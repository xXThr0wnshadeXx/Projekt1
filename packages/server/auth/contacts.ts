import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ServiceError, type AuthPort } from '../service.js';
import type { AuthStore, AuthUser } from './ports.js';
import type { AuthRedirect, GoogleAuthConfig, VerifiedGoogleClaims } from './google.js';
import type { ContactsGrant, ContactsStore } from './contacts-ports.js';
import { createContactsProvider, ContactsGrantRejected, type ContactsProvider, type ContactsTokens } from './contacts-provider.js';
import { ProviderTokenCipher } from './token-cipher.js';

export const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
export const CONTACTS_POLICY_VERSION = 'google-contacts-private-v1';
const callbackPath = '/api/auth/google/contacts/callback';
const cookieName = 'projekt1_contacts_oauth';
const lifetimeMs = 10 * 60 * 1000;
const opaque = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[A-Za-z0-9_.:-]{1,128}$/;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const unavailable = () => new ServiceError('SOURCE_UNAVAILABLE', 502);
const unauthorized = () => new ServiceError('UNAUTHENTICATED', 401);
const forbidden = () => new ServiceError('FORBIDDEN', 403);
export interface GoogleContactsConfig extends GoogleAuthConfig { encryptionKey: string }
export function readGoogleContactsConfig(authConfig: GoogleAuthConfig | null, env: Record<string, string | undefined>): GoogleContactsConfig | null {
  const redirectUri = env.GOOGLE_CONTACTS_REDIRECT_URI, encryptionKey = env.PROVIDER_TOKEN_ENCRYPTION_KEY;
  if (!redirectUri && !encryptionKey) return null;
  if (!authConfig || !redirectUri || !encryptionKey || redirectUri !== `${authConfig.appOrigin}${callbackPath}`) throw unavailable();
  new ProviderTokenCipher(encryptionKey);
  return { ...authConfig, redirectUri, encryptionKey };
}
function getCookie(header: string | undefined, name: string): string | null {
  const found = (header ?? '').split(';').map(x => x.trim()).filter(x => x.startsWith(`${name}=`));
  if (found.length !== 1) return null; const value = found[0]!.slice(name.length + 1); return opaque.test(value) ? value : null;
}
function parameter(params: URLSearchParams, key: string): string {
  const values = params.getAll(key); if (values.length !== 1 || !values[0] || values[0].length > 4096) throw unauthorized(); return values[0];
}
function nonceMatches(value: unknown, expected: string): boolean {
  if (typeof value !== 'string') return false; const a = Buffer.from(value), b = Buffer.from(expected); return a.length === b.length && timingSafeEqual(a, b);
}
function checkClaims(claims: VerifiedGoogleClaims, config: GoogleContactsConfig, nonce: string, subject: string, now: number): void {
  const seconds = now / 1000;
  if (!claims || claims.sub !== subject || !['accounts.google.com', 'https://accounts.google.com'].includes(claims.iss) || claims.aud !== config.clientId ||
      (claims.azp !== undefined && claims.azp !== config.clientId) || !Number.isFinite(claims.iat) || !Number.isFinite(claims.exp) ||
      claims.exp <= seconds || claims.iat > seconds + 60 || claims.exp <= claims.iat || !nonceMatches(claims.nonce, nonce)) throw unauthorized();
}
function checkTokens(tokens: ContactsTokens, requireScope: boolean): void {
  if (!tokens || typeof tokens.accessToken !== 'string' || !tokens.accessToken || tokens.accessToken.length > 16384 ||
      /[\u0000-\u0020\u007f]/.test(tokens.accessToken) || !Number.isSafeInteger(tokens.expiresIn) || tokens.expiresIn <= 0 || tokens.expiresIn > 86400 ||
      (requireScope && tokens.scopes === null) || (tokens.scopes !== null && (!Array.isArray(tokens.scopes) || tokens.scopes.some(scope => typeof scope !== 'string' || !scope || scope.length > 2048) || !tokens.scopes.includes(CONTACTS_SCOPE)))) throw unavailable();
  if (tokens.refreshToken !== null && (typeof tokens.refreshToken !== 'string' || !tokens.refreshToken || tokens.refreshToken.length > 16384 || /[\u0000-\u0020\u007f]/.test(tokens.refreshToken))) throw unavailable();
  if (tokens.refreshExpiresIn !== null && (!Number.isSafeInteger(tokens.refreshExpiresIn) || tokens.refreshExpiresIn <= 0 || tokens.refreshExpiresIn > 366 * 86400)) throw unavailable();
}
/** Secret return type, for server retrieval adapters ONLY. Never expose as an HTTP response. */
export interface FreshContactsAccess { accessToken: string; expiresAt: number; sourceId: string; scopeId: string }
export class GoogleContacts {
  private readonly provider: ContactsProvider | null;
  private readonly cipher: ProviderTokenCipher | null;
  private readonly now: () => number;
  private readonly refreshes = new Map<string, Promise<void>>();
  constructor(private readonly auth: AuthPort, private readonly users: Pick<AuthStore, 'getUser' | 'listPrivateScopes'>,
    private readonly store: ContactsStore, private readonly config: GoogleContactsConfig | null,
    options: { provider?: ContactsProvider; now?: () => number } = {}) {
    this.provider = config ? options.provider ?? createContactsProvider(config) : null;
    this.cipher = config ? new ProviderTokenCipher(config.encryptionKey) : null;
    this.now = options.now ?? Date.now;
  }
  private configured(): { config: GoogleContactsConfig; provider: ContactsProvider; cipher: ProviderTokenCipher } {
    if (!this.config || !this.provider || !this.cipher) throw unavailable(); return { config: this.config, provider: this.provider, cipher: this.cipher };
  }
  private async actor(credential: unknown): Promise<AuthUser> {
    if (typeof credential !== 'string' || !opaque.test(credential)) throw unauthorized();
    const actor = await this.auth.resolveSession(credential); if (!actor) throw unauthorized();
    const user = await this.users.getUser(actor.userId); if (!user) throw unauthorized(); return user;
  }
  private cookie(value: string, maxAge: number): string {
    return `${cookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${this.config?.appOrigin.startsWith('https:') ? '; Secure' : ''}`;
  }
  clearTransactionCookie(): string { return this.cookie('', 0); }
  async start(credential: unknown, scopeId: string): Promise<AuthRedirect> {
    const { config } = this.configured(), user = await this.actor(credential);
    if (!idPattern.test(scopeId)) throw forbidden();
    if (!(await this.users.listPrivateScopes(user.userId)).some(scope => scope.id === scopeId)) throw forbidden();
    const state = random(), binding = random(), nonce = random(), codeVerifier = random(), now = this.now();
    const sourceId = `gc_${hash(JSON.stringify([user.userId, scopeId, user.googleSubject]))}`;
    await this.store.putContactsTransaction({ purpose: 'GOOGLE_CONTACTS', stateHash: hash(state), browserBindingHash: hash(binding), sessionHash: hash(credential as string),
      actorUserId: user.userId, scopeId, sourceId, googleSubject: user.googleSubject, nonce, codeVerifier, createdAt: now, expiresAt: now + lifetimeMs });
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: 'code',
      scope: `openid ${CONTACTS_SCOPE}`, access_type: 'offline', include_granted_scopes: 'true', prompt: 'consent',
      login_hint: user.googleSubject, state, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(codeVerifier).digest('base64url') }).toString();
    return { location: url.href, cookies: [this.cookie(binding, lifetimeMs / 1000)] };
  }
  async callback(params: URLSearchParams, cookieHeader?: string): Promise<AuthRedirect> {
    const { config, provider, cipher } = this.configured(), credential = getCookie(cookieHeader, 'projekt1_session'), user = await this.actor(credential);
    const state = parameter(params, 'state'), binding = getCookie(cookieHeader, cookieName);
    if (!opaque.test(state) || !binding) throw unauthorized();
    const tx = await this.store.consumeContactsTransaction({ stateHash: hash(state), browserBindingHash: hash(binding), sessionHash: hash(credential!), actorUserId: user.userId, now: this.now() });
    if (!tx || tx.purpose !== 'GOOGLE_CONTACTS' || tx.googleSubject !== user.googleSubject || tx.expiresAt <= this.now() || tx.createdAt > this.now()) throw unauthorized();
    if (params.has('error')) throw unauthorized();
    const code = parameter(params, 'code'); let tokens: ContactsTokens;
    try {
      tokens = await provider.exchangeCode(code, tx.codeVerifier); checkTokens(tokens, true);
      if (!tokens.idToken) throw unauthorized();
      checkClaims(await provider.verifyIdToken(tokens.idToken), config, tx.nonce, user.googleSubject, this.now());
    } catch { throw unavailable(); }
    const current = await this.actor(credential); if (current.userId !== user.userId || current.googleSubject !== tx.googleSubject) throw unauthorized();
    const existing = await this.store.getContactsGrant(user.userId, tx.sourceId), now = this.now();
    const bindingData = { ownerUserId: user.userId, scopeId: tx.scopeId, sourceId: tx.sourceId, googleSubject: user.googleSubject };
    // Google may omit refresh_token on an existing grant. Only preserve a still-valid, same-owner/source grant.
    const priorRefresh = existing && existing.revokedAt === null && existing.googleSubject === user.googleSubject && existing.scopeId === tx.scopeId &&
      (existing.refreshExpiresAt === null || existing.refreshExpiresAt > now) ? existing : null;
    const grant: ContactsGrant = { ...bindingData, grantedScopes: tokens.scopes!, accessTokenCiphertext: cipher.encrypt(tokens.accessToken, bindingData, 'access'),
      accessExpiresAt: now + tokens.expiresIn * 1000,
      refreshTokenCiphertext: tokens.refreshToken ? cipher.encrypt(tokens.refreshToken, bindingData, 'refresh') : priorRefresh?.refreshTokenCiphertext ?? null,
      refreshExpiresAt: tokens.refreshToken ? (tokens.refreshExpiresIn === null ? null : now + tokens.refreshExpiresIn * 1000) : priorRefresh?.refreshExpiresAt ?? null,
      createdAt: existing?.createdAt ?? now, updatedAt: now, revokedAt: null, version: random() };
    await this.store.commitContactsGrant(grant, tx.sessionHash);
    return { location: `${config.appOrigin}/`, cookies: [this.clearTransactionCookie()] };
  }
  private async grant(user: AuthUser, sourceId: string): Promise<ContactsGrant> {
    if (!idPattern.test(sourceId)) throw forbidden();
    const grant = await this.store.getContactsGrant(user.userId, sourceId);
    if (!grant || grant.ownerUserId !== user.userId || grant.sourceId !== sourceId || grant.googleSubject !== user.googleSubject || grant.revokedAt !== null ||
        !grant.grantedScopes.includes(CONTACTS_SCOPE)) throw unavailable(); return grant;
  }
  private async refresh(grant: ContactsGrant): Promise<void> {
    const { provider, cipher } = this.configured(), now = this.now();
    if (!grant.refreshTokenCiphertext || (grant.refreshExpiresAt !== null && grant.refreshExpiresAt <= now)) throw unavailable();
    let tokens: ContactsTokens;
    try {
      tokens = await provider.refresh(cipher.decrypt(grant.refreshTokenCiphertext, grant, 'refresh'));
      if (tokens.scopes !== null && Array.isArray(tokens.scopes) && !tokens.scopes.includes(CONTACTS_SCOPE)) throw new ContactsGrantRejected();
      checkTokens(tokens, false);
    } catch (error) {
      if (error instanceof ContactsGrantRejected) await this.store.revokeContactsGrant(grant.ownerUserId, grant.sourceId, grant.version, this.now());
      throw unavailable();
    }
    const updatedAt = this.now();
    const replacement: ContactsGrant = { ...grant, accessTokenCiphertext: cipher.encrypt(tokens.accessToken, grant, 'access'), accessExpiresAt: updatedAt + tokens.expiresIn * 1000,
      grantedScopes: tokens.scopes ?? grant.grantedScopes,
      refreshTokenCiphertext: tokens.refreshToken ? cipher.encrypt(tokens.refreshToken, grant, 'refresh') : grant.refreshTokenCiphertext,
      refreshExpiresAt: tokens.refreshToken ? (tokens.refreshExpiresIn === null ? grant.refreshExpiresAt : updatedAt + tokens.refreshExpiresIn * 1000) : grant.refreshExpiresAt,
      updatedAt, version: random() };
    // A concurrent new consent or revocation wins. Never blindly overwrite its credentials.
    await this.store.replaceContactsGrant(replacement, grant.version);
  }
  async getFreshAccessToken(credential: unknown, sourceId: string): Promise<FreshContactsAccess> {
    const { cipher } = this.configured(), user = await this.actor(credential); let grant = await this.grant(user, sourceId);
    const now = this.now(), canRefresh = grant.refreshTokenCiphertext !== null &&
      (grant.refreshExpiresAt === null || grant.refreshExpiresAt > now);
    if (grant.accessExpiresAt <= now + 60_000 && canRefresh) {
      const key = JSON.stringify([user.userId, sourceId]); let pending = this.refreshes.get(key);
      if (!pending) { pending = this.refresh(grant); this.refreshes.set(key, pending); }
      try { await pending; } finally { if (this.refreshes.get(key) === pending) this.refreshes.delete(key); }
      await this.actor(credential); grant = await this.grant(user, sourceId);
    }
    if (grant.accessExpiresAt <= this.now()) throw unavailable();
    return { accessToken: cipher.decrypt(grant.accessTokenCiphertext, grant, 'access'), expiresAt: grant.accessExpiresAt, scopeId: grant.scopeId, sourceId: grant.sourceId };
  }
  /** Disconnect local credential use only; Google-wide grant revocation and source-data deletion are separate actions. */
  async revoke(credential: unknown, sourceId: string): Promise<void> {
    this.configured(); const user = await this.actor(credential), grant = await this.grant(user, sourceId);
    if (!await this.store.revokeContactsGrant(user.userId, sourceId, grant.version, this.now())) throw new ServiceError('VERSION_CONFLICT', 409);
  }
}
