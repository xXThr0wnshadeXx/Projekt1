import { ServiceError } from '../service.js';
import { createGoogleProvider, type GoogleAuthConfig, type VerifiedGoogleClaims } from './google.js';

export interface ContactsTokens {
  accessToken: string; expiresIn: number; scopes: string[] | null;
  refreshToken: string | null; refreshExpiresIn: number | null; idToken: string | null;
}
export interface ContactsProvider {
  exchangeCode(code: string, codeVerifier: string): Promise<ContactsTokens>;
  verifyIdToken(idToken: string): Promise<VerifiedGoogleClaims>;
  refresh(refreshToken: string): Promise<ContactsTokens>;
}
/** Distinguishes an invalidated grant from transient service failure without exposing provider bodies. */
export class ContactsGrantRejected extends ServiceError { constructor() { super('SOURCE_UNAVAILABLE', 502); } }
const unavailable = () => new ServiceError('SOURCE_UNAVAILABLE', 502);
function optionalToken(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\u0000-\u0020\u007f]/.test(value)) throw unavailable();
  return value;
}
function seconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > 366 * 24 * 3600) throw unavailable(); return value;
}
/** The response parser is shared with injected-transport tests; raw token responses remain server-private. */
export function parseContactsTokens(value: unknown): ContactsTokens {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw unavailable();
  const item = value as Record<string, unknown>, accessToken = optionalToken(item.access_token);
  if (!accessToken || item.token_type !== 'Bearer') throw unavailable();
  let scopes: string[] | null = null;
  if (item.scope !== undefined) {
    if (typeof item.scope !== 'string' || item.scope.length > 8192 || /[\u0000-\u001f\u007f]/.test(item.scope)) throw unavailable();
    scopes = [...new Set(item.scope.split(' ').filter(Boolean))];
  }
  return { accessToken, expiresIn: seconds(item.expires_in), scopes, refreshToken: optionalToken(item.refresh_token),
    refreshExpiresIn: item.refresh_token_expires_in === undefined ? null : seconds(item.refresh_token_expires_in), idToken: optionalToken(item.id_token) };
}
export function createContactsProvider(config: GoogleAuthConfig, transport: typeof fetch = fetch): ContactsProvider {
  const identity = createGoogleProvider(config);
  async function tokenRequest(body: URLSearchParams): Promise<ContactsTokens> {
    try {
      const response = await transport('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body, signal: AbortSignal.timeout(8000) });
      if (!response.body) throw unavailable();
      const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
      try { while (true) { const item = await reader.read(); if (item.done) break;
        size += item.value.byteLength; if (size > 128 * 1024) throw unavailable(); chunks.push(item.value); } }
      finally { await reader.cancel(); }
      const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!response.ok) {
        if (value && typeof value === 'object' && 'error' in value && value.error === 'invalid_grant') throw new ContactsGrantRejected();
        throw unavailable();
      }
      return parseContactsTokens(value);
    } catch (error) { if (error instanceof ContactsGrantRejected) throw error; throw unavailable(); }
  }
  return {
    exchangeCode(code, codeVerifier) { return tokenRequest(new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
      code, code_verifier: codeVerifier, redirect_uri: config.redirectUri, grant_type: 'authorization_code' })); },
    verifyIdToken: idToken => identity.verifyIdToken(idToken),
    refresh(refreshToken) { return tokenRequest(new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret,
      refresh_token: refreshToken, grant_type: 'refresh_token' })); },
  };
}
