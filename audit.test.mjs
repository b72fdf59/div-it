import assert from "node:assert/strict";
import test from "node:test";
import { auditEntries } from "./src/audit.js";
import { projectGroup } from "./src/prototype-events.js";

const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const expenseId = "11111111-1111-4111-8111-111111111111";
const baseId = "22222222-2222-4222-8222-222222222222";
const pendingId = "33333333-3333-4333-8333-333333333333";
const settlementId = "44444444-4444-4444-8444-444444444444";
const recordedA = "55555555-5555-4555-8555-555555555555";
const recordedB = "66666666-6666-4666-8666-666666666666";
const reversedId = "77777777-7777-4777-8777-777777777777";
const invalidChildId = "99999999-9999-4999-8999-999999999999";

function event(id, type, payload, dependsOn = []) {
  return {
    id, type, schemaVersion: 1, protocolVersion: 1, groupId,
    author: { participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" },
    createdAt: "2026-09-05T10:00:00.000Z", dependsOn, payload, signature: "development-only"
  };
}

test("pending children do not imply a stored ancestor was superseded", () => {
  const base = event(baseId, "expense-created", {
    expenseId, description: "Base", currency: "USD", amount: 1000, payerId: "alice",
    splits: [{ participantId: "alice", amount: 500 }, { participantId: "bob", amount: 500 }]
  });
  const pending = event(pendingId, "expense-revised", {
    expenseId, supersedesEventId: baseId, description: "Pending", currency: "USD", amount: 2000, payerId: "alice",
    splits: [{ participantId: "alice", amount: 1000 }, { participantId: "bob", amount: 1000 }]
  }, [baseId, "88888888-8888-4888-8888-888888888888"]);
  const invalidChild = event(invalidChildId, "expense-revised", {
    expenseId, supersedesEventId: baseId, description: "Invalid", currency: "USD", amount: 3000, payerId: "alice",
    splits: [{ participantId: "alice", amount: 1500 }, { participantId: "bob", amount: 1500 }]
  }, [baseId]);
  const projection = {
    effective: [], pending: [{ event: pending, reason: "missing-dependency", missingDependencyIds: ["88888888-8888-4888-8888-888888888888"] }],
    conflicting: [], quarantined: [{ id: invalidChildId, reason: "unauthenticated" }], unsupported: [], ignored: [], duplicates: []
  };
  const rows = auditEntries({ groupId, currency: "USD", people: [], events: [base, pending, invalidChild] }, projection);
  assert.equal(rows.find(({ id }) => id === baseId).status, "Stored only");
  assert.equal(rows.find(({ id }) => id === pendingId).status, "Pending");
  assert.equal(rows.find(({ id }) => id === invalidChildId).status, "Quarantined");
});

test("a reversal marks only the settlement event it references", () => {
  const first = event(recordedA, "settlement-recorded", { settlementId, currency: "USD", fromParticipantId: "bob", toParticipantId: "alice", amount: 100 });
  const second = event(recordedB, "settlement-recorded", { settlementId, currency: "USD", fromParticipantId: "bob", toParticipantId: "alice", amount: 100 });
  const reversal = event(reversedId, "settlement-reversed", { settlementId, reversesEventId: recordedA, reason: "Returned" }, [recordedA]);
  const projection = {
    effective: [{ id: reversedId, type: "settlement-reversed", payload: reversal.payload }],
    pending: [], conflicting: [], quarantined: [], unsupported: [], ignored: [], duplicates: []
  };
  const rows = auditEntries({ groupId, currency: "USD", people: [], events: [first, second, reversal] }, projection);
  assert.equal(rows.find(({ id }) => id === recordedA).status, "Reversed");
  assert.equal(rows.find(({ id }) => id === recordedB).status, "Stored only");
});

test("projected pending and quarantined records do not affect balances or effective audit status", () => {
  const base = event(baseId, "expense-created", {
    expenseId, description: "Base", currency: "USD", amount: 1000, payerId: "alice",
    splits: [{ participantId: "alice", amount: 500 }, { participantId: "bob", amount: 500 }]
  });
  const pending = event(pendingId, "expense-revised", {
    expenseId, supersedesEventId: baseId, description: "Pending", currency: "USD", amount: 2000, payerId: "alice",
    splits: [{ participantId: "alice", amount: 1000 }, { participantId: "bob", amount: 1000 }]
  }, [baseId, "88888888-8888-4888-8888-888888888888"]);
  const invalidChild = event(invalidChildId, "expense-revised", {
    expenseId, supersedesEventId: baseId, description: "Invalid", currency: "USD", amount: 3000, payerId: "alice",
    splits: [{ participantId: "alice", amount: 1000 }, { participantId: "bob", amount: 1000 }]
  }, [baseId]);
  const group = { groupId, currency: "USD", people: [{ id: "alice" }, { id: "bob" }], events: [base, pending, invalidChild] };
  const projection = projectGroup(group);
  const rows = auditEntries(group, projection);
  assert.deepEqual(projection.balances, { alice: 500, bob: -500 });
  assert.equal(rows.find(({ id }) => id === baseId).status, "Effective");
  assert.equal(rows.find(({ id }) => id === pendingId).status, "Pending");
  assert.equal(rows.find(({ id }) => id === invalidChildId).status, "Quarantined");
});

test("projected reversal audits its exact settlement event", () => {
  const firstId = "12121212-1212-4121-8121-121212121212";
  const secondId = "13131313-1313-4131-8131-131313131313";
  const first = event(firstId, "settlement-recorded", { settlementId, currency: "USD", fromParticipantId: "bob", toParticipantId: "alice", amount: 100 });
  const second = event(secondId, "settlement-recorded", { settlementId: "14141414-1414-4141-8141-141414141414", currency: "USD", fromParticipantId: "bob", toParticipantId: "alice", amount: 200 });
  const reversal = event(reversedId, "settlement-reversed", { settlementId, reversesEventId: firstId, reason: "Returned" }, [firstId]);
  const group = { groupId, currency: "USD", people: [{ id: "alice" }, { id: "bob" }], events: [first, second, reversal] };
  const projection = projectGroup(group);
  const rows = auditEntries(group, projection);
  assert.equal(rows.find(({ id }) => id === firstId).status, "Reversed");
  assert.equal(rows.find(({ id }) => id === secondId).status, "Effective");
});
