import type {GraphSnapshot, OpportunityPath, SearchEngine} from '../../../contracts/index.js';
import {FACT_WARNINGS} from './postgres.js';

/** Composition-only decorator: retain the installed engine, rankings, scores and trace ordering. */
export function withFactWarnings(engine: SearchEngine): SearchEngine {
  return {findBestPaths(snapshot, goal, targets, options) {
    const result = structuredClone(engine.findBestPaths(snapshot, goal, targets, options));
    const manualEvidence = ownerAttestations(snapshot);
    const annotate = (path: OpportunityPath) => {
      if (!path.explanation.evidenceIds.some(id => manualEvidence.has(id))) return;
      path.explanation.uncertainties = [...new Set([...path.explanation.uncertainties, ...FACT_WARNINGS])];
    };
    result.paths.forEach(annotate);
    for (const event of result.events) if (event.type === 'PATH_CANDIDATE') annotate(event.path);
    if (manualEvidence.size) result.warnings = [...new Set([...result.warnings, ...FACT_WARNINGS])];
    return result;
  }};
}

function ownerAttestations(graph: GraphSnapshot): Set<string> {
  const sources = new Set(graph.sources.filter(s => s.provider === 'MANUAL' && s.origin === 'USER_PROVIDED').map(s => s.id));
  return new Set(graph.evidence.filter(e => sources.has(e.sourceId)).map(e => e.id));
}
