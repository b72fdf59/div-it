# ADR 0002: Device identity and group membership

- Status: Draft — product rules below are confirmed; technical recommendations remain pending root review and ADR approval. Owner deferred human sign-off until first-release implementation is complete on 2026-10-07. Root technical review and automated acceptance are required per implementation slice.
- Date: 2026-10-07
- Scope: participant, device, and organizer identity; signed events; invites; authorization; revocation; key lifecycle.
- Decision owners: Div It maintainers and the first pilot group.
- Relationship: extends [ADR-0001](./0001-event-format.md). ADR-0001 remains authoritative for v1 ledger payloads, JCS canonicalization, and deterministic financial projection.

## Context

The local prototype has participant IDs and placeholder event authorship, but no cryptographic identity or membership authority. Its local `people` list cannot authorize replicated events. Offline edits, duplicated delivery, and concurrent membership changes must converge without relying on `createdAt`, which ADR-0001 defines as display-only.

This draft separates confirmed product rules from proposed technical details. Product rules were confirmed during the design review. Field names, protocol bounds, and migration encoding are recommendations for root technical review, not approved protocol facts.

## Confirmed product rules

- Participants are distinct from devices. One participant may authorize multiple devices. A device has a distinct signing key and attribution.
- The group creator's participant begins as owner. Only the owner can grant or revoke organizer status and transfer ownership. Active organizers can manage join requests and remove participants/devices.
- Invitations target one participant. They create device-key-bound signed join requests. A request grants no access until an active organizer signs an approval. Any active organizer may approve, including approval of an additional device for an existing participant; enrolling a device for the owner participant also requires an active owner-device signature.
- Invite expiry is ordinary joining UX. It must never make authorization depend on the verifier's current clock or retroactively invalidate an approval. The signed organizer approval determines enrollment.
- Multiple join requests may exist for one copied invitation; an organizer selects one request to approve. An invitation authorizes at most one distinct device enrollment. Concurrent approvals of different requests with the same `inviteId` remain pending until the owner resolves which request wins. A participant's additional device requires a new invitation. Different invite IDs are independent.
- Independent concurrent membership changes combine. Removal wins over concurrent enrollment. Participant and device removals are tombstones; history remains.
- Ownership transfer requires acceptance by the named recipient. A removed recipient cannot accept. Conflicting concurrent transfers leave the current owner in place pending owner resolution.
- There is no automatic co-organizer takeover if all owner devices are lost in v1. This can permanently lock membership administration; document this plainly. Re-enrollment of the owner's participant by a co-organizer is not an implicit ownership transfer.
- Revocation retains events in the signed causal frontier observed by the remover. Unseen offline events from the removed key are quarantined and auditable. Only an organizer may explicitly adopt legitimate rejected expense activity, as a new event linked to the original and carrying approver attribution. The adoption must not double-count the original.
- Legacy activation is explicit and requires an owner-reviewed signed attestation. It preserves raw legacy bytes and labels old authorship unverified.

## Proposed technical decision

### Signing keys and canonical records

- Recommendation: use one verified signing algorithm in v1, Ed25519 via Web Crypto. Generate a fresh key pair per device with `crypto.subtle.generateKey("Ed25519", false, ["sign", "verify"])`; the private key is non-extractable and stays in local browser storage. The public key is stored in signed membership records. If any supported browser lacks this exact capability or fails the known-answer tests, block identity activation in that browser; do not silently fall back to another algorithm. This is a browser support gate, not an assertion that every browser supports Ed25519. W3C Web Cryptography Level 2 specifies Ed25519 operations; RFC 8032 provides the algorithm definition and test vectors. [W3C Web Cryptography Level 2](https://www.w3.org/TR/WebCryptoAPI/), [RFC 8032](https://www.rfc-editor.org/rfc/rfc8032.html)
- Continue signing ledger v1 envelopes over JCS of the full envelope without `signature`, as specified in ADR-0001. Membership records use the same canonicalization and include a `recordType` in signed content. Public keys, participant/device/key IDs, group ID, dependencies, payload, and membership references are all signed.
- DIV-101 API contract: `canonicalJsonBytes(value)` returns RFC 8785 bytes as UTF-8 and throws on values outside the JSON/I-JSON domain; `signedRecordBytes(record)` returns those bytes after omitting only the top-level `signature` property, without mutating the input. `generateDeviceSigningKeyPair()` returns a non-extractable private key and extractable public key; `exportDevicePublicKey(key)` returns the raw 32-byte public key. `signRecord(record, privateKey)` returns a 64-byte Ed25519 signature encoded as unpadded base64url. `verifyRecord(record, publicKey)` returns false for malformed or invalid signatures; unsupported key types/algorithms and unavailable Web Crypto Ed25519 fail closed with errors. No algorithm fallback is permitted.
- Non-extractability limits key export through Web Crypto but does not stop injected same-origin script from requesting a signature. Keep this threat in the first-release security documentation. The relay never grants identity or authorization.
- Use immutable membership records in an ID-keyed set. Automerge transports/stores them but does not decide membership state. Projection uses the complete available record set and classifies missing references as pending, conflicting transitions as pending/conflict, and invalid signatures or unauthorized records as quarantined.

### Genesis and verification without circular trust

- A `group-created` genesis record is signed by the creator's first device key and contains the group ID, owner participant/device/key IDs, owner public key, initial participant, currency, and genesis membership head. Its `membershipHeads` and `causalHeads` are empty; after local creation or explicit bootstrap trust, its own ID is the initial head in both DAGs. This is the sole self-signed trust anchor. It authorizes only itself and the initial owner/device; it cannot be accepted merely because the signature verifies.
- A group created locally trusts the exact genesis record it just created. A joining device receives genesis and the membership chain with invite/bootstrap data, then accepts them only after the organizer-signed approval pins the genesis record ID and group ID and the user confirms the group name, ID, and genesis-key fingerprint. A backup for an unknown group uses the same trust-on-first-use comparison. A self-signature or organizer approval alone cannot authenticate an unknown genesis key; a relay cannot replace a previously pinned genesis record.
- Verification order: (1) parse and size-check raw record; (2) for genesis, verify self-signature, schema, and creator binding then apply the local creation/approved-bootstrap trust rule; for later records, resolve signer key from the membership projection at the named `membershipHeads`; (3) verify signature over canonical bytes; (4) verify transition authorization and references; (5) project. Do not require an enrolled signer to validate the record that enrolls that signer: a join request is verified with its included proposed public key, and the organizer-signed approval enrolls that exact key only after validating the request signature and invite.

### Recommended record shapes and signed envelope

These are concrete proposed fields for review, not approved schema. Membership records use the following envelope; `createdAt` remains display-only.

```json
{
  "id": "<uuid>",
  "recordType": "device-join-request",
  "membershipSchemaVersion": 1,
  "protocolVersion": 2,
  "groupId": "<uuid>",
  "author": { "participantId": "<id>", "deviceId": "<id>", "keyId": "<id>" },
  "createdAt": "<RFC3339 UTC display value>",
  "membershipHeads": ["<sorted unique membership record IDs>"],
  "causalHeads": ["<sorted unique observed signed event IDs>"],
  "dependsOn": ["<sorted unique direct references>"],
  "payload": {},
  "signature": "<base64url signature>"
}
```

For a join request, `author` is the proposed participant/device/key identity and the payload includes `inviteId`, participant ID, and the proposed public key. The device signs the request using that key. It does not include the bearer token or a reusable token verifier. The organizer validates the bearer token privately in the local UI, checks the target participant and request, then signs `device-enrollment-approved` binding the invite ID, request ID, participant ID, device ID, key ID, public key fingerprint, and bootstrap genesis ID. Replicas trust the organizer's signed approval only after validating the organizer's key through the pinned genesis chain; no secret is needed to validate it. The approval is the enrollment event and is itself authored by the organizer's enrolled key.

### Membership heads, concurrent changes, and causal revocation

- Recommendation: use the v2 common envelope (protocolVersion 2) for signed events after identity activation; preserve v1 ledger payload semantics where possible. `membershipHeads` and `causalHeads` are separate sorted, unique frontiers, each capped at 64 direct references. `membershipHeads` is the maximal frontier in the membership-state DAG; `causalHeads` is the maximal frontier in the all-event causal DAG. They are not required to be subsets of one another: a membership head can be an ancestor of later ledger events and remain the current membership-state head. `membershipHeads` edges establish authorization-state ancestry only. `causalHeads` plus ADR-0001 `dependsOn` edges establish event causality and revocation ancestry. Every reference must resolve or the record is pending. No wall-clock ordering is used.
- Only accepted membership transitions (and structural membership checkpoints) become membership-DAG heads. A `device-join-request` is a signed pending request, not a membership transition; it never changes the active membership heads or grants a permission.
- A client authors against every membership head and event-causal head it currently knows. Independent membership operations commute and combine unless a specific conflict rule below applies. The 64 bound is a resource ceiling for each direct frontier and must be validated against the pilot. If a frontier exceeds 64, the client pauses authoring and reduces it with signed checkpoints; it never truncates or guesses.
- Checkpoint reduction is staged and lossless. A `frontier-checkpoint` record names one `frontierKind` (`membership` or `causal`) and at most 64 input heads in that frontier. Its ID replaces those inputs while every input remains stored and reachable as an ancestor in that DAG. To reduce more than 64 heads, the first checkpoint contains up to 64 heads; each following checkpoint contains the previous checkpoint ID plus up to 63 remaining heads. Repeat until all original heads are represented; the last checkpoint is the single merged head. A membership checkpoint has `membershipHeads` equal to its inputs and no `causalHeads`; it exists only in the membership DAG. A causal checkpoint has `causalHeads` equal to its inputs and `membershipHeads` for the state used to authorize its creation; it exists only in the causal DAG. The signer must be an active device in every membership state represented by the inputs/current state; a checkpoint cannot bootstrap its own authority. Checkpoint records carry no ledger or membership permission effect and never resolve conflicts. Every checkpoint preserves unresolved conflicts inherited from its inputs. If no signer is authorized across the referenced state, authoring pauses until that state conflict is resolved. Inputs must be present and valid before checkpoint creation.
- `device-revoked` and `participant-removed` use their signed `causalHeads` as the observed causal frontier; there is no second, potentially inconsistent frontier field. A ledger event from a removed key is retained as valid pre-removal activity only if it is an ancestor of at least one head in that removal frontier through `causalHeads` and `dependsOn` edges. An event not covered by the frontier is concurrent or later and receives `author-revoked-at-causal-frontier`, regardless of its timestamp. Missing or over-bound frontiers fail closed; no wall-clock fallback. Reachability is computed from signed causal edges, not the local arrival order.
- Each event's `causalHeads` are direct edges for reachability, not timestamps or financial ordering. The writer includes its previous device event head plus every other observed maximal event head. `membershipHeads` separately bind the membership state used for authorization. A removal cannot claim to have observed an event whose ID is absent from its causal ancestry. The checkpoint shape above applies independently to either frontier.
- Membership authorization is evaluated against all listed membership heads. Independent transitions combine. Concurrent removal dominates enrollment for the same participant/device. A join request or approval concurrent with removal remains pending/rejected; removal never disappears because of later arrival. Previously valid events in the removal frontier remain effective and auditable.
- Approvals under distinct invite IDs are independent and can enroll devices concurrently. Within one invite ID, exactly equivalent approvals for the same request/device/key are idempotent. If approvals for different requests or keys are concurrent (neither causally observes the other), they conflict and enroll neither device until the owner signs a resolution. An approval authored after observing a valid enrollment for that invite is invalid as `invite-already-consumed`. A resolved invite consumes that invite ID for exactly one device; the losing request stays denied for audit and cannot later enroll with the same invite. Join requests themselves never authorize writes.
- A concurrent role grant/revoke affecting the same participant, or conflicting ownership transfers, is an explicit conflict. Existing role/owner state stays effective pending a resolution. Only the current owner may resolve a role/ownership conflict. Concurrent non-conflicting edits (for example, one invite issue and an unrelated participant rename) combine.
- A signed transfer proposal names one active recipient participant and device. The recipient must sign acceptance with that device key. If the recipient was removed before acceptance in the complete causal projection, acceptance is invalid. A proposal alone does not change owner. Conflicting valid transfers leave the prior owner current until owner resolution; if the prior owner is unavailable, membership administration is locked (documented v1 limitation).
- To enforce the confirmed no-automatic-takeover rule, enrolling a device for the owner participant requires an active organizer's `device-enrollment-approved` record and an `owner-device-enrollment-consented` record signed by a currently active owner device. If the owner device itself is the organizer approving, its one signature satisfies both checks. A co-organizer cannot approve an owner-device replacement alone, even if the owner has no active devices. If every owner device is lost or revoked, no replacement can be enrolled and membership administration remains locked in v1.

### Invitations and enrollment UX

- `invite-issued` is organizer-signed and names one participant and an invite ID. It is delivered as a QR/deep link with a high-entropy bearer token. Only a hash of the token is stored in the invitation record. The joining client generates its device key and creates a signed `device-join-request` binding its proposed key to the invite ID. The request alone grants no group access.
- The joiner presents the signed request and the invitation bearer token to an organizer (for example, the organizer scans the request QR and then the invite QR). The organizer validates the token against the invitation hash in local memory, checks the displayed group/participant/device-key fingerprint, and signs `device-enrollment-approved` referencing the exact request and key. The token is not persisted or logged and never appears in request, approval, backup, or relay records. Replicas verify only the signed request and approval. This avoids requiring an unspecified secret-proving protocol.
- A copied invite can produce multiple signed requests, but all name the same `inviteId`. The organizer chooses one device request to approve; unapproved requests remain pending and grant no access. An invite is single-use across the complete replicated set: exactly equivalent approval records for the same request/key are idempotent; concurrent approvals for distinct requests or keys under the same invite conflict, and neither device enrolls until the owner resolves which request wins. An approval that causally observes a prior valid enrollment for that invite is invalid as `invite-already-consumed`. Once one device is enrolled, that invite cannot enroll another device, even if another request is delivered later. Additional devices require new invite IDs. The same rules do not conflict across unrelated invite IDs.
- If two organizers create distinct approval records for the same request and same device/key, they are semantically equivalent and project as one enrollment while both records remain auditable. If approvals for the same `inviteId` disagree on request, participant, device, or key, they are conflicting approvals and stay pending until owner resolution; approvals under distinct invite IDs are independent. Ordinary expiry stops the invitation from being presented/started in the UI. It is not checked against a verifier clock when projecting records. A late signed approval remains valid unless a signed revocation/removal conflicts with it. An explicit invite revocation before approval blocks new approvals; a concurrent revocation/approval is treated as conflict and requires owner resolution. Approval never retroactively invalidates an already approved enrollment.
- Invite links are bearer capabilities until organizer approval. Anyone with a link may request the named participant's enrollment. Display group and participant clearly, show the requested key fingerprint to the organizer, allow invite revocation, and never embed organizer credentials.

### Removal, adoption, and key rotation

- A device tombstone revokes only that device. Participant removal tombstones the participant and all devices. Neither operation erases source events or history. Removal advances the group encryption epoch; actual secret distribution is an EPIC-200 protocol decision. Previously downloaded history cannot be remotely erased, and the removal UI must state this.
- Legitimate offline activity omitted from the removal frontier remains quarantined. Only an active organizer can adopt a rejected expense by signing a new `expense-adopted` event that references the rejected event ID and includes the approved expense payload. The organizer's envelope attribution is the approver attribution. Group all adoption events by rejected source ID: identical canonical expense payloads are semantically equivalent and contribute once; differing payloads are a conflict and none contributes until the owner signs `expense-adoption-resolved`, referencing every adoption branch and choosing one. The rejected original always remains non-effective. This is a proposed additive event type and needs an ADR-0001-compatible payload definition before implementation. Adoption does not rewrite or re-sign the old event.
- Signing-key rotation enrolls a new device key through the normal signed join request and organizer approval flow, then revokes the old key. If the old key is unavailable, organizer enrollment is still possible. Do not copy private keys between devices. No automatic owner recovery exists in v1 if all owner devices are lost.
- Membership authorization and signatures do not provide confidentiality. Removal-triggered group-key rotation, relay encryption, and encrypted backup recovery need separate approved wire/key-lifecycle decisions.

### Legacy prototype activation

- Activation is explicit. The current local owner reviews the participant list and exact projected balances, then signs a migration attestation. Preserve the original raw event bytes unchanged and label their authorship `legacy-unverified`; placeholder signatures never become verified.
- Proposed canonical attestation payload:

```json
{
  "sourceGroupId": "<existing ID or null>",
  "sourceCanonicalContentDigest": { "algorithm": "SHA-256", "encoding": "base64url-no-padding", "value": "<digest>" },
  "archiveFormat": "div-it-legacy-raw-v1",
  "participants": [{ "participantId": "<stable old ID>", "name": "<name>" }],
  "currency": "USD",
  "openingBalances": [{ "participantId": "<id>", "amount": 0 }],
  "legacyEventCount": 0,
  "legacyAuthorship": "unverified"
}
```

- Proposed digest input is UTF-8 bytes of a canonical JSON object `{ "archiveFormat": "div-it-legacy-raw-v1", "group": <parsed legacy group object> }`, canonicalized with RFC 8785 JCS, then SHA-256. The raw archive is retained byte-for-byte as a separate backup member; the digest binds the exact parsed legacy values, while the archive member preserves original serialization. Approval requires fixed golden vectors covering empty group, Unicode names, integer money, and reordered JSON keys. Same semantic archive with reordered object keys has the same canonical-content digest; changed values change the digest. The owner-visible approval sheet shows participant names, balances, and the `legacy-unverified` warning before signing.
- New devices validate the attestation signature and digest against the preserved archive, then use only its zero-sum opening balances as migrated history. They cannot verify who authored old events. If the archive is malformed, digest mismatches, or balances fail zero-sum checks, activation aborts without changing the original group.

## Membership record inventory (proposed)

| Record | Authorization and effect |
| --- | --- |
| `group-created` | Self-signed genesis exception; anchors one owner/device/key and initial group metadata. |
| `participant-added` / `participant-renamed` | Organizer-authored stable participant identity and display metadata. |
| `invite-issued` / `invite-revoked` | Active organizer issues or revokes participant-specific invite. |
| `device-join-request` | New device self-signed proof of possession; grants no permission. |
| `device-enrollment-approved` | Active organizer approval binds request, participant, device, public key, and invite; enrolls one device. |
| `owner-device-enrollment-consented` | Existing owner device countersigns enrollment of a device for the owner participant; required in addition to organizer approval unless that approval is already signed by the active owner device. |
| `device-revoked` / `participant-removed` | Active organizer tombstone plus observed causal frontier; advances group-key epoch. |
| `organizer-granted` / `organizer-revoked` | Owner-only role transition. |
| `ownership-transfer-proposed` / `ownership-transfer-accepted` | Current owner proposal plus recipient device signature; accepted transfer installs one owner. |
| `membership-conflict-resolved` | Owner resolution references all conflicting transitions and selects a valid combined state. |
| `expense-adopted` | Active organizer links a quarantined rejected expense to a new approved payload; only this event contributes to balances. |
| `expense-adoption-resolved` | Owner resolves conflicting adoption payloads for one rejected source, references all branches, and selects exactly one contribution. |
| `legacy-history-adopted` | Current owner signs explicit legacy snapshot attestation, preserving raw archive digest and opening balances. |

The record inventory may use a tagged membership record, but it must preserve these distinct authorization stages. Group-key ciphertext and secret distribution are not specified here.

## Authorization and diagnostics

Validation stages are deterministic:

1. Parse, validate schema, and enforce byte/list bounds.
2. Verify genesis under its one-time bootstrap rule. For an ordinary record, resolve the already trusted signer key from the membership projection at the declared heads. For a `device-join-request`, use its included proposed public key solely to verify that request's proof of possession.
3. Verify the JCS signature. A valid join request remains pending and does not enroll its proposed key.
4. Validate dependencies, causal reachability, organizer/owner authority, invite state, removal tombstones, and conflict rules over the complete record set.
5. Enroll a device only when a valid active-organizer approval binds the exact valid join request and key. Project only authorized ledger events; retain invalid/unsupported input for audit.

Recommended stable diagnostics include `invalid-signature`, `unknown-device`, `join-request-pending`, `device-revoked-at-causal-frontier`, `participant-removed`, `not-organizer`, `not-owner`, `invalid-membership-transition`, `membership-conflict-pending`, `invite-revoked`, `invite-already-consumed`, `invite-expired-ui-only`, `conflicting-join-approvals`, `ownership-transfer-unaccepted`, `causal-frontier-missing`, `causal-frontier-too-large`, and `unsupported-membership-version`. Expiry is explicitly UI-only and must not be a permanent authorization diagnostic.

## Acceptance and security cases

- The supported browser matrix passes fixed Ed25519 known-answer/signature tests and the ADR-0001 JCS vectors. If the chosen algorithm is unavailable, activation is blocked; no fallback occurs. Tampering with any signed attribution, group, dependency, payload, or membership field fails verification.
- Private key bytes never appear in group documents, membership/ledger records, relay updates, or ordinary backups. Losing browser storage requires new organizer approval. The application documents that same-origin script may still invoke an unlocked key.
- Genesis is accepted only as locally created or as explicitly pinned via organizer-approved joining/TOFU. A self-signed foreign genesis cannot replace an already pinned group. Join request verification does not circularly require the requested device to already be enrolled.
- A valid signed join request alone cannot author ledger or membership events. Approval for a different request/key/participant does not enroll it. Copied invites can yield multiple requests, but one invite ID enrolls at most one device: equivalent duplicate approvals are idempotent; concurrent approvals for different requests/keys conflict until owner resolution; a later approval that observes an enrollment is invalid; a second device needs a new invite ID. Approvals under unrelated invite IDs combine. Token bytes never enter signed records or sync data.
- Expiry does not vary by verifier clock and does not invalidate signed approval. Invite revocation before approval blocks it; a concurrent invite revocation/approval is visibly pending for owner resolution. Removal concurrent with enrollment wins. Two requests under one invite with concurrent approvals remain pending until owner resolution; a later approval that observes the first enrollment is rejected as consumed; the same request/key approved equivalently twice yields one enrollment; distinct invite IDs combine.
- Independent membership changes converge regardless of delivery order. Conflicting ownership transfers retain the former owner. Acceptance from a removed recipient is rejected. Owner-device enrollment remains pending until both organizer approval and owner-device consent exist; a co-organizer alone cannot approve it. Losing all owner keys leaves v1 membership administration locked with no hidden takeover route.
- Frontier checkpoint tests cover more than 64 membership heads and more than 64 causal heads: each checkpoint has at most 64 inputs, each follow-up includes the prior checkpoint plus at most 63 new heads, final reachability includes every original head, and inherited conflicts remain unresolved.
- Revocation-frontier/adoption test matrix: included event remains valid; unseen offline event is quarantined even with an earlier timestamp; missing ancestry is pending/fails closed; identical adoptions of one original contribute once; conflicting payloads contribute nothing until owner resolution selects one; selected adoption links the original and carries organizer attribution. The original and every unselected adoption remain non-effective; at most one adopted payload contributes. Full reordered replicas converge.
- Device revocation preserves participant and history; participant removal tombstones all devices and history. Removal UI states that already downloaded history cannot be erased and future encryption keys rotate under the separate relay design.
- Legacy activation is opt-in; attestation digest matches fixed golden vectors; raw bytes are preserved; exact integer opening balances remain zero-sum; placeholder signatures remain unverified; any failed review leaves the source usable.
- Unknown membership versions are preserved and make affected groups read-only. Prototype development authorization is unreachable in production and cannot be used by synchronization.

## Proposed implementation slices (not ready tickets)

1. Root review and ADR approval: confirm v2 envelope/record fields, bounds, conflict fold, bootstrap, and legacy golden-vector encoding. Review exact contracts per slice before integration; DIV-036 is deferred to the release review.
2. Implement pure record parsing, canonical signature adapter, membership DAG projection, conflict diagnostics, and fixed signature/canonicalization/causality vectors.
3. Implement non-extractable device keys, genesis/bootstrap trust, join requests, organizer approvals, and production fail-closed authorization.
4. Implement participant/device tombstones, causal frontier production/checkpoint bounds, deterministic removal/adoption behavior, and audit UI.
5. Implement owner/co-organizer policy, transfer proposal/acceptance, conflict resolution, and explicit owner-lockout UX.
6. Implement invite issuance/revocation, QR presentation, private token validation in organizer UI, expiry-only UX, and multi-request selection/approval tests.
7. Implement explicit legacy review and signed migration attestation with golden archive digest vectors.
8. Integrate removal-triggered key epochs with the separately approved encrypted relay protocol (EPIC-200).

These are architecture slices, not TASKS.md-ready work. The human Phase 2 review remains required before release; it no longer blocks implementation.

## Remaining technical review items

- Confirm `membershipHeads` and `causalHeads` as separate DAG frontiers and whether all v2 ledger events carry both or only membership/removal records.
- Confirm 64-entry frontier bound and staged checkpoint format against a maximum pilot device count. On overflow the specified behavior is pause/fail closed; no lossy truncation.
- Confirm exact deterministic fold for overlapping membership conflicts, especially approval versus invite revocation and merge of independent organizer actions.
- Confirm SHA-256/JCS legacy digest golden vectors and whether the canonical parsed-value digest plus separately preserved raw bytes meets backup requirements.
- Confirm browser support targets for Ed25519. Unsupported clients remain unable to activate identity.

## References

- [ADR-0001: Version-one domain event format](./0001-event-format.md)
- [ROADMAP.md — Membership, security, and recovery](../../ROADMAP.md)
- [W3C Web Cryptography Level 2](https://www.w3.org/TR/WebCryptoAPI/)
- [RFC 8032: Edwards-Curve Digital Signature Algorithm (EdDSA)](https://www.rfc-editor.org/rfc/rfc8032.html)
- [RFC 8785: JSON Canonicalization Scheme](https://www.rfc-editor.org/rfc/rfc8785.html)
