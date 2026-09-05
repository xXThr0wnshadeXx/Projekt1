import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { OAuth2Client } from 'google-auth-library';
import type { HttpAuthPort, SessionView } from '../http.js';
import { ServiceError } from '../service.js';
import type { AuthStore } from './ports.js';

const callbackPath = '/api/auth/google/callback';
const transactionCookie = 'projekt1_oauth';
const sessionCookie = 'projekt1_session';
const transactionLifetimeMs = 10 * 60 * 1000;
const sessionLifetimeMs = 24 * 60 * 60 * 1000;
const opaquePattern = /^[A-Za-z0-9_-]{43}$/;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const randomToken = () => randomBytes(32).toString('base64url');
const unavailable = () => new ServiceError('SOURCE_UNAVAILABLE', 502);
const unauthorized = () => new ServiceError('UNAUTHENTICATED', 401);

export interface GoogleAuthConfig { clientId: string; clientSecret: string; appOrigin: string; redirectUri: string }
/** No host/header-derived redirect URLs. Missing configuration stays explicitly unavailable. */
export function readGoogleAuthConfig(env: Record<string, string | undefined>): GoogleAuthConfig | null {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, APP_ORIGIN: appOrigin, GOOGLE_REDIRECT_URI: redirectUri } = env;
  if (!clientId && !clientSecret && !appOrigin && !redirectUri) return null;
  if (!clientId || !clientSecret || !appOrigin || !redirectUri) throw unavailable();
  try {
    const origin = new URL(appOrigin), redirect = new URL(redirectUri);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname);
    if (origin.origin !== appOrigin || origin.username || origin.password ||
        (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && local)) ||
        redirect.href !== `${appOrigin}${callbackPath}` || redirect.origin !== origin.origin ||
        !clientId.endsWith('.apps.googleusercontent.com') || clientId.length > 512 || clientSecret.length > 4096) throw new Error();
    return { clientId, clientSecret, appOrigin, redirectUri };
  } catch { throw unavailable(); }
}

export interface VerifiedGoogleClaims {
  sub: string; iss: string; aud: string; exp: number; iat: number;
  nonce?: string; azp?: string; name?: string;
}
/** Implementations must VERIFY the JWT signature before returning claims; decoding is insufficient. */
export interface GoogleProvider {
  exchangeCode(code: string, codeVerifier: string): Promise<string>;
  verifyIdToken(idToken: string): Promise<VerifiedGoogleClaims>;
}

/** Uses Google's maintained signature/key/issuer/audience verifier; token exchange is bounded and never logged. */
export function createGoogleProvider(config: GoogleAuthConfig): GoogleProvider {
  const verifier = new OAuth2Client({ clientId: config.clientId, transporterOptions: { timeout: 8000, retry: false } });
  return {
    async exchangeCode(code, codeVerifier) {
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, code_verifier: codeVerifier, client_id: config.clientId,
          client_secret: config.clientSecret, redirect_uri: config.redirectUri, grant_type: 'authorization_code' }),
      });
      if (!response.ok || !response.body) { await response.body?.cancel(); throw unauthorized(); }
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) { const item = await reader.read(); if (item.done) break; size += item.value.byteLength;
          if (size > 128 * 1024) throw unauthorized(); chunks.push(item.value); }
      } finally { await reader.cancel(); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!value || typeof value !== 'object' || !('id_token' in value) || typeof value.id_token !== 'string' || value.id_token.length > 16384) throw unauthorized();
      // Login only: discard access_token and refresh_token. Contacts requires a separate consent flow.
      return value.id_token;
    },
    async verifyIdToken(idToken) {
      const ticket = await verifier.verifyIdToken({ idToken, audience: config.clientId });
      const payload = ticket.getPayload(); if (!payload) throw unauthorized();
      // Additional application checks (nonce, strict expiry, authorized party) follow in callback.
      return payload as VerifiedGoogleClaims;
    },
  };
}

function cookie(name: string, value: string, maxAge: number, secure: boolean): string {
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`;
}
function oneCookie(header: string | undefined, name: string): string | null {
  const values = (header ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${name}=`));
  if (values.length !== 1) return null;
  const value = values[0]!.slice(name.length + 1); return opaquePattern.test(value) ? value : null;
}
function oneParameter(params: URLSearchParams, name: string): string {
  const values = params.getAll(name); if (values.length !== 1 || !values[0] || values[0].length > 4096) throw unauthorized();
  return values[0];
}
function equal(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right); return a.length === b.length && timingSafeEqual(a, b);
}
export interface AuthRedirect { location: string; cookies: string[] }
export interface GoogleLoginPort extends HttpAuthPort {
  start(): Promise<AuthRedirect>;
  callback(params: URLSearchParams, cookieHeader?: string): Promise<AuthRedirect>;
  clearTransactionCookie(): string;
}

export class GoogleAuth implements GoogleLoginPort {
  private readonly provider: GoogleProvider | null;
  constructor(private readonly store: AuthStore, private readonly config: GoogleAuthConfig | null,
    options: { provider?: GoogleProvider; now?: () => number } = {}) {
    this.provider = config ? (options.provider ?? createGoogleProvider(config)) : null;
    this.now = options.now ?? Date.now;
  }
  private readonly now: () => number;
  clearTransactionCookie(): string { return cookie(transactionCookie, '', 0, this.config?.appOrigin.startsWith('https:') ?? false); }
  async start(): Promise<AuthRedirect> {
    const config = this.config; if (!config || !this.provider) throw unavailable();
    const state = randomToken(), binding = randomToken(), nonce = randomToken(), codeVerifier = randomToken(), now = this.now();
    await this.store.putOAuthTransaction({ stateHash: sha256(state), browserBindingHash: sha256(binding), nonce, codeVerifier,
      createdAt: now, expiresAt: now + transactionLifetimeMs });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri,
      response_type: 'code', scope: 'openid profile', state, nonce, code_challenge_method: 'S256',
      code_challenge: createHash('sha256').update(codeVerifier).digest('base64url'), access_type: 'online' }).toString();
    return { location: url.href, cookies: [cookie(transactionCookie, binding, transactionLifetimeMs / 1000, config.appOrigin.startsWith('https:'))] };
  }
  async callback(params: URLSearchParams, cookieHeader?: string): Promise<AuthRedirect> {
    const config = this.config, provider = this.provider; if (!config || !provider) throw unavailable();
    const state = oneParameter(params, 'state'), binding = oneCookie(cookieHeader, transactionCookie);
    if (!opaquePattern.test(state) || !binding) throw unauthorized();
    const now = this.now();
    const transaction = await this.store.consumeOAuthTransaction(sha256(state), sha256(binding), now);
    if (!transaction || transaction.expiresAt <= now || transaction.createdAt > now) throw unauthorized();
    // Consume before any provider call, including errors: a callback can never be replayed.
    if (params.has('error')) throw unauthorized();
    const code = oneParameter(params, 'code');
    let claims: VerifiedGoogleClaims;
    try { claims = await provider.verifyIdToken(await provider.exchangeCode(code, transaction.codeVerifier)); }
    catch { throw unauthorized(); }
    const seconds = this.now() / 1000;
    if (!claims || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) ||
        claims.aud !== config.clientId || (claims.azp !== undefined && claims.azp !== config.clientId) ||
        typeof claims.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(claims.sub) ||
        !Number.isFinite(claims.exp) || !Number.isFinite(claims.iat) || claims.exp <= seconds ||
        claims.iat > seconds + 60 || claims.exp <= claims.iat ||
        typeof claims.nonce !== 'string' || !equal(claims.nonce, transaction.nonce)) throw unauthorized();
    const displayName = typeof claims.name === 'string' && claims.name.trim()
      ? (claims.name.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 200) || 'Google account') : 'Google account';
    const user = await this.store.upsertGoogleUser({ googleSubject: claims.sub, displayName });
    const token = randomToken(), createdAt = this.now();
    await this.store.putSession({ tokenHash: sha256(token), userId: user.userId, createdAt, expiresAt: createdAt + sessionLifetimeMs, revokedAt: null });
    // Existing browser session rotates on successful login. Its cookie is never used to choose the new account.
    const previous = oneCookie(cookieHeader, sessionCookie); if (previous) await this.store.revokeSession(sha256(previous), createdAt);
    return { location: `${config.appOrigin}/`, cookies: [this.clearTransactionCookie(), cookie(sessionCookie, token, sessionLifetimeMs / 1000, config.appOrigin.startsWith('https:'))] };
  }
  async resolveSession(credential: unknown): Promise<{ userId: string } | null> {
    if (!this.config || typeof credential !== 'string' || !opaquePattern.test(credential)) return null;
    const record = await this.store.getSession(sha256(credential)), now = this.now();
    if (!record || record.revokedAt !== null || record.expiresAt <= now || record.createdAt > now) return null;
    return await this.store.getUser(record.userId) ? { userId: record.userId } : null;
  }
  async displaySession(userId: string): Promise<SessionView> {
    if (!this.config) throw unauthorized();
    const user = await this.store.getUser(userId); if (!user) throw unauthorized();
    return { actor: { id: user.userId, displayName: user.displayName }, scopes: await this.store.listPrivateScopes(userId) };
  }
  async revokeSession(credential: unknown): Promise<void> {
    if (typeof credential === 'string' && opaquePattern.test(credential)) await this.store.revokeSession(sha256(credential), this.now());
  }
}
