import { createHash } from 'node:crypto';
import type { Affiliation, GraphSnapshot, SearchEdge } from '../../../contracts/index.js';
import { canonicalJson } from '../../../contracts/canonical.js';

export const FACT_PROJECTION_POLICY = 'confirmed-facts-v1';
export const factDigest = (value: unknown): string => createHash('sha256').update(canonicalJson(value)).digest('hex');

/** A selection identifies the exact displayed claim, including its current/evidence/state values. */
export function affiliationKey(personId: string, affiliation: Affiliation): string {
  return factDigest({personId, affiliation});
}

/** No observed-link priors, automatic inverse edges, identity assignment, or willingness inference. */
export function projectConfirmedRelationships(graph: GraphSnapshot, includedRelationshipIds: ReadonlySet<string>): SearchEdge[] {
  const evidence = new Map(graph.evidence.map(e => [e.id, e]));
  const sources = new Set(graph.sources.map(s => s.id));
  return graph.relationships
    .filter(r => includedRelationshipIds.has(r.id) && r.state === 'CONFIRMED' && r.kind !== 'UNKNOWN')
    .filter(r => r.strength > 0 && r.confidence > 0 && r.recencyFactor > 0)
    .filter(r => r.evidenceIds.length > 0 && r.evidenceIds.every(id => {
      const item = evidence.get(id); return item?.claimKind === 'RELATIONSHIP' && sources.has(item.sourceId);
    }))
    .filter(r => r.observedLinkIds.every(id => graph.observedLinks.some(l => l.id === id && l.fromPersonId === r.fromPersonId && l.toPersonId === r.toPersonId)))
    .map(r => ({id: `fact_edge_${factDigest(r.id)}`, relationshipId: r.id, fromPersonId: r.fromPersonId, toPersonId: r.toPersonId,
      strength: r.strength, confidence: r.confidence, recencyFactor: r.recencyFactor,
      evidenceIds: [...r.evidenceIds].sort(), basis: 'CONFIRMED_RELATIONSHIP' as const, policyVersion: FACT_PROJECTION_POLICY}))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}
