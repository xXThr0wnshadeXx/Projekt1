import { createHash } from 'node:crypto';
import type { CandidateBatch, GraphSnapshot, NormalizedImportEnvelope, SourceContext, SourceIdentityRef } from '../../../contracts/index.js';
import { canonicalJson } from '../../../contracts/canonical.js';
import { validateCandidateBatch, validateNormalizedImport } from '../../../contracts/validation.js';
import { ServiceError } from '../service.js';
const bad = () => new ServiceError('INVALID_INPUT', 400);
export const opaqueDigest = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
export const normalizedDigest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** Reconstructable persisted normalized record view. This is explicitly not a raw-provider digest.
 * The payload lives in envelope.batch, immutable inside its private import job. */
export function normalizedContactRecord(batch: CandidateBatch, tempId: string) {
  const person = batch.people.find(p => p.tempId === tempId); if (!person) throw bad();
  const observedLinks = batch.observedLinks.filter(l => l.toRef === tempId);
  const affiliations = batch.affiliations.filter(a => a.personRef === tempId);
  const evidenceIds = new Set([...person.evidenceIds, ...observedLinks.flatMap(l => l.evidenceIds), ...affiliations.flatMap(a => a.evidenceIds)]);
  const {existingPersonId: _projection, ...sourcePerson} = person;
  return {person: sourcePerson, observedLinks, affiliations, evidence: batch.evidence.filter(e => evidenceIds.has(e.id))};
}

/** Restrict the Google Contacts bridge to exactly Shaw's saved-contact semantics. */
export function googleContactsEnvelope(input: {batch: CandidateBatch; context: SourceContext; snapshot: GraphSnapshot; retrievedAt: string}): NormalizedImportEnvelope {
  const {context, snapshot: graph, retrievedAt} = input, batch = structuredClone(input.batch);
  // Shape validation precedes any provider-specific projection. Source/root authority is server-owned.
  validateCandidateBatch(batch, {sourceId: context.sourceId, batchId: context.batchId, existingPersonIds: new Set(graph.people.map(p => p.id)), existingEvidenceIds: new Set(graph.evidence.filter(e => e.sourceId === context.sourceId).map(e => e.id))});
  if (batch.relationships.length !== 0) throw bad();
  const owner = graph.identities.find(i => i.sourceId === context.sourceId && i.platform === 'google' && i.personId === graph.rootPersonId && i.assignmentState === 'CONFIRMED');
  if (!owner) throw new ServiceError('SOURCE_UNAVAILABLE', 502);
  const ownerIdentity: SourceIdentityRef = {platform: owner.platform, externalId: owner.externalId};
  const tempIds = new Set(batch.people.map(p => p.tempId));
  if (batch.observedLinks.some(l => l.fromRef !== graph.rootPersonId || !tempIds.has(l.toRef) || l.kind !== 'CONTACT_SAVED') || batch.affiliations.some(a => !tempIds.has(a.personRef))) throw bad();
  const identityByTemp = new Map<string, SourceIdentityRef>();
  for (const person of batch.people) {
    if (person.existingPersonId !== undefined || person.identities.length !== 1 || person.identities[0]!.platform !== 'GOOGLE_CONTACTS') throw bad();
    const identity = person.identities[0]!;
    const existing = graph.identities.find(i => i.sourceId === context.sourceId && i.platform === identity.platform && i.externalId === identity.externalId);
    if (existing) {
      if (existing.assignmentState !== 'CONFIRMED' || existing.personId === null || existing.personId === graph.rootPersonId) throw new ServiceError('VERSION_CONFLICT', 409);
      // Exact immutable source identity, already explicitly accepted: never a name/fuzzy match.
      person.existingPersonId = existing.personId;
    }
    identityByTemp.set(person.tempId, {platform: identity.platform, externalId: identity.externalId});
  }
  batch.affiliations.forEach(a => {a.current ??= null;});
  const envelope: NormalizedImportEnvelope = {context, batch, records: [], evidenceRecords: [], facts: []};
  const recordsByTemp = new Map<string, string>(), assignedEvidence = new Map<string, string>();
  for (const person of batch.people) {
    const sourceIdentity = identityByTemp.get(person.tempId)!, payload = normalizedContactRecord(batch, person.tempId);
    const recordId = opaqueDigest(context.sourceId, context.batchId, sourceIdentity.platform, sourceIdentity.externalId);
    recordsByTemp.set(person.tempId, recordId);
    envelope.records.push({id: recordId, sourceId: context.sourceId, ownerUserId: context.ownerUserId, externalRecordId: sourceIdentity.externalId, retrievedAt, contentDigest: normalizedDigest(payload), privatePayloadRef: `norm_${recordId}`});
    for (const evidence of payload.evidence) {
      if (assignedEvidence.has(evidence.id) || evidence.observedAt !== retrievedAt) throw bad();
      assignedEvidence.set(evidence.id, recordId);
      envelope.evidenceRecords.push({evidenceId: evidence.id, sourceRecordId: recordId});
    }
  }
  if (assignedEvidence.size !== batch.evidence.length) throw bad();
  const seenFacts = new Set<string>();
  batch.observedLinks.forEach((link, candidateIndex) => {
    const identity = identityByTemp.get(link.toRef)!;
    const factKey = opaqueDigest('saved-contact', context.sourceId, identity.platform, identity.externalId);
    if (seenFacts.has(factKey)) throw bad(); seenFacts.add(factKey);
    envelope.facts.push({kind: 'OBSERVED_LINK', candidateIndex, factKey, sourceRecordId: recordsByTemp.get(link.toRef)!, fromIdentity: ownerIdentity, toIdentity: identity});
  });
  batch.affiliations.forEach((affiliation, candidateIndex) => {
    const identity = identityByTemp.get(affiliation.personRef)!;
    const factKey = opaqueDigest('affiliation', context.sourceId, identity.platform, identity.externalId, affiliation.organizationName, affiliation.role ?? '', String(affiliation.current));
    if (seenFacts.has(factKey)) throw bad(); seenFacts.add(factKey);
    envelope.facts.push({kind: 'AFFILIATION', candidateIndex, factKey, sourceRecordId: recordsByTemp.get(affiliation.personRef)!, personIdentity: identity});
  });
  return validateNormalizedImport(envelope, {...context, existingPersonIds: new Set(graph.people.map(p => p.id)), existingEvidenceIds: new Set(graph.evidence.filter(e => e.sourceId === context.sourceId).map(e => e.id)), existingIdentities: graph.identities.filter(i => i.sourceId === context.sourceId)});
}
