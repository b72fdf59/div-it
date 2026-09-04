# Div It

Local-first expense-sharing prototype. Data currently stays in browser IndexedDB and can be exported as a JSON backup.

See [ROADMAP.md](./ROADMAP.md) for product decisions and implementation order, [TASKS.md](./TASKS.md) for dependency-ordered work units, and [the interactive design mock](./docs/design/calm-mobile-mock.html) for the approved visual direction.

## Structure

- `src/App.svelte`: local group state and CRDT actions.
- `src/components/`: small UI pieces for group settings, people, expense entry, and ledger summary.
- `src/ledger.js`: money validation, balance calculation, and settlement logic.
- `src/group.js`: Automerge document, IndexedDB persistence, and same-browser-tab sync.
- `src/legacy.js`: one-time import of data created by the pre-CRDT prototype.
- `public/`: PWA manifest and service worker.

Install dependencies once, then run:

```sh
npm install
npm run dev
```

Open URL Vite prints. Build release files with `npm run build`.

For local development, seed a three-person Seoul trip in browser DevTools after opening the app:

```js
await import("./seed-demo.js").then(({ seedDemo }) => seedDemo())
location.reload()
```

This replaces current browser data.

Next: stabilize the immutable ledger event model and test boundary before hardening the existing Automerge prototype. The optional encrypted sync relay follows after local CRDT behavior is verified.
