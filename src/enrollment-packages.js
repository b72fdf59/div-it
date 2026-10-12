import { canonicalJsonBytes, exportDevicePublicKey, verifyRecord } from "./identity-crypto.js";
import { verifyGroupGenesis } from "./group-genesis.js";
import { projectAuthenticatedLedger } from "./authenticated-ledger.js";
import { projectMembershipEnrollment } from "./membership-invitations.js";
import { verifyLegacyHistoryAttestation } from "./legacy-history-attestation.js";

const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;
const MAX_MEMBERSHIP_RECORDS = 256;
const MAX_LEDGER_RECORDS = 10_000;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_RECORD_BYTES = 65_536;
const MAX_PROOFS = 256;
const MAX_ARCHIVE_BYTES = 8 * 1024 * 1024;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^sha256:[A-Za-z0-9_-]{43}$/;
const INVITE_FORMAT = "div-it-invite-bootstrap-v1";
const REQUEST_FORMAT = "div-it-join-request-v1";
const PROOF_FORMAT = "div-it-enrollment-proof-v1";
const ENCODING = "base64url-no-padding";

function fail(reason) { return { ok: false, reason }; }
function exact(value, fields) {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.getOwnPropertySymbols(value).length === 0 && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field)) && Object.keys(value).every((field) => fields.includes(field));
}
function detach(value) { return JSON.parse(JSON.stringify(value)); }
function sortedJsonBytes(value) { return canonicalJsonBytes(value); }
function uniqueRecords(records) {
  const seen = new Set();
  return records.filter((record) => {
    const key = new TextDecoder().decode(sortedJsonBytes(record));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function same(left, right) {
  try {
    const a = sortedJsonBytes(left), b = sortedJsonBytes(right);
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
  } catch { return false; }
}
function encode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
function decode(value, maxBytes) {
  if (typeof value !== "string" || value.length > Math.ceil(maxBytes * 4 / 3)
      || !/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}|[A-Za-z0-9_-]{3})?$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + (value.length % 4 === 2 ? "==" : value.length % 4 === 3 ? "=" : ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.length <= maxBytes && encode(bytes) === value ? bytes : null;
  } catch { return null; }
}
function parseInput(input) {
  try {
    if (typeof input === "string") {
      if (new TextEncoder().encode(input).length > MAX_PACKAGE_BYTES) return { error: "package-too-large" };
      return { value: JSON.parse(input) };
    }
    const text = JSON.stringify(input);
    if (typeof text !== "string" || new TextEncoder().encode(text).length > MAX_PACKAGE_BYTES) return { error: "package-too-large" };
    return { value: JSON.parse(text) };
  } catch { return { error: "invalid-package-json" }; }
}
function wireProofs(evidence) {
  if (!Array.isArray(evidence) || evidence.length > MAX_PROOFS) throw new TypeError("invalid-proof-list");
  return evidence.map(({ record, archive }) => {
    const bytes = archive?.bytes;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_ARCHIVE_BYTES
        || !["original-bytes", "canonical-object"].includes(archive.kind) || archive.mediaType !== "application/json"
        || (archive.kind === "canonical-object" && archive.canonicalization !== "RFC 8785")) throw new TypeError("invalid-proof-archive");
    return { record: detach(record), archive: { kind: archive.kind, mediaType: archive.mediaType,
      ...(archive.kind === "canonical-object" ? { canonicalization: archive.canonicalization } : {}),
      bytes: { encoding: ENCODING, value: encode(bytes) } } };
  });
}
function readProofs(value) {
  if (!Array.isArray(value) || value.length > MAX_PROOFS) return null;
  const evidence = [];
  for (const item of value) {
    const archive = item?.archive;
    const archiveFields = archive?.kind === "canonical-object"
      ? ["kind", "mediaType", "canonicalization", "bytes"]
      : archive?.kind === "original-bytes" ? ["kind", "mediaType", "bytes"] : [];
    if (!exact(item, ["record", "archive"]) || !archiveFields.length || !exact(archive, archiveFields)
        || archive.mediaType !== "application/json"
        || (archive.kind === "canonical-object" && archive.canonicalization !== "RFC 8785")
        || !exact(archive.bytes, ["encoding", "value"]) || archive.bytes.encoding !== ENCODING) return null;
    const bytes = decode(archive.bytes.value, MAX_ARCHIVE_BYTES);
    if (!bytes) return null;
    evidence.push({ record: detach(item.record), archive: { kind: archive.kind, mediaType: archive.mediaType, bytes,
      ...(archive.kind === "canonical-object" ? { canonicalization: archive.canonicalization } : {}) } });
  }
  return evidence;
}
function checkCollections(membershipRecords, ledgerRecords, legacyAttestations) {
  if (!Array.isArray(membershipRecords) || membershipRecords.length < 1 || membershipRecords.length > MAX_MEMBERSHIP_RECORDS
      || !Array.isArray(ledgerRecords) || ledgerRecords.length > MAX_LEDGER_RECORDS
      || !Array.isArray(legacyAttestations) || legacyAttestations.length > MAX_PROOFS) return "package-record-limit";
  let ledgerBytes = 0;
  try {
    for (const record of membershipRecords) if (sortedJsonBytes(record).byteLength > 8192) return "membership-record-too-large";
    for (const record of ledgerRecords) {
      const size = sortedJsonBytes(record).byteLength;
      if (size > MAX_RECORD_BYTES) return "ledger-record-too-large";
      ledgerBytes += size;
      if (ledgerBytes > MAX_LEDGER_BYTES) return "ledger-too-large";
    }
    for (const proof of legacyAttestations) if (sortedJsonBytes(proof?.record).byteLength > 8192) return "proof-record-too-large";
  } catch { return "invalid-package-record"; }
  return null;
}
function packageBase(input, format, fields) {
  const parsed = parseInput(input);
  if (parsed.error) return parsed;
  const value = parsed.value;
  if (!exact(value, fields) || value.format !== format) return { error: "invalid-package-schema" };
  const membershipRecords = value.membershipRecords;
  const ledgerRecords = value.ledgerRecords;
  const error = checkCollections(membershipRecords, ledgerRecords, value.legacyAttestations);
  if (error) return { error };
  if (!readProofs(value.legacyAttestations)) return { error: "invalid-proof-archive" };
  let packageBytes;
  try { packageBytes = new TextEncoder().encode(JSON.stringify(value)).byteLength; } catch { return { error: "invalid-package-json" }; }
  if (packageBytes > MAX_PACKAGE_BYTES) return { error: "package-too-large" };
  const normalized = detach(value);
  normalized.membershipRecords = uniqueRecords(normalized.membershipRecords);
  normalized.ledgerRecords = uniqueRecords(normalized.ledgerRecords);
  normalized.legacyAttestations = uniqueRecords(normalized.legacyAttestations);
  return { value: normalized, legacyAttestations: readProofs(normalized.legacyAttestations) };
}
function validPin(pin) {
  return exact(pin, ["genesisId", "publicKeyFingerprint"])
    && typeof pin.genesisId === "string" && HASH.test(pin.publicKeyFingerprint);
}
function membershipWire(membershipRecords, ledgerRecords, legacyAttestations, trustPin, format) {
  const membership = detach(membershipRecords);
  const ledger = detach(ledgerRecords);
  const proofs = wireProofs(legacyAttestations);
  const issue = checkCollections(membership, ledger, proofs);
  if (issue) throw new TypeError(issue);
  if (!validPin(trustPin)) throw new TypeError("invalid-trust-pin");
  const genesis = membership.find((record) => record?.recordType === "group-created" && record.id === trustPin.genesisId);
  if (!genesis?.groupId) throw new TypeError("genesis-not-in-records");
  const value = { format, groupId: genesis.groupId, genesisId: genesis.id, trustPin: detach(trustPin), membershipRecords: membership,
    ledgerRecords: ledger, legacyAttestations: proofs };
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > MAX_PACKAGE_BYTES) throw new TypeError("package-too-large");
  return value;
}
async function verifyBundleRecords(pkg, proofs) {
  const verifiedGenesis = await verifyGroupGenesis(pkg.membershipRecords.find((record) => record?.id === pkg.genesisId), pkg.trustPin);
  if (!verifiedGenesis.ok || verifiedGenesis.groupId !== pkg.groupId) return { error: "untrusted-package-genesis" };
  const ledger = await projectAuthenticatedLedger(pkg.ledgerRecords, { membershipRecords: pkg.membershipRecords,
    trustPin: pkg.trustPin, legacyAttestations: proofs });
  if (ledger.groupId !== pkg.groupId || ledger.readOnly) return { error: "invalid-package-ledger" };
  // Keep only the well-formed signed writes rejected by an authenticated
  // removal cutoff; malformed, pending, unsupported, and other quarantine
  // states make this handoff incomplete or untrustworthy.
  if (ledger.pending.length || ledger.unsupported.length
      || ledger.quarantined.some((item) => item.reason !== "author-revoked-at-causal-frontier")) {
    return { error: "incomplete-or-invalid-package-ledger" };
  }
  for (const proof of proofs) {
    const verifiedProof = await verifyLegacyHistoryAttestation({ ...proof, membershipRecords: pkg.membershipRecords,
      trustPin: pkg.trustPin, verifiedCausalContexts: ledger.verifiedCausalContexts || [] });
    if (!verifiedProof.ok) return { error: "invalid-package-legacy-proof" };
  }
  const membership = await projectMembershipEnrollment(pkg.membershipRecords, { trustPin: pkg.trustPin,
    verifiedCausalContexts: ledger.verifiedCausalContexts || [] });
  if (!membership.groupId || membership.groupId !== pkg.groupId || membership.readOnly) return { error: "invalid-package-membership" };
  if (membership.diagnostics.some((item) => item.status === "quarantined" || item.status === "unsupported"
      || (item.status === "pending" && !["join-request-pending", "causal-checkpoint-inputs-require-graph-verification"].includes(item.reason)))) {
    return { error: "incomplete-or-invalid-package-membership" };
  }
  return { membership, ledger, genesis: pkg.membershipRecords.find((record) => record.id === pkg.genesisId) };
}
async function tokenHash(token) {
  if (typeof token !== "string" || !TOKEN.test(token)) return null;
  const raw = decode(token, 32);
  if (!raw || raw.byteLength !== 32) return null;
  return `sha256:${encode(new Uint8Array(await crypto.subtle.digest("SHA-256", raw)))}`;
}
function containsRecords(source, final) {
  const keys = new Set(final.map((record) => new TextDecoder().decode(sortedJsonBytes(record))));
  return source.every((record) => keys.has(new TextDecoder().decode(sortedJsonBytes(record))));
}
function sameProof(left, right) {
  return same(left.record, right.record) && left.archive?.kind === right.archive?.kind
    && left.archive?.mediaType === right.archive?.mediaType
    && left.archive?.canonicalization === right.archive?.canonicalization
    && left.archive?.bytes instanceof Uint8Array && right.archive?.bytes instanceof Uint8Array
    && left.archive.bytes.length === right.archive.bytes.length
    && left.archive.bytes.every((byte, index) => byte === right.archive.bytes[index]);
}
function containsProofs(source, final) { return source.every((proof) => final.some((item) => sameProof(proof, item))); }

/** Build the sole handoff package allowed to contain the invite bearer token. */
export async function createInviteBootstrapPackage({ membershipRecords, ledgerRecords, legacyAttestations, invite, token, trustPin } = {}) {
  const membership = detach(membershipRecords);
  const ledger = detach(ledgerRecords);
  const proofs = wireProofs(legacyAttestations);
  const issue = checkCollections(membership, ledger, proofs);
  if (issue) throw new TypeError(issue);
  if (!validPin(trustPin) || !invite || !membership.some((record) => same(record, invite))) throw new TypeError("invalid-invite-bootstrap");
  const genesis = membership.find((record) => record?.id === trustPin.genesisId);
  const common = { format: INVITE_FORMAT, groupId: genesis?.groupId, genesisId: genesis?.id, trustPin: detach(trustPin),
    membershipRecords: membership, ledgerRecords: ledger, legacyAttestations: proofs, inviteId: invite.payload?.inviteId, token };
  const verified = await verifyInviteBootstrapPackage(common);
  if (!verified.ok) throw new TypeError(verified.reason);
  return verified.package;
}

/** Verify a candidate bootstrap without establishing local trust or persisting anything. */
export async function verifyInviteBootstrapPackage(input, { now = Date.now(), allowExpired = false } = {}) {
  const fields = ["format", "groupId", "genesisId", "trustPin", "membershipRecords", "ledgerRecords", "legacyAttestations", "inviteId", "token"];
  const parsed = packageBase(input, INVITE_FORMAT, fields);
  if (parsed.error) return fail(parsed.error);
  const pkg = parsed.value;
  if (!validPin(pkg.trustPin) || pkg.trustPin.genesisId !== pkg.genesisId || typeof pkg.groupId !== "string"
      || !TOKEN.test(pkg.token) || typeof pkg.inviteId !== "string") return fail("invalid-invite-bootstrap");
  const checked = await verifyBundleRecords(pkg, parsed.legacyAttestations);
  if (checked.error) return fail(checked.error);
  const inviteRecords = pkg.membershipRecords.filter((record) => record?.recordType === "invite-issued" && record.payload?.inviteId === pkg.inviteId);
  if (inviteRecords.length !== 1) return fail("invite-not-unique");
  const invite = inviteRecords[0];
  const projectedInvite = checked.membership.invites.find((item) => item.recordId === invite.id && item.inviteId === pkg.inviteId);
  if (!projectedInvite || projectedInvite.revoked || invite.groupId !== pkg.groupId
      || !checked.membership.participants.some((person) => person.id === invite.payload.participantId)
      || invite.payload.tokenHash !== await tokenHash(pkg.token)) return fail("invite-not-authenticated");
  if (pkg.membershipRecords.some((record) => record?.recordType === "device-enrollment-approved" && record.payload?.inviteId === pkg.inviteId)) {
    return fail("invite-already-consumed");
  }
  const expired = invite.payload.expiresAt !== null && Date.parse(invite.payload.expiresAt) <= now;
  if (expired && !allowExpired) return fail("invite-expired");
  return { ok: true, package: pkg, invite, membership: { ...checked.membership, genesis: checked.genesis }, ledger: checked.ledger,
    groupName: checked.genesis.payload.name, currency: checked.genesis.payload.currency,
    expiresAt: invite.payload.expiresAt, expired, legacyAttestations: parsed.legacyAttestations };
}

/** Build the request-only return package; it contains no bearer token or private key. */
export function createJoinRequestPackage({ bootstrap, request } = {}) {
  const original = bootstrap?.package || bootstrap;
  const invite = original?.membershipRecords?.find((record) => record?.recordType === "invite-issued" && record.payload?.inviteId === original.inviteId);
  if (!original || original.format !== INVITE_FORMAT || !request || request.recordType !== "device-join-request"
      || request.groupId !== original.groupId || request.payload?.inviteId !== original.inviteId
      || request.payload?.participantId !== invite?.payload?.participantId) throw new TypeError("request-bootstrap-mismatch");
  const value = { format: REQUEST_FORMAT, groupId: original.groupId, inviteId: original.inviteId, request: detach(request) };
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1024) throw new TypeError("request-package-too-large");
  return value;
}

/** Verify the returned join proof against the original invitation, without granting membership. */
export async function verifyJoinRequestPackage(input, { bootstrap, allowExpired = false } = {}) {
  const base = bootstrap?.package || bootstrap;
  const verifiedBootstrap = await verifyInviteBootstrapPackage(base, { allowExpired });
  if (!verifiedBootstrap.ok) return fail("invalid-original-bootstrap");
  const parsed = parseInput(input);
  if (parsed.error) return fail(parsed.error);
  const value = parsed.value;
  if (!exact(value, ["format", "groupId", "inviteId", "request"]) || value.format !== REQUEST_FORMAT
      || value.groupId !== verifiedBootstrap.package.groupId || value.inviteId !== verifiedBootstrap.package.inviteId) return fail("request-bootstrap-mismatch");
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 64 * 1024) return fail("request-package-too-large");
  const request = value.request;
  if (request?.recordType !== "device-join-request" || request.groupId !== value.groupId
      || request.payload?.inviteId !== value.inviteId || request.payload?.participantId !== verifiedBootstrap.invite.payload.participantId) return fail("request-binding-mismatch");
  const projection = await projectMembershipEnrollment([...verifiedBootstrap.package.membershipRecords, request], {
    trustPin: verifiedBootstrap.package.trustPin, verifiedCausalContexts: verifiedBootstrap.ledger.verifiedCausalContexts || [] });
  const pending = projection.requests.some((item) => item.requestId === request.id && item.inviteId === value.inviteId
    && item.participantId === request.payload.participantId && item.deviceId === request.author.deviceId
    && item.keyId === request.author.keyId && item.publicKey === request.payload.publicKey);
  if (!pending || projection.readOnly) return fail("invalid-join-request-proof");
  return { ok: true, package: detach(value), request: detach(request), membership: projection };
}

/** Build the full post-approval proof package. It never contains the bearer token. */
export async function createApprovalBootstrapPackage({ membershipRecords, ledgerRecords, legacyAttestations, trustPin } = {}) {
  const value = membershipWire(membershipRecords, ledgerRecords, legacyAttestations, trustPin, PROOF_FORMAT);
  const parsed = packageBase(value, PROOF_FORMAT, ["format", "groupId", "genesisId", "trustPin", "membershipRecords", "ledgerRecords", "legacyAttestations"]);
  if (parsed.error) throw new TypeError(parsed.error);
  const verified = await verifyBundleRecords(parsed.value, parsed.legacyAttestations);
  if (verified.error) throw new TypeError(verified.error);
  return parsed.value;
}

/** Verify a final proof against this browser's original invite and exact local key before confirmation. */
export async function verifyApprovalBootstrapPackage(input, { bootstrap, request, identity } = {}) {
  const original = await verifyInviteBootstrapPackage(bootstrap?.package || bootstrap, { allowExpired: true });
  if (!original.ok) return fail("invalid-original-bootstrap");
  if (!request || !identity || request.recordType !== "device-join-request") return fail("missing-local-request-identity");
  const requestProof = await verifyJoinRequestPackage(createJoinRequestPackage({ bootstrap: original.package, request }),
    { bootstrap: original.package, allowExpired: true });
  if (!requestProof.ok) return fail("invalid-local-request");
  const parsed = packageBase(input, PROOF_FORMAT, ["format", "groupId", "genesisId", "trustPin", "membershipRecords", "ledgerRecords", "legacyAttestations"]);
  if (parsed.error) return fail(parsed.error);
  const pkg = parsed.value;
  if (pkg.groupId !== original.package.groupId || pkg.genesisId !== original.package.genesisId
      || !same(pkg.trustPin, original.package.trustPin)) return fail("final-proof-trust-mismatch");
  const checked = await verifyBundleRecords(pkg, parsed.legacyAttestations);
  if (checked.error) return fail(checked.error);
  if (!containsRecords(original.package.membershipRecords, pkg.membershipRecords)
      || !containsRecords(original.package.ledgerRecords, pkg.ledgerRecords)
      || !containsProofs(original.legacyAttestations, parsed.legacyAttestations)) return fail("final-proof-dropped-original-records");
  const exactRequest = pkg.membershipRecords.find((record) => record?.id === request.id && same(record, request));
  if (!exactRequest) return fail("final-proof-missing-request");
  const approval = pkg.membershipRecords.find((record) => record?.recordType === "device-enrollment-approved"
    && record.payload?.inviteId === original.package.inviteId && record.payload?.requestId === request.id);
  if (!approval || approval.payload.participantId !== request.payload.participantId
      || approval.payload.deviceId !== request.author.deviceId || approval.payload.keyId !== request.author.keyId
      || approval.payload.publicKeyFingerprint !== request.payload.publicKeyFingerprint || approval.payload.genesisId !== pkg.genesisId) {
    return fail("final-proof-approval-mismatch");
  }
  const keyBytes = await exportDevicePublicKey(identity.publicKey);
  const fingerprint = `sha256:${encode(new Uint8Array(await crypto.subtle.digest("SHA-256", keyBytes)))}`;
  if (identity.participantId !== request.author.participantId || identity.deviceId !== request.author.deviceId
      || identity.keyId !== request.author.keyId || fingerprint !== request.payload.publicKeyFingerprint
      || !await verifyRecord(request, identity.publicKey)) return fail("request-local-key-mismatch");
  const enrolledDevice = checked.membership.devices.find((device) => device.participantId === identity.participantId
    && device.deviceId === identity.deviceId && device.keyId === identity.keyId && device.requestId === request.id
    && device.approvalId === approval.id && device.publicKeyFingerprint === fingerprint);
  if (!enrolledDevice) return fail("device-not-enrolled-at-final-proof");
  return { ok: true, package: pkg, membership: checked.membership, ledger: checked.ledger,
    groupName: checked.genesis.payload.name, currency: checked.genesis.payload.currency,
    trustPin: detach(pkg.trustPin), enrolledDevice: detach(enrolledDevice), legacyAttestations: parsed.legacyAttestations };
}
