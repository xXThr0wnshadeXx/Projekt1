import { normalizeGoogleContacts } from './googleContactsNormalizer';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Anonymous structural checks; this module is never application seed data. */
export function runGoogleContactsNormalizerChecks(): void {
  const context = { sourceId: 'source-test', batchId: 'batch-test' };
  const input = {
    ownerPersonId: 'owner-test',
    retrievedAt: '2026-09-05T12:00:00.000Z',
    connections: [
      {
        resourceName: 'people/test-contact',
        names: [{ displayName: 'Test Contact' }],
        organizations: [{ name: 'Test Organization', title: 'Test Role' }],
      },
      { resourceName: 'people/test-contact', names: [{ displayName: 'Ignored duplicate' }] },
      { resourceName: 'people/missing-name' },
      null,
    ],
  };

  const first = normalizeGoogleContacts(input, context);
  const second = normalizeGoogleContacts(input, context);

  assert(first.people.length === 2, 'deduplication should retain valid distinct contacts');
  assert(first.observedLinks.length === 2, 'each contact produces one directional observation');
  assert(first.observedLinks[0].fromRef === 'owner-test', 'owner must be the link source');
  assert(first.observedLinks[0].kind === 'CONTACT_SAVED', 'link kind must preserve contact semantics');
  assert(first.relationships.length === 0, 'contacts must not become relationships');
  assert(first.affiliations.length === 1, 'actual organization data may become an affiliation');
  assert(first.people[0].tempId === second.people[0].tempId, 'reimport ids must be deterministic');
  assert(first.people[1].displayName.startsWith('source:handle-'), 'unnamed contacts need opaque source handles');
  assert(first.warnings.every((warning) => !warning.includes('test-contact')), 'warnings must redact record ids');

  const laterObservation = normalizeGoogleContacts(
    { ...input, retrievedAt: '2026-09-06T12:00:00.000Z' },
    context,
  );
  assert(first.people[0].tempId === laterObservation.people[0].tempId, 'person ids must survive a reimport');
  assert(first.evidence[0].id !== laterObservation.evidence[0].id, 'evidence must identify its observation time');

  const unsafeInput = normalizeGoogleContacts(
    { connections: [] },
    context,
  );
  assert(unsafeInput.people.length === 0, 'missing owner/time must not produce a batch of people');
  assert(unsafeInput.warnings.includes('GOOGLE_CONTACTS_MISSING_OWNER_REFERENCE'), 'missing owner is explicit');
}
