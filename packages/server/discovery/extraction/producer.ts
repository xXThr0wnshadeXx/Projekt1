import type {SourceContext} from '../../../../contracts/index.js';
import * as s from '../../../../contracts/schema.js';
import {DiscoveryError, type PublicDocument, type PublicSourceEnvelope} from '../contracts.js';
import type {RetrievedPublicDocument} from '../document-fetch.js';
import {abortable} from '../providers/http.js';
import {buildPublicClaimFragments, type PublicClaimFragments} from './fragments.js';
import {EXTRACTION_VERSION, extractPublicDocument, hash, validateRetrievedDocument, type DocumentExtraction} from './extractor.js';

export interface ExtractionRequest {scopeId: string; expectedGraphVersion: string; idempotencyKey: string}
export interface ExtractionAuthority {
  context: SourceContext; graphVersion: string;
  source: {enabled: true; origin: 'PUBLIC_SOURCE'; provider: 'PUBLIC_PROFILE'|'PUBLIC_ARTICLE'};
  documents: Array<{documentId: string; documentRevision: string; privatePayloadRef: string;
    kind: PublicDocument['kind']; independenceGroup: string}>;
}
export interface PublicExtractionStageRequest {
  expectedGraphVersion: string; idempotencyKey: string; envelope: PublicSourceEnvelope;
  texts: Array<{documentId: string; documentRevision: string; normalizedText: string}>;
}
export interface PublicExtractionOutput {
  status: 'READY_TO_STAGE'|'NO_SUPPORTED_ASSERTIONS'; persistence: 'NOT_PERSISTED';
  stageRequest: PublicExtractionStageRequest|null; extractions: DocumentExtraction[];
  organizationMentions: PublicClaimFragments['organizationMentions'];
}
export interface PublicExtractionProducerOptions {
  /** Trusted server port: authenticate credential, authorize scope/version, provision enabled private
   * source and allocate opaque payload refs. Never forward authority from a browser body. Called
   * again before return; allocation must be stable for the same operation. Stage performs final
   * transactional reauthorization and persists texts. This producer performs no persistence. */
  authorize(credential: unknown, request: ExtractionRequest, documents: ReadonlyArray<RetrievedPublicDocument>): Promise<ExtractionAuthority>;
}

function validateAuthority(authority: ExtractionAuthority, request: ExtractionRequest, docs: RetrievedPublicDocument[]): void {
  try {
    s.sourceContext(authority.context, '$'); s.id(authority.graphVersion, '$');
    s.object({enabled: s.literal(true), origin: s.literal('PUBLIC_SOURCE'), provider: s.literal('PUBLIC_PROFILE','PUBLIC_ARTICLE')})(authority.source, '$');
    s.array(s.object({documentId: s.id, documentRevision: s.id, privatePayloadRef: s.id,
      kind: s.literal('PUBLIC_PROFILE','PUBLIC_ARTICLE','WIKIMEDIA_PAGE','WIKIDATA_ENTITY'), independenceGroup: s.id}), 1, 5)(authority.documents, '$');
    if (authority.context.scopeId !== request.scopeId || authority.context.sharingDecisionId !== null ||
      authority.context.sourcePolicyVersion !== 'public-citation-review-v1') throw new Error();
    if (authority.documents.length !== docs.length || new Set(authority.documents.map(d => d.documentId)).size !== docs.length ||
      new Set(authority.documents.map(d => d.privatePayloadRef)).size !== docs.length) throw new Error();
    for (const doc of docs) {
      const binding = authority.documents.find(d => d.documentId === doc.id && d.documentRevision === doc.revision);
      if (!binding || authority.source.provider !== (['PUBLIC_ARTICLE','WIKIMEDIA_PAGE'].includes(binding.kind) ? 'PUBLIC_ARTICLE' : 'PUBLIC_PROFILE')) throw new Error();
    }
  } catch {throw new DiscoveryError('FORBIDDEN');}
  if (authority.graphVersion !== request.expectedGraphVersion) throw new DiscoveryError('VERSION_CONFLICT');
}

/** Private sidecar producer. Canonical graph candidates and normalized facts are always empty. */
export function createPublicExtractionProducer(options: PublicExtractionProducerOptions) {
  return {async produce(credential: unknown, input: unknown, retrieved: RetrievedPublicDocument[], parentSignal: AbortSignal = new AbortController().signal): Promise<PublicExtractionOutput> {
    let request: ExtractionRequest;
    try {
      s.object({scopeId: s.id, expectedGraphVersion: s.id, idempotencyKey: s.id})(input, '$');
      request = structuredClone(input as ExtractionRequest);
      if (!Array.isArray(retrieved) || !retrieved.length || retrieved.length > 5) throw new Error();
      retrieved.forEach(validateRetrievedDocument);
      if (new Set(retrieved.map(d => d.id)).size !== retrieved.length) throw new Error();
    } catch {throw new DiscoveryError('INVALID_INPUT');}
    // Snapshot before awaiting any external port; neither caller nor authorize can alter extraction.
    const docs = structuredClone(retrieved), signal = AbortSignal.any([parentSignal, AbortSignal.timeout(10000)]);
    const authorize = async () => {
      try {return structuredClone(await abortable(options.authorize(credential, structuredClone(request), structuredClone(docs)), signal));}
      catch (error) {if (error instanceof DiscoveryError) throw error; throw new DiscoveryError('FORBIDDEN');}
    };
    const authority = await authorize(); validateAuthority(authority, request, docs);
    const context = authority.context;
    const envelope: PublicSourceEnvelope = {schemaVersion: 1, normalized: {context,
      batch: {schemaVersion: 1, batchId: context.batchId, sourceId: context.sourceId, people: [], relationships: [], observedLinks: [], affiliations: [], evidence: [],
        warnings: ['Public claims and person mentions require explicit review. Confidence is unassessed; legacy evidence confidence 0 is a nontraversable placeholder.',
          'Unsupported language is omitted. Names and profile slugs never verify identities. No willingness or reciprocal edges are inferred.']},
      records: [], evidenceRecords: [], facts: []}, documents: [], citations: [], proposals: []};
    const extractions: DocumentExtraction[] = [];
    const organizationMentions: PublicClaimFragments['organizationMentions'] = [];
    const scoped = (prefix: string, value: unknown) => `${prefix}_${hash([context.ownerUserId, context.scopeId, context.sourceId, value])}`;
    for (const doc of docs) {
      if (signal.aborted) throw new DiscoveryError('CANCELLED');
      const binding = authority.documents.find(d => d.documentId === doc.id)!;
      const recordId = scoped('record', doc.id);
      envelope.documents.push({id: doc.id, revision: doc.revision, sourceId: context.sourceId, kind: binding.kind,
        sourceUrl: doc.sourceUrl, fetchedUrl: doc.fetchedUrl, title: doc.title, publisher: doc.publisher, publishedAt: doc.publishedAt,
        retrievedAt: doc.retrievedAt, contentDigest: doc.contentDigest, digestBasis: doc.digestBasis,
        privatePayloadRef: binding.privatePayloadRef, upstreamRevisionId: doc.upstreamRevisionId,
        independenceGroup: binding.independenceGroup, originalSourceUrls: []});
      envelope.normalized.records.push({id: recordId, sourceId: context.sourceId, ownerUserId: context.ownerUserId,
        externalRecordId: doc.id, retrievedAt: doc.retrievedAt, contentDigest: doc.contentDigest, privatePayloadRef: binding.privatePayloadRef});
      const remaining = Math.floor((50 - envelope.proposals.length) / 3);
      const extracted: DocumentExtraction = remaining > 0 ? extractPublicDocument(doc, Math.min(10, remaining)) :
        {version: EXTRACTION_VERSION, documentId: doc.id, documentRevision: doc.revision, mentions: [], assertions: [], issues: ['ASSERTION_LIMIT']};
      extractions.push(extracted);
      const fragments = buildPublicClaimFragments(doc, extracted, scoped);
      envelope.citations.push(...fragments.citations);
      envelope.proposals.push(...fragments.proposals);
      organizationMentions.push(...fragments.organizationMentions);
      for (const cite of fragments.citations) {
        envelope.normalized.batch.evidence.push({id: cite.evidenceId, sourceId: context.sourceId, summary: cite.supportingExcerpt,
          observedAt: doc.retrievedAt, confidence: 0, claimKind: cite.role});
        envelope.normalized.evidenceRecords.push({evidenceId: cite.evidenceId, sourceRecordId: recordId});
      }
    }
    if (extractions.some(result => result.issues.includes('ASSERTION_LIMIT')))
      envelope.normalized.batch.warnings.push('Extraction limits reached; some source statements were not processed.');
    const latest = await authorize(); validateAuthority(latest, request, docs);
    if (hash(latest) !== hash(authority)) throw new DiscoveryError('VERSION_CONFLICT');
    if (!envelope.proposals.length) return {status: 'NO_SUPPORTED_ASSERTIONS', persistence: 'NOT_PERSISTED', stageRequest: null, extractions, organizationMentions};
    return {status: 'READY_TO_STAGE', persistence: 'NOT_PERSISTED', extractions, organizationMentions,
      stageRequest: {expectedGraphVersion: request.expectedGraphVersion, idempotencyKey: request.idempotencyKey, envelope,
        texts: docs.map(doc => ({documentId: doc.id, documentRevision: doc.revision, normalizedText: doc.normalizedText}))}};
  }};
}
