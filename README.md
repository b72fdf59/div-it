# Div It

Local-first expense-sharing prototype. Data currently stays in browser IndexedDB and can be exported as a JSON backup.

See [ROADMAP.md](./ROADMAP.md) for product decisions and implementation order, [TASKS.md](./TASKS.md) for dependency-ordered work units, and [the interactive design mock](./docs/design/calm-mobile-mock.html) for the approved visual direction.

## Structure

- `src/App.svelte`: local group snapshots and typed command calls.
- `src/components/`: small UI pieces for group settings, people, expense entry, and ledger summary.
- `src/ledger.js`: money validation, balance calculation, and settlement logic.
- `src/group.js`: validated local commands, Automerge document, IndexedDB persistence, and BroadcastChannel adapter.
- `src/legacy.js`: one-time import of data created by the pre-CRDT prototype.
- `public/`: PWA manifest and service worker.

Install dependencies once, then run:

```sh
npm install
npx playwright install firefox
npm run dev
```

Open URL Vite prints. Build release files with `npm run build`.

Run the headless browser smoke test with `npm run test:browser`. It starts a local Vite server automatically and uses Playwright's pinned Firefox runtime.

Run the full browser regression suite on Playwright's Chromium, Firefox, and WebKit engines with `npx playwright install chromium firefox webkit` followed by `npm run test:browser:matrix`. The browser binaries may need host system libraries; see Playwright's install guidance for your OS. These engine runs do not establish compatibility with branded Chrome, Edge, Safari, iOS Safari, or Android Chrome, or cover current and previous stable versions. They do not replace the pending manual two-tab review in [the Phase 2 packet](./docs/review/phase-2-gate.md).

For local development, seed a three-person Seoul trip in browser DevTools after opening the app:

```js
await import("./seed-demo.js").then(({ seedDemo }) => seedDemo())
location.reload()
```

This replaces current browser data.

The Phase 1 local-ledger gate is complete: the deterministic event engine, audit UI, responsive shell, conflict resolution, and backup metadata validation pass unit, property, build, and browser checks. The next step is local CRDT hardening. The optional encrypted sync relay follows identity and membership work. See TASKS.md and the [Phase 1 gate review](docs/review/phase-1-gate.md) for current status and evidence.
