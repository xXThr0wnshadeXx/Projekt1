# Orbit: Google account login implementation handoff

Prepared September 6, 2026. Code reviewed against GitHub `main` at `5ee0d92`.
This is a handoff, not a claim that Google login has been implemented or deployed.

## Goal and agreed scope

Implement real Google account login and signup for the **ChatGPT-hosted Orbit webapp**, not the Chrome extension. The homepage already has **Log in**, **Sign up**, and a disabled **Continue with Google** button. All should converge on one verified Google identity flow:

- First-time user: create an Orbit account, then go to `setup.html` to add a LinkedIn profile.
- Returning user with completed onboarding: go to `map.html`.
- Returning user without a LinkedIn starting profile: return to setup.
- Provide logout and handle expired sessions without losing server-saved data.

Adding a LinkedIn URL sets a starting profile; it is not LinkedIn authentication or verified ownership. Google login does not replace LinkedIn collection. The team intends to phase out the extension, but a replacement data source is a separate workstream.

## Existing Google configuration: completed

| Item | Value |
| --- | --- |
| Google Cloud project name | Projekt1 |
| Google Cloud project ID | `projekt1-507807` |
| Branding app name | Orbit |
| OAuth audience | External, testing mode |
| OAuth client name | Orbit web sign-in |
| OAuth client type | Web application |
| Authorized JavaScript origin | `https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site` |
| Client ID (public configuration, not a secret) | `246098953725-ppau21defjg8gdis37osf7j5q6hfatsf.apps.googleusercontent.com` |

The user completed acceptance of Google's API Services User Data Policy. Google displayed **OAuth client created** and **Enabled**. Only the hosted JavaScript origin was entered. No redirect URI or localhost origin was added in this session. Test-user additions and production publishing were not completed or verified.

Google Cloud console: https://console.cloud.google.com/auth/clients?project=projekt1-507807

The client secret is deliberately excluded from this document and must never be committed, pasted into frontend code, or logged. The one-time credentials dialog was subsequently closed by the user; whether they saved the secret is unknown. A browser Google Identity Services ID-token flow normally uses the public client ID plus server token verification, not a client secret in the browser. If the chosen implementation requires a secret, have the credential owner supply it directly to the hosting secret manager. Do not regenerate credentials casually.

## Site and repository

- Repository: https://github.com/xXThr0wnshadeXx/Projekt1
- Intended hosted site: https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site/
- `.openai/hosting.json` project ID: `appgprj_6a9cfe3c7eb4819187da561f93e8a836`
- Logical database binding: `DB` (Sites-managed D1).
- Frontend: plain JavaScript modules, HTML, CSS, Canvas.
- Backend: Cloudflare Worker-compatible code built with Vite and the Sites plugin.
- Database schema/migrations: Drizzle SQLite schema and committed migrations.

Use the existing Site. Do not create a replacement project or change the hosting ID merely to work around access errors.

## First prerequisite: verify platform support and access

**Direct Google authentication on this Sites deployment is not yet verified.** The current integration uses dispatcher-owned ChatGPT sign-in. Do not assume that creating a Google client enables Google login on Sites.

The implementing account's `get_site` call returned `Sites project not found` for the manifest ID. This is an unresolved access/context issue, not proof that the site does not exist or that Google login is unsupported. The teammate owning the Site must inspect it from their own account/workspace.

Before coding the auth boundary, confirm:

1. You have editor/deployment access in the correct Sites workspace. GitHub access and public website access do not grant Site editing rights. Available tools support same-workspace editors; external viewer access is insufficient.
2. The platform permits the intended public Google sign-in flow, server-side token verification, and app-owned cookies/sessions. Verify any dispatch, CSP, framing, and cookie restrictions using current platform documentation/support and the owner account.
3. The public homepage can remain anonymous while protected pages and APIs use the selected identity mechanism.
4. The final origin is the one registered above. If it changes, update Google's allowed origin through the appropriate credential owner.

Sites' built-in `/signin-with-chatgpt`, `/signout-with-chatgpt`, and `/callback` paths belong to the dispatcher. Do not override them. Use distinct application endpoints for any supported app-owned auth flow. If external auth is unsupported, report that explicitly and agree on a supported backend/hosting design rather than faking login or silently substituting ChatGPT login for Google.

## Current code and required changes

| File | Current behavior | Implementation work |
| --- | --- | --- |
| `index.html` | `login-link` → `#login`; `signup-link` → `#signup`; disabled `google-signin`; ChatGPT fallback link | Render the supported Google button and account state; preserve two entry intents with one identity flow |
| `src/onboarding.js` | Sets Google unavailable text, changes heading from hash, fetches `/api/session`, stores starting profile in localStorage | Start real auth, handle failure, use server account/onboarding state, remove placeholder only when functional |
| `setup.html` | LinkedIn URL form and ChatGPT sign-in fallback | Persist the profile under the verified Orbit account; update fallback/navigation |
| `src/workspace.js` | Redirects unauthenticated users to ChatGPT; checks localStorage for setup completion | Recognize the verified session; distinguish incomplete onboarding from missing localStorage |
| `server/worker.js` | Redirects protected page requests based on `oai-authenticated-user-id`; supplies shared library owner | Integrate supported auth endpoints and server page protection |
| `server/api.js` | `/api/session` and all library APIs trust dispatcher-provided ChatGPT user identity | Resolve a verified actor consistently; keep authorization checks on server |
| `src/library.js` | Displays ChatGPT login prompts on 401 | Update prompts and session-expiry behavior to the new flow |
| `db/schema.ts`, `drizzle/` | Existing library schema | Add users/identities/sessions/onboarding as needed with additive migrations |
| `server/rate-limit.js` | Per-actor limits, enabled through `ORBIT_RATE_LIMIT_ENABLED` | Use verified actor IDs; preserve config and enforcement |
| `tools/build.js` | Explicit list of copied browser modules | Include new frontend auth files; otherwise source can work locally but be missing in deployment |

Localhost and Chrome-extension protocols currently bypass the hosted session check for device-local preview. That is **not authentication** and must not authorize backend calls. `npm run preview` is a static server, not an auth/backend emulator.

## Recommended implementation contract (proposal, not existing endpoints)

Choose a supported library/provider integration rather than hand-rolling token cryptography. One possible design, if Sites permits it:

1. Browser uses Google Identity Services to obtain an ID token after user interaction.
2. Browser submits the credential to a same-origin auth endpoint such as `POST /api/auth/google`.
3. Backend validates CSRF/origin protection appropriate to the selected Google callback/redirect mode, then verifies signature using Google's rotating keys, expected audience/client ID, issuer, expiration, and nonce where used.
4. Resolve identity by provider plus Google's stable `sub` claim. Do not use email alone as the account key or automatically merge accounts with matching emails.
5. Create or find an Orbit user atomically, using a unique provider/subject constraint to handle concurrent sign-ins.
6. Issue a secure session, ideally an opaque random token with only a hash stored server-side. Use a host-only `Secure`, `HttpOnly` cookie and a suitable `SameSite` policy. Define expiry and revoke on logout.
7. Return minimal session/account information from `/api/session`, with `Cache-Control: no-store`. Do not expose Google tokens or secrets.
8. Protect both page routes and API requests through one server identity resolver. Never accept an actor or trusted header supplied by the browser as proof of identity.
9. Persist onboarding fields on the server so a returning user on another device is not incorrectly treated as new.

Example minimal data model: `users(id, created_at, linkedin_profile_url)`, `identities(provider, subject, user_id, email, display_name)` with unique `(provider, subject)`, and `sessions(token_hash, user_id, expires_at)`. Adapt to the chosen supported auth system rather than building redundant tables.

Both Log in and Sign up can use the same provider flow. The backend determines whether an account already exists; the frontend intent controls explanatory copy, not trust or authorization.

## Preserve shared-library behavior

The current Worker uses a shared library owner (`demo-knowledge-graph`) while the authenticated actor identifies the contributor and rate-limit subject. Google user IDs must **not silently replace the shared data owner**, partition the team's records, or expose private records under an incorrect identity.

Decide whether existing ChatGPT contributors retain dual sign-in or migrate. If linking identities, require proof of both accounts. If the team wants restricted contribution, enforce a server membership/allowlist rule: Google authentication alone does not prove team membership.

The latest main includes `drizzle/0002_foamy_mad_thinker.sql` and recent database/import changes. Preserve these; this auth handoff does not authorize removing teammates' features. Inspect the actual current schema before adding migrations.

## Google console completion

- Verify the OAuth client and exact origin still match this document.
- Configure test users as required by the selected scopes and Google's current testing rules; the creation dialog warned that access was restricted to test users. Obtain the intended teammate emails rather than inventing an allowlist.
- Request only sign-in identity information; no Gmail, Drive, or LinkedIn access is needed.
- If using a redirect flow, register the exact implemented callback URI before testing. None is configured yet. Do not guess a callback or use the dispatcher-reserved `/callback`.
- If testing locally, register the development origin required by Google and run a real backend test environment. Static preview cannot establish production sessions.
- Review branding, support contact, privacy-policy requirements, and publishing/verification requirements before opening beyond the test audience.
- Never label a ChatGPT sign-in redirect as “Continue with Google.”

## Acceptance checks

- Anonymous visitors can open the homepage; Log in and Sign up reach real Google sign-in.
- New account is created once and reaches LinkedIn setup.
- Existing account with onboarding completed reaches the workspace, including on a new device.
- Google chooser cancellation and authentication failure return a useful, recoverable state.
- Forged, expired, wrong-audience/wrong-issuer credentials and CSRF attempts are rejected.
- Anonymous/expired-session API access is rejected server-side; shared library ownership remains correct.
- Logout revokes the session and protected routes require sign-in again.
- Session cookies and tokens are not exposed to JavaScript, logs, URLs, or Git.
- Untrusted redirect targets cannot send users to arbitrary external sites.
- Verify in ordinary Chrome on the actual hosted origin; an embedded preview alone is insufficient.
- Confirm production configuration, migrations, and copied frontend assets match the validated commit.

## Required Git workflow and deployment

The user explicitly requested feature branches for future website changes:

```sh
git switch main
git pull origin main
git switch -c feature/google-account-login
# Implement the change.
npm run check
npm test
npm run build
git add <only relevant files>
git commit -m "Implement verified Google account login"
git push -u origin feature/google-account-login
```

On this Mac, Git is old enough that `git switch` is unavailable; equivalent commands are `git checkout main` and `git checkout -b feature/google-account-login`. Do not discard existing changes. There are unrelated untracked `.DS_Store` and `docs/` items in this checkout; do not blindly commit them or credentials.

Open/review a PR and merge according to team policy. A GitHub push **does not deploy the Site**. The Site owner/editor must use the existing Sites source/deployment workflow, set any required secrets there, apply compatible migrations, and verify the live URL. Report **committed**, **pushed**, and **deployed** separately with the commit and branch. Never say it is live based only on a successful Git push.

Other feature branches may remain unmerged, including `feature/workspace-zoom-controls` and `feature/workspace-build-button`; check their status rather than overwriting them. Google auth is a separate change.

## Official references

- Google client setup: https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid
- Google button integration: https://developers.google.com/identity/gsi/web/guides/display-button
- Server token verification: https://developers.google.com/identity/gsi/web/guides/verify-google-id-token
- Integration considerations: https://developers.google.com/identity/gsi/web/guides/integrate

## Definition of done

Google login works end-to-end on the specified ChatGPT-hosted origin; new and returning accounts route correctly; sessions and protected APIs are verified server-side; current shared library behavior is preserved; tests pass; the feature branch is pushed/reviewed; the correct source is deployed and tested live. Creating the Google OAuth client alone does not satisfy this goal.
