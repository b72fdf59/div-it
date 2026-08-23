# Div It roadmap

## Product goal

Build a private, self-hostable, local-first expense-sharing PWA. People enter expenses and agree on splits; the app calculates balances and settlement suggestions. It does not move money. AI proposes structured expense drafts and never changes the ledger without human confirmation.

## Decisions already made

- MIT-licensed public project.
- Static PWA first; no required hosted backend.
- Plain HTML, CSS, and ES modules for now. Do not add React, Vite, or a framework without a demonstrated need.
- Browser data is local-first. Automerge will replace the current local state when sync work starts.
- Sync relay is optional and self-hosted. It should store encrypted payloads, not readable ledger data.
- Payments, including UPI, are future integrations only.
- AI uses a user-provided API key and returns a schema-validated draft. Manual entry must always work.

## Current state

The prototype supports local people, equal/exact expenses, balances, settlement suggestions, IndexedDB persistence, JSON backup/import, offline assets, and a developer seed script.

It is not multi-tab live, multi-device, encrypted, or CRDT-backed yet. The current data model is temporary and exists to validate expense entry.

## Work order

### 1. Stabilize local ledger

1. Reproduce and fix reported “Add expense” failure.
2. Add a small browser-level smoke test for adding people and an expense.
3. Model immutable events: `expense-created`, `expense-revised`, `settlement-recorded`, and `settlement-reversed`.
4. Keep money in integer minor units; retain original currency and optional locked exchange rate.
5. Add a visible history/revision view. Never silently overwrite an expense.

Done when a real group can enter and verify a week of expenses without losing or miscalculating data.

### 2. Add local CRDT sync

1. Add Automerge and its IndexedDB storage adapter.
2. Use one Automerge document per group; keep groups small.
3. Replace direct state writes with `doc.change(...)` event writes.
4. Add `BroadcastChannel` adapter so two tabs of same browser update without refresh.
5. Display domain conflicts for concurrent amount, payer, or split revisions. Do not accept automatic last-write-wins for money fields.

Done when offline edits in two tabs converge and produce same balances.

### 3. Add optional self-hosted sync relay

1. Define group/device keys and invite flow before choosing transport.
2. Build a small Go relay that authenticates group access and relays/stores encrypted CRDT updates.
3. Package relay with Docker Compose and documented environment variables.
4. Support reconnect, missed updates, and encrypted full backup recovery.

Done when two devices sync a group through a self-hosted relay and relay cannot read ledger contents.

### 4. Improve expense entry

1. Add receipt attachment storage with creator-controlled retention.
2. Add itemized receipt claiming, then historical suggestions.
3. Add natural-language draft entry, such as “Dinner $80, split Anna, Bob, me”.
4. Add receipt OCR draft flow.
5. Validate AI output against an explicit schema; show confidence/warnings; require submitter confirmation.

Done when AI saves manual work without creating unreviewed debts.

### 5. Product hardening

1. CSV balance import from Splitwise exports.
2. Export readable CSV/JSON and encrypted full backup.
3. Improve accessibility, locale-aware dates/currency, and translation-ready strings.
4. Add group roles, removal, key rotation, and audited owner actions.
5. Add optional reminder notifications only after account/consent design exists.

### 6. Future integrations

1. Create payment-link abstraction with manual settlement confirmation.
2. Research regional requirements before UPI or other payment-provider integration.
3. Keep payment-provider authorization and compliance outside the core ledger.

## Agent rules

- Read this file and existing code before changing architecture.
- Prefer deletion and native browser APIs over new dependencies.
- Do not add backend services before their phase.
- Do not store floating-point money values.
- Do not let AI mutate the ledger directly.
- Do not turn CRDT merge behavior into silent money decisions.
- Update this roadmap when a phase materially changes or completes.
