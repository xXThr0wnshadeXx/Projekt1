import assert from 'node:assert/strict';
import test from 'node:test';
import { loadGraph } from './graph-load.mjs';

const timestamp = '2026-09-05T00:00:00.000Z';
const goal = { id: 'goal', text: 'supported route', organizationIds: [], roles: [], locations: [], industries: [], unsupportedConstraints: [] };

function snapshot(edges, people = [...new Set(edges.flatMap((edge) => [edge.fromPersonId, edge.toPersonId]))]) {
  return {
    schemaVersion: 1, scopeId: 'scope', graphVersion: '1', rootPersonId: 'root',
    people: people.map((id) => ({ id, displayName: id, aliases: [], identityIds: [], affiliations: [], identityConfidence: 1, updatedAt: timestamp })),
    identities: [], organizations: [], observedLinks: [], relationships: [], searchEdges: edges,
    evidence: edges.map((edge) => ({ id: `e-${edge.id}`, sourceId: 'source', summary: edge.id, observedAt: timestamp, confidence: 1, claimKind: 'RELATIONSHIP' })),
    sources: [{ id: 'source', provider: 'MANUAL', label: 'anonymous test source', origin: 'USER_PROVIDED', importedAt: timestamp }],
    coverage: { completeForAuthorizedSources: true, omittedNodeCount: 0, warnings: [] },
  };
}

function edge(id, fromPersonId, toPersonId, quality = 1) {
  return { id, relationshipId: id, fromPersonId, toPersonId, strength: quality, confidence: 1, recencyFactor: 1,
    evidenceIds: [`e-${id}`], basis: 'CONFIRMED_RELATIONSHIP', policyVersion: 'test-v1' };
}

function target(personId, relevance = 1) {
  return { personId, relevance, evidenceIds: [], reasons: [], criteria: [] };
}

function options(overrides = {}) {
  return { k: 3, maxHops: 5, maxExpansions: 100, maxFrontier: 100, maxTraceEvents: 100, deadlineMs: 1_000, ...overrides };
}

test('excludes malformed edge, identity and target scores without producing a route', async (t) => {
  const { BoundedRouteSearch } = await loadGraph(t);
  const engine = new BoundedRouteSearch();
  const invalidEdge = edge('bad-edge', 'root', 'target');
  invalidEdge.strength = Number.NaN;
  assert.deepEqual(engine.findBestPaths(snapshot([invalidEdge]), goal, [target('target')], options()).paths, []);

  const valid = edge('valid', 'root', 'target');
  const invalidIdentity = snapshot([valid]);
  invalidIdentity.people.find((person) => person.id === 'target').identityConfidence = 1.1;
  assert.deepEqual(engine.findBestPaths(invalidIdentity, goal, [target('target')], options()).paths, []);
  assert.deepEqual(engine.findBestPaths(snapshot([valid]), goal, [target('target', 0)], options()).paths, []);
  assert.deepEqual(engine.findBestPaths(snapshot([valid]), goal, [target('target', 1.1)], options()).paths, []);
});

test('reports no targets with a compact, contiguous event sequence', async (t) => {
  const { BoundedRouteSearch } = await loadGraph(t);
  const result = new BoundedRouteSearch().findBestPaths(snapshot([] , ['root']), goal, [], options());
  assert.equal(result.stats.stop, 'NO_TARGETS');
  assert.deepEqual(result.paths, []);
  assert.deepEqual(result.events.map((event) => event.type), ['SEARCH_STARTED', 'SEARCH_COMPLETED']);
  assert.deepEqual(result.events.map((event) => event.seq), [0, 1]);
});

test('keeps direction, prunes cycles, and ranks a stronger longer route ahead of a weak direct route', async (t) => {
  const { BoundedRouteSearch } = await loadGraph(t);
  const edges = [
    edge('direct', 'root', 'target', 0.6),
    edge('to-a', 'root', 'a', 0.95), edge('to-target', 'a', 'target', 0.95),
    edge('cycle', 'a', 'root', 1),
  ];
  const result = new BoundedRouteSearch().findBestPaths(snapshot(edges), goal, [target('target')], options());
  assert.deepEqual(result.paths.map((path) => path.personIds), [['root', 'a', 'target'], ['root', 'target']]);
  assert.ok(result.paths[0].score.value > result.paths[1].score.value);
  assert.ok(result.events.some((event) => event.type === 'PATH_PRUNED' && event.reason === 'CYCLE'));
  assert.equal(result.paths.every((path) => new Set(path.personIds).size === path.personIds.length), true);
});

test('retains a target reached at the expansion cap and reports an incomplete search', async (t) => {
  const { BoundedRouteSearch } = await loadGraph(t);
  const result = new BoundedRouteSearch().findBestPaths(snapshot([edge('only', 'root', 'target')]), goal, [target('target')], options({ maxExpansions: 1 }));
  assert.deepEqual(result.paths.map((path) => path.personIds), [['root', 'target']]);
  assert.equal(result.stats.stop, 'BUDGET_REACHED');
  assert.equal(result.stats.optimalWithinHopLimit, false);
});

test('reports hop and frontier limits without inventing an exhaustive result', async (t) => {
  const { BoundedRouteSearch } = await loadGraph(t);
  const engine = new BoundedRouteSearch();
  const hopLimited = engine.findBestPaths(snapshot([edge('to-a', 'root', 'a'), edge('to-target', 'a', 'target')]), goal, [target('target')], options({ maxHops: 1 }));
  assert.deepEqual(hopLimited.paths, []);
  assert.ok(hopLimited.events.some((event) => event.type === 'PATH_PRUNED' && event.reason === 'HOP_LIMIT'));
  const frontierLimited = engine.findBestPaths(snapshot([edge('to-a', 'root', 'a'), edge('to-b', 'root', 'b')]), goal, [target('a')], options({ maxFrontier: 1 }));
  assert.equal(frontierLimited.stats.stop, 'BUDGET_REACHED');
  assert.equal(frontierLimited.stats.optimalWithinHopLimit, false);
});

test('reserves terminal events and emits contiguous zero-based sequence numbers after trace trimming', async (t) => {
  const { BoundedRouteSearch } = await loadGraph(t);
  const result = new BoundedRouteSearch().findBestPaths(snapshot([
    edge('to-a', 'root', 'a'), edge('to-b', 'root', 'b'), edge('a-target', 'a', 'target'), edge('b-target', 'b', 'target'),
  ]), goal, [target('target')], options({ k: 1, maxTraceEvents: 3 }));
  assert.equal(result.stats.traceTruncated, true);
  assert.deepEqual(result.events.map((event) => event.seq), result.events.map((_, index) => index));
  assert.equal(result.events[0].type, 'SEARCH_STARTED');
  assert.equal(result.events.at(-2).type, 'PATH_SELECTED');
  assert.equal(result.events.at(-1).type, 'SEARCH_COMPLETED');
});

test('matches an exhaustive simple-path oracle on a tiny directed graph', async (t) => {
  const { BoundedRouteSearch } = await loadGraph(t);
  const edges = [
    edge('ra', 'root', 'a', 0.8), edge('rb', 'root', 'b', 0.9), edge('at', 'a', 'target', 0.9),
    edge('bt', 'b', 'target', 0.7), edge('ab', 'a', 'b', 0.9), edge('ba', 'b', 'a', 0.9),
  ];
  const result = new BoundedRouteSearch().findBestPaths(snapshot(edges), goal, [target('target')], options({ k: 5, maxHops: 3 }));
  const expected = exhaustiveScores(edges, 'root', 'target', 3).map((item) => item.people);
  assert.deepEqual(result.paths.map((path) => path.personIds), expected);
});

test('orders equal-score routes deterministically', async (t) => {
  const { BoundedRouteSearch } = await loadGraph(t);
  const input = snapshot([
    edge('root-a', 'root', 'a'), edge('a-target', 'a', 'target'),
    edge('root-b', 'root', 'b'), edge('b-target', 'b', 'target'),
  ]);
  const engine = new BoundedRouteSearch();
  const first = engine.findBestPaths(input, goal, [target('target')], options({ k: 2 }));
  const second = engine.findBestPaths(input, goal, [target('target')], options({ k: 2 }));
  assert.deepEqual(first.paths.map((path) => path.personIds), [['root', 'a', 'target'], ['root', 'b', 'target']]);
  assert.deepEqual(second.paths.map((path) => path.personIds), first.paths.map((path) => path.personIds));
});

test('fails closed for public context or unreviewed claims and never assigns local scores', async (t) => {
  const { assessReviewedPublicRelationship } = await loadGraph(t);
  const accepted = {
    endpointIdentitiesResolved: true, relationshipAccepted: true,
    support: 'DIRECT_ATTRIBUTED_STATEMENT', freshness: 'CURRENT', reviewerPreference: 'STANDARD',
  };
  assert.deepEqual(assessReviewedPublicRelationship(accepted), {
    eligible: true, reviewerPreference: 'STANDARD', scoring: 'REQUIRES_APPROVED_SERVER_POLICY',
  });
  for (const relationship of [
    { ...accepted, endpointIdentitiesResolved: false },
    { ...accepted, relationshipAccepted: false },
    { ...accepted, support: 'CONTEXT_ONLY' },
  ]) {
    assert.equal(assessReviewedPublicRelationship(relationship).eligible, false);
  }
});

function exhaustiveScores(edges, root, targetId, maxHops) {
  const found = [];
  const visit = (person, people, used, score) => {
    if (person === targetId && used.length > 0) {
      found.push({ people, score: score * Math.pow(0.92, used.length - 1) });
      return;
    }
    if (used.length === maxHops) return;
    for (const current of edges.filter((item) => item.fromPersonId === person)) {
      if (people.includes(current.toPersonId)) continue;
      visit(current.toPersonId, [...people, current.toPersonId], [...used, current.id], score * current.strength * current.confidence * current.recencyFactor);
    }
  };
  visit(root, [root], [], 1);
  return found.sort((left, right) => right.score - left.score || left.people.length - right.people.length || left.people.join('\u0000').localeCompare(right.people.join('\u0000')));
}
