# Phase 1 gate review

Status: PASS — DIV-027, 2026-10-05.

## Roadmap evidence

- Feedback loop: `npm test` includes the Node unit runner and fixed-seed projector properties; `npm run test:browser` starts Vite and waits for accessible UI state. Responsive shell tests cover mobile/desktop sizing, keyboard navigation, labels, and dialog focus; design-token checks cover both themes.
- Event ledger: parser and projector tests cover all seven event types, invalid/unsupported data, duplicates and collisions, pending dependencies, settlement reversal, revisions/voids, conflict branches/resolutions, zero-sum output, and deterministic arrival order. Fixed-seed properties cover idempotence and insertion-order invariance.
- Command boundary and UI: commands validate before writes; browser coverage exercises people and expense creation, exact splits, reload, backup restore, settlements/reversals, revisions/voids, conflict choice, and audit navigation.
- Diagnostics and audit: unsupported money entries block writes; pending, conflicting, quarantined, rejected, superseded, voided, and reversed records remain inspectable. Audit and projector share the same projection result.
- Week fixture: [`week-fixture.test.mjs`](../../week-fixture.test.mjs) records events across seven consecutive days. Independently stated end-of-day balances are Alice/Bob/Cara: `2000/-1000/-1000`, `-1200/2400/-1200`, `-1200/1800/-600`, `-1200/2400/-1200`, `-1200/2400/-1200`, `-1200/-1200/2400`, and `-1200/-1200/2400` cents. The fixture includes creation, revision, void, conflicting revisions, explicit resolution, settlement, and reversal; reversing insertion order or duplicating every event preserves balances, and all nine source entries appear in audit history.
- Backup metadata: [P1-001](./phase-1-findings.md) is closed. Validation rejects unsupported currency, null/blank participant records, blank IDs, and duplicate IDs before document mutation. Browser evidence verifies errors preserve the populated group’s people, events, and balances through reload, and a valid older-format backup still imports.

## Acceptance run

- `npm test` — 75 passed, including fixed-seed property tests.
- `npm run build` — passed.
- `npm run test:browser` — 13 passed, including backup rejection/preservation and legacy import.
- `git diff --check` — passed.

Phase 1 roadmap checklist items are complete. Phase 2 remains gated by its own automated convergence work and DIV-036 manual browser sign-off.
