import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import type {Affiliation, Evidence, GraphBuildEvent, GraphSnapshot, Relationship, SourceSummary} from '../../../contracts/index.js';
import {validateGraphBuildEvent} from '../../../contracts/validation.js';
import {canonicalJson} from '../../../contracts/canonical.js';
import type {ConfirmFactsRequest, ConfirmFactsResponse, FactActor, FactReviewRequest, FactReviewResponse, FactStore} from './contracts.js';
import {validateConfirmFacts, validateFactReview} from './contracts.js';
import {affiliationKey, factDigest, projectConfirmedRelationships} from './projection.js';
import {checkedFactSnapshot, conflict, denied, invalid, saveFactSnapshot, withFactScope, type FactScopeRow, type FactSourceRow} from './transaction.js';
import {publicClaimsInstalled, refreshPublicCitationProjection} from '../public-facts/projection.js';
import {PUBLIC_RELATIONSHIP_PREFIX} from '../public-facts/acceptance-proof.js';

export const MANUAL_ATTESTATION_POLICY = 'manual-attestation-v1';
export const FACT_WARNINGS = [
  'Owner-attested claims have not been independently verified or confirmed by the contact.',
  'Willingness to help and job openings remain unknown. Route scores are relative, not probabilities.',
  'Manual attestation confidence records the explicit assertion; recency factor 1 applies no decay model and does not verify recent interaction.',
];
type Receipt = {request_digest: string; response: ConfirmFactsResponse; source_policies: Record<string, string>};

/** Private JSON snapshot/receipt adapter. No person creation, identity merge, or provider operation. */
export class PgFactStore implements FactStore {
  constructor(private readonly pool: Pool) {}

  async review(actor: FactActor, input: FactReviewRequest): Promise<FactReviewResponse> {
    const request = validateFactReview(input);
    return withFactScope(this.pool, actor, request.scopeId, async (_client, row, sources) => {
      const graph = checkedFactSnapshot(row, sources);
      const relationships = graph.relationships;
      const affiliations = graph.people.flatMap(person => person.affiliations.map(claim => ({personId: person.id, affiliationKey: affiliationKey(person.id, claim), claim})));
      const referenced = new Set([...relationships.flatMap(r => r.evidenceIds), ...affiliations.flatMap(a => a.claim.support.evidenceIds)]);
      const evidence = graph.evidence.filter(e => referenced.has(e.id));
      return {scopeId: row.id, graphVersion: row.graph_version, relationships, affiliations, evidence,
        sources: graph.sources.filter(s => evidence.some(e => e.sourceId === s.id)), warnings: [...FACT_WARNINGS]};
    });
  }

  private evidence(graph: GraphSnapshot, ids: string[], kind: Evidence['claimKind']): void {
    if (!ids.length || new Set(ids).size !== ids.length) throw invalid();
    if (ids.some(id => !graph.evidence.some(e => e.id === id && e.claimKind === kind && graph.sources.some(s => s.id === e.sourceId)))) throw denied();
  }

  private async manualEvidence(client: PoolClient, row: FactScopeRow, sources: FactSourceRow[], graph: GraphSnapshot,
    kind: Evidence['claimKind'], statement: string, now: string): Promise<string> {
    const sourceId = `manual_${factDigest([row.owner_user_id, row.id])}`;
    let source = sources.find(s => s.id === sourceId);
    if (!source) {
      // A disabled/colliding source is never silently re-enabled or reassigned.
      if ((await client.query('SELECT id FROM private_sources WHERE id=$1', [sourceId])).rowCount) throw denied();
      const summary: SourceSummary = {id: sourceId, provider: 'MANUAL', origin: 'USER_PROVIDED', label: 'Your explicit fact attestations', importedAt: now};
      await client.query('INSERT INTO private_sources(id,scope_id,owner_user_id,policy_version,summary) VALUES($1,$2,$3,$4,$5)', [sourceId, row.id, row.owner_user_id, MANUAL_ATTESTATION_POLICY, summary]);
      source = {id: sourceId, policy_version: MANUAL_ATTESTATION_POLICY, summary};
      sources.push(source); graph.sources.push(summary);
    }
    if (source.policy_version !== MANUAL_ATTESTATION_POLICY || source.summary.provider !== 'MANUAL' || source.summary.origin !== 'USER_PROVIDED') throw denied();
    const id = randomUUID();
    graph.evidence.push({id, sourceId, summary: `Owner self-attestation (not independently verified): ${statement}`, observedAt: now, confidence: 1, claimKind: kind});
    return id;
  }

  async confirm(actor: FactActor, input: ConfirmFactsRequest): Promise<ConfirmFactsResponse> {
    const request = validateConfirmFacts(input), requestDigest = factDigest(request);
    return withFactScope(this.pool, actor, request.scopeId, async (client, row, sources) => {
      const prior = (await client.query<Receipt>('SELECT request_digest,response,source_policies FROM fact_decisions WHERE scope_id=$1 AND owner_user_id=$2 AND idempotency_key=$3', [row.id, row.owner_user_id, request.idempotencyKey])).rows[0];
      if (prior) {
        if (Object.entries(prior.source_policies).some(([id, policy]) => !sources.some(s => s.id === id && s.policy_version === policy))) throw denied();
        if (prior.request_digest !== requestDigest) throw conflict();
        return {...prior.response, duplicate: true};
      }
      if (row.graph_version !== request.expectedGraphVersion) throw conflict();
      const before = checkedFactSnapshot(row, sources), graph = structuredClone(before), change = request.change;
      const now = (await client.query<{now: string}>('SELECT to_char(clock_timestamp() AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\') AS now')).rows[0]!.now;
      let beforeClaim: Relationship | Affiliation | null = null, afterClaim: Relationship | Affiliation;
      let subjectKey: string, relationshipId: string | null = null, includeInSearch = false, evidenceId: string | null = null;
      if (change.type === 'AFFILIATION') {
        const person = graph.people.find(p => p.id === change.personId); if (!person) throw denied();
        const matches = person.affiliations.filter(a => affiliationKey(person.id, a) === change.affiliationKey);
        if (matches.length !== 1) throw conflict();
        const claim = matches[0]!; beforeClaim = structuredClone(claim); subjectKey = `affiliation:${change.personId}:${change.affiliationKey}`;
        this.evidence(graph, claim.support.evidenceIds, 'AFFILIATION');
        if (change.decision === 'ACCEPT') {
          evidenceId = await this.manualEvidence(client, row, sources, graph, 'AFFILIATION', change.statement, now);
          claim.current = change.current;
          claim.support = {value: true, state: 'CONFIRMED', confidence: 1, evidenceIds: [...claim.support.evidenceIds, evidenceId]};
        } else claim.support.state = 'REJECTED';
        person.updatedAt = now; afterClaim = claim;
      } else {
        let claim: Relationship;
        if (change.type === 'RELATIONSHIP_FROM_OBSERVATION') {
          const observed = graph.observedLinks.find(l => l.id === change.observedLinkId);
          if (!observed || observed.kind !== 'CONTACT_SAVED' || observed.fromPersonId !== graph.rootPersonId || observed.toPersonId === graph.rootPersonId) throw denied();
          this.evidence(graph, observed.evidenceIds, 'RELATIONSHIP');
          relationshipId = `manual_rel_${factDigest([row.id, observed.id])}`;
          if (graph.relationships.some(r => r.id === relationshipId)) throw conflict();
          claim = {id: relationshipId, fromPersonId: observed.fromPersonId, toPersonId: observed.toPersonId, kind: change.confirmation.kind,
            strength: change.confirmation.strength, confidence: 1, recencyFactor: 1, state: 'PENDING', evidenceIds: [...observed.evidenceIds], observedLinkIds: [observed.id], updatedAt: now};
          graph.relationships.push(claim);
        } else {
          // Public citation claims retain their own review basis/policy; never convert them to manual1.
          const publicOwned = await publicClaimsInstalled(client) && (await client.query('SELECT id FROM public_claim_decisions WHERE scope_id=$1 AND owner_user_id=$2 AND relationship_id=$3 LIMIT 1', [row.id, row.owner_user_id, change.relationshipId])).rowCount;
          if (change.relationshipId.startsWith(PUBLIC_RELATIONSHIP_PREFIX) || publicOwned) throw denied();
          const existing = graph.relationships.find(r => r.id === change.relationshipId); if (!existing) throw denied();
          claim = existing; relationshipId = claim.id; beforeClaim = structuredClone(claim);
          this.evidence(graph, claim.evidenceIds, 'RELATIONSHIP');
        }
        subjectKey = `relationship:${relationshipId}`;
        if (change.decision === 'ACCEPT') {
          const confirmation = change.confirmation;
          evidenceId = await this.manualEvidence(client, row, sources, graph, 'RELATIONSHIP', confirmation.statement, now);
          Object.assign(claim, {kind: confirmation.kind, strength: confirmation.strength, confidence: 1, recencyFactor: 1, state: 'CONFIRMED', updatedAt: now});
          claim.evidenceIds.push(evidenceId); includeInSearch = confirmation.includeInSearch;
        } else { claim.state = 'REJECTED'; claim.updatedAt = now; }
        afterClaim = claim;
      }
      const selections = (await client.query<{relationship_id: string; include_in_search: boolean}>('SELECT DISTINCT ON (relationship_id) relationship_id,include_in_search FROM fact_decisions WHERE scope_id=$1 AND owner_user_id=$2 AND relationship_id IS NOT NULL ORDER BY relationship_id,graph_version DESC', [row.id, row.owner_user_id])).rows;
      const included = new Set(selections.filter(s => s.include_in_search).map(s => s.relationship_id));
      if (relationshipId) { included.delete(relationshipId); if (includeInSearch) included.add(relationshipId); }
      graph.searchEdges = projectConfirmedRelationships(graph, included);
      // Rebuild public-owned edges only from their actual ledger and current citation/mapping proof.
      await refreshPublicCitationProjection(client, row, graph, sources);
      await saveFactSnapshot(client, row, sources, graph);
      const decisionId = randomUUID();
      const changed = <K extends 'people' | 'relationships' | 'searchEdges' | 'evidence' | 'sources'>(key: K): GraphSnapshot[K] => graph[key].filter(value => !before[key].some(p => p.id === value.id && canonicalJson(p) === canonicalJson(value))) as GraphSnapshot[K];
      const event: GraphBuildEvent = {schemaVersion: 1, scopeId: row.id, jobId: decisionId, seq: 0, type: 'BATCH_COMMITTED', operationKind: 'REVIEW',
        baseGraphVersion: row.graph_version, graphVersion: graph.graphVersion, people: changed('people'), relationships: changed('relationships'), searchEdges: changed('searchEdges'), evidence: changed('evidence'), sources: changed('sources'),
        identities: [], observedLinks: [], organizations: [], removedPersonIds: [], removedEdgeIds: before.searchEdges.filter(e => !graph.searchEdges.some(current => current.id === e.id)).map(e => e.id)};
      validateGraphBuildEvent(event, {jobId: decisionId, scopeId: row.id, afterSeq: -1, before, after: graph, candidateIds: new Set(), proposalIds: new Set()});
      const response: ConfirmFactsResponse = {schemaVersion: 1, scopeId: row.id, baseGraphVersion: row.graph_version, graphVersion: graph.graphVersion, decisionId, duplicate: false, events: [event]};
      await client.query('INSERT INTO fact_decisions(id,scope_id,owner_user_id,idempotency_key,request_digest,request,subject_key,relationship_id,include_in_search,before_claim,after_claim,source_policies,attestation_evidence_id,base_graph_version,graph_version,response,policy_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)',
        [decisionId, row.id, row.owner_user_id, request.idempotencyKey, requestDigest, request, subjectKey, relationshipId, includeInSearch, beforeClaim, afterClaim, Object.fromEntries(sources.map(s => [s.id, s.policy_version])), evidenceId, row.graph_version, graph.graphVersion, response, MANUAL_ATTESTATION_POLICY]);
      return response;
    });
  }
}
