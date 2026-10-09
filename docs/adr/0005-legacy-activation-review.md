# ADR 0005: Legacy activation review draft

Status: implementation reviewed by root on 2026-10-09. This module does not activate data or create signed records.

## Decision

`prepareLegacyActivationReview(source, { rawArchiveBytes })` prepares a detached owner-review draft from the parsed legacy group source. It uses the existing legacy expense normalizer and ledger projector to calculate opening balances. The summary includes stable source participant IDs and names, currency, exact zero-sum integer balances, event count, diagnostics, and `legacyUnverified: true`.

The review blocks activation when source metadata is invalid or when projection finds pending, quarantined, unsupported, conflicting, or read-only ledger data. It preserves the complete source archive alongside the draft. Existing participant and event IDs stay as supplied; this step creates no membership IDs, signatures, attestations, or writes.

## Archive and digest

The canonical content digest is SHA-256 over UTF-8 RFC 8785 canonical JSON bytes for:

```json
{
  "archiveFormat": "div-it-legacy-raw-v1",
  "group": { "...": "the parsed source group object" }
}
```

The digest is returned as unpadded base64url. If original archive bytes are supplied, they are copied unchanged into the archive member after parsing and checking that their canonical JSON value equals `source`. If bytes are not supplied, the returned archive is explicitly marked `canonical-object` and contains canonical JSON bytes for the source object; it is not described as the original serialization.

Golden vectors:

| Source | Digest |
| --- | --- |
| Empty group (`Empty`, USD, no participants or events) | `99vXNpAxhBv893K4LOXvGDBdFHtBUTcHXROtdVJvEVo` |
| Unicode group/name (`旅行 🐴`, `Zoë 東京`) | `ItPZIT_ZzTOajWHVwcUU_j8oGDRbp8GsA5sO8KwpoDI` |
| Integer money event (2468 cents, `café`) | `lNWPw11bp03_9qqjJyzTIwiF9VC6kiFnEAj5Nch0ONI` |

Reordering JSON object keys leaves the digest unchanged; changing money changes it. Array order remains meaningful under JCS.

## Scope limits

Legacy authorship is always unverified, including records carrying prototype development placeholders. This draft computes a review result only. A later owner-facing approval step must show the participant list, currency, balances, digest, and unverified warning before creating any signed migration attestation. It must preserve the raw archive and abort without mutation if the archive, digest, or zero-sum values fail validation.

## Evidence

`legacy-activation-review.test.mjs` covers old expense arrays, versioned prototype event arrays, scalar event-store values, mixed mirror/event sources, malformed and unsupported entries, same-ID collisions, raw archive byte preservation/source binding, input immutability, zero-sum balances, malformed group shapes, unlisted opening-balance participants (including net-zero balances), and fixed digest vectors. On 2026-10-09 the focused tests passed 7/7, full `npm test` passed 162/162, and `npm run build` passed. Root review accepted the preparation module; signed activation remains a successor task.

## DIV-114: detached signed history attestation

`createLegacyHistoryAttestation` and `verifyLegacyHistoryAttestation` create and verify a standalone `legacy-history-adopted` signed membership-envelope-shaped record. Creation and verification resolve the actual signer against declared trusted membership heads and require the current owner role. Verification checks the original signed envelope, then recomputes every payload field from the supplied preserved archive. It rejects an owner device removed at the declared heads unless a verified causal context proves the relevant frontier. Inputs are detached before asynchronous work.

This is not activation: the returned record is not appended to membership history or financial projection, and there is no caller authorization callback or UI approval boolean. The signed payload always states `legacyAuthorship: "unverified"`; the source participant IDs and names remain exact. Original archive bytes are preserved when supplied. Otherwise the archive is explicitly marked `canonical-object`, not original serialization.

Bounds: 8 MiB archive bytes, 8 KiB canonical signed record, 256 participants, 10,000 source events, and 64 sorted UUID membership heads. Names and participant IDs are preserved without trimming but must be nonempty after trimming and at most 128 Unicode code points. Supported currencies are USD, INR, EUR, and GBP.

`legacy-history-attestation.test.mjs` covers owner role/transfer/removal, trusted heads, payload and archive recomputation, tampering, exact raw-byte preservation, immutability, whitespace-preserving legacy names/IDs, and continued verification after a signed future membership record makes the current projection read-only. `browser-tests/legacy-history-attestation.spec.js` exercises the native browser crypto path. On 2026-10-09 the focused unit tests passed 7/7, full `npm test` passed 188/188, `npm run build` passed, and the focused browser test passed 1/1 in Chromium. Verification accepts historical records at authenticated declared heads even if a later compatibility barrier makes new authoring read-only; creation remains blocked by the writable-authority resolver.

Root review on 2026-10-09 accepted the standalone attestation API after snapshot and compatibility fixes. The combined focused browser run passed 3/3 in Firefox, including the attestation check. No activation or participant-ID mapping is claimed.
