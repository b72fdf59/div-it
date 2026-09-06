# ADR 0001: Version-one domain event format

- Status: Accepted
- Date: 2026-09-05
- Scope: structural event format and projection rules
- Decision owners: Div It maintainers and the first pilot group

## Context

Div It needs an immutable ledger that can be written offline, replicated in any arrival order, and projected to the same balances on every device. Automerge is already used by the prototype, but it must remain a replaceable transport and persistence layer. It must not choose a winning financial value when domain events conflict.

The format below defines the version-one domain event. It does not select a signing algorithm, key type, encryption algorithm, or relay protocol. Those decisions belong to later identity and synchronization work.

## Decision

The source ledger is a set of immutable events keyed by `id`. An event is accepted only after structural validation and, once identity exists, signature and membership validation. A valid event is never edited or deleted. A correction is a new event that references the event it corrects.

### Version policy

- `schemaVersion` describes the shape and semantics of this event. Version one is `1`.
- `protocolVersion` describes the envelope and replication protocol understood by the client. The first protocol version is `1`.
- A client reads version `1` and preserves unknown raw events. A newer unsupported money-affecting version makes the client read-only; it must not display a knowingly incomplete balance as correct.
- Future compatible versions add fields or event types. They do not reinterpret an existing event or mutate old events.

### Common envelope

Every event has exactly these required fields:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "type": "expense-created",
  "schemaVersion": 1,
  "protocolVersion": 1,
  "groupId": "22222222-2222-4222-8222-222222222222",
  "author": {
    "participantId": "participant-alice",
    "deviceId": "device-alice-phone",
    "keyId": "key-device-alice-phone-v1"
  },
  "createdAt": "2026-09-05T10:00:00.000Z",
  "dependsOn": [],
  "payload": {},
  "signature": "base64url-signature-without-padding"
}
```

Envelope rules:

- `id`, `groupId`, and every dependency reference are lowercase canonical UUID strings. The UUID must be syntactically valid; uniqueness is enforced within the group.
- `type` is one of the seven version-one types listed below. Any other value is `unsupported-event-type`.
- `schemaVersion` and `protocolVersion` are positive JSON integers. Money-affecting events with a version the client cannot interpret are unsupported, not partially projected.
- `author.participantId`, `author.deviceId`, and `author.keyId` are non-empty, case-sensitive identifiers of at most 128 UTF-8 characters. The participant and device must be known to membership validation once membership exists.
- `createdAt` is RFC 3339 UTC text. It is display metadata only. It never orders events, resolves revisions, or decides a balance.
- `dependsOn` is an array of unique event IDs in lexicographic order. It cannot contain the event's own ID. A dependency that is not present leaves the event pending; it does not make the event invalid forever.
- `payload` is an object matching the selected type. Unknown semantic fields are rejected for this version; preserved future extensions must live in an explicitly namespaced extension field.
- `signature` is base64url text without padding. Its algorithm and verification rules are intentionally deferred. Structural validation must still require the field and later identity validation must classify a failed signature as `unauthenticated`.
- An encoded event is at most 65,536 UTF-8 bytes. `dependsOn` and every payload collection contain at most 256 entries, signatures contain at most 512 base64url characters, and timestamps use at most nine fractional-second digits. Larger inputs are quarantined as `event-too-large` before projection.

### Canonical signed content

The signature covers the complete envelope except the `signature` field itself. The signing input is the UTF-8 encoding of the JSON Canonicalization Scheme representation of that unsigned envelope (JCS / RFC 8785). This makes equivalent object-key insertion orders produce identical signed content.

The following are therefore part of signed content:

- event identity, type, schema and protocol versions;
- group, participant, device, and key attribution;
- display timestamp and dependency references;
- every payload value, including the order of split entries where order is semantically retained.

Implementations must not sign a parsed error message, an Automerge change, a mutable balance, or a serialization with the signature field included. A verifier first canonicalizes and verifies the envelope, then validates its domain semantics.

## Payload schemas

All money values are integer minor units, never floating-point amounts. `currency` is an uppercase three-letter ISO 4217 code and must match the group's one configured currency. A participant ID in a payload must refer to a group participant during membership validation.

### `expense-created`

```json
{
  "expenseId": "33333333-3333-4333-8333-333333333333",
  "description": "Dinner",
  "currency": "USD",
  "amount": 2000,
  "payerId": "participant-alice",
  "splits": [
    { "participantId": "participant-alice", "amount": 1234 },
    { "participantId": "participant-bob", "amount": 766 }
  ]
}
```

`expenseId` is the stable logical expense identity. `description` is trimmed, non-empty, and bounded to 500 Unicode characters. `amount` and every split amount are positive safe integers. Split participant IDs are unique and their amounts must sum exactly to `amount`. The payer may be included in the split and pays only that participant's share.

Exactly one `expense-created` envelope may introduce an `expenseId`. Any additional creator with a different envelope ID is quarantined as `logical-id-content-collision`, even when its payload matches. Dependent expense events cannot become effective until the collision is removed from the trusted event set.

### `expense-revised`

```json
{
  "expenseId": "33333333-3333-4333-8333-333333333333",
  "supersedesEventId": "11111111-1111-4111-8111-111111111111",
  "description": "Dinner with dessert",
  "currency": "USD",
  "amount": 2400,
  "payerId": "participant-alice",
  "splits": [
    { "participantId": "participant-alice", "amount": 1440 },
    { "participantId": "participant-bob", "amount": 960 }
  ]
}
```

`supersedesEventId` must be in `dependsOn` and must be the current uncontested event for the same `expenseId` when the revision is created. The rest of the payload follows `expense-created`. A revision never edits its predecessor.

### `expense-voided`

```json
{
  "expenseId": "33333333-3333-4333-8333-333333333333",
  "supersedesEventId": "44444444-4444-4444-8444-444444444444",
  "reason": "Restaurant refunded the charge"
}
```

`supersedesEventId` must be in `dependsOn` and must identify the current uncontested expense-created or expense-revised event. `reason` is trimmed, non-empty, and bounded to 500 Unicode characters. A void contributes no expense balances but retains the full source chain for audit.

### `settlement-recorded`

```json
{
  "settlementId": "55555555-5555-4555-8555-555555555555",
  "currency": "USD",
  "fromParticipantId": "participant-bob",
  "toParticipantId": "participant-alice",
  "amount": 766,
  "note": "Paid by bank transfer"
}
```

`fromParticipantId` and `toParticipantId` must differ. `amount` is a positive safe integer. A settlement is a standalone manual transfer and may have no dependencies; it changes only the named participants. The optional `note` is trimmed and bounded to 500 Unicode characters. A settlement reduces the sender's debt and the recipient's credit, preserving zero-sum.

### `settlement-reversed`

```json
{
  "settlementId": "55555555-5555-4555-8555-555555555555",
  "reversesEventId": "66666666-6666-4666-8666-666666666666",
  "reason": "Transfer was returned"
}
```

`reversesEventId` must be in `dependsOn` and must identify one `settlement-recorded` event. The reversal has no independent amount; it exactly neutralizes the named settlement. `settlementId` must match the referenced settlement.

One or more valid reversals of the same settlement are financially equivalent and neutralize that settlement exactly once. Concurrent reversal events remain in the audit history, including their distinct authors and reasons, but redundant reversals are reported as `duplicate-reversal-ignored` and never apply another inverse contribution. This rule depends only on the complete event set, not arrival order.

### `opening-balances-imported`

```json
{
  "importId": "77777777-7777-4777-8777-777777777777",
  "currency": "USD",
  "sourceFormat": "splitwise-csv",
  "balances": [
    { "participantId": "participant-alice", "amount": 766 },
    { "participantId": "participant-bob", "amount": -766 }
  ]
}
```

An opening balance is a signed participant balance: positive means the participant is owed money; negative means the participant owes money. Each participant appears at most once, every amount is an integer safe value, and the sum must be exactly zero. The import records only the mapped opening balances; it never invents historical expenses. Any source-file fingerprint is metadata outside this version-one payload until its digest algorithm is selected.

`importId` identifies one logical import. Different envelopes using the same `importId` are quarantined as `logical-id-content-collision`, even when their payloads match.

### `conflict-resolved`

```json
{
  "resolutionId": "88888888-8888-4888-8888-888888888888",
  "expenseId": "33333333-3333-4333-8333-333333333333",
  "resolvesEventIds": [
    "99999999-9999-4999-8999-999999999999",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
  ],
  "chosenEventId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "supersedesResolutionEventIds": [],
  "note": "Confirmed the receipt total with both members"
}
```

`resolvesEventIds` contains at least two unique sibling revision event IDs, is sorted lexicographically, and every ID is in `dependsOn`. `chosenEventId` must be one of those branches. All resolved events must target the same `expenseId`; a resolution cannot silently introduce a new payload. Any current member may author a resolution under membership rules. Rejected branches remain in audit history.

`supersedesResolutionEventIds` is a sorted array of unique `conflict-resolved` event IDs and every ID it contains must also be in `dependsOn`. It is empty for the first attempt to resolve a revision fork. If concurrent resolutions of the same complete `resolvesEventIds` set choose different branches, none wins and the last uncontested expense remains effective. A later resolution must name every competing resolution in `supersedesResolutionEventIds` and choose one of the original branches. Concurrent resolutions that choose the same branch are semantically equivalent and make that branch effective once. Resolution attempts that name different revision sets do not resolve one another.

`resolutionId` identifies one logical resolution attempt. Different envelopes using the same `resolutionId` are quarantined as `logical-id-content-collision`, even when their payloads match.

## Projection and delivery rules

### Validation stages

1. Parse the raw event without mutating it.
2. Validate the envelope and payload structure.
3. Verify the signature and author membership when identity support exists.
4. Check referenced events and dependencies.
5. Apply the event to the deterministic projection only when all required checks pass.

Invalid, unauthenticated, and invariant-breaking events are quarantined. Missing-dependency events are pending and may become effective when the dependency arrives. The last valid projection remains active, and the UI receives a stable diagnostic code rather than needing to parse an error string.

The projector requires an authorization function supplied by the identity layer and fails closed when it is absent, throws, or does not explicitly approve an event. Until cryptographic identity support exists, test and prototype callers may provide an explicit development-only authorization function; production synchronization must not do so.

Unsupported versions and event types are reported separately from quarantined input and make the projection read-only. The last understood balance may remain visible, but the UI must label it incomplete rather than presenting it as current.

### Duplicates and ID collisions

- An exact duplicate means the same `id` and identical signed content. It is applied once and reported as `duplicate-ignored`.
- If one ID appears with two or more distinct signed contents, it is an `id-content-collision`. No variant with that ID is effective, regardless of arrival order. All variants remain available for diagnostics and audit.
- A duplicate dependency or duplicate split participant is invalid input, not a second application.

Logical identifiers have an additional collision rule. `expenseId` identifies one expense chain, `settlementId` one settlement and its reversals, `importId` one opening-balance import, and `resolutionId` one resolution attempt. Events that legitimately revise, void, or reverse an existing logical object reuse its logical ID and reference its predecessor. Two creator envelopes with the same logical ID are both quarantined as `logical-id-content-collision`, regardless of whether their payloads match. Only delivery of the same envelope ID and signed content is a duplicate. This classification is based on the complete set and is independent of arrival order.

### Reordering and missing dependencies

Independent events may arrive in any order. The projector operates on the complete ID-keyed set, not insertion order. A pending event is reconsidered whenever its dependency set changes. Adding a previously missing dependency can reclassify an event from pending to effective, conflicting, or quarantined deterministically.

### Revisions and concurrent branches

An uncontested revision is effective only when its predecessor is valid and no sibling revision exists for that predecessor. If two valid revisions supersede the same base, neither wins by timestamp, insertion order, Automerge value, or device ID. The last uncontested event before the fork remains effective while the fork is unresolved, and the branches are reported as conflicting. A valid, uncontested `conflict-resolved` event that names every sibling makes exactly its `chosenEventId` branch effective. Conflicting resolution attempts keep the pre-fork expense effective until another resolution explicitly supersedes every competing attempt. Rejected branches and resolution attempts remain auditable.

### Zero-sum invariant

Every effective event contributes a net zero balance:

- an expense adds `amount` to the payer and subtracts each split amount;
- a settlement adds `amount` to the sender and subtracts it from the recipient;
- a settlement reversal applies the exact inverse of its settlement;
- an opening-balance import is accepted only when all signed balances sum to zero;
- revisions and voids replace or remove the effective contribution of a prior expense without deleting its event;
- conflict resolution changes which already-validated branch contributes, never the arithmetic itself.

The projector must assert this invariant in tests and quarantine any event or event combination that would violate it.

## Automerge boundary

The domain representation is the plain event envelope above. Automerge may store it as an ID-keyed map, replicate changes, persist updates, and notify the application that new raw events are available. It must not be the source of event ordering, signature content, revision winner selection, or computed balances.

The first release must not compact or destructively rewrite these events. A future checkpoint is a separate signed, versioned migration decision. Export, backup, and relay code preserve raw event bytes and unknown event data even when the current client cannot project it.

## Invalid examples and stable reason codes

These examples describe the minimum diagnosis surface for validators and tests:

| Example | Reason code | Handling |
| --- | --- | --- |
| `amount: 10.5` or `amount: "100"` | `invalid-money` | Quarantine |
| Split amounts sum to 1999 for an amount of 2000 | `split-total-mismatch` | Quarantine |
| Two splits use the same participant ID | `duplicate-participant` | Quarantine |
| Opening balances sum to 1 cent | `non-zero-sum` | Quarantine |
| `dependsOn` names an absent event | `missing-dependency` | Pending |
| Dependency graph contains or reaches a cycle | `cyclic-dependency` | Quarantine cycle-blocked events |
| Revision points to a different expense | `invalid-reference` | Quarantine |
| Reversal points to a non-settlement | `invalid-reference` | Quarantine |
| Concurrent or later reversal of an already reversed settlement | `duplicate-reversal-ignored` | Preserve; neutralize once |
| Two payloads use the same event ID | `id-content-collision` | Quarantine all variants |
| Different creator envelopes reuse one logical ID | `logical-id-content-collision` | Quarantine all competing creators |
| Event type is not one of the seven supported types | `unsupported-event-type` | Preserve; read-only if money-affecting |
| Schema or protocol version is unsupported | `unsupported-version` | Preserve; read-only if money-affecting |
| Signature is absent or fails verification | `unauthenticated` | Quarantine |
| Event or collection exceeds its resource limit | `event-too-large` | Quarantine |
| Two revisions supersede one base concurrently | `conflicting-revision` | Keep last uncontested projection; require resolution |
| Resolution omits one sibling or chooses an external ID | `invalid-resolution` | Quarantine |
| Concurrent resolutions choose different branches | `conflicting-resolution` | Keep last uncontested projection; require superseding resolution |

## Consequences

This format makes duplicate and reordered delivery safe and keeps financial meaning in a testable domain projector. It requires clients to preserve raw unsupported data and to expose pending, conflicting, quarantined, and unsupported states. It also means an old client cannot safely continue editing when it cannot understand a money-affecting event.

The format intentionally leaves cryptographic algorithms and key lifecycle decisions open. Identity, invitation, key rotation, and encrypted relay work must reference this envelope rather than silently changing it.

## Approval gate

The exact field names, reference semantics, canonicalization rule, and conflict behavior were approved by the project owner on 2026-09-05. DIV-003 is complete and event-envelope implementation may proceed.
