import { canonicalJsonBytes, exportDevicePublicKey, signRecord, verifyRecord } from "./identity-crypto.js";
import { verifyGroupGenesis } from "./group-genesis.js";
import { createVerifiedCausalContext, isVerifiedCausalContext, projectSignedMembership, resolveMembershipAuthority } from "./signed-membership-projector.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MAX_RECORD_BYTES = 8192;
const MAX_RECORDS = 256;
const MAX_HEADS = 64;
const ENVELOPE_FIELDS = ["id", "recordType", "membershipSchemaVersion", "protocolVersion", "groupId", "author", "createdAt", "membershipHeads", "causalHeads", "dependsOn", "payload", "signature"];
const AUTHOR_FIELDS = ["participantId", "deviceId", "keyId"];
const TYPES = new Set(["invite-issued", "invite-revoked", "device-join-request", "device-enrollment-approved", "owner-device-enrollment-consented", "membership-conflict-resolved"]);
const BASE_TYPES = new Set(["group-created", "participant-added", "participant-renamed", "organizer-granted", "organizer-revoked"]);

function isUuid(value) { return typeof value === "string" && UUID.test(value); }
function exact(value, fields) {
  return value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => fields.includes(field));
}
function encode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function decodeKey(value) {
  if (typeof value !== "string" || !BASE64URL_32.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "="), (char) => char.charCodeAt(0));
    return bytes.length === 32 && encode(bytes) === value ? bytes : null;
  } catch { return null; }
}
async function fingerprint(publicKey) {
  return `sha256:${encode(new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey)))}`;
}
function validHeads(heads) {
  return Array.isArray(heads) && heads.length > 0 && heads.length <= MAX_HEADS
    && heads.every((head, index) => isUuid(head) && (!index || heads[index - 1] < head));
}
function validTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function schemaError(record) {
  try {
    if (!exact(record, ENVELOPE_FIELDS) || !TYPES.has(record.recordType)) return "invalid-enrollment-schema";
    if (record.membershipSchemaVersion !== 1 || record.protocolVersion !== 2) return "unsupported-membership-version";
    if (!isUuid(record.id) || !isUuid(record.groupId) || !exact(record.author, AUTHOR_FIELDS)
        || !AUTHOR_FIELDS.every((field) => isUuid(record.author[field]))) return "invalid-enrollment-schema";
    if (!validTimestamp(record.createdAt) || !validHeads(record.membershipHeads)
        || !Array.isArray(record.causalHeads) || record.causalHeads.length || !Array.isArray(record.dependsOn) || record.dependsOn.length
        || typeof record.signature !== "string" || !SIGNATURE.test(record.signature)) return "invalid-enrollment-schema";
    const p = record.payload;
    const fields = {
      "invite-issued": ["inviteId", "participantId", "tokenHash", "expiresAt"],
      "invite-revoked": ["inviteId"],
      "device-join-request": ["inviteId", "participantId", "publicKey", "publicKeyFingerprint"],
      "device-enrollment-approved": ["inviteId", "requestId", "participantId", "deviceId", "keyId", "publicKeyFingerprint", "genesisId"],
      "owner-device-enrollment-consented": ["approvalId", "requestId", "participantId", "deviceId", "keyId"],
      "membership-conflict-resolved": ["inviteId", "conflictRecordIds", "selectedRecordId"]
    }[record.recordType];
    if (!exact(p, fields)) return "invalid-enrollment-payload";
    if (record.recordType === "invite-issued") {
      if (!isUuid(p.inviteId) || !isUuid(p.participantId) || !/^sha256:[A-Za-z0-9_-]{43}$/.test(p.tokenHash)
          || !(p.expiresAt === null || validTimestamp(p.expiresAt))) return "invalid-enrollment-payload";
    } else if (record.recordType === "invite-revoked") {
      if (!isUuid(p.inviteId)) return "invalid-enrollment-payload";
    } else if (record.recordType === "device-join-request") {
      if (!isUuid(p.inviteId) || !isUuid(p.participantId) || p.participantId !== record.author.participantId
          || !decodeKey(p.publicKey) || !/^sha256:[A-Za-z0-9_-]{43}$/.test(p.publicKeyFingerprint)) return "invalid-enrollment-payload";
    } else if (record.recordType === "device-enrollment-approved") {
      if (![p.inviteId, p.requestId, p.participantId, p.deviceId, p.keyId, p.genesisId].every(isUuid)
          || !/^sha256:[A-Za-z0-9_-]{43}$/.test(p.publicKeyFingerprint)) return "invalid-enrollment-payload";
    } else if (record.recordType === "owner-device-enrollment-consented") {
      if (![p.approvalId, p.requestId, p.participantId, p.deviceId, p.keyId].every(isUuid)) return "invalid-enrollment-payload";
    } else if (!isUuid(p.inviteId) || !isUuid(p.selectedRecordId) || !Array.isArray(p.conflictRecordIds)
        || p.conflictRecordIds.length < 2 || p.conflictRecordIds.length > MAX_HEADS
        || !p.conflictRecordIds.every((id, index) => isUuid(id) && (!index || p.conflictRecordIds[index - 1] < id))
        || !p.conflictRecordIds.includes(p.selectedRecordId)) return "invalid-enrollment-payload";
    if (canonicalJsonBytes(record).byteLength > MAX_RECORD_BYTES) return "membership-record-too-large";
    return null;
  } catch { return "invalid-enrollment-schema"; }
}

function membershipHeadError(record, byId, genesisId) {
  const ancestry = new Map();
  const visiting = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error("membership-cycle");
    if (ancestry.has(id)) return ancestry.get(id);
    const parent = byId.get(id);
    if (!parent) throw new Error("missing-membership-head");
    if (parent.groupId !== record.groupId) throw new Error("cross-group-reference");
    if (!BASE_TYPES.has(parent.recordType) && !TYPES.has(parent.recordType)) throw new Error("invalid-membership-head-type");
    if (parent.recordType === "device-join-request") throw new Error("join-request-not-membership-head");
    if (parent.recordType === "device-join-request") throw new Error("join-request-not-membership-head");
    visiting.add(id);
    const found = new Set([id]);
    if (id !== genesisId) {
      if (!Array.isArray(parent.membershipHeads)) throw new Error("invalid-membership-frontier");
      for (const head of parent.membershipHeads) for (const ancestor of visit(head)) found.add(ancestor);
    } else if (parent.membershipHeads?.length) throw new Error("invalid-genesis-frontier");
    visiting.delete(id);
    ancestry.set(id, found);
    return found;
  }
  try {
    const sets = record.membershipHeads.map(visit);
    if (sets.some((set) => !set.has(genesisId))) return "unrooted-membership-history";
    for (let index = 0; index < sets.length; index += 1) {
      for (let other = index + 1; other < sets.length; other += 1) {
        if (sets[index].has(record.membershipHeads[other]) || sets[other].has(record.membershipHeads[index])) return "invalid-membership-frontier";
      }
    }
    return null;
  } catch (error) { return error.message; }
}

function makeEnvelope(type, groupId, author, heads, payload, causalHeads = []) {
  if (!validHeads([...heads].sort())) throw new TypeError("invalid-membership-heads");
  return {
    id: crypto.randomUUID(), recordType: type, membershipSchemaVersion: 1, protocolVersion: 2, groupId,
    author: { participantId: author.participantId, deviceId: author.deviceId, keyId: author.keyId },
    createdAt: new Date().toISOString(), membershipHeads: [...new Set(heads)].sort(), causalHeads: [...causalHeads].sort(), dependsOn: [], payload
  };
}

async function hashToken(token) {
  if (typeof token !== "string" || !BASE64URL_32.test(token)) throw new TypeError("invalid-invite-token");
  const bytes = decodeKey(token);
  if (!bytes) throw new TypeError("invalid-invite-token");
  return `sha256:${encode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
}

export async function createInviteCommand({ groupId, participantId, membershipHeads, identity, records, trustPin, expiresAt = null, verifiedCausalContexts = [] }) {
  const authority = await resolveMembershipAuthority({ identity, membershipHeads, records, trustPin, role: "organizer", verifiedCausalContexts });
  if (!authority || groupId !== authority.projection.groupId) throw new Error("not-organizer");
  if (!authority.projection.participants.some((person) => person.id === participantId)) throw new Error("invite-participant-not-found");
  if (!isUuid(groupId) || !isUuid(participantId)) throw new TypeError("invalid-invite-target");
  if (!(expiresAt === null || validTimestamp(expiresAt))) throw new TypeError("invalid-invite-expiry");
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = encode(tokenBytes);
  const record = makeEnvelope("invite-issued", groupId, identity, membershipHeads, {
    inviteId: crypto.randomUUID(), participantId, tokenHash: await hashToken(token), expiresAt
  });
  record.signature = await signRecord(record, identity.privateKey);
  return { record, token };
}

export async function createJoinRequestCommand({ invite, token, groupId, membershipHeads, identity, records, trustPin, verifiedCausalContexts = [] }) {
  const projection = await projectSignedMembership(records, { trustPin, atHeads: membershipHeads, verifiedCausalContexts });
  const accepted = projection.invites.find((item) => item.recordId === invite?.id && item.inviteId === invite?.payload?.inviteId);
  if (!accepted || accepted.revoked || groupId !== projection.groupId || !sameRecord(records, invite)) throw new Error("invite-not-authenticated-at-heads");
  if (schemaError(invite) || invite.recordType !== "invite-issued" || invite.payload.tokenHash !== await hashToken(token)) {
    throw new Error("invalid-invite-token");
  }
  const publicBytes = await exportDevicePublicKey(identity.publicKey);
  const record = makeEnvelope("device-join-request", groupId, identity, membershipHeads, {
    inviteId: invite.payload.inviteId, participantId: invite.payload.participantId,
    publicKey: encode(publicBytes), publicKeyFingerprint: await fingerprint(publicBytes)
  });
  record.signature = await signRecord(record, identity.privateKey);
  return record;
}

export async function approveJoinRequestCommand({ invite, request, token, genesis, trustPin, membershipHeads, identity, records, verifiedCausalContexts = [] }) {
  const authority = await resolveMembershipAuthority({ identity, membershipHeads, records, trustPin, role: "organizer", verifiedCausalContexts });
  if (!authority || invite?.groupId !== authority.projection.groupId || request?.groupId !== authority.projection.groupId) throw new Error("not-organizer");
  const accepted = authority.projection.invites.find((item) => item.recordId === invite?.id && item.inviteId === invite?.payload?.inviteId);
  if (!accepted || accepted.revoked || !sameRecord(records, invite)) throw new Error("invite-not-authenticated-at-heads");
  if (schemaError(invite) || invite.recordType !== "invite-issued" || invite.payload.tokenHash !== await hashToken(token)) throw new Error("invalid-invite-token");
  if (schemaError(request) || request.recordType !== "device-join-request" || request.payload.inviteId !== invite.payload.inviteId
      || request.payload.participantId !== invite.payload.participantId || request.groupId !== invite.groupId) throw new Error("invalid-join-request");
  const proposedKeyBytes = decodeKey(request.payload.publicKey);
  const proposedKey = await crypto.subtle.importKey("raw", proposedKeyBytes, { name: "Ed25519" }, false, ["verify"]);
  if (!(await verifyRecord(request, proposedKey)) || await fingerprint(proposedKeyBytes) !== request.payload.publicKeyFingerprint) throw new Error("invalid-join-request-signature");
  const verified = await verifyGroupGenesis(genesis, trustPin);
  if (!verified.ok || genesis.groupId !== invite.groupId) throw new Error("invalid-trusted-genesis");
  const payload = {
    inviteId: invite.payload.inviteId, requestId: request.id, participantId: request.payload.participantId,
    deviceId: request.author.deviceId, keyId: request.author.keyId,
    publicKeyFingerprint: request.payload.publicKeyFingerprint, genesisId: genesis.id
  };
  const record = makeEnvelope("device-enrollment-approved", invite.groupId, identity, membershipHeads, payload);
  record.signature = await signRecord(record, identity.privateKey);
  return record;
}

export async function createOwnerDeviceConsentCommand({ approval, groupId, membershipHeads, identity, records, trustPin, verifiedCausalContexts = [] }) {
  const authority = await resolveMembershipAuthority({ identity, membershipHeads, records, trustPin, role: "owner", verifiedCausalContexts });
  if (!authority || groupId !== authority.projection.groupId) throw new Error("not-owner");
  if (schemaError(approval) || approval.recordType !== "device-enrollment-approved"
      || approval.payload.participantId !== identity.participantId) throw new Error("invalid-owner-device-approval");
  const record = makeEnvelope("owner-device-enrollment-consented", groupId, identity, membershipHeads, {
    approvalId: approval.id, requestId: approval.payload.requestId, participantId: approval.payload.participantId,
    deviceId: approval.payload.deviceId, keyId: approval.payload.keyId
  });
  record.signature = await signRecord(record, identity.privateKey);
  return record;
}

export async function createInviteRevocationCommand({ inviteId, groupId, membershipHeads, identity, records, trustPin, verifiedCausalContexts = [] }) {
  const authority = await resolveMembershipAuthority({ identity, membershipHeads, records, trustPin, role: "organizer", verifiedCausalContexts });
  if (!authority || groupId !== authority.projection.groupId) throw new Error("not-organizer");
  if (!isUuid(inviteId) || !isUuid(groupId)) throw new TypeError("invalid-invite-id");
  const record = makeEnvelope("invite-revoked", groupId, identity, membershipHeads, { inviteId });
  record.signature = await signRecord(record, identity.privateKey);
  return record;
}

export async function createDeviceRevocationCommand({ participantId, deviceId, keyId, groupId, membershipHeads, identity, records, trustPin, causalContext, verifiedCausalContexts = [] }) {
  if (!isVerifiedCausalContext(causalContext, groupId, trustPin)) throw new Error("causal-frontier-unverified");
  const contexts = [...verifiedCausalContexts, causalContext];
  const authority = await resolveMembershipAuthority({ identity, membershipHeads, records, trustPin, role: "organizer", verifiedCausalContexts: contexts });
  if (!authority || groupId !== authority.projection.groupId) throw new Error("not-organizer");
  if (!isUuid(participantId) || !isUuid(deviceId) || !isUuid(keyId)) throw new TypeError("invalid-removal-target");
  if (!authority.projection.devices.some((device) => device.participantId === participantId && device.deviceId === deviceId && device.keyId === keyId)) {
    throw new Error("device-not-active-at-heads");
  }
  const record = makeEnvelope("device-revoked", groupId, identity, membershipHeads, {
    participantId, deviceId, keyId, keyEpoch: authority.projection.keyEpoch + 1
  }, causalContext.frontier);
  record.signature = await signRecord(record, identity.privateKey);
  return record;
}

export async function createParticipantRemovalCommand({ participantId, groupId, membershipHeads, identity, records, trustPin, causalContext, verifiedCausalContexts = [] }) {
  if (!isVerifiedCausalContext(causalContext, groupId, trustPin)) throw new Error("causal-frontier-unverified");
  const contexts = [...verifiedCausalContexts, causalContext];
  const authority = await resolveMembershipAuthority({ identity, membershipHeads, records, trustPin, role: "organizer", verifiedCausalContexts: contexts });
  if (!authority || groupId !== authority.projection.groupId) throw new Error("not-organizer");
  if (!isUuid(participantId)) throw new TypeError("invalid-removal-target");
  if (!authority.projection.participants.some((participant) => participant.id === participantId)) throw new Error("participant-not-active-at-heads");
  const record = makeEnvelope("participant-removed", groupId, identity, membershipHeads, {
    participantId, keyEpoch: authority.projection.keyEpoch + 1
  }, causalContext.frontier);
  record.signature = await signRecord(record, identity.privateKey);
  return record;
}

export async function createInviteConflictResolutionCommand({ inviteId, conflictRecordIds, selectedRecordId, groupId, membershipHeads, identity, records, trustPin, verifiedCausalContexts = [] }) {
  const authority = await resolveMembershipAuthority({ identity, membershipHeads, records, trustPin, role: "owner", verifiedCausalContexts });
  if (!authority || groupId !== authority.projection.groupId) throw new Error("not-owner");
  const record = makeEnvelope("membership-conflict-resolved", groupId, identity, membershipHeads, {
    inviteId, conflictRecordIds: [...conflictRecordIds].sort(), selectedRecordId
  });
  record.signature = await signRecord(record, identity.privateKey);
  return record;
}

export async function createOwnershipTransferProposalCommand({ groupId, recipientParticipantId, recipientDeviceId, recipientKeyId, membershipHeads, identity, records, trustPin, verifiedCausalContexts = [] }) {
  const authority = await resolveMembershipAuthority({ identity, membershipHeads, records, trustPin, role: "owner", verifiedCausalContexts });
  if (!authority || groupId !== authority.projection.groupId) throw new Error("not-owner");
  const recipient = authority.projection.devices.find((device) => device.participantId === recipientParticipantId
    && device.deviceId === recipientDeviceId && device.keyId === recipientKeyId);
  if (!recipient || recipientParticipantId === authority.projection.ownerParticipantId) throw new Error("transfer-recipient-not-active");
  const record = makeEnvelope("ownership-transfer-proposed", groupId, identity, membershipHeads, {
    transferId: crypto.randomUUID(), ownerParticipantId: authority.projection.ownerParticipantId,
    recipientParticipantId, recipientDeviceId, recipientKeyId
  });
  record.signature = await signRecord(record, identity.privateKey);
  return record;
}

export async function createOwnershipTransferAcceptanceCommand({ proposal, groupId, membershipHeads, identity, records, trustPin, verifiedCausalContexts = [] }) {
  const projection = await projectSignedMembership(records, { trustPin, atHeads: membershipHeads, verifiedCausalContexts });
  if (projection.readOnly || projection.groupId !== groupId || !sameRecord(records, proposal)
      || !projection.ownershipTransfers.some((item) => item.proposalId === proposal.id && !item.acceptanceId)) {
    throw new Error("transfer-proposal-not-authenticated-at-heads");
  }
  const authority = await resolveMembershipAuthority({ identity, membershipHeads, records, trustPin, role: "member", verifiedCausalContexts });
  if (!authority || proposal.payload.recipientParticipantId !== identity.participantId
      || proposal.payload.recipientDeviceId !== identity.deviceId || proposal.payload.recipientKeyId !== identity.keyId) {
    throw new Error("transfer-recipient-key-mismatch");
  }
  const record = makeEnvelope("ownership-transfer-accepted", groupId, identity, membershipHeads, {
    proposalId: proposal.id, transferId: proposal.payload.transferId
  });
  record.signature = await signRecord(record, identity.privateKey);
  return record;
}

export async function createOwnershipTransferResolutionCommand({ conflictRecordIds, selectedRecordId, groupId, membershipHeads, identity, records, trustPin, verifiedCausalContexts = [] }) {
  const authority = await resolveMembershipAuthority({ identity, membershipHeads, records, trustPin, role: "owner", verifiedCausalContexts });
  if (!authority || groupId !== authority.projection.groupId) throw new Error("not-owner");
  const sorted = [...conflictRecordIds].sort();
  if (sorted.length !== authority.projection.transferConflictRecordIds.length
      || sorted.some((id, index) => id !== authority.projection.transferConflictRecordIds[index])
      || !sorted.includes(selectedRecordId)) throw new Error("incomplete-transfer-conflict-set");
  const record = makeEnvelope("ownership-transfer-resolved", groupId, identity, membershipHeads, {
    conflictRecordIds: sorted, selectedRecordId
  });
  record.signature = await signRecord(record, identity.privateKey);
  return record;
}

function sameRecord(records, supplied) {
  if (!Array.isArray(records) || !supplied || typeof supplied !== "object") return false;
  try {
    const canonical = new TextDecoder().decode(canonicalJsonBytes(supplied));
    return records.some((record) => record?.id === supplied.id
      && new TextDecoder().decode(canonicalJsonBytes(record)) === canonical);
  } catch { return false; }
}

export { createVerifiedCausalContext, projectSignedMembership as projectMembershipEnrollment };
