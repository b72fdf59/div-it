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

For local development, seed a three-person Seoul trip in browser DevTools after opening the app:

```js
await import("./seed-demo.js").then(({ seedDemo }) => seedDemo())
location.reload()
```

This replaces current browser data.

The deterministic event ledger and regression tests are implemented. The responsive app shell and settlement recording/reversal UI use the event projector; next are revision, void, conflict review, and audit views, followed by local CRDT hardening. The optional encrypted sync relay follows identity and membership work. See TASKS.md for current task status.
