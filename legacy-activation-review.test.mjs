import assert from "node:assert/strict";
import { test } from "node:test";
import { prepareLegacyActivationReview } from "./src/legacy-activation-review.js";
import { expenseEnvelope, projectGroup, settlementEnvelope } from "./src/prototype-events.js";

const groupId = "123e4567-e89b-42d3-a456-426614174000";
const alice = "participant-alice";
const bob = "participant-bob";
const id = (suffix) => `123e4567-e89b-42d3-a456-${suffix.padStart(12, "0")}`;

function expense({ expenseId = id("1"), amount = 1000, description = "Dinner", payerId = alice } = {}) {
  return { id: expenseId, type: "expense-created", description, amount, payerId, createdAt: "2026-10-01T12:00:00.000Z",
    splits: [{ personId: alice, amount: amount / 2 }, { personId: bob, amount: amount / 2 }] };
}

function source(events = []) {
  return { name: "Trip", currency: "USD", groupId, people: [{ id: alice, name: "Alice" }, { id: bob, name: "Bob" }], events };
}

test("legacy review projects exact zero-sum balances without mutating or trusting source events", async () => {
  const legacy = expense();
  const input = source([legacy]);
  const before = structuredClone(input);
  const review = await prepareLegacyActivationReview(input);
  assert.equal(review.activationReady, true);
  assert.equal(review.legacyUnverified, true);
  assert.equal(review.currency, "USD");
  assert.deepEqual(review.participants, [{ participantId: alice, name: "Alice" }, { participantId: bob, name: "Bob" }]);
  assert.deepEqual(review.openingBalances, [{ participantId: alice, amount: 500 }, { participantId: bob, amount: -500 }]);
  assert.equal(review.legacyEventCount, 1);
  assert.deepEqual(input, before);
  assert.deepEqual(review.archive, {
    kind: "canonical-object", mediaType: "application/json", canonicalization: "RFC 8785",
    bytes: review.archive.bytes
  });
  assert.equal(review.archive.bytes instanceof Uint8Array, true);
  assert.deepEqual(review.digest, { algorithm: "SHA-256", encoding: "base64url-no-padding", value: review.digest.value });
  assert.equal("signature" in review, false);
});

test("event arrays and scalar event stores use the same existing projection", async () => {
  const oldExpense = expense({ expenseId: id("2"), amount: 2000 });
  const arrayReview = await prepareLegacyActivationReview(source([oldExpense]));
  const envelope = expenseEnvelope(expense({ expenseId: id("6"), amount: 600 }), { groupId, currency: "USD" });
  const versionedArraySource = source([oldExpense, envelope]);
  const versionedArrayReview = await prepareLegacyActivationReview(versionedArraySource);
  const scalarSource = {
    name: "Trip", currency: "USD", groupId, people: source().people,
    eventsById: { [oldExpense.id]: JSON.stringify(oldExpense) }
  };
  const scalarReview = await prepareLegacyActivationReview(scalarSource);
  assert.equal(arrayReview.activationReady, true);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(arrayReview.archive.bytes)).events, [oldExpense]);
  assert.equal(versionedArrayReview.activationReady, true);
  assert.equal(versionedArrayReview.legacyEventCount, 2);
  assert.deepEqual(versionedArrayReview.openingBalances, [{ participantId: alice, amount: 1300 }, { participantId: bob, amount: -1300 }]);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(versionedArrayReview.archive.bytes)).events, versionedArraySource.events,
    "canonical archive retains exact source event IDs and raw envelope values");
  assert.equal(scalarReview.activationReady, true);
  assert.deepEqual(scalarReview.openingBalances, [{ participantId: alice, amount: 1000 }, { participantId: bob, amount: -1000 }]);
  assert.equal(scalarReview.legacyEventCount, 1);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(scalarReview.archive.bytes)), scalarSource,
    "scalar source representation remains archived without rewriting event IDs or content");

  const mixed = await prepareLegacyActivationReview({
    ...source([oldExpense]), eventsById: { mirror: JSON.stringify(oldExpense), second: JSON.stringify(expense({ expenseId: id("3") })) }
  });
  assert.equal(mixed.activationReady, true);
  assert.equal(mixed.legacyEventCount, 2, "the normal legacy-array mirror is read once, while the independent map event remains");
  assert.deepEqual(mixed.openingBalances, [{ participantId: alice, amount: 1500 }, { participantId: bob, amount: -1500 }]);
});

test("supplied archive bytes are preserved and must parse to exactly the reviewed source", async () => {
  const input = source([expense()]);
  const bytes = new TextEncoder().encode(JSON.stringify(input, null, 2));
  const review = await prepareLegacyActivationReview(input, { rawArchiveBytes: bytes });
  assert.equal(review.activationReady, true);
  assert.equal(review.archive.kind, "original-bytes");
  assert.deepEqual(review.archive.bytes, bytes);
  const mismatch = await prepareLegacyActivationReview({ ...input, name: "Changed" }, { rawArchiveBytes: bytes });
  assert.equal(mismatch.activationReady, false);
  assert.equal(mismatch.digest, null);
  assert.deepEqual(mismatch.archive.bytes, bytes, "mismatched raw bytes remain available for diagnosis");
  assert.equal(mismatch.blockers[0].reason, "raw-archive-source-mismatch");
});

test("malformed, unsupported, and incompatible event records block the draft without dropping diagnostics", async () => {
  const malformed = await prepareLegacyActivationReview(source([null]));
  assert.equal(malformed.activationReady, false);
  assert.equal(malformed.blockers.length > 0, true);
  assert.equal(malformed.legacyEventCount, 1);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(malformed.archive.bytes)).events, [null]);

  const unsupportedRecord = { id: id("5"), type: "expense-created", schemaVersion: 2, protocolVersion: 9, groupId,
    author: { participantId: alice, deviceId: "legacy", keyId: "legacy" }, createdAt: "2026-10-01T12:00:00.000Z",
    dependsOn: [], payload: {}, signature: "development-only" };
  const unsupported = await prepareLegacyActivationReview(source([unsupportedRecord]));
  assert.equal(unsupported.activationReady, false);
  assert.equal(unsupported.diagnostics.some(({ status }) => status === "unsupported"), true);

  const collisionA = { ...expense(), id: id("4") };
  const collisionB = { ...collisionA, amount: 1200, splits: [{ personId: alice, amount: 600 }, { personId: bob, amount: 600 }] };
  const collision = await prepareLegacyActivationReview(source([collisionA, collisionB]));
  assert.equal(collision.activationReady, false);
  assert.equal(collision.diagnostics.some(({ reason }) => reason === "id-content-collision"), true);
  assert.equal(collision.legacyEventCount, 2);
});

test("malformed JSON group shapes return blocked drafts instead of throwing", async () => {
  const cases = [null, [], "not a group", { name: "Trip", currency: "USD", people: {}, events: [] },
    { name: "Trip", currency: "USD", people: "Alice", events: [] }];
  for (const input of cases) {
    const review = await prepareLegacyActivationReview(input);
    assert.equal(review.legacyUnverified, true);
    assert.equal(review.activationReady, false);
    assert.equal(review.blockers.length > 0, true);
    assert.deepEqual(review.openingBalances, []);
  }
});

test("zero-sum opening balances for unknown participants block instead of disappearing", async () => {
  const event = settlementEnvelope({
    type: "opening-balances-imported",
    id: id("7"),
    groupId,
    payload: {
      importId: id("8"), currency: "USD", sourceFormat: "splitwise-csv",
      balances: [{ participantId: "unknown-one", amount: 100 }, { participantId: "unknown-two", amount: -100 }]
    }
  });
  const review = await prepareLegacyActivationReview(source([event]));
  assert.equal(review.activationReady, false);
  assert.equal(review.diagnostics.some(({ reason }) => reason === "unknown-balance-participant"), true);
  assert.deepEqual(review.openingBalances, [{ participantId: alice, amount: 0 }, { participantId: bob, amount: 0 }]);

  const offsetEvents = [
    settlementEnvelope({ type: "opening-balances-imported", id: id("9"), groupId,
      payload: { importId: id("10"), currency: "USD", sourceFormat: "splitwise-csv",
        balances: [{ participantId: "unlisted", amount: 100 }, { participantId: alice, amount: -100 }] } }),
    settlementEnvelope({ type: "opening-balances-imported", id: id("11"), groupId,
      payload: { importId: id("12"), currency: "USD", sourceFormat: "splitwise-csv",
        balances: [{ participantId: "unlisted", amount: -100 }, { participantId: alice, amount: 100 }] } })
  ];
  const projection = projectGroup({ ...source(offsetEvents), events: offsetEvents });
  assert.deepEqual(projection.balances, { [alice]: 0, unlisted: 0 }, "the existing projector retains a zero-net unlisted balance key");
  assert.deepEqual(projection.quarantined, [], "the prototype projector does not reject these opening-balance references");
  const offsetReview = await prepareLegacyActivationReview(source(offsetEvents));
  assert.equal(offsetReview.activationReady, false);
  assert.equal(offsetReview.diagnostics.some(({ reason, id: participantId }) => reason === "unknown-balance-participant" && participantId === "unlisted"), true);
});

test("fixed canonical digest vectors cover empty, Unicode, money, key order, and tampering", async () => {
  const empty = { name: "Empty", currency: "USD", people: [], events: [] };
  const unicode = { name: "旅行 🐴", currency: "EUR", people: [{ id: "p-1", name: "Zoë 東京" }], events: [] };
  const money = source([expense({ amount: 2468, description: "café" })]);
  const emptyReview = await prepareLegacyActivationReview(empty);
  const unicodeReview = await prepareLegacyActivationReview(unicode);
  const moneyReview = await prepareLegacyActivationReview(money);
  assert.equal(emptyReview.digest.value, "99vXNpAxhBv893K4LOXvGDBdFHtBUTcHXROtdVJvEVo");
  assert.equal(unicodeReview.digest.value, "ItPZIT_ZzTOajWHVwcUU_j8oGDRbp8GsA5sO8KwpoDI");
  assert.equal(moneyReview.digest.value, "lNWPw11bp03_9qqjJyzTIwiF9VC6kiFnEAj5Nch0ONI");

  const reordered = { events: money.events.map((event) => ({ splits: event.splits, createdAt: event.createdAt, payerId: event.payerId,
    amount: event.amount, description: event.description, type: event.type, id: event.id })),
    people: money.people.map(({ name, id }) => ({ name, id })), groupId: money.groupId, currency: money.currency, name: money.name };
  assert.equal((await prepareLegacyActivationReview(reordered)).digest.value, moneyReview.digest.value);
  const changed = structuredClone(money);
  changed.events[0].amount += 2;
  changed.events[0].splits[0].amount += 1;
  assert.notEqual((await prepareLegacyActivationReview(changed)).digest.value, moneyReview.digest.value);
});
