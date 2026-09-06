import type {PublicCitation, PublicClaimProposal} from './contracts.js';

export type SourceAttribution = {
  version: 'source-declared-author-v1';
  author: {
    locator: {start: number; end: number};
    declarationKinds: ['HTML_META_NAME_AUTHOR', 'JSONLD_ARTICLE_AUTHOR_NAME'];
  };
  article: {
    locator: {start: number; end: number};
    proseRanges: Array<{start: number; end: number}>;
  };
};

type AttributedDocument = {
  id?: string;
  revision?: string;
  normalizationVersion?: 'public-source-text-v1'|'public-source-attributed-v2';
  metadataStatus?: 'SOURCE_SUPPLIED_NOT_VERIFIED';
  attribution?: SourceAttribution|null;
};

const token = "\\p{Lu}[\\p{L}\\p{M}'’-]{0,39}";
const name = `${token}(?: ${token}){1,3}`;
const exactName = new RegExp(`^${name}$`, 'u');
const authoredFriend = new RegExp(`^My (?:(?:good|close) )?friend (${name})\\b[^.!?]*\\.$`, 'u');
const qualified = /["“”«»?`]|\b(?:not|never|no|neither|nor|den(?:y|ies|ied|ial)|false(?:hoods?)?|untrue|rumou?r|alleged|allegedly|reportedly|possibly|perhaps|maybe|might|may|could|would|if|fiction(?:al)?|hypothetical|example|satire|claim(?:s|ed)?|disputed|unverified|incorrect|retracted|fabricated|fake|debunked|suppose|imagine)\b/iu;
const negativeContraction = /\b(?:is|are|was|were|do|does|did|has|have|had|ca|could|wo|would|should|must|need|dare|ai|sha)n['’]t\b/iu;
const laterConflict = /\b(?:not|never|no longer|den(?:y|ies|ied|ial)|false|untrue|rumou?r|alleged|disputed|unverified|incorrect|retracted|fabricated|fake|debunked)\b/iu;
const relationWord = /\bfriends?\b/iu;
const reportOrQuote = /["“”«»]|\b(?:said|says|reported|according to|guest)\b/iu;
const plausibleCoreference = /\b(?:he|she|they|them|him|her)\b/iu;
const quoteMarker = /["“”«»]/u;
const attachedFraming = /\b(?:said|says|reported|according to|guest|fiction(?:al)?|satire|example|correction|clarification|update|retract(?:ed|ion)?)\b/iu;

function invalid(): never {throw new Error('Invalid source attribution');}
function range(value: unknown, limit: number): asserts value is {start: number; end: number} {
  if (!value || typeof value !== 'object') invalid();
  const item = value as {start?: unknown; end?: unknown};
  const start = item.start, end = item.end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || (start as number) < 0 || (end as number) <= (start as number) || (end as number) > limit) invalid();
}
function within(inner: {start: number; end: number}, outer: {start: number; end: number}): boolean {
  return inner.start >= outer.start && inner.end <= outer.end;
}
function sameRange(a: {start: number; end: number}, b: {start: number; end: number}): boolean {
  return a.start === b.start && a.end === b.end;
}
function citationForEvidence(citations: PublicCitation[], evidenceId: string, document: {id?: string; revision?: string}): PublicCitation | undefined {
  return citations.find(c => c.evidenceId === evidenceId && c.role === 'IDENTITY' && c.documentId === document.id && c.documentRevision === document.revision);
}

/** Validates the source-derived, normalized author/article sidecar. It does not authenticate an author. */
export function validateDocumentAttribution(document: AttributedDocument, normalizedText: string): void {
  if (document.normalizationVersion === undefined || document.normalizationVersion === 'public-source-text-v1') {
    if (document.attribution !== undefined && document.attribution !== null) invalid();
    return;
  }
  if (document.normalizationVersion !== 'public-source-attributed-v2' || document.metadataStatus !== 'SOURCE_SUPPLIED_NOT_VERIFIED' || !document.attribution) invalid();
  const attribution = document.attribution;
  if (attribution.version !== 'source-declared-author-v1' || !Array.isArray(attribution.author.declarationKinds) ||
    attribution.author.declarationKinds.length !== 2 || attribution.author.declarationKinds[0] !== 'HTML_META_NAME_AUTHOR' ||
    attribution.author.declarationKinds[1] !== 'JSONLD_ARTICLE_AUTHOR_NAME') invalid();
  range(attribution.author.locator, normalizedText.length); range(attribution.article.locator, normalizedText.length);
  if (attribution.author.locator.end >= attribution.article.locator.start || !exactName.test(normalizedText.slice(attribution.author.locator.start, attribution.author.locator.end))) invalid();
  if (!Array.isArray(attribution.article.proseRanges) || !attribution.article.proseRanges.length || attribution.article.proseRanges.length > 256) invalid();
  let previous = attribution.article.locator.start;
  for (const prose of attribution.article.proseRanges) {
    range(prose, normalizedText.length);
    if (!within(prose, attribution.article.locator) || prose.start < previous || prose.end - prose.start > 10_000) invalid();
    previous = prose.end;
  }
}

/** Returns the named first-person friend object only for an unqualified full source sentence. */
export function authoredFriendObject(sentence: string): string|null {
  const match = authoredFriend.exec(sentence);
  if (!match || qualified.test(sentence) || negativeContraction.test(sentence)) return null;
  return match[1]!;
}

function articleSentences(text: string, article: {start: number; end: number}): Array<{start: number; end: number; text: string}> {
  const result: Array<{start: number; end: number; text: string}> = [];
  const source = text.slice(article.start, article.end);
  for (const block of source.matchAll(/[^\n]+/gu)) {
    for (const part of block[0].matchAll(/[^.!?]+[.!?]|[^.!?]+$/gu)) {
      const sentence = part[0].trim();
      if (!sentence) continue;
      const start = article.start + block.index! + part.index! + part[0].indexOf(sentence);
      result.push({start, end: start + sentence.length, text: sentence});
    }
  }
  return result;
}

/** Rejects named and plausible coreference denials/retractions anywhere in the selected article.
 * It intentionally ignores negatives without a relationship cue. */
export function hasAuthoredRelationshipConflict(document: AttributedDocument, normalizedText: string,
  author: string, object: string, statement: {start: number; end: number}): boolean {
  validateDocumentAttribution(document, normalizedText);
  if (document.normalizationVersion !== 'public-source-attributed-v2' || !document.attribution) return true;
  const sentences = articleSentences(normalizedText, document.attribution.article.locator);
  const candidate = sentences.findIndex(item => item.start <= statement.start && item.end >= statement.end);
  for (const [index, item] of sentences.entries()) {
    const hasRelation = relationWord.test(item.text);
    const candidateReference = item.text.includes(object) || item.text.includes(author) || plausibleCoreference.test(item.text);
    const denialOrUncertainty = laterConflict.test(item.text) || negativeContraction.test(item.text) || qualified.test(item.text);
    if (hasRelation && candidateReference && denialOrUncertainty) return true;
    if (item.text.includes(object) && reportOrQuote.test(item.text)) return true;
    if (index === candidate && (attachedFraming.test(item.text) || quoteMarker.test(item.text))) return true;
    if (index === candidate - 1 && (attachedFraming.test(item.text) || (item.text.includes(object) && quoteMarker.test(item.text)))) return true;
  }
  return false;
}

/** Shared stage/planner invariant for the authored first-person predicate. */
export function validateAuthoredProposal(document: AttributedDocument, normalizedText: string,
  proposal: PublicClaimProposal, citations: PublicCitation[]): void {
  validateDocumentAttribution(document, normalizedText);
  if (typeof document.id !== 'string' || !document.id || typeof document.revision !== 'string' || !document.revision ||
    document.normalizationVersion !== 'public-source-attributed-v2' || !document.attribution ||
    proposal.kind !== 'RELATIONSHIP' || proposal.predicate !== 'AUTHORED_FIRST_PERSON_FRIEND_OF' ||
    proposal.relationshipKind !== 'FRIEND' || proposal.support !== 'DIRECT_EXPLICIT' || !proposal.object ||
    proposal.assertedPeriod?.start !== null || proposal.assertedPeriod?.end !== null) invalid();
  const attribution = document.attribution;
  const author = normalizedText.slice(attribution.author.locator.start, attribution.author.locator.end);
  if (proposal.subject.mention !== author || proposal.subject.identityState !== 'UNRESOLVED' || proposal.subject.personId !== null ||
    proposal.object.identityState !== 'UNRESOLVED' || proposal.object.personId !== null || proposal.subject.mention === proposal.object.mention) invalid();
  const authorCites = proposal.subject.identityEvidenceIds.map(id => citationForEvidence(citations, id, document)).filter((c): c is PublicCitation => Boolean(c));
  if (authorCites.length !== proposal.subject.identityEvidenceIds.length || !authorCites.every(c =>
    sameRange(c.locator, attribution.author.locator) && c.supportingExcerpt === author && normalizedText.slice(c.locator.start, c.locator.end) === author)) invalid();
  const relationship = proposal.citationIds.map(id => citations.find(c => c.id === id && c.role === 'RELATIONSHIP')).filter((c): c is PublicCitation => Boolean(c));
  if (relationship.length !== proposal.citationIds.length || relationship.length !== 1) invalid();
  const statement = relationship[0]!;
  if (statement.documentId !== document.id || statement.documentRevision !== document.revision || !attribution.article.proseRanges.some(range => within(statement.locator, range)) || normalizedText.slice(statement.locator.start, statement.locator.end) !== statement.supportingExcerpt ||
    statement.supportingExcerpt.length > 500 || authoredFriendObject(statement.supportingExcerpt) !== proposal.object.mention) invalid();
  const objectCites = proposal.object.identityEvidenceIds.map(id => citationForEvidence(citations, id, document)).filter((c): c is PublicCitation => Boolean(c));
  if (objectCites.length !== proposal.object.identityEvidenceIds.length || !objectCites.every(c =>
    c.supportingExcerpt === proposal.object!.mention && within(c.locator, statement.locator) && normalizedText.slice(c.locator.start, c.locator.end) === proposal.object!.mention)) invalid();
  if (hasAuthoredRelationshipConflict(document, normalizedText, author, proposal.object.mention, statement.locator)) invalid();
}
