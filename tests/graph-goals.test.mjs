import assert from 'node:assert/strict';
import test from 'node:test';
import { graph, authority } from './fixtures.mjs';
import { validateGraphSnapshot, validateGoal, validateTarget, validateSearchResult } from '../dist/contracts/validation.js';
import { BackendService } from '../dist/packages/server/service.js';
import { loadGraph } from './graph-load.mjs';

function affiliatedGraph() {
  const snapshot = graph();
  snapshot.organizations = [{ id: 'o0', name: 'org0' }];
  snapshot.evidence.push({ ...snapshot.evidence[0], id: 'a0', claimKind: 'AFFILIATION' });
  snapshot.people[1].affiliations = [{ organizationId: 'o0', current: true, support: { value: true, state: 'CONFIRMED', confidence: 1, evidenceIds: ['a0'] } }];
  return snapshot;
}

test('actual backend composes goal resolver, supported targets and ranked graph result', async (t) => {
  const { EvidenceBackedGoalResolver, BoundedRouteSearch } = await loadGraph(t);
  const snapshot = affiliatedGraph();
  validateGraphSnapshot(snapshot, authority);
  const goals = new EvidenceBackedGoalResolver();
  const text = 'Find an internship at ORG0 in l0';
  const resolved = await goals.resolve(text, snapshot);
  validateGoal(resolved.goal, snapshot);
  resolved.targets.forEach(target => validateTarget(target, snapshot));
  assert.deepEqual(resolved.goal.organizationIds, ['o0']);
  assert.equal(resolved.goal.text, text);
  assert.ok(resolved.targets[0].criteria.some(c => c.status === 'UNKNOWN'));
  const service = new BackendService({
    auth: { resolveSession: async () => ({ userId: 'u0' }) },
    reads: {
      authorizePrivateScope: async () => ({ ...authority, ownerUserId: 'u0' }),
      readSnapshot: async () => snapshot,
    },
    goals, engine: new BoundedRouteSearch(),
  });
  const response = await service.search('session0', { scopeId: 's0', expectedGraphVersion: 'v1', goalText: text });
  validateSearchResult(response, snapshot);
  assert.deepEqual(response.paths[0].personIds, ['p0', 'p1']);
  assert.equal(response.paths[0].score.value, 0.5);
  assert.deepEqual(await goals.resolve(text, snapshot), resolved);
  for (const current of [false, null]) {
    snapshot.people[1].affiliations[0].current = current;
    assert.deepEqual((await goals.resolve(text, snapshot)).targets, []);
  }
});

test('literal goal matching avoids substring, ambiguous, negated and shorter overlapping organizations', async (t) => {
  const { resolveOrganizationGoal } = await loadGraph(t);
  const snapshot = affiliatedGraph();
  for (const text of ['org01', 'unknown0', 'not org0', "I don't want org0"]) {
    assert.deepEqual(resolveOrganizationGoal(text, snapshot).organizationIds, []);
  }
  snapshot.organizations.push({ id: 'o1', name: 'org0 labs' });
  assert.deepEqual(resolveOrganizationGoal('at ORG0   labs', snapshot).organizationIds, ['o1']);
  assert.deepEqual(resolveOrganizationGoal('org0 and org0 labs', snapshot).organizationIds, ['o0', 'o1']);
  snapshot.organizations.push({ id: 'o2', name: 'ORG0' });
  assert.deepEqual(resolveOrganizationGoal('org0', snapshot).organizationIds, []);
});
