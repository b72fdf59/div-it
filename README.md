# Div It

Frontend-only local expense-sharing proof. Data stays in browser IndexedDB; export a JSON backup.

See [ROADMAP.md](./ROADMAP.md) for product decisions and implementation order.

Run from this directory:

```sh
python3 -m http.server 8000
```

Open `http://localhost:8000`. Run ledger check with `node ledger.test.mjs`.

For local development, seed a three-person Seoul trip in browser DevTools after opening the app:

```js
await import("./seed-demo.js").then(({ seedDemo }) => seedDemo())
location.reload()
```

This replaces current browser data.

Next: Automerge-backed group documents and optional encrypted sync relay.
