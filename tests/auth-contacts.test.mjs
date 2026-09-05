import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { GoogleContacts, CONTACTS_SCOPE, readGoogleContactsConfig } from '../dist/packages/server/auth/contacts.js';
import { createContactsProvider, parseContactsTokens, ContactsGrantRejected } from '../dist/packages/server/auth/contacts-provider.js';
import { ProviderTokenCipher } from '../dist/packages/server/auth/token-cipher.js';

const key = randomBytes(32).toString('base64url');
const config = { clientId: 'unit.apps.googleusercontent.com', clientSecret: 'test-client-secret', appOrigin: 'https://app.example.test',
  redirectUri: 'https://app.example.test/api/auth/google/contacts/callback', encryptionKey: key };
const credential = 'a'.repeat(43), secondCredential = 'b'.repeat(43), sameUserOtherSession = 'c'.repeat(43);
const hash = value => createHash('sha256').update(value).digest('hex');
const rejection = work => assert.rejects(work, e => ['UNAUTHENTICATED', 'FORBIDDEN', 'SOURCE_UNAVAILABLE', 'VERSION_CONFLICT'].includes(e.code));
function fixture() {
  let now = 1_800_000_000_000, nonce, expectedVerifier, failRefresh, exchangeCalls = 0, refreshCalls = 0;
  let claims = {}, tokens = {}, refreshTokens = {}, refreshHook = async () => {}, verifyHook = async () => {};
  const transactions = new Map(), grants = new Map(), disabledSources = new Set();
  const sessions = new Map([[credential, 'u1'], [secondCredential, 'u2'], [sameUserOtherSession, 'u1']]);
  const users = new Map([['u1', { userId: 'u1', googleSubject: 'g1', displayName: 'Unit 1' }], ['u2', { userId: 'u2', googleSubject: 'g2', displayName: 'Unit 2' }]]);
  const auth = { async resolveSession(token) { return sessions.has(token) ? { userId: sessions.get(token) } : null; } };
  const userStore = { async getUser(id) { return users.get(id) ?? null; }, async listPrivateScopes(userId) { return [{ id: `s_${userId}`, label: 'My network' }]; } };
  const store = {
    async putContactsTransaction(tx) { transactions.set(tx.stateHash, structuredClone(tx)); },
    async consumeContactsTransaction(input) {
      const tx = transactions.get(input.stateHash); if (!tx || tx.browserBindingHash !== input.browserBindingHash || tx.sessionHash !== input.sessionHash || tx.actorUserId !== input.actorUserId || tx.expiresAt <= input.now) return null;
      transactions.delete(input.stateHash); return tx;
    },
    async commitContactsGrant(grant, sessionHash) { assert.ok([...sessions].some(([token, owner]) => hash(token) === sessionHash && owner === grant.ownerUserId)); assert.equal(grant.scopeId, `s_${grant.ownerUserId}`); assert.equal(grant.googleSubject, users.get(grant.ownerUserId).googleSubject);
      grants.set(grant.sourceId, structuredClone(grant)); disabledSources.delete(grant.sourceId); },
    async getContactsGrant(ownerUserId, sourceId) { const grant = grants.get(sourceId); return grant?.ownerUserId === ownerUserId && !disabledSources.has(sourceId) ? structuredClone(grant) : null; },
    async replaceContactsGrant(grant, expectedVersion) { const old = grants.get(grant.sourceId);
      if (!old || old.ownerUserId !== grant.ownerUserId || old.version !== expectedVersion || old.revokedAt !== null || disabledSources.has(grant.sourceId)) return false;
      grants.set(grant.sourceId, structuredClone(grant)); return true; },
    async revokeContactsGrant(ownerUserId, sourceId, expectedVersion, at) { const old = grants.get(sourceId);
      if (!old || old.ownerUserId !== ownerUserId || old.version !== expectedVersion) return false; old.revokedAt = at; return true; },
  };
  const provider = {
    async exchangeCode(code, verifier) { exchangeCalls++; assert.equal(code, 'test-code'); assert.equal(verifier, expectedVerifier);
      return { accessToken: 'test-access', expiresIn: 3600, scopes: ['openid', CONTACTS_SCOPE], refreshToken: 'test-refresh', refreshExpiresIn: 7200, idToken: 'test-id', ...tokens }; },
    async verifyIdToken(id) { assert.equal(id, 'test-id'); await verifyHook(); return { sub: 'g1', iss: 'https://accounts.google.com', aud: config.clientId, iat: now / 1000, exp: now / 1000 + 3600, nonce, ...claims }; },
    async refresh(token) { refreshCalls++; assert.equal(token, 'test-refresh'); await refreshHook(); if (failRefresh) throw failRefresh;
      return { accessToken: 'test-fresh-access', expiresIn: 3600, scopes: null, refreshToken: null, refreshExpiresIn: null, idToken: null, ...refreshTokens }; },
  };
  const contacts = new GoogleContacts(auth, userStore, store, config, { provider, now: () => now });
  async function start() { const result = await contacts.start(credential, 's_u1'), url = new URL(result.location), tx = transactions.get(hash(url.searchParams.get('state')));
    nonce = tx.nonce; expectedVerifier = tx.codeVerifier;
    return { result, url, tx, params: new URLSearchParams({ state: url.searchParams.get('state'), code: 'test-code' }),
      cookies: `${result.cookies[0].split(';')[0]}; projekt1_session=${credential}` };
  }
  async function connect() { const a = await start(); const result = await contacts.callback(a.params, a.cookies); return { ...a, result, sourceId: a.tx.sourceId }; }
  return { contacts, auth, userStore, store, provider, sessions, grants, transactions, disabledSources, start, connect,
    advance: ms => now += ms, setClaims: x => claims = x, setTokens: x => tokens = x, setRefreshTokens: x => refreshTokens = x,
    setRefreshError: x => failRefresh = x, onRefresh: fn => refreshHook = fn, onVerify: fn => verifyHook = fn,
    get exchangeCalls() { return exchangeCalls; }, get refreshCalls() { return refreshCalls; } };
}

test('Contacts start requires authenticated scope ownership and emits separate consent with PKCE', async () => {
  const f = fixture(); await rejection(f.contacts.start(null, 's_u1')); await rejection(f.contacts.start(credential, 's_u2'));
  const a = await f.start(); assert.equal(a.url.searchParams.get('scope'), `openid ${CONTACTS_SCOPE}`);
  assert.equal(a.url.searchParams.get('access_type'), 'offline'); assert.equal(a.url.searchParams.get('include_granted_scopes'), 'true');
  assert.equal(a.url.searchParams.get('prompt'), 'consent'); assert.equal(a.url.searchParams.get('login_hint'), 'g1');
  assert.equal(a.tx.purpose, 'GOOGLE_CONTACTS'); assert.equal(a.tx.sessionHash, hash(credential));
  assert.equal(a.url.searchParams.get('code_challenge'), createHash('sha256').update(a.tx.codeVerifier).digest('base64url'));
  assert.match(a.result.cookies[0], /^projekt1_contacts_oauth=.*HttpOnly; SameSite=Lax.*Secure/);
});
test('callback encrypts tokens, binds source, returns only a fixed redirect and clearing cookie', async () => {
  const f = fixture(), a = await f.connect(), grant = f.grants.get(a.sourceId);
  assert.equal(grant.ownerUserId, 'u1'); assert.equal(grant.scopeId, 's_u1'); assert.equal(grant.googleSubject, 'g1');
  assert.equal(JSON.stringify(grant).includes('test-access'), false); assert.equal(JSON.stringify(grant).includes('test-refresh'), false);
  assert.equal(JSON.stringify(a.result).includes('test-access'), false); assert.equal(JSON.stringify(a.result).includes('test-refresh'), false);
  assert.equal(a.result.location, `${config.appOrigin}/`); assert.match(a.result.cookies[0], /Max-Age=0/);
  assert.deepEqual(await f.contacts.getFreshAccessToken(credential, a.sourceId), { accessToken: 'test-access', expiresAt: 1_800_003_600_000, scopeId: 's_u1', sourceId: a.sourceId });
});
test('source binding stays stable across repeated consent for same owner and subject', async () => {
  const f = fixture(), a = await f.connect(), first = f.grants.get(a.sourceId);
  f.setTokens({ refreshToken: null, refreshExpiresIn: null }); const b = await f.connect(), second = f.grants.get(b.sourceId);
  assert.equal(a.sourceId, b.sourceId); assert.notEqual(first.version, second.version); assert.equal(first.refreshTokenCiphertext, second.refreshTokenCiphertext);
});
test('different owner or changed session cannot complete a consent transaction', async () => {
  for (const other of [secondCredential, sameUserOtherSession]) {
    const f = fixture(), a = await f.start(); await rejection(f.contacts.callback(a.params, a.cookies.replace(credential, other)));
    assert.equal(f.exchangeCalls, 0); assert.equal(f.transactions.size, 1); await f.contacts.callback(a.params, a.cookies);
  }
});
test('browser tampering, duplicate state/cookie, missing session and expired transaction are rejected', async () => {
  const f = fixture(), a = await f.start();
  await rejection(f.contacts.callback(a.params, `projekt1_session=${credential}; projekt1_contacts_oauth=${'x'.repeat(43)}`));
  await rejection(f.contacts.callback(a.params, a.cookies.split(';')[0]));
  const p = new URLSearchParams(a.params); p.append('state', p.get('state')); await rejection(f.contacts.callback(p, a.cookies));
  await rejection(f.contacts.callback(a.params, `${a.cookies}; projekt1_session=${credential}`));
  f.advance(10 * 60 * 1000); await rejection(f.contacts.callback(a.params, a.cookies)); assert.equal(f.exchangeCalls, 0);
});
test('callback consumes denial and cannot replay or race successfully twice', async () => {
  const f = fixture(), a = await f.start(); const results = await Promise.allSettled([f.contacts.callback(a.params, a.cookies), f.contacts.callback(a.params, a.cookies)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1); assert.equal(f.exchangeCalls, 1);
  const b = await f.start(); b.params.set('error', 'access_denied'); await rejection(f.contacts.callback(b.params, b.cookies)); assert.equal(f.transactions.size, 0);
});
for (const [name, claims] of Object.entries({ subject: { sub: 'different_google_user' }, nonce: { nonce: 'wrong' }, audience: { aud: 'other' }, issuer: { iss: 'https://attacker.example' }, expired: { exp: 1 }, authorizedParty: { azp: 'other' } }))
  test(`Contacts callback rejects verified-token ${name} mismatch before storing credentials`, async () => {
    const f = fixture(), a = await f.start(); f.setClaims(claims); await rejection(f.contacts.callback(a.params, a.cookies)); assert.equal(f.grants.size, 0);
  });
for (const [name, tokens] of Object.entries({ missingScope: { scopes: null }, deniedScope: { scopes: ['openid'] }, missingIdentity: { idToken: null }, invalidExpiry: { expiresIn: 0 } }))
  test(`Contacts callback rejects ${name}`, async () => { const f = fixture(), a = await f.start(); f.setTokens(tokens); await rejection(f.contacts.callback(a.params, a.cookies)); assert.equal(f.grants.size, 0); });
test('session revoked while Google responds prevents credential commit', async () => {
  const f = fixture(), a = await f.start(); f.onVerify(async () => f.sessions.delete(credential)); await rejection(f.contacts.callback(a.params, a.cookies)); assert.equal(f.grants.size, 0);
});
test('another owner or disabled source cannot retrieve a provider token', async () => {
  const f = fixture(), a = await f.connect(); await rejection(f.contacts.getFreshAccessToken(secondCredential, a.sourceId));
  f.disabledSources.add(a.sourceId); await rejection(f.contacts.getFreshAccessToken(credential, a.sourceId));
});
test('expired access refreshes once for concurrent calls and retains refresh token if omitted', async () => {
  const f = fixture(), a = await f.connect(); f.advance(3600 * 1000);
  const [first, second] = await Promise.all([f.contacts.getFreshAccessToken(credential, a.sourceId), f.contacts.getFreshAccessToken(credential, a.sourceId)]);
  assert.equal(first.accessToken, 'test-fresh-access'); assert.equal(second.accessToken, first.accessToken); assert.equal(f.refreshCalls, 1);
  const cipher = new ProviderTokenCipher(key), grant = f.grants.get(a.sourceId); assert.equal(cipher.decrypt(grant.refreshTokenCiphertext, grant, 'refresh'), 'test-refresh');
});
test('missing and expired refresh credentials allow valid access until actual expiry', async () => {
  for (const tokens of [{ refreshToken: null, refreshExpiresIn: null }, { refreshExpiresIn: 10 }]) {
    const f = fixture(); f.setTokens(tokens); const a = await f.connect(); f.advance(3541 * 1000);
    assert.equal((await f.contacts.getFreshAccessToken(credential, a.sourceId)).accessToken, 'test-access');
    assert.equal(f.refreshCalls, 0);
    f.advance(59 * 1000);
    await rejection(f.contacts.getFreshAccessToken(credential, a.sourceId)); assert.equal(f.refreshCalls, 0);
  }
});
test('invalid_grant marks stored credential revoked; transient failure preserves retry possibility', async () => {
  for (const permanent of [true, false]) {
    const f = fixture(), a = await f.connect(); f.advance(3541 * 1000); f.setRefreshError(permanent ? new ContactsGrantRejected() : Error('private upstream details'));
    await rejection(f.contacts.getFreshAccessToken(credential, a.sourceId)); assert.equal(f.grants.get(a.sourceId).revokedAt !== null, permanent);
  }
});
test('refresh explicitly losing contacts scope revokes the credential', async () => {
  const f = fixture(), a = await f.connect(); f.advance(3541 * 1000); f.setRefreshTokens({ scopes: ['openid'] });
  await rejection(f.contacts.getFreshAccessToken(credential, a.sourceId)); assert.notEqual(f.grants.get(a.sourceId).revokedAt, null);
});
test('revoke racing refresh wins and cannot be overwritten', async () => {
  const f = fixture(), a = await f.connect(); f.advance(3600 * 1000);
  f.onRefresh(async () => { await f.contacts.revoke(credential, a.sourceId); });
  await rejection(f.contacts.getFreshAccessToken(credential, a.sourceId)); assert.notEqual(f.grants.get(a.sourceId).revokedAt, null);
});
test('new consent racing refresh wins by version instead of stale token overwrite', async () => {
  const f = fixture(), a = await f.connect(); f.advance(3600 * 1000);
  f.onRefresh(async () => { f.setTokens({ accessToken: 'new-consent-access' }); await f.connect(); });
  const result = await f.contacts.getFreshAccessToken(credential, a.sourceId); assert.equal(result.accessToken, 'new-consent-access');
});
test('provider token encryption authenticates owner, source, scope, type and ciphertext', () => {
  const cipher = new ProviderTokenCipher(key), binding = { ownerUserId: 'u1', sourceId: 'src1', scopeId: 's1', googleSubject: 'g1' }, encrypted = cipher.encrypt('unit-token', binding, 'access');
  assert.equal(cipher.decrypt(encrypted, binding, 'access'), 'unit-token'); assert.notEqual(encrypted, cipher.encrypt('unit-token', binding, 'access'));
  for (const change of [{ ownerUserId: 'u2' }, { scopeId: 's2' }, { sourceId: 'src2' }, { googleSubject: 'g2' }]) assert.throws(() => cipher.decrypt(encrypted, { ...binding, ...change }, 'access'));
  assert.throws(() => cipher.decrypt(encrypted, binding, 'refresh'));
  const parts = encrypted.split('.'); parts[2] = `${parts[2][0] === 'A' ? 'B' : 'A'}${parts[2].slice(1)}`; assert.throws(() => cipher.decrypt(parts.join('.'), binding, 'access'));
  assert.throws(() => new ProviderTokenCipher(randomBytes(32).toString('base64url')).decrypt(encrypted, binding, 'access'));
});
test('Contacts configuration is independent and disabled without its explicit key/redirect', async () => {
  const authConfig = { ...config, redirectUri: 'https://app.example.test/api/auth/google/callback' }; delete authConfig.encryptionKey;
  assert.equal(readGoogleContactsConfig(authConfig, {}), null);
  assert.deepEqual(readGoogleContactsConfig(authConfig, { GOOGLE_CONTACTS_REDIRECT_URI: config.redirectUri, PROVIDER_TOKEN_ENCRYPTION_KEY: key }), config);
  for (const env of [{ GOOGLE_CONTACTS_REDIRECT_URI: config.redirectUri }, { GOOGLE_CONTACTS_REDIRECT_URI: config.redirectUri, PROVIDER_TOKEN_ENCRYPTION_KEY: 'short' }, { GOOGLE_CONTACTS_REDIRECT_URI: 'https://attacker.example/callback', PROVIDER_TOKEN_ENCRYPTION_KEY: key }]) assert.throws(() => readGoogleContactsConfig(authConfig, env));
  const f = fixture(), disabled = new GoogleContacts(f.auth, f.userStore, f.store, null);
  await rejection(disabled.start(credential, 's_u1')); await rejection(disabled.getFreshAccessToken(credential, 'src1'));
});
test('real token transport uses fixed endpoint, PKCE/secret POST body, bounded abort and parses responses', async () => {
  const calls = [], transport = async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ token_type: 'Bearer', access_token: 'unit-access', expires_in: 3600, scope: `openid ${CONTACTS_SCOPE}`, refresh_token: 'unit-refresh', id_token: 'unit-id' }), { status: 200 }); };
  const provider = createContactsProvider(config, transport), result = await provider.exchangeCode('unit-code', 'unit-verifier');
  assert.equal(result.accessToken, 'unit-access'); assert.equal(calls[0].url, 'https://oauth2.googleapis.com/token');
  assert.equal(calls[0].options.method, 'POST'); assert.equal(calls[0].options.redirect, 'error'); assert.ok(calls[0].options.signal);
  assert.equal(calls[0].options.body.get('code_verifier'), 'unit-verifier'); assert.equal(calls[0].options.body.get('client_secret'), config.clientSecret);
  await provider.refresh('unit-refresh'); assert.equal(calls[1].options.body.get('grant_type'), 'refresh_token'); assert.equal(calls[1].options.body.get('refresh_token'), 'unit-refresh');
});
test('transport rejects malformed, oversized, failed and invalid_grant responses without private error text', async () => {
  for (const response of [new Response('invalid-json'), new Response('x'.repeat(129 * 1024)), new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'private-text' }), { status: 400 }), new Response(JSON.stringify({ error: 'upstream_private' }), { status: 503 })]) {
    const provider = createContactsProvider(config, async () => response); await assert.rejects(provider.refresh('unit-refresh'), e => e.code === 'SOURCE_UNAVAILABLE' && !e.message.includes('private'));
  }
  for (const value of [null, {}, { token_type: 'Other', access_token: 'unit', expires_in: 1 }, { token_type: 'Bearer', access_token: 'unit', expires_in: -1 }]) assert.throws(() => parseContactsTokens(value));
});
