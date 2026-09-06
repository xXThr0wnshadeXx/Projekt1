import type {OpportunityPath, SearchEngine} from '../../../contracts/index.js';
import {PUBLIC_REVIEW_WARNINGS} from './acceptance.js';

/** Composition decorator only: retain the existing engine, ranking, factors, and trace order. */
export function withPublicCitationWarnings(engine: SearchEngine): SearchEngine {
  return {findBestPaths(snapshot, goal, targets, options) {
    const result = structuredClone(engine.findBestPaths(snapshot, goal, targets, options));
    const sources = new Set(snapshot.sources.filter(s => s.origin === 'PUBLIC_SOURCE').map(s => s.id));
    const evidence = new Set(snapshot.evidence.filter(e => sources.has(e.sourceId)).map(e => e.id));
    const annotate = (path: OpportunityPath) => {
      if (path.explanation.evidenceIds.some(id => evidence.has(id)))
        path.explanation.uncertainties = [...new Set([...path.explanation.uncertainties, ...PUBLIC_REVIEW_WARNINGS])];
    };
    result.paths.forEach(annotate);
    for (const event of result.events) if (event.type === 'PATH_CANDIDATE') annotate(event.path);
    if (evidence.size) result.warnings = [...new Set([...result.warnings, ...PUBLIC_REVIEW_WARNINGS])];
    return result;
  }};
}
