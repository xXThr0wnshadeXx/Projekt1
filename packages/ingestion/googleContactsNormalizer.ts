import type { CandidateBatch, Evidence, Id, IngestionAdapter } from '../../contracts/index';

/**
 * The narrow, provider-shaped subset read from People API connections.list.
 * Authentication, paging, storage, and runtime request validation remain at
 * the server boundary; this module only normalizes an already-authorized page.
 */
export interface GooglePeopleConnection {
  resourceName?: unknown;
  names?: unknown;
  organizations?: unknown;
}

export interface GoogleContactsPayload {
  /** Existing authorized person id for the signed-in owner. */
  ownerPersonId?: unknown;
  /** Accepted aliases make the adapter usable behind different server inputs. */
  rootPersonId?: unknown;
  root?: { personId?: unknown };
  retrievedAt?: unknown;
  connections?: unknown;
}

export interface GoogleContactsNormalizationContext {
  sourceId: Id;
  batchId: Id;
}

/**
 * `current` is part of Ben's pending shared-contract update. Keeping it on
 * the adapter output now avoids losing provider-supplied tenure state while
 * this branch is reviewed against the current main contract.
 */
export type GoogleContactsCandidateBatch = Omit<CandidateBatch, 'affiliations'> & {
  affiliations: Array<
    CandidateBatch['affiliations'][number] & {
      current?: boolean | null;
    }
  >;
};

const GOOGLE_PLATFORM = 'GOOGLE_CONTACTS';
const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

/**
 * Produces a deterministic, non-reversible-in-output identifier. The source
 * resource name is never emitted directly in a temp or evidence id.
 *
 * This is an adapter id, not a cryptographic privacy boundary. Ben's storage
 * layer should namespace and validate final persisted IDs.
 */
function opaqueId(kind: string, sourceId: Id, externalId: string): Id {
  const value = `${kind}\u001f${sourceId}\u001f${externalId}`;
  let first = 0x811c9dc5;
  let second = 0x01000193;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ (code + index), 0x85ebca6b) >>> 0;
  }

  return `${kind}-${first.toString(36)}${second.toString(36)}`;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function isUtcIsoDate(value: unknown): value is string {
  return typeof value === 'string' && ISO_UTC_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function arrayField(value: unknown, warning: string, warnings: string[]): unknown[] {
  if (value === undefined) return [];
  if (Array.isArray(value)) return value;

  warnings.push(warning);
  return [];
}

function currentStatus(value: unknown, warnings: string[]): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value;

  warnings.push('GOOGLE_CONTACTS_ORGANIZATION_INVALID_CURRENT');
  return null;
}

function ownerRef(input: GoogleContactsPayload): string | undefined {
  return nonEmptyString(input.ownerPersonId)
    ?? nonEmptyString(input.rootPersonId)
    ?? nonEmptyString(input.root?.personId);
}

function evidence(
  kind: Evidence['claimKind'],
  sourceId: Id,
  resourceName: string,
  observedAt: string,
  summary: string,
): Evidence {
  return {
    // Evidence identifies one source observation. Re-importing the same record
    // at a later retrievedAt creates new evidence while the candidate id stays
    // stable, letting persistence retain provenance history.
    id: opaqueId(`evidence-${kind.toLowerCase()}`, sourceId, `${resourceName}\u001f${observedAt}`),
    sourceId,
    summary,
    observedAt,
    confidence: 1,
    claimKind: kind,
  };
}

/**
 * Maps only saved-contact observations. It deliberately does not infer a
 * friendship, reciprocal edge, identity merge, or introduction relationship.
 */
export function normalizeGoogleContacts(
  input: GoogleContactsPayload,
  context: GoogleContactsNormalizationContext,
): GoogleContactsCandidateBatch {
  const warnings: string[] = [];
  const people: CandidateBatch['people'] = [];
  const observedLinks: CandidateBatch['observedLinks'] = [];
  const affiliations: GoogleContactsCandidateBatch['affiliations'] = [];
  const allEvidence: Evidence[] = [];
  const seenResourceNames = new Set<string>();

  const ownerPersonId = ownerRef(input);
  if (!ownerPersonId) warnings.push('GOOGLE_CONTACTS_MISSING_OWNER_REFERENCE');
  if (!isUtcIsoDate(input.retrievedAt)) warnings.push('GOOGLE_CONTACTS_INVALID_RETRIEVED_AT');

  const connections = Array.isArray(input.connections) ? input.connections : [];
  if (!Array.isArray(input.connections)) warnings.push('GOOGLE_CONTACTS_CONNECTIONS_NOT_ARRAY');

  // Without an owner or trustworthy observed time, no source-grounded link can
  // be formed. Return a safe empty batch rather than inventing either value.
  if (!ownerPersonId || !isUtcIsoDate(input.retrievedAt)) {
    return {
      schemaVersion: 1,
      batchId: context.batchId,
      sourceId: context.sourceId,
      people,
      relationships: [],
      observedLinks,
      affiliations,
      evidence: allEvidence,
      warnings,
    };
  }

  for (const candidate of connections) {
    if (!candidate || typeof candidate !== 'object') {
      warnings.push('GOOGLE_CONTACTS_MALFORMED_RECORD');
      continue;
    }

    const connection = candidate as GooglePeopleConnection;
    const resourceName = nonEmptyString(connection.resourceName);
    if (!resourceName) {
      warnings.push('GOOGLE_CONTACTS_RECORD_MISSING_RESOURCE_NAME');
      continue;
    }
    if (seenResourceNames.has(resourceName)) {
      warnings.push('GOOGLE_CONTACTS_DUPLICATE_RESOURCE_SKIPPED');
      continue;
    }
    seenResourceNames.add(resourceName);

    const names = arrayField(
      connection.names,
      'GOOGLE_CONTACTS_NAMES_NOT_ARRAY',
      warnings,
    );
    const namedDisplay = names
      .map((name) => nonEmptyString(asRecord(name)?.displayName))
      .find((name): name is string => Boolean(name));
    // A saved Google contact can legitimately have no usable name. Keep it as
    // a distinct record with an opaque source handle; do not invent a name.
    const displayName = namedDisplay ?? `source:${opaqueId('handle', context.sourceId, resourceName)}`;
    if (!namedDisplay) warnings.push('GOOGLE_CONTACTS_RECORD_MISSING_DISPLAY_NAME_USING_OPAQUE_HANDLE');

    const identityEvidence = evidence(
      'IDENTITY', context.sourceId, resourceName, input.retrievedAt,
      'Google Contacts record observed.',
    );
    const contactEvidence = evidence(
      'RELATIONSHIP', context.sourceId, resourceName, input.retrievedAt,
      'Google Contacts saved-contact observation.',
    );
    const tempId = opaqueId('person', context.sourceId, resourceName);

    people.push({
      tempId,
      displayName,
      identities: [{ platform: GOOGLE_PLATFORM, externalId: resourceName }],
      evidenceIds: [identityEvidence.id],
    });
    observedLinks.push({
      fromRef: ownerPersonId,
      toRef: tempId,
      kind: 'CONTACT_SAVED',
      evidenceIds: [contactEvidence.id],
    });
    allEvidence.push(identityEvidence, contactEvidence);

    const organizationKeys = new Set<string>();
    const organizations = arrayField(
      connection.organizations,
      'GOOGLE_CONTACTS_ORGANIZATIONS_NOT_ARRAY',
      warnings,
    );
    for (const organizationValue of organizations) {
      const organization = asRecord(organizationValue);
      if (!organization) {
        warnings.push('GOOGLE_CONTACTS_MALFORMED_ORGANIZATION');
        continue;
      }

      const organizationName = nonEmptyString(organization.name);
      if (!organizationName) continue;

      const role = nonEmptyString(organization.title);
      const current = currentStatus(organization.current, warnings);
      const affiliationKey = JSON.stringify([organizationName, role ?? null, current]);
      if (organizationKeys.has(affiliationKey)) {
        warnings.push('GOOGLE_CONTACTS_DUPLICATE_AFFILIATION_SKIPPED');
        continue;
      }
      organizationKeys.add(affiliationKey);
      const affiliationEvidence = evidence(
        'AFFILIATION',
        context.sourceId,
        `${resourceName}\u001f${organizationName}\u001f${role ?? ''}\u001f${current}`,
        input.retrievedAt,
        'Google Contacts organization field observed.',
      );
      affiliations.push({
        personRef: tempId,
        organizationName,
        ...(role ? { role } : {}),
        current,
        evidenceIds: [affiliationEvidence.id],
      });
      allEvidence.push(affiliationEvidence);
    }
  }

  return {
    schemaVersion: 1,
    batchId: context.batchId,
    sourceId: context.sourceId,
    people,
    relationships: [],
    observedLinks,
    affiliations,
    evidence: allEvidence,
    warnings,
  };
}

export class GoogleContactsAdapter implements IngestionAdapter<GoogleContactsPayload> {
  async normalize(
    input: GoogleContactsPayload,
    context: GoogleContactsNormalizationContext,
  ): Promise<CandidateBatch> {
    return normalizeGoogleContacts(input, context);
  }
}
