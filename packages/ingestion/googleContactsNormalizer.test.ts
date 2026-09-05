import { normalizeGoogleContacts } from './googleContactsNormalizer.ts';

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
        organizations: [
          { name: 'Test Organization', title: 'Test Role', current: true },
          { name: 'Test Organization', title: 'Test Role', current: true },
          { name: 'Past Organization', title: 'Intern', current: false },
        ],
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
  assert(first.affiliations.length === 2, 'identical organization claims must be deduplicated');
  assert(
    first.affiliations.some((affiliation) => affiliation.current === true)
      && first.affiliations.some((affiliation) => affiliation.current === false),
    'Google current-organization status must be preserved',
  );
  assert(
    first.warnings.includes('GOOGLE_CONTACTS_DUPLICATE_AFFILIATION_SKIPPED'),
    'duplicate affiliation input must be redacted in warnings',
  );
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

  const malformedFields = normalizeGoogleContacts({
    ownerPersonId: 'owner-test',
    retrievedAt: '2026-09-05T12:00:00.000Z',
    connections: [{
      resourceName: 'people/malformed-fields',
      names: { displayName: 'Never included' },
      organizations: { name: 'Never included' },
    }],
  }, context);
  assert(malformedFields.people.length === 1, 'malformed optional fields must not discard a contact');
  assert(malformedFields.affiliations.length === 0, 'malformed organization fields must be skipped');
  assert(
    malformedFields.warnings.includes('GOOGLE_CONTACTS_NAMES_NOT_ARRAY')
      && malformedFields.warnings.includes('GOOGLE_CONTACTS_ORGANIZATIONS_NOT_ARRAY'),
    'provider-shaped objects must be rejected safely rather than throwing',
  );

  const invalidCurrent = normalizeGoogleContacts({
    ownerPersonId: 'owner-test',
    retrievedAt: '2026-09-05T12:00:00.000Z',
    connections: [{
      resourceName: 'people/invalid-current',
      organizations: [{ name: 'Test Organization', current: 'yes' }],
    }],
  }, context);
  assert(
    invalidCurrent.affiliations[0]?.current === null
      && invalidCurrent.warnings.includes('GOOGLE_CONTACTS_ORGANIZATION_INVALID_CURRENT'),
    'invalid current status must become unknown',
  );
}

runGoogleContactsNormalizerChecks();
