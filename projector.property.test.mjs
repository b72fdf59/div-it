import assert from "node:assert/strict";
import { test } from "node:test";
import { projectLedger } from "./src/ledger.js";

const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const projectionContext = { groupId, currency: "USD", isEventAuthorized: () => true };

function id(number) {
  return `${String(number).padStart(8, "0")}-0000-4000-8000-000000000000`;
}

function event({ id: eventId, type, author = "alice", dependsOn = [], payload }) {
  return {
    id: eventId,
    type,
    schemaVersion: 1,
    protocolVersion: 1,
    groupId,
    author: { participantId: author, deviceId: `device-${author}`, keyId: `key-${author}` },
    createdAt: "2026-09-05T10:00:00.000Z",
    dependsOn,
    payload,
    signature: `signature-${eventId}`
  };
}

function nextRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

function shuffled(values, random) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) {
    const other = Math.floor(random() * (index + 1));
    [result[index], result[other]] = [result[other], result[index]];
  }
  return result;
}

function generatedLedger(seed) {
  const random = nextRandom(seed);
  const amount = () => 100 + Math.floor(random() * 1_900);
  const split = (total, first, second) => [
    { participantId: first, amount: Math.floor(total / 2) },
    { participantId: second, amount: total - Math.floor(total / 2) }
  ];

  const firstAmount = amount();
  const secondAmount = amount();
  const first = event({
    id: id(seed * 100 + 1),
    type: "expense-created",
    author: "alice",
    payload: {
      expenseId: id(seed * 100 + 51),
      description: `Dinner ${seed}`,
      currency: "USD",
      amount: firstAmount,
      payerId: "alice",
      splits: split(firstAmount, "bob", "carol")
    }
  });
  const second = event({
    id: id(seed * 100 + 2),
    type: "expense-created",
    author: "bob",
    payload: {
      expenseId: id(seed * 100 + 52),
      description: `Taxi ${seed}`,
      currency: "USD",
      amount: secondAmount,
      payerId: "bob",
      splits: split(secondAmount, "alice", "dave")
    }
  });
  const firstRevision = event({
    id: id(seed * 100 + 3),
    type: "expense-revised",
    author: "alice",
    dependsOn: [first.id],
    payload: {
      expenseId: first.payload.expenseId,
      supersedesEventId: first.id,
      description: `Revised dinner ${seed}`,
      currency: "USD",
      amount: firstAmount + 20,
      payerId: "alice",
      splits: split(firstAmount + 20, "bob", "carol")
    }
  });
  const secondRevision = event({
    id: id(seed * 100 + 4),
    type: "expense-revised",
    author: "alice",
    dependsOn: [first.id],
    payload: {
      expenseId: first.payload.expenseId,
      supersedesEventId: first.id,
      description: `Alternate dinner ${seed}`,
      currency: "USD",
      amount: firstAmount + 40,
      payerId: "alice",
      splits: split(firstAmount + 40, "bob", "carol")
    }
  });
  const paymentAmount = 25 + Math.floor(random() * 100);
  const payment = event({
    id: id(seed * 100 + 5),
    type: "settlement-recorded",
    author: "carol",
    payload: {
      settlementId: id(seed * 100 + 55),
      currency: "USD",
      fromParticipantId: "carol",
      toParticipantId: "alice",
      amount: paymentAmount
    }
  });
  const reversal = event({
    id: id(seed * 100 + 6),
    type: "settlement-reversed",
    author: "alice",
    dependsOn: [payment.id],
    payload: { settlementId: payment.payload.settlementId, reversesEventId: payment.id, reason: "Correction" }
  });
  const voided = event({
    id: id(seed * 100 + 7),
    type: "expense-voided",
    author: "alice",
    dependsOn: [second.id],
    payload: { expenseId: second.payload.expenseId, supersedesEventId: second.id, reason: "Refunded" }
  });
  const events = [first, second, firstRevision, secondRevision, payment, reversal, voided];

  if (seed % 2 === 0) {
    events.push(event({
      id: id(seed * 100 + 8),
      type: "conflict-resolved",
      author: "alice",
      dependsOn: [firstRevision.id, secondRevision.id].sort(),
      payload: {
        resolutionId: id(seed * 100 + 8),
        expenseId: first.payload.expenseId,
        resolvesEventIds: [firstRevision.id, secondRevision.id].sort(),
        chosenEventId: firstRevision.id,
        supersedesResolutionEventIds: []
      }
    }));
  }

  // The array value models a CRDT duplicate that arrived twice under one ID.
  const duplicate = structuredClone(payment);
  return { events, duplicateId: payment.id, duplicate };
}

function asObject(events, duplicateId, duplicate) {
  const entries = events.map((value) => [value.id, value]);
  const duplicateEntry = entries.findIndex(([eventId]) => eventId === duplicateId);
  entries[duplicateEntry][1] = [entries[duplicateEntry][1], duplicate];
  return Object.fromEntries(entries);
}

function asMap(events, duplicateId, duplicate) {
  return new Map(events.map((value) => [value.id, value.id === duplicateId ? [value, duplicate] : value]));
}

function projectionFingerprint(projection) {
  return {
    balances: projection.balances,
    effective: projection.effective.map(({ id }) => id),
    pending: projection.pending.map(({ event, reason, missingDependencyIds }) => ({ id: event.id, reason, missingDependencyIds })),
    conflicting: projection.conflicting,
    quarantined: projection.quarantined,
    unsupported: projection.unsupported,
    readOnly: projection.readOnly,
    duplicates: projection.duplicates,
    ignored: projection.ignored
  };
}

test("fixed-seed generated ledgers are zero-sum, idempotent, and order-independent", () => {
  for (const seed of [11, 23, 37, 41, 59, 71]) {
    const { events, duplicateId, duplicate } = generatedLedger(seed);
    const expected = projectionFingerprint(projectLedger(asObject(events, duplicateId, duplicate), projectionContext));

    for (let attempt = 0; attempt < 20; attempt++) {
      const ordered = shuffled(events, nextRandom(seed * 1000 + attempt));
      const result = projectLedger(asObject(ordered, duplicateId, duplicate), projectionContext);
      const mapResult = projectLedger(asMap(shuffled(events, nextRandom(seed * 2000 + attempt)), duplicateId, duplicate), projectionContext);

      assert.deepEqual(projectionFingerprint(result), expected, `seed ${seed}, attempt ${attempt}`);
      assert.deepEqual(projectionFingerprint(mapResult), expected, `Map seed ${seed}, attempt ${attempt}`);
      assert.equal(Object.values(result.balances).reduce((sum, value) => sum + value, 0), 0, `seed ${seed}`);
    }
  }
});

test("generated cases exercise duplicates, reversals, voids, and both conflict outcomes", () => {
  for (const seed of [11, 23, 37, 41, 59, 71]) {
    const { events, duplicateId, duplicate } = generatedLedger(seed);
    const result = projectLedger(asObject(events, duplicateId, duplicate), projectionContext);
    assert.deepEqual(result.duplicates, [{ id: duplicateId, reason: "duplicate-ignored", count: 1 }]);
    assert.ok(result.effective.some(({ type }) => type === "settlement-reversed"), `seed ${seed} reversal`);
    assert.ok(result.effective.some(({ type }) => type === "expense-voided"), `seed ${seed} void`);
    assert.ok(result.conflicting.some(({ reason }) => reason === "conflicting-revision") === (seed % 2 === 1), `seed ${seed} conflict`);
    assert.ok(result.effective.some(({ type }) => type === "conflict-resolved") === (seed % 2 === 0), `seed ${seed} resolution`);
  }
});
