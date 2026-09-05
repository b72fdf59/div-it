# Div It task queue

This queue turns [ROADMAP.md](./ROADMAP.md) into work units small enough for a focused, lower-capability agent. The roadmap remains authoritative for product and architecture decisions.

## Rules for agents

1. Pick exactly one task whose status is READY. A REVIEW task may be drafted only when a human explicitly assigns it.
2. Read that task, its dependencies, the relevant roadmap sections, and the existing code before editing.
3. Do not make product or architecture decisions missing from the roadmap. Stop and report the decision needed.
4. Keep the diff limited to the stated deliverable. Preserve unrelated and untracked work.
5. Run every acceptance check listed for the task.
6. Change a task to DONE only after all checks pass. Then mark only its newly unblocked direct successors READY.
7. Report changed files, checks run, and remaining risks. Do not begin another task.

Suggested prompt:

> Work only on DIV-XXX from TASKS.md. Follow its dependencies and acceptance checks plus the architecture contract in ROADMAP.md. Do not start another task or invent missing decisions.

Status meanings:

- READY: may be started now.
- BLOCKED: a named dependency is incomplete.
- REVIEW: an agent may draft it, but a human must approve it before dependent work starts.
- MANUAL: requires human interaction or real devices.
- FROZEN: intentionally deferred until the first-release gate.
- DONE: all acceptance checks passed.

## Dependency overview

    DIV-001 ── DIV-004 ──────────────┐
                                      ├─ DIV-010 ... DIV-017 ─┐
    DIV-003 (human review) ──────────┘                         │
                                                              ├─ DIV-020 ... DIV-026 ── Phase 1 gate
    DIV-002 ── DIV-005 ── DIV-006 ── DIV-007 ─────────────────┘
                                                                      │
                                                                      ▼
                                                             DIV-030 ... DIV-036
                                                                      │
                                                                      ▼
                                                               Phase 2 gate

## Phase 1A — establish feedback loops

### DIV-001 — Establish the unit-test command

- Status: DONE
- Depends on: none
- Deliverable: Convert the existing ledger check to Node's built-in test runner and add a non-watch npm test command. Do not change ledger behavior.
- Likely files: package.json, ledger.test.mjs
- Acceptance:
  - npm test exits successfully.
  - Existing balance and settlement assertions remain.
  - A failing assertion causes a non-zero exit.

### DIV-002 — Add browser-test scaffolding

- Status: DONE
- Depends on: none
- Deliverable: Add the smallest browser-test setup suitable for the Vite app, a package script, and one page-load test. Do not redesign the UI.
- Likely files: package.json, package-lock.json, browser-test configuration, one browser test
- Acceptance:
  - One command starts the app automatically and runs headlessly.
  - The test waits for the Div It UI rather than using a fixed sleep.
  - The process exits cleanly in success and failure cases.
  - README documents the command.

### DIV-003 — Specify the version-one event format

- Status: REVIEW
- Depends on: none
- Deliverable: Draft an ADR that turns the roadmap event contract into exact envelope and payload schemas. Include event IDs, schema/protocol versions, participant/device attribution fields, dependency references, and canonical signed-content requirements. Cryptographic algorithm selection remains deferred.
- Likely files: docs/adr/0001-event-format.md
- Acceptance:
  - Covers expense-created, expense-revised, expense-voided, settlement-recorded, settlement-reversed, opening-balances-imported, and conflict-resolved.
  - Includes valid examples and invalid cases.
  - Defines duplicate IDs, ID/content collisions, missing dependencies, concurrent revisions, unsupported versions, and zero-sum requirements.
  - Separates domain semantics from Automerge representation.
  - Human approval changes its status to DONE.

### DIV-004 — Cover existing ledger behavior

- Status: DONE
- Depends on: DIV-001
- Deliverable: Add focused tests for cents, makeExpense, balances, and settlementPlan without changing production behavior.
- Likely files: ledger.test.mjs
- Acceptance:
  - Covers success paths, invalid numbers, zero/negative amounts, missing payer/participants, split-total mismatch, uneven-cent totals, and unknown event types.
  - Every balance fixture sums to zero.
  - npm test passes.

### DIV-005 — Protect add-expense behavior in a browser

- Status: DONE
- Depends on: DIV-002
- Deliverable: Add two people, submit an equal-split expense, and assert activity and balances through the browser.
- Likely files: browser test only; production files only if the regression reappears
- Acceptance:
  - Test fails if form submission throws or does not persist.
  - Test verifies payer, description, total, and resulting balances.
  - Test uses a clean browser state.

### DIV-006 — Test exact split, reload, and backup round-trip

- Status: DONE
- Depends on: DIV-005
- Deliverable: Extend browser coverage for exact splits, persistence after reload, JSON export, and import into a clean context.
- Likely files: browser tests and narrow test helpers
- Acceptance:
  - Unequal integer-minor-unit values survive reload exactly.
  - Export then import reproduces people, expenses, and balances.
  - Tests can run independently and in any order.

### DIV-007 — Extract approved design tokens

- Status: READY
- Depends on: DIV-002
- Deliverable: Move the approved calm dark/light palette, typography, spacing, radii, and semantic colors into production CSS variables. Do not change information architecture yet.
- Source: docs/design/calm-mobile-mock.html
- Likely files: style.css and one visual browser test or screenshot assertion
- Acceptance:
  - Dark and light themes share semantic tokens.
  - Emerald means positive/safe/action, amber means review, and coral means debt.
  - Color is never the only status indicator.
  - Existing controls remain readable at mobile and desktop widths.

## Phase 1B — build the deterministic event ledger

### DIV-010 — Validate event envelopes

- Status: BLOCKED
- Depends on: DIV-003, DIV-004
- Deliverable: Implement pure parsing and validation for the approved structural event envelope. Signature verification is deferred to the identity phase.
- Likely files: new src/events.js and focused tests
- Acceptance:
  - Valid fixtures parse to a stable internal shape.
  - Unknown versions/types, malformed IDs, missing references, invalid integer money, and non-zero-sum payloads return stable reason codes.
  - The module does not import Automerge, browser APIs, or UI code.

### DIV-011 — Project created expenses

- Status: BLOCKED
- Depends on: DIV-010
- Deliverable: Add a pure projectLedger(eventsById) path for expense-created events.
- Likely files: src/ledger.js, event/projector tests
- Acceptance:
  - Every permutation of the same valid events produces the same balances and effective activity.
  - Input objects are not mutated.
  - Balances remain zero-sum.

### DIV-012 — Handle duplicates and missing dependencies

- Status: BLOCKED
- Depends on: DIV-011
- Deliverable: Add projector behavior and tests for exact duplicate events, ID/content collisions, and unavailable dependencies.
- Acceptance:
  - Exact duplicates apply once.
  - Reused IDs with different content are quarantined.
  - Missing-dependency events remain pending and become effective when dependencies arrive.
  - Arrival order cannot alter final output.

### DIV-013 — Project settlements and reversals

- Status: BLOCKED
- Depends on: DIV-012
- Deliverable: Add settlement-recorded and settlement-reversed semantics.
- Acceptance:
  - A settlement changes only the named participants.
  - A reversal references and neutralizes one valid settlement.
  - Duplicate, malformed, and already-reversed operations are deterministic and diagnosed.

### DIV-014 — Project expense revisions and voids

- Status: BLOCKED
- Depends on: DIV-013
- Deliverable: Add uncontested expense-revised and expense-voided chains.
- Acceptance:
  - Only the latest valid uncontested revision affects balances.
  - Every predecessor remains available to audit history.
  - Voids never delete source events.
  - Invalid revision and void references are diagnosed.

### DIV-015 — Detect and resolve concurrent revisions

- Status: BLOCKED
- Depends on: DIV-014
- Deliverable: Detect sibling revisions of one base and implement conflict-resolved semantics.
- Acceptance:
  - Competing branches do not silently win by timestamp, insertion order, or Automerge value.
  - The last uncontested revision stays effective until resolution.
  - A resolution references all branches it resolves.
  - Rejected branches remain auditable.

### DIV-016 — Return structured projection diagnostics

- Status: BLOCKED
- Depends on: DIV-015
- Deliverable: Return separate effective, pending, conflicting, quarantined, and unsupported collections with stable reason codes.
- Acceptance:
  - UI code never needs to parse an error string.
  - Invalid and unsupported events never affect effective balances.
  - Adding a previously missing dependency deterministically reclassifies affected events.

### DIV-017 — Add property tests

- Status: BLOCKED
- Depends on: DIV-016
- Deliverable: Generate bounded event sets and permutations to test zero-sum balances, idempotence, and order independence.
- Likely files: projector property tests; one lightweight test dependency only if justified
- Acceptance:
  - Fixed seeds make failures reproducible.
  - Generated cases include expenses, settlements, revisions, voids, duplicates, and conflicts.
  - A deliberately order-dependent projector change is caught.

## Phase 1C — put the domain behind the approved interface

### DIV-020 — Introduce typed local commands

- Status: BLOCKED
- Depends on: DIV-016
- Deliverable: Replace the controller's public arbitrary mutator with narrow commands while temporarily preserving the existing persisted Automerge shape.
- Likely files: src/group.js and command tests
- Acceptance:
  - UI-facing code cannot receive a mutable document or callback-based change function.
  - Commands validate before writing.
  - Existing persisted prototype data still loads.

### DIV-021 — Move existing UI onto typed commands

- Status: BLOCKED
- Depends on: DIV-020
- Deliverable: Route group settings, participant creation, and expense creation through the command API.
- Likely files: src/App.svelte, src/group.js, affected components
- Acceptance:
  - App.svelte and components contain no direct Automerge document mutation.
  - Existing unit and browser tests pass.
  - No visual redesign beyond what is required by the command boundary.

### DIV-022 — Build the responsive app shell

- Status: BLOCKED
- Depends on: DIV-006, DIV-007, DIV-021
- Deliverable: Implement the approved mobile-first Activity, Balances, and Group navigation plus persistent Add Expense action using current capabilities.
- Source: docs/design/calm-mobile-mock.html
- Acceptance:
  - Mobile and desktop use the same information architecture.
  - Group setup and backup move out of the daily Activity view.
  - Keyboard navigation, focus visibility, labels, and reduced-motion behavior work.
  - Browser tests continue to locate controls by accessible role/name.

### DIV-023 — Add settlement recording UI

- Status: BLOCKED
- Depends on: DIV-013, DIV-022
- Deliverable: Let a member record and reverse a manual settlement.
- Acceptance:
  - Record and reverse update balances and effective history.
  - Attribution placeholders are explicit until device identity exists.
  - Both operations survive reload.

### DIV-024 — Add revision and void UI

- Status: BLOCKED
- Depends on: DIV-014, DIV-022
- Deliverable: Add focused controls to revise or void an expense without overwriting it.
- Acceptance:
  - Normal history identifies effective state.
  - Audit data retains original, revisions, and voids.
  - A reason is captured for voiding.

### DIV-025 — Add conflict review UI

- Status: BLOCKED
- Depends on: DIV-015, DIV-022
- Deliverable: Show a calm review banner/inbox, competing revisions, and an explicit resolution action.
- Acceptance:
  - No branch is selected by visual order.
  - Balances keep the uncontested value until resolution.
  - Amount, payer, and split conflicts are understandable without CRDT terminology.

### DIV-026 — Add complete audit history

- Status: BLOCKED
- Depends on: DIV-023, DIV-024, DIV-025
- Deliverable: Pair the concise Activity feed with an audit view of all events, references, reasons, and diagnostics.
- Acceptance:
  - Superseded, voided, reversed, conflicting, pending, quarantined, and unsupported events are inspectable.
  - Effective history remains concise.
  - Tests cover navigation from a conflict or activity item to its audit chain.

### DIV-027 — Close the Phase 1 gate

- Status: BLOCKED
- Depends on: DIV-017, DIV-026
- Deliverable: Run the full local suite, fix only gate-blocking defects, and update Phase 1 status.
- Likely files: narrow fixes, ROADMAP.md, TASKS.md
- Acceptance:
  - Unit, property, build, and browser tests pass.
  - A deterministic fixture represents one week of group activity.
  - Every Phase 1 roadmap checkbox and completion condition is satisfied.

## Phase 2 — harden local CRDT persistence

### DIV-030 — Store events by ID in Automerge

- Status: BLOCKED
- Depends on: DIV-027
- Deliverable: Replace the persisted mutable event array with an ID-keyed map behind the domain API.
- Acceptance:
  - Projected behavior and UI remain unchanged.
  - Repeated insertion is idempotent.
  - No component knows the Automerge representation.

### DIV-031 — Migrate existing local documents

- Status: BLOCKED
- Depends on: DIV-030
- Deliverable: Add a retry-safe migration from legacy and event-array documents to the approved schema.
- Likely files: src/legacy.js, migration module, fixtures and tests
- Acceptance:
  - Every existing repository format has a fixture.
  - Migration loses no integer values or IDs.
  - Running migration twice makes no additional changes.

### DIV-032 — Merge restores instead of replacing

- Status: BLOCKED
- Depends on: DIV-031
- Deliverable: Change JSON restore to validate and union immutable events into a local replica.
- Acceptance:
  - An older backup cannot erase newer events.
  - Invalid data and ID/content collisions are reported before mutation.
  - Re-importing the same backup is idempotent.

### DIV-033 — Add a local group registry

- Status: BLOCKED
- Depends on: DIV-031
- Deliverable: Replace the single localStorage document ID with a local registry and connect the approved basic group switcher.
- Acceptance:
  - Two groups persist independently through reload.
  - Switching cannot leak events, balances, or participants.
  - Deleting or leaving groups is out of scope unless separately specified.

### DIV-034 — Test CRDT delivery pathologies

- Status: BLOCKED
- Depends on: DIV-032, DIV-033
- Deliverable: Exercise duplicate, reversed, delayed, missing-dependency, malformed, and incompatible events through Automerge rather than only through the pure projector.
- Acceptance:
  - Replicas converge on equal event sets, diagnostics, effective history, and balances.
  - Tests prove that Automerge ordering is never used as financial ordering.

### DIV-035 — Automate two-tab convergence

- Status: BLOCKED
- Depends on: DIV-034
- Deliverable: Add browser tests for offline edits in two tabs, reconnection, convergence, and explicit conflict resolution.
- Acceptance:
  - Neither tab requires a manual refresh.
  - Both tabs end with identical effective balances and audit state.
  - Test covers simultaneous independent expenses and competing revisions.

### DIV-036 — Manually close the Phase 2 gate

- Status: MANUAL
- Depends on: DIV-035
- Deliverable: Run the roadmap's two-tab scenarios in the supported desktop browsers and record results.
- Acceptance:
  - Human sign-off and observed browser versions are linked here.
  - Any discovered defect becomes a new narrowly scoped task.
  - Phase 2 is marked complete only after defects are closed.

## Later dependency-gated epics

Do not split or implement these until DIV-036 is complete. Reassess the code and divide one epic at a time so future tickets reflect what was actually learned.

### EPIC-100 — Device identity and membership

- Status: BLOCKED
- Depends on: DIV-036
- Required outcomes: separate participants/devices/organizers; browser-generated signing keys; signed events; ownership transfer and co-organizers; single-use participant invites; QR joining; causal revocation; future-key rotation; documented removal limitations.
- First action after unblocking: draft and approve the identity/membership ADR, then split implementation by event type and user flow.

### EPIC-200 — Replaceable encrypted internet relay

- Status: BLOCKED
- Depends on: EPIC-100
- Required outcomes: outbound secure WebSocket adapter; encrypted opaque updates; authenticated device access; retry and missed-update handling; compatibility negotiation; Go relay; Docker deployment; minimized metadata/logging; no WebRTC requirement in version one.
- First action after unblocking: approve wire protocol and test vectors before creating server code.

### EPIC-300 — Export and encrypted recovery

- Status: BLOCKED
- Depends on: EPIC-100
- Required outcomes: readable CSV/JSON export; passphrase-encrypted full backup; merge-based restore; wrong-passphrase safety; no recovery backdoor.
- First action after unblocking: specify the versioned backup container and golden fixtures.

### EPIC-400 — Splitwise import and release pilot

- Status: BLOCKED
- Depends on: EPIC-200, EPIC-300
- Required outcomes: CSV parsing; participant mapping; zero-sum preview; immutable opening-balance event; supported-browser and 20-member/5,000-event tests; three-day parallel run; remainder of two-week primary-use trial.
- First action after unblocking: collect sanitized representative CSV fixtures before implementing parsing.

## Frozen post-release work

Do not start these before the pilot gate. Re-grill and split each area when promoted.

- FROZEN: receipt storage and retention.
- FROZEN: itemized receipt claiming and historical suggestions.
- FROZEN: schema-validated natural-language expense drafts.
- FROZEN: receipt OCR drafts.
- FROZEN: accessibility, locale, and translation hardening beyond release blockers.
- FROZEN: consent-based reminders.
- FROZEN: payment links and regional payment-provider research.
