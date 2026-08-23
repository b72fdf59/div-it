# Div It

Frontend-only local expense-sharing proof. Data stays in browser IndexedDB; export a JSON backup.

See [ROADMAP.md](./ROADMAP.md) for product decisions and implementation order.

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

Next: Automerge-backed group documents and optional encrypted sync relay.
