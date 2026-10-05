import assert from "node:assert/strict";
import test from "node:test";
import * as Automerge from "@automerge/automerge";
import { auditEntries } from "./src/audit.js";
import { appendStoredEvent, eventMapFromArray, eventsFromDocument, migrateEventStore, needsEventStoreMigration } from "./src/event-store.js";
import { canonicalEventContent } from "./src/ledger.js";
import { projectGroup } from "./src/prototype-events.js";

const firstId = "11111111-1111-4111-8111-111111111111";
const secondId = "22222222-2222-4222-8222-222222222222";

function expense(id, description) {
  return { id, type: "expense-created", description, schemaVersion: 1, protocolVersion: 1 };
}

function validExpense(id, description = "Same content") {
  const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  return {
    id, type: "expense-created", schemaVersion: 1, protocolVersion: 1, groupId,
    author: { participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" },
    createdAt: "2026-09-05T10:00:00.000Z", dependsOn: [],
    payload: { expenseId: "33333333-3333-4333-8333-333333333333", description, currency: "USD", amount: 1000, payerId: "alice",
      splits: [{ participantId: "alice", amount: 500 }, { participantId: "bob", amount: 500 }] },
    signature: "development-only"
  };
}

function initial(events = []) {
  return Automerge.from({ events: [], eventsById: eventMapFromArray(events) });
}

test("event maps are idempotent, scalar, and retain same-ID collision variants", () => {
  const one = expense(firstId, "First");
  let doc = initial();
  doc = Automerge.change(doc, (draft) => { appendStoredEvent(draft, one); });
  const heads = Automerge.getHeads(doc);
  const reordered = { description: "First", protocolVersion: 1, id: firstId, schemaVersion: 1, type: "expense-created" };
  doc = Automerge.change(doc, (draft) => { appendStoredEvent(draft, reordered); });
  assert.deepEqual(Automerge.getHeads(doc), heads);
  const collision = expense(firstId, "Different content");
  doc = Automerge.change(doc, (draft) => { appendStoredEvent(draft, collision); });
  assert.deepEqual(eventsFromDocument(doc), [one, collision].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  assert.ok(Object.entries(doc.eventsById).some(([key, value]) => key.startsWith(`${firstId}:`) && Automerge.isImmutableString(value)));

  let oldDoc = Automerge.from({ events: [one] });
  const oldHeads = Automerge.getHeads(oldDoc);
  oldDoc = Automerge.change(oldDoc, (draft) => { appendStoredEvent(draft, one); });
  assert.deepEqual(Automerge.getHeads(oldDoc), oldHeads);
  assert.equal(oldDoc.eventsById, undefined);
});

test("same-ID concurrent writes preserve every immutable variant after merge and reload", () => {
  const base = initial();
  const leftEvent = expense(firstId, "Left");
  const rightEvent = expense(firstId, "Right");
  const left = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, leftEvent); });
  const right = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, rightEvent); });
  const merged = Automerge.merge(left, right);
  const expected = [leftEvent, rightEvent].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  assert.deepEqual(eventsFromDocument(merged), expected);
  assert.deepEqual(eventsFromDocument(Automerge.merge(right, left)), expected);
  assert.deepEqual(eventsFromDocument(Automerge.load(Automerge.save(merged))), expected);
});

test("concurrent exact duplicates remain diagnosable and project once", () => {
  const event = validExpense(firstId);
  const base = initial();
  const left = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, event); });
  const right = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, event); });
  const merged = Automerge.merge(left, right);
  const events = eventsFromDocument(merged);
  assert.deepEqual(events, [event, event]);
  const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const group = { groupId, currency: "USD", people: [{ id: "alice" }, { id: "bob" }], events };
  const projection = projectGroup(group);
  assert.equal(projection.effective.length, 1);
  assert.ok(projection.duplicates.some(({ id }) => id === firstId));
});

test("concurrent legacy-array append and additive map write survive merge and follow-up save", () => {
  const oldEvent = expense(firstId, "Old array event");
  const newEvent = expense(secondId, "New map event");
  const base = Automerge.from({ events: [oldEvent] });
  const legacyReplica = Automerge.change(Automerge.clone(base), (draft) => { draft.events.push(newEvent); });
  const mapReplica = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, expense("33333333-3333-4333-8333-333333333333", "Converted map event")); });
  const merged = Automerge.merge(legacyReplica, mapReplica);
  const events = eventsFromDocument(merged);
  assert.deepEqual(new Set(events.map(({ description }) => description)), new Set(["Old array event", "New map event", "Converted map event"]));
  const reverse = Automerge.merge(mapReplica, legacyReplica);
  assert.deepEqual(new Set(eventsFromDocument(reverse).map(({ description }) => description)), new Set(["Old array event", "New map event", "Converted map event"]));
  const followup = expense("44444444-4444-4444-8444-444444444444", "Follow-up map write");
  const continued = Automerge.change(merged, (draft) => { appendStoredEvent(draft, followup); });
  assert.deepEqual(new Set(eventsFromDocument(Automerge.load(Automerge.save(continued))).map(({ description }) => description)),
    new Set(["Old array event", "New map event", "Converted map event", "Follow-up map write"]));
});

test("simultaneous first map writes on an old document survive both merges and later writes", () => {
  const old = expense(firstId, "Old document event");
  const leftEvent = expense(secondId, "First client event");
  const rightEvent = expense("33333333-3333-4333-8333-333333333333", "Second client event");
  const base = Automerge.from({ events: [old] });
  const left = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, leftEvent); });
  const right = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, rightEvent); });
  for (const merged of [Automerge.merge(left, right), Automerge.merge(right, left)]) {
    const expected = new Set(["Old document event", "First client event", "Second client event"]);
    assert.deepEqual(new Set(eventsFromDocument(merged).map(({ description }) => description)), expected);
    const later = expense("44444444-4444-4444-8444-444444444444", "Later client event");
    const saved = Automerge.load(Automerge.save(Automerge.change(merged, (draft) => { appendStoredEvent(draft, later); })));
    assert.deepEqual(new Set(eventsFromDocument(saved).map(({ description }) => description)), new Set([...expected, "Later client event"]));
  }
});

test("same-ID collisions in concurrently created map roots enumerate each root variant once", () => {
  const base = Automerge.from({ events: [] });
  const leftEvent = expense(firstId, "Left root");
  const rightEvent = expense(firstId, "Right root");
  const left = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, leftEvent); });
  const right = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, rightEvent); });
  const merged = Automerge.merge(left, right);
  assert.ok(Automerge.getConflicts(merged, "eventsById"));
  assert.deepEqual(eventsFromDocument(merged), [leftEvent, rightEvent].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
});

test("nested collisions in a losing map root survive sibling writes, merge, and save/load", () => {
  const base = Automerge.from({ events: [] });
  const seed = expense(firstId, "Seed");
  const other = expense(secondId, "Other root");
  const left = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, seed); });
  const otherRoot = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, other); });
  const leftOne = Automerge.change(Automerge.clone(left), (draft) => { appendStoredEvent(draft, expense(firstId, "One")); });
  const leftTwo = Automerge.change(Automerge.clone(left), (draft) => { appendStoredEvent(draft, expense(firstId, "Two")); });
  const merged = Automerge.merge(Automerge.merge(leftOne, leftTwo), otherRoot);
  const expected = new Set(["Seed", "One", "Two", "Other root"]);
  assert.deepEqual(new Set(eventsFromDocument(merged).map(({ description }) => description)), expected);
  const followup = expense(firstId, "Follow-up");
  const saved = Automerge.load(Automerge.save(Automerge.change(merged, (draft) => { appendStoredEvent(draft, followup); })));
  assert.deepEqual(new Set(eventsFromDocument(saved).map(({ description }) => description)), new Set([...expected, "Follow-up"]));
});

test("valid same-ID Automerge collisions remain quarantined and auditable after reload", () => {
  const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const logicalExpenseId = "33333333-3333-4333-8333-333333333333";
  const makeValid = (description, payerId) => ({
    id: firstId, type: "expense-created", schemaVersion: 1, protocolVersion: 1, groupId,
    author: { participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" },
    createdAt: "2026-09-05T10:00:00.000Z", dependsOn: [],
    payload: { expenseId: logicalExpenseId, description, currency: "USD", amount: 1000, payerId,
      splits: [{ participantId: "alice", amount: 500 }, { participantId: "bob", amount: 500 }] },
    signature: "development-only"
  });
  const variants = [makeValid("Left copy", "alice"), makeValid("Right copy", "bob")];
  const base = initial();
  const left = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, variants[0]); });
  const right = Automerge.change(Automerge.clone(base), (draft) => { appendStoredEvent(draft, variants[1]); });
  const restored = Automerge.load(Automerge.save(Automerge.merge(left, right)));
  const events = eventsFromDocument(restored);
  assert.equal(events.length, 2);
  const group = { groupId, currency: "USD", people: [{ id: "alice" }, { id: "bob" }], events };
  const projection = projectGroup(group);
  assert.deepEqual(projection.balances, {});
  assert.ok(projection.quarantined.some(({ id, reason }) => id === firstId && reason === "id-content-collision"));
  const audit = auditEntries(group, projection);
  assert.equal(audit.length, 2);
  assert.ok(audit.every(({ status }) => status === "Quarantined"));
});

test("array migration preserves malformed records and hostile IDs for quarantine", () => {
  const malformed = [null, ["raw", "array"], { id: "__proto__", invalid: true }, { invalid: true }, { kind: "event", value: "ordinary raw data" }];
  const doc = initial(malformed);
  assert.deepEqual(new Set(eventsFromDocument(doc).map((event) => JSON.stringify(event))), new Set(malformed.map((event) => JSON.stringify(event))));
});

test("migration copies mixed legacy and versioned arrays without rewriting any source record", () => {
  const oldExpense = { id: firstId, type: "expense", description: "Legacy", amount: 1234, payerId: "alice",
    splits: [{ personId: "alice", amount: 617 }, { personId: "bob", amount: 617 }], createdAt: "2020-01-02T03:04:05.000Z", extra: "preserve me" };
  const signed = validExpense(secondId, "Signed versioned expense");
  signed.signature = "keep-byte-for-byte-signature";
  const unsupported = { ...validExpense("33333333-3333-4333-8333-333333333333", "Future schema"), schemaVersion: 8,
    payload: { ...validExpense("33333333-3333-4333-8333-333333333333").payload, extension: { exact: [1, 2, 3] } }, signature: "unknown-signature" };
  const raw = [oldExpense, signed, unsupported, { noId: true, nested: { keep: null } }];
  let doc = Automerge.from({ name: "Old trip", currency: "USD", people: [], events: raw });
  const before = eventsFromDocument(doc);
  assert.equal(needsEventStoreMigration(doc), true);
  doc = Automerge.change(doc, (draft) => { assert.equal(migrateEventStore(draft), true); });
  assert.deepEqual(doc.events, raw);
  assert.deepEqual(eventsFromDocument(doc), before);
  assert.equal(doc.eventStoreFormatVersion, 1);
  assert.equal(needsEventStoreMigration(doc), false);
  const heads = Automerge.getHeads(doc);
  doc = Automerge.change(doc, (draft) => { assert.equal(migrateEventStore(draft), false); });
  assert.deepEqual(Automerge.getHeads(doc), heads);
  const serialized = Object.values(doc.eventsById).map((value) => value.toString());
  for (const event of raw) assert.ok(serialized.some((value) => canonicalEventContent(JSON.parse(value)) === canonicalEventContent(event)));
  const projection = projectGroup({ groupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", currency: "USD",
    people: [{ id: "alice" }, { id: "bob" }], events: eventsFromDocument(doc) });
  assert.ok(projection.unsupported.some(({ id }) => id === unsupported.id));
  assert.ok(projection.quarantined.length);
});

test("partial migration retries copy only missing records and preserve collisions", () => {
  const one = validExpense(firstId, "First raw variant");
  const two = { ...one, payload: { ...one.payload, description: "Second raw variant" }, signature: "second-signature" };
  const legacy = { id: secondId, type: "expense", description: "Old", amount: 1200, payerId: "alice",
    splits: [{ personId: "alice", amount: 600 }, { personId: "bob", amount: 600 }] };
  let doc = Automerge.from({ events: [one, two, legacy], eventsById: eventMapFromArray([one]) });
  doc = Automerge.change(doc, (draft) => { assert.equal(migrateEventStore(draft), true); });
  const events = eventsFromDocument(doc);
  assert.deepEqual(eventsFromDocument(Automerge.load(Automerge.save(doc))), events);
  for (const raw of [one, two, legacy]) assert.ok(events.some((event) => canonicalEventContent(event) === canonicalEventContent(raw)));
  const projection = projectGroup({ groupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", currency: "USD",
    people: [{ id: "alice" }, { id: "bob" }], events });
  assert.ok(projection.quarantined.some(({ id, reason }) => id === firstId && reason === "id-content-collision"));
  assert.equal(needsEventStoreMigration(doc), false);
});

test("a legacy replica append after migration remains visible and is copied on the next open", () => {
  const first = { id: firstId, type: "expense", description: "Before migration", amount: 1000, payerId: "alice",
    splits: [{ personId: "alice", amount: 500 }, { personId: "bob", amount: 500 }] };
  const late = { id: secondId, type: "expense-created", description: "Old client append", amount: 800, payerId: "bob",
    splits: [{ personId: "alice", amount: 400 }, { personId: "bob", amount: 400 }] };
  let migrated = Automerge.change(Automerge.from({ events: [first] }), (draft) => { migrateEventStore(draft); });
  const oldReplica = Automerge.change(Automerge.clone(migrated), (draft) => { draft.events.push(late); });
  assert.deepEqual(new Set(eventsFromDocument(oldReplica).map(({ id }) => id)), new Set([firstId, secondId]));
  const reopened = Automerge.change(oldReplica, (draft) => { assert.equal(migrateEventStore(draft), true); });
  assert.deepEqual(eventsFromDocument(reopened), eventsFromDocument(oldReplica));
  assert.equal(needsEventStoreMigration(reopened), false);
});

test("concurrent migrations and independent writes preserve arrays, flat variants, and projections", () => {
  const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const seed = validExpense(firstId, "Seed");
  const legacy = { id: secondId, type: "expense", description: "Old meal", amount: 2000, payerId: "alice",
    splits: [{ personId: "alice", amount: 1000 }, { personId: "bob", amount: 1000 }] };
  const base = Automerge.from({ groupId, currency: "USD", people: [{ id: "alice" }, { id: "bob" }], events: [legacy, seed] });
  const left = Automerge.change(Automerge.clone(base), (draft) => {
    migrateEventStore(draft);
    appendStoredEvent(draft, validExpense("33333333-3333-4333-8333-333333333333", "Left write"));
  });
  const right = Automerge.change(Automerge.clone(base), (draft) => {
    migrateEventStore(draft);
    appendStoredEvent(draft, validExpense("44444444-4444-4444-8444-444444444444", "Right write"));
  });
  const expectedIds = new Set([firstId, secondId, "33333333-3333-4333-8333-333333333333", "44444444-4444-4444-8444-444444444444"]);
  const projections = [];
  const audits = [];
  for (const merged of [Automerge.merge(left, right), Automerge.merge(right, left)]) {
    assert.deepEqual(new Set(eventsFromDocument(merged).map((event) => event.id)), expectedIds);
    assert.deepEqual(merged.events, [legacy, seed]);
    const continued = Automerge.change(merged, (draft) => { migrateEventStore(draft); });
    const restored = Automerge.load(Automerge.save(continued));
    const group = { groupId, currency: "USD", people: [{ id: "alice" }, { id: "bob" }], events: eventsFromDocument(restored) };
    const projection = projectGroup(group);
    assert.deepEqual(projection, projectGroup({ ...group, events: [...group.events].reverse() }));
    const audit = auditEntries(group, projection);
    assert.equal(audit.length, group.events.length);
    projections.push(projection);
    audits.push(audit);
  }
  assert.deepEqual(projections[0], projections[1]);
  assert.deepEqual(audits[0], audits[1]);
});
