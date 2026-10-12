import { Repo } from "@automerge/automerge-repo";
import { BroadcastChannelNetworkAdapter } from "@automerge/automerge-repo-network-broadcastchannel";
import { IndexedDBStorageAdapter } from "@automerge/automerge-repo-storage-indexeddb";
import { legacyGroup } from "./legacy.js";
import { canonicalEventContent, makeExpense } from "./ledger.js";
import { parseEvent } from "./events.js";
import { PROTOTYPE_AUTHOR, PROTOTYPE_SIGNATURE, conflictResolutionEnvelope, expenseChangeEnvelope, expenseConflictReviews, expenseEnvelope, groupIdFromDocumentId, normalizeExpenseForProjection, projectGroup, settlementEnvelope } from "./prototype-events.js";
import { appendStoredEvent, eventsFromDocument, migrateEventStore, needsEventStoreMigration } from "./event-store.js";
import { appendStoredRecord, recordsFromDocument } from "./event-store.js";
import { createGroupGenesis } from "./group-genesis.js";
import { getOrCreateDeviceIdentity } from "./device-identity-store.js";
import { createParticipantAddCommand } from "./membership-roster-commands.js";
import { projectSignedMembership } from "./signed-membership-projector.js";
import { projectAuthenticatedLedger } from "./authenticated-ledger.js";
import { createSignedLedgerRecord } from "./signed-ledger-records.js";
import { legacyAttestationsFromDocument } from "./legacy-opening-balances.js";

const GROUP_ID_KEY = "div-it-group-id";
const GROUP_REGISTRY_KEY = "div-it-groups";
const TRUST_PINS_KEY = "div-it-signed-group-trust-pins";
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

function snapshotGroup(document, documentId) {
  const snapshot = JSON.parse(JSON.stringify(document));
  snapshot.events = eventsFromDocument(document);
  snapshot.unsupportedSignedGroupVersion = document.signedGroupVersion !== undefined && document.signedGroupVersion !== 1;
  snapshot.signedMode = document.signedGroupVersion !== undefined || Boolean(localTrustPin(documentId))
    || Object.hasOwn(document, "membershipRecordsById") || Object.hasOwn(document, "ledgerRecordsById")
    || Object.hasOwn(document, "legacyAttestationsById") || Object.hasOwn(document, "membershipRecords") || Object.hasOwn(document, "ledgerRecords");
  if (snapshot.signedMode) {
    snapshot.membershipRecords = recordsFromDocument(document, "membershipRecordsById");
    snapshot.ledgerRecords = recordsFromDocument(document, "ledgerRecordsById");
    snapshot.legacyAttestations = recordsFromDocument(document, "legacyAttestationsById");
  }
  delete snapshot.eventsById;
  delete snapshot.membershipRecordsById;
  delete snapshot.ledgerRecordsById;
  delete snapshot.legacyAttestationsById;
  delete snapshot.eventStoreFormatVersion;
  return snapshot;
}

function trustPins() {
  try {
    const value = JSON.parse(localStorage.getItem(TRUST_PINS_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function localTrustPin(documentId) {
  const pin = trustPins()[documentId];
  return pin && typeof pin.genesisId === "string" && typeof pin.publicKeyFingerprint === "string" ? pin : null;
}

function storeLocalTrustPin(documentId, trustPin) {
  const pins = trustPins();
  pins[documentId] = trustPin;
  localStorage.setItem(TRUST_PINS_KEY, JSON.stringify(pins));
}

function removeLocalTrustPin(documentId) {
  const pins = trustPins();
  delete pins[documentId];
  localStorage.setItem(TRUST_PINS_KEY, JSON.stringify(pins));
}

function sortedRecords(records) {
  return records.map((record) => JSON.stringify(record)).sort();
}

function sameRecords(left, right) {
  return JSON.stringify(sortedRecords(left)) === JSON.stringify(sortedRecords(right));
}

function signedBlockedProjection() {
  return { balances: {}, effective: [], pending: [], conflicting: [], quarantined: [], unsupported: [], ignored: [], duplicates: [], readOnly: true };
}

function assertValidEvent(event) {
  const parsed = parseEvent(event);
  if (!parsed.ok) throw new Error(`Invalid ledger entry: ${parsed.reason}.`);
}

function currentExpenseForChange(group, eventId, projection = projectGroup(group)) {
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

  const testReplica = import.meta.env.DEV && new URLSearchParams(location.search).has("testReplica");
  const repo = new Repo({
    storage: testReplica ? undefined : new IndexedDBStorageAdapter(),
    network: [new BroadcastChannelNetworkAdapter()],
  });
  if (import.meta.env.DEV && new URLSearchParams(location.search).has("testSync")) {
    window.__divItTestSync = {
      disconnect: () => repo.networkSubsystem.disconnect(),
      exportBinary: async () => Array.from(await repo.export(handle.documentId)),
      reconnect: () => {
        for (const adapter of [...repo.networkSubsystem.adapters]) {
          repo.networkSubsystem.removeNetworkAdapter(adapter);
        }
        repo.networkSubsystem.addNetworkAdapter(new BroadcastChannelNetworkAdapter());
      }
    };
  }
  const validRegistry = (value) => value && value.version === 1 && Array.isArray(value.groups)
    && value.groups.every((item) => item && typeof item.documentId === "string" && typeof item.name === "string");
  let registry;
  try {
    const stored = JSON.parse(localStorage.getItem(GROUP_REGISTRY_KEY) || "null");
    if (validRegistry(stored)) registry = stored;
  } catch { /* Rebuild from the prior single-group key below. */ }
  let activeId = registry?.groups.some(({ documentId }) => documentId === registry.activeDocumentId)
    ? registry.activeDocumentId : null;
  let handle;
  if (activeId) {
    if (testReplica) {
      const binary = sessionStorage.getItem("div-it-test-replica");
      if (binary) repo.import(Uint8Array.from(JSON.parse(binary)), { docId: activeId });
    }
    handle = await repo.find(activeId);
  } else {
    const legacyDocumentId = localStorage.getItem(GROUP_ID_KEY);
    handle = legacyDocumentId ? await repo.find(legacyDocumentId) : repo.create((await legacyGroup()) || emptyGroup());
    activeId = handle.documentId;
    registry = { version: 1, activeDocumentId: activeId, groups: [{ documentId: activeId, name: handle.doc().name || "My group" }] };
    if (!legacyDocumentId) localStorage.setItem(GROUP_ID_KEY, activeId);
    localStorage.setItem(GROUP_REGISTRY_KEY, JSON.stringify(registry));
  }
  await repo.flush([handle.documentId]);
  if (!registry.groups.some(({ documentId }) => documentId === activeId)) {
    registry.groups.push({ documentId: activeId, name: handle.doc().name || "My group" });
  }
  registry.activeDocumentId = activeId;
  let generation = 0;
  let activeListener;
  let groupId;
  let projectionRevision = 0;
  const persistRegistry = () => localStorage.setItem(GROUP_REGISTRY_KEY, JSON.stringify(registry));
  const projectSnapshot = async (doc, documentId) => {
    const snapshot = snapshotGroup(doc, documentId);
    if (!snapshot.signedMode) return snapshot;
    if (snapshot.unsupportedSignedGroupVersion) {
      return { ...snapshot, groupIdentityIssue: true, authenticatedProjection: signedBlockedProjection(), people: [], events: [] };
    }
    const trustPin = localTrustPin(documentId);
    if (!trustPin) return { ...snapshot, groupIdentityIssue: true, authenticatedProjection: signedBlockedProjection(), people: [], events: [] };
    const legacyAttestations = legacyAttestationsFromDocument(doc);
    const ledger = await projectAuthenticatedLedger(snapshot.ledgerRecords, { membershipRecords: snapshot.membershipRecords, trustPin, legacyAttestations });
    const membership = await projectSignedMembership(snapshot.membershipRecords, { trustPin,
      verifiedCausalContexts: ledger.verifiedCausalContexts || [] });
    if (!membership.groupId) {
      return { ...snapshot, groupIdentityIssue: true, authenticatedProjection: signedBlockedProjection(), people: [], events: [] };
    }
    const eventViews = ledger.authenticatedEvents || [];
    return {
      ...snapshot,
      name: membership.groupName,
      currency: membership.currency,
      groupId: membership.groupId,
      groupIdentityIssue: false,
      people: membership.participants,
      events: eventViews,
      authenticatedProjection: { ...ledger, readOnly: ledger.readOnly || membership.readOnly }
    };
  };
  const publish = (doc, token) => {
    if (token !== generation || !handle) return;
    const activeDocumentId = handle.documentId;
    const revision = ++projectionRevision;
    void projectSnapshot(doc, activeDocumentId).then((snapshot) => {
      if (token !== generation || revision !== projectionRevision || !handle || handle.documentId !== activeDocumentId) return;
      const entry = registry.groups.find(({ documentId }) => documentId === activeDocumentId);
      if (entry && entry.name !== snapshot.name) {
        entry.name = snapshot.name;
        persistRegistry();
      }
      onSnapshot(snapshot, { activeDocumentId, groups: registry.groups.map((item) => ({ ...item })) });
    }).catch(() => {
      if (token !== generation || revision !== projectionRevision || !handle || handle.documentId !== activeDocumentId) return;
      const snapshot = snapshotGroup(doc, activeDocumentId);
      if (snapshot.signedMode) Object.assign(snapshot, { groupIdentityIssue: true, authenticatedProjection: signedBlockedProjection(), people: [], events: [] });
      onSnapshot(snapshot, { activeDocumentId, groups: registry.groups.map((item) => ({ ...item })) });
    });
  };
  const detach = () => {
    if (handle && activeListener) handle.off("change", activeListener);
    activeListener = undefined;
  };
  const activate = async (nextHandle, token, persist = true) => {
    if (token !== generation) return false;
    detach();
    handle = nextHandle;
    let changed = false;
    if (needsEventStoreMigration(handle.doc())) {
      handle.change((document) => migrateEventStore(document));
      changed = true;
    }
    const snapshot = snapshotGroup(handle.doc(), handle.documentId);
    if (snapshot.signedMode) {
      groupId = groupIdFromDocumentId(handle.documentId);
    } else {
    const eventGroups = inspectGroupIds(snapshot.events);
    const storedGroupId = UUID.test(snapshot.groupId || "") ? snapshot.groupId : undefined;
    const groupIdentityIssue = snapshot.groupId !== undefined && !storedGroupId
      || eventGroups.ambiguous
      || !storedGroupId && eventGroups.invalid;
    groupId = storedGroupId || (!eventGroups.ambiguous && !eventGroups.invalid && eventGroups.id)
      || groupIdFromDocumentId(handle.documentId);
    if (!storedGroupId || snapshot.groupIdentityIssue !== groupIdentityIssue) {
      handle.change((document) => {
        document.groupId = groupId;
        document.groupIdentityIssue = groupIdentityIssue;
      });
      changed = true;
    }
    }
    registry.activeDocumentId = handle.documentId;
    if (!registry.groups.some(({ documentId }) => documentId === handle.documentId)) {
      registry.groups.push({ documentId: handle.documentId, name: handle.doc().name || "My group" });
    }
    if (persist) persistRegistry();
    if (changed) await repo.flush([handle.documentId]);
    if (token !== generation) return false;
    const subscribedToken = token;
    activeListener = ({ doc }) => publish(doc, subscribedToken);
    handle.on("change", activeListener);
    publish(handle.doc(), token);
    return true;
  };

  const initialToken = ++generation;
  await activate(handle, initialToken);

  async function signedWriteContext() {
    const documentId = handle.documentId;
    const token = generation;
    const document = handle.doc();
    const current = snapshotGroup(document, documentId);
    if (!current.signedMode) throw new Error("This is a legacy group; signed commands are unavailable until migration.");
    if (current.unsupportedSignedGroupVersion) throw new Error("This signed group version is not supported for writing.");
    const trustPin = localTrustPin(documentId);
    if (!trustPin) throw new Error("This signed group has no local trust pin and is read-only in this browser.");
    const membershipRecords = current.membershipRecords;
    const ledgerRecords = current.ledgerRecords;
    const legacyAttestations = legacyAttestationsFromDocument(document);
    const authenticated = await projectAuthenticatedLedger(ledgerRecords, { membershipRecords, trustPin, legacyAttestations });
    const verifiedCausalContexts = authenticated.verifiedCausalContexts || [];
    const membership = await projectSignedMembership(membershipRecords, { trustPin, verifiedCausalContexts });
    if (!membership.groupId || membership.readOnly || authenticated.readOnly) throw new Error("This signed group is not writable.");
    if (authenticated.groupId !== membership.groupId) throw new Error("Signed ledger group does not match trusted membership.");
    if (!authenticated.causalFrontier?.ok) throw new Error("The authenticated ledger frontier is incomplete; wait for missing records or checkpoints.");
    const identityKeys = await getOrCreateDeviceIdentity();
    const enrollment = membership.devices.find((device) => device.deviceId === identityKeys.deviceId && device.keyId === identityKeys.keyId);
    if (!enrollment) throw new Error("This device is not enrolled in the signed group.");
    return {
      documentId, token, groupId: membership.groupId, signedGroupVersion: document.signedGroupVersion,
      trustPin, identity: { ...identityKeys, participantId: enrollment.participantId },
      membership, ledger: authenticated, membershipRecords, ledgerRecords, legacyAttestations, legacyAttestationRecords: current.legacyAttestations,
      causalHeads: [...authenticated.causalFrontier.heads]
    };
  }

  function assertPreparedWriteCurrent(state) {
    if (state.token !== generation || !handle || handle.documentId !== state.documentId) {
      throw new Error("The active group changed while the command was being prepared. Try again.");
    }
    const currentPin = localTrustPin(state.documentId);
    if (!currentPin || currentPin.genesisId !== state.trustPin.genesisId
        || currentPin.publicKeyFingerprint !== state.trustPin.publicKeyFingerprint) {
      throw new Error("The local trust pin changed while the command was being prepared. Try again.");
    }
    const current = snapshotGroup(handle.doc(), handle.documentId);
    if (!current.signedMode || current.unsupportedSignedGroupVersion || current.signedGroupVersion !== state.signedGroupVersion
        || !sameRecords(current.membershipRecords, state.membershipRecords)
        || !sameRecords(current.ledgerRecords, state.ledgerRecords)
        || !sameRecords(current.legacyAttestations, state.legacyAttestationRecords)) {
      throw new Error("The signed group changed while the command was being prepared. Review the current heads and try again.");
    }
  }

  async function createSignedRecord(state, event) {
    const record = await createSignedLedgerRecord({
      id: event.id, type: event.type, groupId: state.groupId,
      author: { participantId: state.identity.participantId, deviceId: state.identity.deviceId, keyId: state.identity.keyId },
      createdAt: event.createdAt, membershipHeads: [...state.membership.heads].sort(),
      causalHeads: [...state.causalHeads].sort(), dependsOn: [...(event.dependsOn || [])].sort(), payload: event.payload
    }, state.identity.privateKey);
    const verified = await projectAuthenticatedLedger([...state.ledgerRecords, record], {
      membershipRecords: state.membershipRecords, trustPin: state.trustPin, legacyAttestations: state.legacyAttestations
    });
    const idOf = (item) => item?.id || item?.event?.id;
    const blocked = [...verified.pending, ...verified.quarantined, ...verified.unsupported].some((item) => idOf(item) === record.id);
    const included = [...verified.effective, ...verified.conflicting].some((item) => item.id === record.id);
    if (verified.readOnly || blocked || !included) throw new Error("The signed ledger rejected this command; no changes were saved.");
    assertPreparedWriteCurrent(state);
    handle.change((document) => appendStoredRecord(document, "ledgerRecordsById", record));
    await repo.flush([state.documentId]);
    return record;
  }

  async function createSignedRoster(state, name) {
    const record = await createParticipantAddCommand({ groupId: state.groupId, participantId: crypto.randomUUID(), name,
      membershipHeads: state.membership.heads, identity: state.identity, records: state.membershipRecords, trustPin: state.trustPin,
      verifiedCausalContexts: state.ledger.verifiedCausalContexts || [] });
    assertPreparedWriteCurrent(state);
    handle.change((document) => appendStoredRecord(document, "membershipRecordsById", record));
    await repo.flush([state.documentId]);
    return state.membership.participants.find((person) => person.id === record.payload.participantId)
      || { id: record.payload.participantId, name: record.payload.name };
  }

  controller = {
    getGroups() {
      return registry.groups.map((item) => ({ ...item }));
    },
    getActiveDocumentId() {
      return handle.documentId;
    },
    async switchGroup(documentId) {
      if (!registry.groups.some((item) => item.documentId === documentId)) throw new Error("Choose a group in this browser.");
      if (registry.activeDocumentId === documentId && activeListener) return true;
      const previousHandle = handle;
      const previousId = registry.activeDocumentId;
      const token = ++generation;
      detach();
      registry.activeDocumentId = documentId;
      persistRegistry();
      let nextHandle;
      try {
        nextHandle = await repo.find(documentId);
      } catch (cause) {
        if (token === generation) {
          registry.activeDocumentId = previousId;
          persistRegistry();
          await activate(previousHandle, token);
        }
        throw cause;
      }
      if (token !== generation) return false;
      return activate(nextHandle, token);
    },
    async createGroup(input) {
      const settings = validateGroupSettings(input || {});
      const ownerName = validatePersonName(input?.ownerName);
      const genesis = await createGroupGenesis({ ...settings, ownerName });
      const newHandle = repo.create({ ...emptyGroup(), ...settings, groupId: genesis.record.groupId, signedGroupVersion: 1,
        membershipRecordsById: {}, ledgerRecordsById: {}, legacyAttestationsById: {} });
      newHandle.change((document) => appendStoredRecord(document, "membershipRecordsById", genesis.record));
      await repo.flush([newHandle.documentId]);
      const nextRegistry = structuredClone(registry);
      nextRegistry.groups.push({ documentId: newHandle.documentId, name: settings.name });
      nextRegistry.activeDocumentId = newHandle.documentId;
      try {
        storeLocalTrustPin(newHandle.documentId, genesis.trustPin);
        localStorage.setItem(GROUP_REGISTRY_KEY, JSON.stringify(nextRegistry));
      } catch (cause) {
        try { removeLocalTrustPin(newHandle.documentId); } catch { /* Keep the prior group active if storage is unavailable. */ }
        throw cause;
      }
      registry = nextRegistry;
      const token = ++generation;
      await activate(newHandle, token, false);
      return newHandle.documentId;
    },
    saveSettings(input) {
      const settings = validateGroupSettings(input);
      const current = snapshotGroup(handle.doc(), handle.documentId);
      if (current.signedMode) throw new Error("A signed group's name and currency are fixed by its trusted genesis.");
      assertWritable(current);
      if (settings.currency !== current.currency && current.events.length) {
        throw new Error("A group's currency can't change after ledger entries are recorded.");
      }
      handle.change((document) => Object.assign(document, settings));
    },
    addPerson(input) {
      const name = validatePersonName(input);
      const snapshot = snapshotGroup(handle.doc(), handle.documentId);
      if (snapshot.signedMode) return (async () => createSignedRoster(await signedWriteContext(), name))();
      assertWritable(snapshot);
      const person = { id: crypto.randomUUID(), name };
      handle.change((document) => document.people.push(person));
      return person;
    },
    addExpense(input) {
      const current = snapshotGroup(handle.doc(), handle.documentId);
      const expense = makeExpense(input);
      if (current.signedMode) return (async () => {
        const state = await signedWriteContext();
        const peopleIds = new Set(state.membership.participants.map(({ id }) => id));
        if (!peopleIds.has(expense.payerId) || expense.splits.some(({ personId }) => !peopleIds.has(personId))) {
          throw new Error("Choose people in this group for the payer and split.");
        }
        const event = expenseEnvelope(expense, { groupId: state.groupId, currency: state.membership.currency });
        assertValidEvent(event);
        return createSignedRecord(state, event);
      })();
      assertWritable(current);
      const peopleIds = new Set(current.people.map(({ id }) => id));
      if (!peopleIds.has(expense.payerId) || expense.splits.some(({ personId }) => !peopleIds.has(personId))) {
        throw new Error("Choose people in this group for the payer and split.");
      }
      const event = expenseEnvelope(expense, { groupId: current.groupId || groupId, currency: current.currency });
      assertValidEvent(event);
      handle.change((document) => appendStoredEvent(document, event));
      return event;
    },
    reviseExpense(input) {
      const { eventId, description, amount, payerId, splits } = input || {};
      const current = snapshotGroup(handle.doc(), handle.documentId);
      if (current.signedMode) return (async () => {
        const state = await signedWriteContext();
        const target = currentExpenseForChange(current, eventId, state.ledger);
        if (target.payload.currency !== state.membership.currency) throw new Error("This expense uses a different group currency.");
        const expense = makeExpense({ id: crypto.randomUUID(), description, amount, payerId, splits });
        const peopleIds = new Set(state.membership.participants.map(({ id }) => id));
        if (!peopleIds.has(expense.payerId) || expense.splits.some(({ personId }) => !peopleIds.has(personId))) {
          throw new Error("Choose people in this group for the payer and split.");
        }
        const event = expenseChangeEnvelope({ type: "expense-revised", groupId: state.groupId,
          expenseId: target.payload.expenseId, supersedesEventId: target.id,
          payload: { description: expense.description, currency: state.membership.currency, amount: expense.amount,
            payerId: expense.payerId, splits: expense.splits.map(({ personId, amount }) => ({ participantId: personId, amount })) } });
        assertValidEvent(event);
        return createSignedRecord(state, event);
      })();
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
      const current = snapshotGroup(handle.doc(), handle.documentId);
      if (current.signedMode) return (async () => {
        const state = await signedWriteContext();
        const target = currentExpenseForChange(current, eventId, state.ledger);
        const event = expenseChangeEnvelope({ type: "expense-voided", groupId: state.groupId,
          expenseId: target.payload.expenseId, supersedesEventId: target.id, reason: reason.trim() });
        assertValidEvent(event);
        return createSignedRecord(state, event);
      })();
      assertWritable(current);
      const target = currentExpenseForChange(current, eventId);
      const event = expenseChangeEnvelope({ type: "expense-voided", groupId: current.groupId,
        expenseId: target.payload.expenseId, supersedesEventId: target.id, reason: reason.trim() });
      assertValidEvent(event);
      handle.change((document) => appendStoredEvent(document, event));
      return event;
    },
    resolveExpenseConflict(input) {
      const current = snapshotGroup(handle.doc(), handle.documentId);
      if (current.signedMode) return (async () => {
        const state = await signedWriteContext();
        const known = new Set((state.ledger.authenticatedEvents || []).map(({ id }) => id));
        const authenticatedGroup = { ...current, groupId: state.groupId, currency: state.membership.currency,
          people: state.membership.participants, events: state.ledger.authenticatedEvents || [] };
        const { expenseId, chosenEventId } = input;
        const review = currentConflictChoice(authenticatedGroup, input);
        if (!review.branchIds.every((id) => known.has(id))) throw new Error("This conflict contains unauthenticated branches.");
        const event = conflictResolutionEnvelope({ groupId: state.groupId, expenseId,
          resolvesEventIds: review.branchIds, chosenEventId, supersedesResolutionEventIds: review.resolutionIds });
        assertValidEvent(event);
        return createSignedRecord(state, event);
      })();
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
      const current = snapshotGroup(handle.doc(), handle.documentId);
      if (current.signedMode) return (async () => {
        const state = await signedWriteContext();
        const peopleIds = new Set(state.membership.participants.map(({ id }) => id));
        if (!peopleIds.has(fromParticipantId) || !peopleIds.has(toParticipantId) || fromParticipantId === toParticipantId) {
          throw new Error("Choose two different people in this group.");
        }
        const event = settlementEnvelope({ type: "settlement-recorded", groupId: state.groupId,
          payload: { settlementId: crypto.randomUUID(), currency: state.membership.currency, fromParticipantId, toParticipantId, amount } });
        assertValidEvent(event);
        return createSignedRecord(state, event);
      })();
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
    recordOpeningBalances(input) {
      const current = snapshotGroup(handle.doc(), handle.documentId);
      if (!current.signedMode) throw new Error("Opening balance imports require a signed group.");
      return (async () => {
        const state = await signedWriteContext();
        const event = { id: crypto.randomUUID(), type: "opening-balances-imported", schemaVersion: 1, protocolVersion: 1,
          groupId: state.groupId, author: { ...PROTOTYPE_AUTHOR }, createdAt: new Date().toISOString(), dependsOn: [],
          payload: structuredClone(input || {}), signature: PROTOTYPE_SIGNATURE };
        assertValidEvent(event);
        return createSignedRecord(state, event);
      })();
    },
    reverseSettlement(input) {
      const { eventId, reason } = input || {};
      if (typeof reason !== "string" || !reason.trim() || [...reason.trim()].length > 500) {
        throw new Error("Enter a reversal reason of 1 to 500 characters.");
      }
      const current = snapshotGroup(handle.doc());
      if (current.signedMode) return (async () => {
        const state = await signedWriteContext();
        const target = state.ledger.effective.find((event) => event.id === eventId && event.type === "settlement-recorded");
        const reversedIds = new Set(state.ledger.effective.filter((event) => event.type === "settlement-reversed").map(({ payload }) => payload.settlementId));
        if (!target || reversedIds.has(target.payload.settlementId)) throw new Error("This settlement is no longer active.");
        const event = settlementEnvelope({ type: "settlement-reversed", groupId: state.groupId, dependsOn: [target.id],
          payload: { settlementId: target.payload.settlementId, reversesEventId: target.id, reason: reason.trim() } });
        assertValidEvent(event);
        return createSignedRecord(state, event);
      })();
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
      const currentSnapshot = snapshotGroup(handle.doc(), handle.documentId);
      if (currentSnapshot.signedMode || input?.format === "div-it-signed-group-backup-v1"
          || Array.isArray(input?.membershipRecords) || Array.isArray(input?.ledgerRecords) || Array.isArray(input?.legacyAttestations)
          || Object.hasOwn(input || {}, "legacyAttestationsById")) {
        throw new Error("Signed group backup restore is not supported yet. No changes were made.");
      }
      const prepared = prepareBackupMerge(currentSnapshot, input);
      if (!prepared.changes) return false;
      handle.change((document) => {
        const current = prepareBackupMerge(snapshotGroup(document, handle.documentId), input);
        if (current.name !== document.name) document.name = current.name;
        if (current.currency !== document.currency) document.currency = current.currency;
        if (current.groupId && current.groupId !== document.groupId) document.groupId = current.groupId;
        for (const person of current.people) document.people.push(person);
        for (const event of current.events) appendStoredEvent(document, event);
      });
      return true;
    },
  };
  window.addEventListener("storage", (event) => {
    if (event.key === TRUST_PINS_KEY && handle && activeListener) publish(handle.doc(), generation);
  });
  return controller;
}
