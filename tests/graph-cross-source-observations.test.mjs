import assert from 'node:assert/strict';
import test from 'node:test';
import { graph, result } from './fixtures.mjs';
import { loadGraph } from './graph-load.mjs';

for (const kind of ['CONNECTED_ON_PLATFORM', 'FOLLOWS']) {
  test(`${kind} observations never become a search route without an approved search edge`, async (t) => {
    const { BoundedRouteSearch, DEFAULT_SEARCH_OPTIONS } = await loadGraph(t);
    const snapshot = graph();
    snapshot.observedLinks[0].kind = kind;
    snapshot.searchEdges = [];

    const response = new BoundedRouteSearch().findBestPaths(
      snapshot,
      result().goal,
      result().targets,
      DEFAULT_SEARCH_OPTIONS,
    );

    assert.deepEqual(response.paths, []);
    assert.equal(response.stats.stop, 'EXHAUSTED_WITHIN_HOP_LIMIT');
    assert.equal(response.stats.expansions, 0);
    assert.ok(!response.events.some((event) => event.type === 'EDGE_EXPLORED'));
  });
}
