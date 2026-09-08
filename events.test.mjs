import assert from "node:assert/strict";
import { test } from "node:test";
import { EVENT_TYPES, parseEvent } from "./src/events.js";

const ids = {
  event: "11111111-1111-4111-8111-111111111111",
  group: "22222222-2222-4222-8222-222222222222",
  expense: "33333333-3333-4333-8333-333333333333",
  dependency: "44444444-4444-4444-8444-444444444444",
  secondDependency: "55555555-5555-4555-8555-555555555555"
};

function envelope(type, payload, overrides = {}) {
  return {
    id: ids.event,
    type,
    schemaVersion: 1,
    protocolVersion: 1,
    groupId: ids.group,
    author: { participantId: "participant-alice", deviceId: "device-alice-phone", keyId: "key-device-alice-phone-v1" },
    createdAt: "2026-09-05T10:00:00.000Z",
    dependsOn: [],
    payload,
    signature: "structural-signature",
    ...overrides
  };
}

const createdPayload = {
  expenseId: ids.expense,
  description: "Dinner",
  currency: "USD",
  amount: 2000,
  payerId: "participant-alice",
  splits: [
    { participantId: "participant-alice", amount: 1234 },
    { participantId: "participant-bob", amount: 766 }
  ]
};

function reasonFor(event, options) {
  const result = parseEvent(event, options);
  assert.equal(result.ok, false);
  return result.reason;
}

test("parses a valid fixture into a detached stable shape", () => {
  const input = envelope("expense-created", createdPayload);
  const result = parseEvent(JSON.stringify(input));

  assert.equal(result.ok, true);
  assert.deepEqual(result.event, input);
  assert.notEqual(result.event.payload, input.payload);
  assert.deepEqual(Object.keys(result.event), ["id", "type", "schemaVersion", "protocolVersion", "groupId", "author", "createdAt", "dependsOn", "payload", "signature"]);
});

test("accepts all seven version-one payload shapes", () => {
  const dependent = { dependsOn: [ids.dependency] };
  const fixtures = [
    envelope("expense-created", createdPayload),
    envelope("expense-revised", { ...createdPayload, supersedesEventId: ids.dependency }, dependent),
    envelope("expense-voided", { expenseId: ids.expense, supersedesEventId: ids.dependency, reason: "Refunded" }, dependent),
    envelope("settlement-recorded", { settlementId: ids.expense, currency: "USD", fromParticipantId: "participant-bob", toParticipantId: "participant-alice", amount: 766 }),
    envelope("settlement-reversed", { settlementId: ids.expense, reversesEventId: ids.dependency, reason: "Returned" }, dependent),
    envelope("opening-balances-imported", { importId: ids.expense, currency: "USD", sourceFormat: "splitwise-csv", balances: [{ participantId: "participant-alice", amount: 766 }, { participantId: "participant-bob", amount: -766 }] }),
    envelope("conflict-resolved", { resolutionId: ids.expense, expenseId: ids.group, resolvesEventIds: [ids.dependency, ids.secondDependency], chosenEventId: ids.dependency, supersedesResolutionEventIds: [] }, { dependsOn: [ids.dependency, ids.secondDependency] })
  ];

  for (const fixture of fixtures) assert.equal(parseEvent(fixture).ok, true, fixture.type);
});

test("returns stable reasons for unsupported and malformed envelopes", () => {
  assert.equal(reasonFor(envelope("future-event", {})), "unsupported-event-type");
  assert.equal(reasonFor(envelope("expense-created", createdPayload, { schemaVersion: 2 })), "unsupported-version");
  assert.equal(reasonFor(envelope("expense-created", createdPayload, { id: "NOT-A-UUID" })), "invalid-id");
  assert.equal(reasonFor(envelope("expense-created", createdPayload, { createdAt: "2026-02-30T10:00:00Z" })), "invalid-envelope");
  const unsigned = envelope("expense-created", createdPayload);
  delete unsigned.signature;
  assert.equal(reasonFor(unsigned), "unauthenticated");
  assert.equal(reasonFor("{"), "invalid-json");
});

test("validates dependency references without event-set state", () => {
  const revision = envelope("expense-revised", { ...createdPayload, supersedesEventId: ids.dependency }, { dependsOn: [ids.dependency] });
  assert.equal(parseEvent(revision).ok, true);
  assert.equal(reasonFor({ ...revision, dependsOn: [] }), "invalid-reference");
  assert.equal(reasonFor({ ...revision, dependsOn: [ids.dependency, ids.dependency] }), "invalid-reference");
});

test("rejects invalid money and expense split invariants", () => {
  assert.equal(reasonFor(envelope("expense-created", { ...createdPayload, amount: 10.5 })), "invalid-money");
  assert.equal(reasonFor(envelope("expense-created", { ...createdPayload, amount: 1999 })), "split-total-mismatch");
  assert.equal(reasonFor(envelope("expense-created", { ...createdPayload, splits: [{ participantId: "participant-alice", amount: 1000 }, { participantId: "participant-alice", amount: 1000 }] })), "duplicate-participant");
});

test("rejects non-zero-sum opening balances", () => {
  const payload = { importId: ids.expense, currency: "USD", sourceFormat: "splitwise-csv", balances: [{ participantId: "participant-alice", amount: 766 }, { participantId: "participant-bob", amount: -765 }] };
  assert.equal(reasonFor(envelope("opening-balances-imported", payload)), "non-zero-sum");
});

test("does not mutate object input", () => {
  const input = envelope("expense-created", createdPayload);
  const before = structuredClone(input);
  parseEvent(input);
  assert.deepEqual(input, before);
});

test("does not expose a mutable event-type registry", () => {
  assert.equal(Object.isFrozen(EVENT_TYPES), true);
  assert.throws(() => EVENT_TYPES.push("forged"), TypeError);
  assert.equal(reasonFor(envelope("forged", {})), "unsupported-event-type");
});

test("rejects events that exceed mobile-safe resource limits", () => {
  assert.equal(reasonFor(envelope("expense-created", createdPayload, { signature: "a".repeat(513) })), "event-too-large");
  assert.equal(reasonFor(envelope("expense-created", createdPayload, { createdAt: "2026-09-05T10:00:00.1234567890Z" })), "event-too-large");

  const oversizedSplits = Array.from({ length: 257 }, (_, index) => ({ participantId: `participant-${index}`, amount: 1 }));
  assert.equal(reasonFor(envelope("expense-created", { ...createdPayload, amount: 257, splits: oversizedSplits })), "event-too-large");

  const encoded = JSON.stringify(envelope("expense-created", createdPayload)).padEnd(65_537, " ");
  assert.equal(reasonFor(encoded), "event-too-large");

  const oversizedObject = envelope("expense-created", {
    ...createdPayload,
    amount: 256,
    splits: Array.from({ length: 256 }, (_, index) => ({ participantId: `${index}-${"😀".repeat(120)}`, amount: 1 }))
  });
  assert.equal(reasonFor(oversizedObject), "event-too-large");

  const failOnTraversal = new Proxy(Array(257), {
    get(target, property, receiver) {
      if (property === "every") throw new Error("oversized collection was traversed");
      return Reflect.get(target, property, receiver);
    }
  });
  assert.equal(reasonFor(envelope("expense-created", createdPayload, { dependsOn: failOnTraversal })), "event-too-large");

  const resolution = envelope("conflict-resolved", {
    resolutionId: ids.expense,
    expenseId: ids.group,
    resolvesEventIds: failOnTraversal,
    chosenEventId: ids.dependency,
    supersedesResolutionEventIds: []
  });
  assert.equal(reasonFor(resolution), "event-too-large");
});
