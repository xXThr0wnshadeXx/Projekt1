import { createHash, randomUUID } from 'node:crypto';
import type { ContactsStore, ContactsGrant, ContactsTransaction } from '../auth/contacts-ports.js';
import { PgContactsPersistence } from './contacts.js';
import { Pool, type PoolClient } from 'pg';
import type { AuthStore, AuthUser, OAuthTransaction, StoredSession } from '../auth/ports.js';
import type { ImportPort, ImportRetryKey, ImportReceipt, ImportOutcome, ReadPort, PrivateScope } from '../service.js';
import { ServiceError } from '../service.js';
import type { GraphSnapshot, GraphBuildEvent, NormalizedImportEnvelope, SourceSummary, SourceIdentityRef, Person } from '../../../contracts/index.js';
import { canonicalJson } from '../../../contracts/canonical.js';
import { normalizeImportShape, validateGraphSnapshot, validateNormalizedImport } from '../../../contracts/validation.js';

type ScopeRow = { id: string; owner_user_id: string; root_person_id: string; graph_version: string; snapshot: GraphSnapshot };
type SourceRow = { id: string; policy_version: string; enabled: boolean; summary: SourceSummary };
type JobRow = { id: string; payload_digest: string; envelope: NormalizedImportEnvelope; status: string; review_key: string | null; review_digest: string | null; events: GraphBuildEvent[] };
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const forbidden = () => new ServiceError('FORBIDDEN', 403);
const conflict = () => new ServiceError('VERSION_CONFLICT', 409);
const invalid = () => new ServiceError('INVALID_INPUT', 400);
const timestamp = () => new Date().toISOString();
const stableId = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const id = (value: string) => { if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) throw invalid(); return value; };
const hash = (value: string) => { if (!/^[a-f0-9]{64}$/.test(value)) throw invalid(); return value; };

/** These assignments are an explicit user review, not an inferred entity merge.
 * null means create a separate person. Existing person IDs must be consciously selected in review.
 */
export interface ApproveImportInput {
  actorUserId: string; scopeId: string; jobId: string; expectedGraphVersion: string;
  idempotencyKey: string; personAssignments: Array<{tempId: string; personId: string | null}>;
}

/** PostgreSQL is the authority. No ownership decision trusts a caller-supplied PrivateScope alone. */
export class PgStore implements AuthStore, ReadPort, ImportPort, ContactsStore {
  private readonly contacts: PgContactsPersistence;
  constructor(readonly pool: Pool) { this.contacts = new PgContactsPersistence(pool); }
  putContactsTransaction(t: ContactsTransaction) { return this.contacts.putContactsTransaction(t); }
  consumeContactsTransaction(input: Parameters<ContactsStore['consumeContactsTransaction']>[0]) { return this.contacts.consumeContactsTransaction(input); }
  commitContactsGrant(grant: ContactsGrant) { return this.contacts.commitContactsGrant(grant); }
  getContactsGrant(ownerUserId: string, sourceId: string) { return this.contacts.getContactsGrant(ownerUserId, sourceId); }
  replaceContactsGrant(grant: ContactsGrant, expectedVersion: string) { return this.contacts.replaceContactsGrant(grant, expectedVersion); }
  revokeContactsGrant(ownerUserId: string, sourceId: string, expectedVersion: string, now: number) { return this.contacts.revokeContactsGrant(ownerUserId, sourceId, expectedVersion, now); }
  pruneExpiredContactsTransactions(now: number) { return this.contacts.pruneExpiredContactsTransactions(now); }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try { await client.query('BEGIN'); const result = await work(client); await client.query('COMMIT'); return result; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  private async ownedScope(client: PoolClient, userId: string, scopeId: string, lock = false): Promise<ScopeRow> {
    const row = (await client.query<ScopeRow>(`SELECT * FROM private_scopes WHERE id=$1 AND owner_user_id=$2${lock ? ' FOR UPDATE' : ''}`, [scopeId, userId])).rows[0];
    if (!row) throw forbidden(); return row;
  }
  private async sourceRows(client: PoolClient, row: ScopeRow): Promise<SourceRow[]> {
    return (await client.query<SourceRow>('SELECT id,policy_version,enabled,summary FROM private_sources WHERE scope_id=$1 AND owner_user_id=$2 AND enabled=true ORDER BY id', [row.id, row.owner_user_id])).rows;
  }
  private async checkedSnapshot(client: PoolClient, row: ScopeRow): Promise<GraphSnapshot> {
    const sources = await this.sourceRows(client, row);
    return validateGraphSnapshot(row.snapshot, {scopeId: row.id, rootPersonId: row.root_person_id, sourceIds: new Set(sources.map(s => s.id))});
  }
  private async saveSnapshot(client: PoolClient, row: ScopeRow, snapshot: GraphSnapshot): Promise<void> {
    snapshot.graphVersion = (BigInt(row.graph_version) + 1n).toString();
    const sources = await this.sourceRows(client, row);
    validateGraphSnapshot(snapshot, {scopeId: row.id, rootPersonId: row.root_person_id, sourceIds: new Set(sources.map(s => s.id))});
    const result = await client.query('UPDATE private_scopes SET graph_version=$1,snapshot=$2 WHERE id=$3 AND owner_user_id=$4 AND graph_version=$5', [snapshot.graphVersion, snapshot, row.id, row.owner_user_id, row.graph_version]);
    if (result.rowCount !== 1) throw conflict();
  }
  async authorizePrivateScope(userId: string, scopeId: string): Promise<PrivateScope | null> {
    return this.transaction(async c => {
      const result = await c.query<ScopeRow>('SELECT * FROM private_scopes WHERE id=$1 AND owner_user_id=$2 FOR SHARE', [scopeId, userId]);
      const row = result.rows[0]; if (!row) return null;
      return {scopeId: row.id, ownerUserId: row.owner_user_id, rootPersonId: row.root_person_id, sourceIds: new Set((await this.sourceRows(c, row)).map(s => s.id))};
    });
  }
  async readSnapshot(scope: PrivateScope): Promise<GraphSnapshot | null> {
    return this.transaction(async c => {
      // Recheck the authoritative owner and root even if a stale or forged scope object is supplied.
      const row = await this.ownedScope(c, scope.ownerUserId, scope.scopeId, true);
      if (row.root_person_id !== scope.rootPersonId) throw forbidden();
      return this.checkedSnapshot(c, row);
    });
  }

  async upsertGoogleUser(input: {googleSubject: string; displayName: string}): Promise<AuthUser> {
    if (!input.googleSubject || input.googleSubject.length > 255 || !input.displayName.trim() || input.displayName.length > 200) throw invalid();
    return this.transaction(async c => {
      // ON CONFLICT serializes simultaneous first callbacks for a subject; only the actual INSERT
      // provisions a new scope, in the same transaction, so a user can never exist without its root.
      const userId = randomUUID();
      const inserted = await c.query('INSERT INTO app_users(id,google_subject,display_name) VALUES($1,$2,$3) ON CONFLICT (google_subject) DO NOTHING RETURNING id', [userId, input.googleSubject, input.displayName]);
      if (inserted.rowCount === 1) {
        const scopeId = randomUUID(), rootPersonId = randomUUID();
        const root: Person = {id: rootPersonId, displayName: input.displayName, aliases: [], identityIds: [], affiliations: [], identityConfidence: 1, updatedAt: timestamp()};
        const snapshot: GraphSnapshot = {schemaVersion: 1, scopeId, rootPersonId, graphVersion: '0', people: [root], identities: [], organizations: [], observedLinks: [], relationships: [], searchEdges: [], evidence: [], sources: [], coverage: {completeForAuthorizedSources: false, omittedNodeCount: 0, warnings: ['No relationship sources have been imported.']}};
        validateGraphSnapshot(snapshot, {scopeId, rootPersonId, sourceIds: new Set()});
        await c.query('INSERT INTO private_scopes(id,owner_user_id,root_person_id,graph_version,snapshot) VALUES($1,$2,$3,0,$4)', [scopeId, userId, rootPersonId, snapshot]);
      }
      const row = (await c.query<{id: string; google_subject: string; display_name: string}>('SELECT id,google_subject,display_name FROM app_users WHERE google_subject=$1', [input.googleSubject])).rows[0]!;
      return {userId: row.id, googleSubject: row.google_subject, displayName: row.display_name};
    });
  }
  async getUser(userId: string): Promise<AuthUser | null> {
    const row = (await this.pool.query<{id: string; google_subject: string; display_name: string}>('SELECT id,google_subject,display_name FROM app_users WHERE id=$1', [userId])).rows[0];
    return row ? {userId: row.id, googleSubject: row.google_subject, displayName: row.display_name} : null;
  }
  async listPrivateScopes(userId: string): Promise<Array<{id: string; label: string}>> {
    return (await this.pool.query<{id: string}>('SELECT id FROM private_scopes WHERE owner_user_id=$1 ORDER BY id', [userId])).rows.map(row => ({id: row.id, label: 'Your private network'}));
  }
  async putOAuthTransaction(t: OAuthTransaction): Promise<void> {
    hash(t.stateHash); hash(t.browserBindingHash);
    await this.pool.query('INSERT INTO oauth_transactions(state_hash,browser_binding_hash,nonce,code_verifier,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)', [t.stateHash, t.browserBindingHash, t.nonce, t.codeVerifier, t.createdAt, t.expiresAt]);
  }
  async consumeOAuthTransaction(stateHash: string, bindingHash: string, now: number): Promise<OAuthTransaction | null> {
    const r = (await this.pool.query<{state_hash: string; browser_binding_hash: string; nonce: string; code_verifier: string; created_at: string; expires_at: string}>('DELETE FROM oauth_transactions WHERE state_hash=$1 AND browser_binding_hash=$2 AND expires_at>$3 RETURNING *', [stateHash, bindingHash, now])).rows[0];
    return r ? {stateHash: r.state_hash, browserBindingHash: r.browser_binding_hash, nonce: r.nonce, codeVerifier: r.code_verifier, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at)} : null;
  }
  async putSession(s: StoredSession): Promise<void> {
    hash(s.tokenHash);
    // Never upsert: an accidental token collision cannot reassign or resurrect a session.
    await this.pool.query('INSERT INTO app_sessions(token_hash,user_id,created_at,expires_at,revoked_at) VALUES($1,$2,$3,$4,$5)', [s.tokenHash, s.userId, s.createdAt, s.expiresAt, s.revokedAt]);
  }
  async getSession(tokenHash: string): Promise<StoredSession | null> {
    const r = (await this.pool.query<{token_hash: string; user_id: string; created_at: string; expires_at: string; revoked_at: string | null}>('SELECT * FROM app_sessions WHERE token_hash=$1', [tokenHash])).rows[0];
    return r ? {tokenHash: r.token_hash, userId: r.user_id, createdAt: Number(r.created_at), expiresAt: Number(r.expires_at), revokedAt: r.revoked_at === null ? null : Number(r.revoked_at)} : null;
  }
  async revokeSession(tokenHash: string, now: number): Promise<void> {
    await this.pool.query('UPDATE app_sessions SET revoked_at=COALESCE(revoked_at,$2) WHERE token_hash=$1', [tokenHash, now]);
  }
  async pruneExpiredAuth(now: number): Promise<void> {
    await this.transaction(async c => {
      await c.query('DELETE FROM oauth_transactions WHERE expires_at<=$1', [now]);
      await c.query('DELETE FROM app_sessions WHERE expires_at<=$1', [now]);
    });
  }

  /** Server-only after source consent. Identity must come from verified provider ownership,
   * never a client-chosen root mapping. It allows normalized source endpoint provenance. */
  async provisionSource(input: {actorUserId: string; scopeId: string; expectedGraphVersion: string; source: SourceSummary; policyVersion: string; verifiedOwnerIdentity?: SourceIdentityRef}): Promise<{sourceId: string; graphVersion: string}> {
    id(input.source.id); id(input.policyVersion);
    return this.transaction(async c => {
      const row = await this.ownedScope(c, input.actorUserId, input.scopeId, true);
      const existing = (await c.query<{scope_id: string; owner_user_id: string; policy_version: string; summary: SourceSummary; owner_identity: SourceIdentityRef | null}>('SELECT scope_id,owner_user_id,policy_version,summary,owner_identity FROM private_sources WHERE id=$1', [input.source.id])).rows[0];
      if (existing) {
        if (existing.scope_id !== row.id || existing.owner_user_id !== row.owner_user_id) throw forbidden();
        if (existing.policy_version !== input.policyVersion || canonicalJson(existing.summary) !== canonicalJson(input.source) || canonicalJson(existing.owner_identity) !== canonicalJson(input.verifiedOwnerIdentity ?? null)) throw conflict();
        return {sourceId: input.source.id, graphVersion: row.graph_version};
      }
      if (row.graph_version !== input.expectedGraphVersion) throw conflict();
      const snapshot = await this.checkedSnapshot(c, row);
      await c.query('INSERT INTO private_sources(id,scope_id,owner_user_id,policy_version,summary,owner_identity) VALUES($1,$2,$3,$4,$5,$6)', [input.source.id, row.id, row.owner_user_id, input.policyVersion, input.source, input.verifiedOwnerIdentity ?? null]);
      snapshot.sources.push(input.source);
      if (input.verifiedOwnerIdentity) {
        const now = timestamp(), evidenceId = randomUUID(), identityId = randomUUID();
        snapshot.evidence.push({id: evidenceId, sourceId: input.source.id, summary: 'Account ownership verified by the authorized source connection.', observedAt: now, confidence: 1, claimKind: 'IDENTITY'});
        snapshot.identities.push({id: identityId, sourceId: input.source.id, ...input.verifiedOwnerIdentity, personId: row.root_person_id, assignmentState: 'CONFIRMED', evidenceIds: [evidenceId], updatedAt: now});
        snapshot.people.find(p => p.id === row.root_person_id)!.identityIds.push(identityId);
      }
      await this.saveSnapshot(c, row, snapshot);
      return {sourceId: input.source.id, graphVersion: snapshot.graphVersion};
    });
  }
  private async importAuthority(c: PoolClient, input: ImportRetryKey): Promise<ScopeRow> {
    const context = input.context;
    if (context.ownerUserId !== input.actorUserId || context.sharingDecisionId !== null) throw forbidden();
    // All source mutation APIs use this same scope lock. It prevents revocation/version changes
    // between ownership validation, receipt lookup, reference checks and the durable commit.
    const row = await this.ownedScope(c, input.actorUserId, context.scopeId, true);
    const source = (await c.query<SourceRow>('SELECT id,policy_version,enabled,summary FROM private_sources WHERE id=$1 AND scope_id=$2 AND owner_user_id=$3', [context.sourceId, row.id, row.owner_user_id])).rows[0];
    if (!source?.enabled || source.policy_version !== context.sourcePolicyVersion) throw forbidden();
    return row;
  }
  private async receipt(c: PoolClient, input: ImportRetryKey): Promise<ImportReceipt | null> {
    const row = (await c.query<{id: string; payload_digest: string}>('SELECT id,payload_digest FROM import_jobs WHERE scope_id=$1 AND source_id=$2 AND batch_id=$3 AND owner_user_id=$4', [input.context.scopeId, input.context.sourceId, input.context.batchId, input.actorUserId])).rows[0];
    return row ? {payloadDigest: row.payload_digest, outcome: {jobId: row.id, status: 'PENDING_REVIEW', duplicate: false}} : null;
  }
  async lookupRetry(input: ImportRetryKey): Promise<ImportReceipt | null> {
    return this.transaction(async c => { await this.importAuthority(c, input); return this.receipt(c, input); });
  }
  async stage(input: ImportRetryKey & {expectedGraphVersion: string; payloadDigest: string; envelope: NormalizedImportEnvelope}): Promise<ImportOutcome> {
    const envelope = normalizeImportShape(input.envelope);
    if (canonicalJson(envelope.context) !== canonicalJson(input.context) || digest(envelope) !== input.payloadDigest) throw invalid();
    return this.transaction(async c => {
      const row = await this.importAuthority(c, input);
      const prior = await this.receipt(c, input);
      if (prior) {
        if (prior.payloadDigest !== input.payloadDigest) throw conflict();
        return {...prior.outcome, duplicate: true};
      }
      if (row.graph_version !== input.expectedGraphVersion) throw conflict();
      const g = await this.checkedSnapshot(c, row);
      validateNormalizedImport(envelope, {...input.context, existingPersonIds: new Set(g.people.map(p => p.id)), existingEvidenceIds: new Set(g.evidence.filter(e => e.sourceId === input.context.sourceId).map(e => e.id)), existingIdentities: g.identities.filter(i => i.sourceId === input.context.sourceId)});
      const jobId = randomUUID();
      await c.query('INSERT INTO import_jobs(id,scope_id,owner_user_id,source_id,batch_id,payload_digest,envelope,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [jobId, row.id, row.owner_user_id, input.context.sourceId, input.context.batchId, input.payloadDigest, envelope, 'PENDING_REVIEW']);
      // Staging changes no canonical graph data. The graph version advances only on projection.
      return {jobId, status: 'PENDING_REVIEW', duplicate: false};
    });
  }

  /** Backend-only provenance access. Never serialize this envelope from a graph/review route. */
  async readImportEnvelopePrivate(actorUserId: string, scopeId: string, jobId: string): Promise<NormalizedImportEnvelope> {
    return this.transaction(async c => {
      await this.ownedScope(c, actorUserId, scopeId, true);
      const job = (await c.query<JobRow>('SELECT * FROM import_jobs WHERE id=$1 AND scope_id=$2 AND owner_user_id=$3', [jobId, scopeId, actorUserId])).rows[0];
      if (!job) throw forbidden();
      await this.importAuthority(c, {actorUserId, context: job.envelope.context});
      return job.envelope;
    });
  }

  async getImportReview(actorUserId: string, scopeId: string, jobId: string) {
    return this.transaction(async c => {
      const row = await this.ownedScope(c, actorUserId, scopeId, true);
      const job = (await c.query<JobRow>('SELECT * FROM import_jobs WHERE id=$1 AND scope_id=$2 AND owner_user_id=$3', [jobId, scopeId, actorUserId])).rows[0];
      if (!job) throw forbidden();
      await this.importAuthority(c, {actorUserId, context: job.envelope.context});
      // No SourceRecord/privatePayloadRef, provider token, digest or raw envelope escapes.
      return {jobId, graphVersion: row.graph_version, status: job.status, batch: job.envelope.batch, events: job.events};
    });
  }

  async approveImportObservations(input: ApproveImportInput): Promise<{jobId: string; graphVersion: string; duplicate: boolean; events: GraphBuildEvent[]}> {
    id(input.idempotencyKey);
    const reviewDigest = digest({personAssignments: input.personAssignments});
    return this.transaction(async c => {
      const row = await this.ownedScope(c, input.actorUserId, input.scopeId, true);
      const job = (await c.query<JobRow>('SELECT * FROM import_jobs WHERE id=$1 AND scope_id=$2 AND owner_user_id=$3', [input.jobId, row.id, row.owner_user_id])).rows[0];
      if (!job) throw forbidden();
      await this.importAuthority(c, {actorUserId: input.actorUserId, context: job.envelope.context});
      if (job.review_key !== null) {
        if (job.review_key !== input.idempotencyKey || job.review_digest !== reviewDigest) throw conflict();
        const completion = job.events.find(e => e.type === 'IMPORT_COMPLETED');
        return {jobId: job.id, graphVersion: completion?.type === 'IMPORT_COMPLETED' ? completion.graphVersion : row.graph_version, duplicate: true, events: job.events};
      }
      if (row.graph_version !== input.expectedGraphVersion) throw conflict();
      const before = await this.checkedSnapshot(c, row), g = structuredClone(before), n = job.envelope, b = n.batch;
      validateNormalizedImport(n, {...n.context, existingPersonIds: new Set(g.people.map(p => p.id)), existingEvidenceIds: new Set(g.evidence.filter(e => e.sourceId === n.context.sourceId).map(e => e.id)), existingIdentities: g.identities.filter(i => i.sourceId === n.context.sourceId)});
      const assignments = new Map(input.personAssignments.map(a => [a.tempId, a.personId]));
      if (assignments.size !== b.people.length || assignments.size !== input.personAssignments.length || b.people.some(p => !assignments.has(p.tempId))) throw invalid();
      const refs = new Map(g.people.map(p => [p.id, p.id]));
      for (const candidate of b.people) {
        const selected = assignments.get(candidate.tempId)!;
        if (selected !== null && !g.people.some(p => p.id === selected)) throw forbidden();
        const personId = selected ?? randomUUID();
        refs.set(candidate.tempId, personId);
        // A supplied existingPersonId is a proposal, never authority. Require its explicit selection.
        if (candidate.existingPersonId !== undefined && selected !== candidate.existingPersonId) throw conflict();
        if (selected === null) g.people.push({id: personId, displayName: candidate.displayName, aliases: [], identityIds: [], affiliations: [], identityConfidence: 1, updatedAt: timestamp()});
        const person = g.people.find(p => p.id === personId)!;
        for (const candidateIdentity of candidate.identities) {
          const priorIdentity = g.identities.find(i => i.sourceId === b.sourceId && i.platform === candidateIdentity.platform && i.externalId === candidateIdentity.externalId);
          // Existing assignments are immutable here. Full reversible relinking is a separate ledger.
          if (priorIdentity) {
            if (priorIdentity.personId !== personId) throw conflict();
          } else {
            const identityId = stableId(b.sourceId, candidateIdentity.platform, candidateIdentity.externalId);
            g.identities.push({id: identityId, sourceId: b.sourceId, ...candidateIdentity, personId, assignmentState: 'CONFIRMED', evidenceIds: candidate.evidenceIds, updatedAt: timestamp()});
            person.identityIds.push(identityId);
          }
        }
      }
      const resolve = (ref: string) => { const value = refs.get(ref); if (!value) throw invalid(); return value; };
      g.evidence.push(...b.evidence);
      const factFor = (kind: 'OBSERVED_LINK' | 'RELATIONSHIP' | 'AFFILIATION', index: number) => n.facts.find(f => f.kind === kind && f.candidateIndex === index)!;
      const factId = (kind: 'OBSERVED_LINK' | 'RELATIONSHIP' | 'AFFILIATION', index: number) => stableId(b.sourceId, kind, factFor(kind, index).factKey);
      b.observedLinks.forEach((link, i) => {
        const value = {id: factId('OBSERVED_LINK', i), fromPersonId: resolve(link.fromRef), toPersonId: resolve(link.toRef), kind: link.kind, evidenceIds: link.evidenceIds, confidence: Math.min(...link.evidenceIds.map(e => g.evidence.find(x => x.id === e)!.confidence)), observedAt: timestamp()};
        const prior = g.observedLinks.findIndex(l => l.id === value.id);
        if (prior < 0) g.observedLinks.push(value); else g.observedLinks[prior] = value;
      });
      b.relationships.forEach((relationship, i) => {
        const relationshipId = factId('RELATIONSHIP', i);
        // Refreshing source evidence cannot silently replace a user's accepted relationship.
        if (g.relationships.some(r => r.id === relationshipId)) throw conflict();
        g.relationships.push({id: relationshipId, fromPersonId: resolve(relationship.fromRef), toPersonId: resolve(relationship.toRef), kind: relationship.kind, strength: relationship.strengthEstimate, confidence: relationship.confidence, recencyFactor: 1, state: 'PENDING', evidenceIds: relationship.evidenceIds, observedLinkIds: [], updatedAt: timestamp()});
      });
      b.affiliations.forEach(a => {
        const organizationId = stableId(b.sourceId, 'organization', a.organizationName.trim().toLocaleLowerCase('en-US'));
        if (!g.organizations.some(o => o.id === organizationId)) g.organizations.push({id: organizationId, name: a.organizationName});
        const person = g.people.find(p => p.id === resolve(a.personRef))!;
        const same = person.affiliations.findIndex(prior => prior.organizationId === organizationId && prior.role === a.role && prior.current === (a.current ?? null));
        const value = {organizationId, ...(a.role === undefined ? {} : {role: a.role}), current: a.current ?? null, support: {value: true, confidence: Math.min(...a.evidenceIds.map(e => g.evidence.find(x => x.id === e)!.confidence)), evidenceIds: a.evidenceIds, state: 'PENDING' as const}};
        if (same < 0) person.affiliations.push(value);
        else if (person.affiliations[same]!.support.state === 'PENDING') person.affiliations[same] = value;
        // Reimport refreshes pending source metadata; never overwrites a reviewed claim.

      });
      // Observation approval grants visibility, not introduction suitability or employer truth.
      // No SearchEdges are synthesized. Relationship/affiliation confirmation is a later review.
      await this.saveSnapshot(c, row, g);
      const changed = <K extends 'people' | 'identities' | 'organizations' | 'observedLinks' | 'relationships' | 'searchEdges' | 'evidence' | 'sources'>(key: K): GraphSnapshot[K] => g[key].filter(value => !before[key].some(prior => prior.id === value.id && canonicalJson(prior) === canonicalJson(value))) as GraphSnapshot[K];
      const envelope = {schemaVersion: 1 as const, jobId: job.id, scopeId: row.id};
      const events: GraphBuildEvent[] = [
        {...envelope, seq: 0, type: 'IMPORT_STARTED', sourceId: b.sourceId},
        {...envelope, seq: 1, type: 'BATCH_COMMITTED', operationKind: 'REVIEW', baseGraphVersion: before.graphVersion, graphVersion: g.graphVersion, people: changed('people'), identities: changed('identities'), organizations: changed('organizations'), observedLinks: changed('observedLinks'), relationships: changed('relationships'), searchEdges: [], evidence: changed('evidence'), sources: [], removedPersonIds: [], removedEdgeIds: []},
        {...envelope, seq: 2, type: 'IMPORT_COMPLETED', graphVersion: g.graphVersion, peopleAdded: g.people.length - before.people.length, linksAdded: g.observedLinks.length - before.observedLinks.length, warnings: ['Imported relationship and affiliation claims still require confirmation before search.']},
      ];
      await c.query("UPDATE import_jobs SET status='OBSERVATIONS_APPROVED',review_key=$1,review_digest=$2,events=$3 WHERE id=$4 AND owner_user_id=$5 AND scope_id=$6", [input.idempotencyKey, reviewDigest, JSON.stringify(events), job.id, row.owner_user_id, row.id]);
      return {jobId: job.id, graphVersion: g.graphVersion, duplicate: false, events};
    });
  }
}
