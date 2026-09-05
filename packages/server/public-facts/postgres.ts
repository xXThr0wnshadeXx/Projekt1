import {randomUUID} from 'node:crypto';
import type {Pool, PoolClient} from 'pg';
import type {ClaimEndpoint, PublicSourceEnvelope} from '../discovery/contracts.js';
import type {Evidence, GraphBuildEvent, GraphSnapshot, Identity, Person} from '../../../contracts/index.js';
import {validateNormalizedImport, validateGraphBuildEvent} from '../../../contracts/validation.js';
import {canonicalJson} from '../../../contracts/canonical.js';
import type {FactActor} from '../facts/contracts.js';
import {factDigest} from '../facts/projection.js';
import {checkedFactSnapshot, conflict, denied, saveFactSnapshot, withFactScope, type FactScopeRow, type FactSourceRow} from '../facts/transaction.js';
import type {EndpointView, PublicFactsStore, ReviewPublicFactsRequest, ReviewPublicFactsResponse, ResolvePublicIdentityRequest, ResolvePublicIdentityResponse, StagePublicFactsRequest, StagePublicFactsResponse} from './contracts.js';
import {validatePublicReview, validatePublicResolution} from './contracts.js';
import {endpointId, endpointRevision, validatePublicStage} from './validation.js';

export const PUBLIC_CITATION_POLICY = 'public-citation-review-v1';
type Ref = {id: string; revision: string};
type EndpointPayload = {endpoint: ClaimEndpoint; documents: Ref[]; evidence: Evidence[]};
type BatchRow = {id: string; source_id: string; source_policy: string; request_digest: string; envelope: PublicSourceEnvelope; endpoint_refs: Ref[]; response: StagePublicFactsResponse};
type DecisionRow = {id: string; source_id: string; source_policy: string; request_digest: string; endpoint_revision: string; person_id: string; identity_id: string; response: ResolvePublicIdentityResponse};
const warnings = [
  'Public proposals remain unreviewed and cannot create search edges in this checkpoint.',
  'Resolving a source mention records your explicit identity assignment, not authenticated account ownership.',
  'Publication, retrieval and relationship dates differ; unknown confidence, recency and willingness remain unknown.',
];

export class PgPublicFactsStore implements PublicFactsStore {
  constructor(private readonly pool: Pool) {}
  private source(sources: FactSourceRow[], id: string, policy: string): FactSourceRow {
    const source = sources.find(s => s.id === id && s.policy_version === policy);
    if (!source || source.summary.origin !== 'PUBLIC_SOURCE' || !['PUBLIC_PROFILE', 'PUBLIC_ARTICLE'].includes(source.summary.provider)) throw denied();
    return source;
  }
  private async putResource(client: PoolClient, row: FactScopeRow, sourceId: string, kind: string, ref: Ref, payload: unknown): Promise<void> {
    const digest = factDigest(payload);
    const prior = (await client.query<{digest: string}>('SELECT digest FROM public_fact_resources WHERE source_id=$1 AND kind=$2 AND id=$3 AND revision=$4 AND scope_id=$5 AND owner_user_id=$6', [sourceId, kind, ref.id, ref.revision, row.id, row.owner_user_id])).rows[0];
    const head = (await client.query<{revision: string}>('SELECT revision FROM public_fact_heads WHERE source_id=$1 AND kind=$2 AND id=$3 AND scope_id=$4 AND owner_user_id=$5', [sourceId, kind, ref.id, row.id, row.owner_user_id])).rows[0];
    if (prior && (prior.digest !== digest || (head && head.revision !== ref.revision))) throw conflict();
    if (!prior) await client.query('INSERT INTO public_fact_resources(source_id,scope_id,owner_user_id,kind,id,revision,digest,payload) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [sourceId, row.id, row.owner_user_id, kind, ref.id, ref.revision, digest, payload]);
    await client.query('INSERT INTO public_fact_heads(source_id,scope_id,owner_user_id,kind,id,revision) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (source_id,kind,id) DO UPDATE SET revision=EXCLUDED.revision WHERE public_fact_heads.scope_id=EXCLUDED.scope_id AND public_fact_heads.owner_user_id=EXCLUDED.owner_user_id', [sourceId, row.id, row.owner_user_id, kind, ref.id, ref.revision]);
  }
  private async current(client: PoolClient, row: FactScopeRow, sourceId: string, kind: string, refs: Ref[]): Promise<boolean> {
    for (const ref of refs) {
      const head = (await client.query<{revision: string}>('SELECT revision FROM public_fact_heads WHERE source_id=$1 AND kind=$2 AND id=$3 AND scope_id=$4 AND owner_user_id=$5', [sourceId, kind, ref.id, row.id, row.owner_user_id])).rows[0];
      if (!head || head.revision !== ref.revision) return false;
    }
    return true;
  }
  private async latest(client: PoolClient, row: FactScopeRow, id: string): Promise<DecisionRow | undefined> {
    return (await client.query<DecisionRow>('SELECT * FROM public_identity_decisions WHERE endpoint_id=$1 AND scope_id=$2 AND owner_user_id=$3 ORDER BY graph_version DESC LIMIT 1', [id, row.id, row.owner_user_id])).rows[0];
  }
  private validMapping(graph: GraphSnapshot, payload: EndpointPayload, sourceId: string, decision: DecisionRow): boolean {
    const identity = graph.identities.find(i => i.id === decision.identity_id);
    return !!identity && identity.assignmentState === 'CONFIRMED' && identity.personId === decision.person_id && identity.sourceId === sourceId
      && identity.platform === payload.endpoint.sourceIdentity.platform && identity.externalId === payload.endpoint.sourceIdentity.externalId
      && graph.people.some(p => p.id === decision.person_id && p.identityIds.includes(identity.id));
  }
  private async endpoint(client: PoolClient, row: FactScopeRow, id: string, revision: string): Promise<{sourceId: string; payload: EndpointPayload}> {
    const result = (await client.query<{source_id: string; payload: EndpointPayload}>('SELECT source_id,payload FROM public_fact_resources WHERE kind=\'ENDPOINT\' AND id=$1 AND revision=$2 AND scope_id=$3 AND owner_user_id=$4', [id, revision, row.id, row.owner_user_id])).rows[0];
    if (!result) throw denied(); return {sourceId: result.source_id, payload: result.payload};
  }

  async stage(actor: FactActor, input: StagePublicFactsRequest): Promise<StagePublicFactsResponse> {
    const request = validatePublicStage(input), e = request.envelope, n = e.normalized, context = n.context;
    if (actor.userId !== context.ownerUserId || context.sourcePolicyVersion !== PUBLIC_CITATION_POLICY) throw denied();
    return withFactScope(this.pool, actor, context.scopeId, async (client, row, sources) => {
      const source = this.source(sources, context.sourceId, context.sourcePolicyVersion);
      if (e.documents.some(d => (['PUBLIC_ARTICLE', 'WIKIMEDIA_PAGE'].includes(d.kind) ? 'PUBLIC_ARTICLE' : 'PUBLIC_PROFILE') !== source.summary.provider)) throw denied();
      const digest = factDigest(request);
      const prior = (await client.query<BatchRow>('SELECT * FROM public_fact_batches WHERE scope_id=$1 AND owner_user_id=$2 AND idempotency_key=$3', [row.id, row.owner_user_id, request.idempotencyKey])).rows[0];
      if (prior) {if (prior.request_digest !== digest) throw conflict(); return {...prior.response, duplicate: true};}
      if (row.graph_version !== request.expectedGraphVersion) throw conflict();
      if ((await client.query('SELECT id FROM public_fact_batches WHERE source_id=$1 AND batch_key=$2', [context.sourceId, context.batchId])).rowCount) throw conflict();
      const graph = checkedFactSnapshot(row, sources);
      for (const d of e.documents) await this.putResource(client, row, context.sourceId, 'DOCUMENT', d, {document: d, normalizedText: request.texts.find(t => t.documentId === d.id)!.normalizedText});
      for (const evidence of n.batch.evidence) {
        const existing = graph.evidence.find(item => item.id === evidence.id);
        if (existing && canonicalJson(existing) !== canonicalJson(evidence)) throw conflict();
        const foreign = await client.query('SELECT id FROM public_fact_resources WHERE scope_id=$1 AND owner_user_id=$2 AND kind=\'EVIDENCE\' AND id=$3 AND source_id<>$4', [row.id, row.owner_user_id, evidence.id, context.sourceId]);
        if (foreign.rowCount) throw denied();
        await this.putResource(client, row, context.sourceId, 'EVIDENCE', {id: evidence.id, revision: 'immutable'}, evidence);
      }
      for (const citation of e.citations) await this.putResource(client, row, context.sourceId, 'CITATION', {id: citation.id, revision: 'immutable'}, citation);
      // Sidecar staging may reuse identical evidence already materialized by identity review;
      // prove exact equality above before excluding those IDs from the import's new-evidence check.
      const repeated = new Set(n.batch.evidence.map(item => item.id));
      validateNormalizedImport(n, {...context, existingPersonIds: new Set(graph.people.map(p => p.id)), existingEvidenceIds: new Set(graph.evidence.filter(item => item.sourceId === context.sourceId && !repeated.has(item.id)).map(item => item.id)), existingIdentities: graph.identities.filter(i => i.sourceId === context.sourceId)});
      const endpointRefs = new Map<string, Ref>();
      for (const p of e.proposals) {
        for (const ep of [p.subject, ...(p.object ? [p.object] : [])]) {
          const id = endpointId(row.id, context.sourceId, ep), revision = endpointRevision(e, ep);
          const citations = e.citations.filter(c => ep.identityEvidenceIds.includes(c.evidenceId));
          const documents = e.documents.filter(d => citations.some(c => c.documentId === d.id)).map(d => ({id: d.id, revision: d.revision}));
          const evidence = n.batch.evidence.filter(item => ep.identityEvidenceIds.includes(item.id));
          await this.putResource(client, row, context.sourceId, 'ENDPOINT', {id, revision}, {endpoint: ep, documents, evidence} satisfies EndpointPayload);
          endpointRefs.set(id, {id, revision});
        }
        const citations = e.citations.filter(c => p.citationIds.includes(c.id));
        await this.putResource(client, row, context.sourceId, 'PROPOSAL', p, {proposal: p, citations,
          documents: e.documents.filter(d => citations.some(c => c.documentId === d.id)),
          endpoints: [p.subject, ...(p.object ? [p.object] : [])].map(ep => ({id: endpointId(row.id, context.sourceId, ep), revision: endpointRevision(e, ep)}))});
      }
      // Staging advances the scope version to serialize changing evidence/mapping revisions;
      // canonical nodes, identities, relationships, affiliations and search edges remain identical.
      await saveFactSnapshot(client, row, sources, graph);
      const id = randomUUID(), response: StagePublicFactsResponse = {batchId: id, scopeId: row.id, graphVersion: graph.graphVersion, duplicate: false, status: 'PENDING_REVIEW'};
      await client.query('INSERT INTO public_fact_batches(id,scope_id,owner_user_id,source_id,batch_key,idempotency_key,request_digest,source_policy,envelope,endpoint_refs,response) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)', [id, row.id, row.owner_user_id, context.sourceId, context.batchId, request.idempotencyKey, digest, context.sourcePolicyVersion, e, JSON.stringify([...endpointRefs.values()]), response]);
      return response;
    });
  }

  async review(actor: FactActor, input: ReviewPublicFactsRequest): Promise<ReviewPublicFactsResponse> {
    const request = validatePublicReview(input);
    return withFactScope(this.pool, actor, request.scopeId, async (client, row, sources) => {
      const batch = (await client.query<BatchRow>('SELECT * FROM public_fact_batches WHERE id=$1 AND scope_id=$2 AND owner_user_id=$3', [request.batchId, row.id, row.owner_user_id])).rows[0];
      if (!batch) throw denied(); this.source(sources, batch.source_id, batch.source_policy);
      const graph = checkedFactSnapshot(row, sources), endpoints: EndpointView[] = [];
      for (const ref of batch.endpoint_refs) {
        const {sourceId, payload} = await this.endpoint(client, row, ref.id, ref.revision), decision = await this.latest(client, row, ref.id);
        const current = await this.current(client, row, sourceId, 'ENDPOINT', [ref]) && await this.current(client, row, sourceId, 'DOCUMENT', payload.documents);
        const liveMapping = decision && decision.endpoint_revision === ref.revision && this.validMapping(graph, payload, sourceId, decision);
        endpoints.push({endpointId: ref.id, endpointRevision: ref.revision, endpoint: payload.endpoint, latestResolutionDecisionId: decision?.id ?? null,
          resolution: current && liveMapping ? {decisionId: decision.id, personId: decision.person_id} : null, current});
      }
      return {scopeId: row.id, graphVersion: row.graph_version, batchId: batch.id,
        documents: batch.envelope.documents.map(({privatePayloadRef: _private, ...document}) => document), citations: batch.envelope.citations,
        proposals: batch.envelope.proposals, endpoints, warnings: [...warnings, ...(endpoints.some(ep => !ep.current) ? ['Evidence or endpoint revisions changed. Start from the latest review.'] : [])]};
    });
  }

  async resolve(actor: FactActor, input: ResolvePublicIdentityRequest): Promise<ResolvePublicIdentityResponse> {
    const request = validatePublicResolution(input), digest = factDigest(request);
    return withFactScope(this.pool, actor, request.scopeId, async (client, row, sources) => {
      const {sourceId, payload} = await this.endpoint(client, row, request.endpointId, request.expectedEndpointRevision);
      this.source(sources, sourceId, PUBLIC_CITATION_POLICY);
      if (!await this.current(client, row, sourceId, 'ENDPOINT', [{id: request.endpointId, revision: request.expectedEndpointRevision}]) || !await this.current(client, row, sourceId, 'DOCUMENT', payload.documents)) throw conflict();
      const graph = checkedFactSnapshot(row, sources), before = structuredClone(graph), latest = await this.latest(client, row, request.endpointId);
      if (latest && (!this.validMapping(graph, payload, sourceId, latest) || latest.source_policy !== PUBLIC_CITATION_POLICY)) throw conflict();
      const prior = (await client.query<DecisionRow>('SELECT * FROM public_identity_decisions WHERE scope_id=$1 AND owner_user_id=$2 AND idempotency_key=$3', [row.id, row.owner_user_id, request.idempotencyKey])).rows[0];
      if (prior) {
        if (prior.request_digest !== digest || latest?.id !== prior.id) throw conflict();
        return {...prior.response, duplicate: true};
      }
      if (row.graph_version !== request.expectedGraphVersion || (latest?.id ?? null) !== request.expectedResolutionDecisionId) throw conflict();
      if (latest?.endpoint_revision === request.expectedEndpointRevision) throw conflict();
      const ep = payload.endpoint;
      const existing = graph.identities.find(i => i.sourceId === sourceId && i.platform === ep.sourceIdentity.platform && i.externalId === ep.sourceIdentity.externalId);
      if (existing && (request.disposition !== 'LINK_EXISTING' || existing.personId !== request.personId || existing.assignmentState !== 'CONFIRMED')) throw conflict();
      if (request.disposition === 'LINK_EXISTING' && !graph.people.some(p => p.id === request.personId)) throw denied();
      const personId = request.disposition === 'NEW_PERSON' ? randomUUID() : request.personId;
      const now = new Date().toISOString();
      let person = graph.people.find(p => p.id === personId);
      if (!person) {
        person = {id: personId, displayName: ep.mention, aliases: [], identityIds: [], affiliations: [], identityConfidence: 1, updatedAt: now} satisfies Person;
        graph.people.push(person);
      }
      for (const evidence of payload.evidence) {
        if (evidence.sourceId !== sourceId || evidence.claimKind !== 'IDENTITY') throw denied();
        const priorEvidence = graph.evidence.find(item => item.id === evidence.id);
        if (priorEvidence && canonicalJson(priorEvidence) !== canonicalJson(evidence)) throw conflict();
        if (!priorEvidence) graph.evidence.push(evidence);
      }
      const identityId = existing?.id ?? factDigest([sourceId, ep.sourceIdentity]);
      if (existing) {existing.evidenceIds = [...new Set([...existing.evidenceIds, ...ep.identityEvidenceIds])]; existing.updatedAt = now;}
      else {
        const identity: Identity = {id: identityId, sourceId, ...ep.sourceIdentity, displayName: ep.mention, personId,
          assignmentState: 'CONFIRMED', evidenceIds: ep.identityEvidenceIds, updatedAt: now};
        graph.identities.push(identity); person.identityIds.push(identityId);
      }
      person.updatedAt = now;
      await saveFactSnapshot(client, row, sources, graph);
      const decisionId = randomUUID();
      const changed = <K extends 'people' | 'identities' | 'evidence'>(key: K): GraphSnapshot[K] => graph[key].filter(item => !before[key].some(old => old.id === item.id && canonicalJson(old) === canonicalJson(item))) as GraphSnapshot[K];
      const event: GraphBuildEvent = {schemaVersion: 1, jobId: decisionId, scopeId: row.id, seq: 0, type: 'BATCH_COMMITTED', operationKind: 'IDENTITY_LINK',
        baseGraphVersion: row.graph_version, graphVersion: graph.graphVersion, people: changed('people'), identities: changed('identities'), evidence: changed('evidence'),
        sources: [], relationships: [], observedLinks: [], searchEdges: [], organizations: [], removedPersonIds: [], removedEdgeIds: []};
      validateGraphBuildEvent(event, {jobId: decisionId, scopeId: row.id, afterSeq: -1, before, after: graph, candidateIds: new Set(), proposalIds: new Set()});
      const response: ResolvePublicIdentityResponse = {scopeId: row.id, baseGraphVersion: row.graph_version, graphVersion: graph.graphVersion, decisionId,
        endpointId: request.endpointId, endpointRevision: request.expectedEndpointRevision, personId, identityId, duplicate: false, events: [event]};
      await client.query('INSERT INTO public_identity_decisions(id,scope_id,owner_user_id,source_id,endpoint_id,endpoint_revision,source_policy,idempotency_key,request_digest,request,previous_decision_id,person_id,identity_id,response,base_graph_version,graph_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)',
        [decisionId, row.id, row.owner_user_id, sourceId, request.endpointId, request.expectedEndpointRevision, PUBLIC_CITATION_POLICY, request.idempotencyKey, digest, request, latest?.id ?? null, personId, identityId, response, row.graph_version, graph.graphVersion]);
      return response;
    });
  }
}
