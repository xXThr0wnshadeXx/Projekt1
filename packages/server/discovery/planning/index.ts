import {DiscoveryError, type SearchHit} from '../contracts.js';
import {selectDocumentExcerpt, type RetrievedPublicDocument} from '../document-fetch.js';
import {abortable} from '../providers/http.js';
import {canonicalPublicUrl, canonicalQuery, discoverExploratoryCandidates, expansionQueries,
  fallbackQueries, initialQueries, validatePlanningInput} from './queries.js';
import type {ExploratoryCandidate, PlannedQuery, PlanningBudget, PlanningExtraction, PlanningInput,
  PlanningOutput, PlanningPorts, PlanningStop} from './types.js';
import {validatePlanningExtraction} from './validation.js';
export * from './types.js';
export {canonicalPublicUrl, canonicalQuery, discoverExploratoryCandidates} from './queries.js';

export const DEFAULT_PLANNING_BUDGET: Readonly<PlanningBudget> = Object.freeze({
  maxSearches: 4, maxRetainedHits: 8, maxDocumentAttempts: 5, collectionMs: 30000,
});
function limits(overrides: Partial<PlanningBudget>): PlanningBudget {
  const result = {...DEFAULT_PLANNING_BUDGET};
  for (const key of Object.keys(result) as Array<keyof PlanningBudget>) {
    const value = overrides[key] ?? result[key];
    if (!Number.isSafeInteger(value) || value < (key === 'collectionMs' ? 1 : 0)) throw new DiscoveryError('INVALID_INPUT');
    result[key] = Math.min(value, result[key]);
  }
  return result;
}

/** Stateless, two-frontier PUBLIC collection. No authentication, persistence, identity resolution,
 * graph mutation or route ranking. Composition MUST authorize before this call and recheck session,
 * scope, selected-public-context, source policy and graph version before returning/staging results.
 * Injected ports must enforce public transport/robots restrictions and honor AbortSignal. */
export function createDiscoveryPlanner(ports: PlanningPorts, overrides: Partial<PlanningBudget> = {}) {
  const budget = limits(overrides);
  return {async collect(input: PlanningInput, parentSignal = new AbortController().signal): Promise<PlanningOutput> {
    const validated = validatePlanningInput(input), start = performance.now();
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), budget.collectionMs);
    const signal = AbortSignal.any([parentSignal, deadline.signal]);
    const queries: PlanningOutput['queries'] = [], hits: SearchHit[] = [], documents: RetrievedPublicDocument[] = [];
    const extractions: PlanningOutput['extractions'] = [], candidates: ExploratoryCandidate[] = [];
    const issues: PlanningOutput['issues'] = [];
    const queryKeys = new Set<string>(), hitKeys = new Set<string>(), attemptedUrls = new Set<string>();
    const seenDocuments = new Set<string>();
    let documentAttempts = 0, extractionAttempts = 0, exhausted = false;
    let stop: PlanningStop = 'COMPLETED';
    const stopped = () => {
      if (parentSignal.aborted) stop = 'CANCELLED';
      else if (deadline.signal.aborted || performance.now() - start >= budget.collectionMs) {
        stop = 'DEADLINE'; deadline.abort();
      }
      return stop !== 'COMPLETED';
    };
    const failure = (stage: 'SEARCH'|'DOCUMENT'|'EXTRACTION', error: unknown) => {
      stopped();
      const code = stop === 'CANCELLED' || stop === 'DEADLINE' ? stop :
        error instanceof DiscoveryError ? error.code : 'SOURCE_UNAVAILABLE';
      if (code === 'CANCELLED') stop = 'CANCELLED';
      issues.push({stage, code});
      return code;
    };
    const search = async (plan: PlannedQuery, retainedLimit: number) => {
      if (stopped()) return;
      const query = canonicalQuery(plan.query);
      if (!query || query.length > 600 || /[\u0000-\u001f\u007f]/.test(query)) {
        issues.push({stage:'PLANNING', code:'QUERY_TOO_LONG_OR_INVALID'}); return;
      }
      if (queryKeys.has(query)) return;
      if (queries.length >= budget.maxSearches) {exhausted = true; return;}
      queryKeys.add(query);
      const attempt: PlanningOutput['queries'][number] = {...plan, query, outcome:'FAILED'};
      queries.push(attempt); // Count before invoking, including synchronous throws and aborted work.
      try {
        const returned = await abortable(ports.provider.search(query, signal), signal);
        if (stopped()) {attempt.outcome = stop === 'CANCELLED' ? 'CANCELLED' : 'DEADLINE'; return;}
        if (!Array.isArray(returned) || returned.length > 20) throw new DiscoveryError('SOURCE_UNAVAILABLE');
        attempt.outcome = 'SUCCEEDED';
        for (const hit of returned) {
          if (!hit || hit.evidenceStatus !== 'DISCOVERY_HINT' || hit.provider !== ports.provider.kind ||
            typeof hit.title !== 'string' || hit.title.length > 1200 || typeof hit.snippet !== 'string' || hit.snippet.length > 1200) {
            issues.push({stage:'SEARCH',code:'INVALID_HIT'}); continue;
          }
          let url: string;
          try {url = canonicalPublicUrl(hit.url);} catch {issues.push({stage:'SEARCH',code:'INVALID_HIT'}); continue;}
          if (hitKeys.has(url)) continue;
          if (hits.length >= retainedLimit) {exhausted = true; continue;}
          hitKeys.add(url); hits.push({...hit, url});
        }
      } catch (error) {
        const code = failure('SEARCH', error);
        attempt.outcome = code === 'CANCELLED' || code === 'DEADLINE' ? code : 'FAILED';
        // Existing providers collapse HTTP 403/429 into ACCESS_DENIED. Stop on every
        // search error rather than retrying a possibly exhausted/denied provider.
        if (stop === 'COMPLETED') stop = 'PROVIDER_STOPPED';
      }
    };
    const read = async (urls: string[], attemptLimit: number) => {
      for (const raw of urls) {
        if (stopped()) return;
        let url: string;
        try {url = canonicalPublicUrl(raw);} catch {issues.push({stage:'DOCUMENT',code:'INVALID_INPUT'}); continue;}
        if (attemptedUrls.has(url)) continue;
        if (documentAttempts >= attemptLimit) {exhausted = true; return;}
        attemptedUrls.add(url); documentAttempts++;
        let doc: RetrievedPublicDocument;
        try {
          doc = structuredClone(await abortable(ports.documents.fetch(url, signal), signal));
          if (stopped()) return;
          if (canonicalPublicUrl(doc.sourceUrl) !== url || typeof doc.normalizedText !== 'string' ||
            Buffer.byteLength(doc.normalizedText, 'utf8') > 1024 * 1024) throw new DiscoveryError('INVALID_INPUT');
          selectDocumentExcerpt(doc,0,Math.min(doc.normalizedText.length,500)); // Verify text digest before extraction.
          const fetched = canonicalPublicUrl(doc.fetchedUrl), key = JSON.stringify([fetched, doc.revision]);
          attemptedUrls.add(fetched);
          if (seenDocuments.has(key)) continue;
          seenDocuments.add(key); documents.push(structuredClone(doc));
        } catch (error) {failure('DOCUMENT', error); continue;}
        if (stopped()) return;
        extractionAttempts++;
        try {
          // A clone prevents an extractor from changing the revision/text that we verify.
          const raw: PlanningExtraction = await abortable(ports.extraction.extract(structuredClone(doc), signal), signal);
          if (stopped()) return;
          const output = validatePlanningExtraction(raw,doc);
          // Full proposal semantic/schema checks belong to extractor and staging. The
          // planner validates the narrower citation proof needed to spend a query.
          const discovered = discoverExploratoryCandidates(doc, output);
          extractions.push({documentId:doc.id, documentRevision:doc.revision, output:structuredClone(output)});
          for (const candidate of discovered) if (candidates.length < 8 &&
            !candidates.some(c => c.sourceIdentity.platform === candidate.sourceIdentity.platform && c.sourceIdentity.externalId === candidate.sourceIdentity.externalId) &&
            (!candidate.profileUrl || (!Object.values(validated.request.anchors).includes(candidate.profileUrl) &&
            (!validated.request.target.profileUrl || canonicalPublicUrl(validated.request.target.profileUrl) !== candidate.profileUrl)))) {
            candidates.push(candidate);
          }
        } catch (error) {failure('EXTRACTION', error);}
      }
    };
    try {
      if (!stopped() && !ports.provider.configured) {
        issues.push({stage:'SEARCH',code:'NOT_CONFIGURED'}); stop = 'NOT_CONFIGURED';
      }
      if (!stopped()) {
        const initialHitLimit = Math.ceil(budget.maxRetainedHits / 2);
        const initialDocumentLimit = budget.maxDocumentAttempts - Math.min(2, Math.floor(budget.maxDocumentAttempts / 2));
        for (const [index, query] of initialQueries(validated).entries()) {
          // Reserve initial hit space for both social anchors instead of letting the
          // first provider response fill the entire initial pool.
          await search(query,index === 0 ? Math.ceil(initialHitLimit / 2) : initialHitLimit);
        }
        await read([...(validated.request.selectedPublicUrls ?? []), ...hits.map(h => h.url)], initialDocumentLimit);
        // Freeze frontier after initial document extraction: no recursive/unrestricted crawl.
        const key = (c: ExploratoryCandidate) => c.profileUrl ?? `${c.mention}\u0000${c.sourceIdentity.externalId}`;
        const frontier = [...candidates].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
        const initialHitCount = hits.length;
        for (const query of [...expansionQueries(validated, frontier), ...fallbackQueries(validated)]) {
          if (queries.length >= budget.maxSearches || stopped()) break;
          await search(query, budget.maxRetainedHits);
        }
        // Expansion pages go first so initial sources cannot consume their reserved attempts.
        await read([...hits.slice(initialHitCount).map(h => h.url),
          ...(validated.request.selectedPublicUrls ?? []), ...hits.slice(0, initialHitCount).map(h => h.url)], budget.maxDocumentAttempts);
      }
      stopped();
      exhausted ||= (stop as PlanningStop) === 'DEADLINE' || queries.length >= budget.maxSearches || documentAttempts >= budget.maxDocumentAttempts;
      const proposalCount = extractions.reduce((sum, e) => sum + e.output.proposals.length, 0);
      const limitations = [
        'Public collection is incomplete; profile anchors are owner assertions, not verified platform ownership.',
        'Search hits and exploratory candidates are hints, not confirmed people, relationships, or introduction paths.',
        'Claims remain unreviewed and unpersisted; authorized identity review and graph projection are separate steps.',
      ];
      if (!proposalCount) limitations.push('No extracted public claims were available; there is insufficient evidence to establish a route.');
      if (!candidates.length) limitations.push('No precisely cited identity or attributed interpersonal assertion supported expansion; names alone are not expanded.');
      if (exhausted) limitations.push('Collection limits were reached or results omitted to preserve the second-frontier budget.');
      if (stop !== 'COMPLETED') limitations.push(`Collection stopped: ${stop}.`);
      if (issues.length) limitations.push('Some sources or extraction attempts were unavailable, blocked, invalid, or unsupported.');
      if (ports.provider.kind === 'WIKIMEDIA') limitations.push('Wikimedia-only coverage cannot enumerate LinkedIn connections or Instagram followers.');
      return {status:proposalCount ? 'UNREVIEWED_PUBLIC_EVIDENCE' : 'INSUFFICIENT_PUBLIC_EVIDENCE', stop,
        queries, hits, documents, extractions, candidates, issues, limitations,
        budget:{...budget, searchesAttempted:queries.length, documentAttempts, extractionAttempts,
          retainedHits:hits.length, elapsedMs:Math.ceil(performance.now() - start), exhausted}, persistence:'NOT_PERFORMED'};
    } finally {clearTimeout(timer);}
  }};
}
