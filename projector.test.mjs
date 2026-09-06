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

function conflictResolution({ id, expenseId, resolvesEventIds, chosenEventId, supersedesResolutionEventIds = [] }) {
  const dependsOn = [...resolvesEventIds, ...supersedesResolutionEventIds].sort();
  return {
    id,
    type: "conflict-resolved",
    schemaVersion: 1,
    protocolVersion: 1,
    groupId,
    author: { participantId: "alice", deviceId: "device-alice", keyId: "key-alice" },
    createdAt: "2026-09-05T10:00:00.000Z",
    dependsOn,
    payload: { resolutionId: id, expenseId, resolvesEventIds, chosenEventId, supersedesResolutionEventIds },
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
    conflicting: [],
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
    balances: {}, effective: [], pending: [], conflicting: [], quarantined: [], unsupported: [], readOnly: false, duplicates: [], ignored: []
  });
});

test("uses overflow-safe arithmetic when later events return balances to a safe range", () => {
  const maximumExpense = expense({
    id: "11111111-1111-4111-8111-111111111112",
    expenseId: "21111111-1111-4111-8111-111111111112",
    description: "Maximum safe expense",
    payerId: "alice",
    amount: Number.MAX_SAFE_INTEGER,
    splits: [{ participantId: "bob", amount: Number.MAX_SAFE_INTEGER }]
  });
  const payment = settlement({
    id: "51111111-1111-4111-8111-111111111112",
    settlementId: "61111111-1111-4111-8111-111111111112",
    fromParticipantId: "bob",
    toParticipantId: "alice",
    amount: Number.MAX_SAFE_INTEGER
  });
  const undo = reversal({
    id: "31111111-1111-4111-8111-111111111112",
    settlementId: payment.payload.settlementId,
    reversesEventId: payment.id
  });
  const result = projectLedger({ [payment.id]: payment, [undo.id]: undo, [maximumExpense.id]: maximumExpense }, projectionContext);

  assert.deepEqual(result.balances, { alice: Number.MAX_SAFE_INTEGER, bob: -Number.MAX_SAFE_INTEGER });
  assert.deepEqual(result.effective.map((event) => event.id), [maximumExpense.id, undo.id, payment.id]);
  assert.deepEqual(result.quarantined, []);
});

test("quarantines money events whose combined balances cannot be represented safely", () => {
  const first = expense({
    id: "11111111-1111-4111-8111-111111111112",
    expenseId: "21111111-1111-4111-8111-111111111112",
    description: "First maximum expense",
    payerId: "alice",
    amount: Number.MAX_SAFE_INTEGER,
    splits: [{ participantId: "bob", amount: Number.MAX_SAFE_INTEGER }]
  });
  const second = expense({
    id: "31111111-1111-4111-8111-111111111112",
    expenseId: "41111111-1111-4111-8111-111111111112",
    description: "Second maximum expense",
    payerId: "alice",
    amount: Number.MAX_SAFE_INTEGER,
    splits: [{ participantId: "bob", amount: Number.MAX_SAFE_INTEGER }]
  });
  const result = projectLedger({ [second.id]: second, [first.id]: first }, projectionContext);

  assert.deepEqual(result.balances, {});
  assert.deepEqual(result.effective, []);
  assert.deepEqual(result.quarantined, [first.id, second.id].map((id) => ({ id, reason: "balance-overflow" })));
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

test("quarantines different envelopes that reuse a logical ID even when their payloads match", () => {
  const alias = { ...structuredClone(dinner), id: "21111111-1111-4111-8111-111111111112", signature: "signature-expense-alias" };
  const revision = revisedExpense({
    id: "51111111-1111-4111-8111-111111111111",
    supersedesEventId: alias.id,
    expenseId: dinner.payload.expenseId,
    amount: 2400,
    splits: [{ participantId: "alice", amount: 1440 }, { participantId: "bob", amount: 960 }]
  });
  const result = projectLedger({ [revision.id]: revision, [alias.id]: alias, [dinner.id]: dinner }, projectionContext);

  assert.deepEqual(result.balances, {});
  assert.deepEqual(result.effective, []);
  assert.deepEqual(result.pending.map(({ event }) => event.id), [revision.id]);
  assert.deepEqual(result.duplicates, []);
  assert.deepEqual(result.quarantined, [dinner.id, alias.id].sort().map((id) => ({ id, reason: "logical-id-content-collision" })));
});

test("quarantines conflicting logical expense creators and blocks their dependents", () => {
  const collision = expense({
    id: "21111111-1111-4111-8111-111111111112",
    expenseId: dinner.payload.expenseId,
    description: "Different dinner",
    payerId: "alice",
    amount: 3000,
    splits: [{ participantId: "alice", amount: 1800 }, { participantId: "bob", amount: 1200 }]
  });
  const revision = revisedExpense({
    id: "51111111-1111-4111-8111-111111111111",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 2400,
    splits: [{ participantId: "alice", amount: 1440 }, { participantId: "bob", amount: 960 }]
  });
  const result = projectLedger({ [revision.id]: revision, [collision.id]: collision, [dinner.id]: dinner, [taxi.id]: taxi }, projectionContext);

  assert.deepEqual(result.balances, { alice: -500, bob: 1000, carol: -500 });
  assert.deepEqual(result.effective.map((event) => event.id), [taxi.id]);
  assert.deepEqual(result.pending.map(({ event }) => event.id), [revision.id]);
  assert.deepEqual(result.quarantined, [dinner.id, collision.id].sort().map((id) => ({ id, reason: "logical-id-content-collision" })));
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

test("quarantines settlements that reuse one logical ID with different content", () => {
  const first = settlement({
    id: "55555555-5555-4555-8555-555555555555",
    settlementId: "65555555-5555-4555-8555-555555555555",
    fromParticipantId: "bob",
    toParticipantId: "alice",
    amount: 800
  });
  const second = settlement({
    id: "75555555-5555-4555-8555-555555555555",
    settlementId: first.payload.settlementId,
    fromParticipantId: "alice",
    toParticipantId: "bob",
    amount: 300
  });
  const undo = reversal({ id: "85555555-5555-4555-8555-555555555555", settlementId: first.payload.settlementId, reversesEventId: first.id });
  const result = projectLedger({ [undo.id]: undo, [second.id]: second, [first.id]: first }, projectionContext);

  assert.deepEqual(result.balances, {});
  assert.deepEqual(result.effective, []);
  assert.deepEqual(result.pending.map(({ event }) => event.id), [undo.id]);
  assert.deepEqual(result.quarantined, [first.id, second.id].map((id) => ({ id, reason: "logical-id-content-collision" })));
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

test("keeps the last uncontested expense effective during a revision conflict", () => {
  const firstBranch = revisedExpense({
    id: "55555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 2400,
    splits: [{ participantId: "alice", amount: 1440 }, { participantId: "bob", amount: 960 }]
  });
  const secondBranch = revisedExpense({
    id: "65555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 3000,
    splits: [{ participantId: "alice", amount: 1800 }, { participantId: "bob", amount: 1200 }]
  });
  const result = projectLedger({ [secondBranch.id]: secondBranch, [dinner.id]: dinner, [firstBranch.id]: firstBranch }, projectionContext);
  const reordered = projectLedger(new Map([[firstBranch.id, firstBranch], [secondBranch.id, secondBranch], [dinner.id, dinner]]), projectionContext);

  assert.deepEqual(result.balances, { alice: 800, bob: -800 });
  assert.deepEqual(result.effective.map((event) => event.id), [dinner.id]);
  assert.deepEqual(result.conflicting, [
    { id: firstBranch.id, reason: "conflicting-revision" },
    { id: secondBranch.id, reason: "conflicting-revision" }
  ]);
  assert.deepEqual(reordered, result);
});

test("applies a resolution to exactly one revision branch", () => {
  const firstBranch = revisedExpense({
    id: "55555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 2400,
    splits: [{ participantId: "alice", amount: 1440 }, { participantId: "bob", amount: 960 }]
  });
  const secondBranch = revisedExpense({
    id: "65555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 3000,
    splits: [{ participantId: "alice", amount: 1800 }, { participantId: "bob", amount: 1200 }]
  });
  const resolution = conflictResolution({
    id: "75555555-5555-4555-8555-555555555555",
    expenseId: dinner.payload.expenseId,
    resolvesEventIds: [firstBranch.id, secondBranch.id],
    chosenEventId: secondBranch.id
  });
  const result = projectLedger({ [resolution.id]: resolution, [firstBranch.id]: firstBranch, [dinner.id]: dinner, [secondBranch.id]: secondBranch }, projectionContext);

  assert.deepEqual(result.balances, { alice: 1200, bob: -1200 });
  assert.deepEqual(result.effective.map((event) => event.id), [secondBranch.id, resolution.id]);
  assert.deepEqual(result.quarantined, []);
});

test("does not accept a resolution for an incomplete or unrelated branch set", () => {
  const firstBranch = revisedExpense({
    id: "55555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 2400,
    splits: [{ participantId: "alice", amount: 1440 }, { participantId: "bob", amount: 960 }]
  });
  const secondBranch = revisedExpense({
    id: "65555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 3000,
    splits: [{ participantId: "alice", amount: 1800 }, { participantId: "bob", amount: 1200 }]
  });
  const invalidResolution = conflictResolution({
    id: "75555555-5555-4555-8555-555555555555",
    expenseId: dinner.payload.expenseId,
    resolvesEventIds: [taxi.id, firstBranch.id],
    chosenEventId: firstBranch.id
  });
  const result = projectLedger({ [invalidResolution.id]: invalidResolution, [firstBranch.id]: firstBranch, [dinner.id]: dinner, [secondBranch.id]: secondBranch, [taxi.id]: taxi }, projectionContext);

  assert.deepEqual(result.balances, { alice: 300, bob: 200, carol: -500 });
  assert.deepEqual(result.conflicting, [
    { id: firstBranch.id, reason: "conflicting-revision" },
    { id: secondBranch.id, reason: "conflicting-revision" }
  ]);
  assert.deepEqual(result.quarantined, [
    { id: invalidResolution.id, reason: "invalid-resolution" }
  ]);
});

test("requires a later resolution to supersede competing resolution attempts", () => {
  const firstBranch = revisedExpense({
    id: "55555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 2400,
    splits: [{ participantId: "alice", amount: 1440 }, { participantId: "bob", amount: 960 }]
  });
  const secondBranch = revisedExpense({
    id: "65555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 3000,
    splits: [{ participantId: "alice", amount: 1800 }, { participantId: "bob", amount: 1200 }]
  });
  const firstResolution = conflictResolution({
    id: "75555555-5555-4555-8555-555555555555",
    expenseId: dinner.payload.expenseId,
    resolvesEventIds: [firstBranch.id, secondBranch.id],
    chosenEventId: firstBranch.id
  });
  const secondResolution = conflictResolution({
    id: "85555555-5555-4555-8555-555555555555",
    expenseId: dinner.payload.expenseId,
    resolvesEventIds: [firstBranch.id, secondBranch.id],
    chosenEventId: secondBranch.id
  });
  const finalResolution = conflictResolution({
    id: "95555555-5555-4555-8555-555555555555",
    expenseId: dinner.payload.expenseId,
    resolvesEventIds: [firstBranch.id, secondBranch.id],
    chosenEventId: firstBranch.id,
    supersedesResolutionEventIds: [firstResolution.id, secondResolution.id]
  });
  const unresolved = projectLedger({ [dinner.id]: dinner, [firstBranch.id]: firstBranch, [secondBranch.id]: secondBranch, [firstResolution.id]: firstResolution, [secondResolution.id]: secondResolution }, projectionContext);
  const resolved = projectLedger({ [finalResolution.id]: finalResolution, [secondResolution.id]: secondResolution, [dinner.id]: dinner, [firstBranch.id]: firstBranch, [secondBranch.id]: secondBranch, [firstResolution.id]: firstResolution }, projectionContext);

  assert.deepEqual(unresolved.balances, { alice: 800, bob: -800 });
  assert.deepEqual(unresolved.effective.map((event) => event.id), [dinner.id]);
  assert.deepEqual(unresolved.conflicting, [
    { id: firstBranch.id, reason: "conflicting-revision" },
    { id: secondBranch.id, reason: "conflicting-revision" },
    { id: firstResolution.id, reason: "conflicting-resolution" },
    { id: secondResolution.id, reason: "conflicting-resolution" }
  ]);
  assert.deepEqual(unresolved.quarantined, []);
  assert.deepEqual(resolved.balances, { alice: 960, bob: -960 });
  assert.deepEqual(resolved.effective.map((event) => event.id), [firstBranch.id, finalResolution.id]);
  assert.deepEqual(resolved.quarantined, []);
});

test("does not resolve a disputed choice by superseding only one competing attempt", () => {
  const firstBranch = revisedExpense({
    id: "55555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 2400,
    splits: [{ participantId: "alice", amount: 1440 }, { participantId: "bob", amount: 960 }]
  });
  const secondBranch = revisedExpense({
    id: "65555555-5555-4555-8555-555555555555",
    supersedesEventId: dinner.id,
    expenseId: dinner.payload.expenseId,
    amount: 3000,
    splits: [{ participantId: "alice", amount: 1800 }, { participantId: "bob", amount: 1200 }]
  });
  const firstResolution = conflictResolution({
    id: "75555555-5555-4555-8555-555555555555",
    expenseId: dinner.payload.expenseId,
    resolvesEventIds: [firstBranch.id, secondBranch.id],
    chosenEventId: firstBranch.id
  });
  const secondResolution = conflictResolution({
    id: "85555555-5555-4555-8555-555555555555",
    expenseId: dinner.payload.expenseId,
    resolvesEventIds: [firstBranch.id, secondBranch.id],
    chosenEventId: secondBranch.id
  });
  const partialResolution = conflictResolution({
    id: "95555555-5555-4555-8555-555555555555",
    expenseId: dinner.payload.expenseId,
    resolvesEventIds: [firstBranch.id, secondBranch.id],
    chosenEventId: secondBranch.id,
    supersedesResolutionEventIds: [firstResolution.id]
  });
  const result = projectLedger(Object.fromEntries([
    dinner,
    firstBranch,
    secondBranch,
    firstResolution,
    secondResolution,
    partialResolution
  ].map((event) => [event.id, event])), projectionContext);

  assert.deepEqual(result.balances, { alice: 800, bob: -800 });
  assert.deepEqual(result.effective.map((event) => event.id), [dinner.id]);
  assert.deepEqual(result.conflicting, [
    { id: firstBranch.id, reason: "conflicting-revision" },
    { id: secondBranch.id, reason: "conflicting-revision" },
    ...[secondResolution.id, partialResolution.id].sort().map((id) => ({ id, reason: "conflicting-resolution" }))
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

test("does not let untrusted unsupported events force read-only mode", () => {
  const future = { ...taxi, schemaVersion: 2 };
  const unauthorized = projectLedger({ [future.id]: future }, { ...projectionContext, isEventAuthorized: () => false });
  const otherGroup = { ...future, groupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };
  const foreign = projectLedger({ [otherGroup.id]: otherGroup }, projectionContext);

  assert.equal(unauthorized.readOnly, false);
  assert.deepEqual(unauthorized.unsupported, []);
  assert.deepEqual(unauthorized.quarantined, [{ id: future.id, reason: "unauthenticated" }]);
  assert.equal(foreign.readOnly, false);
  assert.deepEqual(foreign.unsupported, []);
  assert.deepEqual(foreign.quarantined, [{ id: otherGroup.id, reason: "group-mismatch" }]);
});

test("projects opening balances and keeps them in the audit trail", () => {
  const imported = {
    ...structuredClone(dinner),
    id: "71111111-1111-4111-8111-111111111111",
    type: "opening-balances-imported",
    payload: {
      importId: "81111111-1111-4111-8111-111111111111",
      currency: "USD",
      sourceFormat: "splitwise-csv",
      balances: [
        { participantId: "alice", amount: 766 },
        { participantId: "bob", amount: -766 }
      ]
    },
    signature: "signature-opening-balances"
  };
  const result = projectLedger({ [imported.id]: imported }, projectionContext);

  assert.deepEqual(result.balances, { alice: 766, bob: -766 });
  assert.deepEqual(result.effective, [imported]);
  assert.deepEqual(result.quarantined, []);
});

test("quarantines malformed events without blocking valid balances", () => {
  const malformedId = "55555555-5555-4555-8555-555555555555";
  const result = projectLedger({ [dinner.id]: dinner, [malformedId]: { nope: true } }, projectionContext);

  assert.deepEqual(result.balances, { alice: 800, bob: -800 });
  assert.deepEqual(result.effective, [dinner]);
  assert.deepEqual(result.quarantined, [{ id: malformedId, reason: "invalid-envelope" }]);
});

test("stops before projecting an excessive number of event envelopes", () => {
  const variants = Array.from({ length: 10_001 }, () => dinner);
  const result = projectLedger({ [dinner.id]: variants }, projectionContext);

  assert.deepEqual(result, {
    balances: {},
    effective: [],
    pending: [],
    conflicting: [],
    quarantined: [{ id: "ledger", reason: "ledger-too-large" }],
    unsupported: [],
    readOnly: true,
    duplicates: [],
    ignored: []
  });
});

test("does not fully materialize an oversized event Map before stopping", () => {
  class OversizedMap extends Map {
    *entries() {
      for (let index = 0; index <= 10_000; index++) yield [`event-${index}`, dinner];
      throw new Error("read beyond ledger event limit");
    }
  }

  const result = projectLedger(new OversizedMap(), projectionContext);

  assert.equal(result.readOnly, true);
  assert.deepEqual(result.quarantined, [{ id: "ledger", reason: "ledger-too-large" }]);
});

test("stops before projecting excessive aggregate event bytes", () => {
  const oversizedLedger = new Map();
  const encoded = JSON.stringify(dinner).padEnd(65_536, " ");
  for (let index = 0; index < 129; index++) oversizedLedger.set(`event-${index}`, encoded);
  const result = projectLedger(oversizedLedger, projectionContext);

  assert.equal(result.readOnly, true);
  assert.deepEqual(result.quarantined, [{ id: "ledger", reason: "ledger-too-large" }]);
  assert.deepEqual(result.balances, {});
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
