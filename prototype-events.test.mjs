import assert from "node:assert/strict";
import { test } from "node:test";
import { generateAutomergeUrl, parseAutomergeUrl } from "@automerge/automerge-repo";
import { conflictResolutionEnvelope, expenseConflictReviews, projectGroup, groupIdFromDocumentId, normalizeExpenseForProjection } from "./src/prototype-events.js";

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

test("conflict review previews uncontested follow-up revisions inside each branch", () => {
  const baseId = "22222222-2222-4222-8222-222222222222";
  const firstId = "33333333-3333-4333-8333-333333333333";
  const secondId = "44444444-4444-4444-8444-444444444444";
  const followupId = "55555555-5555-4555-8555-555555555555";
  const expenseId = "66666666-6666-4666-8666-666666666666";
  const envelope = (id, type, payload, dependsOn = []) => ({
    id, type, schemaVersion: 1, protocolVersion: 1, groupId: group.groupId,
    author: { participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" },
    createdAt: "2026-09-05T10:00:00.000Z", dependsOn: [...dependsOn].sort(), payload, signature: "development-only"
  });
  const created = envelope(baseId, "expense-created", {
    expenseId, description: "Base", currency: "USD", amount: 2000, payerId: "alice",
    splits: [{ participantId: "alice", amount: 1000 }, { participantId: "bob", amount: 1000 }]
  });
  const first = envelope(firstId, "expense-revised", {
    expenseId, supersedesEventId: baseId, description: "First branch", currency: "USD", amount: 3000, payerId: "alice",
    splits: [{ participantId: "alice", amount: 1500 }, { participantId: "bob", amount: 1500 }]
  }, [baseId]);
  const second = envelope(secondId, "expense-revised", {
    expenseId, supersedesEventId: baseId, description: "Second branch", currency: "USD", amount: 4000, payerId: "bob",
    splits: [{ participantId: "alice", amount: 2000 }, { participantId: "bob", amount: 2000 }]
  }, [baseId]);
  const missingId = "88888888-8888-4888-8888-888888888888";
  const followup = envelope(followupId, "expense-revised", {
    expenseId, supersedesEventId: firstId, description: "First branch follow-up", currency: "USD", amount: 5000, payerId: "bob",
    splits: [{ participantId: "alice", amount: 2500 }, { participantId: "bob", amount: 2500 }]
  }, [firstId, missingId]);
  const sources = [created, first, second, followup];
  const projection = projectGroup({ ...group, events: sources });
  const reviews = expenseConflictReviews({ ...group, events: sources }, projection);
  assert.equal(reviews.length, 1);
  assert.deepEqual(reviews[0].branchIds, [firstId, secondId].sort());
  assert.equal(reviews[0].branches.find(({ id }) => id === firstId).preview.id, firstId);
  const dependency = envelope(missingId, "settlement-recorded", {
    settlementId: "99999999-9999-4999-8999-999999999999", currency: "USD",
    fromParticipantId: "alice", toParticipantId: "bob", amount: 100
  });
  const readySources = [...sources, dependency];
  const readyProjection = projectGroup({ ...group, events: readySources });
  const readyReviews = expenseConflictReviews({ ...group, events: readySources }, readyProjection);
  assert.equal(readyReviews[0].branches.find(({ id }) => id === firstId).preview.id, followupId);
  assert.equal(readyReviews[0].branches.find(({ id }) => id === firstId).preview.payload.amount, 5000);
  const malformedDuplicate = { ...first, payload: null };
  const duplicateSources = [created, malformedDuplicate, first, second];
  const duplicateProjection = projectGroup({ ...group, events: duplicateSources });
  const duplicateReviews = expenseConflictReviews({ ...group, events: duplicateSources }, duplicateProjection);
  assert.equal(duplicateReviews[0].branches.find(({ id }) => id === firstId).event.payload.description, "First branch");
});

test("a resolved nested fork is previewed as its projected result and is not reviewed twice", () => {
  const expenseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const baseId = "11111111-1111-4111-8111-111111111111";
  const rootA = "33333333-3333-4333-8333-333333333333";
  const rootB = "44444444-4444-4444-8444-444444444444";
  const nestedA = "55555555-5555-4555-8555-555555555555";
  const nestedB = "66666666-6666-4666-8666-666666666666";
  const envelope = (id, type, payload, dependsOn = []) => ({
    id, type, schemaVersion: 1, protocolVersion: 1, groupId: group.groupId,
    author: { participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" },
    createdAt: "2026-09-05T10:00:00.000Z", dependsOn: [...dependsOn].sort(), payload, signature: "development-only"
  });
  const created = envelope(baseId, "expense-created", {
    expenseId, description: "Base", currency: "USD", amount: 2000, payerId: "alice",
    splits: [{ participantId: "alice", amount: 1000 }, { participantId: "bob", amount: 1000 }]
  });
  const revision = (id, supersedesEventId, description, amount, payerId) => envelope(id, "expense-revised", {
    expenseId, supersedesEventId, description, currency: "USD", amount, payerId,
    splits: [{ participantId: "alice", amount: amount / 2 }, { participantId: "bob", amount: amount / 2 }]
  }, [supersedesEventId]);
  const events = [
    created,
    revision(rootA, baseId, "Root A", 3000, "alice"),
    revision(rootB, baseId, "Root B", 4000, "bob"),
    revision(nestedA, rootA, "Nested A", 6000, "alice"),
    revision(nestedB, rootA, "Nested B", 7000, "bob"),
    conflictResolutionEnvelope({ groupId: group.groupId, expenseId, resolvesEventIds: [nestedA, nestedB], chosenEventId: nestedA })
  ];
  const source = { ...group, events };
  const projection = projectGroup(source);
  const reviews = expenseConflictReviews(source, projection);
  assert.equal(reviews.length, 1);
  const rootPreview = reviews[0].branches.find(({ id }) => id === rootA).preview;
  assert.equal(rootPreview.id, nestedA);
  const hypothetical = conflictResolutionEnvelope({ groupId: group.groupId, expenseId,
    resolvesEventIds: [rootA, rootB], chosenEventId: rootA });
  const selected = projectGroup({ ...source, events: [...events, hypothetical] }).effective
    .find((event) => event.payload?.expenseId === expenseId && ["expense-created", "expense-revised"].includes(event.type));
  assert.equal(rootPreview.id, selected.id);
  assert.equal(rootPreview.payload.amount, 6000);
});
