import type {
  Goal,
  GraphSnapshot,
  OpportunityPath,
  PathScore,
  SearchEdge,
  SearchEngine,
  SearchEvent,
  SearchOptions,
  SearchResult,
  SearchStats,
  Target,
} from '../../../contracts/index.js';

export const ROUTE_POLICY_VERSION = 'route-v1' as const;

/** Server-side caps. Callers may ask for less, never more. */
export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  k: 3,
  maxHops: 5,
  maxExpansions: 10_000,
  maxFrontier: 25_000,
  maxTraceEvents: 3_000,
  deadlineMs: 1_000,
};

type PathState = {
  personIds: string[];
  edgeIds: string[];
  edges: SearchEdge[];
  relationshipQuality: number;
  identityQuality: number;
};

type Candidate = { path: OpportunityPath; rankKey: string };
type SearchEventPayload<T extends SearchEvent = SearchEvent> = T extends unknown
  ? Omit<T, 'schemaVersion' | 'scopeId' | 'graphVersion' | 'searchId' | 'seq'>
  : never;

/** A deterministic, simple-path top-K engine. Authorization is enforced before this boundary. */
export class BoundedRouteSearch implements SearchEngine {
  findBestPaths(
    snapshot: GraphSnapshot,
    goal: Goal,
    targets: Target[],
    requested: SearchOptions,
  ): SearchResult {
    const options = clampOptions(requested);
    const startedAt = Date.now();
    const events: SearchEventPayload[] = [];
    let omittedTraceEvents = 0;
    const emit = (event: SearchEventPayload) => {
      if (events.length >= options.maxTraceEvents) {
        omittedTraceEvents += 1;
        return;
      }
      events.push(event);
    };

    const searchId = makeSearchId(snapshot, goal);
    emit({ type: 'SEARCH_STARTED', rootPersonId: snapshot.rootPersonId });
    // The API validator owns schema rejection. Keep this pure boundary defensive too:
    // an invalid score must never create a route or poison heap ordering with NaN.
    const validPeople = new Map(snapshot.people
      .filter((person) => isUnitScore(person.identityConfidence))
      .map((person) => [person.id, person]));
    const targetsByPerson = new Map(targets
      .filter((target) => isUnitScore(target.relevance) && target.relevance > 0)
      .map((target) => [target.personId, target]));
    if (targetsByPerson.size === 0) {
      const stats: SearchStats = {
        expansions: 0,
        elapsedMs: Date.now() - startedAt,
        stop: 'NO_TARGETS',
        optimalWithinHopLimit: true,
        traceTruncated: false,
        omittedTraceEvents: 0,
      };
      events.push({ type: 'SEARCH_COMPLETED', pathIds: [], stats });
      return { schemaVersion: 1, scopeId: snapshot.scopeId, graphVersion: snapshot.graphVersion, searchId, goal, targets,
        paths: [], events: finalizeEvents(events, snapshot, searchId), stats, warnings: [] };
    }
    const adjacency = buildAdjacency(snapshot.searchEdges, validPeople);
    const initial: PathState = {
      personIds: [snapshot.rootPersonId], edgeIds: [], edges: [], relationshipQuality: 1, identityQuality: 1,
    };
    const frontier = new MaxHeap<PathState>(compareStates);
    frontier.push(initial);
    const candidatesByRoute = new Map<string, Candidate>();
    const recordCandidate = (state: PathState, target: Target) => {
      const path = makePath(snapshot, goal, target, state);
      const routeKey = path.personIds.join('\u0000');
      const existing = candidatesByRoute.get(routeKey);
      if (!existing || compareCandidates({ path, rankKey: routeKey }, existing) < 0) {
        emit({ type: 'TARGET_FOUND', personId: target.personId });
        candidatesByRoute.set(routeKey, { path, rankKey: routeKey });
        emit({ type: 'PATH_CANDIDATE', path });
      }
    };
    let expansions = 0;
    let budgetReached = false;

    while (frontier.length > 0) {
      if (Date.now() - startedAt >= options.deadlineMs) {
        budgetReached = true;
        break;
      }
      const state = frontier.pop()!;
      const currentPersonId = state.personIds[state.personIds.length - 1];
      emit({ type: 'NODE_VISITED', personId: currentPersonId, prefixPersonIds: state.personIds });

      const target = targetsByPerson.get(currentPersonId);
      if (target && state.edgeIds.length > 0) {
        recordCandidate(state, target);
      }
      // A state reached just as the expansion budget was consumed is still a
      // legitimate candidate (and was recorded above); do not expand it further.
      if (expansions >= options.maxExpansions) { budgetReached = true; break; }
      if (state.edgeIds.length >= options.maxHops) {
        if ((adjacency.get(currentPersonId) ?? []).length > 0) {
          emit({ type: 'PATH_PRUNED', prefixPersonIds: state.personIds, reason: 'HOP_LIMIT' });
        }
        continue;
      }

      for (const edge of adjacency.get(currentPersonId) ?? []) {
        if (expansions >= options.maxExpansions || Date.now() - startedAt >= options.deadlineMs) {
          budgetReached = true;
          break;
        }
        expansions += 1;
        emit({ type: 'EDGE_EXPLORED', edgeId: edge.id, fromPersonId: edge.fromPersonId, toPersonId: edge.toPersonId });
        if (state.personIds.includes(edge.toPersonId)) {
          emit({ type: 'PATH_PRUNED', prefixPersonIds: [...state.personIds, edge.toPersonId], reason: 'CYCLE' });
          continue;
        }
        const edgeQuality = edge.strength * edge.confidence * edge.recencyFactor;
        if (edgeQuality <= 0) {
          emit({ type: 'PATH_PRUNED', prefixPersonIds: [...state.personIds, edge.toPersonId], reason: 'ZERO_QUALITY' });
          continue;
        }
        const person = validPeople.get(edge.toPersonId);
        if (!person) continue;
        if (frontier.length >= options.maxFrontier) {
          budgetReached = true;
          break;
        }
        const nextState: PathState = {
          personIds: [...state.personIds, edge.toPersonId],
          edgeIds: [...state.edgeIds, edge.id],
          edges: [...state.edges, edge],
          relationshipQuality: state.relationshipQuality * edgeQuality,
          identityQuality: state.identityQuality * person.identityConfidence,
        };
        frontier.push(nextState);
        // Retain a reached target even when this was the final permitted expansion.
        const reachedTarget = targetsByPerson.get(edge.toPersonId);
        if (reachedTarget) {
          recordCandidate(nextState, reachedTarget);
        }
      }
      if (budgetReached) break;
    }

    const candidates = [...candidatesByRoute.values()].sort(compareCandidates);
    const selected = candidates.slice(0, options.k);
    // Completion and selected-path events are contractual; discard old detail events if necessary.
    const reservedCount = selected.length + 1;
    while (events.length + reservedCount > options.maxTraceEvents && events.length > 1) {
      events.splice(1, 1);
      omittedTraceEvents += 1;
    }
    for (const { path } of selected) {
      events.push({ type: 'PATH_SELECTED', pathId: path.id });
    }
    const stats: SearchStats = {
      expansions,
      elapsedMs: Date.now() - startedAt,
      stop: targets.length === 0 ? 'NO_TARGETS' : budgetReached ? 'BUDGET_REACHED' : 'EXHAUSTED_WITHIN_HOP_LIMIT',
      optimalWithinHopLimit: !budgetReached,
      traceTruncated: omittedTraceEvents > 0,
      omittedTraceEvents,
    };
    events.push({ type: 'SEARCH_COMPLETED', pathIds: selected.map(({ path }) => path.id), stats });
    return { schemaVersion: 1, scopeId: snapshot.scopeId, graphVersion: snapshot.graphVersion, searchId, goal, targets,
      paths: selected.map(({ path }) => path), events: finalizeEvents(events, snapshot, searchId), stats,
      warnings: budgetReached ? ['Search budget reached; returned paths are the best found, not proven exhaustive.'] : [] };
  }
}

function buildAdjacency(edges: SearchEdge[], people: Map<string, unknown>): Map<string, SearchEdge[]> {
  const adjacency = new Map<string, SearchEdge[]>();
  for (const edge of edges) {
    if (!people.has(edge.fromPersonId) || !people.has(edge.toPersonId)) continue;
    if (!isUnitScore(edge.strength) || !isUnitScore(edge.confidence) || !isUnitScore(edge.recencyFactor)) continue;
    const entries = adjacency.get(edge.fromPersonId) ?? [];
    entries.push(edge);
    adjacency.set(edge.fromPersonId, entries);
  }
  for (const entries of adjacency.values()) entries.sort((a, b) => a.id.localeCompare(b.id));
  return adjacency;
}

function makePath(snapshot: GraphSnapshot, goal: Goal, target: Target, state: PathState): OpportunityPath {
  const hopPenalty = Math.pow(0.92, Math.max(0, state.edgeIds.length - 1));
  const score: PathScore = {
    value: state.relationshipQuality * state.identityQuality * target.relevance * hopPenalty,
    relationshipQuality: state.relationshipQuality,
    identityQuality: state.identityQuality,
    targetRelevance: target.relevance,
    hopPenalty,
    edges: state.edges.map((edge) => ({ edgeId: edge.id, strength: edge.strength, confidence: edge.confidence,
      recencyFactor: edge.recencyFactor, value: edge.strength * edge.confidence * edge.recencyFactor })),
    identities: state.personIds.slice(1).map((personId) => ({ personId, value: snapshot.people.find((person) => person.id === personId)!.identityConfidence })),
    policyVersion: ROUTE_POLICY_VERSION,
  };
  const evidenceIds = [...new Set([...state.edges.flatMap((edge) => edge.evidenceIds), ...target.evidenceIds])]
    .sort((left, right) => left.localeCompare(right));
  return {
    id: makeOpaqueId('path', [...state.personIds, ...state.edgeIds, target.personId]),
    personIds: state.personIds, edgeIds: state.edgeIds, target, score,
    explanation: { summary: `Evidence-backed route for: ${goal.text}`, evidenceIds,
      uncertainties: ['Route score is a relative heuristic, not a probability of help.'], suggestedFirstContactId: state.personIds[1] },
  };
}

function compareStates(a: PathState, b: PathState): number {
  const aScore = a.relationshipQuality * a.identityQuality;
  const bScore = b.relationshipQuality * b.identityQuality;
  return aScore - bScore || b.personIds.join('\u0000').localeCompare(a.personIds.join('\u0000')) || b.edgeIds.join('\u0000').localeCompare(a.edgeIds.join('\u0000'));
}

function compareCandidates(a: Candidate, b: Candidate): number {
  return b.path.score.value - a.path.score.value || a.path.personIds.length - b.path.personIds.length || a.rankKey.localeCompare(b.rankKey);
}

function clampOptions(options: SearchOptions): SearchOptions {
  const k = clampInteger(options.k, 1, DEFAULT_SEARCH_OPTIONS.k, 5);
  return {
    k,
    maxHops: clampInteger(options.maxHops, 1, DEFAULT_SEARCH_OPTIONS.maxHops, 6),
    maxExpansions: clampInteger(options.maxExpansions, 1, DEFAULT_SEARCH_OPTIONS.maxExpansions, DEFAULT_SEARCH_OPTIONS.maxExpansions),
    maxFrontier: clampInteger(options.maxFrontier, 1, DEFAULT_SEARCH_OPTIONS.maxFrontier, DEFAULT_SEARCH_OPTIONS.maxFrontier),
    maxTraceEvents: clampInteger(options.maxTraceEvents, k + 2, DEFAULT_SEARCH_OPTIONS.maxTraceEvents, DEFAULT_SEARCH_OPTIONS.maxTraceEvents),
    deadlineMs: clampInteger(options.deadlineMs, 1, DEFAULT_SEARCH_OPTIONS.deadlineMs, DEFAULT_SEARCH_OPTIONS.deadlineMs),
  };
}

function clampInteger(value: number, min: number, fallback: number, max: number): number {
  return Number.isInteger(value) && value >= min ? Math.min(value, max) : fallback;
}

function isUnitScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function makeSearchId(snapshot: GraphSnapshot, goal: Goal): string {
  return makeOpaqueId('search', [snapshot.scopeId, snapshot.graphVersion, snapshot.rootPersonId, goal.id]);
}

/** Produces a bounded, stable ID without leaking opaque input IDs into delimiters. */
function makeOpaqueId(kind: 'search' | 'path', parts: string[]): string {
  const input = parts.map((part) => `${part.length}:${part}`).join('|');
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  let third = 0x85ebca6b;
  for (let index = 0; index < input.length; index += 1) {
    const code = input.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x27d4eb2d) >>> 0;
    third = Math.imul(third ^ (code * 31 + index), 0x165667b1) >>> 0;
  }
  return `${kind}:${first.toString(36)}-${second.toString(36)}-${third.toString(36)}`;
}

function finalizeEvents(events: SearchEventPayload[], snapshot: GraphSnapshot, searchId: string): SearchEvent[] {
  return events.map((event, seq) => ({
    ...event,
    schemaVersion: 1,
    scopeId: snapshot.scopeId,
    graphVersion: snapshot.graphVersion,
    searchId,
    seq,
  }) as SearchEvent);
}

/** Small deterministic binary max-heap; a comparator above zero means higher priority. */
class MaxHeap<T> {
  private readonly values: T[] = [];

  constructor(private readonly compare: (left: T, right: T) => number) {}

  get length(): number { return this.values.length; }

  push(value: T): void {
    this.values.push(value);
    for (let index = this.values.length - 1; index > 0;) {
      const parent = Math.floor((index - 1) / 2);
      if (this.compare(this.values[index]!, this.values[parent]!) <= 0) break;
      [this.values[index], this.values[parent]] = [this.values[parent]!, this.values[index]!];
      index = parent;
    }
  }

  pop(): T | undefined {
    const best = this.values[0];
    const last = this.values.pop();
    if (this.values.length > 0 && last !== undefined) {
      this.values[0] = last;
      for (let index = 0;;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let next = index;
        if (left < this.values.length && this.compare(this.values[left]!, this.values[next]!) > 0) next = left;
        if (right < this.values.length && this.compare(this.values[right]!, this.values[next]!) > 0) next = right;
        if (next === index) break;
        [this.values[index], this.values[next]] = [this.values[next]!, this.values[index]!];
        index = next;
      }
    }
    return best;
  }
}
