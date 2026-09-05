# Explicit Google Contacts authorization

This is an additive server milestone after identity-only Google login. It does not fetch contacts, infer relationship strength, render imported data or imply a live Google account was tested. Shaw owns retrieval/normalization; Ben's integration composes these modules, the private database and HTTP routes. Login continues requesting only `openid profile`.

## Modules and store

- `auth/contacts.ts`: `GoogleContacts`, authenticated consent start/callback, source-bound fresh access tokens and local credential disconnect.
- `auth/contacts-provider.ts`: fixed Google token endpoint, bounded exchange/refresh transport and Google's official ID-token verification.
- `auth/token-cipher.ts`: AES-256-GCM with unique IVs and authenticated owner/scope/source/Google-subject/token-kind binding.
- `auth/contacts-ports.ts`: frozen `ContactsStore`, separate purpose-specific transaction and encrypted grant interfaces. All times are epoch milliseconds.

The existing `google-auth-library@11.0.2` dependency is sufficient; no new dependency is required. The storage implementation must apply its additive Contacts migration after the identity/private-storage migration. Atomic commit provisions/enables the actual owner's source together with its encrypted credential. It must check private scope ownership and verified Google subject. Source policy is `google-contacts-private-v1`; owner source identity is `{platform:'google', externalId:<verified Google sub>}`. That subject must not be misrepresented as a People API contact resource name.

A source ID is a stable opaque SHA-256 digest of the actor, scope and Google subject. Access/refresh ciphertext is authenticated against those exact bindings, so copying a credential row to another owner/source fails decryption. Source registration does not create contact records or relationship edges.

## Google console and server configuration

Use the **same Web application client** as login. In its Google Cloud project, enable **Google People API** in APIs & Services → Library. Add `https://www.googleapis.com/auth/contacts.readonly` to the application's Google Auth Platform data-access configuration. Keep actual presenting/test accounts listed while testing; do not assume public verification or every account's access is available by the deadline.

Register the separate authorized redirect URI:

`http://127.0.0.1:5173/api/auth/google/contacts/callback`

For deployment, register exactly `https://<actual-app-host>/api/auth/google/contacts/callback`. Keep the existing identity callback registered as well. These exact paths are separate and cannot substitute for each other.

In addition to [identity setup](AUTH-SETUP.md), set server-only:

```dotenv
GOOGLE_CONTACTS_REDIRECT_URI=http://127.0.0.1:5173/api/auth/google/contacts/callback
PROVIDER_TOKEN_ENCRYPTION_KEY=<32-random-bytes-encoded-as-43-base64url-characters>
```

Generate the encryption key with a cryptographically secure generator and put it directly into the local/server secret store. Keep it stable across restarts and separate from database backups. Never commit it, put it in `VITE_` variables, log it, or paste it into chat/GitHub. The module accepts exactly 32 bytes in canonical unpadded base64url; it fails closed for a missing/invalid key or mismatched redirect. Removing/changing the key makes existing ciphertext unusable: this first implementation requires disconnect/reconsent after deliberate key replacement; it has no multi-key rotation facility.

Primary sources: [Google server OAuth: enable APIs, incremental/offline consent and refresh](https://developers.google.com/identity/protocols/oauth2/web-server), [People API preparation](https://developers.google.com/people/quickstart/nodejs), [people.connections.list and required scopes](https://developers.google.com/people/api/rest/v1/people.connections/list).

## Composition and HTTP contract

```ts
const contactsConfig = readGoogleContactsConfig(googleLoginConfig, process.env);
const contacts = new GoogleContacts(auth, durableStore, durableStore, contactsConfig);
```

The constructor takes `AuthPort`, user/scope reads from `AuthStore`, `ContactsStore`, and nullable configuration. No data access happens without a live signed-in session. Dependencies can inject a provider and clock in tests; production must use the default verified Google provider.

Recommended routes, owned by integration:

1. **POST `/api/auth/google/contacts/start`**, same-origin Origin check, authenticated session cookie, JSON `{scopeId}`. Call `contacts.start(sessionCredential, scopeId)`, set its returned `cookies` array, and respond `{authorizationUrl: result.location}`. Frontend then navigates with `window.location.assign(authorizationUrl)`. A fetch-followed redirect to Google may fail CORS; native HTML form POST can instead use a 303 if integration adds safe form parsing. This must be an explicit Connect Contacts action, not an automatic effect after login.
2. **GET `/api/auth/google/contacts/callback`** passes original `URLSearchParams` and raw cookie header to `contacts.callback(params, header)`. On success, set its returned cookie array and 303 to returned fixed APP_ORIGIN `/`. On failure, clear only its own transaction cookie with `contacts.clearTransactionCookie()` and use the existing safe `apiFailure`. Never log callback URLs, codes, cookies, tokens or provider response bodies.
3. Optional **POST `/api/auth/google/contacts/disconnect`**, same-origin authenticated JSON `{sourceId}`, calls `contacts.revoke(sessionCredential, sourceId)`. This disables local credential use and wipes credentials through storage. It does not delete previously imported evidence or revoke Google's entire app grant; those are separate user actions.

Retain no-store/no-referrer response headers, request size limits and auth route rate limits. A browser session that expires, is revoked, changes account, or rotates while consent is in progress must restart this flow. Login and Contacts use separate cookie names and transaction tables/purposes.

## Server-only retrieval handoff to Shaw

```ts
const access = await contacts.getFreshAccessToken(sessionCredential, sourceId);
// SERVER ONLY: access.accessToken goes into Authorization: Bearer for People API.
// access.scopeId and sourceId bind the import's privately constructed SourceContext.
```

`FreshContactsAccess` includes plaintext `accessToken`, expiry, scopeId and sourceId **only for in-process retrieval**. Never create an HTTP endpoint that returns it, place it in graph/event DTOs, or pass it to a browser. The existing import bridge must construct source ownership/policy from storage/session; clients do not submit actor IDs or trusted SourceContext. The module does not invoke Shaw's normalizer or assume CONTACT_SAVED observations are confirmed relationships.

The consent request adds `openid contacts.readonly`, `access_type=offline`, `include_granted_scopes=true`, `prompt=consent` and a subject login hint. The callback verifies issuer, audience, authorized party, expiry, signature, nonce and that `sub` exactly matches the signed-in account. The **returned** granted scopes must contain `contacts.readonly`; a consent screen appearing is insufficient proof.

Fresh access tokens are decrypted only after current actor/source ownership checks. Within 60 seconds of expiry, the module refreshes using the encrypted refresh token; provider token lifetimes are respected. A response without new scopes retains the existing grant's scopes. A response explicitly removing Contacts access or returning `invalid_grant` revokes the stored credential and requires new consent. Temporary service/network failures leave the grant available for retry. Missing/expired refresh tokens require reconnect after access expiry. Google can omit a refresh token during repeated consent: only an existing non-revoked same-source refresh credential is retained. A new account/source with no refresh token still supports its current access token, but no invented long-lived refresh capability.

Refresh calls are deduplicated per source in one process. Database compare-and-swap versions ensure an older refresh cannot overwrite a concurrent newer consent, disconnect or source disable, including multiple processes. A disconnect leaves already imported private records intact; source deletion/review policies still belong to integration.

## Verification status and acceptance

`npm run build:server` and `node --test tests/auth*.test.mjs` pass **48 offline tests**: 20 unchanged login tests and 28 Contacts tests. Contacts tests cover scope/subject/session binding, state/cookie tampering and replay, denial, revoked sessions during callback, ciphertext isolation/tampering, encrypted storage, token transport parsing/limits, refresh/expiry/permanent-vs-transient failure and refresh races with consent/revocation. Test tokens/accounts exist only in test fixtures and never populate product data. The storage agent separately verifies actual PostgreSQL constraints/transactions; these auth tests use an in-memory port implementation.

Live acceptance remains required: enable People API and client scopes; complete consent on the actual demo account; confirm the real source is registered privately; let Shaw's server fetch actual People API records; demonstrate no contacts scope on login alone; verify another account cannot read the source; prove refresh/restart and disconnect behavior without exposing credentials. No live Google access, source count or deployed route is claimed by this module commit.
