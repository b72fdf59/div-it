import { parseEvent } from "./events.js";
import { canonicalJsonBytes, signRecord, verifyRecord } from "./identity-crypto.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const AUTHOR_FIELDS = ["participantId", "deviceId", "keyId"];
const RECORD_FIELDS = ["id", "type", "schemaVersion", "protocolVersion", "groupId", "author", "createdAt", "membershipHeads", "causalHeads", "dependsOn", "payload", "signature"];
const INPUT_FIELDS = ["id", "type", "groupId", "author", "createdAt", "membershipHeads", "payload"];
const OPTIONAL_INPUT_FIELDS = ["causalHeads", "dependsOn"];
const MAX_RECORD_BYTES = 65_536;
const MAX_FRONTIER_ENTRIES = 64;

function isObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactFields(value, required, optional = []) {
  return isObject(value)
    && Object.getOwnPropertySymbols(value).length === 0
    && required.every((field) => Object.hasOwn(value, field))
    && Object.keys(value).every((field) => required.includes(field) || optional.includes(field));
}

function fail(reason, record) {
  return record === undefined ? { ok: false, reason } : { ok: false, reason, record };
}

function isUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

function validFrontier(values, { nonEmpty = false } = {}) {
  return Array.isArray(values)
    && values.length <= MAX_FRONTIER_ENTRIES
    && (!nonEmpty || values.length > 0)
    && values.every((value, index) => isUuid(value) && (index === 0 || values[index - 1] < value));
}

function detachedJson(value) {
  return JSON.parse(new TextDecoder().decode(canonicalJsonBytes(value)));
}

function parseRaw(raw) {
  if (typeof raw === "string") {
    if (new TextEncoder().encode(raw).byteLength > MAX_RECORD_BYTES) return fail("event-too-large");
    try {
      return { ok: true, value: JSON.parse(raw) };
    } catch {
      return fail("invalid-json");
    }
  }
  try {
    return { ok: true, value: raw };
  } catch {
    return fail("invalid-envelope");
  }
}

function v1StructuralView(record) {
  return {
    id: record.id,
    type: record.type,
    schemaVersion: record.schemaVersion,
    protocolVersion: 1,
    groupId: record.groupId,
    author: record.author,
    createdAt: record.createdAt,
    dependsOn: record.dependsOn,
    payload: record.payload,
    signature: record.signature
  };
}

/** Parse and structurally validate a signed v2 ledger record without authorizing membership or ancestry. */
export function parseSignedLedgerRecord(raw) {
  try {
    const parsed = parseRaw(raw);
    if (!parsed.ok) return parsed;
    const source = parsed.value;
    if (!hasExactFields(source, RECORD_FIELDS)) return fail("invalid-envelope");

    const canonicalBytes = canonicalJsonBytes(source);
    if (canonicalBytes.byteLength > MAX_RECORD_BYTES) return fail("event-too-large");
    const record = detachedJson(source);
    if (!hasExactFields(record.author, AUTHOR_FIELDS)) return fail("invalid-envelope", record);

    if (!isUuid(record.id) || !isUuid(record.groupId)) return fail("invalid-id", record);
    if (!Number.isSafeInteger(record.schemaVersion) || !Number.isSafeInteger(record.protocolVersion)
        || record.schemaVersion < 1 || record.protocolVersion < 1) return fail("invalid-version", record);
    if (record.schemaVersion !== 1 || record.protocolVersion !== 2) return fail("unsupported-version", record);
    if (!validFrontier(record.membershipHeads, { nonEmpty: true })) return fail("invalid-membership-heads", record);
    if (!validFrontier(record.causalHeads)) return fail("invalid-causal-heads", record);
    if (typeof record.signature !== "string" || !SIGNATURE.test(record.signature)) return fail("invalid-signature", record);

    const structural = parseEvent(v1StructuralView(record));
    if (!structural.ok) return fail(structural.reason, record);
    return { ok: true, record, event: structural.event };
  } catch {
    return fail("invalid-envelope");
  }
}

/** Create one schema-v1 financial record in the signed protocol-v2 envelope. */
export async function createSignedLedgerRecord(input, privateKey) {
  let source;
  try {
    if (!hasExactFields(input, INPUT_FIELDS, OPTIONAL_INPUT_FIELDS)) throw new TypeError("invalid-record-input");
    source = detachedJson(input);
  } catch {
    throw new TypeError("invalid-record-input");
  }
  const record = {
    id: source.id,
    type: source.type,
    schemaVersion: 1,
    protocolVersion: 2,
    groupId: source.groupId,
    author: source.author,
    createdAt: source.createdAt,
    membershipHeads: source.membershipHeads,
    causalHeads: Object.hasOwn(source, "causalHeads") ? source.causalHeads : [],
    dependsOn: Object.hasOwn(source, "dependsOn") ? source.dependsOn : [],
    payload: source.payload,
    signature: "A".repeat(86)
  };
  const validated = parseSignedLedgerRecord(record);
  if (!validated.ok) throw new TypeError(validated.reason);

  record.signature = await signRecord(record, privateKey);
  const signed = parseSignedLedgerRecord(record);
  if (!signed.ok) throw new TypeError(signed.reason);
  return signed.record;
}

/** Verify the signature after structural validation; membership and ancestry checks are separate. */
export async function verifySignedLedgerRecord(raw, publicKey) {
  const parsed = parseSignedLedgerRecord(raw);
  if (!parsed.ok) return parsed;
  if (!(await verifyRecord(parsed.record, publicKey))) return fail("invalid-signature", parsed.record);
  return parsed;
}
