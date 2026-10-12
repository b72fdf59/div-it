# DIV-121 enrollment handoff contract

Status: implementation and automated acceptance reviewed by root on 2026-10-12. Human release sign-off remains pending.

## Exchange and trust

An organizer deliberately shares a versioned invitation bootstrap containing complete signed membership, ledger and legacy archive proof, a particular invitation, and its bearer token. The recipient verifies the candidate and creates a request with its persisted device key. A request proves possession of that key; it establishes neither membership nor local trust.

The request handoff contains no bearer token. The organizer reviews the exact participant, device, key and fingerprint before approving against current verified membership and the privately retained token. Owner device enrollment also requires current owner consent. Refreshed approval packages and ordinary backups contain no bearer token or private signing key.

The recipient must bind the approval to the original candidate genesis, invitation and its own exact request/key. Only after verification does the app display group name, group ID and genesis fingerprint for explicit out-of-band comparison and confirmation. A candidate pin remains in memory until that confirmation. Persistence uses the durable verification and local registry rollback rules established by DIV-120.

## Bounds

Whole JSON packages are limited to 32 MiB of UTF-8 before parsing. Membership follows the existing 256-record and individual membership schema limits. Financial history follows the existing 10,000-event, 8 MiB aggregate and 65,536-byte individual signed-record limits. Each legacy archive is limited to 8 MiB, with the whole-package limit also enforced. Packages must preserve valid history near the roadmap's 5,000-event envelope; smaller demonstration fixtures do not justify narrower product limits.

## User actions and acceptance

The default invitation expiry is 24 hours. Expiry gates user actions and never decides replicated financial or membership projection authority. Revoked, consumed and conflicting invitations retain the existing signed projector policy. Never automatically select or approve the first request.

Required acceptance includes two isolated browser contexts with distinct persisted keys, rejection before approval and trust confirmation, complete signed proof preservation, no raw token in persistent shared records/registry/pins/ordinary backups, forged and mismatched package rejection without mutation, safe retry, and full regression checks.

This task provides deliberate file exchange. QR joining and encrypted internet synchronization remain required first-release successors. Human architecture sign-off and actual-device/pilot evidence remain deferred release gates and are not established by automated browser tests.

## Technical review findings

The package verifier derives causal evidence through authenticated ledger projection before resolving final membership, so signed removals and checkpoints cannot be bypassed by a candidate bootstrap. Original membership records, financial records and archive bytes must remain present in the final approved proof.

Validly signed offline records rejected at an authenticated revocation frontier remain in audit history and cannot affect balances or authorization. Other ledger quarantine reasons, incomplete dependencies and unsupported authority are rejected by this handoff format. This policy preserves the documented revocation behavior without granting rejected records causal authority.

An active owner's signed enrollment approval supplies owner consent. When a co-organizer approves an owner's additional device, the existing active owner must supply a separate signed consent record. Historical approval verification does not depend on whether the invitation has since expired; issuing requests and approving them still use the explicit expiry gate.

Root focused verification (2026-10-12): package and checkpoint tests 8/8 pass after correcting the checkpoint test's assumption about sorted random UUID order. Full Firefox acceptance now passes 54/54, full unit suite 208/208 and production build passes, including duplicate delivery, independent device keys/reload, signed member expense, authority denial, token absence, storage rollback/retry and stale group switching.
