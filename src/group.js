import { Repo } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { legacyGroup } from "./legacy.js";
import { makeExpense } from "./ledger.js";
import { parseEvent } from "./events.js";
import { conflictResolutionEnvelope, expenseChangeEnvelope, expenseConflictReviews, expenseEnvelope, groupIdFromDocumentId, projectGroup, settlementEnvelope } from "./prototype-events.js";

const GROUP_ID_KEY = "div-it-group-id";
const emptyGroup = () => ({ name: "My group", currency: "USD", people: [], events: [] });
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

function assertWritable(group) {
  if (group.groupIdentityIssue) throw new Error("This group's ledger identity is ambiguous. Import a valid backup before editing.");
  if (projectGroup(group).readOnly) throw new Error("This group has unsupported ledger entries and is read-only until the app is updated.");
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

  const snapshot = handle.doc();
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
  const publish = (doc) => onSnapshot(structuredClone(doc));
  handle.on("change", ({ doc }) => publish(doc));
  publish(handle.doc());

  controller = {
    saveSettings(input) {
      const settings = validateGroupSettings(input);
      assertWritable(handle.doc());
      if (settings.currency !== handle.doc().currency && handle.doc().events.length) {
        throw new Error("A group's currency can't change after ledger entries are recorded.");
      }
      handle.change((document) => Object.assign(document, settings));
    },
    addPerson(input) {
      assertWritable(handle.doc());
      const name = validatePersonName(input);
      const person = { id: crypto.randomUUID(), name };
      handle.change((document) => document.people.push(person));
      return person;
    },
    addExpense(input) {
      assertWritable(handle.doc());
      const expense = makeExpense(input);
      const snapshot = handle.doc();
      const peopleIds = new Set(snapshot.people.map(({ id }) => id));
      if (!peopleIds.has(expense.payerId) || expense.splits.some(({ personId }) => !peopleIds.has(personId))) {
        throw new Error("Choose people in this group for the payer and split.");
      }
      const event = expenseEnvelope(expense, { groupId: snapshot.groupId || groupId, currency: snapshot.currency });
      assertValidEvent(event);
      handle.change((document) => document.events.push(event));
      return event;
    },
    reviseExpense(input) {
      const { eventId, description, amount, payerId, splits } = input || {};
      const current = handle.doc();
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
      handle.change((document) => document.events.push(event));
      return event;
    },
    voidExpense(input) {
      const { eventId, reason } = input || {};
      if (typeof reason !== "string" || !reason.trim() || [...reason.trim()].length > 500) {
        throw new Error("Enter a void reason of 1 to 500 characters.");
      }
      const current = handle.doc();
      assertWritable(current);
      const target = currentExpenseForChange(current, eventId);
      const event = expenseChangeEnvelope({ type: "expense-voided", groupId: current.groupId,
        expenseId: target.payload.expenseId, supersedesEventId: target.id, reason: reason.trim() });
      assertValidEvent(event);
      handle.change((document) => document.events.push(event));
      return event;
    },
    resolveExpenseConflict(input) {
      const current = handle.doc();
      assertWritable(current);
      const { expenseId, chosenEventId } = input;
      const review = currentConflictChoice(current, input);
      const event = conflictResolutionEnvelope({ groupId: current.groupId, expenseId,
        resolvesEventIds: review.branchIds, chosenEventId, supersedesResolutionEventIds: review.resolutionIds });
      assertValidEvent(event);
      handle.change((document) => document.events.push(event));
      return event;
    },
    recordSettlement(input) {
      const { fromParticipantId, toParticipantId, amount } = input || {};
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Enter a settlement amount greater than zero.");
      const current = handle.doc();
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
      handle.change((document) => document.events.push(event));
      return event;
    },
    reverseSettlement(input) {
      const { eventId, reason } = input || {};
      if (typeof reason !== "string" || !reason.trim() || [...reason.trim()].length > 500) {
        throw new Error("Enter a reversal reason of 1 to 500 characters.");
      }
      const current = handle.doc();
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
      handle.change((document) => document.events.push(event));
      return event;
    },
    importBackup(input) {
      const group = validateBackup(input);
      handle.change((document) => {
        if (group.groupId) document.groupId = group.groupId;
        document.groupIdentityIssue = false;
        document.name = group.name;
        document.currency = group.currency;
        document.people = group.people;
        document.events = group.events;
      });
    },
  };
  return controller;
}
