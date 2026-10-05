import { Repo } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { legacyGroup } from "./legacy.js";
import { makeExpense } from "./ledger.js";

const GROUP_ID_KEY = "div-it-group-id";
const emptyGroup = () => ({ name: "My group", currency: "USD", people: [], events: [] });
const currencies = new Set(["USD", "INR", "EUR", "GBP"]);

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

export function validateBackup(group) {
  if (!group || typeof group !== "object" || Array.isArray(group)
    || typeof group.name !== "string" || typeof group.currency !== "string"
    || !Array.isArray(group.people) || !Array.isArray(group.events)) {
    throw new Error("Not a Div It backup.");
  }
  return structuredClone({ name: group.name, currency: group.currency, people: group.people, events: group.events });
}

export async function openGroup(onSnapshot) {
  if (controller) return controller;

  const repo = new Repo({
    storage: new IndexedDBStorageAdapter(),
    network: [new BroadcastChannelNetworkAdapter()],
  });
  const documentId = localStorage.getItem(GROUP_ID_KEY);
  const handle = documentId ? await repo.find(documentId) : repo.create((await legacyGroup()) || emptyGroup());

  if (!documentId) localStorage.setItem(GROUP_ID_KEY, handle.documentId);
  const publish = (doc) => onSnapshot(structuredClone(doc));
  handle.on("change", ({ doc }) => publish(doc));
  publish(handle.doc());

  controller = {
    saveSettings(input) {
      const settings = validateGroupSettings(input);
      handle.change((document) => Object.assign(document, settings));
    },
    addPerson(input) {
      const name = validatePersonName(input);
      const person = { id: crypto.randomUUID(), name };
      handle.change((document) => document.people.push(person));
      return person;
    },
    addExpense(input) {
      const expense = makeExpense(input);
      const snapshot = handle.doc();
      const peopleIds = new Set(snapshot.people.map(({ id }) => id));
      if (!peopleIds.has(expense.payerId) || expense.splits.some(({ personId }) => !peopleIds.has(personId))) {
        throw new Error("Choose people in this group for the payer and split.");
      }
      handle.change((document) => document.events.push(expense));
      return expense;
    },
    importBackup(input) {
      const group = validateBackup(input);
      handle.change((document) => {
        document.name = group.name;
        document.currency = group.currency;
        document.people = group.people;
        document.events = group.events;
      });
    },
  };
  return controller;
}
