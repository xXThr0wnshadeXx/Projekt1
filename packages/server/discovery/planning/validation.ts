import * as s from '../../../../contracts/schema.js';
import {DiscoveryError} from '../contracts.js';
import {selectDocumentExcerpt, type RetrievedPublicDocument} from '../document-fetch.js';
import type {PlanningExtraction} from './types.js';

const endpoint = s.object({sourceIdentity:s.object({platform:s.string,externalId:s.string}), mention:s.string,
  identityState:s.literal('OWNER_ASSERTED_ANCHOR','UNRESOLVED','EXPLICITLY_CONFIRMED'), personId:s.nullable(s.id),
  resolutionRevision:s.id, resolutionDecisionId:s.nullable(s.id), identityEvidenceIds:s.array(s.id,1,100)});
const date = s.object({value:s.string,precision:s.literal('YEAR','MONTH','DAY','SECOND')});
const citation = s.object({id:s.id,evidenceId:s.id,documentId:s.id,documentRevision:s.id,
  role:s.literal('IDENTITY','RELATIONSHIP','AFFILIATION'),supportingExcerpt:s.string,
  locator:s.object({start:s.integer,end:s.integer,section:s.nullable(s.string)}),statementId:s.nullable(s.id)});
const proposal = s.object({id:s.id,revision:s.id,factKey:s.id,basis:s.literal('PUBLIC_SOURCE_CITATION'),
  kind:s.literal('IDENTITY','RELATIONSHIP','AFFILIATION'),subject:endpoint,object:s.nullable(endpoint),
  organizationRef:s.nullable(s.string),predicate:s.string,relationshipKind:s.nullable(s.relationshipKind),
  citationIds:s.array(s.id,1,100),assertedPeriod:s.nullable(s.object({start:s.nullable(date),end:s.nullable(date)})),
  current:s.nullable(s.boolean),support:s.literal('DIRECT_EXPLICIT','CORROBORATED_DIRECT','CONTEXT_ONLY','AMBIGUOUS'),
  confidence:s.object({value:s.nullable(s.score),meaning:s.literal('HEURISTIC_EVIDENCE_SUPPORT'),policyVersion:s.nullable(s.string)}),
  extractionUncertainties:s.array(s.string,0,20),reviewState:s.literal('PENDING'),reviewDecisionId:s.literal(null),includeInSearch:s.literal(false)});

/** Structural/citation checks for the query seam, not the facts service's acceptance validator.
 * Extra top-level extractor diagnostics are intentionally omitted from planner output. */
export function validatePlanningExtraction(value: PlanningExtraction, document: RetrievedPublicDocument): PlanningExtraction {
  try {
    const output: PlanningExtraction = {citations:value.citations,proposals:value.proposals};
    s.array(citation,0,100)(output.citations,'$');
    s.array(proposal,0,50)(output.proposals,'$');
    if (new Set(output.citations.map(c=>c.id)).size !== output.citations.length ||
      new Set(output.citations.map(c=>c.evidenceId)).size !== output.citations.length ||
      new Set(output.proposals.map(p=>p.id)).size !== output.proposals.length) throw new Error();
    for (const c of output.citations) {
      if (c.documentId !== document.id || c.documentRevision !== document.revision ||
        selectDocumentExcerpt(document,c.locator.start,c.locator.end).supportingExcerpt !== c.supportingExcerpt) throw new Error();
    }
    for (const p of output.proposals) {
      if (p.citationIds.some(id=>!output.citations.some(c=>c.id === id && c.role === p.kind))) throw new Error();
      for (const e of [p.subject,...(p.object ? [p.object] : [])]) {
        if (e.identityEvidenceIds.some(id=>!output.citations.some(c=>c.evidenceId === id && c.role === 'IDENTITY'))) throw new Error();
      }
    }
    return structuredClone(output);
  } catch {throw new DiscoveryError('INVALID_INPUT');}
}
