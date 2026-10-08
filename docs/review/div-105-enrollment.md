# DIV-105 invitation and enrollment technical review

Status: accepted by root technical review on 2026-10-08; isolated API implemented, app/QR integration remains a successor task.

Human acceptance remains deferred until the complete first-release solution is built, as requested by the owner. This review covers implementation correctness.

## Required fixes from the first review

- Resolve enrolled signing keys and organizer/owner permissions from verified membership ancestry. Caller-supplied authorization callbacks are not sufficient evidence of a working permission system.
- Verify referenced parent records before allowing them to establish ancestry. Forged, pending, colliding, and unauthorized records cannot justify an approval or resolution.
- Detect content collisions across genesis, roster, and enrollment records. Never select a variant by array order or map overwrite.
- Retain conflicting concurrent owner resolutions as unresolved; equivalent resolutions may be idempotent.
- Resolve the complete set of competing approval and invite-revocation branches, rather than replacing a prior conflict set.
- Require an actual active owner-device signature when enrolling an owner device.
- Verify an invitation's signature and authority before signing an approval, in addition to checking its token hash.
- Bind enrolled public keys to their verified request and approval chain.

## Required evidence before acceptance

- A second device joins, receives an organizer grant, and issues/approves a subsequent invite through concrete verified state.
- Ordinary members cannot perform organizer operations, and permissions revoked at the declared heads are rejected.
- Forged ancestry and colliding genesis/roster records never grant permissions, regardless of delivery order.
- Concurrent resolutions and multiple approval/revocation branches remain deterministic and fail closed.
- Full unit/build checks and focused browser checks pass after the revision.

The initial isolated implementation reported 121 passing unit tests and one passing browser test. Those results do not establish these missing end-to-end authorization properties. Revised implementation uses a concrete combined signed membership projector with no permission callbacks. Root reran the unit suite (121/121 passed) and build (passed). Luna reported the focused browser test passed (1/1). Real enrolled organizer, ordinary member denial, role revocation, owner consent, mixed approval/revocation conflicts, concurrent resolutions, forged/colliding ancestry, device binding collisions and dependent-authority withdrawal are covered. WebKit host support remains unavailable and no branded browser coverage is inferred.
