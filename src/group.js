import { Repo } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { legacyGroup } from "./legacy.js";
import { canonicalEventContent, makeExpense } from "./ledger.js";
import { parseEvent } from "./events.js";
import { conflictResolutionEnvelope, expenseChangeEnvelope, expenseConflictReviews, expenseEnvelope, groupIdFromDocumentId, normalizeExpenseForProjection, projectGroup, settlementEnvelope } from "./prototype-events.js";
import { appendStoredEvent, eventsFromDocument, migrateEventStore, needsEventStoreMigration } from "./event-store.js";

const GROUP_ID_KEY = "div-it-group-id";
const emptyGroup = () => ({ name: "My group", currency: "USD", people: [], events: [], eventsById: {} });
const currencies = new Set(["USD", "INR", "EUR", "GBP"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let controller;

export function validatePersonName(name) {
  if (typeof name !== "string" || !name.trim()) throw new Error("Enter a name.");
  return name.trim();
}

export function validateGroupSettings({ name, currency }) {
  if (typeof name !== "string" || !name.trim()) throw new Error("Enter a group name.");
  if (!currencies.has(currency)) throw new Error("Choose a supported currency.");
  return { name: name.trim(), currency };
}

function inspectGroupIds(events) {
  const ids = new Set();
  let invalid = false;
  for (const event of events) {
    if (event && typeof event === "object" && Object.hasOwn(event, "schemaVersion")) {
      if (!UUID.test(event.groupId || "")) invalid = true;
      else ids.add(event.groupId);
    }
  }
  return { id: ids.size === 1 ? [...ids][0] : undefined, ambiguous: ids.size > 1, invalid };
}

function groupIdInEvents(events) {
  const result = inspectGroupIds(events);
  if (result.invalid) throw new Error("Backup contains an invalid ledger group ID.");
  if (result.ambiguous) throw new Error("Backup contains events from multiple ledger groups.");
  return result.id;
}

export function validateBackup(group) {
  if (!group || typeof group !== "object" || Array.isArray(group)
    || typeof group.name !== "string" || typeof group.currency !== "string"
    || !Array.isArray(group.people) || !Array.isArray(group.events)) {
    throw new Error("Not a Div It backup.");
  }
  validateGroupSettings({ name: group.name, currency: group.currency });
  const participantIds = new Set();
  for (const person of group.people) {
    if (!person || typeof person !== "object" || Array.isArray(person)
      || typeof person.id !== "string" || !person.id.trim()) {
      throw new Error("Backup contains an invalid participant.");
    }
    validatePersonName(person.name);
    if (participantIds.has(person.id)) throw new Error("Backup contains duplicate participant IDs.");
    participantIds.add(person.id);
  }
  if (group.groupId !== undefined && (typeof group.groupId !== "string" || !UUID.test(group.groupId))) {
    throw new Error("Backup contains an invalid ledger group ID.");
  }
  const eventGroupId = groupIdInEvents(group.events);
  if (group.groupId && eventGroupId && group.groupId !== eventGroupId) {
    throw new Error("Backup group ID does not match its events.");
  }
  const validated = structuredClone({ name: group.name, currency: group.currency, people: group.people, events: group.events });
  if (group.groupId || eventGroupId) validated.groupId = group.groupId || eventGroupId;
  return validated;
}

export function prepareBackupMerge(current, input) {
  const backup = validateBackup(input);
  const currentPeople = current.people ?? [];
  const currentEvents = current.events ?? [];
  const populated = currentPeople.length > 0 || currentEvents.length > 0;
  if (current.groupIdentityIssue) throw new Error("This group's ledger identity is ambiguous and cannot accept a backup.");
  if (populated && backup.groupId && current.groupId !== backup.groupId) {
    throw new Error("Backup belongs to a different ledger group.");
  }
  if (populated && current.currency !== backup.currency) {
    throw new Error("Backup currency does not match this populated group.");
  }

  const peopleById = new Map(currentPeople.map((person) => [person.id, person]));
  const newPeople = [];
  for (const person of backup.people) {
    const existing = peopleById.get(person.id);
    if (existing && existing.name !== person.name) throw new Error(`Participant ID ${person.id} has different names in the backup.`);
    if (!existing) {
      peopleById.set(person.id, person);
      newPeople.push(person);
    }
  }

  const incomingById = new Map();
  for (const source of backup.events) {
    const event = normalizeExpenseForProjection(source, { groupId: backup.groupId || current.groupId, currency: backup.currency });
    if (typeof event?.id !== "string" || !event.id) throw new Error("Backup contains a ledger event without an ID.");
    const content = canonicalEventContent(source);
    const variants = incomingById.get(source.id) ?? [];
    if (variants.some((variant) => canonicalEventContent(variant) !== content)) {
      throw new Error(`Backup contains different ledger events with ID ${source.id}.`);
    }
    variants.push(source);
    incomingById.set(source.id, variants);
  }
  for (const [id, variants] of incomingById) {
    const local = currentEvents.filter((event) => event?.id === id);
    if (local.some((event) => variants.some((variant) => canonicalEventContent(event) !== canonicalEventContent(variant)))) {
      throw new Error(`Ledger event ID ${id} conflicts with this group.`);
    }
  }

  const newEvents = backup.events.filter((event) => !currentEvents.some((existing) => canonicalEventContent(existing) === canonicalEventContent(event)));
  const incomingProjection = projectGroup({
    groupId: backup.groupId || current.groupId,
    currency: backup.currency,
    people: [...currentPeople, ...newPeople],
    events: [...currentEvents, ...newEvents]
  });
  const incomingIds = new Set(newEvents.map((event) => event.id));
  const incomingQuarantine = incomingProjection.quarantined.filter(({ id }) => incomingIds.has(id));
  if (incomingQuarantine.length) {
    const reasons = [...new Set(incomingQuarantine.map(({ reason }) => reason))].join(", ");
    throw new Error(`Backup contains invalid ledger events (${reasons}).`);
  }

  const fresh = !populated;
  const groupId = fresh ? backup.groupId || current.groupId : current.groupId;
  return {
    name: fresh ? backup.name : current.name,
    currency: fresh ? backup.currency : current.currency,
    groupId,
    people: newPeople,
    events: newEvents,
    changes: fresh && (backup.name !== current.name || backup.currency !== current.currency || (backup.groupId && backup.groupId !== current.groupId))
      || newPeople.length > 0 || newEvents.length > 0
  };
}

function assertWritable(group) {
  if (group.groupIdentityIssue) throw new Error("This group's ledger identity is ambiguous. Import a valid backup before editing.");
  if (projectGroup(group).readOnly) throw new Error("This group has unsupported ledger entries and is read-only until the app is updated.");
}

function snapshotGroup(document) {
  const snapshot = JSON.parse(JSON.stringify(document));
  snapshot.events = eventsFromDocument(document);
  delete snapshot.eventsById;
  delete snapshot.eventStoreFormatVersion;
  return snapshot;
}

function assertValidEvent(event) {
  const parsed = parseEvent(event);
  if (!parsed.ok) throw new Error(`Invalid ledger entry: ${parsed.reason}.`);
}

function currentExpenseForChange(group, eventId) {
  const projection = projectGroup(group);
  const target = projection.effective.find((event) => event.id === eventId
    && ["expense-created", "expense-revised"].includes(event.type));
  if (!target) throw new Error("This expense changed since you opened it. Close the form and review the current activity.");
  const sameExpense = (event) => event?.payload?.expenseId === target.payload.expenseId;
  const conflictingIds = new Set(projection.conflicting.map(({ id }) => id));
  if (group.events.some((event) => conflictingIds.has(event?.id) && sameExpense(event))) {
    throw new Error("This expense has competing changes. Resolve them before revising or voiding it.");
  }
  return target;
}

export function currentConflictChoice(group, input) {
  const { expenseId, parentId, resolvesEventIds, chosenEventId, supersedesResolutionEventIds = [], branchPreviewIds, branchPreviewSnapshots } = input || {};
  const review = expenseConflictReviews(group).find((item) => item.expenseId === expenseId && item.parentId === parentId);
  const sameIds = (left, right) => Array.isArray(left) && left.length === right.length
    && [...left].sort().every((id, index) => id === right[index]);
  if (!review || !sameIds(resolvesEventIds, review.branchIds)
    || !sameIds(supersedesResolutionEventIds, review.resolutionIds)
    || !Array.isArray(branchPreviewIds) || branchPreviewIds.length !== review.branchPreviewIds.length
    || branchPreviewIds.some((id, index) => id !== review.branchPreviewIds[index])
    || !Array.isArray(branchPreviewSnapshots) || branchPreviewSnapshots.length !== review.branchPreviewSnapshots.length
    || branchPreviewSnapshots.some((snapshot, index) => snapshot !== review.branchPreviewSnapshots[index])
    || !review.branchIds.includes(chosenEventId)) {
    throw new Error("This conflict changed since you opened it. Review the current competing changes before choosing.");
  }
  return review;
}

export async function openGroup(onSnapshot) {
  if (controller) return controller;

  const repo = new Repo({
    storage: new IndexedDBStorageAdapter(),
    network: [new BroadcastChannelNetworkAdapter()],
  });
  const documentId = localStorage.getItem(GROUP_ID_KEY);
  const handle = documentId ? await repo.find(documentId) : repo.create((await legacyGroup()) || emptyGroup());

  if (needsEventStoreMigration(handle.doc())) {
    handle.change((document) => migrateEventStore(document));
  }

  const snapshot = snapshotGroup(handle.doc());
  const eventGroups = inspectGroupIds(snapshot.events);
  const storedGroupId = UUID.test(snapshot.groupId || "") ? snapshot.groupId : undefined;
  const groupIdentityIssue = snapshot.groupId !== undefined && !storedGroupId
    || eventGroups.ambiguous
    || !storedGroupId && eventGroups.invalid;
  const groupId = storedGroupId || (!eventGroups.ambiguous && !eventGroups.invalid && eventGroups.id)
    || groupIdFromDocumentId(handle.documentId);
  if (!storedGroupId || snapshot.groupIdentityIssue !== groupIdentityIssue) {
    handle.change((document) => {
      document.groupId = groupId;
      document.groupIdentityIssue = groupIdentityIssue;
    });
  }

  if (!documentId) localStorage.setItem(GROUP_ID_KEY, handle.documentId);
  const publish = (doc) => onSnapshot(snapshotGroup(doc));
  handle.on("change", ({ doc }) => publish(doc));
  publish(handle.doc());

  controller = {
    saveSettings(input) {
      const settings = validateGroupSettings(input);
      const current = snapshotGroup(handle.doc());
      assertWritable(current);
      if (settings.currency !== current.currency && current.events.length) {
        throw new Error("A group's currency can't change after ledger entries are recorded.");
      }
      handle.change((document) => Object.assign(document, settings));
    },
    addPerson(input) {
      assertWritable(snapshotGroup(handle.doc()));
      const name = validatePersonName(input);
      const person = { id: crypto.randomUUID(), name };
      handle.change((document) => document.people.push(person));
      return person;
    },
    addExpense(input) {
      assertWritable(snapshotGroup(handle.doc()));
      const expense = makeExpense(input);
      const snapshot = snapshotGroup(handle.doc());
      const peopleIds = new Set(snapshot.people.map(({ id }) => id));
      if (!peopleIds.has(expense.payerId) || expense.splits.some(({ personId }) => !peopleIds.has(personId))) {
        throw new Error("Choose people in this group for the payer and split.");
      }
      const event = expenseEnvelope(expense, { groupId: snapshot.groupId || groupId, currency: snapshot.currency });
      assertValidEvent(event);
      handle.change((document) => appendStoredEvent(document, event));
      return event;
    },
    reviseExpense(input) {
      const { eventId, description, amount, payerId, splits } = input || {};
      const current = snapshotGroup(handle.doc());
      assertWritable(current);
      const target = currentExpenseForChange(current, eventId);
      if (target.payload.currency !== current.currency) throw new Error("This expense uses a different group currency.");
      const expense = makeExpense({ id: crypto.randomUUID(), description, amount, payerId, splits });
      const peopleIds = new Set(current.people.map(({ id }) => id));
      if (!peopleIds.has(expense.payerId) || expense.splits.some(({ personId }) => !peopleIds.has(personId))) {
        throw new Error("Choose people in this group for the payer and split.");
      }
      const event = expenseChangeEnvelope({
        type: "expense-revised",
        groupId: current.groupId,
        expenseId: target.payload.expenseId,
        supersedesEventId: target.id,
        payload: {
          description: expense.description,
          currency: current.currency,
          amount: expense.amount,
          payerId: expense.payerId,
          splits: expense.splits.map(({ personId, amount }) => ({ participantId: personId, amount }))
        }
      });
      assertValidEvent(event);
      handle.change((document) => appendStoredEvent(document, event));
      return event;
    },
    voidExpense(input) {
      const { eventId, reason } = input || {};
      if (typeof reason !== "string" || !reason.trim() || [...reason.trim()].length > 500) {
        throw new Error("Enter a void reason of 1 to 500 characters.");
      }
      const current = snapshotGroup(handle.doc());
      assertWritable(current);
      const target = currentExpenseForChange(current, eventId);
      const event = expenseChangeEnvelope({ type: "expense-voided", groupId: current.groupId,
        expenseId: target.payload.expenseId, supersedesEventId: target.id, reason: reason.trim() });
      assertValidEvent(event);
      handle.change((document) => appendStoredEvent(document, event));
      return event;
    },
    resolveExpenseConflict(input) {
      const current = snapshotGroup(handle.doc());
      assertWritable(current);
      const { expenseId, chosenEventId } = input;
      const review = currentConflictChoice(current, input);
      const event = conflictResolutionEnvelope({ groupId: current.groupId, expenseId,
        resolvesEventIds: review.branchIds, chosenEventId, supersedesResolutionEventIds: review.resolutionIds });
      assertValidEvent(event);
      handle.change((document) => appendStoredEvent(document, event));
      return event;
    },
    recordSettlement(input) {
      const { fromParticipantId, toParticipantId, amount } = input || {};
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter a settlement amount greater than zero.");
      const current = snapshotGroup(handle.doc());
      assertWritable(current);
      const peopleIds = new Set(current.people.map(({ id }) => id));
      if (!peopleIds.has(fromParticipantId) || !peopleIds.has(toParticipantId) || fromParticipantId === toParticipantId) {
        throw new Error("Choose two different people in this group.");
      }
      const event = settlementEnvelope({
        type: "settlement-recorded",
        groupId: current.groupId,
        payload: {
          settlementId: crypto.randomUUID(),
          currency: current.currency,
          fromParticipantId,
          toParticipantId,
          amount
        }
      });
      assertValidEvent(event);
      handle.change((document) => appendStoredEvent(document, event));
      return event;
    },
    reverseSettlement(input) {
      const { eventId, reason } = input || {};
      if (typeof reason !== "string" || !reason.trim() || [...reason.trim()].length > 500) {
        throw new Error("Enter a reversal reason of 1 to 500 characters.");
      }
      const current = snapshotGroup(handle.doc());
      assertWritable(current);
      const projection = projectGroup(current);
      const target = projection.effective.find((event) => event.id === eventId && event.type === "settlement-recorded");
      const reversedIds = new Set(projection.effective.filter((event) => event.type === "settlement-reversed").map(({ payload }) => payload.settlementId));
      if (!target || reversedIds.has(target.payload.settlementId)) throw new Error("This settlement is no longer active.");
      const event = settlementEnvelope({
        type: "settlement-reversed",
        groupId: current.groupId,
        dependsOn: [target.id],
        payload: { settlementId: target.payload.settlementId, reversesEventId: target.id, reason: reason.trim() }
      });
      assertValidEvent(event);
      handle.change((document) => appendStoredEvent(document, event));
      return event;
    },
    importBackup(input) {
      const prepared = prepareBackupMerge(snapshotGroup(handle.doc()), input);
      if (!prepared.changes) return false;
      handle.change((document) => {
        const current = prepareBackupMerge(snapshotGroup(document), input);
        if (current.name !== document.name) document.name = current.name;
        if (current.currency !== document.currency) document.currency = current.currency;
        if (current.groupId && current.groupId !== document.groupId) document.groupId = current.groupId;
        for (const person of current.people) document.people.push(person);
        for (const event of current.events) appendStoredEvent(document, event);
      });
      return true;
    },
  };
  return controller;
}
