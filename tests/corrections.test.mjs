import test from 'node:test';
import assert from 'node:assert/strict';
import { BackendService, ServiceError } from '../dist/packages/server/service.js';
import { validateNormalizedImport, validateGraphBuildEvent, ContractError } from '../dist/contracts/validation.js';
import { graph, result, envelope, context, importAuthority } from './fixtures.mjs';

function importGraph() {
  const g = graph();
  g.people[0].identityIds = ['i0'];
  g.identities = [{ id: 'i0', sourceId: 's1', platform: 'm0', externalId: 'root0', personId: 'p0', assignmentState: 'CONFIRMED', evidenceIds: ['e0'], updatedAt: g.people[0].updatedAt }];
  return g;
}
function harness() {
  let snapshot = importGraph(), reads = 0, lookups = 0, stages = 0, receipt = null;
  const ports = {
    auth: { resolveSession: async credential => credential === 'session0' ? { userId: 'u0' } : null },
    reads: {
      authorizePrivateScope: async (user, scope) => user === 'u0' && scope === 's0' ? { scopeId: 's0', ownerUserId: 'u0', rootPersonId: 'p0', sourceIds: new Set(['s1']) } : null,
      readSnapshot: async () => { reads++; return snapshot; },
    },
    imports: {
      lookupRetry: async key => { lookups++; assert.equal(key.actorUserId, 'u0'); return receipt; },
      // Test-only transaction stub. No runtime persistence or real records.
      stage: async input => {
        stages++;
        if (receipt) {
          if (receipt.payloadDigest !== input.payloadDigest) throw new ServiceError('VERSION_CONFLICT', 409);
          return { ...receipt.outcome, duplicate: true };
        }
        if (snapshot.graphVersion !== input.expectedGraphVersion) throw new ServiceError('VERSION_CONFLICT', 409);
        receipt = { payloadDigest: input.payloadDigest, outcome: { jobId: 'j0', status: 'PENDING_REVIEW', duplicate: false } };
        return receipt.outcome;
      },
    },
  };
  return { ports, service: new BackendService(ports), setSnapshot: g => { snapshot = g; }, getReceipt: () => receipt, setReceipt: r => { receipt = r; }, counts: () => ({ reads, lookups, stages }) };
}
const rejectsCode = (promise, code) => assert.rejects(promise, error => error.code === code);

test('exact import retry succeeds after version advance and evidence persistence without snapshot read', async () => {
  const h = harness();
  await h.service.stageImport('session0', context, 'v1', envelope());
  const next = importGraph(); next.graphVersion = 'v2'; next.evidence.push(envelope().batch.evidence[0]); h.setSnapshot(next);
  const before = h.counts();
  const reordered = Object.fromEntries(Object.entries(envelope()).reverse());
  assert.deepEqual(await h.service.stageImport('session0', context, 'v1', reordered), { jobId: 'j0', status: 'PENDING_REVIEW', duplicate: true });
  assert.equal(h.counts().reads, before.reads);
  assert.equal(h.counts().stages, 1);
  assert.match(h.getReceipt().payloadDigest, /^[a-f0-9]{64}$/);
});
test('same retry key with changed content conflicts before stale graph checks', async () => {
  const h = harness(); await h.service.stageImport('session0', context, 'v1', envelope());
  const changed = envelope(); changed.batch.warnings = ['w0'];
  await rejectsCode(h.service.stageImport('session0', context, 'v0', changed), 'VERSION_CONFLICT');
  assert.equal(h.counts().reads, 1);
});
test('receipt lookup never bypasses actor/source authorization or trusted context binding', async () => {
  const h = harness();
  await rejectsCode(h.service.stageImport(null, context, 'v1', envelope()), 'UNAUTHENTICATED');
  await rejectsCode(h.service.stageImport('session0', { ...context, sourceId: 's9' }, 'v1', envelope()), 'FORBIDDEN');
  const other = envelope(); other.context.ownerUserId = 'u9';
  await rejectsCode(h.service.stageImport('session0', context, 'v1', other), 'INVALID_INPUT');
  assert.equal(h.counts().lookups, 0);
});
test('retry found after concurrent commit rescues stale preflight', async () => {
  const h = harness(); await h.service.stageImport('session0', context, 'v1', envelope());
  const receipt = h.getReceipt(); let lookups = 0;
  h.ports.imports.lookupRetry = async () => ++lookups === 1 ? null : receipt;
  const next = importGraph(); next.graphVersion = 'v2'; h.setSnapshot(next);
  assert.equal((await h.service.stageImport('session0', context, 'v1', envelope())).duplicate, true);
  assert.equal(lookups, 2);
  assert.equal(h.counts().stages, 1);
});
test('adapter resolves a racing receipt atomically after successful preflight', async () => {
  const h = harness(); await h.service.stageImport('session0', context, 'v1', envelope());
  h.ports.imports.lookupRetry = async () => null;
  // A receipt exists under the adapter lock despite the earlier lookup miss.
  assert.equal((await h.service.stageImport('session0', context, 'v1', envelope())).duplicate, true);
  const changed = envelope(); changed.batch.warnings = ['w0'];
  await rejectsCode(h.service.stageImport('session0', context, 'v1', changed), 'VERSION_CONFLICT');
});
test('unseen stale import remains a conflict and never stages', async () => {
  const h = harness();
  await rejectsCode(h.service.stageImport('session0', context, 'v0', envelope()), 'VERSION_CONFLICT');
  assert.equal(h.counts().stages, 0);
});

test('source endpoints accept both temporary and matching existing aliases', () => {
  const authority = { ...importAuthority, existingIdentities: [...importAuthority.existingIdentities, { platform: 'm0', externalId: 'a0', personId: 'p1' }] };
  for (const ref of ['t0', 'p1']) {
    const n = envelope(); n.batch.people[0].existingPersonId = 'p1'; n.batch.observedLinks[0].toRef = ref;
    validateNormalizedImport(n, authority);
  }
  const bad = envelope(); bad.batch.people[0].existingPersonId = 'p0';
  assert.throws(() => validateNormalizedImport(bad, authority), ContractError);
});
test('aliases cannot disguise self-links', () => {
  const n = envelope(); n.batch.people[0].existingPersonId = 'p0';
  assert.throws(() => validateNormalizedImport(n, importAuthority), ContractError);
});

const request = { scopeId: 's0', expectedGraphVersion: 'v1', goalText: 'g0' };
function searchHarness(resolve, engine) {
  const h = harness(); h.ports.goals = { resolve }; h.ports.engine = { findBestPaths: engine }; return h.service;
}
test('cached search for another goal on the same graph is rejected', async () => {
  const service = searchHarness(async () => ({ goal: { ...result().goal, text: 'g1' }, targets: result().targets }), () => result());
  await rejectsCode(service.search('session0', request), 'INTERNAL');
});
test('cached target content and target order must match resolver inputs', async () => {
  const changed = searchHarness(async () => ({ goal: result().goal, targets: [{ ...result().targets[0], reasons: ['r1'] }] }), () => result());
  await rejectsCode(changed.search('session0', request), 'INTERNAL');
  const targets = [...result().targets, { ...result().targets[0], personId: 'p0' }];
  const reversed = searchHarness(async () => ({ goal: result().goal, targets }), () => ({ ...result(), targets: [...targets].reverse() }));
  await rejectsCode(reversed.search('session0', request), 'INTERNAL');
  const ordered = searchHarness(async () => ({ goal: result().goal, targets }), () => ({ ...result(), targets }));
  assert.equal((await ordered.search('session0', request)).targets.length, 2);
});
test('search binding tolerates object key order while preserving array order', async () => {
  const service = searchHarness(async () => ({ goal: Object.fromEntries(Object.entries(result().goal).reverse()), targets: result().targets }), () => result());
  assert.equal((await service.search('session0', request)).paths.length, 1);
});

const entityKeys = ['people', 'identities', 'organizations', 'observedLinks', 'relationships', 'searchEdges', 'evidence', 'sources'];
function deltaCase() {
  const before = graph(), after = graph(); after.graphVersion = 'v2';
  const ctx = { jobId: 'j0', scopeId: 's0', afterSeq: 0, before, after, candidateIds: new Set(), proposalIds: new Set() };
  const event = { schemaVersion: 1, jobId: 'j0', scopeId: 's0', seq: 1, type: 'BATCH_COMMITTED', operationKind: 'IMPORT', baseGraphVersion: 'v1', graphVersion: 'v2', ...Object.fromEntries(entityKeys.map(k => [k, []])), removedPersonIds: [], removedEdgeIds: [] };
  return { ctx, event };
}
test('empty or partial delta cannot omit a changed or added entity', () => {
  const { ctx, event } = deltaCase(); ctx.after.people[1].displayName = 'p1-updated';
  assert.throws(() => validateGraphBuildEvent(event, ctx), ContractError);
  event.people = [ctx.after.people[1]]; validateGraphBuildEvent(event, ctx);
  ctx.after.organizations.push({ id: 'o0', name: 'o0' });
  assert.throws(() => validateGraphBuildEvent(event, ctx), ContractError);
  event.organizations = ctx.after.organizations; validateGraphBuildEvent(event, ctx);
});
test('supported entity removals reconstruct the full after snapshot', () => {
  const { ctx, event } = deltaCase(); ctx.after.people.pop(); ctx.after.observedLinks = []; ctx.after.searchEdges = [];
  event.removedPersonIds = ['p1']; event.removedEdgeIds = ['l0', 'x0'];
  validateGraphBuildEvent(event, ctx);
  event.removedEdgeIds = ['l0']; assert.throws(() => validateGraphBuildEvent(event, ctx), ContractError);
});
for (const key of ['identities', 'organizations', 'evidence', 'sources']) {
  test(`unsupported ${key} deletion requires snapshot invalidation`, () => {
    const { ctx, event } = deltaCase();
    if (key === 'identities') ctx.before.identities = [{ id: 'i0' }];
    if (key === 'organizations') ctx.before.organizations = [{ id: 'o0', name: 'o0' }];
    ctx.after[key] = [];
    assert.throws(() => validateGraphBuildEvent(event, ctx), ContractError);
  });
}
for (const change of ['root', 'coverage']) {
  test(`${change} change requires snapshot invalidation`, () => {
    const { ctx, event } = deltaCase();
    if (change === 'root') ctx.after.rootPersonId = 'p1'; else ctx.after.coverage.warnings = ['w0'];
    assert.throws(() => validateGraphBuildEvent(event, ctx), ContractError);
    validateGraphBuildEvent({ schemaVersion: 1, jobId: 'j0', scopeId: 's0', seq: 1, type: 'SNAPSHOT_INVALIDATED', baseGraphVersion: 'v1', graphVersion: 'v2', reason: 'ACCESS_CHANGED', removedSourceIds: [] }, ctx);
  });
}
