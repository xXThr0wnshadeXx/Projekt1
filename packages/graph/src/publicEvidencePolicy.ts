/**
 * Proposed policy for turning a reviewed public relationship claim into search
 * inputs.  It is deliberately not connected to persistence or HTTP: Ben's
 * acceptance transaction remains the only place that can make a claim
 * traversable.
 *
 * These are relative ranking factors, never probabilities that a person knows,
 * likes, or will introduce another person.
 */
export const PUBLIC_EVIDENCE_POLICY_VERSION = 'public-evidence-review-v1' as const;

export type PublicRelationshipSupport =
  | 'DIRECT_ATTRIBUTED_STATEMENT'
  | 'DIRECT_CORROBORATED_STATEMENT'
  | 'CONTEXT_ONLY';

export type PublicRelationshipFreshness = 'CURRENT' | 'RECENT' | 'STALE' | 'UNKNOWN';
export type ReviewerRoutePreference = 'PREFERRED' | 'STANDARD';

export interface ReviewedPublicRelationship {
  /** Both endpoint identities must already have explicit review decisions. */
  endpointIdentitiesResolved: boolean;
  /** The reviewer accepted this exact directional relationship claim. */
  relationshipAccepted: boolean;
  /** A citation must explicitly support this directed relationship. */
  support: PublicRelationshipSupport;
  /** Freshness describes the cited relationship claim, not a profile update. */
  freshness: PublicRelationshipFreshness;
  /** A reviewer can order otherwise comparable routes, but cannot inflate truth. */
  reviewerPreference: ReviewerRoutePreference;
}

export type PublicEvidenceRouteAssessment =
  | { eligible: false; reasons: string[] }
  | {
    eligible: true;
    /** Use only as a deterministic tie-breaker after the score is equal. */
    reviewerPreference: ReviewerRoutePreference;
    /** A trusted server policy must supply finite score factors or fail closed. */
    scoring: 'REQUIRES_APPROVED_SERVER_POLICY';
  };

/**
 * Public-evidence eligibility policy:
 *
 * - Direct attributable and corroborated-direct statements are eligible only
 *   after explicit identity and directional-claim review.
 * - Freshness remains a stated input, but receives no local numeric default.
 *   A trusted server policy must assess strength, confidence and freshness
 *   together, record its version, or refuse searchable acceptance.
 * - Context-only material (co-mentions, follows, co-employment and shared
 *   organizations) is never eligible for an introduction edge.
 *
 * Relationship strength is intentionally absent: only the existing reviewed
 * relationship decision supplies it. This prevents public citations from
 * silently creating friendship, direction, or willingness claims.
 */
export function assessReviewedPublicRelationship(
  relationship: ReviewedPublicRelationship,
): PublicEvidenceRouteAssessment {
  const reasons: string[] = [];
  if (!relationship.endpointIdentitiesResolved) reasons.push('Both endpoint identities require explicit review.');
  if (!relationship.relationshipAccepted) reasons.push('The directional relationship claim is not accepted.');
  if (relationship.support === 'CONTEXT_ONLY') {
    reasons.push('Context-only material cannot establish an introduction relationship.');
  }
  if (reasons.length > 0) return { eligible: false, reasons };

  return {
    eligible: true,
    reviewerPreference: relationship.reviewerPreference,
    scoring: 'REQUIRES_APPROVED_SERVER_POLICY',
  };
}
