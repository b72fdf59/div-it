import assert from "node:assert/strict";
import { test } from "node:test";
import { generateAutomergeUrl, parseAutomergeUrl } from "@automerge/automerge-repo";
import { projectGroup, groupIdFromDocumentId, normalizeExpenseForProjection } from "./src/prototype-events.js";

const group = {
  groupId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  currency: "USD",
  people: [{ id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }]
};
const legacyExpense = {
  id: "11111111-1111-4111-8111-111111111111",
  type: "expense-created",
  description: "Dinner",
  amount: 2000,
  payerId: "alice",
  splits: [{ personId: "alice", amount: 1200 }, { personId: "bob", amount: 800 }],
  createdAt: "2026-09-05T10:00:00.000Z"
};

test("legacy expenses normalize deterministically without changing their stored values", () => {
  const source = structuredClone(legacyExpense);
  const first = normalizeExpenseForProjection(source, group);
  const second = normalizeExpenseForProjection(source, group);

  assert.deepEqual(first, second);
  assert.equal(first.id, source.id);
  assert.equal(first.payload.expenseId, source.id);
  assert.deepEqual(first.payload.splits, [
    { participantId: "alice", amount: 1200 },
    { participantId: "bob", amount: 800 }
  ]);
  assert.deepEqual(source, legacyExpense);
  assert.deepEqual(projectGroup({ ...group, events: [source] }).balances, { alice: 800, bob: -800 });
});

test("duplicate legacy IDs quarantine as collisions without crashing", () => {
  const second = { ...legacyExpense, description: "Different content" };
  const projection = projectGroup({ ...group, events: [legacyExpense, second] });
  assert.deepEqual(projection.balances, {});
  assert.deepEqual(projection.quarantined, [{ id: legacyExpense.id, reason: "id-content-collision" }]);
});

test("malformed legacy entries and unsupported versions remain visible to the projector", () => {
  const malformed = { ...legacyExpense, splits: [null] };
  const invalidId = { ...legacyExpense, id: "old-expense" };
  const future = {
    ...normalizeExpenseForProjection(legacyExpense, group),
    schemaVersion: 2,
    payload: {}
  };
  const futureProtocol = { ...future, id: "21111111-1111-4111-8111-111111111111", schemaVersion: 1, protocolVersion: 2 };
  assert.deepEqual(normalizeExpenseForProjection(future, group), future);

  const invalid = projectGroup({ ...group, events: [malformed, invalidId, { type: "expense" }] });
  assert.equal(invalid.quarantined.length, 3);
  const unsupported = projectGroup({ ...group, events: [future, futureProtocol] });
  assert.equal(unsupported.readOnly, true);
  assert.deepEqual(unsupported.unsupported, [
    { id: future.id, reason: "unsupported-version" },
    { id: futureProtocol.id, reason: "unsupported-version" }
  ]);
});

test("group IDs preserve the UUID embedded in a local Automerge document ID", () => {
  const documentId = parseAutomergeUrl(generateAutomergeUrl()).documentId;
  const first = groupIdFromDocumentId(documentId);
  assert.equal(groupIdFromDocumentId(documentId), first);
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
