# Google login and private sessions

Owner: Ben. This module supplies a real Google authorization-code/OIDC adapter; the integration composition must wire it to HTTP and a durable `AuthStore`. It does not create fake users or grant Contacts access. Google client credentials and an actual consenting account are still required for the live acceptance test.

## Dependencies and configuration

Integration owner adds the exact runtime dependency `google-auth-library@11.0.2` to the root manifest and lockfile. The module uses Node crypto only for secure random opaque tokens, SHA-256 hashes and constant-time nonce comparison. Google's official library verifies JWT signatures against Google's keys, issuer, audience and token lifetime. Application code additionally validates nonce, authorized party, strict expiry and subject shape.

Create a Google Cloud project and a Google Auth Platform OAuth client of type **Web application**. Configure app branding/audience, and add the presenting account and other approved testers as test users while the app is in testing. Register this exact local authorized redirect URI:

`http://127.0.0.1:5173/api/auth/google/callback`

For a deployed app, register `https://<actual-app-host>/api/auth/google/callback` separately. The frontend and API must use the same browser origin. The configured redirect must be exactly APP_ORIGIN plus `/api/auth/google/callback`; no trailing slash, query string, different port or `localhost`/`127.0.0.1` substitution. HTTPS is required outside loopback development.

Set these **server-only** values in the process environment or the hosting secret store:

```dotenv
GOOGLE_CLIENT_ID=<web-client-id>.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=<client-secret>
APP_ORIGIN=http://127.0.0.1:5173
GOOGLE_REDIRECT_URI=http://127.0.0.1:5173/api/auth/google/callback
DATABASE_URL=<private-postgresql-connection-string>
```

`DATABASE_URL` belongs to the storage composition, not this module. Never prefix secrets with `VITE_`, commit an environment file, put a token in a URL, or paste credentials into GitHub/chat. No Google API key, service account, email address lookup or browser cookie import is needed. Initial authorization requests only `openid profile`; no email, contacts, Gmail or offline refresh access is requested.

Primary references: [Google OpenID Connect server flow and exact redirect configuration](https://developers.google.com/identity/openid-connect/openid-connect), [official Node Google Auth Library](https://github.com/googleapis/google-auth-library-nodejs), [OAuth2Client verification API](https://googleapis.dev/nodejs/google-auth-library/latest/classes/OAuth2Client.html).

## Integration wiring

The auth agent owns only `packages/server/auth`, `tests/auth.test.mjs`, and this document. HTTP/main and dependency changes belong to integration.

```ts
import { GoogleAuth, readGoogleAuthConfig } from './auth/google.js';
const config = readGoogleAuthConfig(process.env);
const auth = new GoogleAuth(durableAuthStore, config);
// Pass auth to BackendService AND createApiServer. Use config.appOrigin as browserOrigin.
```

A completely absent config yields `null` and auth stays unavailable. Partially configured or unsafe URLs fail with the existing safe `SOURCE_UNAVAILABLE` error. Composition should treat incomplete deployment configuration as unavailable/readiness failure; do not replace it with a fabricated session. The Google provider is constructed only for valid configuration.

HTTP route work required:

- `GET /api/auth/google/start`: await `auth.start()`, set the returned `cookies` array as `Set-Cookie`, and return 302 to returned `location`.
- `GET /api/auth/google/callback`: pass the request's **original URLSearchParams** and raw Cookie header to `auth.callback`. Duplicate state/code parameters must remain detectable. On success, set the full returned `cookies` array and 302 to returned location. On callback error, clear the transaction cookie using `auth.clearTransactionCookie()` and use `apiFailure`; never render/log provider errors, raw request URLs, authorization codes, cookies or tokens. Callback URLs must not enter proxy/access logs.
- Existing `/api/session` resolves the opaque cookie and returns only actor display data and owner-filtered private scope IDs/labels. Do not call displaySession using a client-supplied user ID.
- Existing same-origin `POST /api/auth/logout` calls `auth.revokeSession(token)` and clears `projekt1_session`; preserve the HTTP Origin check.

Keep `Cache-Control: no-store` and `Referrer-Policy: no-referrer` on auth responses. Use a reverse proxy/Vite proxy for `/api`; do not expose credentials through frontend environment variables or a separate cross-origin cookie workaround. Apply reasonable per-client start/callback request limits at HTTP/hosting level and periodically remove expired OAuth transaction/session rows. Request timeouts must accommodate the bounded provider exchange and verification-key fetch; each network leg has an 8-second timeout. Provider rejection is intentionally returned as a generic authentication failure, without private details.

## Durable store contract

`packages/server/auth/ports.ts` is the interface shared with the storage agent. All times are epoch **milliseconds**. Store ownership and uniqueness constraints must be real database constraints/transactions:

- State and browser binding are independently random; persist only SHA-256 hashes. The nonce and PKCE verifier stay server-side in a short-lived transaction.
- `consumeOAuthTransaction` must atomically return-and-delete only an unexpired transaction with a matching browser binding. Concurrent callbacks must not both succeed. A wrong browser must not consume the legitimate transaction. Transactions expire after 10 minutes and are consumed even if Google denies access or subsequent verification fails.
- `upsertGoogleUser` uses verified Google `sub`, never name/email as identity. Concurrent first logins must produce exactly one account and one private scope/root. Existing subjects reuse their account. The root is the actual authenticated account, not a seeded person.
- A successful callback issues a fresh 256-bit opaque session token. Persist only its SHA-256 hash with user ID, creation/expiry and revocation timestamps. An existing browser session is revoked when replaced. Session lifetime is 24 hours; expired, revoked and deleted-account sessions resolve to unauthenticated.
- Cookies are host-only, HttpOnly, SameSite=Lax, Path=/ and Secure on HTTPS. Raw session tokens are sent only in Set-Cookie, never in JSON or storage. Opening two concurrent login starts in one browser invalidates the older browser binding; restart sign-in if needed.

## Verification and live acceptance

Run `npm run build:server` followed by `node --test tests/auth.test.mjs` after dependency integration. The 20 offline tests cover state/cookie tampering, duplicate inputs, callback replay/concurrency, denial, transaction expiry, nonce/issuer/audience/authorized-party/expiry checks, subject account reuse, session rotation/revocation/expiry, deleted accounts and fail-closed configuration. They use an injected provider for flow tests. A separate ephemeral-key test exercises the official library's actual signature verification and rejects altered signatures, wrong issuer/audience and expired tokens. No tests call Google or seed product data. These do not prove a configured Google client, real browser callback, durable database restart behavior or live Google key retrieval.

Before demo acceptance, verify with the actual authorized presenting account: sign-in returns to the exact app origin; session shows its real display name and private scope; refresh and server restart preserve its unexpired session; a second account cannot access that scope; logout revokes the credential; replaying callback fails without creating another account. Never record the full callback URL or tokens in screenshots/reports.

## Next milestone: separately consented Google Contacts

Login alone supplies **no Contacts access**. A later explicit “Connect Google Contacts” action should create a distinct owner/session-bound OAuth transaction and callback route, add `https://www.googleapis.com/auth/contacts.readonly`, verify returned identity matches the signed-in subject, verify the granted scope, and store provider credentials only server-side. It must not reuse this login callback to silently expand permissions or attach a different Google account's contacts. Current provider intentionally discards access/refresh tokens.

Suggested new server-private contracts for that milestone (not implemented here): `ContactsConsentTransaction` extends a transaction with actorUserId, googleSubject, sourceId, requestedScopes and purpose `GOOGLE_CONTACTS`; a credential store atomically writes `{ownerUserId,sourceId,googleSubject,grantedScopes,accessTokenCiphertext,accessExpiresAt,refreshTokenCiphertext|null,revokedAt|null}` and exposes an owner-authorized server-only retrieval/revoke operation. Ciphertext requires a deployment-managed encryption key separate from the database, and plaintext never goes to graph DTOs or the browser. One-time import can use online access and avoid refresh storage; request offline access only if background/repeated imports are actually implemented. Source registration and the credential receipt must commit together so Shaw's retrieval always has an owned source/provenance context. Keep login AuthStore and identity-only scopes unchanged for this first milestone.
