import { createHash } from 'node:crypto';
import type { Goal, GraphSnapshot, Target } from '../../../contracts/index.js';
import { resolveEvidenceBackedTargets } from './targets.js';

const LIMITATION = 'Only named organization affiliation is evaluated; roles, locations, industries, openings and other requirements remain unverified.';
const normalize = (text: string): string => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

/** Structural implementation of Ben's GoalPort. Receives an authorized snapshot only. */
export class EvidenceBackedGoalResolver {
  async resolve(text: string, snapshot: GraphSnapshot): Promise<{ goal: Goal; targets: Target[] }> {
    const goal = resolveOrganizationGoal(text, snapshot);
    return { goal, targets: resolveEvidenceBackedTargets(snapshot, goal) };
  }
}

/** Exact organization-name mentions, not a semantic role/vacancy or employer inference. */
export function resolveOrganizationGoal(text: string, snapshot: GraphSnapshot): Goal {
  const normalizedText = normalize(text);
  // Do not reinterpret an exclusion as a positive target. Complex polarity needs review.
  const unsupportedPolarity = /\b(?:no|not|never|without|except|exclude|excluding|avoid|rather)\b|\b(?:don|doesn|isn|aren)['’]t\b/u.test(normalizedText);
  const byName = new Map<string, string[]>();
  for (const organization of snapshot.organizations) {
    const name = normalize(organization.name);
    if (name) byName.set(name, [...(byName.get(name) ?? []), organization.id]);
  }
  const spans: Array<{ start: number; end: number; organizationId: string }> = [];
  if (!unsupportedPolarity) {
    for (const [name, ids] of byName) {
      // Equal names do not prove equal organizations; leave ambiguous matches unresolved.
      if (ids.length !== 1) continue;
      let start = normalizedText.indexOf(name);
      while (start !== -1) {
        const end = start + name.length;
        const before = Array.from(normalizedText.slice(0, start)).at(-1) ?? '';
        const after = Array.from(normalizedText.slice(end))[0] ?? '';
        if (!/[\p{L}\p{N}_]/u.test(before) && !/[\p{L}\p{N}_]/u.test(after)) {
          spans.push({ start, end, organizationId: ids[0]! });
        }
        start = normalizedText.indexOf(name, start + 1);
      }
    }
  }
  // The longest organization mention wins when names overlap.
  spans.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start || a.organizationId.localeCompare(b.organizationId));
  const selected: typeof spans = [];
  for (const span of spans) {
    if (!selected.some(other => span.start < other.end && span.end > other.start)) selected.push(span);
  }
  return {
    id: `goal:${createHash('sha256').update(JSON.stringify([snapshot.scopeId, snapshot.graphVersion, text])).digest('hex')}`,
    text,
    organizationIds: [...new Set(selected.map(span => span.organizationId))].sort(),
    roles: [], locations: [], industries: [],
    unsupportedConstraints: [LIMITATION, ...(unsupportedPolarity ? ['Negated or contrastive organization requests require explicit clarification.'] : [])],
  };
}
