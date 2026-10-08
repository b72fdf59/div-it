# ADR 0003: Signed ledger envelope foundation

- Status: Envelope foundation accepted by root technical review on 2026-10-08; full authorization/causal integration remains pending
- Scope: Isolated construction and structural validation of protocol-v2 signed ledger records
- Related contracts: [ADR-0001 event payloads and JCS](./0001-event-format.md), [ADR-0002 identity and membership](./0002-device-identity-and-membership.md)

## Decision in this implementation slice

Keep the existing protocol-v1 event parser and projector unchanged. Add `parseSignedLedgerRecord`, `createSignedLedgerRecord`, and `verifySignedLedgerRecord` in `src/signed-ledger-records.js`. The single record builder supports each of ADR-0001's seven financial event types by taking the exact v1 event `type` and `payload`.

A signed ledger record contains exactly:

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "type": "expense-created",
  "schemaVersion": 1,
  "protocolVersion": 2,
  "groupId": "22222222-2222-4222-8222-222222222222",
  "author": {
    "participantId": "participant-alice",
    "deviceId": "device-alice",
    "keyId": "key-alice"
  },
  "createdAt": "2026-10-08T09:30:00.000Z",
  "membershipHeads": ["33333333-3333-4333-8333-333333333333"],
  "causalHeads": [],
  "dependsOn": [],
  "payload": {},
  "signature": "<64-byte Ed25519 signature as canonical unpadded base64url>"
}
```

The schema and protocol versions are fixed to 1 and 2 respectively. `id`, `groupId`, dependency IDs, and frontier IDs use ADR-0001's canonical lowercase UUID syntax. `author` has exactly the three ADR-0001 fields; each value is a non-empty, trimmed, case-sensitive identifier no longer than 128 Unicode code points. `membershipHeads` is a non-empty lexicographically sorted unique UUID list; `causalHeads` may be empty. Both frontiers contain at most 64 IDs. `dependsOn` retains the v1 sorted unique UUID rule and 256-entry limit. The full canonical record is limited to 65,536 UTF-8 bytes. The signature must be the canonical 86-character unpadded base64url Ed25519 representation.

The v2 parser validates the envelope and passes a detached temporary view to `parseEvent`: it retains the original `schemaVersion`, sets only the validation view's `protocolVersion` to 1, and omits `membershipHeads` and `causalHeads`. This reuses all existing payload, ID, timestamp, dependency, currency, integer-money, split-total, and zero-sum rules. The successful result includes both the detached original v2 record and the parsed v1 structural event. The view is never signed or returned as the stored record.

`createSignedLedgerRecord` builds the exact v2 envelope, inserts a syntactically valid placeholder signature, and runs full structural validation before calling `signRecord`. `signRecord` signs the original v2 record using ADR-0001 JCS over every envelope field except `signature`; in particular, group, author, both frontiers, dependencies, and payload are covered. `verifySignedLedgerRecord` structurally validates first, then verifies that same original v2 content with `verifyRecord`.

Stable structural failures include `invalid-json`, `invalid-envelope`, `invalid-id`, `invalid-version`, `unsupported-version`, `invalid-membership-heads`, `invalid-causal-heads`, `invalid-signature`, and the v1 parser's payload/dependency diagnostics such as `invalid-money`, `split-total-mismatch`, `invalid-reference`, and `unsupported-event-type`. Cryptographic signature failure is `invalid-signature`.

## Explicit limits

This slice checks frontier syntax and size only. It does not prove that membership heads exist, are trusted, are maximal, or authorize the author. It does not resolve causal ancestry, revocation, signer keys, participant/device enrollment, or event dependencies against a ledger. A structurally valid signature proves only that the supplied public key signed the complete v2 record; it is not membership authorization. The next integration must validate the declared membership and causal frontiers against verified graph state before accepting a record for projection. No UI, v1 projection, production activation, or identity policy changes are included.
