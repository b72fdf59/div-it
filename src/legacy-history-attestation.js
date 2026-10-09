import { canonicalJsonBytes, signRecord, verifyRecord } from "./identity-crypto.js";
import { prepareLegacyActivationReview } from "./legacy-activation-review.js";
import { projectSignedMembership, resolveMembershipAuthority } from "./signed-membership-projector.js";

const RECORD_TYPE = "legacy-history-adopted";
const ARCHIVE_FORMAT = "div-it-legacy-raw-v1";
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 8192;
const MAX_HEADS = 64;
const MAX_PARTICIPANTS = 256;
const MAX_EVENTS = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{86}$/;
const CURRENCIES = new Set(["USD", "INR", "EUR", "GBP"]);
const RECORD_FIELDS = ["id", "recordType", "membershipSchemaVersion", "protocolVersion", "groupId", "author", "createdAt", "membershipHeads", "causalHeads", "dependsOn", "payload", "signature"];
const AUTHOR_FIELDS = ["participantId", "deviceId", "keyId"];
const PAYLOAD_FIELDS = ["sourceGroupId", "sourceCanonicalContentDigest", "archiveFormat", "participants", "currency", "openingBalances", "legacyEventCount", "legacyAuthorship"];
const DIGEST_FIELDS = ["algorithm", "encoding", "value"];

function exact(value, fields) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => fields.includes(field));
}

function isUuid(value) { return typeof value === "string" && UUID.test(value); }
function boundedText(value, max = 128) {
  return typeof value === "string" && !!value.trim() && [...value].length <= max;
}
function isTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}
function validHeads(value, { required = true } = {}) {
  return Array.isArray(value) && value.length <= MAX_HEADS && (!required || value.length > 0)
    && value.every((id, index) => isUuid(id) && (!index || value[index - 1] < id));
}
function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function validSignature(value) {
  if (typeof value !== "string" || !SIGNATURE.test(value)) return false;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "==");
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return bytes.length === 64 && encodeBase64Url(bytes) === value;
  } catch { return false; }
}
function bytes(value) {
  return value instanceof Uint8Array ? Uint8Array.from(value)
    : value instanceof ArrayBuffer ? new Uint8Array(value.slice(0)) : null;
}
function sameCanonical(left, right) {
  return new TextDecoder().decode(canonicalJsonBytes(left)) === new TextDecoder().decode(canonicalJsonBytes(right));
}

function recordError(record) {
  try {
    if (!exact(record, RECORD_FIELDS)) return "invalid-attestation-envelope";
    if (record.recordType !== RECORD_TYPE || record.membershipSchemaVersion !== 1 || record.protocolVersion !== 2) return "unsupported-attestation-envelope";
    if (!isUuid(record.id) || !isUuid(record.groupId) || !exact(record.author, AUTHOR_FIELDS)
        || !AUTHOR_FIELDS.every((field) => isUuid(record.author[field]))) return "invalid-attestation-envelope";
    if (!isTimestamp(record.createdAt) || !validHeads(record.membershipHeads)
        || !validHeads(record.causalHeads, { required: false }) || record.causalHeads.length !== 0
        || !Array.isArray(record.dependsOn) || record.dependsOn.length !== 0 || !validSignature(record.signature)) {
      return "invalid-attestation-envelope";
    }
    if (canonicalJsonBytes(record).byteLength > MAX_RECORD_BYTES) return "attestation-too-large";
    return null;
  } catch { return "invalid-attestation-envelope"; }
}

function payloadError(payload) {
  if (!exact(payload, PAYLOAD_FIELDS)) return "invalid-attestation-payload";
  if (!(payload.sourceGroupId === null || isUuid(payload.sourceGroupId))
      || !exact(payload.sourceCanonicalContentDigest, DIGEST_FIELDS)
      || payload.sourceCanonicalContentDigest.algorithm !== "SHA-256"
      || payload.sourceCanonicalContentDigest.encoding !== "base64url-no-padding"
      || typeof payload.sourceCanonicalContentDigest.value !== "string"
      || !/^[A-Za-z0-9_-]{43}$/.test(payload.sourceCanonicalContentDigest.value)
      || payload.archiveFormat !== ARCHIVE_FORMAT || !CURRENCIES.has(payload.currency)
      || payload.legacyAuthorship !== "unverified"
      || !Number.isSafeInteger(payload.legacyEventCount) || payload.legacyEventCount < 0 || payload.legacyEventCount > MAX_EVENTS
      || !Array.isArray(payload.participants) || payload.participants.length > MAX_PARTICIPANTS
      || !Array.isArray(payload.openingBalances) || payload.openingBalances.length !== payload.participants.length) {
    return "invalid-attestation-payload";
  }
  const participantIds = new Set();
  for (const participant of payload.participants) {
    if (!exact(participant, ["participantId", "name"]) || !boundedText(participant.participantId)
        || !boundedText(participant.name) || participantIds.has(participant.participantId)) return "invalid-attestation-payload";
    participantIds.add(participant.participantId);
  }
  let total = 0;
  for (let index = 0; index < payload.openingBalances.length; index += 1) {
    const balance = payload.openingBalances[index];
    if (!exact(balance, ["participantId", "amount"]) || !participantIds.has(balance.participantId)
        || !Number.isSafeInteger(balance.amount) || (index > 0 && payload.openingBalances[index - 1].participantId >= balance.participantId)) {
      return "invalid-attestation-payload";
    }
    total += balance.amount;
    if (!Number.isSafeInteger(total)) return "invalid-attestation-payload";
  }
  return total === 0 ? null : "invalid-attestation-payload";
}

function archiveContents(archive) {
  const archiveFields = archive?.kind === "original-bytes"
    ? ["kind", "mediaType", "bytes"]
    : archive?.kind === "canonical-object" ? ["kind", "mediaType", "canonicalization", "bytes"] : [];
  if (!archiveFields.length || !exact(archive, archiveFields) || archive.mediaType !== "application/json") {
    throw new Error("invalid-legacy-archive");
  }
  if (archive.kind === "canonical-object" && archive.canonicalization !== "RFC 8785") throw new Error("invalid-legacy-archive");
  const data = bytes(archive.bytes);
  if (!data || data.byteLength > MAX_ARCHIVE_BYTES) throw new Error("legacy-archive-too-large-or-invalid");
  let source;
  try { source = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data)); }
  catch { throw new Error("invalid-legacy-archive-json"); }
  if (archive.kind === "canonical-object" && !sameCanonicalBytes(data, canonicalJsonBytes(source))) {
    throw new Error("noncanonical-legacy-archive");
  }
  return { source, bytes: data };
}

function sameCanonicalBytes(left, right) {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.length; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

async function reviewArchive(archive) {
  const { source, bytes: archiveBytes } = archiveContents(archive);
  const snapshot = copyArchive(archive, archiveBytes);
  const review = await prepareLegacyActivationReview(source, archive.kind === "original-bytes" ? { rawArchiveBytes: archiveBytes } : {});
  if (!review.activationReady || !review.digest) throw new Error("legacy-review-blocked");
  if (review.legacyEventCount > MAX_EVENTS || review.participants.length > MAX_PARTICIPANTS) throw new Error("legacy-archive-too-large-or-invalid");
  return { source, archiveBytes, archive: snapshot, review };
}

function payloadFromReview(review) {
  return {
    sourceGroupId: review.sourceGroupId,
    sourceCanonicalContentDigest: { ...review.digest },
    archiveFormat: review.archiveFormat,
    participants: review.participants.map(({ participantId, name }) => ({ participantId, name })),
    currency: review.currency,
    openingBalances: review.openingBalances.map(({ participantId, amount }) => ({ participantId, amount })),
    legacyEventCount: review.legacyEventCount,
    legacyAuthorship: "unverified"
  };
}

function validMembershipHeads(membershipHeads) {
  if (!validHeads(membershipHeads)) throw new TypeError("invalid-membership-heads");
}

function copyArchive(archive, data) {
  return archive.kind === "original-bytes"
    ? { kind: archive.kind, mediaType: archive.mediaType, bytes: Uint8Array.from(data) }
    : { kind: archive.kind, mediaType: archive.mediaType, canonicalization: archive.canonicalization, bytes: Uint8Array.from(data) };
}

/** Create a signed snapshot statement; it is not inserted into membership or ledger state. */
export async function createLegacyHistoryAttestation({ archive, membershipHeads, identity, membershipRecords, trustPin,
  verifiedCausalContexts = [] } = {}) {
  validMembershipHeads(membershipHeads);
  if (!Array.isArray(membershipRecords) || !Array.isArray(verifiedCausalContexts)) throw new TypeError("invalid-attestation-context");
  const archiveInput = copyArchiveInput(archive);
  const membershipSnapshot = structuredClone(membershipRecords);
  const identitySnapshot = identity ? { ...identity } : identity;
  const trustSnapshot = trustPin ? structuredClone(trustPin) : trustPin;
  const headsSnapshot = [...membershipHeads];
  const contextsSnapshot = [...verifiedCausalContexts];
  const { review, archive: archiveSnapshot } = await reviewArchive(archiveInput);
  if (!identitySnapshot || !AUTHOR_FIELDS.every((field) => isUuid(identitySnapshot[field]))) throw new Error("not-owner");
  let authority;
  try {
    authority = await resolveMembershipAuthority({ identity: identitySnapshot, membershipHeads: headsSnapshot, records: membershipSnapshot, trustPin: trustSnapshot,
      role: "owner", verifiedCausalContexts: contextsSnapshot });
  } catch { throw new Error("not-owner"); }
  if (!authority) throw new Error("not-owner");
  if (review.currency !== authority.projection.currency) throw new Error("currency-mismatch");
  const record = {
    id: crypto.randomUUID(),
    recordType: RECORD_TYPE,
    membershipSchemaVersion: 1,
    protocolVersion: 2,
    groupId: authority.projection.groupId,
    author: Object.fromEntries(AUTHOR_FIELDS.map((field) => [field, identitySnapshot[field]])),
    createdAt: new Date().toISOString(),
    membershipHeads: headsSnapshot,
    causalHeads: [],
    dependsOn: [],
    payload: payloadFromReview(review)
  };
  if (payloadError(record.payload)) throw new Error("invalid-attestation-payload");
  record.signature = await signRecord(record, identitySnapshot.privateKey);
  if (recordError(record) || !(await verifyRecord(record, identitySnapshot.publicKey))) throw new Error("attestation-signature-failed");
  if (canonicalJsonBytes(record).byteLength > MAX_RECORD_BYTES) throw new Error("attestation-too-large");
  return { record, archive: archiveSnapshot, review };
}

function copyArchiveInput(archive) {
  const archiveFields = archive?.kind === "original-bytes"
    ? ["kind", "mediaType", "bytes"]
    : archive?.kind === "canonical-object" ? ["kind", "mediaType", "canonicalization", "bytes"] : [];
  if (!archiveFields.length || !exact(archive, archiveFields) || archive.mediaType !== "application/json"
      || (archive.kind === "canonical-object" && archive.canonicalization !== "RFC 8785")) throw new Error("invalid-legacy-archive");
  const data = bytes(archive.bytes);
  if (!data || data.byteLength > MAX_ARCHIVE_BYTES) throw new Error("legacy-archive-too-large-or-invalid");
  return archive.kind === "original-bytes"
    ? { kind: archive.kind, mediaType: archive.mediaType, bytes: data }
    : { kind: archive.kind, mediaType: archive.mediaType, canonicalization: archive.canonicalization, bytes: data };
}

async function resolveRecordSigner(record, { membershipRecords, trustPin, verifiedCausalContexts, allowReadOnly = false }) {
  const atHeads = await projectSignedMembership(membershipRecords, { trustPin, atHeads: record.membershipHeads, verifiedCausalContexts });
  if (!atHeads.groupId || (!allowReadOnly && atHeads.readOnly)) throw new Error("untrusted-membership-heads");
  const device = atHeads.devices.find((item) => item.participantId === record.author.participantId
    && item.deviceId === record.author.deviceId && item.keyId === record.author.keyId);
  if (!device) throw new Error("unknown-or-removed-device");
  const binary = atob(device.publicKey.replace(/-/g, "+").replace(/_/g, "/") + "=");
  const publicKeyBytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const publicKey = await crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, true, ["verify"]);
  return { atHeads, publicKey, identity: { ...record.author, publicKey } };
}

/** Verify original signature and recompute every attested field from the supplied archive. */
export async function verifyLegacyHistoryAttestation({ record, archive, membershipRecords, trustPin,
  verifiedCausalContexts = [] } = {}) {
  let recordSnapshot;
  let archiveSnapshot;
  let membershipSnapshot;
  let trustSnapshot;
  let contextsSnapshot;
  try {
    recordSnapshot = structuredClone(record);
    archiveSnapshot = copyArchiveInput(archive);
    membershipSnapshot = structuredClone(membershipRecords);
    trustSnapshot = trustPin ? structuredClone(trustPin) : trustPin;
    contextsSnapshot = [...verifiedCausalContexts];
  } catch (error) { return { ok: false, reason: error?.message || "invalid-attestation-input" }; }
  const schemaFailure = recordError(recordSnapshot);
  if (schemaFailure) return { ok: false, reason: schemaFailure };
  if (!Array.isArray(membershipSnapshot) || !Array.isArray(contextsSnapshot) || !trustSnapshot) {
    return { ok: false, reason: "invalid-attestation-context" };
  }
  let signer;
  try { signer = await resolveRecordSigner(recordSnapshot, { membershipRecords: membershipSnapshot, trustPin: trustSnapshot,
    verifiedCausalContexts: contextsSnapshot, allowReadOnly: true }); }
  catch (error) { return { ok: false, reason: error?.message || "untrusted-membership-heads" }; }
  let signatureValid = false;
  try { signatureValid = await verifyRecord(recordSnapshot, signer.publicKey); } catch { /* fail closed */ }
  if (!signatureValid) return { ok: false, reason: "invalid-signature" };
  const authorityProjection = signer.atHeads;
  if (recordSnapshot.author.participantId !== authorityProjection.ownerParticipantId) return { ok: false, reason: "not-owner" };
  if (recordSnapshot.groupId !== authorityProjection.groupId) return { ok: false, reason: "group-mismatch" };
  if (payloadError(recordSnapshot.payload)) return { ok: false, reason: "invalid-attestation-payload" };
  if (recordSnapshot.payload.currency !== authorityProjection.currency) return { ok: false, reason: "currency-mismatch" };
  let recomputed;
  try { recomputed = await reviewArchive(archiveSnapshot); }
  catch (error) { return { ok: false, reason: error?.message || "invalid-legacy-archive" }; }
  const expectedPayload = payloadFromReview(recomputed.review);
  if (!sameCanonical(recordSnapshot.payload, expectedPayload)) return { ok: false, reason: "attestation-payload-mismatch" };
  return { ok: true, record: recordSnapshot, archive: recomputed.archive, review: recomputed.review };
}
