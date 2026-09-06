import {createHash, randomUUID} from 'node:crypto';
import type {Pool} from 'pg';
import type {GraphBuildEvent, GraphSnapshot, Relationship} from '../../../contracts/index.js';
import {canonicalJson} from '../../../contracts/canonical.js';
import * as s from '../../../contracts/schema.js';
import {validateGraphBuildEvent} from '../../../contracts/validation.js';
import {ServiceError, type AuthPort} from '../service.js';
import type {FactActor} from '../facts/contracts.js';
import {factDigest} from '../facts/projection.js';
import {withFactScope, checkedFactSnapshot, saveFactSnapshot, conflict, invalid} from '../facts/transaction.js';
import type {PublicCitationPolicy, PublicCitationAssessment, PublicClaimReviewRequest, PublicClaimReviewResponse} from './acceptance-contracts.js';
import {validatePublicClaimReview} from './acceptance-contracts.js';
import {provePublicRelationship, publicResource, publicSource, PUBLIC_RELATIONSHIP_PREFIX, type PublicProposalRecord} from './acceptance-proof.js';
import {latestPublicDecisions, refreshPublicCitationProjection} from './projection.js';

export const PUBLIC_REVIEW_WARNINGS = ['Public citations report source assertions; they do not verify willingness to help or current opportunities.', 'Route scores are relative policy assessments, not probabilities. Identity assignments are explicitly reviewed, not authenticated profile ownership.'];
export class PgPublicClaimStore {
  constructor(private readonly pool: Pool, private readonly options: {policy?: PublicCitationPolicy} = {}) {}
  async review(actor: FactActor, input: PublicClaimReviewRequest): Promise<PublicClaimReviewResponse> {
    const request = validatePublicClaimReview(input), digest = factDigest(request);
    return withFactScope(this.pool, actor, request.scopeId, async (c, row, sources) => {
      const graph = checkedFactSnapshot(row, sources), before = structuredClone(graph);
      const prior = (await c.query<{id: string; request_digest: string; response: PublicClaimReviewResponse}>('SELECT id,request_digest,response FROM public_claim_reviews WHERE scope_id=$1 AND owner_user_id=$2 AND idempotency_key=$3', [row.id, row.owner_user_id, request.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== digest) throw conflict();
        const latest = await latestPublicDecisions(c, row);
        for (const selected of request.decisions) {
          publicSource(sources, selected.sourceId);
          const decision = latest.find(d => d.source_id === selected.sourceId && d.proposal_id === selected.proposalId);
          if (!decision || !prior.response.decisions.some(d => d.decisionId === decision.id)) throw conflict();
          if (selected.decision === 'ACCEPT') await provePublicRelationship(c, row, graph, sources, selected, selected.bindings);
        }
        return {...prior.response, duplicate: true};
      }
      if (row.graph_version !== request.expectedGraphVersion) throw conflict();
      const reviewId = randomUUID(), outcomes: PublicClaimReviewResponse['decisions'] = [], policyWarnings: string[] = [];
      const nextVersion = (BigInt(row.graph_version) + 1n).toString();
      for (const selected of request.decisions) {
        publicSource(sources, selected.sourceId);
        const relationshipId = `${PUBLIC_RELATIONSHIP_PREFIX}${factDigest([row.id, selected.sourceId, selected.proposalId])}`;
        let relationship: Relationship | null = null, assessment: PublicCitationAssessment | null = null, policy: PublicCitationPolicy | undefined;
        let includeInSearch = false;
        const existing = graph.relationships.find(r => r.id === relationshipId);
        if (selected.decision === 'ACCEPT') {
          const proof = await provePublicRelationship(c, row, graph, sources, selected, selected.bindings);
          includeInSearch = selected.includeInSearch;
          if (includeInSearch) {
            policy = this.options.policy;
            if (!policy) throw new ServiceError('SOURCE_UNAVAILABLE', 502);
            s.id(policy.version, '$.policy.version'); s.object({strength: s.string, confidence: s.string, recency: s.string})(policy.semantics, '$.policy.semantics');
            assessment = policy.assess({proposal: structuredClone(proof.record.proposal), citations: structuredClone(proof.record.citations), documents: structuredClone(proof.record.documents), relativeStrength: selected.relativeStrength ?? null});
            if (!assessment) throw new ServiceError('SOURCE_UNAVAILABLE', 502);
            s.object({strength: s.nullable(s.score), confidence: s.nullable(s.score), recencyFactor: s.nullable(s.score), warnings: s.array(s.string, 0, 20)})(assessment, '$.policy.assessment');
            if ([assessment.strength, assessment.confidence, assessment.recencyFactor].some(n => n === null || n <= 0)) throw new ServiceError('SOURCE_UNAVAILABLE', 502);
            relationship = {id: relationshipId, fromPersonId: proof.fromPersonId, toPersonId: proof.toPersonId, kind: proof.record.proposal.relationshipKind!,
              strength: assessment.strength!, confidence: assessment.confidence!, recencyFactor: assessment.recencyFactor!, state: 'CONFIRMED',
              evidenceIds: proof.evidence.map(e => e.id), observedLinkIds: [], updatedAt: new Date().toISOString()};
            for (const evidence of proof.evidence) {
              const original = graph.evidence.find(e => e.id === evidence.id);
              if (original && canonicalJson(original) !== canonicalJson(evidence)) throw conflict();
              if (!original) graph.evidence.push(evidence);
            }
            if (existing) Object.assign(existing, relationship); else graph.relationships.push(relationship);
            policyWarnings.push(...assessment.warnings);
          } else if (existing) {
            // Opt-out retains the last reviewed historical canonical claim/factors but removes traversal.
            existing.state = 'CONFIRMED'; relationship = structuredClone(existing);
          }
        } else {
          const record = await publicResource<PublicProposalRecord>(c, row, selected.sourceId, 'PROPOSAL', selected.proposalId, selected.proposalRevision);
          if (record.proposal.kind !== 'RELATIONSHIP') throw invalid();
          if (existing) {existing.state = 'REJECTED'; existing.updatedAt = new Date().toISOString(); relationship = structuredClone(existing);}
        }
        const decisionId = randomUUID();
        await c.query('INSERT INTO public_claim_decisions(id,review_id,scope_id,owner_user_id,source_id,proposal_id,proposal_revision,graph_version,decision,basis,include_in_search,bindings,relationship_id,relationship,policy_version,policy_semantics,assessment) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,\'PUBLIC_CITATION_REVIEW\',$10,$11,$12,$13,$14,$15,$16)',
          [decisionId, reviewId, row.id, row.owner_user_id, selected.sourceId, selected.proposalId, selected.proposalRevision, nextVersion, selected.decision, includeInSearch,
            selected.decision === 'ACCEPT' ? selected.bindings : null, relationship?.id ?? null, relationship, policy?.version ?? null, policy?.semantics ?? null, assessment]);
        outcomes.push({decisionId, sourceId: selected.sourceId, proposalId: selected.proposalId, proposalRevision: selected.proposalRevision,
          state: selected.decision === 'ACCEPT' ? 'CONFIRMED' : 'REJECTED', relationshipId: relationship?.id ?? null, searchable: includeInSearch});
      }
      await refreshPublicCitationProjection(c, row, graph, sources);
      if (outcomes.some(d => d.searchable && !graph.searchEdges.some(e => e.relationshipId === d.relationshipId))) throw conflict();
      await saveFactSnapshot(c, row, sources, graph);
      const changed = <K extends 'relationships' | 'evidence' | 'searchEdges'>(key: K): GraphSnapshot[K] => graph[key].filter(item => !before[key].some(old => old.id === item.id && canonicalJson(old) === canonicalJson(item))) as GraphSnapshot[K];
      const event: GraphBuildEvent = {schemaVersion: 1, scopeId: row.id, jobId: reviewId, seq: 0, type: 'BATCH_COMMITTED', operationKind: 'REVIEW', baseGraphVersion: row.graph_version, graphVersion: graph.graphVersion,
        people: [], identities: [], sources: [], organizations: [], observedLinks: [], relationships: changed('relationships'), evidence: changed('evidence'), searchEdges: changed('searchEdges'),
        removedPersonIds: [], removedEdgeIds: before.searchEdges.filter(e => !graph.searchEdges.some(after => after.id === e.id)).map(e => e.id)};
      validateGraphBuildEvent(event, {scopeId: row.id, jobId: reviewId, afterSeq: -1, before, after: graph, candidateIds: new Set(), proposalIds: new Set()});
      const response: PublicClaimReviewResponse = {scopeId: row.id, baseGraphVersion: row.graph_version, graphVersion: graph.graphVersion, reviewId, duplicate: false,
        decisions: outcomes, events: [event], warnings: [...new Set([...PUBLIC_REVIEW_WARNINGS, ...policyWarnings])]};
      await c.query('INSERT INTO public_claim_reviews(id,scope_id,owner_user_id,idempotency_key,request_digest,request,response,base_graph_version,graph_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)', [reviewId, row.id, row.owner_user_id, request.idempotencyKey, digest, request, response, row.graph_version, graph.graphVersion]);
      return response;
    });
  }
}
export class PublicClaimReviewService {
  constructor(private readonly ports: {auth: AuthPort; claims: PgPublicClaimStore}) {}
  async review(credential: unknown, input: unknown): Promise<PublicClaimReviewResponse> {
    const request = validatePublicClaimReview(input), actor = await this.ports.auth.resolveSession(credential);
    if (!actor || typeof credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(credential)) throw new ServiceError('UNAUTHENTICATED', 401);
    return this.ports.claims.review({userId: actor.userId, sessionHash: createHash('sha256').update(credential).digest('hex')}, request);
  }
}
