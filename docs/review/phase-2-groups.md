# DIV-033 local group registry evidence

The app stores a version-one local registry in `localStorage` under `div-it-groups`, with one entry per Automerge document ID and one active document ID. On first startup without that registry, it copies the existing `div-it-group-id` into the registry and opens that same document in place. The legacy key remains unchanged for older local builds. Creating a group creates a separate Automerge document; selecting a group loads its registered document and changes the registry's active ID. There is no delete/leave action.

Each handle has one change listener while active. Switching removes the prior listener and uses an activation generation token to ignore late handle loads or queued callbacks from an old selection. The UI remounts the active-group content and closes/reset dialogs, audit filters, and drafts when the document ID changes.

`browser-tests/group-registry.spec.js` verifies single-key migration without changing the original backup, creating two documents, preserving separate people/events/balances/audit history through switching and reload, and clearing an open expense draft during a programmatic group switch. Cross-tab delivery is outside this task's acceptance; same-browser synchronization remains a later Phase 2 gate.

Acceptance run: `npm test` — 92 passed; `npm run build` — passed; `npm run test:browser` — 16 passed; `git diff --check` — clean.
