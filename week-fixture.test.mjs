import assert from "node:assert/strict";
import test from "node:test";
import { auditEntries } from "./src/audit.js";
import { projectGroup } from "./src/prototype-events.js";

const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const people = [{ id: "alice", name: "Alice" }, { id: "bob", name: "Bob" }, { id: "cara", name: "Cara" }];
const ids = {
  dinner: "11111111-1111-4111-8111-111111111111",
  dinnerRevision: "22222222-2222-4222-8222-222222222222",
  taxi: "33333333-3333-4333-8333-333333333333",
  taxiVoid: "44444444-4444-4444-8444-444444444444",
  branchCara: "55555555-5555-4555-8555-555555555555",
  branchAlice: "66666666-6666-4666-8666-666666666666",
  resolution: "77777777-7777-4777-8777-777777777777",
  settlement: "88888888-8888-4888-8888-888888888888",
  reversal: "99999999-9999-4999-8999-999999999999"
};

function event(id, type, payload, dependsOn = [], day = 1) {
  return {
    id, type, schemaVersion: 1, protocolVersion: 1, groupId,
    author: { participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" },
    createdAt: `2026-09-0${day}T12:00:00.000Z`, dependsOn: [...dependsOn].sort(), payload, signature: "development-only"
  };
}

const equalSplits = (amount) => ["alice", "bob", "cara"].map((participantId) => ({ participantId, amount: amount / 3 }));
const dinner = event(ids.dinner, "expense-created", {
  expenseId: ids.dinner, description: "Monday dinner", currency: "USD", amount: 3000, payerId: "alice", splits: equalSplits(3000)
});
const dinnerRevision = event(ids.dinnerRevision, "expense-revised", {
  expenseId: ids.dinner, supersedesEventId: ids.dinner, description: "Corrected dinner", currency: "USD", amount: 3600, payerId: "bob", splits: equalSplits(3600)
}, [ids.dinner], 2);
const taxi = event(ids.taxi, "expense-created", {
  expenseId: ids.taxi, description: "Tuesday taxi", currency: "USD", amount: 1200, payerId: "cara",
  splits: [{ participantId: "bob", amount: 600 }, { participantId: "cara", amount: 600 }]
}, [], 3);
const taxiVoid = event(ids.taxiVoid, "expense-voided", {
  expenseId: ids.taxi, supersedesEventId: ids.taxi, reason: "Duplicate receipt"
}, [ids.taxi], 4);
const branchCara = event(ids.branchCara, "expense-revised", {
  expenseId: ids.dinner, supersedesEventId: ids.dinnerRevision, description: "Dinner paid by Cara", currency: "USD", amount: 3600, payerId: "cara", splits: equalSplits(3600)
}, [ids.dinnerRevision], 5);
const branchAlice = event(ids.branchAlice, "expense-revised", {
  expenseId: ids.dinner, supersedesEventId: ids.dinnerRevision, description: "Dinner paid by Alice", currency: "USD", amount: 4800, payerId: "alice",
  splits: [{ participantId: "alice", amount: 1600 }, { participantId: "bob", amount: 1600 }, { participantId: "cara", amount: 1600 }]
}, [ids.dinnerRevision], 5);
const resolution = event(ids.resolution, "conflict-resolved", {
  resolutionId: "12121212-1212-4121-8121-121212121212", expenseId: ids.dinner,
  resolvesEventIds: [ids.branchAlice, ids.branchCara].sort(), chosenEventId: ids.branchCara, supersedesResolutionEventIds: []
}, [ids.branchAlice, ids.branchCara], 6);
const settlement = event(ids.settlement, "settlement-recorded", {
  settlementId: "13131313-1313-4131-8131-131313131313", currency: "USD", fromParticipantId: "cara", toParticipantId: "alice", amount: 500
}, [], 7);
const reversal = event(ids.reversal, "settlement-reversed", {
  settlementId: settlement.payload.settlementId, reversesEventId: ids.settlement, reason: "Transfer returned"
}, [ids.settlement], 7);
const weekEvents = [dinner, dinnerRevision, taxi, taxiVoid, branchCara, branchAlice, resolution, settlement, reversal];

function project(events) {
  return projectGroup({ groupId, currency: "USD", people, events });
}

test("a week's ledger stays deterministic and every source event remains auditable", () => {
  const expectedBalances = { alice: -1200, bob: -1200, cara: 2400 };
  const byDay = (day) => weekEvents.filter(({ createdAt }) => Number(createdAt.slice(8, 10)) <= day);
  const expectedByDay = [
    { alice: 2000, bob: -1000, cara: -1000 },
    { alice: -1200, bob: 2400, cara: -1200 },
    { alice: -1200, bob: 1800, cara: -600 },
    { alice: -1200, bob: 2400, cara: -1200 },
    { alice: -1200, bob: 2400, cara: -1200 },
    { alice: -1200, bob: -1200, cara: 2400 },
    expectedBalances
  ];
  assert.deepEqual(new Set(weekEvents.map(({ createdAt }) => createdAt.slice(0, 10))).size, 7);
  for (let day = 1; day <= 7; day++) assert.deepEqual(project(byDay(day)).balances, expectedByDay[day - 1], `ending balance on day ${day}`);
  const baseline = project(weekEvents);
  assert.deepEqual(baseline.balances, expectedBalances);
  assert.equal(baseline.balances.alice + baseline.balances.bob + baseline.balances.cara, 0);
  assert.deepEqual(project([...weekEvents].reverse()).balances, expectedBalances);
  assert.deepEqual(project([...weekEvents, ...weekEvents]).balances, expectedBalances);
  assert.deepEqual(project([...weekEvents].reverse()).effective.map(({ id }) => id).sort(), baseline.effective.map(({ id }) => id).sort());

  const audit = auditEntries({ groupId, currency: "USD", people, events: weekEvents }, baseline);
  const status = Object.fromEntries(audit.map(({ id, status }) => [id, status]));
  assert.equal(audit.length, weekEvents.length);
  assert.equal(status[ids.dinner], "Superseded");
  assert.equal(status[ids.dinnerRevision], "Superseded");
  assert.equal(status[ids.taxi], "Superseded");
  assert.equal(status[ids.taxiVoid], "Effective void");
  assert.equal(status[ids.branchCara], "Effective");
  assert.equal(status[ids.branchAlice], "Rejected branch");
  assert.equal(status[ids.resolution], "Effective resolution");
  assert.equal(status[ids.settlement], "Reversed");
  assert.equal(status[ids.reversal], "Effective reversal");
});
