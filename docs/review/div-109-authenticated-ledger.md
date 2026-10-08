# DIV-109 authenticated signed ledger projection

Status: isolated API accepted by root technical review on 2026-10-08; causal revocation and production activation remain pending.

## API and behavior

`projectAuthenticatedLedger(rawRecords, { membershipRecords, trustPin })` is isolated in `src/authenticated-ledger.js`. It resolves each signed ledger record against `projectSignedMembership` at that record's declared `membershipHeads`, obtains the concrete enrolled public key, verifies the original protocol-v2 record signature, then checks group, currency, author participant, payer, split, settlement, and opening-balance participant bindings. Only verified authorized v2 variants are converted to detached v1 events and passed to the existing `projectLedger`.

Before conversion, records are grouped by ID and canonical full v2 content. Exact repeats project once. Distinct authorized records sharing an ID are quarantined as collisions, even if their financial views match; invalid or unauthorized variants cannot suppress a valid one. The result preserves detached original signed records and includes membership and ledger diagnostics. Caller-supplied authorization callbacks are ignored; the ledger callback is a closed set derived internally from verified records.

## Evidence

- `authenticated-ledger.test.mjs`: enrolled ordinary member projects every v1 financial type; record-order invariance; pending domain and membership dependencies; denied unknown/proof-only devices, mismatched attribution, wrong keys/groups/currencies, and unknown participants; trusted-group pinning; unsupported record behavior; same-ID signed v2 collisions and invalid-variant non-shadowing.
- Ledger records naming invalid membership ancestry are quarantined without changing trusted current-group read-only state; an altered, unverified head claim cannot suppress a valid event. Pending, quarantined, unsupported, and membership diagnostic arrays have stable ordering across record permutations; `rawRecords` intentionally retains input order.
- `browser-tests/authenticated-ledger.spec.js`: real browser Web Crypto, genesis trust pin, enrollment, signed member expense, balance projection, original-envelope preservation, and modified-frontier signature rejection.
- On 2026-10-08: root reran the integrated unit suite (148/148 passed) and build (passed) after DIV-110 authenticated compatibility barriers. Focused authenticated unit tests passed 6/6 and the configured Firefox browser test passed 1/1. No Safari/WebKit or branded-browser coverage is inferred.

## Limits

The caller must provide the trusted genesis pin and membership record set. This projection validates membership authorization at each declared membership frontier and signs the original causal-frontier fields, but it does not validate causal ancestry, revocation cutoffs, or offline-event adoption. It is not connected to the application UI or current prototype event store. Do not treat this isolated API as production activation until causal/revocation integration and later activation work are reviewed.
