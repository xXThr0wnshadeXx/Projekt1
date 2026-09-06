import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {Evidence, GraphSnapshot} from '../../../contracts/index.js';
import type {PublicClaimProposal, PublicCitation, PublicDocument, ClaimEndpoint} from '../discovery/contracts.js';
import {canonicalJson} from '../../../contracts/canonical.js';
import {conflict, denied, invalid, type FactScopeRow, type FactSourceRow} from '../facts/transaction.js';
import type {PublicRelationshipBindings} from './acceptance-contracts.js';
import {validateDocumentAttribution, validateAuthoredProposal} from '../discovery/attribution.js';

export const PUBLIC_SOURCE_POLICY = 'public-citation-review-v1';
export const PUBLIC_RELATIONSHIP_PREFIX = 'public_relationship_';
export const PUBLIC_EDGE_PREFIX = 'public_edge_';
export interface PublicProposalRecord {proposal: PublicClaimProposal; citations: PublicCitation[]; documents: PublicDocument[]; endpoints: Array<{id: string; revision: string}>}
type EndpointRecord = {endpoint: ClaimEndpoint; documents: Array<{id: string; revision: string}>; evidence: Evidence[]};
export function publicSource(sources: FactSourceRow[], sourceId: string): void {
  if (!sources.some(s => s.id === sourceId && s.policy_version === PUBLIC_SOURCE_POLICY && s.summary.origin === 'PUBLIC_SOURCE' && ['PUBLIC_PROFILE', 'PUBLIC_ARTICLE'].includes(s.summary.provider))) throw denied();
}
export async function publicResource<T>(c: PoolClient, row: FactScopeRow, sourceId: string, kind: string, id: string, revision: string): Promise<T> {
  const r = (await c.query<{payload: T}>('SELECT payload FROM public_fact_resources WHERE source_id=$1 AND scope_id=$2 AND owner_user_id=$3 AND kind=$4 AND id=$5 AND revision=$6', [sourceId, row.id, row.owner_user_id, kind, id, revision])).rows[0];
  if (!r) throw denied(); return r.payload;
}
export async function assertPublicHead(c: PoolClient, row: FactScopeRow, sourceId: string, kind: string, id: string, revision: string): Promise<void> {
  const r = (await c.query<{revision: string}>('SELECT revision FROM public_fact_heads WHERE source_id=$1 AND scope_id=$2 AND owner_user_id=$3 AND kind=$4 AND id=$5', [sourceId, row.id, row.owner_user_id, kind, id])).rows[0];
  if (r?.revision !== revision) throw conflict();
}
export async function provePublicRelationship(c: PoolClient, row: FactScopeRow, graph: GraphSnapshot, sources: FactSourceRow[],
  selector: {sourceId: string; proposalId: string; proposalRevision: string}, bindings: PublicRelationshipBindings) {
  publicSource(sources, selector.sourceId);
  const record = await publicResource<PublicProposalRecord>(c, row, selector.sourceId, 'PROPOSAL', selector.proposalId, selector.proposalRevision);
  await assertPublicHead(c, row, selector.sourceId, 'PROPOSAL', selector.proposalId, selector.proposalRevision);
  const p = record.proposal;
  if (p.kind !== 'RELATIONSHIP' || !p.object || !['DIRECT_EXPLICIT', 'CORROBORATED_DIRECT'].includes(p.support) || !p.relationshipKind || p.relationshipKind === 'UNKNOWN') throw invalid();
  const evidence: Evidence[] = [];
  const retainedTexts = new Map<string, string>();
  for (const citation of record.citations) {
    if (citation.role !== 'RELATIONSHIP' || !p.citationIds.includes(citation.id)) throw invalid();
    const stored = await publicResource<PublicCitation>(c, row, selector.sourceId, 'CITATION', citation.id, 'immutable');
    if (canonicalJson(stored) !== canonicalJson(citation)) throw conflict();
    const document = record.documents.find(d => d.id === citation.documentId && d.revision === citation.documentRevision);
    if (!document) throw invalid();
    await assertPublicHead(c, row, selector.sourceId, 'DOCUMENT', document.id, document.revision);
    const retained = await publicResource<{document: PublicDocument; normalizedText: string}>(c, row, selector.sourceId, 'DOCUMENT', document.id, document.revision);
    if (canonicalJson(retained.document) !== canonicalJson(document) || createHash('sha256').update(retained.normalizedText, 'utf8').digest('hex') !== document.contentDigest
      || retained.normalizedText.slice(citation.locator.start, citation.locator.end) !== citation.supportingExcerpt) throw conflict();
    try {validateDocumentAttribution(document, retained.normalizedText);} catch {throw conflict();}
    retainedTexts.set(document.id, retained.normalizedText);
    const item = await publicResource<Evidence>(c, row, selector.sourceId, 'EVIDENCE', citation.evidenceId, 'immutable');
    if (item.sourceId !== selector.sourceId || item.claimKind !== 'RELATIONSHIP') throw denied();
    evidence.push(item);
  }
  if (record.citations.length !== p.citationIds.length || !evidence.length) throw invalid();
  if (p.predicate === 'AUTHORED_FIRST_PERSON_FRIEND_OF') {
    if (record.citations.length !== 1) throw invalid();
    const identityEvidenceIds = [...new Set([...p.subject.identityEvidenceIds, ...p.object.identityEvidenceIds])];
    const identityRows = (await c.query<{id: string; payload: PublicCitation}>(
      "SELECT id,payload FROM public_fact_resources WHERE scope_id=$1 AND owner_user_id=$2 AND source_id=$3 AND kind='CITATION' AND revision='immutable' AND payload->>'evidenceId'=ANY($4::text[])",
      [row.id, row.owner_user_id, selector.sourceId, identityEvidenceIds])).rows;
    if (identityRows.length !== identityEvidenceIds.length || new Set(identityRows.map(r => r.payload.evidenceId)).size !== identityEvidenceIds.length
      || identityRows.some(r => r.id !== r.payload.id || r.payload.role !== 'IDENTITY')) throw conflict();
    const relation = record.citations[0]!;
    const document = record.documents.find(d => d.id === relation.documentId && d.revision === relation.documentRevision);
    const text = document && retainedTexts.get(document.id);
    if (!document || text === undefined) throw conflict();
    try {validateAuthoredProposal(document, text, p, [...record.citations, ...identityRows.map(r => r.payload)]);} catch {throw conflict();}
  }
  if (p.support === 'CORROBORATED_DIRECT' && new Set(record.documents.map(d => d.independenceGroup)).size < 2) throw invalid();
  const people: string[] = [];
  for (const [index, binding] of [bindings.subject, bindings.object].entries()) {
    const expected = record.endpoints[index];
    if (!expected || expected.id !== binding.endpointId || expected.revision !== binding.endpointRevision) throw conflict();
    await assertPublicHead(c, row, selector.sourceId, 'ENDPOINT', expected.id, expected.revision);
    const endpoint = await publicResource<EndpointRecord>(c, row, selector.sourceId, 'ENDPOINT', expected.id, expected.revision);
    const original = index === 0 ? p.subject : p.object;
    if (canonicalJson(endpoint.endpoint.sourceIdentity) !== canonicalJson(original.sourceIdentity)) throw conflict();
    for (const d of endpoint.documents) await assertPublicHead(c, row, selector.sourceId, 'DOCUMENT', d.id, d.revision);
    const decision = (await c.query<{id: string; endpoint_revision: string; source_policy: string; person_id: string; identity_id: string}>('SELECT id,endpoint_revision,source_policy,person_id,identity_id FROM public_identity_decisions WHERE scope_id=$1 AND owner_user_id=$2 AND source_id=$3 AND endpoint_id=$4 ORDER BY graph_version DESC LIMIT 1', [row.id, row.owner_user_id, selector.sourceId, expected.id])).rows[0];
    if (!decision || decision.id !== binding.resolutionDecisionId || decision.endpoint_revision !== expected.revision || decision.source_policy !== PUBLIC_SOURCE_POLICY) throw conflict();
    const identity = graph.identities.find(i => i.id === decision.identity_id);
    if (!identity || identity.sourceId !== selector.sourceId || identity.personId !== decision.person_id || identity.assignmentState !== 'CONFIRMED'
      || identity.platform !== original.sourceIdentity.platform || identity.externalId !== original.sourceIdentity.externalId
      || original.identityEvidenceIds.some(id => !identity.evidenceIds.includes(id))
      || !graph.people.some(person => person.id === identity.personId && person.identityIds.includes(identity.id))) throw conflict();
    if (endpoint.evidence.some(item => !graph.evidence.some(e => canonicalJson(e) === canonicalJson(item))) || endpoint.evidence.some(e => e.claimKind !== 'IDENTITY')) throw conflict();
    people.push(decision.person_id);
  }
  if (people[0] === people[1]) throw invalid();
  return {record, evidence, fromPersonId: people[0]!, toPersonId: people[1]!};
}
