import type { GraphSnapshot, SourceContext } from '../../../contracts/index.js';
import * as s from '../../../contracts/schema.js';
import type { AuthPort } from '../service.js';
import { BackendService, ServiceError } from '../service.js';
import { PgStore } from '../storage/postgres.js';
import { CONTACTS_SOURCE_POLICY } from '../storage/contacts.js';
import { googleContactsEnvelope, normalizedContactRecord, normalizedDigest, opaqueDigest } from './provenance.js';
import type { ApproveGoogleImportRequest, ContactsAccessPort, ImportApprovalResponse, ImportReviewResponse, ImportStartResponse, RetrieveAndNormalizeGoogleContacts, ReviewImportRequest, StartGoogleImportRequest } from './contracts.js';
const startShape = s.object({scopeId: s.id, sourceId: s.id, expectedGraphVersion: s.id, idempotencyKey: s.id});
const reviewShape = s.object({scopeId: s.id, jobId: s.id});
const approveShape = s.object({scopeId: s.id, jobId: s.id, expectedGraphVersion: s.id, idempotencyKey: s.id, confirm: s.literal(true)});
const denied = () => new ServiceError('FORBIDDEN', 403);
const conflict = () => new ServiceError('VERSION_CONFLICT', 409);

/** Thin server helper; all inputs must arrive through bounded authenticated HTTP adapters.
 * No provider HTTP/pagination/parser logic lives here. Credential and tokens never enter responses.
 */
export class GoogleImportBridge {
  private readonly service: BackendService;
  constructor(private readonly ports: {auth: AuthPort; store: PgStore; contacts: ContactsAccessPort; retrieveAndNormalize: RetrieveAndNormalizeGoogleContacts; now?: () => number}) {
    this.service = new BackendService({auth: ports.auth, reads: ports.store, imports: ports.store});
  }
  private async actor(credential: unknown) {
    const user = await this.ports.auth.resolveSession(credential); if (!user) throw new ServiceError('UNAUTHENTICATED', 401); return user;
  }
  private async source(credential: unknown, scopeId: string, sourceId: string) {
    const actor = await this.actor(credential), scope = await this.ports.store.authorizePrivateScope(actor.userId, scopeId);
    if (!scope || !scope.sourceIds.has(sourceId)) throw denied();
    const graph = await this.service.graph(credential, scopeId);
    if (!graph.sources.some(source => source.id === sourceId && source.provider === 'GOOGLE_CONTACTS' && source.origin === 'AUTHORIZED_API')) throw denied();
    return {actor, graph};
  }
  private async outcome(userId: string, context: SourceContext, jobId: string, duplicate: boolean): Promise<ImportStartResponse> {
    const review = await this.ports.store.getImportReview(userId, context.scopeId, jobId);
    return {jobId, scopeId: context.scopeId, sourceId: context.sourceId, status: review.status as ImportStartResponse['status'], duplicate};
  }
  async start(credential: unknown, input: unknown): Promise<ImportStartResponse> {
    startShape(input, '$'); const request = input as StartGoogleImportRequest;
    const {actor, graph} = await this.source(credential, request.scopeId, request.sourceId);
    const context: SourceContext = {ownerUserId: actor.userId, scopeId: graph.scopeId, sourceId: request.sourceId, batchId: opaqueDigest(actor.userId, graph.scopeId, request.sourceId, request.idempotencyKey), sourcePolicyVersion: CONTACTS_SOURCE_POLICY, sharingDecisionId: null};
    // The API is an idempotent import command, not a caller-submitted candidate payload. Retry
    // returns its committed job before contacting Google or using a stale expected graph version.
    const retryKey = {actorUserId: actor.userId, context};
    const prior = await this.ports.store.lookupRetry(retryKey);
    if (prior) return this.outcome(actor.userId, context, prior.outcome.jobId, true);
    if (request.expectedGraphVersion !== graph.graphVersion) throw conflict();
    const access = await this.ports.contacts.getFreshAccessToken(credential, request.sourceId);
    if (access.scopeId !== graph.scopeId || access.sourceId !== request.sourceId) throw denied();
    const retrievedAt = new Date((this.ports.now ?? Date.now)()).toISOString();
    const batch = await this.ports.retrieveAndNormalize({accessToken: access.accessToken, sourceId: request.sourceId, batchId: context.batchId, ownerPersonId: graph.rootPersonId, retrievedAt});
    const envelope = googleContactsEnvelope({batch, context, snapshot: graph, retrievedAt});
    try {
      const staged = await this.service.stageImport(credential, context, request.expectedGraphVersion, envelope);
      return this.outcome(actor.userId, context, staged.jobId, staged.duplicate);
    } catch (error) {
      // Concurrent executions of the SAME command may fetch at different instants. First durable
      // result wins at this command layer; ImportPort itself still rejects differing payload digests.
      if (error instanceof ServiceError && error.code === 'VERSION_CONFLICT') {
        const currentActor = await this.actor(credential); if (currentActor.userId !== actor.userId) throw denied();
        const receipt = await this.ports.store.lookupRetry(retryKey);
        if (receipt) return this.outcome(actor.userId, context, receipt.outcome.jobId, true);
      }
      throw error;
    }
  }
  private async reviewData(credential: unknown, input: ReviewImportRequest) {
    const actor = await this.actor(credential);
    const stored = await this.ports.store.getImportReview(actor.userId, input.scopeId, input.jobId);
    const {graph} = await this.source(credential, input.scopeId, stored.batch.sourceId);
    if (graph.graphVersion !== stored.graphVersion) throw conflict();
    const candidateIds = new Set(stored.batch.people.map(p => p.tempId));
    if (stored.batch.relationships.length !== 0 || stored.batch.observedLinks.some(l => l.kind !== 'CONTACT_SAVED' || l.fromRef !== graph.rootPersonId || !candidateIds.has(l.toRef)) || stored.batch.affiliations.some(a => !candidateIds.has(a.personRef))) throw denied();
    return {actor, stored, graph};
  }
  private decisions(graph: GraphSnapshot, batch: Awaited<ReturnType<PgStore['getImportReview']>>['batch']) {
    return batch.people.map(person => {
      if (person.identities.length !== 1 || person.identities[0]!.platform !== 'GOOGLE_CONTACTS') throw denied();
      const sourceIdentity = person.identities[0]!;
      const existing = graph.identities.find(i => i.sourceId === batch.sourceId && i.platform === sourceIdentity.platform && i.externalId === sourceIdentity.externalId);
      if (existing && (existing.assignmentState !== 'CONFIRMED' || existing.personId === null || existing.personId === graph.rootPersonId)) throw conflict();
      return {tempId: person.tempId, personId: existing?.personId ?? null};
    });
  }
  async review(credential: unknown, input: unknown): Promise<ImportReviewResponse> {
    reviewShape(input, '$'); const request = input as ReviewImportRequest;
    const {stored, graph} = await this.reviewData(credential, request), assignments = this.decisions(graph, stored.batch);
    const staleAssignments = stored.status === 'PENDING_REVIEW' && stored.batch.people.some(person => (person.existingPersonId ?? null) !== assignments.find(a => a.tempId === person.tempId)!.personId);
    const people: ImportReviewResponse['people'] = stored.batch.people.map(person => {
      const existingPersonId = assignments.find(a => a.tempId === person.tempId)!.personId;
      return {candidateId: person.tempId, displayName: person.displayName, disposition: existingPersonId === null ? 'NEW_PERSON' : 'EXISTING_SOURCE_IDENTITY', existingPersonId};
    });
    return {jobId: request.jobId, scopeId: graph.scopeId, sourceId: stored.batch.sourceId, graphVersion: graph.graphVersion, status: stored.status as ImportReviewResponse['status'], canApprove: stored.status === 'PENDING_REVIEW' && !staleAssignments,
      people, observations: stored.batch.observedLinks.map(link => ({fromPersonId: link.fromRef, toCandidateId: link.toRef, kind: 'CONTACT_SAVED'})),
      affiliations: stored.batch.affiliations.map(a => ({candidateId: a.personRef, organizationName: a.organizationName, ...(a.role === undefined ? {} : {role: a.role}), current: a.current ?? null, state: 'PENDING'})),
      counts: {people: people.length, newPeople: people.filter(p => p.existingPersonId === null).length, existingPeople: people.filter(p => p.existingPersonId !== null).length, savedContactObservations: stored.batch.observedLinks.length, pendingAffiliations: stored.batch.affiliations.length},
      warnings: [...stored.batch.warnings, 'Saved contacts are observations, not confirmed introduction relationships.', 'Employer fields remain unconfirmed.', ...(staleAssignments ? ['A source identity changed after staging. Start a fresh import before approval.'] : [])]};
  }
  async approve(credential: unknown, input: unknown): Promise<ImportApprovalResponse> {
    approveShape(input, '$'); const request = input as ApproveGoogleImportRequest;
    const {actor, stored, graph} = await this.reviewData(credential, request);
    if (stored.status === 'OBSERVATIONS_APPROVED') {
      const completed = stored.events.find(e => e.type === 'IMPORT_COMPLETED');
      if (!completed || completed.type !== 'IMPORT_COMPLETED') throw new ServiceError('INTERNAL', 500);
      return {jobId: request.jobId, graphVersion: completed.graphVersion, duplicate: true, events: stored.events};
    }
    const assignments = this.decisions(graph, stored.batch);
    if (stored.batch.people.some(person => (person.existingPersonId ?? null) !== assignments.find(a => a.tempId === person.tempId)!.personId)) throw conflict();
    return this.ports.store.approveImportObservations({actorUserId: actor.userId, scopeId: graph.scopeId, jobId: request.jobId, expectedGraphVersion: request.expectedGraphVersion, idempotencyKey: request.idempotencyKey, personAssignments: assignments});
  }
  /** Server-private provenance resolver. Do NOT mount as a public/raw import HTTP route. */
  async readNormalizedRecord(credential: unknown, input: ReviewImportRequest & {privatePayloadRef: string}) {
    const actor = await this.actor(credential);
    const envelope = await this.ports.store.readImportEnvelopePrivate(actor.userId, input.scopeId, input.jobId);
    const record = envelope.records.find(r => r.privatePayloadRef === input.privatePayloadRef);
    if (!record) throw denied();
    const person = envelope.batch.people.find(p => p.identities.some(i => i.platform === 'GOOGLE_CONTACTS' && i.externalId === record.externalRecordId));
    if (!person) throw new ServiceError('INTERNAL', 500);
    const payload = normalizedContactRecord(envelope.batch, person.tempId);
    if (normalizedDigest(payload) !== record.contentDigest) throw new ServiceError('INTERNAL', 500);
    return {record, payload};
  }
}
