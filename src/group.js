import { Repo } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { legacyGroup } from "./legacy.js";

const GROUP_ID_KEY = "div-it-group-id";

const emptyGroup = () => ({ name: "My group", currency: "USD", people: [], events: [] });

let controller;

export async function openGroup(onChange) {
  if (controller) return controller;

  const repo = new Repo({
    storage: new IndexedDBStorageAdapter(),
    network: [new BroadcastChannelNetworkAdapter()],
  });
  const documentId = localStorage.getItem(GROUP_ID_KEY);
  const handle = documentId ? await repo.find(documentId) : repo.create((await legacyGroup()) || emptyGroup());

  if (!documentId) localStorage.setItem(GROUP_ID_KEY, handle.documentId);
  handle.on("change", ({ doc }) => onChange(doc));
  onChange(handle.doc());

  controller = {
    change(mutator) {
      handle.change(mutator);
    },
    replace(group) {
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
