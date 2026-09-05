import type { Pool, PoolClient } from 'pg';
import type { GraphSnapshot, SourceSummary } from '../../../contracts/index.js';
import { validateGraphSnapshot } from '../../../contracts/validation.js';
import { ServiceError } from '../service.js';
import type { FactActor } from './contracts.js';

export type FactScopeRow = {id: string; owner_user_id: string; root_person_id: string; graph_version: string; snapshot: GraphSnapshot};
export type FactSourceRow = {id: string; policy_version: string; summary: SourceSummary};
export const denied = () => new ServiceError('FORBIDDEN', 403);
export const conflict = () => new ServiceError('VERSION_CONFLICT', 409);
export const invalid = () => new ServiceError('INVALID_INPUT', 400);

/** Session then scope matches Contacts consent; the scope lock also serializes PgStore imports. */
export async function withFactScope<T>(pool: Pool, actor: FactActor, scopeId: string,
  work: (client: PoolClient, scope: FactScopeRow, sources: FactSourceRow[]) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const session = await client.query('SELECT token_hash FROM app_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL FOR UPDATE', [actor.sessionHash, actor.userId]);
    if (!session.rowCount) throw new ServiceError('UNAUTHENTICATED', 401);
    const row = (await client.query<FactScopeRow>('SELECT * FROM private_scopes WHERE id=$1 AND owner_user_id=$2 FOR UPDATE', [scopeId, actor.userId])).rows[0];
    if (!row) throw denied();
    const sources = (await client.query<FactSourceRow>('SELECT id,policy_version,summary FROM private_sources WHERE scope_id=$1 AND owner_user_id=$2 AND enabled=true ORDER BY id', [row.id, row.owner_user_id])).rows;
    const result = await work(client, row, sources);
    // Use the database wall clock after every lock wait/write; rollback if expiry occurred meanwhile.
    const live = await client.query('SELECT token_hash FROM app_sessions WHERE token_hash=$1 AND user_id=$2 AND revoked_at IS NULL AND created_at<=floor(extract(epoch FROM clock_timestamp())*1000)::bigint AND expires_at>floor(extract(epoch FROM clock_timestamp())*1000)::bigint', [actor.sessionHash, actor.userId]);
    if (!live.rowCount) throw new ServiceError('UNAUTHENTICATED', 401);
    await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { client.release(); }
}

export function checkedFactSnapshot(row: FactScopeRow, sources: FactSourceRow[]): GraphSnapshot {
  const sourceIds = new Set(sources.map(s => s.id));
  if (row.snapshot.sources.some(s => !sourceIds.has(s.id))) throw denied();
  if (row.snapshot.graphVersion !== row.graph_version) throw new ServiceError('INTERNAL', 500);
  try { return structuredClone(validateGraphSnapshot(row.snapshot, {scopeId: row.id, rootPersonId: row.root_person_id, sourceIds})); }
  catch { throw new ServiceError('INTERNAL', 500); }
}

export async function saveFactSnapshot(client: PoolClient, row: FactScopeRow, sources: FactSourceRow[], graph: GraphSnapshot): Promise<void> {
  graph.graphVersion = (BigInt(row.graph_version) + 1n).toString();
  validateGraphSnapshot(graph, {scopeId: row.id, rootPersonId: row.root_person_id, sourceIds: new Set(sources.map(s => s.id))});
  const result = await client.query('UPDATE private_scopes SET graph_version=$1,snapshot=$2 WHERE id=$3 AND owner_user_id=$4 AND graph_version=$5', [graph.graphVersion, graph, row.id, row.owner_user_id, row.graph_version]);
  if (result.rowCount !== 1) throw conflict();
}
