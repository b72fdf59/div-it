# Phase 1 gate findings

These observed defects must be closed during DIV-027 (or an earlier task if they block its acceptance). They do not change the approved ledger architecture.

## P1-001 — Validate backup participants and currency before replacing state

Status: CLOSED in DIV-027 (`2026-10-05`)

Observed after DIV-024, commit `6ee8ae4`: `validateBackup` accepts `people: [null]`, duplicate participant IDs, and `currency: "invalid"`. The null participant causes the app's participant destructuring to throw; invalid currency causes `Intl.NumberFormat` to throw; duplicate IDs make participant selection and balances ambiguous. Import currently replaces live state before these rendering errors appear.

Reproduction: call `validateBackup({ name: "Bad backup", currency: "USD", people: [null], events: [] })`; it returns instead of rejecting. Calling `group.people.map(({ id }) => id)` then throws. A backup with two participants sharing an ID also returns. A backup with `currency: "invalid"` returns, then currency formatting throws.

Required fix: validate the supported group currency and participant records, including unique nonempty IDs and valid names, before document mutation. Keep valid legacy backup formats compatible. Preserve malformed ledger events for projection diagnostics according to the event contract; participant metadata has no analogous safe projection path.

Required evidence: meaningful validation tests and a browser case importing invalid participant/currency metadata into an existing valid group. The import reports an error, existing people/events/balances remain unchanged, and the app still works after reload. Verify a valid older backup still imports.

Closure evidence: `validateBackup` now validates the supported currency and participant object, nonblank ID, unique ID, and name before `importBackup` calls `handle.change`. `group.test.mjs` covers null records, blank IDs/names, duplicate IDs, unsupported currency, and valid legacy-shaped backups. `browser-tests/backup-validation.spec.js` rejects each malformed metadata case while a group has people and an expense, reloads and compares its people/events and balance, then imports a valid legacy-format expense without error. See [phase-1-gate.md](./phase-1-gate.md).
