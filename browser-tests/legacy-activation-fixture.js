import { Repo } from "@automerge/automerge-repo";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { change, clone, getConflicts, ImmutableString, load, merge, save } from "@automerge/automerge";

export async function installLegacyGroup(source) {
  const repo = new Repo({ storage: new IndexedDBStorageAdapter(), network: [] });
  try {
    const handle = repo.create(source);
    await repo.flush([handle.documentId]);
    const documentId = handle.documentId;
    localStorage.setItem("div-it-groups", JSON.stringify({ version: 1, activeDocumentId: documentId,
      groups: [{ documentId, name: source.name }] }));
    return documentId;
  } finally { await repo.shutdown(); }
}

export async function readGroup(documentId) {
  const repo = new Repo({ storage: new IndexedDBStorageAdapter(), network: [] });
  try {
    const handle = await repo.find(documentId);
    return JSON.parse(JSON.stringify(handle.doc()));
  } finally { await repo.shutdown(); }
}

export async function mutateGroup(documentId, mutate) {
  const repo = new Repo({ storage: new IndexedDBStorageAdapter(), network: [new BroadcastChannelNetworkAdapter()] });
  try {
    const handle = await repo.find(documentId);
    handle.change(mutate);
    await repo.flush([documentId]);
  } finally { await repo.shutdown(); }
}

export async function installLegacyConflictGroup(source, leftEvent, rightEvent) {
  const repo = new Repo({ storage: new IndexedDBStorageAdapter(), network: [] });
  try {
    const handle = repo.create(source);
    await repo.flush([handle.documentId]);
    const documentId = handle.documentId;
    const base = load(await repo.export(documentId));
    const left = change(clone(base, "aa"), (document) => {
      document.eventsById["conflicted-expense:variant"] = new ImmutableString(JSON.stringify(leftEvent));
    });
    const right = change(clone(base, "bb"), (document) => {
      document.eventsById["conflicted-expense:variant"] = new ImmutableString(JSON.stringify(rightEvent));
    });
    const merged = merge(left, right);
    const variants = getConflicts(merged.eventsById, "conflicted-expense:variant");
    if (!variants || Object.keys(variants).length !== 2) throw new Error("fixture did not create two hidden event variants");
    repo.import(save(merged), { docId: documentId });
    await repo.flush([documentId]);
    localStorage.setItem("div-it-groups", JSON.stringify({ version: 1, activeDocumentId: documentId,
      groups: [{ documentId, name: source.name }] }));
    return documentId;
  } finally { await repo.shutdown(); }
}
