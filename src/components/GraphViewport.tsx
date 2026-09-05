import type { GraphSnapshot, OpportunityPath } from '../../contracts/index';

export interface GraphViewportProps {
  /** An actor-authorized, server-provided graph. */
  snapshot: GraphSnapshot | null;
  selectedPaths?: OpportunityPath[];
  loading?: boolean;
  error?: string;
  activePersonIds?: string[];
}

type PositionedPerson = { id: string; name: string; x: number; y: number };

function positionPeople(snapshot: GraphSnapshot): PositionedPerson[] {
  const total = snapshot.people.length;
  return snapshot.people.map((person, index) => {
    const angle = (Math.PI * 2 * index / Math.max(total, 1)) - Math.PI / 2;
    return { id: person.id, name: person.displayName, x: 50 + Math.cos(angle) * 38, y: 50 + Math.sin(angle) * 35 };
  });
}

function lineFor(positions: Map<string, PositionedPerson>, fromPersonId: string, toPersonId: string) {
  const from = positions.get(fromPersonId);
  const to = positions.get(toPersonId);
  return from && to ? { from, to } : null;
}

/** Renders only graph facts and selected server routes supplied by the API. */
export function GraphViewport({ snapshot, selectedPaths = [], loading = false, error, activePersonIds = [] }: GraphViewportProps) {
  if (loading) return <section className="graph-viewport graph-viewport-empty" aria-busy="true"><p className="graph-kicker">YOUR PRIVATE GRAPH</p><h2>Loading your authorized graph.</h2><p className="graph-status" role="status">Requesting the latest graph snapshot…</p></section>;
  if (error) return <section className="graph-viewport graph-viewport-empty"><p className="graph-kicker">YOUR PRIVATE GRAPH</p><h2>We couldn’t load this graph.</h2><p className="graph-status" role="alert">{error}</p></section>;
  if (snapshot === null) {
    return (
      <section className="graph-viewport graph-viewport-empty" aria-labelledby="graph-empty-title">
        <p className="graph-kicker">YOUR PRIVATE GRAPH</p>
        <h2 id="graph-empty-title">Your graph is ready when you are.</h2>
        <p>Connect or import data you are authorized to use. WarmPath will only show relationships supported by that data.</p>
        <p className="graph-status" role="status">No authorized scope or graph snapshot is loaded yet.</p>
      </section>
    );
  }

  const people = positionPeople(snapshot);
  const positions = new Map(people.map((person) => [person.id, person]));
  const selectedEdgeIds = new Set(selectedPaths.flatMap((path) => path.edgeIds));
  const selectedRouteEdges = snapshot.searchEdges.filter((edge) => selectedEdgeIds.has(edge.id));
  const selectedPeople = new Set(selectedPaths.flatMap((path) => path.personIds));
  const activePeople = new Set(activePersonIds);
  const relationshipLines = snapshot.relationships.map((relationship) => ({ relationship, line: lineFor(positions, relationship.fromPersonId, relationship.toPersonId) })).filter((item) => item.line !== null);
  const observedLines = snapshot.observedLinks.map((link) => ({ link, line: lineFor(positions, link.fromPersonId, link.toPersonId) })).filter((item) => item.line !== null);

  return <section className="graph-viewport graph-viewport-loaded" aria-labelledby="graph-title">
    <div className="graph-header"><div><p className="graph-kicker">YOUR PRIVATE GRAPH</p><h2 id="graph-title">Authorized relationship graph</h2></div><p className="graph-summary">{snapshot.people.length} people · {snapshot.relationships.length} relationships · {snapshot.observedLinks.length} observed links</p></div>
    <svg className="graph-canvas" viewBox="0 0 100 100" role="img" aria-label={`Graph with ${snapshot.people.length} people, ${snapshot.relationships.length} relationships, and ${snapshot.observedLinks.length} observed links`}>
      <g className="graph-observed-links">{observedLines.map(({ link, line }) => <line key={link.id} x1={line!.from.x} y1={line!.from.y} x2={line!.to.x} y2={line!.to.y} />)}</g>
      <g className="graph-relationships">{relationshipLines.map(({ relationship, line }) => <line key={relationship.id} x1={line!.from.x} y1={line!.from.y} x2={line!.to.x} y2={line!.to.y} />)}</g>
      <g className="graph-selected-routes">{selectedRouteEdges.map((edge) => { const line = lineFor(positions, edge.fromPersonId, edge.toPersonId); return line ? <line key={edge.id} x1={line.from.x} y1={line.from.y} x2={line.to.x} y2={line.to.y} /> : null; })}</g>
      <g className="graph-people">{people.map((person) => <g key={person.id} className={`${selectedPeople.has(person.id) ? 'is-selected' : ''} ${activePeople.has(person.id) ? 'is-active' : ''}`}><circle cx={person.x} cy={person.y} r="2.8" /><text x={person.x} y={person.y + 6}>{person.name}</text></g>)}</g>
    </svg>
    <div className="graph-facts" aria-label="Graph facts">
      <details><summary>Relationships ({snapshot.relationships.length})</summary><ul>{snapshot.relationships.map((relationship) => <li key={relationship.id}>{snapshot.people.find((person) => person.id === relationship.fromPersonId)?.displayName ?? 'Unknown person'} — {relationship.kind.replaceAll('_', ' ').toLowerCase()} — {snapshot.people.find((person) => person.id === relationship.toPersonId)?.displayName ?? 'Unknown person'} ({relationship.state.toLowerCase()})</li>)}</ul></details>
      <details><summary>Observed links ({snapshot.observedLinks.length})</summary><ul>{snapshot.observedLinks.map((link) => <li key={link.id}>{snapshot.people.find((person) => person.id === link.fromPersonId)?.displayName ?? 'Unknown person'} — {link.kind.replaceAll('_', ' ').toLowerCase()} — {snapshot.people.find((person) => person.id === link.toPersonId)?.displayName ?? 'Unknown person'}</li>)}</ul></details>
    </div>
    {snapshot.coverage.warnings.length > 0 && <p className="graph-warning" role="status">{snapshot.coverage.warnings.join(' ')}</p>}
  </section>;
}
