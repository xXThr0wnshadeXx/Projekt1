import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function loadGraph(t) {
  const output = mkdtempSync(join(tmpdir(), 'projekt1-graph-'));
  t.after(() => rmSync(output, { recursive: true, force: true }));
  execFileSync(process.execPath, [
    resolve('node_modules/typescript/lib/tsc.js'),
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--strict', '--noUncheckedIndexedAccess', '--exactOptionalPropertyTypes', '--skipLibCheck',
    '--outDir', output, '--rootDir', process.cwd(), resolve('packages/graph/src/index.ts'),
  ], { stdio: 'pipe' });
  writeFileSync(join(output, 'package.json'), '{"type":"module"}');
  return import(pathToFileURL(join(output, 'packages/graph/src/index.js')).href);
}
