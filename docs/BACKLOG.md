# Projekt1 task board — evidence-based checkpoint

Updated September 5, 2026. Deadline September 6 at 2 p.m. Pacific; feature freeze noon, rehearsal 1 p.m. Main remains separate from draft integration PR #6. Code-complete and real-user acceptance are distinct.

## Implemented and checked in integration

- [x] Existing Vite/React frontend preserved; modular Node backend and runtime contracts established.
- [x] Google identity/session, private PostgreSQL storage and separate encrypted Contacts composition.
- [x] Authorized graph/search with Shreev’s weighted engine and supported current-affiliation targets.
- [x] Private Contacts import staging, safe review and explicit observation approval HTTP routes.
- [x] Shaw parser integrated with NodeNext compatibility and structural validation.
- [x] Exact zero-based search playback compatibility fix integrated.
- [x] Private environment dev/start runner prepared; browser subprocess excludes server secrets.

Latest published integration `9e96543`: server/browser build and 24 focused tests passed. Earlier complete integration checkpoint passed 209 tests with disposable PostgreSQL. Neither establishes a real import or route.

## Active bounded implementation/review

- [ ] Contacts P2 fixes `315548e`: independent immutable-commit review, then integration. Fix agent reports 96 focused checks passing; not yet independently accepted.
- [ ] Backend task: bounded People API retriever/pagination relay after Shaw’s capacity handoff, reusing his parser; transport review and injection follow.
- [ ] Real-fact backend task: explicit versioned relationship/current-affiliation decisions, private attestation ledger, opt-in confirmed directed search projection. No inferred relationships from contacts.
- [ ] Nicolas: Contacts connect/import/review controls and actual committed construction playback; fact forms use the agreed narrow contract.
- [ ] Deployment task: reconcile current production artifacts and run disposable production smoke checks; observer handles release.
- [ ] Shreev: confirm resumed ownership and review projection semantics; existing engine/goal work already integrated, do not duplicate.

## Account preparation

- [x] Existing Google project/client/People API retained; profile/openid and separately consented Contacts readonly approved and saved.
- [x] Ben completed Render verification. Free PostgreSQL available, private network only; expires October 5.
- [ ] Free web service, private server settings, production HTTPS callbacks and deployed acceptance. Paid plans are not approved.

## Required real-data acceptance

- [ ] Restart latest reviewed app with existing private config and database; migrations/readiness verified.
- [ ] Real owner sign-in, separate Contacts consent, source retrieval and private staged review/approval.
- [ ] Real saved contacts render without promoting observations into friendships.
- [ ] Explicit truthful relationship/current-affiliation confirmation yields one supported positive route; unknown willingness/openings remain unknown.
- [ ] Actual graph construction/search playback, reduced motion, version consistency and reload behavior.
- [ ] Cross-user isolation and private persistence after restart.
- [ ] Deployed flow and local real-data fallback rehearsed on presenting account/device.

## Deferred unless independently proven

LinkedIn user export is a separate source proposal; do not assume availability or silently switch source scope. Gmail, unrestricted crawling, broad enrichment, automatic fuzzy identity merges, invented networks and pooled private graphs are excluded. No extra source or AI extraction should delay the first supported route.

Owners report exact commit, checks, limitations and next action. Observer posts issue #2 after every actual push/pull; no force push, dirty overwrite or automatic main merge.
