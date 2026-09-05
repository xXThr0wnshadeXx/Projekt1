import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { Pool } from 'pg';
import { PgStore } from '../dist/packages/server/storage/postgres.js';
import { migratePrivateStorage, migrateContactsStorage } from '../dist/packages/server/storage/migrate.js';
import { GoogleImportBridge } from '../dist/packages/server/imports/bridge.js';
import { validateNormalizedImport, validateGraphBuildEvent } from '../dist/contracts/validation.js';
const url = process.env.STORAGE_TEST_DATABASE_URL;
const sha = value => createHash('sha256').update(value).digest('hex');
const migration = name => fileURLToPath(new URL(`../migrations/${name}`, import.meta.url));
const rejectsCode = (action, code) => assert.rejects(action, error => error.code === code);

// Anonymous normalized contract fixture. Provider retrieval itself is injected and untested here.
function contactsBatch(input) {
  const evidence = [], people = [], observedLinks = [], affiliations = [];
  for (const number of ['2', '3']) {
    const identityEvidence = `i_${sha(number + input.retrievedAt)}`, contactEvidence = `c_${sha(number + input.retrievedAt)}`, affiliationEvidence = `a_${sha(number + input.retrievedAt)}`;
    people.push({tempId: `p${number}`, displayName: '2', identities: [{platform: 'GOOGLE_CONTACTS', externalId: `people/${number}`}], evidenceIds: [identityEvidence]});
    evidence.push(...[[identityEvidence, 'IDENTITY'], [contactEvidence, 'RELATIONSHIP'], [affiliationEvidence, 'AFFILIATION']].map(([id, claimKind]) => ({id, sourceId: input.sourceId, summary: number, observedAt: input.retrievedAt, confidence: 1, claimKind})));
    observedLinks.push({fromRef: input.ownerPersonId, toRef: `p${number}`, kind: 'CONTACT_SAVED', evidenceIds: [contactEvidence]});
    affiliations.push({personRef: `p${number}`, organizationName: number, current: false, evidenceIds: [affiliationEvidence]});
  }
  return {schemaVersion: 1, batchId: input.batchId, sourceId: input.sourceId, people, relationships: [], observedLinks, affiliations, evidence, warnings: []};
}

describe('real PostgreSQL normalized Google import bridge', {skip: !url}, () => {
  let admin, pool, store;
  const schema = `bridge_test_${randomUUID().replaceAll('-', '')}`;
  before(async () => {
    admin = new Pool({connectionString: url}); await admin.query(`CREATE SCHEMA ${schema}`);
    pool = new Pool({connectionString: url, options: `-c search_path=${schema}`, max: 12}); store = new PgStore(pool);
    await migratePrivateStorage(pool, migration('001_private_storage.sql'));
    await migrateContactsStorage(pool, migration('002_contacts_grants.sql'));
  });
  after(async () => { await pool?.end(); if (admin) { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); } });
  async function owner() {
    const user = await store.upsertGoogleUser({googleSubject: randomUUID(), displayName: '1'});
    const scopeId = (await store.listPrivateScopes(user.userId))[0].id, sourceId = `gc_${sha(JSON.stringify([user.userId, scopeId, user.googleSubject]))}`;
    await store.commitContactsGrant({ownerUserId: user.userId, scopeId, sourceId, googleSubject: user.googleSubject, grantedScopes: ['https://www.googleapis.com/auth/contacts.readonly'], accessTokenCiphertext: 'encrypted1', accessExpiresAt: 1000, refreshTokenCiphertext: null, refreshExpiresAt: null, createdAt: 200, updatedAt: 200, revokedAt: null, version: randomUUID()});
    return {user, scopeId, sourceId};
  }
  function bridge(owner, override = {}) {
    let clock = Date.parse('2026-09-05T00:00:00.000Z'), retrievalCalls = 0, tokenCalls = 0;
    const auth = {resolveSession: async credential => credential === owner.user.userId ? {userId: owner.user.userId} : null};
    const contacts = {getFreshAccessToken: async (credential, sourceId) => { tokenCalls++; return {accessToken: 'private-access', scopeId: owner.scopeId, sourceId, expiresAt: clock + 1000}; }};
    const ports = {auth, contacts, store, now: () => clock, retrieveAndNormalize: async input => {retrievalCalls++; return contactsBatch(input);}, ...override};
    return {api: new GoogleImportBridge(ports), advance: () => {clock += 1000;}, calls: () => ({retrievalCalls, tokenCalls})};
  }
  const start = (a, key = 'import1', version = '1') => ({scopeId: a.scopeId, sourceId: a.sourceId, expectedGraphVersion: version, idempotencyKey: key});
  const approval = (a, jobId, version = '1') => ({scopeId: a.scopeId, jobId, expectedGraphVersion: version, idempotencyKey: 'approval1', confirm: true});
  async function graph(a) { return store.readSnapshot(await store.authorizePrivateScope(a.user.userId, a.scopeId)); }
  it('stages source-bound normalized provenance, shows safe review, then explicitly publishes people and committed events', async () => {
    const a = await owner(), b = bridge(a), beforeGraph = await graph(a);
    const job = await b.api.start(a.user.userId, start(a));
    assert.equal(job.status, 'PENDING_REVIEW'); assert.equal((await graph(a)).people.length, 1);
    const review = await b.api.review(a.user.userId, {scopeId: a.scopeId, jobId: job.jobId});
    assert.equal(review.counts.newPeople, 2); assert.equal(review.canApprove, true);
    assert.equal(review.people.every(p => p.disposition === 'NEW_PERSON'), true);
    assert.equal(review.affiliations.every(a => a.state === 'PENDING' && a.current === false), true);
    assert.equal(JSON.stringify(review).includes('people/2'), false); assert.equal(JSON.stringify(review).includes('private-access'), false);
    const envelope = await store.readImportEnvelopePrivate(a.user.userId, a.scopeId, job.jobId);
    validateNormalizedImport(envelope, {...envelope.context, existingPersonIds: new Set(beforeGraph.people.map(p => p.id)), existingEvidenceIds: new Set(beforeGraph.evidence.map(e => e.id)), existingIdentities: beforeGraph.identities});
    assert.equal(envelope.records.length, 2); assert.equal(envelope.facts.length, 4); assert.equal(envelope.evidenceRecords.length, 6);
    for (const record of envelope.records) {
      const resolved = await b.api.readNormalizedRecord(a.user.userId, {scopeId: a.scopeId, jobId: job.jobId, privatePayloadRef: record.privatePayloadRef});
      assert.equal(resolved.record.contentDigest, record.contentDigest);
      assert.equal(resolved.payload.person.identities[0].externalId, record.externalRecordId);
    }
    const result = await b.api.approve(a.user.userId, approval(a, job.jobId));
    const afterGraph = await graph(a);
    assert.equal(afterGraph.people.length, 3); assert.equal(afterGraph.observedLinks.length, 2);
    assert.equal(afterGraph.people.filter(p => p.displayName === '2').length, 2); // Equal names never merge.
    assert.equal(afterGraph.relationships.length, 0); assert.equal(afterGraph.searchEdges.length, 0);
    for (const event of result.events) validateGraphBuildEvent(event, {jobId: job.jobId, scopeId: a.scopeId, afterSeq: event.seq - 1, before: beforeGraph, after: afterGraph, candidateIds: new Set(), proposalIds: new Set()});
  });
  it('retries commands without provider calls, including after approval and stale graph versions', async () => {
    const a = await owner(), b = bridge(a), job = await b.api.start(a.user.userId, start(a));
    await b.api.approve(a.user.userId, approval(a, job.jobId)); b.advance();
    const retried = await b.api.start(a.user.userId, start(a, 'import1', 'obsolete'));
    assert.equal(retried.jobId, job.jobId); assert.equal(retried.duplicate, true); assert.equal(retried.status, 'OBSERVATIONS_APPROVED');
    assert.deepEqual(b.calls(), {retrievalCalls: 1, tokenCalls: 1});
    assert.equal((await b.api.approve(a.user.userId, approval(a, job.jobId, 'obsolete'))).duplicate, true);
  });
  it('reimports exact accepted source identities without duplicating people, observations or pending affiliations', async () => {
    const a = await owner(), b = bridge(a), first = await b.api.start(a.user.userId, start(a));
    await b.api.approve(a.user.userId, approval(a, first.jobId)); const original = await graph(a); b.advance();
    const second = await b.api.start(a.user.userId, start(a, 'import2', '2'));
    const review = await b.api.review(a.user.userId, {scopeId: a.scopeId, jobId: second.jobId});
    assert.equal(review.counts.newPeople, 0); assert.equal(review.counts.existingPeople, 2);
    assert.equal(review.people.every(p => p.disposition === 'EXISTING_SOURCE_IDENTITY'), true);
    await b.api.approve(a.user.userId, approval(a, second.jobId, '2'));
    const current = await graph(a);
    assert.deepEqual(current.people.map(p => p.id), original.people.map(p => p.id));
    assert.deepEqual(current.observedLinks.map(l => l.id), original.observedLinks.map(l => l.id));
    assert.equal(current.people.flatMap(p => p.affiliations).length, 2);
    assert.equal(current.searchEdges.length, 0); assert.equal(current.graphVersion, '3');
  });
  it('denies unauthenticated/cross-owner operations before retrieving tokens or data and rejects client actor/root overrides', async () => {
    const a = await owner(), other = await owner(), b = bridge(a);
    await rejectsCode(() => b.api.start('unknown', start(a)), 'UNAUTHENTICATED');
    await rejectsCode(() => b.api.start(a.user.userId, start(other)), 'FORBIDDEN');
    await assert.rejects(() => b.api.start(a.user.userId, {...start(a), ownerUserId: other.user.userId}));
    await assert.rejects(() => b.api.start(a.user.userId, {...start(a), rootPersonId: 'injected'}));
    assert.deepEqual(b.calls(), {retrievalCalls: 0, tokenCalls: 0});
    const job = await b.api.start(a.user.userId, start(a)); const wrong = bridge(other);
    await rejectsCode(() => wrong.api.review(other.user.userId, {scopeId: a.scopeId, jobId: job.jobId}), 'FORBIDDEN');
    await rejectsCode(() => wrong.api.approve(other.user.userId, approval(a, job.jobId)), 'FORBIDDEN');
    const envelope = await store.readImportEnvelopePrivate(a.user.userId, a.scopeId, job.jobId);
    await rejectsCode(() => wrong.api.readNormalizedRecord(other.user.userId, {scopeId: a.scopeId, jobId: job.jobId, privatePayloadRef: envelope.records[0].privatePayloadRef}), 'FORBIDDEN');
  });
  it('requires deliberate confirmation and a fresh version; malformed/invented provider relationships never stage', async () => {
    const a = await owner(), b = bridge(a), job = await b.api.start(a.user.userId, start(a));
    await assert.rejects(() => b.api.approve(a.user.userId, {...approval(a, job.jobId), confirm: false}));
    await assert.rejects(() => b.api.approve(a.user.userId, {...approval(a, job.jobId), personAssignments: []}));
    await rejectsCode(() => b.api.approve(a.user.userId, approval(a, job.jobId, '0')), 'VERSION_CONFLICT');
    assert.equal((await graph(a)).people.length, 1);
    const bad = bridge(a, {retrieveAndNormalize: async input => {
      const batch = contactsBatch(input); batch.observedLinks[0].kind = 'FOLLOWS'; return batch;
    }});
    await rejectsCode(() => bad.api.start(a.user.userId, start(a, 'bad')), 'INVALID_INPUT');
    assert.equal((await pool.query('SELECT count(*) FROM import_jobs WHERE owner_user_id=$1', [a.user.userId])).rows[0].count, '1');
  });
  it('concurrent same-key commands return one durable job despite different retrieval timestamps', async () => {
    const a = await owner(); let sequence = 0;
    const b = bridge(a, {now: () => Date.parse('2026-09-05T00:00:00.000Z') + (++sequence) * 1000});
    const results = await Promise.all(Array.from({length: 6}, () => b.api.start(a.user.userId, start(a))));
    assert.equal(new Set(results.map(r => r.jobId)).size, 1);
    assert.equal(results.filter(r => !r.duplicate).length, 1);
    assert.equal((await pool.query('SELECT count(*) FROM import_jobs WHERE owner_user_id=$1', [a.user.userId])).rows[0].count, '1');
  });
  it('detects source-identity changes between separately staged batches and requires a fresh import', async () => {
    const a = await owner(), b = bridge(a), first = await b.api.start(a.user.userId, start(a)); b.advance();
    const second = await b.api.start(a.user.userId, start(a, 'import2'));
    await b.api.approve(a.user.userId, approval(a, first.jobId));
    const review = await b.api.review(a.user.userId, {scopeId: a.scopeId, jobId: second.jobId});
    assert.equal(review.canApprove, false);
    await rejectsCode(() => b.api.approve(a.user.userId, approval(a, second.jobId, '2')), 'VERSION_CONFLICT');
    assert.equal((await graph(a)).people.length, 3);
  });
});
