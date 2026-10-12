import { canonicalJsonBytes, verifyRecord } from "./identity-crypto.js";
import { getConflicts, isImmutableString } from "@automerge/automerge";
import { projectSignedMembership } from "./signed-membership-projector.js";
import { parseSignedLedgerRecord } from "./signed-ledger-records.js";
import { verifyLegacyHistoryAttestation } from "./legacy-history-attestation.js";

function canonical(value) { return new TextDecoder().decode(canonicalJsonBytes(value)); }
function failure(status, reason, record, event) {
  return { status, reason, ...(record ? { record } : {}), ...(event ? { event } : {}) };
}
function decodeKey(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  try {
    const raw = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
    const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
    return bytes.length === 32 ? bytes : null;
  } catch { return null; }
}
function sameBalances(left, right) {
  const normalize = (items) => [...items].sort((a, b) => a.participantId < b.participantId ? -1 : a.participantId > b.participantId ? 1 : 0);
  return canonical(normalize(left)) === canonical(normalize(right));
}

function decodeArchiveWire(archive) {
  const expectedKeys = archive?.kind === "original-bytes"
    ? ["kind", "mediaType", "bytes"]
    : archive?.kind === "canonical-object" ? ["kind", "mediaType", "canonicalization", "bytes"] : [];
  if (!expectedKeys.length || Object.keys(archive).length !== expectedKeys.length
      || Object.keys(archive).some((key) => !expectedKeys.includes(key))
      || archive.mediaType !== "application/json"
      || (archive.kind === "canonical-object" && archive.canonicalization !== "RFC 8785")
      || !archive.bytes
      || archive.bytes.encoding !== "base64url-no-padding" || typeof archive.bytes.value !== "string") return null;
  const value = archive.bytes.value;
  // DIV-114 caps raw archives at 8 MiB; reject oversized wire values before atob allocates.
  if (value.length > Math.ceil(8 * 1024 * 1024 * 4 / 3)) return null;
  if (!/^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-]{2}|[A-Za-z0-9_-]{3})?$/.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + (value.length % 4 === 2 ? "==" : value.length % 4 === 3 ? "=" : ""));
    const raw = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    let encoded = "";
    for (const byte of raw) encoded += String.fromCharCode(byte);
    if (btoa(encoded).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_") !== value) return null;
    const result = { kind: archive.kind, mediaType: archive.mediaType, bytes: raw };
    if (archive.kind === "canonical-object") result.canonicalization = archive.canonicalization;
    return result;
  } catch { return null; }
}

function textValue(value) {
  const text = isImmutableString(value) ? value.toString() : typeof value === "string" ? value : null;
  if (text === null || text.length > Math.ceil(8 * 1024 * 1024 * 4 / 3) + 16 * 1024) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** Decode every stored proof variant, restoring original archive bytes without a lossy object conversion. */
export function legacyAttestationsFromDocument(document) {
  const field = "legacyAttestationsById";
  let rootConflicts;
  try { rootConflicts = getConflicts(document, field); } catch { /* Detached snapshots have no Automerge conflicts. */ }
  const roots = rootConflicts ? Object.values(rootConflicts) : [document?.[field]];
  const evidence = [];
  for (const store of roots) {
    if (!store || typeof store !== "object" || Array.isArray(store)) continue;
    for (const key of Object.keys(store)) {
      let conflicts;
      if (!rootConflicts) {
        try { conflicts = getConflicts(store, key); } catch { /* Detached snapshots have no Automerge conflicts. */ }
      }
      const variants = rootConflicts ? [store[key]] : conflicts ? Object.values(conflicts) : [store[key]];
      for (const value of variants) {
        const decoded = textValue(value);
        if (decoded && typeof decoded === "object" && decoded.record && decoded.archive) {
          evidence.push({ record: decoded.record, archive: decodeArchiveWire(decoded.archive) });
        } else {
          const id = key.split(":", 1)[0];
          evidence.push({ record: { id, invalidStoredProof: true }, archive: null });
        }
      }
    }
  }
  return evidence;
}

/** Authenticates a legacy baseline only when its owner-signed mapped archive proof is available. */
export async function verifyLegacyOpeningBalanceImport(rawRecord, {
  legacyAttestations = [], membershipRecords, trustPin, verifiedCausalContexts = []
} = {}) {
  let record;
  let evidence;
  let memberships;
  let trust;
  let contexts;
  try {
    record = structuredClone(rawRecord);
    evidence = structuredClone(legacyAttestations);
    memberships = structuredClone(membershipRecords);
    trust = structuredClone(trustPin);
    contexts = [...verifiedCausalContexts];
  } catch { return failure("quarantined", "invalid-legacy-import-input"); }

  const parsed = parseSignedLedgerRecord(record);
  if (!parsed.ok) return failure("quarantined", parsed.reason, parsed.record);
  const event = parsed.event;
  if (event.type !== "opening-balances-imported" || event.payload.sourceFormat !== "legacy-activation") {
    return { status: "not-applicable" };
  }
  if (!Array.isArray(evidence) || !Array.isArray(memberships) || !trust || !Array.isArray(contexts)) {
    return failure("quarantined", "invalid-legacy-import-context", record, event);
  }

  const membershipIds = new Set(memberships.map((item) => item?.id).filter((id) => typeof id === "string"));
  if (record.membershipHeads.some((id) => !membershipIds.has(id))) return failure("pending", "missing-membership-head", record, event);
  let atHeads;
  try { atHeads = await projectSignedMembership(memberships, { trustPin: trust, atHeads: record.membershipHeads, verifiedCausalContexts: contexts }); }
  catch { return failure("quarantined", "membership-projection-failed", record, event); }
  if (!atHeads.groupId) {
    const missing = atHeads.diagnostics?.some((item) => item.reason === "missing-membership-head");
    return failure(missing ? "pending" : "quarantined", missing ? "missing-membership-head" : "untrusted-membership-heads", record, event);
  }
  // Historical verification is evaluated at the signed heads. A later unsupported
  // membership record can make current writes read-only without invalidating this proof.
  if (record.groupId !== atHeads.groupId) return failure("quarantined", "group-mismatch", record, event);
  if (event.payload.importId !== trust.genesisId) return failure("quarantined", "legacy-import-id-mismatch", record, event);
  if (event.payload.currency !== atHeads.currency) return failure("quarantined", "currency-mismatch", record, event);
  if (record.author.participantId !== atHeads.ownerParticipantId) return failure("quarantined", "not-financial-owner", record, event);
  const device = atHeads.devices.find((item) => item.participantId === record.author.participantId
    && item.deviceId === record.author.deviceId && item.keyId === record.author.keyId);
  const publicKeyBytes = device && decodeKey(device.publicKey);
  if (!publicKeyBytes) return failure("quarantined", "unknown-or-removed-owner-device", record, event);
  let signatureValid = false;
  try {
    const publicKey = await crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
    signatureValid = await verifyRecord(record, publicKey);
  } catch { /* fail closed */ }
  if (!signatureValid) return failure("quarantined", "invalid-signature", record, event);

  const matching = evidence.filter((item) => item?.record?.id === event.payload.legacyAttestationId);
  if (!matching.length) return failure("pending", "missing-legacy-attestation", record, event);
  const verified = [];
  let sawUnmapped = false;
  for (const item of matching) {
    let result;
    try {
      result = await verifyLegacyHistoryAttestation({ record: item.record, archive: item.archive,
        membershipRecords: memberships, trustPin: trust, verifiedCausalContexts: contexts });
    } catch { continue; }
    if (!result.ok) continue;
    if (result.record.membershipSchemaVersion !== 2 || !result.mappedOpeningBalances) { sawUnmapped = true; continue; }
    if (result.record.groupId !== record.groupId || result.record.payload.currency !== event.payload.currency) continue;
    verified.push({ item, result, key: canonical(result.record) });
  }
  const unique = new Map(verified.map((item) => [item.key, item]));
  if (!unique.size) return failure("quarantined", sawUnmapped ? "legacy-attestation-unmapped" : "invalid-legacy-attestation", record, event);
  if (unique.size > 1) return failure("quarantined", "legacy-attestation-id-collision", record, event);
  const selected = unique.values().next().value;
  if (!sameBalances(event.payload.balances, selected.result.mappedOpeningBalances)) {
    return failure("quarantined", "legacy-opening-balances-mismatch", record, event);
  }
  const participants = new Set(atHeads.participants.map(({ id }) => id));
  if (event.payload.balances.some(({ participantId }) => !participants.has(participantId))) {
    return failure("quarantined", "unknown-participant-reference", record, event);
  }
  return { status: "authorized", event, record, attestation: selected.item, mappedOpeningBalances: selected.result.mappedOpeningBalances };
}
