import assert from "node:assert/strict";
import { test } from "node:test";
import { parseEvent } from "./src/events.js";
import { generateDeviceSigningKeyPair, verifyRecord } from "./src/identity-crypto.js";
import { createSignedLedgerRecord, parseSignedLedgerRecord, verifySignedLedgerRecord } from "./src/signed-ledger-records.js";

const uuid = (hex) => `${hex.repeat(8)}-${hex.repeat(4)}-4${hex.repeat(3)}-8${hex.repeat(3)}-${hex.repeat(12)}`;
const numberedUuid = (value) => `00000000-0000-4000-8000-${value.toString(16).padStart(12, "0")}`;
const ids = {
  record: "11111111-1111-4111-8111-111111111111",
  group: "22222222-2222-4222-8222-222222222222",
  membershipHead: "33333333-3333-4333-8333-333333333333",
  otherMembershipHead: "44444444-4444-4444-8444-444444444444",
  causalHead: "55555555-5555-4555-8555-555555555555",
  dependency: "66666666-6666-4666-8666-666666666666",
  expense: "77777777-7777-4777-8777-777777777777",
  settlement: "88888888-8888-4888-8888-888888888888",
  import: "99999999-9999-4999-8999-999999999999",
  resolution: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  branchA: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  branchB: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
};

const author = { participantId: "participant-alice", deviceId: "device-alice", keyId: "key-alice" };
const expensePayload = {
  expenseId: ids.expense,
  description: "Dinner",
  currency: "USD",
  amount: 1000,
  payerId: "participant-alice",
  splits: [
    { participantId: "participant-alice", amount: 500 },
    { participantId: "participant-bob", amount: 500 }
  ]
};

function input(type, payload, extra = {}) {
  return {
    id: ids.record,
    type,
    groupId: ids.group,
    author,
    createdAt: "2026-10-08T09:30:00.000Z",
    membershipHeads: [ids.membershipHead],
    causalHeads: [],
    dependsOn: [],
    payload,
    ...extra
  };
}

function validCases() {
  return [
    input("expense-created", expensePayload),
    input("expense-revised", { ...expensePayload, supersedesEventId: ids.dependency }, { dependsOn: [ids.dependency] }),
    input("expense-voided", { expenseId: ids.expense, supersedesEventId: ids.dependency, reason: "Refunded" }, { dependsOn: [ids.dependency] }),
    input("settlement-recorded", {
      settlementId: ids.settlement,
      currency: "USD",
      fromParticipantId: "participant-bob",
      toParticipantId: "participant-alice",
      amount: 500
    }),
    input("settlement-reversed", {
      settlementId: ids.settlement,
      reversesEventId: ids.dependency,
      reason: "Returned"
    }, { dependsOn: [ids.dependency] }),
    input("opening-balances-imported", {
      importId: ids.import,
      currency: "USD",
      sourceFormat: "splitwise-csv",
      balances: [
        { participantId: "participant-alice", amount: 500 },
        { participantId: "participant-bob", amount: -500 }
      ]
    }),
    input("conflict-resolved", {
      resolutionId: ids.resolution,
      expenseId: ids.expense,
      resolvesEventIds: [ids.branchA, ids.branchB],
      chosenEventId: ids.branchB,
      supersedesResolutionEventIds: []
    }, { dependsOn: [ids.branchA, ids.branchB] })
  ];
}

function unsignedFixture(overrides = {}) {
  return {
    ...input("expense-created", expensePayload),
    schemaVersion: 1,
    protocolVersion: 2,
    signature: "A".repeat(86),
    ...overrides
  };
}

test("builds and verifies signed v2 envelopes for every v1 financial event type", async () => {
  const pair = await generateDeviceSigningKeyPair();
  for (const candidate of validCases()) {
    const original = structuredClone(candidate);
    const record = await createSignedLedgerRecord(candidate, pair.privateKey);
    const verified = await verifySignedLedgerRecord(record, pair.publicKey);
    assert.equal(verified.ok, true, candidate.type);
    assert.equal(record.schemaVersion, 1);
    assert.equal(record.protocolVersion, 2);
    assert.deepEqual(record.author, author);
    assert.deepEqual(candidate, original, "builder must not mutate input");
    assert.equal(verified.event.protocolVersion, 1, "only the detached validation view uses protocol v1");
    assert.equal(verified.record.protocolVersion, 2, "the returned signed envelope remains protocol v2");
  }
});

test("signatures cover group, author, payload, and both frontiers", async () => {
  const pair = await generateDeviceSigningKeyPair();
  const signed = await createSignedLedgerRecord(input("expense-created", expensePayload, { causalHeads: [ids.causalHead] }), pair.privateKey);
  const variants = [
    { ...signed, groupId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd" },
    { ...signed, author: { ...signed.author, participantId: "participant-bob" } },
    { ...signed, payload: { ...signed.payload, description: "Changed" } },
    { ...signed, membershipHeads: [ids.otherMembershipHead] },
    { ...signed, causalHeads: [ids.otherMembershipHead] }
  ];
  for (const variant of variants) {
    assert.equal(parseSignedLedgerRecord(variant).ok, true, "tampered variant remains structurally valid");
    assert.equal(await verifyRecord(variant, pair.publicKey), false);
    assert.equal((await verifySignedLedgerRecord(variant, pair.publicKey)).reason, "invalid-signature");
  }
  const tamperedSignature = { ...signed, signature: `${signed.signature.slice(0, -1)}${signed.signature.endsWith("A") ? "B" : "A"}` };
  assert.equal(await verifyRecord(tamperedSignature, pair.publicKey), false);
});

test("returns the original v2 record and a detached v1 structural event", () => {
  const source = unsignedFixture();
  const before = structuredClone(source);
  const parsed = parseSignedLedgerRecord(source);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.record.protocolVersion, 2);
  assert.equal(parsed.event.protocolVersion, 1);
  assert.notEqual(parsed.event, source);
  assert.deepEqual(source, before);
  parsed.event.payload.description = "changed copy";
  assert.equal(source.payload.description, "Dinner");
});

test("rejects unsupported versions, extra fields, invalid IDs, attribution, and frontiers", () => {
  const cases = [
    [unsignedFixture({ protocolVersion: 1 }), "unsupported-version"],
    [unsignedFixture({ schemaVersion: 2 }), "unsupported-version"],
    [unsignedFixture({ extra: true }), "invalid-envelope"],
    [unsignedFixture({ groupId: "not-a-uuid" }), "invalid-id"],
    [unsignedFixture({ author: { ...author, extra: true } }), "invalid-envelope"],
    [unsignedFixture({ author: { ...author, participantId: " " } }), "invalid-envelope"],
    [unsignedFixture({ author: { ...author, deviceId: "d".repeat(129) } }), "invalid-envelope"],
    [unsignedFixture({ membershipHeads: [] }), "invalid-membership-heads"],
    [unsignedFixture({ membershipHeads: [ids.otherMembershipHead, ids.membershipHead] }), "invalid-membership-heads"],
    [unsignedFixture({ membershipHeads: [ids.membershipHead, ids.membershipHead] }), "invalid-membership-heads"],
    [unsignedFixture({ membershipHeads: Array.from({ length: 65 }, (_, index) => numberedUuid(index + 1)) }), "invalid-membership-heads"],
    [unsignedFixture({ causalHeads: [ids.causalHead, ids.membershipHead] }), "invalid-causal-heads"],
    [unsignedFixture({ causalHeads: Array.from({ length: 65 }, (_, index) => numberedUuid(index + 1)) }), "invalid-causal-heads"],
    [unsignedFixture({ dependsOn: [ids.dependency, ids.membershipHead] }), "invalid-reference"],
    [unsignedFixture({ signature: "not-a-signature" }), "invalid-signature"],
    [unsignedFixture({ signature: `${"A".repeat(85)}B` }), "invalid-signature"]
  ];
  for (const [record, reason] of cases) assert.equal(parseSignedLedgerRecord(record).reason, reason);
});

test("reuses v1 payload validation and validates before signing", async () => {
  const invalid = input("expense-created", { ...expensePayload, amount: 999 });
  const record = unsignedFixture({ payload: invalid.payload });
  assert.equal(parseSignedLedgerRecord(record).reason, "split-total-mismatch");
  await assert.rejects(createSignedLedgerRecord(invalid, {}), { message: "split-total-mismatch" });
  await assert.rejects(createSignedLedgerRecord({ ...validCases()[0], causalHeads: null }, {}), { message: "invalid-causal-heads" });

  const badMoney = unsignedFixture({ payload: { ...expensePayload, amount: 0, splits: [{ participantId: "participant-alice", amount: 0 }] } });
  assert.equal(parseSignedLedgerRecord(badMoney).reason, "invalid-money");
  assert.equal(parseSignedLedgerRecord(unsignedFixture({ type: "expense-created", payload: { ...expensePayload, expenseId: "bad-id" } })).reason, "invalid-id");
  assert.equal(parseSignedLedgerRecord(unsignedFixture({ type: "unknown-money-event" })).reason, "unsupported-event-type");
  assert.equal(parseSignedLedgerRecord(unsignedFixture({ payload: { ...expensePayload, currency: "usd" } })).reason, "invalid-payload");

  const badOpeningBalances = {
    importId: ids.import,
    currency: "USD",
    sourceFormat: "splitwise-csv",
    balances: [
      { participantId: "participant-alice", amount: 500 },
      { participantId: "participant-bob", amount: -499 }
    ]
  };
  assert.equal(parseSignedLedgerRecord(unsignedFixture({ type: "opening-balances-imported", payload: badOpeningBalances })).reason, "non-zero-sum");
  assert.equal(parseSignedLedgerRecord(unsignedFixture({
    type: "settlement-recorded",
    payload: { settlementId: ids.settlement, currency: "US", fromParticipantId: "alice", toParticipantId: "bob", amount: 5 }
  })).reason, "invalid-payload");
  assert.equal(parseSignedLedgerRecord(unsignedFixture({
    type: "settlement-reversed",
    payload: { settlementId: ids.settlement, reversesEventId: ids.dependency, reason: "Returned" }
  })).reason, "invalid-reference");
  assert.equal(parseSignedLedgerRecord(unsignedFixture({
    type: "conflict-resolved",
    payload: {
      resolutionId: ids.resolution,
      expenseId: ids.expense,
      resolvesEventIds: [ids.branchB, ids.branchA],
      chosenEventId: ids.branchB,
      supersedesResolutionEventIds: []
    },
    dependsOn: [ids.branchA, ids.branchB]
  })).reason, "invalid-reference");

  const v1 = {
    id: ids.record,
    type: "expense-created",
    schemaVersion: 1,
    protocolVersion: 1,
    groupId: ids.group,
    author,
    createdAt: "2026-10-08T09:30:00.000Z",
    dependsOn: [],
    payload: expensePayload,
    signature: "A".repeat(86)
  };
  assert.equal(parseEvent(v1).ok, true);
  assert.equal(parseSignedLedgerRecord(v1).reason, "invalid-envelope");
});

test("applies the encoded v2 event and dependency size limits", () => {
  const frontier64 = Array.from({ length: 64 }, (_, index) => numberedUuid(index + 1));
  const dependencies256 = Array.from({ length: 256 }, (_, index) => numberedUuid(index + 100));
  assert.equal(parseSignedLedgerRecord(unsignedFixture({ membershipHeads: frontier64, causalHeads: frontier64 })).ok, true);
  assert.equal(parseSignedLedgerRecord(unsignedFixture({ dependsOn: dependencies256 })).ok, true);

  const oversized = JSON.stringify(unsignedFixture()).padEnd(65_537, " ");
  assert.equal(parseSignedLedgerRecord(oversized).reason, "event-too-large");
  const tooManyDependencies = Array.from({ length: 257 }, (_, index) => numberedUuid(index + 1));
  assert.equal(parseSignedLedgerRecord(unsignedFixture({ dependsOn: tooManyDependencies })).reason, "event-too-large");
});
