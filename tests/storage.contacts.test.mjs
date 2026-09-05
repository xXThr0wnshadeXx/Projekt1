import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { PgStore } from '../dist/packages/server/storage/postgres.js';
import { migratePrivateStorage, migrateContactsStorage } from '../dist/packages/server/storage/migrate.js';
const url = process.env.STORAGE_TEST_DATABASE_URL;
const sha = value => createHash('sha256').update(value).digest('hex');
const migration = name => fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
const rejectsCode = (action, code) => assert.rejects(action, error => error.code === code);
const contactScope = 'https://www.googleapis.com/auth/contacts.readonly';

describe('real PostgreSQL Contacts consent and encrypted grant storage', {skip: !url}, () => {
  let admin, pool, store;
  const schema = `contacts_test_${randomUUID().replaceAll('-', '')}`;
  before(async () => {
    admin = new Pool({connectionString: url}); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({connectionString: url, options: `-c search_path=${schema}`, max: 12}); store = new PgStore(pool);
    await migratePrivateStorage(pool, migration('001_private_storage.sql'));
    await Promise.all([migrateContactsStorage(pool, migration('002_contacts_grants.sql')), migrateContactsStorage(pool, migration('002_contacts_grants.sql'))]);
  });
  after(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });
  async function owner() {
    const user = await store.upsertGoogleUser({googleSubject: randomUUID(), displayName: '1'});
    const scopeId = (await store.listPrivateScopes(user.userId))[0].id, sessionHash = sha(randomUUID());
    await store.putSession({tokenHash: sessionHash, userId: user.userId, createdAt: 100, expiresAt: Number.MAX_SAFE_INTEGER, revokedAt: null});
    const grant = {ownerUserId: user.userId, scopeId, sourceId: `gc_${sha(JSON.stringify([user.userId, scopeId, user.googleSubject]))}`, googleSubject: user.googleSubject, grantedScopes: [contactScope, 'openid'], accessTokenCiphertext: 'encrypted1', accessExpiresAt: 800, refreshTokenCiphertext: 'encrypted2', refreshExpiresAt: null, createdAt: 200, updatedAt: 200, revokedAt: null, version: randomUUID()};
    const transaction = {purpose: 'GOOGLE_CONTACTS', actorUserId: user.userId, sessionHash, scopeId, sourceId: grant.sourceId, googleSubject: user.googleSubject, stateHash: sha(randomUUID()), browserBindingHash: sha('1'), nonce: '2', codeVerifier: '3', createdAt: 200, expiresAt: 500};
    return {user, scopeId, sessionHash, grant, transaction};
  }
  it('binds Contacts transactions to the exact owner, browser and live session, isolated from login state', async () => {
    const a = await owner(), b = await owner(); await store.putContactsTransaction(a.transaction);
    const input = {stateHash: a.transaction.stateHash, browserBindingHash: a.transaction.browserBindingHash, sessionHash: a.sessionHash, actorUserId: a.user.userId, now: 300};
    assert.equal(await store.consumeOAuthTransaction(input.stateHash, input.browserBindingHash, input.now), null);
    assert.equal(await store.consumeContactsTransaction({...input, actorUserId: b.user.userId}), null);
    assert.equal(await store.consumeContactsTransaction({...input, sessionHash: b.sessionHash}), null);
    assert.equal(await store.consumeContactsTransaction({...input, browserBindingHash: sha('wrong')}), null);
    const results = await Promise.all(Array.from({length: 4}, () => store.consumeContactsTransaction(input)));
    assert.equal(results.filter(Boolean).length, 1); assert.deepEqual(results.find(Boolean), a.transaction);
  });
  it('denies mismatched subject/scope sessions and expired/revoked callbacks; cleanup does not break session pruning', async () => {
    const a = await owner(), b = await owner();
    await rejectsCode(() => store.putContactsTransaction({...a.transaction, scopeId: b.scopeId}), 'FORBIDDEN');
    await rejectsCode(() => store.putContactsTransaction({...a.transaction, googleSubject: b.user.googleSubject}), 'FORBIDDEN');
    await rejectsCode(() => store.putContactsTransaction({...a.transaction, sessionHash: b.sessionHash}), 'FORBIDDEN');
    await store.putContactsTransaction(a.transaction);
    const input = {stateHash: a.transaction.stateHash, browserBindingHash: a.transaction.browserBindingHash, sessionHash: a.sessionHash, actorUserId: a.user.userId, now: 500};
    assert.equal(await store.consumeContactsTransaction(input), null);
    await store.revokeSession(a.sessionHash, 250);
    assert.equal(await store.consumeContactsTransaction({...input, now: 300}), null);
    await pool.query('UPDATE app_sessions SET expires_at=1000 WHERE token_hash=$1', [a.sessionHash]);
    await store.pruneExpiredAuth(1000);
    assert.equal((await pool.query('SELECT count(*) FROM contacts_transactions WHERE state_hash=$1', [a.transaction.stateHash])).rows[0].count, '0');
  });
  it('atomically creates one authorized source and evidenced root identity without adding contacts or relationships', async () => {
    const a = await owner();
    await Promise.all(Array.from({length: 4}, () => store.commitContactsGrant(a.grant, a.sessionHash)));
    const scope = await store.authorizePrivateScope(a.user.userId, a.scopeId), graph = await store.readSnapshot(scope);
    assert.equal(graph.sources.length, 1); assert.equal(graph.graphVersion, '1');
    assert.equal(graph.people.length, 1); assert.equal(graph.identities.length, 1);
    assert.equal(graph.identities[0].externalId, a.user.googleSubject); assert.equal(graph.identities[0].personId, graph.rootPersonId);
    assert.equal(graph.searchEdges.length, 0); assert.equal(graph.observedLinks.length, 0);
    assert.equal(JSON.stringify(graph).includes('encrypted1'), false);
    assert.deepEqual(await store.getContactsGrant(a.user.userId, a.grant.sourceId), a.grant);
    await rejectsCode(() => store.commitContactsGrant({...a.grant, sourceId: randomUUID()}, a.sessionHash), 'VERSION_CONFLICT');
  });
  it('rejects missing Contacts permission and cross-owner grant access/update', async () => {
    const a = await owner(), b = await owner();
    await rejectsCode(() => store.commitContactsGrant({...a.grant, grantedScopes: ['openid']}, a.sessionHash), 'INVALID_INPUT');
    await rejectsCode(() => store.commitContactsGrant({...a.grant, scopeId: b.scopeId}, a.sessionHash), 'FORBIDDEN');
    await rejectsCode(() => store.commitContactsGrant({...a.grant, googleSubject: b.user.googleSubject}, a.sessionHash), 'FORBIDDEN');
    await store.commitContactsGrant(a.grant, a.sessionHash);
    assert.equal(await store.getContactsGrant(b.user.userId, a.grant.sourceId), null);
    assert.equal(await store.revokeContactsGrant(b.user.userId, a.grant.sourceId, a.grant.version, 300), false);
    await rejectsCode(() => store.replaceContactsGrant({...a.grant, ownerUserId: b.user.userId, version: randomUUID()}, a.grant.version), 'FORBIDDEN');
  });
  it('requires a live session owned by the grant actor at persistence', async () => {
    const a = await owner(), b = await owner();
    for (const sessionHash of [b.sessionHash, sha('missing-session')])
      await rejectsCode(() => store.commitContactsGrant(a.grant, sessionHash), 'UNAUTHENTICATED');
    await rejectsCode(() => store.commitContactsGrant(a.grant), 'INVALID_INPUT');
    await store.revokeSession(a.sessionHash, 300);
    await rejectsCode(() => store.commitContactsGrant(a.grant, a.sessionHash), 'UNAUTHENTICATED');
    const graph = await store.readSnapshot(await store.authorizePrivateScope(a.user.userId, a.scopeId));
    assert.equal(graph.sources.length, 0); assert.equal(graph.graphVersion, '0');
  });
  it('rolls source, root identity and graph version back if encrypted-grant persistence fails', async () => {
    const a = await owner();
    await pool.query("CREATE FUNCTION reject_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test rollback'; END $$");
    await pool.query('CREATE TRIGGER reject_grant BEFORE INSERT ON contacts_grants FOR EACH ROW EXECUTE PROCEDURE reject_grant()');
    try { await assert.rejects(() => store.commitContactsGrant(a.grant, a.sessionHash)); }
    finally { await pool.query('DROP TRIGGER reject_grant ON contacts_grants'); await pool.query('DROP FUNCTION reject_grant()'); }
    const graph = await store.readSnapshot(await store.authorizePrivateScope(a.user.userId, a.scopeId));
    assert.equal(graph.graphVersion, '0'); assert.equal(graph.sources.length, 0); assert.equal(graph.identities.length, 0);
    assert.equal(await store.getContactsGrant(a.user.userId, a.grant.sourceId), null);
  });
  it('allows one refresh winner, rejects stale refresh after consent, and erases revoked credentials while retaining evidence', async () => {
    const a = await owner(); await store.commitContactsGrant(a.grant, a.sessionHash);
    const refresh = {...a.grant, updatedAt: 300, accessTokenCiphertext: 'encrypted3', version: randomUUID()};
    const results = await Promise.all(Array.from({length: 5}, () => store.replaceContactsGrant(refresh, a.grant.version)));
    assert.equal(results.filter(Boolean).length, 1);
    const consent = {...refresh, updatedAt: 400, version: randomUUID()}; await store.commitContactsGrant(consent, a.sessionHash);
    assert.equal(await store.replaceContactsGrant({...refresh, version: randomUUID()}, refresh.version), false);
    assert.equal(await store.revokeContactsGrant(a.user.userId, a.grant.sourceId, refresh.version, 450), false);
    assert.equal(await store.revokeContactsGrant(a.user.userId, a.grant.sourceId, consent.version, 450), true);
    assert.equal(await store.getContactsGrant(a.user.userId, a.grant.sourceId), null);
    assert.equal(await store.replaceContactsGrant({...consent, version: randomUUID()}, consent.version), false);
    const persisted = (await pool.query('SELECT grant_data FROM contacts_grants WHERE source_id=$1', [a.grant.sourceId])).rows[0].grant_data;
    assert.equal(persisted.accessTokenCiphertext, ''); assert.equal(persisted.refreshTokenCiphertext, null); assert.equal(persisted.revokedAt, 450);
    const graph = await store.readSnapshot(await store.authorizePrivateScope(a.user.userId, a.scopeId));
    assert.equal(graph.sources.length, 1); assert.equal(graph.identities.length, 1);
  });
  it('rechecks enabled source and current policy on every credential read/refresh', async () => {
    const a = await owner(); await store.commitContactsGrant(a.grant, a.sessionHash);
    await pool.query('UPDATE private_sources SET enabled=false WHERE id=$1', [a.grant.sourceId]);
    assert.equal(await store.getContactsGrant(a.user.userId, a.grant.sourceId), null);
    assert.equal(await store.replaceContactsGrant({...a.grant, version: randomUUID()}, a.grant.version), false);
    await pool.query('UPDATE private_sources SET enabled=true,policy_version=$1 WHERE id=$2', ['changed', a.grant.sourceId]);
    assert.equal(await store.getContactsGrant(a.user.userId, a.grant.sourceId), null);
    assert.equal(await store.replaceContactsGrant({...a.grant, version: randomUUID()}, a.grant.version), false);
    await rejectsCode(() => store.commitContactsGrant({...a.grant, version: randomUUID()}, a.sessionHash), 'VERSION_CONFLICT');
  });
});
