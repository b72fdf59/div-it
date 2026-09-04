# Div It roadmap

## Product goal

Replace Splitwise for one real private group before generalizing the product. A technically capable organizer manages setup and infrastructure; ordinary members join without accounts, import starting balances, enter expenses offline, sync safely across devices, and record manual settlements. The app records debts but does not move money.

The first release is a product for that group and, secondarily, an MIT-licensed reference for local-first engineering. It is not yet a zero-operations service for arbitrary nontechnical groups.

AI and payment integrations are post-release work. AI may propose schema-validated drafts but must never change the ledger without human confirmation. Manual entry must always work.

## First-release boundary

- One currency per group; all money uses integer minor units.
- Equal and exact expense splits.
- Immutable expenses, revisions, voids, settlements, settlement reversals, conflict resolutions, and imported opening balances.
- Readable history plus a complete audit history.
- Splitwise CSV opening-balance import with preview, participant mapping, zero-sum validation, and explicit confirmation. Do not use the Splitwise API or invent historical expenses.
- Readable CSV/JSON export and a passphrase-encrypted full recovery backup.
- Offline use, same-browser synchronization, and encrypted multi-device synchronization through an optional self-hosted relay.
- Accountless membership with participants distinct from their authorized devices.
- A basic group registry and switcher, backed by one Automerge document per group.
- Current and previous major Safari/iOS, Chrome/Android, Chrome, Edge, and Firefox. PWA installation is optional.
- Initial supported envelope: at most 20 members and approximately 5,000 events per group.

Deferred until after the first release: cross-currency expenses and exchange rates, receipt storage and AI entry, hosted relay service, large-group claims, payment links, and payment-provider integrations.

## Architecture contract

### Ledger

- The source data is an ID-keyed set of immutable, versioned domain events, not mutable balances or an ordered event array.
- Initial event types are `expense-created`, `expense-revised`, `expense-voided`, `settlement-recorded`, `settlement-reversed`, `opening-balances-imported`, and `conflict-resolved`.
- Revisions and reversals reference the events they supersede. Never destructively delete or silently overwrite ledger history.
- UI components call typed commands such as `createExpense`, `reviseExpense`, and `recordSettlement`. Only the domain layer may validate and append events.
- Every ledger and membership event identifies its participant and device and is signed by the originating device.
- Validate events before appending and again when projecting replicated data. Quarantine unknown, malformed, unauthenticated, or invariant-breaking events; keep the last valid projection active and show a visible error.
- Compute balances through a deterministic projection. Device timestamps are display-only and must never resolve financial meaning.
- Independent events may arrive in any order. Events with missing dependencies remain pending. Repeated events with the same ID and signed payload are ignored; an ID reused with different content is quarantined.
- Concurrent revisions of an amount, payer, or split are a domain conflict. Keep the last uncontested revision effective until a member explicitly resolves the competing branches. Any current member may create an attributed resolution; rejected branches remain in audit history.
- Every projection must preserve the zero-sum balance invariant.

### CRDT and compatibility

- Automerge is a replaceable replication and persistence layer around domain events. It does not decide which financial value wins.
- Device-owned CRDT state is authoritative. The relay is an untrusted encrypted mailbox/cache, not a ledger server.
- Local writes remain available during relay outages. Duplication and reordering are tolerated, but eventual delivery from another device or recovery backup is still required after permanent data loss.
- Do not compact event history in the first release. Consider explicit signed checkpoints only if tests near 5,000 events demonstrate a real need.
- Prefer additive schema changes. Events remain immutable and carry a schema version.
- New clients read the current and a bounded number of older protocol versions. After the first release, target the current and two previous versions.
- A client that encounters an unsupported money-affecting event becomes read-only and requests an update; it must preserve unknown data and never show a knowingly incomplete balance as correct.
- Breaking protocol upgrades are explicit. Retiring old readers may eventually use a deliberate checkpoint migration, never an incidental rewrite during synchronization.

### Membership, security, and recovery

- The group creator is the initial organizer. Ownership is transferable, and organizers may appoint co-organizers.
- Organizers manage invitations, devices, removals, key rotation, and recovery. Ordinary members may manage ledger entries but not membership or keys.
- A participant may authorize multiple devices. Removing a device does not remove the participant or their history.
- Invitations are single-use, participant-specific, authorize one device, expire after 24 hours by default, and can be revoked before use.
- Removing a participant or device rotates future group keys. Previously downloaded history cannot be remotely erased; state this limitation clearly.
- Events causally established before revocation remain valid. Concurrent or later events from the removed device are quarantined, even if created offline; an organizer may recreate legitimate rejected activity.
- The encrypted recovery backup contains the group document, cryptographic material, and format version. Restoring merges immutable events into a local replica; it does not replace or erase newer history.
- A forgotten backup passphrase cannot be recovered, and the relay has no recovery backdoor.
- Minimize relay logs and document observable metadata, including IP addresses, group identifiers, update sizes, and timing. Do not claim metadata privacy.
- First-release threat model: defend against an untrusted relay, network attackers, accidental conflicts, buggy clients, and lost devices. A deliberately malicious authorized member is out of scope and must be documented as such.

## Current state

The prototype supports local people, equal and exact expenses, integer-minor-unit balances, settlement suggestions, JSON backup/import, offline assets, and a developer seed script. The reported add-expense failure has an implementation fix, and the small ledger check passes.

Automerge Repo, IndexedDB storage, and BroadcastChannel synchronization have already been introduced. This is partial Phase 2 work, not a completed sync architecture: the app currently keeps one document ID in `localStorage`, exposes arbitrary document mutation, stores events in a mutable array, and can replace the document during backup import. Same-browser two-tab behavior still needs manual and automated verification.

The product does not yet have the complete event model, revisions, voids, recorded settlements, opening-balance import, conflict handling, participant/device membership, signatures, encryption, multi-device relay, recovery flow, browser smoke tests, or a real-group trial.

## Work order

Work phases in order. A later phase may contain prototype code, but do not expand it while an earlier gate is incomplete.

Execution-sized tasks, dependencies, and acceptance checks live in [TASKS.md](./TASKS.md).

### 1. Stabilize the local ledger — active

- [x] Fix the reported add-expense failure.
- [ ] Add an automated browser smoke test covering people, equal/exact expenses, reload, and backup round-trip; retain the add-expense case as a regression test.
- [ ] Replace arbitrary `change(mutator)` calls with a typed domain command boundary.
- [ ] Define versioned event envelopes, IDs, dependencies, validation, and deterministic projection independently of Automerge.
- [ ] Implement expense revision/void, settlement/reversal, and complete audit-history views.
- [ ] Add tests for every event type and revision chain plus property tests that balances always sum to zero.
- [ ] Quarantine invalid and dependency-missing events without corrupting the last valid projection.

Done when the ledger can represent and verify a week of single-currency activity, every change is auditable, and tests demonstrate deterministic balances independent of insertion order or duplication.

### 2. Harden local CRDT persistence — partial prototype exists

- [x] Introduce Automerge Repo with IndexedDB and BroadcastChannel adapters.
- [ ] Replace the mutable event array with ID-keyed immutable domain events behind the command boundary.
- [ ] Add a local group registry and basic switcher while retaining one Automerge document per group.
- [ ] Make restore merge event sets rather than replace a live document.
- [ ] Test duplicate, reversed, delayed, dependency-missing, malformed, and incompatible events.
- [ ] Automate two-tab offline edits, reconnection, convergence, conflict display, and equal projections.
- [ ] Manually verify the same scenarios in two tabs before proceeding.

Done when two browser tabs can edit offline, reconnect, converge on identical valid event sets and balances, and expose every money conflict for explicit resolution.

### 3. Add device identity and membership

- [ ] Separate participant, device, and organizer identities.
- [ ] Generate per-device signing keys and sign all ledger and membership events.
- [ ] Implement ownership transfer and optional co-organizers with audited actions.
- [ ] Implement single-use, participant-specific, expiring invite links and QR codes.
- [ ] Implement device/participant removal, causal revocation checks, and group-key rotation.
- [ ] Document that removal cannot erase history already downloaded to another device.

Done when multiple devices have attributable events, only organizers can change membership, expired/revoked invites fail, and removed devices cannot read future updates or contribute accepted concurrent/later events.

### 4. Add the optional self-hosted relay and recovery

- [ ] Define the encrypted synchronization protocol and compatibility/version negotiation.
- [ ] Build a small public-HTTPS Go relay that authenticates devices and stores/relays only encrypted CRDT updates.
- [ ] Tolerate retries, duplication, reordering, reconnects, and missed updates; surface permanent gaps rather than hiding them.
- [ ] Package the relay with Docker Compose, deployment instructions, environment variables, minimized logging, and backup guidance.
- [ ] Add readable CSV/JSON export and passphrase-encrypted full backup/restore without a recovery backdoor.
- [ ] Test two-device encrypted synchronization, relay blindness, metadata documentation, outage recovery, key rotation, and backup restoration.

Done when two devices synchronize through the self-hosted relay, the relay cannot read or forge ledger contents, local work continues during outages, removal blocks future access, and an encrypted backup can recover the group.

### 5. Reach the Splitwise replacement gate

- [ ] Import a user-uploaded Splitwise CSV as a previewed, mapped, zero-sum `opening-balances-imported` event.
- [ ] Validate supported browsers and the 20-member/5,000-event envelope.
- [ ] Reconcile imported balances with one real group.
- [ ] Run Div It and Splitwise in parallel for three days and resolve every discrepancy.
- [ ] Use Div It as the primary ledger for the remainder of a two-week trial while retaining exports from both systems.
- [ ] Verify that every member joins from their own device, offline edits merge, conflicts are resolved visibly, manual settlements close debts, and recovery instructions are usable.

The first release is ready only when all automated ledger/property/browser tests pass, manual two-tab and two-device encrypted-relay tests pass, and the pilot completes with no unexplained balance discrepancy or unrecoverable data loss.

### 6. Improve expense entry with AI — post-release

1. Add receipt attachment storage with creator-controlled retention.
2. Add itemized receipt claiming, then historical suggestions.
3. Add natural-language draft entry, such as “Dinner $80, split Anna, Bob, me”.
4. Add receipt OCR draft flow.
5. Validate AI output against an explicit schema; show confidence and warnings; require submitter confirmation.

Done when AI saves manual work without creating unreviewed debts.

### 7. Product hardening and future integrations

1. Improve accessibility, locale-aware dates/currency, and translation-ready strings.
2. Add optional reminder notifications only after account and consent design exists.
3. Create a payment-link abstraction with manual settlement confirmation.
4. Research regional requirements before UPI or another payment-provider integration.
5. Keep payment-provider authorization and compliance outside the core ledger.

## Agent rules

- Read this file and the existing code before changing architecture.
- Follow the work order and update phase status when material work lands.
- Prefer deletion and native browser APIs over new dependencies.
- Do not add backend services before their phase.
- Do not store floating-point money values.
- Do not allow arbitrary UI-layer Automerge mutation.
- Do not let CRDT merge behavior, timestamps, or AI make silent money decisions.
- Do not destructively rewrite ledger history.
- Do not claim security, privacy, compatibility, or scale beyond the tested boundaries above.
