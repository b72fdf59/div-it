import test from "node:test";
import assert from "node:assert/strict";
import { currentConflictChoice, validateBackup, validateGroupSettings, validatePersonName } from "./src/group.js";
import { conflictResolutionEnvelope, expenseConflictReviews } from "./src/prototype-events.js";

test("local command inputs are validated before document writes", () => {
  assert.equal(validatePersonName("  Ana  "), "Ana");
  assert.deepEqual(validateGroupSettings({ name: "  Trip  ", currency: "USD" }), { name: "Trip", currency: "USD" });
  assert.throws(() => validatePersonName("  "), /Enter a name/);
  assert.throws(() => validateGroupSettings({ name: "Trip", currency: "BAD" }), /supported currency/);
});

test("legacy prototype backup shape is accepted as a detached copy", () => {
  const backup = {
    name: "Trip",
    currency: "EUR",
    people: [{ id: "ana", name: "Ana" }],
    events: [{ id: "old-expense", type: "expense", amount: 100 }],
  };
  const imported = validateBackup(backup);
  imported.people[0].name = "Changed";
  assert.equal(backup.people[0].name, "Ana");
  assert.throws(() => validateBackup({ people: [], events: [] }), /Not a Div It backup/);
});

test("backup metadata must use a supported currency and valid unique participants", () => {
  const backup = { name: "Trip", currency: "EUR", people: [{ id: "legacy-ana", name: "Ana" }], events: [{ id: "legacy-event", type: "expense", amount: 123 }] };
  assert.deepEqual(validateBackup(backup).people, backup.people);
  for (const people of [[null], [{ id: " ", name: "Ana" }], [{ id: "ana", name: " " }], [{ id: "ana", name: "Ana" }, { id: "ana", name: "Another Ana" }]]) {
    assert.throws(() => validateBackup({ ...backup, people }), /participant|name/i);
  }
  assert.throws(() => validateBackup({ ...backup, currency: "invalid" }), /supported currency/i);
});

test("modern backup keeps the group identity carried by its events", () => {
  const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const event = { id: "11111111-1111-4111-8111-111111111111", schemaVersion: 1, groupId };
  assert.equal(validateBackup({ name: "Trip", currency: "USD", people: [], events: [event] }).groupId, groupId);
  assert.throws(() => validateBackup({ name: "Trip", currency: "USD", groupId, people: [], events: [{ ...event, groupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }] }), /does not match/);
  assert.throws(() => validateBackup({ name: "Trip", currency: "USD", people: [], events: [event, { ...event, id: "21111111-1111-4111-8111-111111111111", groupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }] }), /multiple ledger groups/);
});

test("conflict choices reject stale branches and require superseding every competing resolution", () => {
  const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const expenseId = "11111111-1111-4111-8111-111111111111";
  const baseId = "22222222-2222-4222-8222-222222222222";
  const firstId = "33333333-3333-4333-8333-333333333333";
  const secondId = "44444444-4444-4444-8444-444444444444";
  const thirdId = "55555555-5555-4555-8555-555555555555";
  const envelope = (id, type, payload, dependsOn = []) => ({
    id, type, schemaVersion: 1, protocolVersion: 1, groupId,
    author: { participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" },
    createdAt: "2026-09-05T10:00:00.000Z", dependsOn: [...dependsOn].sort(), payload, signature: "development-only"
  });
  const created = envelope(baseId, "expense-created", {
    expenseId, description: "Base", currency: "USD", amount: 2000, payerId: "alice",
    splits: [{ participantId: "alice", amount: 1000 }, { participantId: "bob", amount: 1000 }]
  });
  const branch = (id, description) => envelope(id, "expense-revised", {
    expenseId, supersedesEventId: baseId, description, currency: "USD", amount: 2400, payerId: "alice",
    splits: [{ participantId: "alice", amount: 1200 }, { participantId: "bob", amount: 1200 }]
  }, [baseId]);
  const first = branch(firstId, "First");
  const second = branch(secondId, "Second");
  const third = branch(thirdId, "Third");
  const current = { groupId, currency: "USD", people: [{ id: "alice" }, { id: "bob" }], events: [created, first, second] };
  const initialReview = expenseConflictReviews(current)[0];
  const choice = { expenseId, parentId: baseId, resolvesEventIds: [firstId, secondId], chosenEventId: firstId,
    supersedesResolutionEventIds: [], branchPreviewIds: initialReview.branchPreviewIds,
    branchPreviewSnapshots: initialReview.branchPreviewSnapshots };
  assert.deepEqual(currentConflictChoice(current, choice).branchIds, [firstId, secondId]);
  assert.throws(() => currentConflictChoice({ ...current, events: [...current.events, third] }, choice), /changed since you opened it/);
  const followup = envelope("77777777-7777-4777-8777-777777777777", "expense-revised", {
    expenseId, supersedesEventId: firstId, description: "First followup", currency: "USD", amount: 2500, payerId: "bob",
    splits: [{ participantId: "alice", amount: 1250 }, { participantId: "bob", amount: 1250 }]
  }, [firstId]);
  assert.throws(() => currentConflictChoice({ ...current, events: [...current.events, followup] }, choice), /changed since you opened it/);
  const modifiedFirst = { ...first, payload: { ...first.payload, description: "Changed without changing ID" } };
  assert.throws(() => currentConflictChoice({ ...current, events: [created, modifiedFirst, second] }, choice), /changed since you opened it/);

  const resolve = (chosenEventId) => conflictResolutionEnvelope({ groupId, expenseId, resolvesEventIds: [firstId, secondId], chosenEventId });
  const contested = { ...current, events: [...current.events, resolve(firstId), resolve(secondId)] };
  const contestedReview = currentConflictChoice(contested, {
    ...choice,
    supersedesResolutionEventIds: contested.events.slice(-2).map(({ id }) => id),
    branchPreviewIds: expenseConflictReviews(contested)[0].branchPreviewIds,
    branchPreviewSnapshots: expenseConflictReviews(contested)[0].branchPreviewSnapshots
  });
  assert.equal(contestedReview.resolutionIds.length, 2);
  assert.throws(() => currentConflictChoice(contested, choice), /changed since you opened it/);
});
