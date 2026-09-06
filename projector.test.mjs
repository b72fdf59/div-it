import assert from "node:assert/strict";
import { test } from "node:test";
import { projectLedger } from "./src/ledger.js";

const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectionContext = { groupId, currency: "USD", isEventAuthorized: () => true };

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

function settlement({ id, settlementId, fromParticipantId, toParticipantId, amount, dependsOn = [] }) {
  return {
    id,
    type: "settlement-recorded",
    schemaVersion: 1,
    protocolVersion: 1,
    groupId,
    author: { participantId: fromParticipantId, deviceId: `device-${fromParticipantId}`, keyId: `key-${fromParticipantId}` },
    createdAt: "2026-09-05T10:00:00.000Z",
    dependsOn,
    payload: { settlementId, currency: "USD", fromParticipantId, toParticipantId, amount },
    signature: `signature-${id}`
  };
}

function reversal({ id, settlementId, reversesEventId, dependsOn = [reversesEventId] }) {
  return {
    id,
    type: "settlement-reversed",
    schemaVersion: 1,
    protocolVersion: 1,
    groupId,
    author: { participantId: "alice", deviceId: "device-alice", keyId: "key-alice" },
    createdAt: "2026-09-05T10:00:00.000Z",
    dependsOn,
    payload: { settlementId, reversesEventId, reason: "Returned" },
    signature: `signature-${id}`
  };
}

function revisedExpense({ id, supersedesEventId, expenseId, amount, splits, description = "Revised dinner", dependsOn = [supersedesEventId] }) {
  return {
    id,
    type: "expense-revised",
    schemaVersion: 1,
    protocolVersion: 1,
    groupId,
    author: { participantId: "alice", deviceId: "device-alice", keyId: "key-alice" },
    createdAt: "2026-09-05T10:00:00.000Z",
    dependsOn,
    payload: { expenseId, supersedesEventId, description, currency: "USD", amount, payerId: "alice", splits },
    signature: `signature-${id}`
  };
}

function voidedExpense({ id, supersedesEventId, expenseId, dependsOn = [supersedesEventId] }) {
  return {
    id,
    type: "expense-voided",
    schemaVersion: 1,
    protocolVersion: 1,
    groupId,
    author: { participantId: "alice", deviceId: "device-alice", keyId: "key-alice" },
    createdAt: "2026-09-05T10:00:00.000Z",
    dependsOn,
    payload: { expenseId, supersedesEventId, reason: "Refunded" },
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
    pending: [],
    quarantined: [],
    unsupported: [],
    readOnly: false,
    duplicates: [],
    ignored: []
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
  assert.deepEqual(projectLedger({}, projectionContext), {
    balances: {}, effective: [], pending: [], quarantined: [], unsupported: [], readOnly: false, duplicates: [], ignored: []
  });
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

test("applies exact duplicate event content once", () => {
  const duplicate = structuredClone(dinner);
  const result = projectLedger({ [dinner.id]: [dinner, duplicate] }, projectionContext);

  assert.deepEqual(result.balances, { alice: 800, bob: -800 });
  assert.deepEqual(result.effective, [dinner]);
  assert.deepEqual(result.duplicates, [{ id: dinner.id, reason: "duplicate-ignored", count: 1 }]);
});

test("does not let an unauthorized duplicate shadow an authorized one", () => {
  const unauthorized = { ...dinner, signature: "bad" };
  const context = { ...projectionContext, isEventAuthorized: (event) => event.signature !== "bad" };
  const result = projectLedger({ [dinner.id]: [unauthorized, dinner] }, context);

  assert.deepEqual(result.balances, { alice: 800, bob: -800 });
  assert.deepEqual(result.effective, [dinner]);
  assert.deepEqual(result.quarantined, [{ id: dinner.id, reason: "unauthenticated" }]);
  assert.deepEqual(result.duplicates, []);
});

test("quarantines all valid variants of an ID-content collision", () => {
  const collision = { ...dinner, payload: { ...dinner.payload, description: "Different dinner" } };
  const result = projectLedger(new Map([[dinner.id, [collision, dinner]]]), projectionContext);
  const reordered = projectLedger(new Map([[dinner.id, [dinner, collision]]]), projectionContext);

  assert.deepEqual(result.balances, {});
  assert.deepEqual(result.effective, []);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.quarantined, [{ id: dinner.id, reason: "id-content-collision" }]);
  assert.deepEqual(reordered, result);
});

test("re-evaluates pending events when dependencies arrive", () => {
  const dependencyId = "99999999-9999-4999-8999-999999999999";
  const dependency = { ...taxi, id: dependencyId, payload: { ...taxi.payload, expenseId: "89999999-9999-4999-8999-999999999999" } };
  const dependent = { ...dinner, dependsOn: [dependencyId] };
  const pending = projectLedger({ [dependent.id]: dependent }, projectionContext);
  const complete = projectLedger({ [dependent.id]: dependent, [dependency.id]: dependency }, projectionContext);

  assert.equal(pending.effective.length, 0);
  assert.equal(pending.pending.length, 1);
  assert.deepEqual(complete.pending, []);
  assert.deepEqual(complete.effective.map((event) => event.id), [dependent.id, dependency.id].sort());
  assert.deepEqual(complete, projectLedger(new Map([[dependency.id, dependency], [dependent.id, dependent]]), projectionContext));
});

test("projects a settlement onto only its named participants", () => {
  const payment = settlement({
    id: "55555555-5555-4555-8555-555555555555",
    settlementId: "65555555-5555-4555-8555-555555555555",
    fromParticipantId: "bob",
    toParticipantId: "alice",
    amount: 800
  });
  const result = projectLedger({ [dinner.id]: dinner, [payment.id]: payment }, projectionContext);

  assert.deepEqual(result.balances, { alice: 0, bob: 0 });
  assert.deepEqual(result.effective.map((event) => event.id), [dinner.id, payment.id]);
});

test("reverses a valid settlement exactly", () => {
  const payment = settlement({
    id: "55555555-5555-4555-8555-555555555555",
    settlementId: "65555555-5555-4555-8555-555555555555",
    fromParticipantId: "bob",
    toParticipantId: "alice",
    amount: 800
  });
  const undo = reversal({
    id: "75555555-5555-4555-8555-555555555555",
    settlementId: payment.payload.settlementId,
    reversesEventId: payment.id
  });
  const result = projectLedger({ [undo.id]: undo, [payment.id]: payment }, projectionContext);

  assert.deepEqual(result.balances, { alice: 0, bob: 0 });
  assert.deepEqual(result.effective.map((event) => event.id), [payment.id, undo.id]);
});

test("ignores concurrent duplicate reversals deterministically", () => {
  const payment = settlement({
    id: "55555555-5555-4555-8555-555555555555",
    settlementId: "65555555-5555-4555-8555-555555555555",
    fromParticipantId: "bob",
    toParticipantId: "alice",
    amount: 800
  });
  const firstUndo = reversal({ id: "75555555-5555-4555-8555-555555555555", settlementId: payment.payload.settlementId, reversesEventId: payment.id });
  const secondUndo = reversal({ id: "85555555-5555-4555-8555-555555555555", settlementId: payment.payload.settlementId, reversesEventId: payment.id });
  const result = projectLedger({ [secondUndo.id]: secondUndo, [payment.id]: payment, [firstUndo.id]: firstUndo }, projectionContext);
  const reordered = projectLedger(new Map([[firstUndo.id, firstUndo], [payment.id, payment], [secondUndo.id, secondUndo]]), projectionContext);

  assert.deepEqual(result.balances, { alice: 0, bob: 0 });
  assert.deepEqual(result.effective.map((event) => event.id), [payment.id, firstUndo.id]);
  assert.deepEqual(result.ignored, [{ id: secondUndo.id, reason: "duplicate-reversal-ignored" }]);
  assert.deepEqual(reordered, result);
});

test("quarantines reversals with invalid targets or settlement IDs", () => {
  const payment = settlement({
    id: "55555555-5555-4555-8555-555555555555",
    settlementId: "65555555-5555-4555-8555-555555555555",
    fromParticipantId: "bob",
    toParticipantId: "alice",
    amount: 800
  });
  const wrongTarget = reversal({ id: "75555555-5555-4555-8555-555555555555", settlementId: payment.payload.settlementId, reversesEventId: dinner.id, dependsOn: [dinner.id] });
  const wrongSettlement = reversal({ id: "85555555-5555-4555-8555-555555555555", settlementId: "95555555-5555-4555-8555-555555555555", reversesEventId: payment.id });
  const result = projectLedger({ [dinner.id]: dinner, [payment.id]: payment, [wrongTarget.id]: wrongTarget, [wrongSettlement.id]: wrongSettlement }, projectionContext);

  assert.deepEqual(result.balances, { alice: 0, bob: 0 });
  assert.deepEqual(result.quarantined, [
    { id: wrongTarget.id, reason: "invalid-reference" },
    { id: wrongSettlement.id, reason: "invalid-reference" }
  ]);
});

test("projects only the latest uncontested expense revision", () => {
  const revision = revisedExpense({
    id: "55555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 2400,
    splits: [{ participantId: "alice", amount: 1440 }, { participantId: "bob", amount: 960 }]
  });
  const result = projectLedger({ [revision.id]: revision, [dinner.id]: dinner }, projectionContext);

  assert.deepEqual(result.balances, { alice: 960, bob: -960 });
  assert.deepEqual(result.effective.map((event) => event.id), [revision.id]);
});

test("keeps the full expense chain auditable when a later revision arrives", () => {
  const firstRevision = revisedExpense({
    id: "55555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 2400,
    splits: [{ participantId: "alice", amount: 1440 }, { participantId: "bob", amount: 960 }]
  });
  const latestRevision = revisedExpense({
    id: "65555555-5555-4555-8555-555555555555",
    supersedesEventId: firstRevision.id,
    expenseId: dinner.payload.expenseId,
    amount: 3000,
    splits: [{ participantId: "alice", amount: 1800 }, { participantId: "bob", amount: 1200 }]
  });
  const result = projectLedger({ [latestRevision.id]: latestRevision, [dinner.id]: dinner, [firstRevision.id]: firstRevision }, projectionContext);
  const reordered = projectLedger(new Map([[dinner.id, dinner], [firstRevision.id, firstRevision], [latestRevision.id, latestRevision]]), projectionContext);

  assert.deepEqual(result.balances, { alice: 1200, bob: -1200 });
  assert.deepEqual(result.effective.map((event) => event.id), [latestRevision.id]);
  assert.equal(result.quarantined.length, 0);
  assert.equal(result.effective.some((event) => event.id === dinner.id), false);
  assert.deepEqual(reordered, result);
});

test("voids an expense without deleting its source chain", () => {
  const voided = voidedExpense({ id: "55555555-5555-4555-8555-555555555555", supersedesEventId: dinner.id, expenseId: dinner.payload.expenseId });
  const result = projectLedger({ [voided.id]: voided, [dinner.id]: dinner }, projectionContext);

  assert.deepEqual(result.balances, {});
  assert.deepEqual(result.effective.map((event) => event.id), [voided.id]);
  assert.equal(result.quarantined.length, 0);
  assert.equal(dinner.payload.description, "Dinner");
});

test("diagnoses invalid revision and void references", () => {
  const wrongExpense = revisedExpense({
    id: "55555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: "65555555-5555-4555-8555-555555555555",
    amount: 2400,
    splits: [{ participantId: "alice", amount: 1200 }, { participantId: "bob", amount: 1200 }]
  });
  const wrongTarget = voidedExpense({ id: "75555555-5555-4555-8555-555555555555", supersedesEventId: taxi.id, expenseId: dinner.payload.expenseId });
  const result = projectLedger({ [dinner.id]: dinner, [taxi.id]: taxi, [wrongExpense.id]: wrongExpense, [wrongTarget.id]: wrongTarget }, projectionContext);

  assert.deepEqual(result.balances, { alice: 300, bob: 200, carol: -500 });
  assert.deepEqual(result.quarantined, [
    { id: wrongExpense.id, reason: "invalid-reference" },
    { id: wrongTarget.id, reason: "invalid-reference" }
  ]);
});

test("rejects events outside the trusted group and currency", () => {
  const otherGroup = { ...dinner, groupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const otherCurrency = { ...dinner, payload: { ...dinner.payload, currency: "EUR" } };

  assert.deepEqual(projectLedger({ [otherGroup.id]: otherGroup }, projectionContext).quarantined, [{ id: otherGroup.id, reason: "group-mismatch" }]);
  assert.deepEqual(projectLedger({ [otherCurrency.id]: otherCurrency }, projectionContext).quarantined, [{ id: otherCurrency.id, reason: "currency-mismatch" }]);
});

test("requires trusted projection context", () => {
  assert.throws(
    () => projectLedger({ [dinner.id]: dinner }),
    { name: "TypeError", message: "invalid-projection-context" }
  );
});

test("fails closed when authorization rejects an event", () => {
  const context = { ...projectionContext, isEventAuthorized: () => false };
  const result = projectLedger({ [dinner.id]: dinner }, context);

  assert.deepEqual(result.balances, {});
  assert.deepEqual(result.effective, []);
  assert.deepEqual(result.quarantined, [{ id: dinner.id, reason: "unauthenticated" }]);
});

test("does not let authorization mutate projected events", () => {
  const context = {
    ...projectionContext,
    isEventAuthorized(event) {
      event.payload.amount = 1;
      return true;
    }
  };
  const result = projectLedger({ [dinner.id]: dinner }, context);

  assert.deepEqual(result.balances, { alice: 800, bob: -800 });
  assert.equal(result.effective[0].payload.amount, 2000);
});

test("marks projections with unsupported events read-only", () => {
  const future = { ...taxi, schemaVersion: 2 };
  const result = projectLedger({ [dinner.id]: dinner, [future.id]: future }, projectionContext);

  assert.deepEqual(result.balances, { alice: 800, bob: -800 });
  assert.deepEqual(result.effective, [dinner]);
  assert.deepEqual(result.quarantined, []);
  assert.deepEqual(result.unsupported, [{ id: future.id, reason: "unsupported-version" }]);
  assert.equal(result.readOnly, true);
});

test("quarantines malformed events without blocking valid balances", () => {
  const malformedId = "55555555-5555-4555-8555-555555555555";
  const result = projectLedger({ [dinner.id]: dinner, [malformedId]: { nope: true } }, projectionContext);

  assert.deepEqual(result.balances, { alice: 800, bob: -800 });
  assert.deepEqual(result.effective, [dinner]);
  assert.deepEqual(result.quarantined, [{ id: malformedId, reason: "invalid-envelope" }]);
});

test("quarantines dependency cycles", () => {
  const first = { ...dinner, dependsOn: [taxi.id] };
  const second = { ...taxi, dependsOn: [dinner.id] };
  const result = projectLedger({ [first.id]: first, [second.id]: second }, projectionContext);

  assert.deepEqual(result.balances, {});
  assert.deepEqual(result.effective, []);
  assert.deepEqual(result.pending, []);
  assert.deepEqual(result.quarantined, [
    { id: first.id, reason: "cyclic-dependency" },
    { id: second.id, reason: "cyclic-dependency" }
  ]);
});
