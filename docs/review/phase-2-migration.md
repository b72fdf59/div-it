# DIV-031 migration evidence

Migration is additive and retryable. `eventStoreFormatVersion: 1` identifies the flat immutable scalar map encoding; it records that the document has been scanned, but does not claim old replicas have stopped appending to the retained `events` array. On each open, the app checks that source again and copies newly observed records. Snapshots union the legacy source and map while suppressing one map mirror for each matching legacy record. Legacy storage is never cleared or rewritten.

| Published source format | Fixture and evidence | Origin |
| --- | --- | --- |
| Pre-CRDT IndexedDB `div-it` v1 / `state` / `group`, `{name,currency,people,events}` | `browser-tests/legacy-storage-migration.spec.js` seeds this DB before app startup; export/reload checks IDs, cents, extra raw fields, participants and group identity. | `c021590^:src/storage.js` |
| Automerge document with a legacy `events` array containing flat `expense` or `expense-created` records | `event-store.test.mjs` “migration copies mixed legacy and versioned arrays…” and “a legacy replica append after migration…”; browser fixture also uses flat `expense-created`. | `c021590` (local Automerge group); `c021590^:src/ledger.js` (flat creation record) |
| Automerge event arrays with version-one envelopes, mixed legacy entries, unsupported versions and malformed values | Mixed-array migration test compares raw events and serialized envelope content including the signature; projection keeps unsupported/malformed data diagnosable. | Versioned writes: `807319e`; revisions/voids: `6ee8ae4`; conflicts/resolutions: `1882a16` |
| Current flat `eventsById` scalar map alongside retained legacy source, including a partially copied array and colliding variants | `event-store.test.mjs` “partial migration retries…” checks current-map plus source, same-ID variants, save/load and exact content. | `0332a29` |

Migration tests also verify second-pass Automerge heads are unchanged, a late legacy append is retried, and two replicas migrating while making independent writes preserve source arrays and map variants through both merge directions and save/load. Projected balances/diagnostics and audit rows are compared after merge; transport-map representation remains hidden from group snapshots and backups.
