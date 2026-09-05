import type { Affiliation, Goal, GraphSnapshot, Target } from '../../../contracts/index.js';

/**
 * Resolves only targets that have an explicit, confirmed affiliation with an
 * organization named in the goal. This deliberately does not infer a role,
 * location, industry, vacancy, or willingness to help from a profile.
 */
export function resolveEvidenceBackedTargets(snapshot: GraphSnapshot, goal: Goal): Target[] {
  const requestedOrganizations = new Set(goal.organizationIds);
  if (requestedOrganizations.size === 0) return [];

  const organizationIds = new Set(snapshot.organizations.map((organization) => organization.id));
  const affiliationEvidenceIds = new Set(snapshot.evidence
    .filter((evidence) => evidence.claimKind === 'AFFILIATION')
    .map((evidence) => evidence.id));

  return snapshot.people
    .filter((person) => person.id !== snapshot.rootPersonId)
    .map((person) => {
      const matches = person.affiliations
        .filter((affiliation) => requestedOrganizations.has(affiliation.organizationId))
        .filter((affiliation) => organizationIds.has(affiliation.organizationId))
        .filter((affiliation) => isSupportedAffiliation(affiliation, affiliationEvidenceIds))
        .sort((left, right) => left.organizationId.localeCompare(right.organizationId));

      if (matches.length === 0) return undefined;
      const primaryMatch = matches[0]!;

      const matchedOrganizationIds = new Set(matches.map((affiliation) => affiliation.organizationId));
      const evidenceIds = uniqueSorted(matches.flatMap((affiliation) => affiliation.support.evidenceIds));
      const criteria = [
        ...goal.organizationIds.map((organizationId) => ({
          name: `organization:${organizationId}`,
          status: matchedOrganizationIds.has(organizationId) ? ('MATCHED' as const) : ('UNKNOWN' as const),
        })),
        ...unknownCriteria('role', goal.roles),
        ...unknownCriteria('location', goal.locations),
        ...unknownCriteria('industry', goal.industries),
        ...unknownCriteria('constraint', goal.unsupportedConstraints),
      ];

      const target: Target = {
        personId: person.id,
        organizationId: primaryMatch.organizationId,
        // An explicit, confirmed organization match is the only relevance
        // signal in v1. Other goal constraints remain visible as UNKNOWN.
        relevance: 1,
        evidenceIds,
        reasons: [...matchedOrganizationIds]
          .sort((left, right) => left.localeCompare(right))
          .map((organizationId) => `Supported affiliation matches organization:${organizationId}.`),
        criteria,
      };
      return target;
    })
    .filter((target): target is Target => target !== undefined)
    .sort((left, right) => left.personId.localeCompare(right.personId));
}

function isSupportedAffiliation(affiliation: Affiliation, validEvidenceIds: Set<string>): boolean {
  const { support } = affiliation;
  return support.state === 'CONFIRMED'
    && support.value === true
    && isUnitScore(support.confidence)
    && support.confidence > 0
    && support.evidenceIds.length > 0
    && support.evidenceIds.every((evidenceId) => validEvidenceIds.has(evidenceId));
}

function unknownCriteria(prefix: string, values: string[]): Target['criteria'] {
  return values.map((value) => ({ name: `${prefix}:${value}`, status: 'UNKNOWN' }));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function isUnitScore(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}
