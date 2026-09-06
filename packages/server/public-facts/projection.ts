import type {PoolClient} from 'pg';
import type {GraphSnapshot, Relationship, SearchEdge} from '../../../contracts/index.js';
import {canonicalJson} from '../../../contracts/canonical.js';
import {ContractError} from '../../../contracts/schema.js';
import {ServiceError} from '../service.js';
import {factDigest} from '../facts/projection.js';
import type {FactScopeRow, FactSourceRow} from '../facts/transaction.js';
import type {PublicRelationshipBindings} from './acceptance-contracts.js';
import {provePublicRelationship, PUBLIC_EDGE_PREFIX, PUBLIC_RELATIONSHIP_PREFIX} from './acceptance-proof.js';

export interface PublicDecisionRow {
  id: string; source_id: string; proposal_id: string; proposal_revision: string;
  decision: 'ACCEPT' | 'REJECT'; include_in_search: boolean; bindings: PublicRelationshipBindings | null;
  relationship_id: string | null; relationship: Relationship | null; policy_version: string | null;
}
export async function publicClaimsInstalled(c: PoolClient): Promise<boolean> {
  return (await c.query<{ready: boolean}>("SELECT to_regclass('public_claim_decisions') IS NOT NULL AS ready")).rows[0]!.ready;
}
export async function latestPublicDecisions(c: PoolClient, row: FactScopeRow): Promise<PublicDecisionRow[]> {
  return (await c.query<PublicDecisionRow>('SELECT DISTINCT ON (source_id,proposal_id) * FROM public_claim_decisions WHERE scope_id=$1 AND owner_user_id=$2 ORDER BY source_id,proposal_id,graph_version DESC', [row.id, row.owner_user_id])).rows;
}
/** Call inside the source/identity scope mutation transaction. Preserve all non-public edges.
 * Stored assessed factors are retained; freshness/mapping checks never silently recalculate scores. */
export async function refreshPublicCitationProjection(c: PoolClient, row: FactScopeRow, graph: GraphSnapshot, sources: FactSourceRow[]): Promise<void> {
  if (!await publicClaimsInstalled(c)) return;
  const edges: SearchEdge[] = [];
  for (const decision of await latestPublicDecisions(c, row)) {
    if (decision.decision !== 'ACCEPT' || !decision.include_in_search || !decision.bindings || !decision.relationship || !decision.policy_version) continue;
    try {
      const proof = await provePublicRelationship(c, row, graph, sources, {sourceId: decision.source_id, proposalId: decision.proposal_id, proposalRevision: decision.proposal_revision}, decision.bindings);
      const relationship = graph.relationships.find(r => r.id === decision.relationship_id);
      if (!relationship || relationship.state !== 'CONFIRMED' || canonicalJson(relationship) !== canonicalJson(decision.relationship)
        || relationship.fromPersonId !== proof.fromPersonId || relationship.toPersonId !== proof.toPersonId
        || relationship.kind !== proof.record.proposal.relationshipKind
        || relationship.evidenceIds.length !== proof.evidence.length || proof.evidence.some(e => !relationship.evidenceIds.includes(e.id) || !graph.evidence.some(item => canonicalJson(item) === canonicalJson(e)))
        || [relationship.strength, relationship.confidence, relationship.recencyFactor].some(n => !Number.isFinite(n) || n <= 0 || n > 1)) continue;
      edges.push({id: `${PUBLIC_EDGE_PREFIX}${factDigest(relationship.id)}`, relationshipId: relationship.id,
        fromPersonId: relationship.fromPersonId, toPersonId: relationship.toPersonId, strength: relationship.strength,
        confidence: relationship.confidence, recencyFactor: relationship.recencyFactor, evidenceIds: [...relationship.evidenceIds].sort(),
        basis: 'CONFIRMED_RELATIONSHIP', policyVersion: decision.policy_version});
    } catch (error) {if (!(error instanceof ServiceError) && !(error instanceof ContractError)) throw error;}
  }
  graph.searchEdges = [...graph.searchEdges.filter(e => !e.id.startsWith(PUBLIC_EDGE_PREFIX) && !e.relationshipId?.startsWith(PUBLIC_RELATIONSHIP_PREFIX)),
    ...edges.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)];
}
