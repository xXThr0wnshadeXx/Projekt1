import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

const repo = process.cwd();
const timestamp = '2026-09-05T00:00:00.000Z';

async function loadResolver(t) {
  const output = mkdtempSync(join(tmpdir(), 'projekt1-targets-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  execFileSync(process.execPath, [
    resolve(repo, 'node_modules/typescript/lib/tsc.js'),
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes',
    '--outDir', output, '--rootDir', repo,
    resolve(repo, 'contracts/index.ts'),
    resolve(repo, 'packages/graph/src/targets.ts'),
  ], { cwd: repo, stdio: 'pipe' });
  return import(pathToFileURL(join(output, 'packages/graph/src/targets.js')).href);
}

function affiliation(current) {
  return {
    organizationId: 'org-1', current,
    support: { value: true, confidence: 1, evidenceIds: ['affiliation-evidence'], state: 'CONFIRMED' },
  };
}

function person(id, affiliations = []) {
  return { id, displayName: id, aliases: [], identityIds: [], affiliations, identityConfidence: 1, updatedAt: timestamp };
}

function snapshot(people) {
  return {
    schemaVersion: 1, scopeId: 'scope-1', graphVersion: 'graph-1', rootPersonId: 'root', people,
    identities: [], organizations: [{ id: 'org-1', name: 'Organization One' }], observedLinks: [], relationships: [], searchEdges: [],
    evidence: [{ id: 'affiliation-evidence', sourceId: 'source-1', summary: 'Confirmed affiliation.', observedAt: timestamp, confidence: 1, claimKind: 'AFFILIATION' }],
    sources: [{ id: 'source-1', provider: 'MANUAL', label: 'Approved source', origin: 'USER_PROVIDED', importedAt: timestamp }],
    coverage: { completeForAuthorizedSources: true, omittedNodeCount: 0, warnings: [] },
  };
}

const goal = { id: 'goal-1', text: 'Organization One', organizationIds: ['org-1'], roles: [], locations: [], industries: [], unsupportedConstraints: [] };

test('target resolver selects a current, confirmed, evidence-backed affiliation', async (t) => {
  const { resolveEvidenceBackedTargets } = await loadResolver(t);
  const targets = resolveEvidenceBackedTargets(snapshot([
    person('root'), person('former', [affiliation(false)]), person('current', [affiliation(true)]),
  ]), goal);
  assert.deepEqual(targets.map((target) => target.personId), ['current']);
  assert.equal(targets[0]?.criteria[0]?.status, 'MATCHED');
});

test('target resolver returns no target for former or unknown affiliations', async (t) => {
  const { resolveEvidenceBackedTargets } = await loadResolver(t);
  const targets = resolveEvidenceBackedTargets(snapshot([
    person('root'), person('former', [affiliation(false)]), person('unknown', [affiliation(null)]),
  ]), goal);
  assert.deepEqual(targets, []);
});
