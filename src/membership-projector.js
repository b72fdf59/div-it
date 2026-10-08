import { canonicalJsonBytes, verifyRecord } from "./identity-crypto.js";
import { verifyGroupGenesis } from "./group-genesis.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const MAX_RECORD_BYTES = 8192;
const MAX_RECORDS = 256;
const MAX_HEADS = 64;
const RECORD_FIELDS = ["id", "recordType", "membershipSchemaVersion", "protocolVersion", "groupId", "author", "createdAt", "membershipHeads", "causalHeads", "dependsOn", "payload", "signature"];
const AUTHOR_FIELDS = ["participantId", "deviceId", "keyId"];
const TRANSITIONS = new Set(["participant-added", "participant-renamed", "organizer-granted", "organizer-revoked"]);

function isUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  return Object.getOwnPropertySymbols(value).length === 0
    && keys.length === fields.length
    && fields.every((field) => Object.hasOwn(value, field))
    && keys.every((key) => fields.includes(key)
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"));
}

function validName(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim() && [...value].length <= 128;
}

function validTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function validHeads(value, { allowEmpty = false } = {}) {
  return Array.isArray(value) && value.length <= MAX_HEADS && (allowEmpty || value.length > 0)
    && value.every((head, index) => isUuid(head) && (index === 0 || value[index - 1] < head));
}

function commonSchemaError(record) {
  if (!exactObject(record, RECORD_FIELDS)) return "invalid-membership-schema";
  if (typeof record.recordType !== "string" || record.recordType.length > 64) return "invalid-membership-schema";
  if (!isUuid(record.id) || !isUuid(record.groupId)) return "invalid-membership-id";
  if (!exactObject(record.author, AUTHOR_FIELDS) || !AUTHOR_FIELDS.every((field) => isUuid(record.author[field]))) {
    return "invalid-membership-author";
  }
  if (!validTimestamp(record.createdAt)) return "invalid-membership-timestamp";
  if (!validHeads(record.membershipHeads) || !Array.isArray(record.causalHeads) || record.causalHeads.length !== 0
      || !Array.isArray(record.dependsOn) || record.dependsOn.length !== 0) return "invalid-membership-frontier";
  if (typeof record.signature !== "string" || !SIGNATURE.test(record.signature)) return "invalid-membership-signature";
  try {
    if (canonicalJsonBytes(record).byteLength > MAX_RECORD_BYTES) return "membership-record-too-large";
  } catch {
    return "invalid-membership-schema";
  }
  return null;
}

function schemaError(record) {
  const commonError = commonSchemaError(record);
  if (commonError) return commonError;
  if (record.membershipSchemaVersion !== 1 || record.protocolVersion !== 2) return "unsupported-membership-version";
  if (!TRANSITIONS.has(record.recordType)) return "unsupported-membership-record";
  if (!Array.isArray(record.payload) && (!record.payload || typeof record.payload !== "object")) {
    return "invalid-membership-payload";
  }
  if (record.recordType === "participant-added" || record.recordType === "participant-renamed") {
    if (!exactObject(record.payload, ["participantId", "name"]) || !isUuid(record.payload.participantId)
        || !validName(record.payload.name)) return "invalid-membership-payload";
  } else if (!exactObject(record.payload, ["participantId"]) || !isUuid(record.payload.participantId)) {
    return "invalid-membership-payload";
  }
  return null;
}

function canonicalKey(record) {
  try {
    return new TextDecoder().decode(canonicalJsonBytes(record));
  } catch {
    try { return JSON.stringify(record) ?? "<unserializable>"; } catch { return "<unserializable>"; }
  }
}

function ancestorsOf(id, byId, memo = new Map()) {
  if (memo.has(id)) return memo.get(id);
  const result = new Set([id]);
  memo.set(id, result);
  const record = byId.get(id);
  if (record) {
    for (const parent of record.membershipHeads) {
      for (const ancestor of ancestorsOf(parent, byId, memo)) result.add(ancestor);
    }
  }
  return result;
}

function commonFrontier(heads, byId, memo) {
  if (heads.length === 1) return heads;
  let common = null;
  for (const head of heads) {
    const ancestors = ancestorsOf(head, byId, memo);
    common = common === null ? new Set(ancestors) : new Set([...common].filter((id) => ancestors.has(id)));
  }
  if (!common?.size) return [];
  return [...common].filter((candidate) => ![...common].some((other) => other !== candidate
    && ancestorsOf(other, byId, memo).has(candidate))).sort();
}

function collectCycleIds(recordsById) {
  const visiting = new Set();
  const visited = new Set();
  const cycles = new Set();
  const stack = [];
  function visit(id) {
    if (visiting.has(id)) {
      const index = stack.indexOf(id);
      for (const cycleId of stack.slice(index)) cycles.add(cycleId);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    const record = recordsById.get(id);
    for (const parent of record?.membershipHeads || []) if (recordsById.has(parent)) visit(parent);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of recordsById.keys()) visit(id);
  return cycles;
}

function transitionValue(record) {
  if (record.recordType === "participant-added" || record.recordType === "participant-renamed") return record.payload.name;
  return record.recordType === "organizer-granted";
}

function isDescendant(candidateId, ancestorId, byId, memo) {
  return ancestorsOf(candidateId, byId, memo).has(ancestorId);
}

function resolvedField({ participantId, field, context, accepted, byId, memo, initial }) {
  const candidates = accepted.filter((record) => context.has(record.id)
    && ((field === "name" && (record.recordType === "participant-added" || record.recordType === "participant-renamed")
      && record.payload.participantId === participantId)
      || (field === "role" && (record.recordType === "organizer-granted" || record.recordType === "organizer-revoked")
        && record.payload.participantId === participantId)));
  const maximal = candidates.filter((candidate) => !candidates.some((other) => other.id !== candidate.id
    && isDescendant(other.id, candidate.id, byId, memo)));
  if (!maximal.length) return { value: initial, conflict: null };
  const values = [...new Set(maximal.map(transitionValue))];
  if (values.length === 1) return { value: values[0], conflict: null };
  const common = commonFrontier(maximal.map((record) => record.id), byId, memo);
  const commonContext = new Set(common.flatMap((head) => [...ancestorsOf(head, byId, memo)]));
  const baseline = resolvedField({ participantId, field, context: commonContext, accepted, byId, memo, initial });
  return {
    value: baseline.value,
    conflict: {
      type: field === "name" ? "participant-name-conflict" : "organizer-role-conflict",
      participantId,
      recordIds: maximal.map((record) => record.id).sort()
    }
  };
}

function stateAt(heads, genesis, accepted, byId, memo) {
  const context = new Set(heads.flatMap((head) => [...ancestorsOf(head, byId, memo)]));
  const participantIds = new Set([genesis.author.participantId]);
  for (const record of accepted) {
    if (record.recordType === "participant-added" && context.has(record.id)) participantIds.add(record.payload.participantId);
  }
  const participants = new Map();
  const organizers = new Set();
  const conflicts = [];
  for (const participantId of [...participantIds].sort()) {
    const initialName = participantId === genesis.author.participantId ? genesis.payload.owner.name : undefined;
    const name = resolvedField({ participantId, field: "name", context, accepted, byId, memo, initial: initialName });
    if (name.conflict) conflicts.push(name.conflict);
    if (name.value === undefined && !name.conflict) continue;
    participants.set(participantId, { name: name.value ?? null });
    const initialRole = participantId === genesis.author.participantId;
    const role = resolvedField({ participantId, field: "role", context, accepted, byId, memo, initial: initialRole });
    if (role.value) organizers.add(participantId);
    if (role.conflict) conflicts.push(role.conflict);
  }
  return { participants, organizers, conflicts };
}

function fail(reason, recordId) {
  return { status: "quarantined", reason, recordId };
}

export async function projectMembershipRecords(input, { trustPin } = {}) {
  const rawRecords = Array.isArray(input) ? input : [];
  if (!Array.isArray(input)) return { groupId: null, participants: [], organizers: [], ownerParticipantId: null, heads: [], diagnostics: [{ status: "quarantined", reason: "invalid-membership-input" }], rawRecords, readOnly: true };

  const variants = new Map();
  const diagnostics = [];
  const duplicateCounts = new Map();
  let uniqueVariantCount = 0;
  for (let index = 0; index < rawRecords.length; index += 1) {
    const record = rawRecords[index];
    let id;
    try { id = record && typeof record === "object" ? record.id : undefined; } catch { id = undefined; }
    if (!isUuid(id)) {
      diagnostics.push({ status: "quarantined", reason: "invalid-membership-id", rawRecord: record });
      continue;
    }
    const list = variants.get(id) || [];
    const key = canonicalKey(record);
    if (list.some((variant) => variant.key === key)) {
      duplicateCounts.set(id, (duplicateCounts.get(id) || 0) + 1);
    } else {
      uniqueVariantCount += 1;
      if (uniqueVariantCount > MAX_RECORDS) {
        diagnostics.push({ status: "quarantined", reason: "membership-record-limit" });
        return emptyResult(rawRecords, diagnostics, true);
      }
      list.push({ record, key });
      variants.set(id, list);
    }
  }
  for (const [recordId, count] of duplicateCounts) {
    diagnostics.push({ recordId, status: "duplicate", reason: "duplicate-membership-record", duplicateCount: count });
  }
  const collisions = new Set([...variants].filter(([, list]) => list.length > 1).map(([id]) => id));
  for (const id of collisions) {
    for (const { record } of variants.get(id).sort((a, b) => a.key.localeCompare(b.key))) {
      diagnostics.push({ recordId: id, status: "quarantined", reason: "id-content-collision", rawRecord: record });
    }
  }
  const byId = new Map([...variants].filter(([id]) => !collisions.has(id)).map(([id, list]) => [id, list[0].record]));
  let validPin = false;
  try {
    validPin = exactObject(trustPin, ["genesisId", "publicKeyFingerprint"])
      && isUuid(trustPin.genesisId)
      && typeof trustPin.publicKeyFingerprint === "string"
      && /^sha256:[A-Za-z0-9_-]{43}$/.test(trustPin.publicKeyFingerprint);
  } catch {
    validPin = false;
  }
  if (!validPin) {
    diagnostics.push({ status: "quarantined", reason: "invalid-genesis-trust-pin" });
    return emptyResult(rawRecords, diagnostics, true);
  }
  const pinId = trustPin.genesisId;
  const genesis = pinId ? byId.get(pinId) : null;
  if (!genesis) {
    diagnostics.push({ recordId: pinId, status: "pending", reason: "trusted-genesis-missing" });
    return emptyResult(rawRecords, diagnostics, true);
  }
  const verifiedGenesis = await verifyGroupGenesis(genesis, trustPin);
  if (!verifiedGenesis.ok) {
    diagnostics.push({ recordId: pinId, status: "quarantined", reason: verifiedGenesis.reason, rawRecord: genesis });
    return emptyResult(rawRecords, diagnostics, true);
  }
  const groupId = genesis.groupId;
  const publicBytes = decodePublicKey(genesis.payload.owner.publicKey);
  let publicKey;
  try {
    publicKey = await globalThis.crypto.subtle.importKey("raw", publicBytes, { name: "Ed25519" }, false, ["verify"]);
  } catch (cause) {
    throw new Error("membership-crypto-unavailable", { cause });
  }
  const initial = {
    id: genesis.id,
    recordType: "group-created",
    membershipHeads: [],
    groupId,
    author: genesis.author,
    payload: genesis.payload
  };
  const stateById = new Map([[genesis.id, true]]);
  diagnostics.push({ recordId: genesis.id, status: "effective", reason: "trusted-genesis", rawRecord: genesis });

  const eligible = new Map();
  for (const [id, record] of byId) {
    if (id === genesis.id || collisions.has(id)) continue;
    if (record.groupId !== groupId) {
      eligible.set(id, fail("cross-group-record", id));
      continue;
    }
    if (record.recordType === "group-created") {
      eligible.set(id, fail("untrusted-genesis", id));
      continue;
    }
    let reason;
    try { reason = commonSchemaError(record); } catch { reason = "invalid-membership-schema"; }
    if (reason) {
      eligible.set(id, fail(reason, id));
      continue;
    }
    if (record.author.participantId !== genesis.author.participantId
        || record.author.deviceId !== genesis.author.deviceId || record.author.keyId !== genesis.author.keyId) {
      eligible.set(id, fail("unknown-signer", id));
      continue;
    }
    if (!(await verifyRecord(record, publicKey))) {
      eligible.set(id, fail("invalid-membership-signature", id));
      continue;
    }
    let specificError;
    try { specificError = schemaError(record); } catch { specificError = "invalid-membership-schema"; }
    if (specificError === "unsupported-membership-version" || specificError === "unsupported-membership-record") {
      eligible.set(id, { status: "unsupported", reason: specificError, recordId: id });
      continue;
    }
    if (specificError) {
      eligible.set(id, fail(specificError, id));
      continue;
    }
    eligible.set(id, { status: "waiting", recordId: id });
  }

  const cycleCandidates = new Map([...byId].filter(([id]) => {
    const status = eligible.get(id)?.status;
    return id !== genesis.id && (status === "waiting" || status === "unsupported");
  }));
  const cycleIds = collectCycleIds(cycleCandidates);
  for (const id of cycleIds) eligible.set(id, fail("membership-cycle", id));
  const accepted = [];
  const memo = new Map();
  let readOnly = false;
  for (let pass = 0; pass < MAX_RECORDS; pass += 1) {
    let progress = false;
    for (const [id, record] of [...byId].sort(([left], [right]) => left.localeCompare(right))) {
      if (id === genesis.id || eligible.get(id)?.status !== "waiting") continue;
      const collidingParents = record.membershipHeads.filter((head) => collisions.has(head));
      if (collidingParents.length) {
        eligible.set(id, fail("membership-parent-id-collision", id));
        progress = true;
        continue;
      }
      const missing = record.membershipHeads.filter((head) => !byId.has(head));
      if (missing.length) {
        eligible.set(id, { status: "pending", reason: "missing-membership-head", recordId: id, missing: missing.sort() });
        continue;
      }
      const crossGroupParents = record.membershipHeads.filter((head) => byId.get(head)?.groupId !== groupId);
      if (crossGroupParents.length) {
        eligible.set(id, fail("cross-group-reference", id));
        progress = true;
        continue;
      }
      const parentStatuses = record.membershipHeads.map((head) => eligible.get(head)?.status).filter(Boolean);
      if (parentStatuses.some((status) => status === "waiting" || status === "pending")) continue;
      const badParents = record.membershipHeads.filter((head) => eligible.has(head) && eligible.get(head).status !== "effective");
      if (badParents.length) {
        eligible.set(id, fail("invalid-membership-parent", id));
        progress = true;
        continue;
      }
      if (record.membershipHeads.includes(id)
          || record.membershipHeads.some((head, index) => record.membershipHeads.slice(index + 1)
            .some((other) => ancestorsOf(head, byId, memo).has(other) || ancestorsOf(other, byId, memo).has(head)))) {
        eligible.set(id, fail("invalid-membership-frontier", id));
        progress = true;
        continue;
      }
      if (record.membershipHeads.some((head) => !ancestorsOf(head, byId, memo).has(genesis.id))) {
        eligible.set(id, fail("unrooted-membership-history", id));
        progress = true;
        continue;
      }
      const state = stateAt(record.membershipHeads, initial, accepted, byId, memo);
      const actorId = record.author.participantId;
      const ownerId = genesis.author.participantId;
      if ((record.recordType === "organizer-granted" || record.recordType === "organizer-revoked") && actorId !== ownerId) {
        eligible.set(id, fail("not-owner", id));
        progress = true;
        continue;
      }
      if ((record.recordType === "participant-added" || record.recordType === "participant-renamed")
          && !state.organizers.has(actorId)) {
        eligible.set(id, fail("not-organizer", id));
        progress = true;
        continue;
      }
      const targetId = record.payload.participantId;
      if (record.recordType === "participant-renamed" && !state.participants.has(targetId)) {
        eligible.set(id, fail("participant-not-found", id));
        progress = true;
        continue;
      }
      if (record.recordType === "participant-added" && state.participants.has(targetId)) {
        eligible.set(id, fail("participant-already-exists", id));
        progress = true;
        continue;
      }
      if ((record.recordType === "organizer-granted" || record.recordType === "organizer-revoked")
          && !state.participants.has(targetId)) {
        eligible.set(id, fail("participant-not-found", id));
        progress = true;
        continue;
      }
      if (record.recordType === "organizer-revoked" && targetId === ownerId) {
        eligible.set(id, fail("owner-role-immutable", id));
        progress = true;
        continue;
      }
      accepted.push(record);
      stateById.set(id, true);
      eligible.set(id, { status: "effective", recordId: id });
      progress = true;
    }
    if (!progress) break;
  }
  for (const [id, status] of eligible) {
    if (status.status === "waiting") eligible.set(id, { status: "pending", reason: "missing-membership-head", recordId: id });
    if (status.status === "unsupported") readOnly = true;
  }
  const effectiveIds = [...stateById.keys()];
  const heads = effectiveIds.filter((id) => !effectiveIds.some((other) => other !== id && ancestorsOf(other, byId, memo).has(id))).sort();
  const finalState = stateAt(heads, initial, accepted, byId, memo);
  for (const [id, status] of eligible) diagnostics.push({ ...status, rawRecord: byId.get(id) });
  diagnostics.push(...finalState.conflicts.map((conflict) => ({ status: "conflicting", reason: conflict.type, participantId: conflict.participantId, recordIds: conflict.recordIds })));
  return {
    groupId,
    groupName: genesis.payload.name,
    currency: genesis.payload.currency,
    ownerParticipantId: genesis.author.participantId,
    participants: [...finalState.participants].map(([id, participant]) => ({ id, name: participant.name })).sort((a, b) => a.id.localeCompare(b.id)),
    organizers: [...finalState.organizers].sort(),
    heads,
    diagnostics: stableDiagnostics(diagnostics),
    rawRecords,
    readOnly
  };
}

function emptyResult(rawRecords, diagnostics, readOnly) {
  return { groupId: null, groupName: null, currency: null, ownerParticipantId: null, participants: [], organizers: [], heads: [], diagnostics: stableDiagnostics(diagnostics), rawRecords, readOnly };
}

function stableDiagnostics(diagnostics) {
  return diagnostics.sort((a, b) => `${a.recordId || ""}:${a.status}:${a.reason || ""}:${a.participantId || ""}:${(a.recordIds || []).join(",")}`
    .localeCompare(`${b.recordId || ""}:${b.status}:${b.reason || ""}:${b.participantId || ""}:${(b.recordIds || []).join(",")}`)
      || canonicalKey(a.rawRecord).localeCompare(canonicalKey(b.rawRecord)));
}

function decodePublicKey(value) {
  const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
