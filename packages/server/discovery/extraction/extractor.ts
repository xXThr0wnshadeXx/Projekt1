import {createHash} from 'node:crypto';
import type {RelationshipKind} from '../../../../contracts/index.js';
import {DiscoveryError, publicUrl, type DateValue} from '../contracts.js';
import {selectDocumentExcerpt, type DocumentExcerpt, type RetrievedPublicDocument} from '../document-fetch.js';
import * as s from '../../../../contracts/schema.js';

export const EXTRACTION_VERSION = 'explicit-sentences-v1';
export const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ExtractedMention {id: string; name: string; excerpt: DocumentExcerpt}
export interface ExtractedAssertion {
  id: string; kind: 'RELATIONSHIP'|'AFFILIATION'; subjectMentionId: string; objectMentionId: string|null;
  organization: {id: string; name: string}|null; predicate: string; relationshipKind: RelationshipKind|null;
  excerpt: DocumentExcerpt; assertedPeriod: {start: DateValue|null; end: DateValue|null}; current: boolean|null;
}
export interface DocumentExtraction {
  version: typeof EXTRACTION_VERSION; documentId: string; documentRevision: string;
  mentions: ExtractedMention[]; assertions: ExtractedAssertion[];
  issues: Array<'UNSUPPORTED_TEXT'|'AMBIGUOUS_CONTEXT'|'REPEATED_ENDPOINT_NAME'|'ASSERTION_LIMIT'>;
}

/** Source metadata remains source-supplied, never authenticated identity evidence. */
export function validateRetrievedDocument(doc: RetrievedPublicDocument): void {
  try {
    s.id(doc.id, '$'); s.id(doc.revision, '$'); s.date(doc.retrievedAt, '$');
    publicUrl(doc.sourceUrl); publicUrl(doc.fetchedUrl);
    if (typeof doc.normalizedText !== 'string' || !doc.normalizedText.trim() || Buffer.byteLength(doc.normalizedText) > 1024 * 1024) throw new Error();
    if (doc.digestBasis !== 'NORMALIZED_TEXT_SHA256' || doc.normalizationVersion !== 'public-source-text-v1' ||
      doc.metadataStatus !== 'SOURCE_SUPPLIED_NOT_VERIFIED' || doc.persistence !== 'NOT_PERSISTED' ||
      createHash('sha256').update(doc.normalizedText).digest('hex') !== doc.contentDigest) throw new Error();
    if (typeof doc.title !== 'string' || !doc.title.trim() || doc.title.length > 500 ||
      (doc.publisher !== null && (typeof doc.publisher !== 'string' || doc.publisher.length > 2000))) throw new Error();
    if (doc.upstreamRevisionId !== null) s.id(doc.upstreamRevisionId, '$');
    if (doc.publishedAt !== null) {
      const {value, precision} = doc.publishedAt;
      if (precision === 'SECOND') s.date(value, '$');
      else {
        const suffix = precision === 'YEAR' ? '-01-01' : precision === 'MONTH' ? '-01' : precision === 'DAY' ? '' : null;
        const pattern = precision === 'YEAR' ? /^\d{4}$/ : precision === 'MONTH' ? /^\d{4}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/;
        if (suffix === null || !pattern.test(value)) throw new Error();
        s.date(`${value}${suffix}T00:00:00.000Z`, '$');
      }
    }
  } catch {throw new DiscoveryError('INVALID_INPUT');}
}

// Full sentences only. Bounded capitalized multi-token names exclude pronouns and URL slugs.
// This is syntax recognition, not person verification; every occurrence requires identity review.
const token = "\\p{Lu}[\\p{L}\\p{M}'’-]{0,39}";
const name = `${token}(?: ${token}){1,3}`;
const relationRules: Array<{phrase: string; predicate: string; kind: RelationshipKind}> = [
  {phrase: 'is a friend of', predicate: 'FRIEND_OF', kind: 'FRIEND'},
  {phrase: 'is a close friend of', predicate: 'CLOSE_FRIEND_OF', kind: 'CLOSE_FRIEND'},
  {phrase: 'is the parent of', predicate: 'PARENT_OF', kind: 'PARENT_OF'},
  {phrase: 'is a coworker of', predicate: 'COWORKER_OF', kind: 'COWORKER'},
  {phrase: 'is a former coworker of', predicate: 'FORMER_COWORKER_OF', kind: 'FORMER_COWORKER'},
  // Collaboration alone does not prove common employment or that a relationship has ended.
  {phrase: 'worked directly with', predicate: 'WORKED_DIRECTLY_WITH', kind: 'UNKNOWN'},
];
const relations = relationRules.map(rule => ({...rule, pattern: new RegExp(`^(${name}) ${rule.phrase} (${name})\\.$`, 'u')}));
const affiliation = new RegExp(`^(${name}) (works at|worked at) (${token}(?: ${token}){0,5})\\.$`, 'u');
// Abstain on the whole document when context could negate, quote or qualify a matched sentence.
// Deliberately conservative: unrelated qualifying language can suppress otherwise valid claims.
const qualified = /["“”«»?`]|\b(?:not|never|no|neither|nor|den(?:y|ies|ied|ial)|false(?:hoods?)?|untrue|rumou?r|alleged|allegedly|reportedly|possibly|perhaps|maybe|might|may|could|would|if|fiction(?:al)?|hypothetical|example|satire|claim(?:s|ed)?|disputed|unverified|incorrect|retracted|fabricated|fake|debunked|suppose|imagine)\b/iu;
// Match ordinary contracted negatives without rewriting source text or its citation offsets.
// ca+n / wo+n / sha+n cover can't, won't and shan't; both apostrophe forms are source data.
const negativeContraction = /\b(?:is|are|was|were|do|does|did|has|have|had|ca|could|wo|would|should|must|need|dare|ai|sha)n['’]t\b/iu;

/** Offline, bounded extraction from exact retrieval text. Unsupported syntax produces no facts.
 * No coreference, same-name linking, reverse edges, closeness scores or willingness inference. */
export function extractPublicDocument(document: RetrievedPublicDocument, maxAssertions = 10): DocumentExtraction {
  validateRetrievedDocument(document);
  if (!Number.isSafeInteger(maxAssertions) || maxAssertions < 1 || maxAssertions > 16) throw new DiscoveryError('INVALID_INPUT');
  const out: DocumentExtraction = {version: EXTRACTION_VERSION, documentId: document.id, documentRevision: document.revision, mentions: [], assertions: [], issues: []};
  if (qualified.test(document.normalizedText) || negativeContraction.test(document.normalizedText)) {out.issues.push('AMBIGUOUS_CONTEXT'); return out;}
  const addMention = (value: string, start: number): string => {
    const excerpt = selectDocumentExcerpt(document, start, start + value.length);
    const id = `mention_${hash([document.id, document.revision, start, value])}`;
    out.mentions.push({id, name: value, excerpt}); return id;
  };
  // A match always consumes the whole sentence, including its punctuation. Clauses and quotations
  // cannot be accepted by selecting a convenient substring from a longer sentence.
  for (const part of document.normalizedText.matchAll(/[^.!?]+[.!?]|[^.!?]+$/gu)) {
    const sentence = part[0].trim(), start = part.index! + part[0].indexOf(sentence);
    if (sentence.length > 500) {if (!out.issues.includes('UNSUPPORTED_TEXT')) out.issues.push('UNSUPPORTED_TEXT'); continue;}
    const rule = relations.find(item => item.pattern.test(sentence));
    const match = rule ? rule.pattern.exec(sentence)! : affiliation.exec(sentence);
    if (!match) {if (!out.issues.includes('UNSUPPORTED_TEXT')) out.issues.push('UNSUPPORTED_TEXT'); continue;}
    if (out.assertions.length >= maxAssertions) {out.issues.push('ASSERTION_LIMIT'); break;}
    const subject = match[1]!, object = rule ? match[2]! : match[3]!;
    if (rule && subject === object) {if (!out.issues.includes('REPEATED_ENDPOINT_NAME')) out.issues.push('REPEATED_ENDPOINT_NAME'); continue;}
    const subjectMentionId = addMention(subject, start);
    const objectStart = start + sentence.length - 1 - object.length;
    const objectMentionId = rule ? addMention(object, objectStart) : null;
    const predicate = rule?.predicate ?? (match[2] === 'works at' ? 'WORKS_AT' : 'WORKED_AT');
    out.assertions.push({id: `assertion_${hash([document.id, start, sentence, predicate])}`,
      kind: rule ? 'RELATIONSHIP' : 'AFFILIATION', subjectMentionId, objectMentionId,
      organization: rule ? null : {id: `org_${hash([document.id, document.revision, objectStart, object])}`, name: object},
      predicate, relationshipKind: rule?.kind ?? null, excerpt: selectDocumentExcerpt(document, start, start + sentence.length),
      assertedPeriod: {start: null, end: null}, current: rule ? null : match[2] === 'works at' ? true : null});
  }
  return out;
}
