import { documentIdToBinary } from "@automerge/automerge-repo";
import { parseEvent } from "./events.js";
import { projectLedger } from "./ledger.js";

export const PROTOTYPE_AUTHOR = Object.freeze({ participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" });
export const PROTOTYPE_SIGNATURE = "development-only";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function isPrototypeEventAuthorized(event, participantIds) {
  if (event.author.participantId !== PROTOTYPE_AUTHOR.participantId && !participantIds.has(event.author.participantId)) return false;
  if (event.schemaVersion !== 1 || event.protocolVersion !== 1) return true;
  if (event.type === "expense-created" || event.type === "expense-revised") {
    return participantIds.has(event.payload.payerId) && event.payload.splits.every(({ participantId }) => participantIds.has(participantId));
  }
  if (event.type === "settlement-recorded") {
    return participantIds.has(event.payload.fromParticipantId) && participantIds.has(event.payload.toParticipantId);
  }
  return true;
}

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

export function conflictResolutionEnvelope({ groupId, expenseId, resolvesEventIds, chosenEventId, supersedesResolutionEventIds = [] }) {
  const id = crypto.randomUUID();
  const supersedes = [...supersedesResolutionEventIds].sort();
  return {
    id,
    type: "conflict-resolved",
    schemaVersion: 1,
    protocolVersion: 1,
    groupId,
    author: { ...PROTOTYPE_AUTHOR },
    createdAt: new Date().toISOString(),
    dependsOn: [...new Set([...resolvesEventIds, ...supersedes])].sort(),
    payload: {
      resolutionId: crypto.randomUUID(),
      expenseId,
      resolvesEventIds: [...resolvesEventIds].sort(),
      chosenEventId,
      supersedesResolutionEventIds: supersedes
    },
    signature: PROTOTYPE_SIGNATURE
  };
}

export function expenseConflictReviews(group, projection = projectGroup(group)) {
  const conflicts = new Set(projection.conflicting.filter(({ reason }) => reason === "conflicting-revision").map(({ id }) => id));
  if (!conflicts.size) return [];
  const validIds = new Set([
    ...projection.effective.map(({ id }) => id),
    ...projection.conflicting.map(({ id }) => id)
  ]);
  const participantIds = new Set((group.people ?? []).flatMap((person) => typeof person?.id === "string" ? [person.id] : []));
  const events = new Map();
  for (const source of group.events ?? []) {
    const candidate = normalizeExpenseForProjection(source, group);
    const parsed = parseEvent(candidate);
    if (!parsed.ok) continue;
    const event = parsed.event;
    if (!validIds.has(event.id) || event.groupId !== group.groupId
      || (["expense-created", "expense-revised", "settlement-recorded"].includes(event.type)
        && event.payload.currency !== group.currency)
      || !isPrototypeEventAuthorized(event, participantIds)) continue;
    if (!events.has(event.id)) events.set(event.id, event);
  }
  const forks = new Map();
  for (const id of conflicts) {
    const event = events.get(id);
    if (!event || !["expense-revised", "expense-voided"].includes(event.type)) continue;
    const key = `${event.payload.expenseId}:${event.payload.supersedesEventId}`;
    if (!forks.has(key)) forks.set(key, { expenseId: event.payload.expenseId, parentId: event.payload.supersedesEventId, branchIds: [] });
    forks.get(key).branchIds.push(id);
  }
  const reviews = [];
  for (const fork of forks.values()) {
    fork.branchIds.sort();
    if (fork.branchIds.length < 2) continue;
    const branchSet = new Set(fork.branchIds);
    const alreadyResolved = projection.effective.some((event) => event.type === "conflict-resolved"
      && event.payload.resolvesEventIds.length === fork.branchIds.length
      && event.payload.resolvesEventIds.every((id, index) => id === fork.branchIds[index]));
    if (alreadyResolved) continue;
    const resolutionIds = projection.conflicting.filter(({ id, reason }) => reason === "conflicting-resolution"
      && branchSet.size === events.get(id)?.payload?.resolvesEventIds?.length
      && events.get(id)?.payload?.resolvesEventIds.every((branchId) => branchSet.has(branchId)))
      .map(({ id }) => id).sort();
    const branches = fork.branchIds.map((id) => {
      const hypotheticalResolution = conflictResolutionEnvelope({ groupId: group.groupId, expenseId: fork.expenseId,
        resolvesEventIds: fork.branchIds, chosenEventId: id, supersedesResolutionEventIds: resolutionIds });
      const hypothetical = projectGroup({ ...group, events: [...(group.events ?? []), hypotheticalResolution] });
      const preview = hypothetical.effective.find((event) => event.payload?.expenseId === fork.expenseId
        && ["expense-created", "expense-revised", "expense-voided"].includes(event.type));
      return { id, event: events.get(id), preview };
    });
    reviews.push({ ...fork, key: fork.parentId, branchIds: [...fork.branchIds], resolutionIds, branches,
      branchPreviewIds: branches.map(({ id, preview }) => `${id}:${preview?.id || "missing"}`),
      branchPreviewSnapshots: branches.map(({ preview }) => JSON.stringify(preview)) });
  }
  return reviews.sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0);
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
    isEventAuthorized: (event) => isPrototypeEventAuthorized(event, participantIds)
  });
}
