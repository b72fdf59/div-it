import assert from "node:assert/strict";
import { test } from "node:test";
import { createMembershipRosterCommand } from "./src/membership-roster-commands.js";
import { exportDevicePublicKey, generateDeviceSigningKeyPair, signRecord } from "./src/identity-crypto.js";
import { createSignedLedgerRecord } from "./src/signed-ledger-records.js";
import { createLegacyHistoryAttestation } from "./src/legacy-history-attestation.js";
import { prepareLegacyActivationReview } from "./src/legacy-activation-review.js";
import { verifyLegacyOpeningBalanceImport } from "./src/legacy-opening-balances.js";

const uuid = () => crypto.randomUUID();
const encode = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

async function setup() {
  const owner = { participantId: uuid(), deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const groupId = uuid();
  const genesisId = uuid();
  const publicBytes = await exportDevicePublicKey(owner.publicKey);
  const genesis = { id: genesisId, groupId, recordType: "group-created", membershipSchemaVersion: 1, protocolVersion: 2,
    author: { participantId: owner.participantId, deviceId: owner.deviceId, keyId: owner.keyId }, createdAt: "2026-10-09T10:00:00.000Z",
    membershipHeads: [], causalHeads: [], dependsOn: [], payload: { name: "Current", currency: "USD",
      owner: { participantId: owner.participantId, deviceId: owner.deviceId, keyId: owner.keyId, name: "Alice", publicKey: encode(publicBytes) } } };
  genesis.signature = await signRecord(genesis, owner.privateKey);
  const trustPin = { genesisId, publicKeyFingerprint: `sha256:${encode(new Uint8Array(await crypto.subtle.digest("SHA-256", publicBytes)))}` };
  const records = [genesis];
  const member = { participantId: uuid(), deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const participant = await createMembershipRosterCommand({ recordType: "participant-added", groupId, participantId: member.participantId,
    name: "Bob", membershipHeads: [genesisId], identity: owner, records, trustPin });
  records.push(participant);

  const source = { name: "Old", currency: "USD", groupId: uuid(), people: [{ id: "old-alice", name: "Alice" }, { id: "old-bob", name: "Bob" }],
    events: [{ id: uuid(), type: "expense-created", description: "Meal", amount: 1000, payerId: "old-alice",
      splits: [{ personId: "old-alice", amount: 400 }, { personId: "old-bob", amount: 600 }], createdAt: "2026-10-08T10:00:00.000Z" }] };
  const rawArchiveBytes = new TextEncoder().encode(JSON.stringify(source, null, 2));
  const review = await prepareLegacyActivationReview(source, { rawArchiveBytes });
  const identity = { ...owner, participantId: owner.participantId };
  const participantMapping = [{ sourceParticipantId: "old-alice", participantId: owner.participantId },
    { sourceParticipantId: "old-bob", participantId: member.participantId }];
  const attestation = await createLegacyHistoryAttestation({ archive: review.archive, membershipHeads: [participant.id], identity,
    membershipRecords: records, trustPin, participantMapping });
  const eventInput = { id: uuid(), type: "opening-balances-imported", groupId,
    author: { participantId: owner.participantId, deviceId: owner.deviceId, keyId: owner.keyId }, createdAt: "2026-10-09T10:01:00.000Z",
    membershipHeads: [participant.id], causalHeads: [], dependsOn: [], payload: { importId: genesisId, currency: "USD",
      sourceFormat: "legacy-activation", balances: attestation.mappedOpeningBalances, legacyAttestationId: attestation.record.id } };
  const event = await createSignedLedgerRecord(eventInput, owner.privateKey);
  return { owner, member, groupId, genesis, trustPin, records, review, attestation, event, eventInput, source };
}

async function verify(ctx, record = ctx.event, legacyAttestations = [{ record: ctx.attestation.record, archive: ctx.attestation.archive }]) {
  return verifyLegacyOpeningBalanceImport(record, { legacyAttestations, membershipRecords: ctx.records, trustPin: ctx.trustPin });
}

test("only a signed owner baseline with its mapped attestation authorizes opening balances", async () => {
  const ctx = await setup();
  const missing = await verify(ctx, ctx.event, []);
  assert.deepEqual({ status: missing.status, reason: missing.reason }, { status: "pending", reason: "missing-legacy-attestation" });
  const accepted = await verify(ctx);
  assert.equal(accepted.status, "authorized");
  assert.deepEqual(accepted.mappedOpeningBalances, ctx.attestation.mappedOpeningBalances);
  const splitwise = await createSignedLedgerRecord({ ...ctx.eventInput,
    payload: { importId: ctx.trustPin.genesisId, currency: "USD", sourceFormat: "splitwise-csv", balances: ctx.attestation.mappedOpeningBalances }
  }, ctx.owner.privateKey);
  assert.equal((await verifyLegacyOpeningBalanceImport(splitwise, {
    legacyAttestations: [], membershipRecords: ctx.records, trustPin: ctx.trustPin })).status, "not-applicable");
});

test("legacy import gate rejects fake, mismatched, and non-owner financial records", async () => {
  const ctx = await setup();
  const wrongBalances = await createSignedLedgerRecord({ ...ctx.eventInput,
    payload: { ...ctx.eventInput.payload, balances: [{ participantId: ctx.owner.participantId, amount: 0 }, { participantId: ctx.member.participantId, amount: 0 }] }
  }, ctx.owner.privateKey);
  assert.equal((await verify(ctx, wrongBalances)).reason, "legacy-opening-balances-mismatch");

  const wrongImport = await createSignedLedgerRecord({ ...ctx.eventInput,
    payload: { ...ctx.eventInput.payload, importId: uuid() }
  }, ctx.owner.privateKey);
  assert.equal((await verify(ctx, wrongImport)).reason, "legacy-import-id-mismatch");

  const fakeOnly = await createSignedLedgerRecord({ ...ctx.eventInput, id: uuid() }, ctx.owner.privateKey);
  assert.equal((await verify(ctx, fakeOnly, [])).status, "pending");

  const memberEvent = await createSignedLedgerRecord({ ...ctx.eventInput,
    author: { participantId: ctx.member.participantId, deviceId: ctx.member.deviceId, keyId: ctx.member.keyId }
  }, ctx.member.privateKey);
  assert.equal((await verify(ctx, memberEvent)).reason, "not-financial-owner");

  const forgedAttestation = structuredClone(ctx.attestation.record);
  forgedAttestation.payload.participantMapping[1].participantId = uuid();
  const invalid = await verify(ctx, ctx.event, [{ record: forgedAttestation, archive: ctx.attestation.archive }]);
  assert.equal(invalid.status, "quarantined");
  assert.equal(invalid.reason, "invalid-legacy-attestation");
});

test("invalid same-ID evidence does not shadow a valid proof, but distinct valid variants collide", async () => {
  const ctx = await setup();
  const invalid = structuredClone(ctx.attestation.record);
  invalid.signature = `${invalid.signature.slice(0, -1)}${invalid.signature.endsWith("A") ? "B" : "A"}`;
  const validWithInvalidNoise = await verify(ctx, ctx.event, [
    { record: invalid, archive: ctx.attestation.archive },
    { record: ctx.attestation.record, archive: ctx.attestation.archive }
  ]);
  assert.equal(validWithInvalidNoise.status, "authorized");

  const second = structuredClone(ctx.attestation.record);
  second.createdAt = "2026-10-09T10:03:00.000Z";
  second.signature = await signRecord(second, ctx.owner.privateKey);
  const collision = await verify(ctx, ctx.event, [
    { record: ctx.attestation.record, archive: ctx.attestation.archive },
    { record: second, archive: ctx.attestation.archive }
  ]);
  assert.equal(collision.status, "quarantined");
  assert.equal(collision.reason, "legacy-attestation-id-collision");
});

test("a signed future membership barrier at the event's heads does not erase historical proof verification", async () => {
  const ctx = await setup();
  const future = { id: uuid(), recordType: "participant-renamed", membershipSchemaVersion: 1, protocolVersion: 3,
    groupId: ctx.groupId, author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-09T10:02:00.000Z", membershipHeads: [ctx.records[1].id], causalHeads: [], dependsOn: [],
    payload: { participantId: ctx.member.participantId, name: "Bob v2" } };
  future.signature = await signRecord(future, ctx.owner.privateKey);
  ctx.records.push(future);
  const result = await verify(ctx);
  assert.equal(result.status, "authorized", result.reason);
});
