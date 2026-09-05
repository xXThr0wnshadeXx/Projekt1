import { randomUUID, createHash } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import type { ContactsStore, ContactsGrant, ContactsTransaction } from '../auth/contacts-ports.js';
import { ServiceError } from '../service.js';
import type { GraphSnapshot, SourceSummary } from '../../../contracts/index.js';
import { validateGraphSnapshot } from '../../../contracts/validation.js';

export const CONTACTS_SOURCE_POLICY = 'google-contacts-private-v1';
const contactsScope = 'https://www.googleapis.com/auth/contacts.readonly';
const denied = () => new ServiceError('FORBIDDEN', 403);
const conflict = () => new ServiceError('VERSION_CONFLICT', 409);
const invalid = () => new ServiceError('INVALID_INPUT', 400);
const isHash = (value: string) => /^[a-f0-9]{64}$/.test(value);
const isId = (value: string) => /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
const validTime = (value: number) => Number.isSafeInteger(value) && value >= 0;
const stableId = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
type ScopeRow = {id: string; owner_user_id: string; root_person_id: string; graph_version: string; snapshot: GraphSnapshot};
type SourceRow = {id: string; scope_id: string; owner_user_id: string; enabled: boolean; policy_version: string; summary: SourceSummary; owner_identity: {platform: string; externalId: string} | null};

/** Internal PgStore helper. All source/snapshot writes take the same scope lock as imports. */
export class PgContactsPersistence implements ContactsStore {
  constructor(private readonly pool: Pool) {}
  private async tx<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try { await c.query('BEGIN'); const result = await work(c); await c.query('COMMIT'); return result; }
    catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  private async scope(c: PoolClient, userId: string, scopeId: string, subject?: string): Promise<ScopeRow> {
    const row = (await c.query<ScopeRow & {google_subject: string}>('SELECT s.*,u.google_subject FROM private_scopes s JOIN app_users u ON u.id=s.owner_user_id WHERE s.id=$1 AND s.owner_user_id=$2 FOR UPDATE OF s', [scopeId, userId])).rows[0];
    if (!row || (subject !== undefined && row.google_subject !== subject)) throw denied(); return row;
  }
  private checkGrant(g: ContactsGrant): void {
    if (![g.ownerUserId, g.scopeId, g.sourceId, g.version].every(isId) || !g.googleSubject || g.googleSubject.length > 255 || !Array.isArray(g.grantedScopes) || !g.grantedScopes.includes(contactsScope) || new Set(g.grantedScopes).size !== g.grantedScopes.length || !g.grantedScopes.every(s => typeof s === 'string' && s.length <= 300) || !g.accessTokenCiphertext || g.accessTokenCiphertext.length > 32768 || (g.refreshTokenCiphertext !== null && (!g.refreshTokenCiphertext || g.refreshTokenCiphertext.length > 32768)) || ![g.accessExpiresAt, g.createdAt, g.updatedAt].every(validTime) || (g.refreshExpiresAt !== null && !validTime(g.refreshExpiresAt)) || (g.revokedAt !== null && !validTime(g.revokedAt)) || g.updatedAt < g.createdAt) throw invalid();
  }
  async putContactsTransaction(t: ContactsTransaction): Promise<void> {
    if (t.purpose !== 'GOOGLE_CONTACTS' || ![t.stateHash, t.browserBindingHash, t.sessionHash].every(isHash)) throw invalid();
    await this.tx(async c => {
      await this.scope(c, t.actorUserId, t.scopeId, t.googleSubject);
      const session = await c.query('SELECT token_hash FROM app_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND expires_at>$3 FOR SHARE', [t.sessionHash, t.actorUserId, t.createdAt]);
      if (!session.rowCount) throw denied();
      await c.query('INSERT INTO contacts_transactions(state_hash,browser_binding_hash,session_hash,actor_user_id,scope_id,source_id,google_subject,nonce,code_verifier,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [t.stateHash, t.browserBindingHash, t.sessionHash, t.actorUserId, t.scopeId, t.sourceId, t.googleSubject, t.nonce, t.codeVerifier, t.createdAt, t.expiresAt]);
    });
  }
  async consumeContactsTransaction(input: {stateHash: string; browserBindingHash: string; sessionHash: string; actorUserId: string; now: number}): Promise<ContactsTransaction | null> {
    type Row = {state_hash: string; browser_binding_hash: string; session_hash: string; actor_user_id: string; scope_id: string; source_id: string; google_subject: string; nonce: string; code_verifier: string; created_at: string; expires_at: string};
    const row = (await this.pool.query<Row>('DELETE FROM contacts_transactions t USING app_sessions s, private_scopes p, app_users u WHERE t.state_hash=$1 AND t.browser_binding_hash=$2 AND t.session_hash=$3 AND t.actor_user_id=$4 AND t.expires_at>$5 AND s.token_hash=t.session_hash AND s.user_id=t.actor_user_id AND s.revoked_at IS NULL AND s.expires_at>$5 AND p.id=t.scope_id AND p.owner_user_id=t.actor_user_id AND u.id=t.actor_user_id AND u.google_subject=t.google_subject RETURNING t.*', [input.stateHash, input.browserBindingHash, input.sessionHash, input.actorUserId, input.now])).rows[0];
    return row ? {purpose: 'GOOGLE_CONTACTS', stateHash: row.state_hash, browserBindingHash: row.browser_binding_hash, sessionHash: row.session_hash, actorUserId: row.actor_user_id, scopeId: row.scope_id, sourceId: row.source_id, googleSubject: row.google_subject, nonce: row.nonce, codeVerifier: row.code_verifier, createdAt: Number(row.created_at), expiresAt: Number(row.expires_at)} : null;
  }
  async commitContactsGrant(grant: ContactsGrant): Promise<void> {
    this.checkGrant(grant); if (grant.revokedAt !== null) throw invalid();
    await this.tx(async c => {
      const row = await this.scope(c, grant.ownerUserId, grant.scopeId, grant.googleSubject);
      const sameAccount = (await c.query<{source_id: string}>('SELECT source_id FROM contacts_grants WHERE owner_user_id=$1 AND scope_id=$2 AND google_subject=$3', [grant.ownerUserId, grant.scopeId, grant.googleSubject])).rows[0];
      if (sameAccount && sameAccount.source_id !== grant.sourceId) throw conflict();
      let source = (await c.query<SourceRow>('SELECT * FROM private_sources WHERE id=$1', [grant.sourceId])).rows[0];
      if (source && (source.scope_id !== row.id || source.owner_user_id !== row.owner_user_id)) throw denied();
      if (source && (source.summary.provider !== 'GOOGLE_CONTACTS' || source.policy_version !== CONTACTS_SOURCE_POLICY || (source.owner_identity !== null && (source.owner_identity.platform !== 'google' || source.owner_identity.externalId !== grant.googleSubject)))) throw conflict();
      let graphChanged = false;
      if (!source) {
        const summary: SourceSummary = {id: grant.sourceId, provider: 'GOOGLE_CONTACTS', label: 'Google Contacts', origin: 'AUTHORIZED_API', importedAt: new Date(grant.createdAt).toISOString()};
        source = {id: grant.sourceId, scope_id: row.id, owner_user_id: row.owner_user_id, enabled: true, policy_version: CONTACTS_SOURCE_POLICY, summary, owner_identity: {platform: 'google', externalId: grant.googleSubject}};
        await c.query('INSERT INTO private_sources(id,scope_id,owner_user_id,policy_version,summary,owner_identity) VALUES($1,$2,$3,$4,$5,$6)', [source.id, row.id, row.owner_user_id, source.policy_version, source.summary, source.owner_identity]);
        row.snapshot.sources.push(summary); graphChanged = true;
      } else if (!source.enabled) {
        await c.query('UPDATE private_sources SET enabled=true WHERE id=$1 AND scope_id=$2 AND owner_user_id=$3', [grant.sourceId, row.id, row.owner_user_id]);
        graphChanged = true;
      }
      const ownerIdentity = row.snapshot.identities.find(i => i.sourceId === grant.sourceId && i.platform === 'google' && i.externalId === grant.googleSubject);
      if (ownerIdentity && ownerIdentity.personId !== row.root_person_id) throw conflict();
      if (!ownerIdentity) {
        const evidenceId = randomUUID(), identityId = stableId(grant.sourceId, 'google', grant.googleSubject), observedAt = new Date(grant.createdAt).toISOString();
        row.snapshot.evidence.push({id: evidenceId, sourceId: grant.sourceId, summary: 'Google account ownership verified during Contacts authorization.', observedAt, confidence: 1, claimKind: 'IDENTITY'});
        row.snapshot.identities.push({id: identityId, sourceId: grant.sourceId, platform: 'google', externalId: grant.googleSubject, personId: row.root_person_id, assignmentState: 'CONFIRMED', evidenceIds: [evidenceId], updatedAt: observedAt});
        row.snapshot.people.find(p => p.id === row.root_person_id)!.identityIds.push(identityId);
        graphChanged = true;
      }
      if (graphChanged) {
        row.snapshot.graphVersion = (BigInt(row.graph_version) + 1n).toString();
        const sources = (await c.query<{id: string}>('SELECT id FROM private_sources WHERE scope_id=$1 AND owner_user_id=$2 AND enabled=true', [row.id, row.owner_user_id])).rows;
        validateGraphSnapshot(row.snapshot, {scopeId: row.id, rootPersonId: row.root_person_id, sourceIds: new Set(sources.map(s => s.id))});
        await c.query('UPDATE private_scopes SET graph_version=$1,snapshot=$2 WHERE id=$3 AND owner_user_id=$4', [row.snapshot.graphVersion, row.snapshot, row.id, row.owner_user_id]);
      }
      // Consent is a new authorization, so it deliberately replaces an older consent/revoked grant.
      // Refreshes must use replaceContactsGrant's version compare-and-swap instead.
      await c.query('INSERT INTO contacts_grants(source_id,owner_user_id,scope_id,google_subject,version,revoked_at,grant_data) VALUES($1,$2,$3,$4,$5,NULL,$6) ON CONFLICT (source_id) DO UPDATE SET version=EXCLUDED.version,revoked_at=NULL,grant_data=EXCLUDED.grant_data WHERE contacts_grants.owner_user_id=EXCLUDED.owner_user_id AND contacts_grants.scope_id=EXCLUDED.scope_id AND contacts_grants.google_subject=EXCLUDED.google_subject', [grant.sourceId, grant.ownerUserId, grant.scopeId, grant.googleSubject, grant.version, grant]);
    });
  }
  async getContactsGrant(ownerUserId: string, sourceId: string): Promise<ContactsGrant | null> {
    const row = (await this.pool.query<{grant_data: ContactsGrant}>('SELECT g.grant_data FROM contacts_grants g JOIN private_sources s ON s.id=g.source_id AND s.owner_user_id=g.owner_user_id AND s.scope_id=g.scope_id JOIN private_scopes p ON p.id=g.scope_id AND p.owner_user_id=g.owner_user_id WHERE g.owner_user_id=$1 AND g.source_id=$2 AND s.enabled=true AND s.policy_version=$3 AND g.revoked_at IS NULL', [ownerUserId, sourceId, CONTACTS_SOURCE_POLICY])).rows[0];
    return row?.grant_data ?? null;
  }
  async replaceContactsGrant(grant: ContactsGrant, expectedVersion: string): Promise<boolean> {
    this.checkGrant(grant); if (grant.revokedAt !== null || grant.version === expectedVersion) throw invalid();
    return this.tx(async c => {
      await this.scope(c, grant.ownerUserId, grant.scopeId, grant.googleSubject);
      const result = await c.query('UPDATE contacts_grants g SET version=$1,grant_data=$2 FROM private_sources s WHERE g.source_id=$3 AND g.owner_user_id=$4 AND g.scope_id=$5 AND g.google_subject=$6 AND g.version=$7 AND g.revoked_at IS NULL AND s.id=g.source_id AND s.owner_user_id=g.owner_user_id AND s.scope_id=g.scope_id AND s.enabled=true AND s.policy_version=$8', [grant.version, grant, grant.sourceId, grant.ownerUserId, grant.scopeId, grant.googleSubject, expectedVersion, CONTACTS_SOURCE_POLICY]);
      return result.rowCount === 1;
    });
  }
  async revokeContactsGrant(ownerUserId: string, sourceId: string, expectedVersion: string, now: number): Promise<boolean> {
    if (!validTime(now)) throw invalid();
    return this.tx(async c => {
      const grant = (await c.query<{scope_id: string; google_subject: string}>('SELECT scope_id,google_subject FROM contacts_grants WHERE source_id=$1 AND owner_user_id=$2', [sourceId, ownerUserId])).rows[0];
      if (!grant) return false;
      await this.scope(c, ownerUserId, grant.scope_id, grant.google_subject);
      const version = randomUUID();
      const result = await c.query("UPDATE contacts_grants g SET revoked_at=$1,version=$2,grant_data=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(g.grant_data,'{revokedAt}',to_jsonb($1::bigint)),'{version}',to_jsonb($2::text)),'{accessTokenCiphertext}','\"\"'::jsonb),'{refreshTokenCiphertext}','null'::jsonb),'{updatedAt}',to_jsonb($1::bigint)) FROM private_sources s WHERE g.source_id=$3 AND g.owner_user_id=$4 AND g.version=$5 AND g.revoked_at IS NULL AND s.id=g.source_id AND s.scope_id=g.scope_id AND s.owner_user_id=g.owner_user_id AND s.enabled=true", [now, version, sourceId, ownerUserId, expectedVersion]);
      // Keep source/evidence available for the owner's retained graph; revoke credentials only.
      return result.rowCount === 1;
    });
  }
  async pruneExpiredContactsTransactions(now: number): Promise<void> {
    await this.pool.query('DELETE FROM contacts_transactions WHERE expires_at<=$1', [now]);
  }
}
