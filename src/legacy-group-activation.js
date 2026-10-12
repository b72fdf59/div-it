import { ImmutableString } from "@automerge/automerge";
import { canonicalJsonBytes } from "./identity-crypto.js";
import { createGroupGenesis } from "./group-genesis.js";
import { getOrCreateDeviceIdentity } from "./device-identity-store.js";
import { createMembershipRosterCommand } from "./membership-roster-commands.js";
import { createSignedLedgerRecord } from "./signed-ledger-records.js";
import { projectSignedMembership } from "./signed-membership-projector.js";
import { prepareLegacyActivationReview } from "./legacy-activation-review.js";
import { createLegacyHistoryAttestation } from "./legacy-history-attestation.js";
import { verifyLegacyOpeningBalanceImport } from "./legacy-opening-balances.js";

function canonical(value) { return new TextDecoder().decode(canonicalJsonBytes(value)); }
function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function sourceBytes(value) {
  if (typeof value === "string") return new TextEncoder().encode(value);
  if (value instanceof Uint8Array) return Uint8Array.from(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  return null;
}
function scalarRecordStore(records) {
  return Object.fromEntries(records.map((record) => [`${record.id}:${crypto.randomUUID()}`, new ImmutableString(JSON.stringify(record))]));
}
function proofArchiveWire(archive) {
  return {
    kind: archive.kind,
    mediaType: archive.mediaType,
    ...(archive.kind === "canonical-object" ? { canonicalization: archive.canonicalization } : {}),
    bytes: { encoding: "base64url-no-padding", value: base64url(archive.bytes) }
  };
}
function scalarProofStore(attestations) {
  return Object.fromEntries(attestations.map(({ record, archive }) => [
    `${record.id}:${crypto.randomUUID()}`,
    new ImmutableString(JSON.stringify({ record, archive: proofArchiveWire(archive) }))
  ]));
}

/** Synchronous stale-source guard for the exact canonical snapshot carried by a staged plan. */
export function legacyActivationSourceMatches(source, sourceFingerprint) {
  try {
    return !!sourceFingerprint && typeof sourceFingerprint.canonicalJson === "string"
      && canonical(source) === sourceFingerprint.canonicalJson;
  } catch { return false; }
}

export function legacyActivationSourcesEqual(left, right) {
  try { return canonical(left) === canonical(right); }
  catch { return false; }
}

/** Build a detached migration plan after an explicit digest and owner selection. No group data is persisted. */
export async function stageLegacyGroupActivation({ source, rawArchiveBytes, approvedDigest,
  selectedOwnerSourceParticipantId, emptySourceOwnerName } = {}) {
  let sourceSnapshot;
  let archiveBytes;
  let approvedDigestSnapshot;
  const selectedOwnerSnapshot = selectedOwnerSourceParticipantId;
  const emptyOwnerNameSnapshot = emptySourceOwnerName;
  try {
    sourceSnapshot = structuredClone(source);
    archiveBytes = rawArchiveBytes === undefined ? undefined : sourceBytes(rawArchiveBytes);
    if (rawArchiveBytes !== undefined && !archiveBytes) throw new Error("invalid-raw-archive-bytes");
    approvedDigestSnapshot = structuredClone(approvedDigest);
  } catch (error) { throw new TypeError(error?.message || "invalid-legacy-source"); }

  let sourceCanonicalBytes;
  try { sourceCanonicalBytes = canonicalJsonBytes(sourceSnapshot); }
  catch { throw new TypeError("invalid-legacy-source"); }
  const review = await prepareLegacyActivationReview(sourceSnapshot,
    archiveBytes === undefined ? {} : { rawArchiveBytes: archiveBytes });
  if (!review.activationReady || !review.archive) throw new Error("legacy-review-blocked");
  if (!approvedDigestSnapshot || canonical(approvedDigestSnapshot) !== canonical(review.digest)) throw new Error("legacy-review-digest-mismatch");

  const sourceOwner = review.participants.length
    ? review.participants.find(({ participantId }) => participantId === selectedOwnerSnapshot)
    : null;
  if (review.participants.length && !sourceOwner) throw new Error("invalid-selected-legacy-owner");
  if (!review.participants.length && selectedOwnerSnapshot !== undefined) throw new Error("invalid-selected-legacy-owner");
  const ownerName = sourceOwner?.name ?? emptyOwnerNameSnapshot;
  if (typeof ownerName !== "string" || !ownerName.trim()) throw new Error("invalid-selected-legacy-owner");

  const localIdentity = await getOrCreateDeviceIdentity();
  const genesis = await createGroupGenesis({ name: sourceSnapshot.name, currency: review.currency, ownerName });
  if (genesis.record.author.deviceId !== localIdentity.deviceId || genesis.record.author.keyId !== localIdentity.keyId) {
    throw new Error("local-identity-changed");
  }
  const identity = { ...localIdentity, participantId: genesis.record.author.participantId };
  const targetBySource = new Map();
  if (sourceOwner) targetBySource.set(sourceOwner.participantId, identity.participantId);
  for (const { participantId } of review.participants) {
    if (participantId === selectedOwnerSourceParticipantId) continue;
    let targetId;
    do { targetId = crypto.randomUUID(); } while (targetId === identity.participantId || [...targetBySource.values()].includes(targetId));
    targetBySource.set(participantId, targetId);
  }

  const membershipRecords = [genesis.record];
  for (const participant of review.participants) {
    if (participant.participantId === selectedOwnerSourceParticipantId) continue;
    const atHeads = await projectSignedMembership(membershipRecords, { trustPin: genesis.trustPin });
    if (!atHeads.groupId || atHeads.readOnly) throw new Error("membership-plan-untrusted");
    const record = await createMembershipRosterCommand({ recordType: "participant-added", groupId: genesis.record.groupId,
      participantId: targetBySource.get(participant.participantId), name: participant.name, membershipHeads: atHeads.heads,
      identity, records: membershipRecords, trustPin: genesis.trustPin });
    membershipRecords.push(record);
  }
  const membership = await projectSignedMembership(membershipRecords, { trustPin: genesis.trustPin });
  if (!membership.groupId || membership.readOnly || membership.participants.length !== review.participants.length + (sourceOwner ? 0 : 1)) {
    throw new Error("membership-plan-invalid");
  }
  const participantMapping = [...targetBySource].map(([sourceParticipantId, participantId]) => ({ sourceParticipantId, participantId }))
    .sort((a, b) => a.sourceParticipantId < b.sourceParticipantId ? -1 : a.sourceParticipantId > b.sourceParticipantId ? 1 : 0);
  const attestation = await createLegacyHistoryAttestation({ archive: review.archive, membershipHeads: membership.heads,
    identity, membershipRecords, trustPin: genesis.trustPin, participantMapping });

  const ledgerRecords = [];
  if (review.participants.length) {
    const event = await createSignedLedgerRecord({
      id: crypto.randomUUID(), type: "opening-balances-imported", groupId: genesis.record.groupId,
      author: { participantId: identity.participantId, deviceId: identity.deviceId, keyId: identity.keyId },
      createdAt: new Date().toISOString(), membershipHeads: [...membership.heads].sort(), causalHeads: [], dependsOn: [],
      payload: { importId: genesis.record.id, currency: review.currency, sourceFormat: "legacy-activation",
        balances: attestation.mappedOpeningBalances, legacyAttestationId: attestation.record.id }
    }, identity.privateKey);
    const verified = await verifyLegacyOpeningBalanceImport(event, { legacyAttestations: [{ record: attestation.record, archive: attestation.archive }],
      membershipRecords, trustPin: genesis.trustPin });
    if (verified.status !== "authorized") throw new Error(`legacy-opening-balance-${verified.reason || verified.status}`);
    ledgerRecords.push(event);
  }

  const digest = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", sourceCanonicalBytes)));
  const sourceFingerprint = { algorithm: "RFC 8785 SHA-256", value: digest, canonicalJson: new TextDecoder().decode(sourceCanonicalBytes) };
  const attestationEvidence = [{ record: attestation.record, archive: attestation.archive }];
  return {
    document: {
      groupId: genesis.record.groupId, name: genesis.record.payload.name, currency: genesis.record.payload.currency,
      signedGroupVersion: 1, people: [], events: [], eventsById: {},
      membershipRecordsById: scalarRecordStore(membershipRecords), ledgerRecordsById: scalarRecordStore(ledgerRecords),
      legacyAttestationsById: scalarProofStore(attestationEvidence)
    },
    proofPlan: {
      genesis: structuredClone(genesis.record), membershipRecords: membershipRecords.map((record) => structuredClone(record)),
      trustPin: structuredClone(genesis.trustPin), attestations: structuredClone(attestationEvidence),
      ledgerRecords: ledgerRecords.map((record) => structuredClone(record)), participantMapping: structuredClone(participantMapping),
      mappedOpeningBalances: structuredClone(attestation.mappedOpeningBalances)
    },
    archive: structuredClone(review.archive), review: structuredClone(review), approvedDigest: structuredClone(review.digest), sourceFingerprint
  };
}
