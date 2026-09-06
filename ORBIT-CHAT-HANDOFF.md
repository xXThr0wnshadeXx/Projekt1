# Orbit — conversation handoff

Updated September 6, 2026. Read this before continuing work. This document records conversation context; verify the checkout and remote state before making changes.

## Project and access

- Product: Orbit, a professional-network knowledge graph built from observed LinkedIn connections, with a shared team library.
- GitHub: https://github.com/xXThr0wnshadeXx/Projekt1
- Local checkout: `/Users/avenger.hao.ran/Projects/Projekt1`
- The Codex task's default working directory may be an unrelated Minecraft directory. Explicitly set the project working directory for shell commands.
- Hosted app: https://orbit-shreev2703-graph-test.shreev2703.chatgpt.site/
- `.openai/hosting.json`: project ID `appgprj_6a9cfe3c7eb4819187da561f93e8a836`, D1 binding `DB`.
- Sites `get_site` repeatedly returned `NOT_FOUND` in this account. We have pushed GitHub branches, but have **not deployed these changes**. The teammate who owns the Site must merge and deploy, or provide working Sites access.
- GitHub push success does not mean the hosted app changed. Do not claim deployment without verifying it.

## User's working preferences

1. Target the **ChatGPT-hosted app** for all product changes. Do not focus on the Chrome extension unless collection/companion work is explicitly requested.
2. Commit and push completed changes to GitHub, and always finish with a note confirming the commit and pushed branch.
3. User's requested workflow for new work:
   ```sh
   git switch main
   git pull origin main
   git switch -c feature/short-description
   # implement
   npm run check
   npm test
   git add .
   git commit -m "Describe the change"
   git push -u origin feature/short-description
   ```
   Installed Git is old and does not support `git switch`; use `git checkout` equivalents. Use `git symbolic-ref --short HEAD` to inspect the branch. Stage only relevant files instead of sweeping up unrelated user files.
4. Keep unrelated untracked `.DS_Store` and `docs/` untouched.
5. Follow-up corrections to an existing feature have been committed to the same feature branch, without rewriting history.
6. No main-branch pushes or automatic merging have been performed. Check whether teammates already merged equivalent changes before combining branches.
7. Be concise, act autonomously, and distinguish tested code from live/browser verification.

## Product requirements and design direction

- Homepage is a landing/sign-up experience, separate from the graph workspace. Top-right navigation is Log in and Sign up.
- Desired journey: account sign-in (Google), LinkedIn profile setup, then map creation.
- Dark NYT Connections-inspired puzzle-game theme, with yellow, green, blue and purple accents. Distinctive but subtle editorial typography; avoid generic Arial styling.
- Readable text, generous spacing, clean workspace. Settings belong in their own tab, not a permanent sidebar consuming map space.
- Build network, pause and cancel should be easy to reach in the workspace. Collection settings should initially be expanded.
- Multiple maps and cancellable builds; smooth, controllable scroll zoom.
- Location and industry/field filters, searchable cities, connection-degree toggles. Grouping should move with a gentle spring/bounce.
- The graph should make room as second-degree branches grow. User likes the spacing, but needs visible dots and clear connection lines.
- Selecting a person should grey unrelated nodes while keeping that person and their **direct neighbors** colored. Clicking blank canvas clears selection.
- **Do not add duplicate People/Coverage search bars.** User explicitly reversed that request after recognizing an existing search bar. Preserve existing search.
- Current collection activity is useful but should be compact, with details available on demand.
- User eventually wants to phase out the extension; it currently remains necessary for scrolling/collecting in their LinkedIn session. Hosted code alone does not scroll the user's LinkedIn page.
- Earlier request removed import/export controls, but teammates subsequently added team-library import capabilities. Do not remove current teammate work based solely on stale conversation context.

## Current checkout and recent changes

At handoff, current feature branch is `feature/orbit-editorial-motion`, product commit `f6354dc`. It was created from the latest pulled main (`1d842b8`) and successfully pushed. This handoff document is an additional documentation change.

### Latest: editorial typography and homepage motion

Branch: `feature/orbit-editorial-motion` — commit `f6354dc`

- Bundled free/open-source Fraunces (400, 600) and Space Grotesk (400, 600), with OFL licenses in `fonts/`.
- Fraunces for headings, brand and metrics; Space Grotesk for body, controls, tiles and canvas labels.
- Graph redraws after its font loads.
- New `src/landing-motion.js`: IntersectionObserver-triggered, once-only section reveals and staggered tile entrances. No hidden-content dependency when JS/observer support is absent.
- CSS adds gentle scroll-linked hero-board rotation where supported, hover treatment, and reduced-motion alternatives.
- Sign-in behavior and content preserved.
- Build, preview and extension packaging updated to include font assets; Worker asset encoding treats TTF files as binary with `font/ttf` MIME.
- Verified all four fonts survive Worker asset encoding byte-for-byte, and the animation module is included.
- `npm run check`, `node --check src/landing-motion.js`, 65 tests and production build passed.
- No browser visual QA performed. No deployment performed.

### Clearer graph and compact activity (separate branch)

Branch: `feature/clearer-map-activity` — commit `16e89e6`

- Wider layouts caused dots to shrink excessively at fitted zoom levels.
- Added minimum on-screen node radii: root 8 px, direct 4.5 px, extended 3 px. Preserved layout coordinates/spacing.
- Updated hit testing, selection rings and label offsets to match rendered node size.
- Stronger ordinary edges and highlighted edges directly attached to selected node.
- Changed live activity to a compact native `<details>` element: current status in summary, full details and rate on expansion.
- 66 tests and build passed; pushed, not deployed.
- This branch is **not included in the typography branch merely because both were pushed**. Merge/reconcile as needed.

### Selection focus, with duplicate search reverted

Branch: `feature/people-search-node-focus`
- `2c055af`: initially added per-tab searches and grey-out selection.
- `9b755ff`: removed new per-tab searches and restored original search, preserving graph selection changes.
- Retained neighbor tracking, grey unrelated dots/labels, blank-canvas deselection, and neighbor updates when new edges arrive.
- After reversal, 58 tests and build passed.
- Latest main now contains equivalent selection code; inspect actual diffs rather than assuming this branch still needs merging.

### Adaptive layout

Branch: `feature/adaptive-graph-layout` — commit `a59394f`
- `networkTargets` reserves subtree space bottom-up, then arranges sibling branches in a golden-angle spiral.
- New batches update target positions for existing nodes; existing spring interpolation moves them smoothly.
- Preserves camera pan/zoom, reduced motion and grouping. Handles arrivals during active transitions without invalid coordinates.
- Synthetic 10,000-node and growth tests passed (59 tests at that time).
- Latest main contains an equivalent `networkTargets` implementation, although Git still lists the original branch as not merged by ancestry. Avoid duplicating it.

### LinkedIn automatic scrolling

Branch: `feature/connection-list-scroll` — commit `cb6491a`
- Collector could pick a header/profile link outside the scrollable connection list.
- Searches profile-link ancestors for the likely list scroller; falls back to document scrolling element.
- When already at bottom, moves up slightly, waits 150 ms, then returns to bottom so the browser can observe a loading-boundary re-entry.
- Revalidates URL after wait; ignores disabled/aria-disabled load-more buttons.
- `advanceLinkedIn` became async; Chrome scripting awaits its promise.
- Preserves request scheduling and restriction handling.
- Updated `downloads/orbit-network-mapper.zip` included in commit.
- 59 tests and build passed; live LinkedIn behavior still needed confirmation.
- Companion updates require extraction and reloading the unpacked Chrome extension.

### Other historical feature branches

`feature/map-filter-navigation`, `feature/workspace-build-button`, `feature/workspace-zoom-controls`, `feature/google-auth-handoff` also exist. Their names and history are context, not a request to merge everything. Teammates have changed main substantially.

## Code layout and testing

- Plain JavaScript frontend and Canvas graph; no React migration required.
- `index.html`: landing/account entry; `setup.html`: LinkedIn setup; `map.html`: workspace and settings.
- `styles.css`: shared theme; contains accumulated overrides, so inspect cascade before editing.
- `src/graph.js`: layout, animation, node selection, pan/zoom, canvas painting.
- `src/app.js`: graph/People/Coverage views, inspector, activity, collection UI.
- `src/filters.js`, `src/search.js`: filtering/grouping and search. Latest main has richer search and keyword grouping from teammates.
- `src/onboarding.js`: sessions and Google login; `src/workspace.js`: workspace startup.
- `src/collector.js`: self-contained functions serialized into LinkedIn tab by `chrome.scripting`.
- `src/background.js`: collection scheduling, pauses, retries, rate limits.
- `server/worker.js`, `server/auth.js`, `server/database.js`: Cloudflare Worker API/auth/D1.
- `tools/build.js`: copies frontend to `out/`, encodes assets into `.build/assets.js`, builds Worker at `dist/server/index.js`, packages companion.
- `tools/package.js`: creates `dist/orbit-network-mapper.zip`.
- `tools/preview.js`: static preview, normally `http://127.0.0.1:8770/`; does not emulate hosted auth/API. An existing server has occupied this port. Do not kill unknown processes or assume a static preview proves hosted auth works.
- `npm run check`, `npm test`, `npm run build` are normal checks. Keep `npm run package` in mind after builds if companion distribution is explicitly needed.
- Canvas unit tests use mocked animation frames and synthetic data, not a real browser.
- Latest theme branch has 65 passing tests; other branches have different totals. Do not treat differing counts as a failure by themselves.

## Google auth context

- Google Cloud project: `projekt1-507807`.
- Public OAuth client ID previously configured: `246098953725-ppau21defjg8gdis37osf7j5q6hfatsf.apps.googleusercontent.com`.
- Do not request, expose, or commit client secrets. Verify current implementation/configuration before changing auth.
- Teammates added Google auth to main; older handoff assumptions may be obsolete.
- Prior document: `GOOGLE-AUTH-HANDOFF.md` on `feature/google-auth-handoff`.

## Useful next steps in a new chat

1. Read this file, inspect Git status and latest main, and confirm what the user wants next.
2. For deployment, reconcile the desired feature branches with current main and the Site owner's checkout. Do not equate Git ancestry with whether equivalent code is present.
3. Preserve the explicit reversal of duplicate search inputs and the preference for visible nodes with spacious layout.
4. If checking the live look is requested, use the actual hosted page or a suitable preview; previous test results did not include visual browser verification.
5. Always report what was committed/pushed and whether it is live.
