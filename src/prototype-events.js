import { documentIdToBinary } from "@automerge/automerge-repo";
import { projectLedger } from "./ledger.js";

export const PROTOTYPE_AUTHOR = Object.freeze({ participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" });
export const PROTOTYPE_SIGNATURE = "development-only";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function groupIdFromDocumentId(documentId) {
  const bytes = documentIdToBinary(documentId);
  if (!bytes || bytes.byteLength !== 16) throw new Error("Invalid local group document ID.");
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  if (!UUID.test(id)) throw new Error("Local group document ID is not a UUID.");
  return id;
}

function timestamp(value) {
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : "1970-01-01T00:00:00.000Z";
}

export function expenseEnvelope(expense, { groupId, currency }) {
  return {
    id: expense.id,
    type: "expense-created",
    schemaVersion: 1,
    protocolVersion: 1,
    groupId,
    author: { ...PROTOTYPE_AUTHOR },
    createdAt: timestamp(expense.createdAt),
    dependsOn: [],
    payload: {
      expenseId: expense.id,
      description: expense.description,
      currency,
      amount: expense.amount,
      payerId: expense.payerId,
      splits: expense.splits.map(({ personId, amount }) => ({ participantId: personId, amount }))
    },
    signature: PROTOTYPE_SIGNATURE
  };
}

export function settlementEnvelope({ type, id = crypto.randomUUID(), groupId, payload, dependsOn = [] }) {
  return {
    id,
    type,
    schemaVersion: 1,
    protocolVersion: 1,
    groupId,
    author: { ...PROTOTYPE_AUTHOR },
    createdAt: new Date().toISOString(),
    dependsOn: [...dependsOn].sort(),
    payload,
    signature: PROTOTYPE_SIGNATURE
  };
}

export function expenseChangeEnvelope({ type, groupId, expenseId, supersedesEventId, payload = {}, reason }) {
  return {
    id: crypto.randomUUID(),
    type,
    schemaVersion: 1,
    protocolVersion: 1,
    groupId,
    author: { ...PROTOTYPE_AUTHOR },
    createdAt: new Date().toISOString(),
    dependsOn: [supersedesEventId],
    payload: type === "expense-revised"
      ? { ...payload, expenseId, supersedesEventId }
      : { expenseId, supersedesEventId, reason },
    signature: PROTOTYPE_SIGNATURE
  };
}

export function normalizeExpenseForProjection(event, { groupId, currency }) {
  const envelopeMarkers = ["schemaVersion", "protocolVersion", "groupId", "payload", "author", "signature", "dependsOn"];
  if (!event || typeof event !== "object" || envelopeMarkers.some((marker) => Object.hasOwn(event, marker))
    || !["expense", "expense-created"].includes(event.type)) return event;
  if (typeof event.id !== "string" || !UUID.test(event.id)
    || typeof event.description !== "string" || typeof event.payerId !== "string"
    || !Number.isSafeInteger(event.amount) || event.amount <= 0 || !Array.isArray(event.splits)
    || event.splits.some((split) => !split || typeof split !== "object" || Array.isArray(split)
      || typeof split.personId !== "string" || !Number.isSafeInteger(split.amount) || split.amount <= 0)
    || event.splits.reduce((sum, split) => sum + split.amount, 0) !== event.amount) return event;
  return expenseEnvelope(event, { groupId, currency });
}

export function projectGroup(group) {
  const eventsById = new Map();
  for (const [index, sourceEvent] of group.events.entries()) {
    const event = normalizeExpenseForProjection(sourceEvent, group);
    const id = typeof event?.id === "string" ? event.id : `legacy-missing-id-${index}`;
    const existing = eventsById.get(id);
    if (existing) existing.push(event);
    else eventsById.set(id, [event]);
  }
  const participantIds = new Set((group.people ?? []).flatMap((person) => typeof person?.id === "string" ? [person.id] : []));
  return projectLedger(eventsById, {
    groupId: group.groupId,
    currency: group.currency,
    // Prototype-only authorization: membership is checked locally, but signatures are placeholders until device identity exists.
    isEventAuthorized: (event) => (event.author.participantId === PROTOTYPE_AUTHOR.participantId || participantIds.has(event.author.participantId))
      && (event.schemaVersion !== 1 || event.protocolVersion !== 1 ? true : event.type === "expense-created" || event.type === "expense-revised"
        ? participantIds.has(event.payload.payerId) && event.payload.splits.every(({ participantId }) => participantIds.has(participantId))
        : event.type === "settlement-recorded"
          ? participantIds.has(event.payload.fromParticipantId) && participantIds.has(event.payload.toParticipantId)
          : true)
  });
}
