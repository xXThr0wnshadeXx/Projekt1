import type { GraphSnapshot } from '../../contracts/index';

export interface GraphViewportProps {
  /** An actor-authorized, server-provided graph. */
  snapshot: GraphSnapshot | null;
}

/** Stable integration point for the future graph renderer. */
export function GraphViewport({ snapshot }: GraphViewportProps) {
  if (snapshot === null) {
    return (
      <section className="graph-viewport graph-viewport-empty" aria-labelledby="graph-empty-title">
        <p className="graph-kicker">YOUR PRIVATE GRAPH</p>
        <h2 id="graph-empty-title">Your graph is ready when you are.</h2>
        <p>Connect or import data you are authorized to use. WarmPath will only show relationships supported by that data.</p>
        <p className="graph-status" role="status">No people, relationships, or introduction routes are loaded yet.</p>
      </section>
    );
  }

  return (
    <section className="graph-viewport" aria-label="Authorized relationship graph">
      <p className="graph-kicker">YOUR PRIVATE GRAPH</p>
      <p className="graph-status" role="status">An authorized graph snapshot is available for rendering.</p>
    </section>
  );
}
