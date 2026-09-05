import assert from 'node:assert/strict';
import test from 'node:test';
import { graph, result, authority } from './fixtures.mjs';
import { validateGraphSnapshot, validateSearchResult } from '../dist/contracts/validation.js';
import { loadGraph } from './graph-load.mjs';

test('zero-relevance targets remain visible in an exhausted result accepted by the backend', async (t) => {
  const { BoundedRouteSearch, DEFAULT_SEARCH_OPTIONS } = await loadGraph(t);
  const snapshot = graph();
  validateGraphSnapshot(snapshot, authority);
  const targets = [{ ...result().targets[0], relevance: 0 }];
  const response = new BoundedRouteSearch().findBestPaths(snapshot, result().goal, targets, DEFAULT_SEARCH_OPTIONS);
  validateSearchResult(response, snapshot);
  assert.deepEqual(response.targets, targets);
  assert.deepEqual(response.paths, []);
  assert.equal(response.stats.stop, 'EXHAUSTED_WITHIN_HOP_LIMIT');
  assert.equal(response.stats.expansions, 0);
  assert.deepEqual(response.events.map(e => [e.type, e.seq]), [['SEARCH_STARTED', 0], ['SEARCH_COMPLETED', 1]]);
  assert.deepEqual(response.events.at(-1).stats, response.stats);
  const empty = new BoundedRouteSearch().findBestPaths(snapshot, result().goal, [], DEFAULT_SEARCH_OPTIONS);
  validateSearchResult(empty, snapshot);
  assert.equal(empty.stats.stop, 'NO_TARGETS');
});
