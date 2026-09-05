import assert from "node:assert/strict";
import { test } from "node:test";
import { projectLedger } from "./src/ledger.js";

const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectionContext = { groupId, currency: "USD" };

function expense({ id, expenseId, payerId, amount, splits, description }) {
  return {
    id,
    type: "expense-created",
    schemaVersion: 1,
    protocolVersion: 1,
    groupId,
    author: { participantId: payerId, deviceId: `device-${payerId}`, keyId: `key-${payerId}` },
    createdAt: "2026-09-05T10:00:00.000Z",
    dependsOn: [],
    payload: { expenseId, description, currency: "USD", amount, payerId, splits },
    signature: `signature-${id}`
  };
}

const dinner = expense({
  id: "11111111-1111-4111-8111-111111111111",
  expenseId: "21111111-1111-4111-8111-111111111111",
  description: "Dinner",
  payerId: "alice",
  amount: 2000,
  splits: [{ participantId: "alice", amount: 1200 }, { participantId: "bob", amount: 800 }]
});

const taxi = expense({
  id: "33333333-3333-4333-8333-333333333333",
  expenseId: "43333333-3333-4333-8333-333333333333",
  description: "Taxi",
  payerId: "bob",
  amount: 1500,
  splits: [{ participantId: "alice", amount: 500 }, { participantId: "bob", amount: 500 }, { participantId: "carol", amount: 500 }]
});

function permutations(values) {
  if (values.length < 2) return [values];
  return values.flatMap((value, index) => permutations(values.toSpliced(index, 1)).map((rest) => [value, ...rest]));
}

test("projects created expenses independently of insertion order", () => {
  const expected = {
    balances: { alice: 300, bob: 200, carol: -500 },
    effective: [dinner, taxi],
    pending: []
  };

  for (const ordered of permutations([dinner, taxi])) {
    const eventsById = Object.fromEntries(ordered.map((event) => [event.id, event]));
    assert.deepEqual(projectLedger(eventsById, projectionContext), expected);
  }
});

test("accepts an ID-keyed Map and returns deterministic participant keys", () => {
  const projection = projectLedger(new Map([[taxi.id, taxi], [dinner.id, dinner]]), projectionContext);
  assert.deepEqual(Object.keys(projection.balances), ["alice", "bob", "carol"]);
  assert.deepEqual(projection.effective.map((event) => event.id), [dinner.id, taxi.id]);
});

test("does not mutate event input or expose references to it", () => {
  const eventsById = { [dinner.id]: structuredClone(dinner), [taxi.id]: structuredClone(taxi) };
  const before = structuredClone(eventsById);
  const projection = projectLedger(eventsById, projectionContext);

  projection.effective[0].payload.description = "Changed outside";
  assert.deepEqual(eventsById, before);
});

test("always returns zero-sum balances", () => {
  const { balances } = projectLedger({ [dinner.id]: dinner, [taxi.id]: taxi }, projectionContext);
  assert.equal(Object.values(balances).reduce((sum, balance) => sum + balance, 0), 0);
  assert.deepEqual(projectLedger({}, projectionContext), { balances: {}, effective: [], pending: [] });
});

test("keeps missing-dependency events pending without blocking valid balances", () => {
  const dependent = { ...dinner, dependsOn: ["99999999-9999-4999-8999-999999999999"] };
  const result = projectLedger({ [dependent.id]: dependent, [taxi.id]: taxi }, projectionContext);

  assert.deepEqual(result.balances, { alice: -500, bob: 1000, carol: -500 });
  assert.deepEqual(result.effective, [taxi]);
  assert.deepEqual(result.pending, [{
    event: dependent,
    reason: "missing-dependency",
    missingDependencyIds: ["99999999-9999-4999-8999-999999999999"]
  }]);
});

test("keeps transitive missing dependencies pending", () => {
  const missingId = "99999999-9999-4999-8999-999999999999";
  const first = { ...dinner, dependsOn: [missingId] };
  const second = { ...taxi, dependsOn: [first.id] };
  const result = projectLedger({ [first.id]: first, [second.id]: second }, projectionContext);

  assert.deepEqual(result.balances, {});
  assert.deepEqual(result.effective, []);
  assert.deepEqual(result.pending.map(({ event, missingDependencyIds }) => ({ id: event.id, missingDependencyIds })), [
    { id: first.id, missingDependencyIds: [missingId] },
    { id: second.id, missingDependencyIds: [first.id] }
  ]);
});

test("rejects events outside the trusted group and currency", () => {
  const otherGroup = { ...dinner, groupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const otherCurrency = { ...dinner, payload: { ...dinner.payload, currency: "EUR" } };

  assert.throws(
    () => projectLedger({ [otherGroup.id]: otherGroup }, projectionContext),
    { name: "TypeError", message: "group-mismatch" }
  );
  assert.throws(
    () => projectLedger({ [otherCurrency.id]: otherCurrency }, projectionContext),
    { name: "TypeError", message: "currency-mismatch" }
  );
});

test("requires trusted projection context", () => {
  assert.throws(
    () => projectLedger({ [dinner.id]: dinner }),
    { name: "TypeError", message: "invalid-projection-context" }
  );
});
