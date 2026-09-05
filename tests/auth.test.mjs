import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import { GoogleAuth, readGoogleAuthConfig } from '../dist/packages/server/auth/google.js';

const config = { clientId: 'unit.apps.googleusercontent.com', clientSecret: 'unit-secret', appOrigin: 'https://app.example.test', redirectUri: 'https://app.example.test/api/auth/google/callback' };
const hash = token => createHash('sha256').update(token).digest('hex');
function fixture() {
  let now = 1_800_000_000_000, claims = {}, failVerification = false, calls = 0;
  const transactions = new Map(), sessions = new Map(), users = new Map();
  const store = {
    async putOAuthTransaction(tx) { transactions.set(tx.stateHash, structuredClone(tx)); },
    async consumeOAuthTransaction(stateHash, bindingHash, at) { const tx = transactions.get(stateHash);
      if (!tx || tx.browserBindingHash !== bindingHash || tx.expiresAt <= at) return null;
      transactions.delete(stateHash); return tx; },
    async upsertGoogleUser(input) { let user = [...users.values()].find(x => x.googleSubject === input.googleSubject);
      if (!user) { user = { userId: `user_${users.size}`, ...input }; users.set(user.userId, user); } return user; },
    async getUser(id) { return users.get(id) ?? null; },
    async listPrivateScopes(userId) { return [{ id: `scope_${userId}`, label: 'My network' }]; },
    async putSession(session) { sessions.set(session.tokenHash, structuredClone(session)); },
    async getSession(tokenHash) { return sessions.get(tokenHash) ?? null; },
    async revokeSession(tokenHash, at) { const session = sessions.get(tokenHash); if (session) session.revokedAt = at; },
  };
  let expectedNonce, expectedVerifier;
  const provider = {
    async exchangeCode(code, verifier) { calls++; assert.equal(code, 'provider-code'); assert.equal(verifier, expectedVerifier); return 'signed-token'; },
    async verifyIdToken(token) { assert.equal(token, 'signed-token'); if (failVerification) throw Error('private provider details');
      return { sub: 'subject_1', iss: 'https://accounts.google.com', aud: config.clientId, exp: now / 1000 + 3600, iat: now / 1000, nonce: expectedNonce, name: 'Unit account', ...claims }; },
  };
  const auth = new GoogleAuth(store, config, { provider, now: () => now });
  async function start() { const result = await auth.start(), url = new URL(result.location);
    const tx = transactions.get(hash(url.searchParams.get('state'))); expectedNonce = tx.nonce; expectedVerifier = tx.codeVerifier;
    return { result, url, params: new URLSearchParams({ state: url.searchParams.get('state'), code: 'provider-code' }), cookie: result.cookies[0].split(';')[0] }; }
  return { auth, store, sessions, transactions, users, start, provider, advance: ms => now += ms, setClaims: value => claims = value,
    failVerification: () => failVerification = true, get calls() { return calls; } };
}
const rejectsAuth = work => assert.rejects(work, e => e.code === 'UNAUTHENTICATED' && e.message === 'UNAUTHENTICATED');
const tokenFrom = result => result.cookies.find(c => c.startsWith('projekt1_session=')).split(';')[0].split('=')[1];

test('start binds state to browser and requests identity only with nonce and S256 PKCE', async () => {
  const f = fixture(), { result, url } = await f.start(), tx = [...f.transactions.values()][0];
  assert.equal(url.origin, 'https://accounts.google.com'); assert.equal(url.searchParams.get('scope'), 'openid profile');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update(tx.codeVerifier).digest('base64url'));
  assert.notEqual(tx.stateHash, url.searchParams.get('state')); assert.match(result.cookies[0], /HttpOnly; SameSite=Lax.*Secure/);
  assert.equal(url.searchParams.has('client_secret'), false);
});
test('callback issues hashed session and same subject reuses account with a new session', async () => {
  const f = fixture(), first = await f.start(), result = await f.auth.callback(first.params, first.cookie), token = tokenFrom(result);
  assert.equal(result.location, `${config.appOrigin}/`); assert.equal(f.sessions.has(token), false); assert.equal(f.sessions.has(hash(token)), true);
  assert.deepEqual(await f.auth.resolveSession(token), { userId: 'user_0' });
  assert.deepEqual(await f.auth.displaySession('user_0'), { actor: { id: 'user_0', displayName: 'Unit account' }, scopes: [{ id: 'scope_user_0', label: 'My network' }] });
  const second = await f.start(), secondResult = await f.auth.callback(second.params, `${second.cookie}; projekt1_session=${token}`);
  assert.equal(f.users.size, 1); assert.notEqual(tokenFrom(secondResult), token); assert.equal(await f.auth.resolveSession(token), null);
});
test('callback rejects wrong browser without consuming legitimate transaction', async () => {
  const f = fixture(), a = await f.start(); await rejectsAuth(f.auth.callback(a.params, `projekt1_oauth=${'x'.repeat(43)}`));
  assert.equal(f.calls, 0); await f.auth.callback(a.params, a.cookie); assert.equal(f.calls, 1);
});
test('callback rejects missing, duplicate and tampered state/cookie values', async () => {
  const f = fixture(), a = await f.start();
  await rejectsAuth(f.auth.callback(a.params));
  await rejectsAuth(f.auth.callback(a.params, `${a.cookie}; ${a.cookie}`));
  const duplicate = new URLSearchParams(a.params); duplicate.append('state', duplicate.get('state'));
  await rejectsAuth(f.auth.callback(duplicate, a.cookie));
  const tampered = new URLSearchParams(a.params); tampered.set('state', 'x'.repeat(43));
  await rejectsAuth(f.auth.callback(tampered, a.cookie)); assert.equal(f.calls, 0);
});
test('transaction is one time across concurrent callback attempts', async () => {
  const f = fixture(), a = await f.start(); const results = await Promise.allSettled([f.auth.callback(a.params, a.cookie), f.auth.callback(a.params, a.cookie)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(f.calls, 1);
});
test('expired transaction cannot exchange code', async () => {
  const f = fixture(), a = await f.start(); f.advance(10 * 60 * 1000); await rejectsAuth(f.auth.callback(a.params, a.cookie)); assert.equal(f.calls, 0);
});
test('denial and ambiguous code consume transaction without provider exchange', async () => {
  for (const mutate of [p => p.set('error', 'access_denied'), p => p.append('code', 'other-code')]) {
    const f = fixture(), a = await f.start(); mutate(a.params); await rejectsAuth(f.auth.callback(a.params, a.cookie));
    assert.equal(f.calls, 0); assert.equal(f.transactions.size, 0);
  }
});
for (const [name, claims] of Object.entries({
  issuer: { iss: 'https://attacker.example' }, audience: { aud: 'other-client' }, authorizedParty: { azp: 'other-client' },
  nonce: { nonce: 'wrong' }, missingNonce: { nonce: undefined }, expired: { exp: 1 }, futureIssued: { iat: 1_800_000_061 },
  invalidSubject: { sub: '' }, invalidExpiry: { exp: NaN },
})) test(`verified-token claims still reject ${name}`, async () => {
  const f = fixture(), a = await f.start(); f.setClaims(claims); await rejectsAuth(f.auth.callback(a.params, a.cookie));
  assert.equal(f.users.size, 0); assert.equal(f.sessions.size, 0); await rejectsAuth(f.auth.callback(a.params, a.cookie)); assert.equal(f.calls, 1);
});
test('failed signature verification is sanitized and cannot create a user', async () => {
  const f = fixture(), a = await f.start(); f.failVerification(); await rejectsAuth(f.auth.callback(a.params, a.cookie)); assert.equal(f.users.size, 0);
});
test('official signature verifier accepts a signed test token and rejects tampered signature, audience, issuer and expiry offline', async () => {
  // Anonymous ephemeral cryptographic test fixture; never used by the application or Google's live key fetcher.
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const verifier = new OAuth2Client(), now = Math.floor(Date.now() / 1000);
  const certs = { unit_key: publicKey.export({ type: 'spki', format: 'pem' }).toString() };
  const jwt = overrides => { const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'unit_key' })).toString('base64url');
    const body = Buffer.from(JSON.stringify({ sub: 'unit_subject', iss: 'https://accounts.google.com', aud: config.clientId, iat: now, exp: now + 3600, ...overrides })).toString('base64url');
    const unsigned = `${header}.${body}`; return `${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`; };
  const verify = token => verifier.verifySignedJwtWithCertsAsync(token, certs, config.clientId, ['https://accounts.google.com']);
  assert.equal((await verify(jwt({}))).getPayload().sub, 'unit_subject');
  const segments = jwt({}).split('.'); segments[2] = `${segments[2][0] === 'A' ? 'B' : 'A'}${segments[2].slice(1)}`;
  await assert.rejects(verify(segments.join('.')), /Invalid token signature/);
  await assert.rejects(verify(jwt({ aud: 'wrong' })), /audience/);
  await assert.rejects(verify(jwt({ iss: 'https://attacker.example' })), /issuer/);
  await assert.rejects(verify(jwt({ iat: now - 4000, exp: now - 1000 })), /too late/);
  await assert.rejects(verify('malformed-token'), /number of segments/);
});
test('session expiry, revocation and deleted account invalidate credentials', async () => {
  const f = fixture(), a = await f.start(), token = tokenFrom(await f.auth.callback(a.params, a.cookie));
  f.advance(24 * 60 * 60 * 1000); assert.equal(await f.auth.resolveSession(token), null);
  const b = await f.start(), token2 = tokenFrom(await f.auth.callback(b.params, b.cookie));
  await f.auth.revokeSession(token2); assert.equal(await f.auth.resolveSession(token2), null);
  const c = await f.start(), token3 = tokenFrom(await f.auth.callback(c.params, c.cookie));
  f.users.clear(); assert.equal(await f.auth.resolveSession(token3), null);
  assert.equal(await f.auth.resolveSession({ userId: 'user_0' }), null);
});
test('missing config fails closed and malformed origins are rejected', async () => {
  assert.equal(readGoogleAuthConfig({}), null);
  const env = { GOOGLE_CLIENT_ID: config.clientId, GOOGLE_CLIENT_SECRET: config.clientSecret, APP_ORIGIN: config.appOrigin, GOOGLE_REDIRECT_URI: config.redirectUri };
  assert.deepEqual(readGoogleAuthConfig(env), config);
  for (const change of [{ APP_ORIGIN: 'http://public.example' }, { GOOGLE_REDIRECT_URI: 'https://attacker.example/callback' }, { GOOGLE_CLIENT_SECRET: '' }, { APP_ORIGIN: `${config.appOrigin}/` }]) {
    assert.throws(() => readGoogleAuthConfig({ ...env, ...change }), e => e.code === 'SOURCE_UNAVAILABLE');
  }
  const f = fixture(), auth = new GoogleAuth(f.store, null);
  await assert.rejects(auth.start(), e => e.code === 'SOURCE_UNAVAILABLE');
  await assert.rejects(auth.callback(new URLSearchParams()), e => e.code === 'SOURCE_UNAVAILABLE');
  assert.equal(await auth.resolveSession('x'.repeat(43)), null);
});
