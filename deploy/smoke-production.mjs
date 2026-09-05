// Anonymous production integration fixture. Never accepts a database URL or env file.
// Run from repository root after npm run build; PG_BIN names installed PostgreSQL binaries.
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, mkdir, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {createServer} from 'node:net';
import {setTimeout as delay} from 'node:timers/promises';
import {createHash} from 'node:crypto';
import {Pool} from 'pg';
import {PgStore} from '../dist/packages/server/storage/postgres.js';

const exec = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
assert.equal(process.cwd(), root, 'Run from the repository root.');
assert.equal(process.argv.length, 2, 'No URLs, env files, or other arguments are accepted.');
assert.ok(process.env.PG_BIN, 'Set PG_BIN to installed PostgreSQL binaries.');
const pgBin = resolve(process.env.PG_BIN);
// Do not inherit application secrets, PG*, NODE_OPTIONS, or an env-file runner.
const cleanEnv = {PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C'};
// macOS TMPDIR can exceed PostgreSQL's Unix socket path length limit.
const temp = await mkdtemp(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'wp-smoke-'));
const data = join(temp, 'data'), socket = join(temp, 'socket');
const origin = 'https://production-smoke.invalid';
let server, serverExit, pgStarted = false, admin, pool;
let stage = 'setup';
const check = name => console.log(`PASS ${name}`);
async function port() {
  const listener = createServer();
  await new Promise((done, reject) => { listener.once('error', reject); listener.listen(0, '127.0.0.1', done); });
  const value = listener.address().port;
  await new Promise(done => listener.close(done));
  return value;
}
async function pg(command, args) {
  return exec(join(pgBin, command), args, {env: cleanEnv, timeout: 30000, maxBuffer: 1024 * 1024});
}
async function stopServer() {
  if (!server) return;
  const child = server, exited = serverExit;
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const result = await Promise.race([exited, delay(6500, 'timeout')]);
  if (result === 'timeout') { child.kill('SIGKILL'); await exited; throw new Error('Server shutdown exceeded its grace period.'); }
  assert.equal(result, 0, 'Production entrypoint should shut down cleanly.');
  server = undefined;
}
try {
  await readFile(join(root, 'dist/web/index.html'));
  await mkdir(socket);
  const pgPort = await port(), httpPort = await port();
  const base = `http://127.0.0.1:${httpPort}`;
  const databaseUrl = `postgresql://smoke_app@127.0.0.1:${pgPort}/smoke`;
  console.log((await pg('postgres', ['--version'])).stdout.trim());
  await pg('initdb', ['-D', data, '-U', 'smoke_admin', '--auth=trust', '--no-locale', '--encoding=UTF8']);
  // This fresh cluster alone is reachable on loopback, never a pre-existing DB.
  await pg('pg_ctl', ['-D', data, '-l', join(temp, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${pgPort} -k ${socket}`, '-w', 'start']);
  pgStarted = true;
  admin = new Pool({connectionString: `postgresql://smoke_admin@127.0.0.1:${pgPort}/postgres`});
  await admin.query('CREATE ROLE smoke_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');
  await admin.query('CREATE DATABASE smoke OWNER smoke_app');
  await admin.end(); admin = undefined;
  admin = new Pool({connectionString: `postgresql://smoke_admin@127.0.0.1:${pgPort}/smoke`});
  await admin.query('ALTER SCHEMA public OWNER TO smoke_app');
  await admin.query('REVOKE CREATE ON SCHEMA public FROM PUBLIC');
  await admin.end(); admin = undefined;
  pool = new Pool({connectionString: databaseUrl, connectionTimeoutMillis: 1000});
  pool.on('error', () => {}); // Expected when testing this disposable cluster's outage.
  const role = await pool.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user');
  assert.equal(role.rows[0].rolsuper, false);
  const env = {...cleanEnv, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(httpPort),
    APP_ORIGIN: origin, DATABASE_URL: databaseUrl,
    GOOGLE_CLIENT_ID: 'smoke.apps.googleusercontent.com', GOOGLE_CLIENT_SECRET: 'anonymous-test-only',
    GOOGLE_CONTACTS_REDIRECT_URI: `${origin}/api/auth/google/contacts/callback`,
    // Deterministic fixture key, never used for real grants or deployment.
    PROVIDER_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64url')};
  async function request(path, {method = 'GET', token, body, accept = 'application/json', requestOrigin = origin} = {}) {
    const response = await fetch(base + path, {method, redirect: 'manual', signal: AbortSignal.timeout(4000),
      headers: {accept, ...(token ? {cookie: `projekt1_session=${token}`} : {}),
        ...(body ? {'content-type': 'application/json'} : {}), ...(method === 'POST' ? {origin: requestOrigin} : {})},
      ...(body ? {body: JSON.stringify(body)} : {})});
    return {status: response.status, headers: response.headers, body: await response.text()};
  }
  async function startServer() {
    server = spawn(process.execPath, ['dist/packages/server/main.js'], {cwd: root, env, stdio: ['ignore', 'pipe', 'pipe']});
    // Drain without printing config, callback URLs, cookies, or provider responses.
    server.stdout.resume(); server.stderr.resume();
    serverExit = new Promise((done, reject) => { server.once('error', reject); server.once('exit', code => done(code)); });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (server.exitCode !== null) throw new Error('Production startup exited before readiness.');
      try { if ((await request('/api/ready')).status === 200) return; } catch {}
      await delay(100);
    }
    throw new Error('Production startup did not become ready.');
  }
  stage = 'startup and migrations';
  await startServer();
  const migrations = await pool.query('SELECT id,digest FROM app_migrations ORDER BY id');
  assert.deepEqual(migrations.rows.map(row => row.id), ['001_private_storage', '002_contacts_grants']);
  for (const row of migrations.rows) {
    const sql = await readFile(join(root, 'migrations', `${row.id}.sql`));
    assert.equal(row.digest, createHash('sha256').update(sql).digest('hex'));
  }
  assert.equal((await request('/api/health')).status, 200);
  check('actual main.js startup applies 001/002 as non-superuser database owner');

  stage = 'static/API isolation';
  const html = await readFile(join(root, 'dist/web/index.html'), 'utf8');
  for (const path of ['/', '/network/person']) {
    const response = await request(path, {accept: 'text/html'});
    assert.equal(response.status, 200); assert.equal(response.body, html);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const asset = html.match(/src="(\/assets\/[^" ]+\.js)"/)?.[1];
  assert.ok(asset, 'Vite entrypoint should reference a built JS asset.');
  const js = await request(asset);
  assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
  assert.match(js.headers.get('cache-control'), /immutable/);
  const head = await request(asset, {method: 'HEAD'});
  assert.equal(head.status, 200); assert.equal(head.body, '');
  for (const path of ['/api/unknown', '/assets/missing.js', '/network/person', '/migrations/001_private_storage.sql', '/packages/server/main.ts', `${asset}.map`]) {
    const response = await request(path);
    assert.equal(response.status, 404); assert.match(response.headers.get('content-type'), /json/);
  }
  assert.equal((await request('/.env', {accept: 'text/html'})).status, 400);
  const unknownApi = await request('/api/unknown', {accept: 'text/html'});
  assert.equal(unknownApi.status, 404); assert.match(unknownApi.headers.get('content-type'), /json/);
  check('real Vite assets, navigation refresh, HEAD/cache behavior, API and source-file isolation');

  stage = 'anonymous sessions and provider limits';
  // Two anonymous accounts exist ONLY inside this deleted test cluster.
  const store = new PgStore(pool), actors = [];
  for (const [index, token] of ['a'.repeat(43), 'b'.repeat(43)].entries()) {
    const user = await store.upsertGoogleUser({googleSubject: `smoke-${index}`, displayName: `u${index}`});
    const scope = (await store.listPrivateScopes(user.userId))[0];
    const now = Date.now();
    await store.putSession({tokenHash: createHash('sha256').update(token).digest('hex'), userId: user.userId,
      createdAt: now, expiresAt: now + 600000, revokedAt: null});
    actors.push({user, scope, token});
  }
  const [a, b] = actors, graphPath = `/api/graph?scopeId=${a.scope.id}`;
  const body = {scopeId: a.scope.id, expectedGraphVersion: '0', goalText: 'unknown0'};
  assert.equal((await request('/api/session')).status, 401);
  assert.equal((await request(graphPath, {accept: 'text/html'})).status, 401);
  assert.equal((await request('/api/search', {method: 'POST', body})).status, 401);
  assert.equal((await request(graphPath, {token: b.token})).status, 403);
  assert.equal((await request('/api/search', {method: 'POST', token: b.token, body})).status, 403);
  assert.equal((await request('/api/search', {method: 'POST', token: a.token, body, requestOrigin: 'https://other.invalid'})).status, 403);
  const graph = await request(graphPath, {token: a.token}); assert.equal(graph.status, 200);
  assert.equal(JSON.parse(graph.body).people.length, 1);
  const search = await request('/api/search', {method: 'POST', token: a.token, body});
  assert.equal(search.status, 200); assert.deepEqual(JSON.parse(search.body).paths, []);
  assert.equal(JSON.parse(search.body).stats.stop, 'NO_TARGETS');
  check('signed-out 401, other-owner/origin 403, actual graph engine honest empty result');
  // Do not follow either authorization URL; no external Google request is made.
  const login = await request('/api/auth/google/start');
  assert.equal(login.status, 302);
  assert.equal(new URL(login.headers.get('location')).searchParams.get('redirect_uri'), `${origin}/api/auth/google/callback`);
  assert.match(login.headers.get('set-cookie'), /HttpOnly; SameSite=Lax;.*Secure/);
  const consent = await request('/api/auth/google/contacts/start', {method: 'POST', token: a.token, body: {scopeId: a.scope.id}});
  assert.equal(consent.status, 200);
  assert.equal(new URL(JSON.parse(consent.body).authorizationUrl).searchParams.get('redirect_uri'), env.GOOGLE_CONTACTS_REDIRECT_URI);
  assert.match(consent.headers.get('set-cookie'), /HttpOnly; SameSite=Lax;.*Secure/);
  const unavailable = await request('/api/imports/google', {method: 'POST', token: a.token,
    body: {scopeId: a.scope.id, sourceId: 'unavailable0', expectedGraphVersion: '0', idempotencyKey: 'k0'}});
  assert.equal(unavailable.status, 502); assert.equal(JSON.parse(unavailable.body).error.code, 'SOURCE_UNAVAILABLE');
  assert.equal((await request('/api/ready')).status, 200);
  check('HTTPS callback/Secure-cookie configuration; readiness 200 with unavailable retrieval 502');

  stage = 'restart, migration replay, and logout';
  await stopServer(); await startServer();
  assert.deepEqual((await pool.query('SELECT id,digest FROM app_migrations ORDER BY id')).rows, migrations.rows);
  assert.equal((await request(graphPath, {token: a.token})).body, graph.body);
  const logout = await request('/api/auth/logout', {method: 'POST', token: a.token});
  assert.equal(logout.status, 204); assert.match(logout.headers.get('set-cookie'), /Max-Age=0; Secure/);
  assert.equal((await request(graphPath, {token: a.token})).status, 401);
  check('restart retains fixture/session, migrations replay once, logout revokes access');

  stage = 'database outage';
  await pool.end(); pool = undefined;
  await pg('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); pgStarted = false;
  const ready = await request('/api/ready');
  assert.equal(ready.status, 503); assert.deepEqual(JSON.parse(ready.body), {status: 'unavailable'});
  assert.equal((await request('/api/health')).status, 200);
  check('database outage gives readiness 503 while liveness stays 200');
  await stopServer();
  console.log('PASS production smoke; local fixture only, no live OAuth/import/container/Render acceptance');
} catch (error) {
  // Fixture-only assertions can be printed; avoid dumping driver/child env objects.
  console.error(`FAIL ${stage}: ${error instanceof assert.AssertionError ? error.message : 'fixture operation failed'}`);
  process.exitCode = 1;
} finally {
  try { await stopServer(); } catch { process.exitCode = 1; }
  await pool?.end(); await admin?.end();
  if (pgStarted) {
    try { await pg('pg_ctl', ['-D', data, '-m', 'fast', '-w', 'stop']); }
    catch { console.error('Temporary PostgreSQL stop failed; fixture directory retained.'); process.exitCode = 1; }
  }
  // Do not remove a cluster whose process may still be running.
  try { await readFile(join(data, 'postmaster.pid')); }
  catch { await rm(temp, {recursive: true, force: true}); }
}
