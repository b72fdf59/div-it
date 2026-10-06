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

const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const author = { participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" };
function domainEvent(id, type, payload, dependsOn = [], overrides = {}) {
  return {
    id, type, schemaVersion: 1, protocolVersion: 1, groupId, author,
    createdAt: "2026-09-05T10:00:00.000Z", dependsOn: [...dependsOn].sort(), payload,
    signature: "development-only", ...overrides
  };
}

function created(id, expenseId, amount = 1000) {
  return domainEvent(id, "expense-created", {
    expenseId, description: `Expense ${expenseId}`, currency: "USD", amount, payerId: "alice",
    splits: [{ participantId: "alice", amount: amount / 2 }, { participantId: "bob", amount: amount / 2 }]
  });
}

function snapshot(document) {
  const events = eventsFromDocument(document);
  const group = { groupId, currency: "USD", people: [{ id: "alice" }, { id: "bob" }], events };
  const projection = projectGroup(group);
  return {
    events: events.map(canonicalEventContent),
    diagnostics: {
      pending: projection.pending.map(({ event, reason, missingDependencyIds }) => ({ id: event.id, reason, missingDependencyIds })),
      conflicting: projection.conflicting, quarantined: projection.quarantined,
      unsupported: projection.unsupported, duplicates: projection.duplicates, ignored: projection.ignored, readOnly: projection.readOnly
    },
    effective: projection.effective.map(({ id, type, payload }) => ({ id, type, payload })),
    balances: projection.balances,
    audit: auditEntries(group, projection)
  };
}

function appendReplica(base, events) {
  return Automerge.change(Automerge.clone(base), (draft) => {
    for (const event of events) appendStoredEvent(draft, event);
  });
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

test("Automerge delivery order converges through duplicate, reversed, delayed, malformed and incompatible events", () => {
  const baseEventId = "10111111-1111-4111-8111-111111111111";
  const revisionId = "20222222-2222-4222-8222-222222222222";
  const settlementId = "30333333-3333-4333-8333-333333333333";
  const missingDependencyId = "40444444-4444-4444-8444-444444444444";
  const malformedId = "50555555-5555-4555-8555-555555555555";
  const foreignId = "60666666-6666-4666-8666-666666666666";
  const futureId = "70777777-7777-4777-8777-777777777777";
  const expenseId = "80888888-8888-4888-8888-888888888888";
  const baseEvent = created(baseEventId, expenseId, 2000);
  const revision = domainEvent(revisionId, "expense-revised", {
    expenseId, supersedesEventId: baseEventId, description: "Revised after delivery", currency: "USD", amount: 3000,
    payerId: "bob", splits: [{ participantId: "alice", amount: 1500 }, { participantId: "bob", amount: 1500 }]
  }, [baseEventId]);
  const prerequisite = domainEvent(missingDependencyId, "settlement-recorded", {
    settlementId, currency: "USD", fromParticipantId: "alice", toParticipantId: "bob", amount: 200
  });
  const reversal = domainEvent("41444444-4444-4444-8444-444444444444", "settlement-reversed", {
    settlementId, reversesEventId: missingDependencyId, reason: "Delayed correction"
  }, [missingDependencyId]);
  const malformed = { id: malformedId, type: "expense-created", schemaVersion: 1, protocolVersion: 1,
    groupId, author, createdAt: "2026-09-05T10:00:00.000Z", dependsOn: [], payload: { broken: true }, signature: "development-only" };
  const foreign = { ...created(foreignId, "90999999-9999-4999-8999-999999999999"), groupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const future = { ...created(futureId, "91999999-9999-4999-8999-999999999999"), schemaVersion: 2,
    payload: { ...created(futureId, "91999999-9999-4999-8999-999999999999").payload, extension: [1, 2] } };

  // Replica A has the expense and malformed/foreign records; B has a duplicate expense,
  // a dependent revision, and a future event; C has the domain prerequisite.
  const deliveryBase = initial();
  const a = appendReplica(deliveryBase, [baseEvent, malformed, foreign]);
  const b = appendReplica(deliveryBase, [baseEvent, revision, reversal, future]);
  const c = appendReplica(deliveryBase, [prerequisite]);
  const partialAB = Automerge.merge(a, b);
  const partialBA = Automerge.merge(b, a);
  const partialSnapshot = snapshot(partialAB);
  assert.deepEqual(snapshot(partialBA), partialSnapshot);
  assert.ok(partialSnapshot.diagnostics.duplicates.some(({ id }) => id === baseEventId));
  assert.ok(partialSnapshot.diagnostics.pending.some(({ id }) => id === reversal.id), "present event with missing domain dependency is pending");
  assert.ok(partialSnapshot.diagnostics.quarantined.some(({ id, reason }) => id === malformedId && reason === "invalid-payload"));
  assert.ok(partialSnapshot.diagnostics.quarantined.some(({ id, reason }) => id === foreignId && reason === "group-mismatch"));
  assert.ok(partialSnapshot.diagnostics.unsupported.some(({ id }) => id === futureId));
  assert.equal(partialSnapshot.diagnostics.readOnly, true);
  assert.equal(partialSnapshot.effective.length, 1, "duplicate base expense applies once; pending reversal is not effective");

  // Delay the Automerge change containing the prerequisite: it is absent, not pending,
  // until C's change is actually merged. Then deliver changes in opposite merge orders.
  const delayed = snapshot(a);
  assert.ok(!delayed.events.some((serialized) => JSON.parse(serialized).id === missingDependencyId));
  const deliveredABC = Automerge.merge(Automerge.clone(partialAB), Automerge.clone(c));
  const deliveredCBA = Automerge.merge(Automerge.clone(c), Automerge.clone(partialBA));
  const expected = snapshot(deliveredABC);
  assert.deepEqual(snapshot(deliveredCBA), expected);
  assert.ok(expected.effective.some(({ id }) => id === revisionId), "revision becomes effective after its domain dependency arrives");
  assert.ok(expected.effective.some(({ id }) => id === reversal.id), "reversal becomes effective after its Automerge change arrives");
  assert.ok(!expected.diagnostics.pending.some(({ id }) => id === reversal.id));
  assert.deepEqual(expected.balances, { alice: -1500, bob: 1500 }, "revision applies and the settlement/reversal pair nets to zero");
  assert.deepEqual(expected, snapshot(Automerge.load(Automerge.save(deliveredCBA))));
});

test("concurrent revision branches stay financially neutral regardless of Automerge merge direction", () => {
  const baseId = "11111111-aaaa-4111-8111-111111111111";
  const leftId = "22222222-aaaa-4222-8222-222222222222";
  const rightId = "33333333-aaaa-4333-8333-333333333333";
  const expenseId = "44444444-aaaa-4444-8444-444444444444";
  const root = created(baseId, expenseId, 2000);
  const revise = (id, description, amount, payerId) => domainEvent(id, "expense-revised", {
    expenseId, supersedesEventId: baseId, description, currency: "USD", amount, payerId,
    splits: [{ participantId: "alice", amount: amount / 2 }, { participantId: "bob", amount: amount / 2 }]
  }, [baseId]);
  const leftEvent = revise(leftId, "Concurrent left", 3000, "alice");
  const rightEvent = revise(rightId, "Concurrent right", 4000, "bob");
  const base = appendReplica(initial(), [root]);
  const left = appendReplica(base, [leftEvent]);
  const right = appendReplica(base, [rightEvent]);
  const leftFirst = Automerge.merge(left, right);
  const rightFirst = Automerge.merge(right, left);
  const expected = snapshot(leftFirst);
  assert.deepEqual(snapshot(rightFirst), expected);
  assert.deepEqual(expected.balances, { alice: 1000, bob: -1000 }, "competing branches preserve the uncontested base projection");
  assert.deepEqual(expected.effective.map(({ id }) => id), [baseId]);
  assert.deepEqual(expected.diagnostics.conflicting.map(({ id, reason }) => ({ id, reason })), [
    { id: leftId, reason: "conflicting-revision" }, { id: rightId, reason: "conflicting-revision" }
  ]);
  assert.deepEqual(expected, snapshot(Automerge.load(Automerge.save(rightFirst))));
});
