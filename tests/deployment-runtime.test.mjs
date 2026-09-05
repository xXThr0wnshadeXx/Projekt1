import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { createProductionHandler, readRuntimeConfig } from '../dist/packages/server/deployment/runtime.js';

test('production config requires canonical HTTPS and pins OAuth callback instead of trusting headers', () => {
  const config = readRuntimeConfig({ NODE_ENV: 'production', APP_ORIGIN: 'https://example.test', PORT: '10000' });
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.googleRedirectUri, 'https://example.test/api/auth/google/callback');
  for (const origin of ['', 'http://example.test', 'http://localhost', 'https://u:p@example.test', 'https://example.test/', 'https://example.test/?x=1']) {
    assert.throws(() => readRuntimeConfig({ NODE_ENV: 'production', APP_ORIGIN: origin }));
  }
  for (const port of ['0', '-1', '65536', '3.5', '3oops']) assert.throws(() => readRuntimeConfig({ PORT: port }));
  assert.throws(() => readRuntimeConfig({ GOOGLE_REDIRECT_URI: 'https://elsewhere.test/callback' }));
  assert.equal(readRuntimeConfig({}).browserOrigin, 'http://127.0.0.1:5173');
});

async function fixture(t, extra = {}) {
  const root = await mkdtemp(join(tmpdir(), 'projekt1-deployment-'));
  const webRoot = join(root, 'web');
  await mkdir(join(webRoot, 'assets'), { recursive: true });
  await writeFile(join(webRoot, 'index.html'), '<html>built app</html>');
  await writeFile(join(webRoot, 'assets/app-12345678.js'), 'export const built = true;');
  await writeFile(join(root, 'private.txt'), 'must not escape');
  await writeFile(join(webRoot, '.env'), 'must not serve');
  await symlink(join(root, 'private.txt'), join(webRoot, 'escape.js'));
  const apiHandler = (request, response) => { response.writeHead(401, { 'Content-Type': 'application/json' }); response.end('{"error":"unauthenticated"}'); };
  const server = createServer(await createProductionHandler({ webRoot, apiHandler, ...extra }));
  await new Promise((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); await rm(root, { recursive: true, force: true }); });
  const port = server.address().port;
  const get = (path, headers = {}, method = 'GET') => new Promise((done, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers, method }, response => {
      let body = ''; response.setEncoding('utf8'); response.on('data', chunk => body += chunk);
      response.on('end', () => done({ status: response.statusCode, body, headers: response.headers }));
    }); req.once('error', reject); req.end();
  });
  return { get };
}

test('same origin serves built entrypoint, navigation and cached assets; API stays API', async t => {
  const { get } = await fixture(t);
  for (const path of ['/', '/network', '/network/person']) {
    const page = await get(path, { accept: 'text/html' });
    assert.equal(page.status, 200); assert.match(page.body, /built app/); assert.equal(page.headers['cache-control'], 'no-store');
  }
  const asset = await get('/assets/app-12345678.js');
  assert.equal(asset.status, 200); assert.match(asset.headers['content-type'], /javascript/); assert.match(asset.headers['cache-control'], /immutable/);
  assert.equal((await get('/api/session', { accept: 'text/html' })).status, 401);
  assert.equal((await get('/api/unknown', { accept: 'text/html' })).body, '{"error":"unauthenticated"}');
  assert.equal((await get('/missing.js', { accept: 'text/html' })).status, 404);
  assert.equal((await get('/assets/missing', { accept: 'text/html' })).status, 404);
  assert.equal((await get('/unknown', { accept: 'application/json' })).status, 404);
  assert.equal((await get('/network', {}, 'POST')).status, 405);
  const head = await get('/assets/app-12345678.js', {}, 'HEAD');
  assert.equal(head.status, 200); assert.equal(head.body, ''); assert.ok(Number(head.headers['content-length']) > 0);
});

test('static routing rejects traversal, malformed paths, dotfiles, source maps and escaped symlinks', async t => {
  const { get } = await fixture(t);
  for (const path of ['/../private.txt', '/%2e%2e/private.txt', '/assets/%2e%2e/.env', '/.env', '/%00', '/%xy', '//outside.test/a', '/a%5cb', '/%2foutside.test']) {
    assert.equal((await get(path, { accept: 'text/html' })).status, 400, path);
  }
  assert.equal((await get('/escape.js')).status, 404);
  assert.equal((await get('/assets/app.js.map', { accept: 'text/html' })).status, 404);
});

test('liveness is separate from readiness and never leaks adapter failures', async t => {
  const { get } = await fixture(t, { readiness: async () => { throw Error('private database credential'); } });
  assert.equal((await get('/api/health')).status, 200);
  const ready = await get('/api/ready');
  assert.equal(ready.status, 503); assert.equal(ready.body, '{"status":"unavailable"}');
});

test('readiness defaults unavailable, supports ready, and bounds a stalled probe', async t => {
  const unset = await fixture(t);
  assert.equal((await unset.get('/api/ready')).status, 503);
  const ready = await fixture(t, { readiness: async () => true });
  assert.equal((await ready.get('/api/ready')).status, 200);
  let signal;
  const stalled = await fixture(t, { readinessTimeoutMs: 25, readiness: async value => { signal = value; await new Promise(() => {}); return true; } });
  assert.equal((await stalled.get('/api/ready')).status, 503);
  assert.equal(signal.aborted, true);
});
