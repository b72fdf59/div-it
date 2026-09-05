export const EVENT_TYPES = Object.freeze([
  "expense-created",
  "expense-revised",
  "expense-voided",
  "settlement-recorded",
  "settlement-reversed",
  "opening-balances-imported",
  "conflict-resolved"
]);
const EVENT_TYPE_SET = new Set(EVENT_TYPES);

const ENVELOPE_FIELDS = [
  "id",
  "type",
  "schemaVersion",
  "protocolVersion",
  "groupId",
  "author",
  "createdAt",
  "dependsOn",
  "payload",
  "signature"
];
const AUTHOR_FIELDS = ["participantId", "deviceId", "keyId"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURRENCY = /^[A-Z]{3}$/;
const SIGNATURE = /^[A-Za-z0-9_-]+$/;
const UTC_TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;
const MAX_EVENT_BYTES = 65_536;
const MAX_COLLECTION_ENTRIES = 256;
const MAX_SIGNATURE_LENGTH = 512;

function failure(reason) {
  return { ok: false, reason };
}

function utf8Length(value) {
  return new TextEncoder().encode(value).byteLength;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactFields(value, required, optional = []) {
  if (!isObject(value)) return false;
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => required.includes(key) || optional.includes(key));
}

function isIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim() && [...value].length <= 128;
}

function isUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

function isTimestamp(value) {
  if (typeof value !== "string") return false;
  const match = UTC_TIMESTAMP.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (hour > 23 || minute > 59 || second > 59) return false;
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function isSortedUnique(values) {
  return values.every((value, index) => index === 0 || values[index - 1] < value);
}

function isText(value, { allowEmpty = false } = {}) {
  return typeof value === "string"
    && value === value.trim()
    && [...value].length <= 500
    && (allowEmpty || value.length > 0);
}

function validMoney(value, { positive = true } = {}) {
  return Number.isSafeInteger(value) && (!positive || value > 0);
}

function validateSplits(payload) {
  if (!Array.isArray(payload.splits) || payload.splits.length === 0) return failure("invalid-payload");
  if (payload.splits.length > MAX_COLLECTION_ENTRIES) return failure("event-too-large");
  const participants = new Set();
  let total = 0n;
  for (const split of payload.splits) {
    if (!hasExactFields(split, ["participantId", "amount"]) || !isIdentifier(split.participantId)) return failure("invalid-payload");
    if (participants.has(split.participantId)) return failure("duplicate-participant");
    if (!validMoney(split.amount)) return failure("invalid-money");
    participants.add(split.participantId);
    total += BigInt(split.amount);
  }
  return total === BigInt(payload.amount) ? null : failure("split-total-mismatch");
}

function validateExpense(payload, revised) {
  const fields = ["expenseId", ...(revised ? ["supersedesEventId"] : []), "description", "currency", "amount", "payerId", "splits"];
  if (!hasExactFields(payload, fields)) return failure("invalid-payload");
  if (!isUuid(payload.expenseId) || (revised && !isUuid(payload.supersedesEventId))) return failure("invalid-id");
  if (!isText(payload.description) || !CURRENCY.test(payload.currency) || !isIdentifier(payload.payerId)) return failure("invalid-payload");
  if (!validMoney(payload.amount)) return failure("invalid-money");
  return validateSplits(payload);
}

function validatePayload(event) {
  const payload = event.payload;
  if (!isObject(payload)) return failure("invalid-payload");

  if (event.type === "expense-created") return validateExpense(payload, false);
  if (event.type === "expense-revised") {
    const invalid = validateExpense(payload, true);
    if (invalid) return invalid;
    return event.dependsOn.includes(payload.supersedesEventId) ? null : failure("invalid-reference");
  }
  if (event.type === "expense-voided") {
    if (!hasExactFields(payload, ["expenseId", "supersedesEventId", "reason"])) return failure("invalid-payload");
    if (!isUuid(payload.expenseId) || !isUuid(payload.supersedesEventId)) return failure("invalid-id");
    if (!isText(payload.reason)) return failure("invalid-payload");
    return event.dependsOn.includes(payload.supersedesEventId) ? null : failure("invalid-reference");
  }
  if (event.type === "settlement-recorded") {
    if (!hasExactFields(payload, ["settlementId", "currency", "fromParticipantId", "toParticipantId", "amount"], ["note"])) return failure("invalid-payload");
    if (!isUuid(payload.settlementId)) return failure("invalid-id");
    if (!CURRENCY.test(payload.currency) || !isIdentifier(payload.fromParticipantId) || !isIdentifier(payload.toParticipantId) || payload.fromParticipantId === payload.toParticipantId) return failure("invalid-payload");
    if (!validMoney(payload.amount)) return failure("invalid-money");
    return Object.hasOwn(payload, "note") && !isText(payload.note, { allowEmpty: true }) ? failure("invalid-payload") : null;
  }
  if (event.type === "settlement-reversed") {
    if (!hasExactFields(payload, ["settlementId", "reversesEventId", "reason"])) return failure("invalid-payload");
    if (!isUuid(payload.settlementId) || !isUuid(payload.reversesEventId)) return failure("invalid-id");
    if (!isText(payload.reason)) return failure("invalid-payload");
    return event.dependsOn.includes(payload.reversesEventId) ? null : failure("invalid-reference");
  }
  if (event.type === "opening-balances-imported") {
    if (!hasExactFields(payload, ["importId", "currency", "sourceFormat", "balances"])) return failure("invalid-payload");
    if (!isUuid(payload.importId)) return failure("invalid-id");
    if (!CURRENCY.test(payload.currency) || payload.sourceFormat !== "splitwise-csv" || !Array.isArray(payload.balances) || payload.balances.length === 0) return failure("invalid-payload");
    if (payload.balances.length > MAX_COLLECTION_ENTRIES) return failure("event-too-large");
    const participants = new Set();
    let total = 0n;
    for (const balance of payload.balances) {
      if (!hasExactFields(balance, ["participantId", "amount"]) || !isIdentifier(balance.participantId)) return failure("invalid-payload");
      if (participants.has(balance.participantId)) return failure("duplicate-participant");
      if (!validMoney(balance.amount, { positive: false })) return failure("invalid-money");
      participants.add(balance.participantId);
      total += BigInt(balance.amount);
    }
    return total === 0n ? null : failure("non-zero-sum");
  }

  if (!hasExactFields(payload, ["resolutionId", "expenseId", "resolvesEventIds", "chosenEventId", "supersedesResolutionEventIds"], ["note"])) return failure("invalid-payload");
  if (!isUuid(payload.resolutionId) || !isUuid(payload.expenseId) || !isUuid(payload.chosenEventId)) return failure("invalid-id");
  for (const references of [payload.resolvesEventIds, payload.supersedesResolutionEventIds]) {
    if (!Array.isArray(references)) return failure("invalid-reference");
    if (references.length > MAX_COLLECTION_ENTRIES) return failure("event-too-large");
    if (!references.every(isUuid) || !isSortedUnique(references)) return failure("invalid-reference");
  }
  if (payload.resolvesEventIds.length < 2
    || !payload.resolvesEventIds.includes(payload.chosenEventId)
    || [...payload.resolvesEventIds, ...payload.supersedesResolutionEventIds].some((id) => !event.dependsOn.includes(id))) return failure("invalid-resolution");
  return Object.hasOwn(payload, "note") && !isText(payload.note, { allowEmpty: true }) ? failure("invalid-payload") : null;
}

function stableEvent(event) {
  return {
    id: event.id,
    type: event.type,
    schemaVersion: event.schemaVersion,
    protocolVersion: event.protocolVersion,
    groupId: event.groupId,
    author: { participantId: event.author.participantId, deviceId: event.author.deviceId, keyId: event.author.keyId },
    createdAt: event.createdAt,
    dependsOn: [...event.dependsOn],
    payload: JSON.parse(JSON.stringify(event.payload)),
    signature: event.signature
  };
}

export function parseEvent(raw) {
  if (typeof raw === "string"
    && (raw.length > MAX_EVENT_BYTES || utf8Length(raw) > MAX_EVENT_BYTES)) return failure("event-too-large");

  let event;
  try {
    event = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return failure("invalid-json");
  }

  if (hasExactFields(event, ENVELOPE_FIELDS.filter((field) => field !== "signature"))) return failure("unauthenticated");
  if (!hasExactFields(event, ENVELOPE_FIELDS) || !hasExactFields(event.author, AUTHOR_FIELDS)) return failure("invalid-envelope");
  if (!isUuid(event.id) || !isUuid(event.groupId)) return failure("invalid-id");
  if (!Number.isSafeInteger(event.schemaVersion) || !Number.isSafeInteger(event.protocolVersion) || event.schemaVersion < 1 || event.protocolVersion < 1) return failure("invalid-version");
  if (event.schemaVersion !== 1 || event.protocolVersion !== 1) return failure("unsupported-version");
  if (!EVENT_TYPE_SET.has(event.type)) return failure("unsupported-event-type");
  if (!AUTHOR_FIELDS.every((field) => isIdentifier(event.author[field]))) return failure("invalid-envelope");
  if (typeof event.createdAt === "string" && event.createdAt.length > 30) return failure("event-too-large");
  if (!isTimestamp(event.createdAt)) return failure("invalid-envelope");
  if (!Array.isArray(event.dependsOn)) return failure("invalid-reference");
  if (event.dependsOn.length > MAX_COLLECTION_ENTRIES) return failure("event-too-large");
  if (!event.dependsOn.every(isUuid) || !isSortedUnique(event.dependsOn) || event.dependsOn.includes(event.id)) return failure("invalid-reference");
  if (typeof event.signature === "string" && event.signature.length > MAX_SIGNATURE_LENGTH) return failure("event-too-large");
  if (typeof event.signature !== "string" || !SIGNATURE.test(event.signature)) return failure("unauthenticated");

  const payloadFailure = validatePayload(event);
  if (payloadFailure) return payloadFailure;

  const stable = stableEvent(event);
  if (utf8Length(JSON.stringify(stable)) > MAX_EVENT_BYTES) return failure("event-too-large");
  return { ok: true, event: stable };
}
