import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { PgStore } from '../dist/packages/server/storage/postgres.js';
import { migratePrivateStorage } from '../dist/packages/server/storage/migrate.js';
import { BackendService } from '../dist/packages/server/service.js';
import { canonicalJson } from '../dist/contracts/canonical.js';
import { validateGraphBuildEvent } from '../dist/contracts/validation.js';

// Anonymous structural fixtures only. This suite creates a disposable schema, never app data.
const url = process.env.STORAGE_TEST_DATABASE_URL;
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha(canonicalJson(value));
const migration = fileURLToPath(new URL('../migrations/001_private_storage.sql', import.meta.url));
const now = '2026-09-05T00:00:00.000Z';
const rejectsCode = (action, code) => assert.rejects(action, error => error.code === code);

describe('real PostgreSQL private storage (set STORAGE_TEST_DATABASE_URL)', {skip: !url}, () => {
  let admin, pool, store;
  const schema = `storage_test_${randomUUID().replaceAll('-', '')}`;
  before(async () => {
    admin = new Pool({connectionString: url});
    await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({connectionString: url, options: `-c search_path=${schema}`, max: 12});
    store = new PgStore(pool);
    await Promise.all([migratePrivateStorage(pool, migration), migratePrivateStorage(pool, migration)]);
  });
  after(async () => {
    await pool?.end();
    if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); }
  });
  async function owner() {
    const u = await store.upsertGoogleUser({googleSubject: randomUUID(), displayName: '1'});
    const scopeId = (await store.listPrivateScopes(u.userId))[0].id;
    let scope = await store.authorizePrivateScope(u.userId, scopeId);
    const sourceId = randomUUID();
    await store.provisionSource({actorUserId: u.userId, scopeId, expectedGraphVersion: '0', source: {id: sourceId, provider: 'GOOGLE_CONTACTS', label: '1', origin: 'AUTHORIZED_API', importedAt: now}, policyVersion: 'private-v1', verifiedOwnerIdentity: {platform: 'google', externalId: '1'}});
    scope = await store.authorizePrivateScope(u.userId, scopeId);
    const graph = await store.readSnapshot(scope);
    const context = {sourceId, ownerUserId: u.userId, scopeId, batchId: randomUUID(), sourcePolicyVersion: 'private-v1', sharingDecisionId: null};
    const evidence = ['2', '3', '4'].map((key, index) => ({id: `e${key}`, sourceId, summary: key, observedAt: now, confidence: .8, claimKind: index === 0 ? 'IDENTITY' : index === 1 ? 'RELATIONSHIP' : 'AFFILIATION'}));
    const envelope = {
      context,
      batch: {schemaVersion: 1, sourceId, batchId: context.batchId, people: [{tempId: 't2', displayName: '2', identities: [{platform: 'google', externalId: '2'}], evidenceIds: ['e2']}], relationships: [{tempId: 'r2', fromRef: graph.rootPersonId, toRef: 't2', kind: 'FRIEND', strengthEstimate: .8, confidence: .8, evidenceIds: ['e3']}], observedLinks: [{fromRef: graph.rootPersonId, toRef: 't2', kind: 'CONTACT_SAVED', evidenceIds: ['e3']}], affiliations: [{personRef: 't2', organizationName: '3', evidenceIds: ['e4'], current: null}], evidence, warnings: []},
      records: [{id: 'record2', sourceId, ownerUserId: u.userId, externalRecordId: '2', retrievedAt: now, contentDigest: sha('2'), privatePayloadRef: 'private2'}],
      evidenceRecords: evidence.map(e => ({evidenceId: e.id, sourceRecordId: 'record2'})),
      facts: [
        {factKey: 'observed2', sourceRecordId: 'record2', kind: 'OBSERVED_LINK', candidateIndex: 0, fromIdentity: {platform: 'google', externalId: '1'}, toIdentity: {platform: 'google', externalId: '2'}},
        {factKey: 'relationship2', sourceRecordId: 'record2', kind: 'RELATIONSHIP', candidateIndex: 0, fromIdentity: {platform: 'google', externalId: '1'}, toIdentity: {platform: 'google', externalId: '2'}},
        {factKey: 'affiliation2', sourceRecordId: 'record2', kind: 'AFFILIATION', candidateIndex: 0, personIdentity: {platform: 'google', externalId: '2'}},
      ],
    };
    return {user: u, scope, graph, context, envelope, input: {actorUserId: u.userId, context, expectedGraphVersion: graph.graphVersion, payloadDigest: digest(envelope), envelope}};
  }
  it('migrates once under concurrent startup and provisions one true root under concurrent first login', async () => {
    assert.equal((await pool.query('SELECT count(*) FROM app_migrations')).rows[0].count, '1');
    const subject = randomUUID();
    const users = await Promise.all(Array.from({length: 8}, () => store.upsertGoogleUser({googleSubject: subject, displayName: '9'})));
    assert.equal(new Set(users.map(u => u.userId)).size, 1);
    const scopes = await store.listPrivateScopes(users[0].userId);
    assert.equal(scopes.length, 1);
    const scope = await store.authorizePrivateScope(users[0].userId, scopes[0].id);
    const snapshot = await store.readSnapshot(scope);
    assert.equal(snapshot.people.length, 1);
    assert.equal(snapshot.people[0].displayName, '9');
    assert.equal(snapshot.people[0].id, scope.rootPersonId);
    assert.equal(snapshot.searchEdges.length, 0);
  });
  it('rechecks owners, roots and source policy on reads, new imports and existing receipts', async () => {
    const a = await owner(), b = await owner();
    assert.equal(await store.authorizePrivateScope(b.user.userId, a.scope.scopeId), null);
    await rejectsCode(() => store.readSnapshot({...a.scope, ownerUserId: b.user.userId}), 'FORBIDDEN');
    await rejectsCode(() => store.readSnapshot({...a.scope, rootPersonId: b.scope.rootPersonId}), 'FORBIDDEN');
    await rejectsCode(() => store.stage({...a.input, actorUserId: b.user.userId}), 'FORBIDDEN');
    const job = await store.stage(a.input);
    await rejectsCode(() => store.getImportReview(b.user.userId, a.scope.scopeId, job.jobId), 'FORBIDDEN');
    await pool.query('UPDATE private_sources SET policy_version=$1 WHERE id=$2', ['private-v2', a.context.sourceId]);
    await rejectsCode(() => store.lookupRetry(a.input), 'FORBIDDEN');
    await rejectsCode(() => store.stage(a.input), 'FORBIDDEN');
  });
  it('serializes concurrent duplicate staging and rejects changed receipt payloads', async () => {
    const a = await owner();
    const outcomes = await Promise.all(Array.from({length: 8}, () => store.stage(a.input)));
    assert.equal(new Set(outcomes.map(o => o.jobId)).size, 1);
    assert.equal(outcomes.filter(o => !o.duplicate).length, 1);
    assert.equal((await store.readSnapshot(a.scope)).people.length, 1);
    const changed = structuredClone(a.envelope); changed.batch.people[0].displayName = '7';
    await rejectsCode(() => store.stage({...a.input, envelope: changed, payloadDigest: digest(changed)}), 'VERSION_CONFLICT');
    const retry = await store.stage({...a.input, expectedGraphVersion: 'obsolete'});
    assert.equal(retry.duplicate, true);
    assert.equal(retry.jobId, outcomes[0].jobId);
  });
  it('rejects stale first import, digest spoofing and cross-scope references without a durable receipt', async () => {
    const a = await owner(), b = await owner();
    await rejectsCode(() => store.stage({...a.input, expectedGraphVersion: '0'}), 'VERSION_CONFLICT');
    await rejectsCode(() => store.stage({...a.input, payloadDigest: sha('other')}), 'INVALID_INPUT');
    const broken = structuredClone(a.envelope); broken.batch.people[0].existingPersonId = b.scope.rootPersonId;
    await assert.rejects(() => store.stage({...a.input, envelope: broken, payloadDigest: digest(broken)}));
    assert.equal(await store.lookupRetry(a.input), null);
  });
  it('rolls back receipt creation when its transaction fails after INSERT', async () => {
    const a = await owner();
    await pool.query("CREATE FUNCTION reject_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$");
    await pool.query('CREATE TRIGGER reject_receipt AFTER INSERT ON import_jobs FOR EACH ROW EXECUTE PROCEDURE reject_receipt()');
    try { await assert.rejects(() => store.stage(a.input)); }
    finally { await pool.query('DROP TRIGGER reject_receipt ON import_jobs'); await pool.query('DROP FUNCTION reject_receipt()'); }
    assert.equal(await store.lookupRetry(a.input), null);
    assert.equal((await store.stage(a.input)).duplicate, false);
  });
  it('requires explicit person decisions; projects observations and replayable committed events while claims stay pending', async () => {
    const a = await owner(), b = await owner(), job = await store.stage(a.input);
    const approval = {actorUserId: a.user.userId, scopeId: a.scope.scopeId, jobId: job.jobId, expectedGraphVersion: a.graph.graphVersion, idempotencyKey: 'review2', personAssignments: [{tempId: 't2', personId: null}]};
    await rejectsCode(() => store.approveImportObservations({...approval, personAssignments: []}), 'INVALID_INPUT');
    await rejectsCode(() => store.approveImportObservations({...approval, personAssignments: [{tempId: 't2', personId: b.scope.rootPersonId}]}), 'FORBIDDEN');
    const result = await store.approveImportObservations(approval);
    const graph = await store.readSnapshot(a.scope);
    assert.equal(graph.graphVersion, '2');
    assert.equal(graph.people.length, 2); assert.equal(graph.observedLinks.length, 1);
    assert.equal(graph.relationships[0].state, 'PENDING');
    assert.equal(graph.people.find(p => p.id !== graph.rootPersonId).affiliations[0].support.state, 'PENDING');
    assert.equal(graph.searchEdges.length, 0);
    for (const event of result.events) validateGraphBuildEvent(event, {jobId: job.jobId, scopeId: a.scope.scopeId, afterSeq: event.seq - 1, before: a.graph, after: graph, candidateIds: new Set(), proposalIds: new Set()});
    assert.equal((await store.approveImportObservations({...approval, expectedGraphVersion: 'obsolete'})).duplicate, true);
    await rejectsCode(() => store.approveImportObservations({...approval, idempotencyKey: 'other'}), 'VERSION_CONFLICT');
    const retry = await store.stage({...a.input, expectedGraphVersion: 'obsolete'});
    assert.equal(retry.duplicate, true);
    const review = await store.getImportReview(a.user.userId, a.scope.scopeId, job.jobId);
    assert.equal(review.status, 'OBSERVATIONS_APPROVED');
    assert.equal(JSON.stringify(graph).includes('private2'), false);
    assert.equal(JSON.stringify(review).includes('private2'), false);
  });
  it('rolls graph and review receipt back together on a failed approval write', async () => {
    const a = await owner(), job = await store.stage(a.input);
    await pool.query("CREATE FUNCTION reject_review() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$");
    await pool.query('CREATE TRIGGER reject_review BEFORE UPDATE ON import_jobs FOR EACH ROW EXECUTE PROCEDURE reject_review()');
    const input = {actorUserId: a.user.userId, scopeId: a.scope.scopeId, jobId: job.jobId, expectedGraphVersion: a.graph.graphVersion, idempotencyKey: 'review3', personAssignments: [{tempId: 't2', personId: null}]};
    try { await assert.rejects(() => store.approveImportObservations(input)); }
    finally { await pool.query('DROP TRIGGER reject_review ON import_jobs'); await pool.query('DROP FUNCTION reject_review()'); }
    assert.equal((await store.readSnapshot(a.scope)).graphVersion, a.graph.graphVersion);
    assert.equal((await store.getImportReview(a.user.userId, a.scope.scopeId, job.jobId)).status, 'PENDING_REVIEW');
    assert.equal((await store.approveImportObservations(input)).duplicate, false);
  });
  it('works through BackendService digest normalization and preserves retry after graph changes', async () => {
    const a = await owner();
    const service = new BackendService({auth: {resolveSession: async () => ({userId: a.user.userId})}, reads: store, imports: store});
    const n = structuredClone(a.envelope); delete n.batch.affiliations[0].current;
    const job = await service.stageImport('credential', a.context, a.graph.graphVersion, n);
    await store.approveImportObservations({actorUserId: a.user.userId, scopeId: a.scope.scopeId, jobId: job.jobId, expectedGraphVersion: a.graph.graphVersion, idempotencyKey: 'review4', personAssignments: [{tempId: 't2', personId: null}]});
    assert.equal((await service.stageImport('credential', a.context, 'obsolete', n)).duplicate, true);
    assert.equal((await service.graph('credential', a.scope.scopeId)).people.length, 2);
  });
  it('rejects stale review and serializes repeated approval into one persisted graph version', async () => {
    const a = await owner(), job = await store.stage(a.input);
    const input = {actorUserId: a.user.userId, scopeId: a.scope.scopeId, jobId: job.jobId, expectedGraphVersion: a.graph.graphVersion, idempotencyKey: 'review5', personAssignments: [{tempId: 't2', personId: null}]};
    await rejectsCode(() => store.approveImportObservations({...input, expectedGraphVersion: '0'}), 'VERSION_CONFLICT');
    const results = await Promise.all(Array.from({length: 5}, () => store.approveImportObservations(input)));
    assert.equal(results.filter(r => !r.duplicate).length, 1);
    assert.deepEqual(new Set(results.map(r => r.graphVersion)), new Set(['2']));
    const separatePool = new Pool({connectionString: url, options: `-c search_path=${schema}`});
    try {
      const reopened = new PgStore(separatePool);
      assert.equal((await reopened.readSnapshot(a.scope)).people.length, 2);
      assert.equal((await reopened.getImportReview(a.user.userId, a.scope.scopeId, job.jobId)).status, 'OBSERVATIONS_APPROVED');
    } finally { await separatePool.end(); }
  });
  it('consumes OAuth state once, never for a wrong browser, and rejects expired transactions', async () => {
    const t = {stateHash: sha(randomUUID()), browserBindingHash: sha('1'), nonce: '1', codeVerifier: '2', createdAt: 100, expiresAt: 200};
    await store.putOAuthTransaction(t);
    assert.equal(await store.consumeOAuthTransaction(t.stateHash, sha('wrong'), 150), null);
    const results = await Promise.all([store.consumeOAuthTransaction(t.stateHash, t.browserBindingHash, 150), store.consumeOAuthTransaction(t.stateHash, t.browserBindingHash, 150)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.deepEqual(results.find(Boolean), t);
    const expired = {...t, stateHash: sha(randomUUID())}; await store.putOAuthTransaction(expired);
    assert.equal(await store.consumeOAuthTransaction(expired.stateHash, expired.browserBindingHash, 200), null);
    await store.pruneExpiredAuth(200);
    assert.equal((await pool.query('SELECT count(*) FROM oauth_transactions WHERE state_hash=$1', [expired.stateHash])).rows[0].count, '0');
  });
  it('persists millisecond expiry/revocation and cannot overwrite or resurrect session tokens', async () => {
    const a = await owner(), b = await owner();
    const session = {tokenHash: sha(randomUUID()), userId: a.user.userId, createdAt: 1788644000000, expiresAt: 1788647600000, revokedAt: null};
    await store.putSession(session);
    assert.deepEqual(await store.getSession(session.tokenHash), session);
    await store.revokeSession(session.tokenHash, session.createdAt + 1);
    await store.revokeSession(session.tokenHash, session.createdAt + 2);
    assert.equal((await store.getSession(session.tokenHash)).revokedAt, session.createdAt + 1);
    await assert.rejects(() => store.putSession({...session, userId: b.user.userId}));
    assert.equal((await store.getSession(session.tokenHash)).userId, a.user.userId);
    await store.pruneExpiredAuth(session.expiresAt);
    assert.equal(await store.getSession(session.tokenHash), null);
  });
  it('database constraints prevent moving a root/snapshot or attaching a source to another owner', async () => {
    const a = await owner(), b = await owner();
    await assert.rejects(() => pool.query('UPDATE private_scopes SET root_person_id=$1 WHERE id=$2', [b.scope.rootPersonId, a.scope.scopeId]));
    await assert.rejects(() => pool.query('UPDATE private_sources SET owner_user_id=$1 WHERE id=$2', [b.user.userId, a.context.sourceId]));
  });
});
