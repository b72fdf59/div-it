# DIV-032 restore evidence

Restore validates the whole backup and the proposed union before writing. It adds missing participants and immutable raw events by exact ID/content, preserving local settings, people, newer events, and existing quarantined entries. For a populated group it requires matching currency and, when supplied or carried by versioned events, matching group identity. A legacy backup with no group ID can join a populated group only through its unsigned prototype event format; those records are normalized for projection using the existing local group ID and are stored unchanged. An empty group may adopt backup metadata and identity.

Incoming malformed/quarantined events and any same-ID content collision are rejected before mutation. Exact events already stored are harmless on re-import. Unsupported future events are accepted byte-for-byte and make the resulting group read-only, as required by the event ADR. Existing malformed records remain in the local audit trail; they do not make an otherwise exact re-import fail.

Evidence:

- `group.test.mjs` covers additive participant/event plans, preserving current identity/settings, fresh-group adoption, metadata and ID/content collision rejection, malformed input rejection, unsupported raw preservation, and harmless re-import of a pre-existing invalid record.
- `browser-tests/restore-merge.spec.js` exports an older state, adds a newer expense and participant, rejects conflicting/malformed restores without changing its export, restores the old backup twice, reloads, and checks both expense values and all participants/balances remain.
- `browser-tests/exact-split-backup.spec.js` checks a fresh group adopts the source identity and exact event/split provenance.
- `browser-tests/audit-history.spec.js` seeds an already stored malformed event through the persisted legacy group, then merges valid events and a future-version event; the malformed diagnostic remains inspectable and the future record remains unsupported/read-only.
- `browser-tests/backup-validation.spec.js`, `browser-tests/conflicts.spec.js`, `browser-tests/settlements.spec.js`, and `browser-tests/unsupported-ledger.spec.js` retain checks for invalid metadata, exact conflict/reversal histories, legacy no-group-ID restore, and unsupported-event handling.

Acceptance run: `npm test` — 92 passed; `npm run build` — passed; `npm run test:browser` — 15 passed; `git diff --check` — clean.
