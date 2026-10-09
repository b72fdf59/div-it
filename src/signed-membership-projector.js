import { canonicalJsonBytes, verifyRecord } from "./identity-crypto.js";
import { verifyGroupGenesis } from "./group-genesis.js";
import { foldMembershipStateAt, membershipAncestorsOf, validateMembershipRecord } from "./membership-projector.js";
import { parseSignedLedgerRecord } from "./signed-ledger-records.js";
import { analyzeCausalGraph, maximalCausalFrontier, validateCausalFrontier } from "./causal-graph.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9_-]{43}$/;
const SIG = /^[A-Za-z0-9_-]{86}$/;
const MAX = 256;
const verifiedCausalContexts = new WeakMap();
const TYPES = new Set(["invite-issued", "invite-revoked", "device-join-request", "device-enrollment-approved", "owner-device-enrollment-consented", "membership-conflict-resolved", "ownership-transfer-proposed", "ownership-transfer-accepted", "ownership-transfer-resolved", "device-revoked", "participant-removed"]);
const BASE = new Set(["group-created", "participant-added", "participant-renamed", "organizer-granted", "organizer-revoked"]);
const FIELDS = ["id", "recordType", "membershipSchemaVersion", "protocolVersion", "groupId", "author", "createdAt", "membershipHeads", "causalHeads", "dependsOn", "payload", "signature"];
const AUTHOR = ["participantId", "deviceId", "keyId"];
const PAYLOADS = {
  "invite-issued": ["inviteId", "participantId", "tokenHash", "expiresAt"],
  "invite-revoked": ["inviteId"],
  "device-join-request": ["inviteId", "participantId", "publicKey", "publicKeyFingerprint"],
  "device-enrollment-approved": ["inviteId", "requestId", "participantId", "deviceId", "keyId", "publicKeyFingerprint", "genesisId"],
  "owner-device-enrollment-consented": ["approvalId", "requestId", "participantId", "deviceId", "keyId"],
  "membership-conflict-resolved": ["inviteId", "conflictRecordIds", "selectedRecordId"],
  "ownership-transfer-proposed": ["transferId", "ownerParticipantId", "recipientParticipantId", "recipientDeviceId", "recipientKeyId"],
  "ownership-transfer-accepted": ["proposalId", "transferId"],
  "ownership-transfer-resolved": ["conflictRecordIds", "selectedRecordId"],
  "device-revoked": ["participantId", "deviceId", "keyId", "keyEpoch"],
  "participant-removed": ["participantId", "keyEpoch"]
};

const uuid = (value) => typeof value === "string" && UUID.test(value);
function exact(value, fields) {
  try {
    return !!value && typeof value === "object" && !Array.isArray(value)
      && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
      && Object.getOwnPropertySymbols(value).length === 0 && Object.keys(value).length === fields.length
      && fields.every((field) => Object.hasOwn(value, field)) && Object.keys(value).every((field) => fields.includes(field));
  } catch { return false; }
}
function b64(bytes) {
  let out = ""; for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function unb64(value) {
  if (typeof value !== "string" || !KEY.test(value)) return null;
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/") + "="), (c) => c.charCodeAt(0));
    return bytes.length === 32 && b64(bytes) === value ? bytes : null;
  } catch { return null; }
}
async function fingerprint(bytes) { return `sha256:${b64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`; }
function canonical(record) { try { return new TextDecoder().decode(canonicalJsonBytes(record)); } catch { return "<invalid>"; } }
function timestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value); return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function schemaError(record) {
  try {
    if (!exact(record, FIELDS) || !TYPES.has(record.recordType)) return "invalid-enrollment-schema";
    if (record.membershipSchemaVersion !== 1 || record.protocolVersion !== 2) return "unsupported-membership-version";
    if (!uuid(record.id) || !uuid(record.groupId) || !exact(record.author, AUTHOR) || !AUTHOR.every((field) => uuid(record.author[field]))) return "invalid-enrollment-schema";
    const removal = ["device-revoked", "participant-removed"].includes(record.recordType);
    const causalHeadsValid = removal
      ? Array.isArray(record.causalHeads) && record.causalHeads.length <= 64
        && record.causalHeads.every((id, i) => uuid(id) && (!i || record.causalHeads[i - 1] < id))
      : Array.isArray(record.causalHeads) && record.causalHeads.length === 0;
    if (!timestamp(record.createdAt) || !Array.isArray(record.membershipHeads) || !record.membershipHeads.length || record.membershipHeads.length > 64
        || !record.membershipHeads.every((id, i) => uuid(id) && (!i || record.membershipHeads[i - 1] < id))
        || !causalHeadsValid || !Array.isArray(record.dependsOn) || record.dependsOn.length
        || typeof record.signature !== "string" || !SIG.test(record.signature)) return "invalid-enrollment-schema";
    const p = record.payload;
    if (!exact(p, PAYLOADS[record.recordType])) return "invalid-enrollment-payload";
    if (record.recordType === "invite-issued") {
      if (!uuid(p.inviteId) || !uuid(p.participantId) || !/^sha256:[A-Za-z0-9_-]{43}$/.test(p.tokenHash)
          || !(p.expiresAt === null || timestamp(p.expiresAt))) return "invalid-enrollment-payload";
    } else if (record.recordType === "invite-revoked") {
      if (!uuid(p.inviteId)) return "invalid-enrollment-payload";
    } else if (record.recordType === "device-join-request") {
      if (!uuid(p.inviteId) || p.participantId !== record.author.participantId || !uuid(p.participantId)
          || !unb64(p.publicKey) || !/^sha256:[A-Za-z0-9_-]{43}$/.test(p.publicKeyFingerprint)) return "invalid-enrollment-payload";
    } else if (record.recordType === "device-enrollment-approved") {
      if (![p.inviteId, p.requestId, p.participantId, p.deviceId, p.keyId, p.genesisId].every(uuid)
          || !/^sha256:[A-Za-z0-9_-]{43}$/.test(p.publicKeyFingerprint)) return "invalid-enrollment-payload";
    } else if (record.recordType === "owner-device-enrollment-consented") {
      if (![p.approvalId, p.requestId, p.participantId, p.deviceId, p.keyId].every(uuid)) return "invalid-enrollment-payload";
    } else if (record.recordType === "ownership-transfer-proposed") {
      if (![p.transferId, p.ownerParticipantId, p.recipientParticipantId, p.recipientDeviceId, p.recipientKeyId].every(uuid)
          || p.ownerParticipantId === p.recipientParticipantId) return "invalid-enrollment-payload";
    } else if (record.recordType === "ownership-transfer-accepted") {
      if (![p.proposalId, p.transferId].every(uuid)) return "invalid-enrollment-payload";
    } else if (record.recordType === "device-revoked") {
      if (![p.participantId, p.deviceId, p.keyId].every(uuid) || !Number.isSafeInteger(p.keyEpoch) || p.keyEpoch < 2) return "invalid-enrollment-payload";
    } else if (record.recordType === "participant-removed") {
      if (!uuid(p.participantId) || !Number.isSafeInteger(p.keyEpoch) || p.keyEpoch < 2) return "invalid-enrollment-payload";
    } else if (!Array.isArray(p.conflictRecordIds)
        || p.conflictRecordIds.length < 2 || p.conflictRecordIds.length > 64
        || !p.conflictRecordIds.every((id, i) => uuid(id) && (!i || p.conflictRecordIds[i - 1] < id))
        || !uuid(p.selectedRecordId) || !p.conflictRecordIds.includes(p.selectedRecordId)
        || (record.recordType === "membership-conflict-resolved" && !uuid(p.inviteId))) return "invalid-enrollment-payload";
    if (canonicalJsonBytes(record).byteLength > 8192) return "membership-record-too-large";
    return null;
  } catch { return "invalid-enrollment-schema"; }
}

function compatibilityEnvelopeError(record) {
  try {
    if (!exact(record, FIELDS) || typeof record.recordType !== "string" || !record.recordType.length || record.recordType.length > 64
        || !uuid(record.id) || !uuid(record.groupId)
        || !exact(record.author, AUTHOR) || !AUTHOR.every((field) => uuid(record.author[field]))
        || !timestamp(record.createdAt) || !Array.isArray(record.membershipHeads) || !record.membershipHeads.length
        || record.membershipHeads.length > 64 || !record.membershipHeads.every((id, i) => uuid(id) && (!i || record.membershipHeads[i - 1] < id))
        || !Array.isArray(record.causalHeads) || record.causalHeads.length > 64
        || !record.causalHeads.every((id, i) => uuid(id) && (!i || record.causalHeads[i - 1] < id))
        || !Array.isArray(record.dependsOn) || record.dependsOn.length > 256
        || !record.dependsOn.every((id, i) => uuid(id) && (!i || record.dependsOn[i - 1] < id))
        || !record.payload || typeof record.payload !== "object" || Array.isArray(record.payload)
        || typeof record.signature !== "string" || !SIG.test(record.signature)
        || !Number.isSafeInteger(record.membershipSchemaVersion) || record.membershipSchemaVersion < 1
        || !Number.isSafeInteger(record.protocolVersion) || record.protocolVersion < 1
        || canonicalJsonBytes(record).byteLength > 8192) return "invalid-membership-schema";
    return null;
  } catch { return "invalid-membership-schema"; }
}

function relation(record, ancestorId, byId, visiting = new Set()) {
  if (record.id === ancestorId || record.membershipHeads.includes(ancestorId)) return true;
  if (visiting.has(record.id)) return false;
  visiting.add(record.id);
  const result = record.membershipHeads.some((head) => {
    const parent = byId.get(head);
    return parent && relation(parent, ancestorId, byId, visiting);
  });
  visiting.delete(record.id);
  return result;
}

function closureFromHeads(heads, byId, groupId, genesisId, records = new Set(), visiting = new Set()) {
  for (const head of heads) {
    if (visiting.has(head)) throw new Error("membership-cycle");
    if (byId.has(`!collision:${head}`)) throw new Error("membership-parent-id-collision");
    const record = byId.get(head);
    if (!record) throw new Error("missing-membership-head");
    if (record.groupId !== groupId) throw new Error("cross-group-reference");
    if (!BASE.has(record.recordType) && !TYPES.has(record.recordType)) throw new Error("invalid-membership-head-type");
    if (record.recordType === "device-join-request") throw new Error("join-request-not-membership-head");
    if (records.has(head)) continue;
    visiting.add(head); records.add(head);
    if (head !== genesisId) {
      if (!Array.isArray(record.membershipHeads)) throw new Error("invalid-membership-frontier");
      closureFromHeads(record.membershipHeads, byId, groupId, genesisId, records, visiting);
    } else if (record.membershipHeads?.length) throw new Error("invalid-genesis-frontier");
    visiting.delete(head);
  }
  if (!records.has(genesisId)) throw new Error("unrooted-membership-history");
  return records;
}

function diag(status, reason, record, extra = {}) { return { status, reason, ...(record?.id ? { recordId: record.id } : {}), ...extra, ...(record ? { rawRecord: record } : {}) }; }
function stable(diagnostics) {
  return diagnostics.sort((a, b) => `${a.recordId || ""}:${a.status}:${a.reason || ""}:${canonical(a.rawRecord)}`.localeCompare(`${b.recordId || ""}:${b.status}:${b.reason || ""}:${canonical(b.rawRecord)}`));
}

/** Authenticate a caller's observed ledger records and bind their verified causal graph as a removal frontier source. */
export async function createVerifiedCausalContext({ causalRecords, membershipRecords, trustPin, priorContexts = [] } = {}) {
  if (!Array.isArray(causalRecords) || !Array.isArray(membershipRecords) || !trustPin || !Array.isArray(priorContexts)) {
    throw new TypeError("invalid-causal-context-input");
  }
  const contextOptions = { trustPin, verifiedCausalContexts: priorContexts };
  const membership = await projectSignedMembership(membershipRecords, contextOptions);
  if (!membership.groupId || membership.readOnly) throw new Error("causal-context-membership-untrusted");
  if (priorContexts.some((context) => {
    const proof = verifiedCausalContexts.get(context);
    return !proof || context.groupId !== membership.groupId || proof.genesisId !== trustPin.genesisId
      || proof.publicKeyFingerprint !== trustPin.publicKeyFingerprint;
  })) {
    throw new Error("causal-context-invalid-prior-context");
  }
  const verified = priorContexts.flatMap((context) => verifiedCausalContexts.get(context)?.sourceRecords || []);
  for (const raw of causalRecords) {
    const parsed = parseSignedLedgerRecord(raw);
    if (!parsed.ok) throw new Error(`causal-context-${parsed.reason}`);
    const record = parsed.record;
    if (record.groupId !== membership.groupId) throw new Error("causal-context-group-mismatch");
    const atHeads = await projectSignedMembership(membershipRecords, { ...contextOptions, atHeads: record.membershipHeads });
    if (atHeads.groupId !== membership.groupId || atHeads.readOnly) throw new Error("causal-context-membership-untrusted");
    const participantExists = atHeads.participants.some((participant) => participant.id === record.author.participantId);
    const device = atHeads.devices.find((item) => item.participantId === record.author.participantId
      && item.deviceId === record.author.deviceId && item.keyId === record.author.keyId);
    const keyBytes = device && unb64(device.publicKey);
    if (!participantExists || !keyBytes) throw new Error("causal-context-unknown-device");
    const publicKey = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    if (!(await verifyRecord(record, publicKey))) throw new Error("causal-context-invalid-signature");
    verified.push(record);
  }
  const uniqueVerified = [...new Map(verified.map((record) => [canonical(record), record])).values()];
  const graph = analyzeCausalGraph(uniqueVerified, { groupId: membership.groupId });
  if (!graph.ok) throw new Error(`causal-context-${graph.reason}`);
  const invalid = graph.diagnostics.find((item) => item.status !== "valid");
  if (invalid) throw new Error(`causal-context-${invalid.reason}`);
  const frontier = maximalCausalFrontier(graph, graph.nodes.map((node) => node.id));
  if (!frontier.ok) throw new Error(`causal-context-${frontier.reason}`);
  const context = Object.freeze({ groupId: membership.groupId, genesisId: trustPin.genesisId,
    publicKeyFingerprint: trustPin.publicKeyFingerprint, frontier: Object.freeze([...frontier.heads]),
    sourceRecordIds: Object.freeze(graph.nodes.map((node) => node.id).sort()) });
  verifiedCausalContexts.set(context, { graph, sourceRecords: uniqueVerified,
    genesisId: trustPin.genesisId, publicKeyFingerprint: trustPin.publicKeyFingerprint });
  return context;
}

export function isVerifiedCausalContext(context, groupId, trustPin) {
  const proof = verifiedCausalContexts.get(context);
  return !!proof && context.groupId === groupId && proof.genesisId === trustPin?.genesisId
    && proof.publicKeyFingerprint === trustPin?.publicKeyFingerprint;
}

function causalContextCovers(contexts, groupId, heads, trustPin) {
  if (!heads.length) return true;
  for (const context of contexts) {
    const proof = verifiedCausalContexts.get(context);
    if (proof && context.groupId === groupId && proof.genesisId === trustPin?.genesisId
        && proof.publicKeyFingerprint === trustPin?.publicKeyFingerprint && validateCausalFrontier(proof.graph, heads).ok) return true;
  }
  return false;
}

export async function projectSignedMembership(input, { trustPin, atHeads, allowConflictHeads = false, verifiedCausalContexts = [] } = {}) {
  const rawRecords = Array.isArray(input) ? input : [];
  const diagnostics = [];
  const variants = new Map();
  const variantKeys = new Map();
  const compatibilityCandidates = new Map();
  const collisions = new Set();
  const duplicateCounts = new Map();
  let uniqueVariantCount = 0;
  let readOnly = false;
  for (const record of rawRecords) {
    let type;
    try { type = record?.recordType; } catch { diagnostics.push(diag("quarantined", "invalid-membership-schema", record)); continue; }
    let id;
    try { id = record.id; } catch { diagnostics.push(diag("quarantined", "invalid-membership-id", record)); continue; }
    if (!uuid(id)) { diagnostics.push(diag("quarantined", "invalid-membership-id", record)); continue; }
    const key = canonical(record);
    const keys = variantKeys.get(id) || new Set();
    if (keys.has(key)) {
      duplicateCounts.set(id, (duplicateCounts.get(id) || 0) + 1);
      continue;
    }
    keys.add(key); variantKeys.set(id, keys); uniqueVariantCount += 1;
    if (keys.size > 1) {
      collisions.add(id); diagnostics.push(diag("quarantined", "id-content-collision", record, { recordId: id }));
    } else if (!BASE.has(type) && !TYPES.has(type)) compatibilityCandidates.set(id, record);
    else {
      variants.set(id, { key, record });
      if (BASE.has(type) && id !== trustPin?.genesisId
          && (record.membershipSchemaVersion !== 1 || record.protocolVersion !== 2)) compatibilityCandidates.set(id, record);
    }
    if (uniqueVariantCount > MAX) return empty(rawRecords, diagnostics.concat({ status: "quarantined", reason: "membership-record-limit" }), true);
  }
  for (const [recordId, duplicateCount] of duplicateCounts) diagnostics.push({ recordId, status: "duplicate", reason: "duplicate-membership-record", duplicateCount });
  const genesisId = trustPin?.genesisId;
  if (collisions.has(genesisId)) return empty(rawRecords, diagnostics.concat({ status: "quarantined", reason: "trusted-genesis-id-collision" }), true);
  const genesis = variants.get(genesisId)?.record;
  const verifiedGenesis = await verifyGroupGenesis(genesis, trustPin);
  if (!verifiedGenesis.ok) return empty(rawRecords, diagnostics.concat(diag("quarantined", verifiedGenesis.reason, genesis)), true);
  const groupId = genesis.groupId;
  const byId = new Map([...variants].filter(([id]) => !collisions.has(id)).map(([id, entry]) => [id, entry.record]));
  for (const id of collisions) byId.set(`!collision:${id}`, { id, recordType: "collision", groupId });

  const errors = new Map();
  for (const [id, record] of byId) {
    if (id === genesisId) continue;
    if (record.groupId !== groupId) { errors.set(id, "cross-group-record"); continue; }
    if (BASE.has(record.recordType)) continue;
    const error = schemaError(record);
    if (error) {
      errors.set(id, error);
      if (error === "unsupported-membership-version") compatibilityCandidates.set(id, record);
      continue;
    }
  }
  const structural = new Map();
  for (const [id, record] of byId) {
    if (id === genesisId || !TYPES.has(record.recordType) || errors.has(id)) continue;
    try {
      const closure = closureFromHeads(record.membershipHeads, byId, groupId, genesisId);
      const list = [...record.membershipHeads];
      if (list.some((head, i) => list.some((other, j) => i !== j && relation(byId.get(other), head, byId))) ) errors.set(id, "invalid-membership-frontier");
      else structural.set(id, closure);
    } catch (error) { errors.set(id, error.message); }
  }

  const effective = new Set([genesisId]);
  const acceptedBase = new Map();
  const baseErrors = new Map();
  const valid = new Map();
  const requests = new Map();
  const inviteIssues = new Map();
  const inviteRevocations = new Map();
  const approvals = new Map();
  const deviceBindings = new Map();
  const deviceIdConflicts = new Set();
  const consents = new Map();
  const resolutions = new Map();
  const transferProposals = new Map();
  const transferAcceptances = new Map();
  const transferResolutions = new Map();
  const deviceRevocations = new Map();
  const participantRemovals = new Map();
  const pendingRecords = new Set();
  const pendingReasons = new Map();

  const contexts = Array.isArray(verifiedCausalContexts) ? verifiedCausalContexts : [];
  function participantRemoved(participantId, closure) {
    return [...participantRemovals.values()].some((record) => effective.has(record.id) && closure.has(record.id)
      && record.payload.participantId === participantId);
  }
  function deviceRemoved(deviceId, participantId, closure) {
    return participantRemoved(participantId, closure) || [...deviceRevocations.values()].some((record) => effective.has(record.id)
      && closure.has(record.id) && record.payload.deviceId === deviceId
      && (!participantId || record.payload.participantId === participantId));
  }
  function keyEpochAt(closure) {
    return Math.max(1, ...[...deviceRevocations.values(), ...participantRemovals.values()]
      .filter((record) => effective.has(record.id) && closure.has(record.id)).map((record) => record.payload.keyEpoch));
  }
  function authorRemovedBefore(record, closure) {
    return record && [...deviceRevocations.values(), ...participantRemovals.values()].some((removal) =>
      effective.has(removal.id) && closure.has(removal.id) && removal.id !== record.id
      && (removal.recordType === "participant-removed"
        ? removal.payload.participantId === record.author?.participantId
        : removal.payload.participantId === record.author?.participantId && removal.payload.deviceId === record.author?.deviceId)
      && !relation(removal, record.id, byId));
  }
  function enrollmentRemovedBefore(approval, closure) {
    return [...deviceRevocations.values(), ...participantRemovals.values()].some((removal) => {
      if (!effective.has(removal.id) || !closure.has(removal.id)) return false;
      const targetMatches = removal.payload.participantId === approval.payload.participantId
        && (removal.recordType === "participant-removed" || removal.payload.deviceId === approval.payload.deviceId);
      return targetMatches && !relation(removal, approval.id, byId);
    });
  }

  function acceptedTransfersAt(closure) {
    let accepted = [...transferAcceptances.values()].filter((record) => closure.has(record.id) && effective.has(record.id))
      .map((record) => ({ record, proposal: transferProposals.get(record.payload.proposalId) }))
      .filter(({ proposal }) => proposal && closure.has(proposal.id) && effective.has(proposal.id) && !authorRemovedBefore(proposal, closure));
    accepted = accepted.filter(({ record, proposal }) => ![...deviceRevocations.values(), ...participantRemovals.values()].some((removal) => {
      if (!effective.has(removal.id) || !closure.has(removal.id)) return false;
      const targetsParticipant = removal.recordType === "participant-removed"
        ? removal.payload.participantId === proposal.payload.recipientParticipantId
        : removal.payload.participantId === proposal.payload.recipientParticipantId
          && removal.payload.deviceId === proposal.payload.recipientDeviceId;
      return targetsParticipant && !relation(removal, record.id, byId);
    }));
    const resolutionGroups = new Map();
    for (const resolution of transferResolutions.values()) {
      const roots = resolution.payload.conflictRecordIds;
      if (!closure.has(resolution.id) || !roots.every((id) => accepted.some(({ record }) => record.id === id)
          && relation(resolution, id, byId))) continue;
      const key = canonical(roots);
      (resolutionGroups.get(key) || resolutionGroups.set(key, []).get(key)).push(resolution);
    }
    for (const [key, resolutionsForConflict] of resolutionGroups) {
      const maximalResolutions = resolutionsForConflict.filter((candidate) => !resolutionsForConflict.some((other) =>
        candidate.id !== other.id && relation(other, candidate.id, byId)));
      const selections = new Set(maximalResolutions.map((record) => record.payload.selectedRecordId));
      if (selections.size !== 1) continue;
      const roots = JSON.parse(key);
      const selected = maximalResolutions[0].payload.selectedRecordId;
      accepted = accepted.filter(({ record }) => !roots.some((root) => root !== selected
        && relation(record, root, byId) && !relation(record, selected, byId)));
    }
    return accepted;
  }

  function ownerAt(closure) {
    const accepted = acceptedTransfersAt(closure);
    if (!accepted.length) return genesis.author.participantId;
    const maximal = accepted.filter(({ record: candidate }) => !accepted.some(({ record: other }) => candidate.id !== other.id && relation(other, candidate.id, byId)));
    const recipients = new Set(maximal.map(({ proposal }) => proposal.payload.recipientParticipantId));
    if (recipients.size === 1) return maximal[0].proposal.payload.recipientParticipantId;
    const commonAccepted = accepted.filter(({ record }) => maximal.every(({ record: branch }) => relation(branch, record.id, byId)));
    const commonMaximal = commonAccepted.filter(({ record: candidate }) => !commonAccepted.some(({ record: other }) => candidate.id !== other.id && relation(other, candidate.id, byId)));
    if (commonMaximal.length === 1) return commonMaximal[0].proposal.payload.recipientParticipantId;
    const priorOwners = new Set(maximal.map(({ proposal }) => proposal.payload.ownerParticipantId));
    if (priorOwners.size === 1) return priorOwners.values().next().value;
    // If malformed or overlapping histories do not yield one shared causal owner, retain genesis.
    return genesis.author.participantId;
  }

  async function baseAt(heads) {
    let closure;
    try { closure = closureFromHeads(heads, byId, groupId, genesisId); }
    catch (error) { return { error: error.message }; }
    if ([...closure].some((id) => BASE.has(byId.get(id)?.recordType) && id !== genesisId && !acceptedBase.has(id))) return { error: "invalid-membership-ancestor" };
    const state = foldMembershipStateAt(heads, genesis, [...acceptedBase.values()].filter((record) => closure.has(record.id) && !authorRemovedBefore(record, closure)), byId);
    const currentOwner = ownerAt(closure);
    const removedParticipants = new Set([...participantRemovals.values()].filter((record) => effective.has(record.id) && closure.has(record.id))
      .map((record) => record.payload.participantId));
    const projection = {
      groupId, groupName: genesis.payload.name, currency: genesis.payload.currency,
      ownerParticipantId: currentOwner,
      participants: [...state.participants].filter(([id]) => !removedParticipants.has(id)).map(([id, person]) => ({ id, name: person.name })).sort((a, b) => a.id.localeCompare(b.id)),
      organizers: [...new Set([...state.organizers].filter((id) => !removedParticipants.has(id)).concat(removedParticipants.has(currentOwner) ? [] : [currentOwner]))].sort(),
      keyEpoch: keyEpochAt(closure), diagnostics: state.conflicts.map((conflict) => ({ status: "conflicting", reason: conflict.type, participantId: conflict.participantId, recordIds: conflict.recordIds }))
    };
    return { projection, closure };
  }

  function matchingEnrollment(author, closure) {
    const key = `${author.participantId}:${author.deviceId}:${author.keyId}`;
    const ownerKey = `${genesis.author.participantId}:${genesis.author.deviceId}:${genesis.author.keyId}`;
    const currentOwner = ownerAt(closure);
    if (deviceRemoved(author.deviceId, author.participantId, closure)) return null;
    if (key === ownerKey && !deviceIdConflicts.has(genesis.author.deviceId)) return { key: genesis.payload.owner.publicKey, participantId: genesis.author.participantId, role: currentOwner === genesis.author.participantId ? "owner" : null, sourceRequestId: null };
    for (const [approvalId, approval] of approvals) {
      if (!closure.has(approvalId) || !effective.has(approvalId)) continue;
      const p = approval.payload;
      if (deviceIdConflicts.has(p.deviceId)) continue;
      if (`${p.participantId}:${p.deviceId}:${p.keyId}` !== key) continue;
      const request = requests.get(p.requestId);
      if (!request || request.payload.publicKeyFingerprint !== p.publicKeyFingerprint) continue;
      const ownerAtEnrollment = ownerAt(structural.get(approvalId));
      if (p.participantId === ownerAtEnrollment) {
        const ownerApproved = approval.author.participantId === ownerAtEnrollment;
        const consented = [...consents].some(([consentId, consent]) => closure.has(consentId) && consent.payload.approvalId === approvalId
          && consent.author.participantId === ownerAtEnrollment);
        if (!ownerApproved && !consented) continue;
      }
      return { key: request.payload.publicKey, participantId: p.participantId,
        role: p.participantId === currentOwner ? "owner" : null,
        sourceRequestId: request.id, approvalId };
    }
    return null;
  }

  async function verifyBase(record) {
    if (acceptedBase.has(record.id) || baseErrors.has(record.id) || compatibilityCandidates.has(record.id)) return false;
    const schema = validateMembershipRecord(record);
    if (schema) { baseErrors.set(record.id, schema); return false; }
    let closure;
    try { closure = closureFromHeads(record.membershipHeads, byId, groupId, genesisId); }
    catch (error) { if (error.message !== "missing-membership-head") baseErrors.set(record.id, error.message); return false; }
    if ([...closure].some((id) => BASE.has(byId.get(id)?.recordType) && id !== genesisId && id !== record.id && !acceptedBase.has(id))) return false;
    if (record.membershipHeads.some((id) => !effective.has(id))) return false;
    const state = await baseAt(record.membershipHeads);
    if (state.error) return false;
    const signer = matchingEnrollment(record.author, closure);
    if (!signer) return false;
    const keyBytes = unb64(signer.key);
    if (!keyBytes) { baseErrors.set(record.id, "invalid-authorized-public-key"); return false; }
    const publicKey = await crypto.subtle.importKey("raw", keyBytes, { name: "Ed25519" }, false, ["verify"]);
    if (!(await verifyRecord(record, publicKey))) { baseErrors.set(record.id, "invalid-membership-signature"); return false; }
    const actor = record.author.participantId;
    const ownerId = state.projection.ownerParticipantId;
    const organizer = signer.role === "owner" || state.projection.organizers.includes(actor);
    if (["organizer-granted", "organizer-revoked"].includes(record.recordType) && signer.role !== "owner") { baseErrors.set(record.id, "not-owner"); return false; }
    if (["participant-added", "participant-renamed"].includes(record.recordType) && !organizer) { baseErrors.set(record.id, "not-organizer"); return false; }
    const target = record.payload.participantId;
    const exists = state.projection.participants.some((person) => person.id === target);
    if (record.recordType === "participant-added" && participantRemoved(target, closure)) { baseErrors.set(record.id, "participant-id-tombstoned"); return false; }
    if (record.recordType === "participant-added" && exists) { baseErrors.set(record.id, "participant-already-exists"); return false; }
    if (record.recordType === "participant-renamed" && !exists) { baseErrors.set(record.id, "participant-not-found"); return false; }
    if (["organizer-granted", "organizer-revoked"].includes(record.recordType) && !exists) { baseErrors.set(record.id, "participant-not-found"); return false; }
    if (record.recordType === "organizer-revoked" && target === ownerId) { baseErrors.set(record.id, "owner-role-immutable"); return false; }
    acceptedBase.set(record.id, record);
    effective.add(record.id);
    return true;
  }

  async function verifyOne(record, allowConflictHeads = false) {
    if (["device-revoked", "participant-removed"].includes(record.recordType)
        && !causalContextCovers(contexts, groupId, record.causalHeads, trustPin)) return { pending: "causal-frontier-unverified" };
    const state = await baseAt(record.membershipHeads);
    if (state.error === "invalid-membership-ancestor") return { pending: state.error };
    if (state.error) return { error: state.error };
    for (const head of record.membershipHeads) {
      const headState = valid.get(head);
      const revocationCandidate = [...inviteRevocations.values()].some((items) => items.some((item) => item.id === head));
      if (!effective.has(head) && !(allowConflictHeads && (approvals.has(head) || resolutions.has(head) || revocationCandidate))) return { pending: "membership-head-not-effective" };
    }
    const signer = matchingEnrollment(record.author, state.closure);
    if (!signer) return { pending: "unknown-device-at-membership-heads" };
    const owner = signer.role === "owner";
    const organizer = owner || state.projection.organizers.includes(record.author.participantId);
    if (["invite-issued", "invite-revoked", "device-enrollment-approved", "device-revoked", "participant-removed"].includes(record.recordType) && !organizer) return { error: "not-organizer" };
    if (["owner-device-enrollment-consented", "membership-conflict-resolved", "ownership-transfer-proposed", "ownership-transfer-resolved"].includes(record.recordType) && !owner) return { error: "not-owner" };
    const publicBytes = unb64(signer.key);
    if (!publicBytes) return { error: "invalid-authorized-public-key" };
    const key = await crypto.subtle.importKey("raw", publicBytes, { name: "Ed25519" }, false, ["verify"]);
    if (!(await verifyRecord(record, key))) return { error: "invalid-signature" };
    return { state, signer };
  }

  const bases = [...byId.values()].filter((record) => BASE.has(record.recordType) && record.id !== genesisId && !collisions.has(record.id));
  for (const record of bases.sort((a, b) => a.id.localeCompare(b.id))) {
    await verifyBase(record);
  }
  const transitions = [...byId.values()].filter((record) => TYPES.has(record.recordType) && !errors.has(record.id) && !collisions.has(record.id));
  for (const record of transitions) {
    const error = structural.get(record.id) ? null : errors.get(record.id) || "invalid-membership-frontier";
    if (error) diagnostics.push(diag(error === "missing-membership-head" ? "pending" : "quarantined", error, record));
  }

  // Fixed point: an enrollment only authorizes descendants after its proof and approval are verified.
  for (let pass = 0; pass < MAX; pass += 1) {
    let changed = false;
    for (const record of transitions.sort((a, b) => a.id.localeCompare(b.id))) {
      if (valid.has(record.id) || errors.has(record.id)) continue;
      if (record.recordType === "device-join-request") {
        const invitation = [...inviteIssues.values()].find((item) => item.payload.inviteId === record.payload.inviteId);
        if (!invitation || record.membershipHeads.some((head) => !effective.has(head))) { pendingRecords.add(record.id); continue; }
        const bytes = unb64(record.payload.publicKey);
        const pub = await crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]);
        if (await fingerprint(bytes) !== record.payload.publicKeyFingerprint || !(await verifyRecord(record, pub))) errors.set(record.id, "invalid-signature");
        else { requests.set(record.id, record); valid.set(record.id, "request-proof"); changed = true; }
        continue;
      }
      const checked = await verifyOne(record, ["membership-conflict-resolved", "owner-device-enrollment-consented", "ownership-transfer-resolved"].includes(record.recordType));
      if (checked.pending) { pendingRecords.add(record.id); pendingReasons.set(record.id, checked.pending); continue; }
      if (checked.error) { errors.set(record.id, checked.error); continue; }
      const p = record.payload;
      if (record.recordType === "invite-issued") {
        if (!checked.state.projection.participants.some((person) => person.id === p.participantId)) { errors.set(record.id, "invite-participant-not-found"); continue; }
        if ([...inviteIssues.values()].some((item) => item.payload.inviteId === p.inviteId && canonical(item.payload) !== canonical(p))) { errors.set(record.id, "invite-id-collision"); continue; }
        inviteIssues.set(record.id, record); valid.set(record.id, "effective"); effective.add(record.id); changed = true;
      } else if (record.recordType === "invite-revoked") {
        const issue = [...inviteIssues.values()].find((item) => item.payload.inviteId === p.inviteId && checked.state.closure.has(item.id));
        if (!issue) { pendingRecords.add(record.id); continue; }
        (inviteRevocations.get(p.inviteId) || inviteRevocations.set(p.inviteId, []).get(p.inviteId)).push(record);
        valid.set(record.id, "effective"); changed = true;
      } else if (record.recordType === "device-enrollment-approved") {
        const issue = [...inviteIssues.values()].find((item) => item.payload.inviteId === p.inviteId);
        const request = requests.get(p.requestId);
        if (!issue || !request) { pendingRecords.add(record.id); continue; }
        if (issue.payload.participantId !== p.participantId || request.payload.inviteId !== p.inviteId
            || request.payload.participantId !== p.participantId || request.author.deviceId !== p.deviceId || request.author.keyId !== p.keyId
            || request.payload.publicKeyFingerprint !== p.publicKeyFingerprint || p.genesisId !== genesisId) {
          errors.set(record.id, "approval-binding-mismatch"); continue;
        }
        if (participantRemoved(p.participantId, checked.state.closure) || deviceRemoved(p.deviceId, p.participantId, checked.state.closure)) {
          errors.set(record.id, "identity-already-removed"); continue;
        }
        approvals.set(record.id, record); valid.set(record.id, "approval-candidate");
        const binding = `${p.participantId}:${p.deviceId}:${p.keyId}:${p.publicKeyFingerprint}`;
        const prior = deviceBindings.get(p.deviceId) || (p.deviceId === genesis.author.deviceId
          ? `${genesis.author.participantId}:${genesis.author.deviceId}:${genesis.author.keyId}:${trustPin.publicKeyFingerprint}` : null);
        if (prior && prior !== binding) deviceIdConflicts.add(p.deviceId);
        else deviceBindings.set(p.deviceId, binding);
        changed = true;
      } else if (record.recordType === "owner-device-enrollment-consented") {
        const approval = approvals.get(p.approvalId);
        if (!approval || approval.payload.requestId !== p.requestId || approval.payload.participantId !== p.participantId
            || approval.payload.deviceId !== p.deviceId || approval.payload.keyId !== p.keyId || !checked.state.closure.has(approval.id)) {
          pendingRecords.add(record.id); continue;
        }
        consents.set(record.id, record); valid.set(record.id, "effective"); effective.add(record.id); changed = true;
      } else if (record.recordType === "membership-conflict-resolved") {
        resolutions.set(record.id, record); valid.set(record.id, "resolution-candidate"); changed = true;
      } else if (record.recordType === "ownership-transfer-proposed") {
        const targetAuthor = { participantId: p.recipientParticipantId, deviceId: p.recipientDeviceId, keyId: p.recipientKeyId };
        if (p.ownerParticipantId !== checked.state.projection.ownerParticipantId || !matchingEnrollment(targetAuthor, checked.state.closure)) {
          errors.set(record.id, "transfer-recipient-not-enrolled"); continue;
        }
        transferProposals.set(record.id, record); valid.set(record.id, "effective"); effective.add(record.id); changed = true;
      } else if (record.recordType === "ownership-transfer-accepted") {
        const proposal = transferProposals.get(p.proposalId);
        if (!proposal || !checked.state.closure.has(proposal.id) || !effective.has(proposal.id)
            || proposal.payload.transferId !== p.transferId
            || proposal.payload.recipientParticipantId !== record.author.participantId
            || proposal.payload.recipientDeviceId !== record.author.deviceId
            || proposal.payload.recipientKeyId !== record.author.keyId) {
          errors.set(record.id, "transfer-acceptance-binding-mismatch"); continue;
        }
        transferAcceptances.set(record.id, record); valid.set(record.id, "effective"); effective.add(record.id); changed = true;
      } else if (record.recordType === "ownership-transfer-resolved") {
        const contextAcceptances = [...transferAcceptances.values()].filter((item) => checked.state.closure.has(item.id) && effective.has(item.id));
        const maximal = contextAcceptances.filter((candidate) => !contextAcceptances.some((other) => other.id !== candidate.id && relation(other, candidate.id, byId)));
        const recipients = new Set(maximal.map((item) => transferProposals.get(item.payload.proposalId)?.payload.recipientParticipantId));
        const completeIds = recipients.size > 1 ? maximal.map((item) => item.id).sort() : [];
        if (!completeIds.length || canonical(p.conflictRecordIds) !== canonical(completeIds) || !completeIds.includes(p.selectedRecordId)) {
          errors.set(record.id, "incomplete-transfer-conflict-set"); continue;
        }
        transferResolutions.set(record.id, record); valid.set(record.id, "effective"); effective.add(record.id); changed = true;
      } else if (record.recordType === "device-revoked") {
        const device = matchingEnrollment({ participantId: p.participantId, deviceId: p.deviceId, keyId: p.keyId }, checked.state.closure);
        if (!device) { errors.set(record.id, "device-not-active-at-heads"); continue; }
        if (p.keyEpoch !== checked.state.projection.keyEpoch + 1) { errors.set(record.id, "invalid-key-epoch"); continue; }
        deviceRevocations.set(record.id, record); valid.set(record.id, "effective"); effective.add(record.id); changed = true;
      } else if (record.recordType === "participant-removed") {
        if (!checked.state.projection.participants.some((person) => person.id === p.participantId)) {
          errors.set(record.id, "participant-not-active-at-heads"); continue;
        }
        if (p.keyEpoch !== checked.state.projection.keyEpoch + 1) { errors.set(record.id, "invalid-key-epoch"); continue; }
        participantRemovals.set(record.id, record); valid.set(record.id, "effective"); effective.add(record.id); changed = true;
      }
    }
    const selected = resolveInvites({ inviteIssues, inviteRevocations, approvals, resolutions, byId, genesis, consents, valid, deviceIdConflicts, ownerAt, structural });
    const previousBranchState = new Set([...effective].filter((id) => approvals.has(id) || [...inviteRevocations.values()].some((items) => items.some((item) => item.id === id)) || resolutions.has(id)));
    let enrollmentChanged = false;
    for (const [id, state] of selected.conflicts) {
      effective.delete(id);
      valid.set(id, state);
    }
    const nextBranchState = new Set([...selected.enrollments.keys(), ...selected.effectiveRevocations, ...selected.resolvedResolutions]);
    const allBranchIds = new Set([...approvals.keys(), ...[...inviteRevocations.values()].flatMap((items) => items.map((item) => item.id)), ...resolutions.keys()]);
    for (const id of allBranchIds) {
      if (effective.has(id) && !nextBranchState.has(id)) { effective.delete(id); enrollmentChanged = true; }
    }
    for (const id of nextBranchState) {
      if (!effective.has(id)) { effective.add(id); enrollmentChanged = true; }
      valid.set(id, "effective");
    }
    enrollmentChanged ||= previousBranchState.size !== nextBranchState.size || [...previousBranchState].some((id) => !nextBranchState.has(id));
    for (const record of bases.sort((a, b) => a.id.localeCompare(b.id))) {
      if (await verifyBase(record)) changed = true;
    }
    if (!changed && !enrollmentChanged) break;
  }

  // A branch recipient cannot exercise owner-only powers while another accepted
  // transfer branch remains unresolved. Keep the records as candidates so a later
  // complete resolution can activate the selected branch's descendants.
  const acceptedTransferHeads = acceptedTransfersAt(effective).map(({ record }) => record);
  const maximalTransferHeads = acceptedTransferHeads.filter((candidate) => !acceptedTransferHeads.some((other) =>
    other.id !== candidate.id && relation(other, candidate.id, byId)));
  const branchRecipients = new Set(maximalTransferHeads.map((record) =>
    transferProposals.get(record.payload.proposalId)?.payload.recipientParticipantId));
  const unresolvedTransferBranches = branchRecipients.size > 1 ? maximalTransferHeads : [];
  if (unresolvedTransferBranches.length) {
    const shared = acceptedTransferHeads.filter((record) => unresolvedTransferBranches.every((branch) => relation(branch, record.id, byId)));
    const sharedIds = new Set(shared.map((record) => record.id));
    const lineages = unresolvedTransferBranches.map((branch) => {
      const lineage = acceptedTransferHeads.filter((record) => relation(branch, record.id, byId) && !sharedIds.has(record.id));
      const roots = lineage.filter((candidate) => !lineage.some((other) => other.id !== candidate.id && relation(candidate, other.id, byId)));
      return { roots, owners: new Set(lineage.map((record) => transferProposals.get(record.payload.proposalId)?.payload.recipientParticipantId)) };
    });
    const ownerOnlyTypes = new Set(["organizer-granted", "organizer-revoked", "owner-device-enrollment-consented",
      "membership-conflict-resolved", "ownership-transfer-proposed", "ownership-transfer-resolved"]);
    const blocked = new Set();
    for (const id of effective) {
      const record = byId.get(id);
      if (ownerOnlyTypes.has(record?.recordType) && lineages.some((lineage, index) => lineage.owners.has(record.author?.participantId)
          && lineage.roots.some((root) => relation(record, root.id, byId))
          && !lineages.some((other, otherIndex) => otherIndex !== index
            && other.roots.some((root) => relation(record, root.id, byId))))) {
        blocked.add(id);
      }
    }
    for (let changed = true; changed;) {
      changed = false;
      for (const id of effective) {
        if (blocked.has(id)) continue;
        if (byId.get(id)?.membershipHeads.some((head) => blocked.has(head))) {
          blocked.add(id);
          changed = true;
        }
      }
    }
    for (const id of blocked) {
      effective.delete(id);
      acceptedBase.delete(id);
      valid.set(id, "owner-authority-conflict-pending");
    }
  }

  // A provisional enrollment may unlock descendants before a competing branch is delivered.
  // Revoke that provisional authority from every descendant once the complete conflict set is known.
  let pruned = true;
  while (pruned) {
    pruned = false;
    for (const id of [...effective]) {
      if (id === genesisId) continue;
      const record = byId.get(id);
      const disputeReferenceAllowed = (head) => ["membership-conflict-resolved", "owner-device-enrollment-consented"].includes(record?.recordType)
        && (approvals.has(head) || resolutions.has(head) || [...inviteRevocations.values()].some((items) => items.some((item) => item.id === head)));
      if (deviceIdConflicts.has(record?.author?.deviceId)
          || record?.membershipHeads?.some((head) => !effective.has(head) && !disputeReferenceAllowed(head))) {
        effective.delete(id);
        acceptedBase.delete(id);
        valid.set(id, "membership-ancestor-conflicted");
        pruned = true;
      }
    }
  }

  for (const [id, record] of [...compatibilityCandidates].sort(([a], [b]) => a.localeCompare(b))) {
    if (collisions.has(id)) continue;
    const envelopeError = compatibilityEnvelopeError(record);
    if (envelopeError) {
      diagnostics.push(diag("quarantined", envelopeError, record));
      continue;
    }
    if (record.groupId !== groupId) {
      diagnostics.push(diag("quarantined", "cross-group-record", record));
      continue;
    }
    let closure;
    try { closure = closureFromHeads(record.membershipHeads, byId, groupId, genesisId); }
    catch (error) {
      const status = error.message === "missing-membership-head" ? "pending" : "quarantined";
      diagnostics.push(diag(status, error.message, record));
      continue;
    }
    if (record.membershipHeads.some((head) => !effective.has(head))) {
      diagnostics.push(diag("pending", "membership-head-not-effective", record));
      continue;
    }
    const state = await baseAt(record.membershipHeads);
    if (state.error) {
      const status = state.error === "invalid-membership-ancestor" ? "pending" : "quarantined";
      diagnostics.push(diag(status, state.error, record));
      continue;
    }
    const signer = matchingEnrollment(record.author, closure);
    if (!signer) {
      diagnostics.push(diag("pending", "unknown-device-at-membership-heads", record));
      continue;
    }
    const publicKeyBytes = unb64(signer.key);
    let signatureValid = false;
    try {
      if (publicKeyBytes) {
        const publicKey = await crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
        signatureValid = await verifyRecord(record, publicKey);
      }
    } catch { /* malformed or unsupported signatures remain quarantined */ }
    if (!signatureValid) {
      diagnostics.push(diag("quarantined", "invalid-membership-signature", record));
      continue;
    }
    readOnly = true;
    const unsupportedReason = record.membershipSchemaVersion !== 1 || record.protocolVersion !== 2
      ? "unsupported-membership-version" : "unsupported-membership-record";
    diagnostics.push(diag("unsupported", unsupportedReason, record));
  }

  // Final per-record diagnostics and projection values come from the verified ancestry closure.
  const allEffectiveHeads = [...effective].filter((id) => ![...effective].some((other) => other !== id && relation(byId.get(other), id, byId))).sort();
  const requestedHeads = atHeads || allEffectiveHeads;
  let finalState = await baseAt(requestedHeads);
  const isConflictHead = (id) => approvals.has(id) || resolutions.has(id)
    || [...inviteRevocations.values()].some((items) => items.some((item) => item.id === id));
  const invalidExplicitHead = atHeads?.some((id) => !effective.has(id) && !(allowConflictHeads && isConflictHead(id)));
  if (finalState.error || invalidExplicitHead) {
    return empty(rawRecords, diagnostics.concat({ status: "quarantined", reason: finalState.error || "membership-head-not-effective" }), true);
  }
  const inviteList = [...inviteIssues.values()].filter((record) => effective.has(record.id) && !authorRemovedBefore(record, finalState.closure)).sort((a, b) => a.payload.inviteId.localeCompare(b.payload.inviteId));
  const ownershipTransfers = [...transferProposals.values()].filter((proposal) => finalState.closure.has(proposal.id) && !authorRemovedBefore(proposal, finalState.closure)).map((proposal) => {
    const acceptance = [...transferAcceptances.values()].find((item) => item.payload.proposalId === proposal.id && effective.has(item.id) && finalState.closure.has(item.id));
    return { transferId: proposal.payload.transferId, proposalId: proposal.id, ownerParticipantId: proposal.payload.ownerParticipantId,
      recipientParticipantId: proposal.payload.recipientParticipantId, recipientDeviceId: proposal.payload.recipientDeviceId,
      recipientKeyId: proposal.payload.recipientKeyId, acceptanceId: acceptance?.id || null };
  }).sort((a, b) => a.transferId.localeCompare(b.transferId));
  const acceptedTransfersAtHeads = acceptedTransfersAt(finalState.closure).map(({ record }) => record);
  const maximalTransfersAtHeads = acceptedTransfersAtHeads.filter((candidate) => !acceptedTransfersAtHeads.some((other) => other.id !== candidate.id && relation(other, candidate.id, byId)));
  const transferConflictRecordIds = new Set(maximalTransfersAtHeads.map((item) => item.id));
  const maximalRecipients = new Set(maximalTransfersAtHeads.map((item) => transferProposals.get(item.payload.proposalId)?.payload.recipientParticipantId));
  const transferConflict = maximalRecipients.size > 1 ? [...transferConflictRecordIds].sort() : [];
  if (transferConflict.length) diagnostics.push({ status: "conflicting", reason: "conflicting-ownership-transfers", recordIds: transferConflict });
  if (transferConflict.length) {
    const relevant = [...transferResolutions.values()].filter((item) => finalState.closure.has(item.id)
      && canonical(item.payload.conflictRecordIds) === canonical(transferConflict));
    const maximal = relevant.filter((candidate) => !relevant.some((other) => candidate.id !== other.id && relation(other, candidate.id, byId)));
    if (new Set(maximal.map((item) => item.payload.selectedRecordId)).size > 1) {
      diagnostics.push({ status: "conflicting", reason: "conflicting-ownership-transfer-resolutions", recordIds: maximal.map((item) => item.id).sort() });
    }
  }
  const deviceMap = new Map();
  const devices = [];
  const ownerDevice = { participantId: genesis.author.participantId, deviceId: genesis.author.deviceId, keyId: genesis.author.keyId,
    publicKey: genesis.payload.owner.publicKey, publicKeyFingerprint: trustPin.publicKeyFingerprint, requestId: null, approvalId: null, genesisId };
  if (!deviceRemoved(ownerDevice.deviceId, ownerDevice.participantId, finalState.closure)) {
    deviceMap.set(ownerDevice.deviceId, ownerDevice); devices.push(ownerDevice);
  }
  for (const [approvalId, approval] of approvals) {
    if (!effective.has(approvalId) || !finalState.closure.has(approvalId)) continue;
    const req = requests.get(approval.payload.requestId);
    const device = { participantId: approval.payload.participantId, deviceId: approval.payload.deviceId, keyId: approval.payload.keyId,
      publicKey: req.payload.publicKey, publicKeyFingerprint: req.payload.publicKeyFingerprint, requestId: req.id, approvalId };
    if (deviceRemoved(device.deviceId, device.participantId, finalState.closure)) continue;
    const prior = deviceMap.get(device.deviceId);
    if (!prior) { deviceMap.set(device.deviceId, device); devices.push(device); }
    else if (prior.participantId !== device.participantId || prior.keyId !== device.keyId || prior.publicKeyFingerprint !== device.publicKeyFingerprint) {
      deviceMap.delete(device.deviceId); devices.splice(devices.indexOf(prior), 1); diagnostics.push({ status: "conflicting", reason: "device-id-collision", deviceId: device.deviceId });
    }
  }
  for (const [id, error] of errors) {
    if (compatibilityCandidates.has(id)) continue;
    diagnostics.push(diag(error === "unsupported-membership-version" ? "unsupported" : "quarantined", error, byId.get(id)));
  }
  for (const [id, error] of baseErrors) {
    if (!compatibilityCandidates.has(id)) diagnostics.push(diag("quarantined", error, byId.get(id)));
  }
  for (const record of transitions) {
    if (errors.has(record.id) || valid.has(record.id)) continue;
    diagnostics.push(diag("pending", pendingReasons.get(record.id) || "membership-conflict-or-dependency-pending", record));
  }
  for (const [id, state] of valid) {
    const record = byId.get(id);
    if (state === "request-proof") diagnostics.push(diag("pending", "join-request-pending", record));
    else if (record?.recordType === "device-enrollment-approved" && finalState.closure.has(id) && enrollmentRemovedBefore(record, finalState.closure)) {
      diagnostics.push(diag("conflicting", "identity-already-removed", record));
    }
    else if (state !== "effective" && state !== "request-proof" && !effective.has(id)) diagnostics.push(diag("conflicting", state, record));
    else if (state === "effective") diagnostics.push(diag("effective", "membership-transition", record));
  }
  return {
    ...finalState.projection,
    invites: inviteList.filter((item) => finalState.closure.has(item.id)).map((item) => ({ inviteId: item.payload.inviteId, participantId: item.payload.participantId, recordId: item.id,
      revoked: (inviteRevocations.get(item.payload.inviteId) || []).some((revocation) => effective.has(revocation.id)) })),
    ownershipTransfers,
    transferConflictRecordIds: transferConflict,
    tombstones: {
      keyEpoch: finalState.projection.keyEpoch,
      devices: [...deviceRevocations.values()].filter((record) => effective.has(record.id) && finalState.closure.has(record.id))
        .map((record) => ({ participantId: record.payload.participantId, deviceId: record.payload.deviceId, keyId: record.payload.keyId,
          recordId: record.id, causalHeads: [...record.causalHeads], keyEpoch: record.payload.keyEpoch }))
        .sort((a, b) => a.recordId.localeCompare(b.recordId)),
      participants: [...participantRemovals.values()].filter((record) => effective.has(record.id) && finalState.closure.has(record.id))
        .map((record) => ({ participantId: record.payload.participantId, recordId: record.id,
          causalHeads: [...record.causalHeads], keyEpoch: record.payload.keyEpoch }))
        .sort((a, b) => a.recordId.localeCompare(b.recordId))
    },
    requests: [...requests.values()].filter((item) => item.membershipHeads.some((head) => finalState.closure.has(head))).map((item) => ({ requestId: item.id, inviteId: item.payload.inviteId, participantId: item.payload.participantId,
      deviceId: item.author.deviceId, keyId: item.author.keyId, publicKey: item.payload.publicKey, status: effective.has(item.id) ? "pending" : "pending" })).sort((a, b) => a.requestId.localeCompare(b.requestId)),
    devices: devices.sort((a, b) => a.deviceId.localeCompare(b.deviceId)),
    heads: allEffectiveHeads,
    diagnostics: stable(diagnostics.concat(finalState.projection.diagnostics)),
    rawRecords,
    readOnly
  };
}

export async function resolveMembershipAuthority({ identity, membershipHeads, records, trustPin, role, verifiedCausalContexts = [] }) {
  if (!identity || !Array.isArray(membershipHeads) || !Array.isArray(records) || !trustPin) return null;
  const projection = await projectSignedMembership(records, { trustPin, atHeads: membershipHeads, allowConflictHeads: role === "owner", verifiedCausalContexts });
  if (projection.groupId == null || projection.readOnly) return null;
  const participantId = identity.participantId;
  if (role === "owner" && participantId !== projection.ownerParticipantId) return null;
  if (role === "organizer" && !projection.organizers.includes(participantId)) return null;
  const device = projection.devices.find((item) => item.participantId === identity.participantId
    && item.deviceId === identity.deviceId && item.keyId === identity.keyId);
  const key = device?.publicKey;
  if (!key) return null;
  const actual = await exportFingerprint(identity.publicKey);
  if (actual !== await fingerprint(unb64(key))) return null;
  return { publicKey: key, role: participantId === projection.ownerParticipantId ? "owner" : "organizer", projection };
}

async function exportFingerprint(publicKey) {
  const raw = await crypto.subtle.exportKey("raw", publicKey);
  return fingerprint(new Uint8Array(raw));
}

function resolveInvites({ inviteIssues, inviteRevocations, approvals, resolutions, byId, genesis, consents, valid, deviceIdConflicts, ownerAt, structural }) {
  const enrollments = new Map(); const conflicts = new Map(); const resolvedResolutions = new Set(); const effectiveRevocations = new Set();
  const inviteIds = new Set([...inviteIssues.values()].map((item) => item.payload.inviteId));
  for (const inviteId of inviteIds) {
    const issue = [...inviteIssues.values()].find((item) => item.payload.inviteId === inviteId);
    const allInviteApprovals = [...approvals.values()].filter((item) => item.payload.inviteId === inviteId);
    for (const item of allInviteApprovals.filter((item) => deviceIdConflicts.has(item.payload.deviceId))) conflicts.set(item.id, "device-id-collision");
    const inviteApprovals = allInviteApprovals.filter((item) => !deviceIdConflicts.has(item.payload.deviceId));
    const revoked = inviteRevocations.get(inviteId) || [];
    const consumed = inviteApprovals.filter((item) => inviteApprovals.some((earlier) => item.id !== earlier.id && relation(item, earlier.id, byId)));
    for (const item of consumed) conflicts.set(item.id, "invite-already-consumed");
    const roots = inviteApprovals.filter((item) => !consumed.includes(item));
    const candidates = roots.filter((item) => !roots.some((other) => item.id !== other.id && relation(item, other.id, byId)));
    const conflictBranches = new Set();
    for (let i = 0; i < candidates.length; i += 1) for (let j = i + 1; j < candidates.length; j += 1) {
      const a = candidates[i]; const b = candidates[j];
      const equivalent = a.payload.requestId === b.payload.requestId && a.payload.participantId === b.payload.participantId
        && a.payload.deviceId === b.payload.deviceId && a.payload.keyId === b.payload.keyId && a.payload.publicKeyFingerprint === b.payload.publicKeyFingerprint;
      if (!equivalent && !relation(a, b.id, byId) && !relation(b, a.id, byId)) { conflictBranches.add(a.id); conflictBranches.add(b.id); }
    }
    for (const approval of candidates) for (const revocation of revoked) {
      if (!relation(approval, revocation.id, byId) && !relation(revocation, approval.id, byId)) { conflictBranches.add(approval.id); conflictBranches.add(revocation.id); }
    }
    if (conflictBranches.size) {
      const ids = [...conflictBranches].sort();
      const relevantResolutions = [...resolutions.values()].filter((item) => item.payload.inviteId === inviteId
        && ids.every((id) => item.payload.conflictRecordIds.includes(id))
        && ids.every((id) => relation(item, id, byId)));
      const maximal = relevantResolutions.filter((a) => !relevantResolutions.some((b) => a.id !== b.id && relation(b, a.id, byId)));
      const selections = new Set(maximal.map((item) => item.payload.selectedRecordId));
      if (maximal.length && selections.size === 1) {
        for (const item of maximal) resolvedResolutions.add(item.id);
        const chosenId = maximal[0].payload.selectedRecordId;
        const chosenApproval = candidates.find((item) => item.id === chosenId);
        const chosenRevoke = revoked.find((item) => item.id === chosenId);
        if (chosenRevoke) effectiveRevocations.add(chosenRevoke.id);
      if (chosenApproval) {
          if (chosenApproval.payload.participantId === ownerAt(structural.get(chosenApproval.id))) {
            const currentOwner = ownerAt(structural.get(chosenApproval.id));
            const ownerSigned = chosenApproval.author.participantId === currentOwner;
            const consent = [...consents.values()].some((item) => item.payload.approvalId === chosenId && relation(item, chosenId, byId)
              && item.author.participantId === currentOwner);
            if (!ownerSigned && !consent) conflicts.set(chosenId, "owner-device-consent-required");
            else enrollments.set(chosenId, chosenApproval);
          } else enrollments.set(chosenId, chosenApproval);
        }
        if (chosenRevoke) for (const approval of candidates) conflicts.set(approval.id, "invite-revocation-selected");
      } else {
        for (const id of conflictBranches) conflicts.set(id, "conflicting-join-approvals");
      }
    } else {
      if (revoked.length) for (const item of revoked) effectiveRevocations.add(item.id);
      for (const approval of candidates) {
        if (revoked.some((item) => relation(approval, item.id, byId))) continue;
        const currentOwner = ownerAt(structural.get(approval.id));
        if (approval.payload.participantId === currentOwner) {
          const ownerSigned = approval.author.participantId === currentOwner;
          const consent = [...consents.values()].some((item) => item.payload.approvalId === approval.id && relation(item, approval.id, byId)
            && item.author.participantId === currentOwner);
          if (!ownerSigned && !consent) { conflicts.set(approval.id, "owner-device-consent-required"); continue; }
        }
        enrollments.set(approval.id, approval);
      }
    }
  }
  return { enrollments, conflicts, resolvedResolutions, effectiveRevocations };
}

function empty(rawRecords, diagnostics, readOnly) {
  return { groupId: null, participants: [], organizers: [], ownerParticipantId: null, invites: [], requests: [], devices: [], ownershipTransfers: [], transferConflictRecordIds: [], heads: [],
    tombstones: { keyEpoch: null, devices: [], participants: [] }, diagnostics: stable(diagnostics), rawRecords, readOnly };
}
