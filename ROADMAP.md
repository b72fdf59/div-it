# Div It roadmap

## First release goal

Replace Splitwise for one real private group: members join without accounts, import their starting balances, enter expenses offline, sync safely across devices, and record manual settlements. The app does not move money.

AI is post-release work. It will propose structured expense drafts and never change the ledger without human confirmation.

## Decisions already made

- MIT-licensed public project.
- Static PWA first; no required hosted backend.
- Svelte 5 components with Vite for local development and production builds. Do not add SvelteKit, React, or another state-management library.
- Browser data is local-first. Use one Automerge document per small group.
- Sync relay is optional and self-hosted. It is a public-HTTPS Go service that stores encrypted payloads, not readable ledger data.
- Membership is accountless: a device key plus secret invite link/QR. New devices are re-invited; removing a member rotates future group keys.
- Payments, including UPI, are future integrations only.
- AI uses a user-provided API key and returns a schema-validated draft. Manual entry must always work.

## Current state

The prototype supports local people, equal/exact expenses, balances, settlement suggestions, JSON backup/import, offline assets, and a developer seed script. It now stores one Automerge group document in IndexedDB and uses BroadcastChannel for same-browser-tab sync; this still needs manual two-tab verification.

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

Done when two browser tabs make offline edits, reconnect, converge, and produce the same balances.

### 3. Add optional self-hosted sync relay

1. Define group/device keys and secret-link/QR invite format.
2. Build a small Go relay that authenticates device keys and relays/stores encrypted CRDT updates.
3. Package relay with Docker Compose, public HTTPS deployment guide, and documented environment variables.
4. Support reconnect, missed updates, group-key rotation, and encrypted full backup recovery.

Done when two devices sync a group through a self-hosted relay, relay cannot read ledger contents, and removal prevents future-update access.

### 4. Reach Splitwise replacement gate

1. Import current balances from a user-uploaded Splitwise CSV; do not use its API.
2. Export readable CSV/JSON and encrypted full backup.
3. Add visible conflict resolution for concurrent amount, payer, or split revisions.
4. Test with one real group for two weeks: every member joins from own device, offline edits merge, and manual settlements close debts.

Done when that group can stop using Splitwise without data loss or incorrect balances.

### 5. Improve expense entry with AI

1. Add receipt attachment storage with creator-controlled retention.
2. Add itemized receipt claiming, then historical suggestions.
3. Add natural-language draft entry, such as “Dinner $80, split Anna, Bob, me”.
4. Add receipt OCR draft flow.
5. Validate AI output against an explicit schema; show confidence/warnings; require submitter confirmation.

Done when AI saves manual work without creating unreviewed debts.

### 6. Product hardening

1. Improve accessibility, locale-aware dates/currency, and translation-ready strings.
2. Add audited owner actions.
3. Add optional reminder notifications only after account/consent design exists.

### 7. Future integrations

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
