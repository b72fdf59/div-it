import { signRecord, verifyRecord } from "./identity-crypto.js";
import { validateMembershipRecord } from "./membership-projector.js";
import { projectSignedMembership, resolveMembershipAuthority } from "./signed-membership-projector.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;

function validUuid(value) { return typeof value === "string" && UUID.test(value); }
function decodeKey(value) {
  if (typeof value !== "string" || !KEY.test(value)) throw new Error("invalid-enrolled-public-key");
  const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "="), (char) => char.charCodeAt(0));
  if (bytes.length !== 32) throw new Error("invalid-enrolled-public-key");
  return bytes;
}
function sameHeads(a, b) {
  return Array.isArray(a) && a.length === b.length && [...a].sort().every((head, index) => head === b[index]);
}
function assertActive(projection, participantId) {
  if (!validUuid(participantId) || !projection.participants.some((item) => item.id === participantId)) {
    throw new Error("participant-not-active");
  }
}

/** Creates and verifies one signed participant or organizer transition at the current trusted membership frontier. */
export async function createMembershipRosterCommand({
  recordType, groupId, participantId, name, membershipHeads, identity, records, trustPin, verifiedCausalContexts = []
} = {}) {
  if (!new Set(["participant-added", "participant-renamed", "organizer-granted", "organizer-revoked"]).has(recordType)) {
    throw new TypeError("invalid-roster-command-type");
  }
  if (!validUuid(groupId) || !validUuid(participantId) || !Array.isArray(records) || !trustPin
      || !Array.isArray(verifiedCausalContexts) || !Array.isArray(membershipHeads)) {
    throw new TypeError("invalid-roster-command-input");
  }

  let sourceRecords;
  let sourceTrustPin;
  try {
    sourceRecords = structuredClone(records);
    sourceTrustPin = structuredClone(trustPin);
  } catch {
    throw new TypeError("invalid-roster-command-input");
  }
  const contexts = [...verifiedCausalContexts];
  const signer = identity && {
    participantId: identity.participantId, deviceId: identity.deviceId, keyId: identity.keyId,
    publicKey: identity.publicKey, privateKey: identity.privateKey
  };
  const heads = [...membershipHeads];

  const options = { trustPin: sourceTrustPin, verifiedCausalContexts: contexts };
  const current = await projectSignedMembership(sourceRecords, options);
  if (!current.groupId || current.groupId !== groupId || current.readOnly) throw new Error("membership-state-untrusted");
  if (!sameHeads(heads, current.heads)) throw new Error("stale-membership-heads");

  const role = recordType === "participant-added" || recordType === "participant-renamed" ? "organizer" : "owner";
  const authority = await resolveMembershipAuthority({ identity: signer, membershipHeads: current.heads, records: sourceRecords,
    trustPin: sourceTrustPin, role, verifiedCausalContexts: contexts });
  if (!authority || authority.projection.groupId !== groupId) throw new Error(role === "owner" ? "not-owner" : "not-organizer");

  const participant = current.participants.find((item) => item.id === participantId);
  if (recordType === "participant-added") {
    if (participant || current.tombstones.participants.some((item) => item.participantId === participantId)) {
      throw new Error("participant-id-unavailable");
    }
  } else {
    assertActive(current, participantId);
  }
  if (recordType === "organizer-revoked" && participantId === current.ownerParticipantId) {
    throw new Error("cannot-revoke-owner");
  }

  const payload = recordType === "participant-added" || recordType === "participant-renamed"
    ? { participantId, name }
    : { participantId };
  const record = {
    id: crypto.randomUUID(), recordType, membershipSchemaVersion: 1, protocolVersion: 2, groupId,
    author: { participantId: signer.participantId, deviceId: signer.deviceId, keyId: signer.keyId },
    createdAt: new Date().toISOString(), membershipHeads: [...current.heads].sort(), causalHeads: [], dependsOn: [], payload
  };
  record.signature = await signRecord(record, signer.privateKey);
  const validationError = validateMembershipRecord(record);
  if (validationError) throw new Error(validationError);

  const publicKey = await crypto.subtle.importKey("raw", decodeKey(authority.publicKey), { name: "Ed25519" }, true, ["verify"]);
  if (!(await verifyRecord(record, publicKey))) throw new Error("membership-command-signature-key-mismatch");

  const projected = await projectSignedMembership([...sourceRecords, record], options);
  if (projected.readOnly) throw new Error("membership-command-projection-read-only");
  if (recordType === "participant-added" && !projected.participants.some((item) => item.id === participantId)) {
    throw new Error("membership-command-not-effective");
  }
  if (recordType === "participant-renamed" && projected.participants.find((item) => item.id === participantId)?.name !== name) {
    throw new Error("membership-command-not-effective");
  }
  if (recordType === "organizer-granted" && !projected.organizers.includes(participantId)) {
    throw new Error("membership-command-not-effective");
  }
  if (recordType === "organizer-revoked" && projected.organizers.includes(participantId)) {
    throw new Error("membership-command-not-effective");
  }
  return record;
}

export function createParticipantAddCommand(input) {
  return createMembershipRosterCommand({ ...input, recordType: "participant-added" });
}
export function createParticipantRenameCommand(input) {
  return createMembershipRosterCommand({ ...input, recordType: "participant-renamed" });
}
export function createOrganizerGrantCommand(input) {
  return createMembershipRosterCommand({ ...input, recordType: "organizer-granted" });
}
export function createOrganizerRevokeCommand(input) {
  return createMembershipRosterCommand({ ...input, recordType: "organizer-revoked" });
}
