import test from "node:test";
import assert from "node:assert/strict";
import { exportDevicePublicKey, generateDeviceSigningKeyPair, signRecord } from "./src/identity-crypto.js";
import { projectSignedMembership } from "./src/signed-membership-projector.js";

const uuid = () => crypto.randomUUID();
const encode = (bytes) => {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

async function setup() {
  const pair = await generateDeviceSigningKeyPair();
  const [participantId, deviceId, keyId, groupId, genesisId] = Array.from({ length: 5 }, uuid);
  const publicKey = encode(await exportDevicePublicKey(pair.publicKey));
  const genesis = { id: genesisId, groupId, recordType: "group-created", membershipSchemaVersion: 1, protocolVersion: 2,
    author: { participantId, deviceId, keyId }, createdAt: "2026-10-08T00:00:00.000Z", membershipHeads: [], causalHeads: [], dependsOn: [],
    payload: { name: "Trip", currency: "USD", owner: { participantId, deviceId, keyId, name: "Owner", publicKey } } };
  genesis.signature = await signRecord(genesis, pair.privateKey);
  const fingerprintBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", await exportDevicePublicKey(pair.publicKey)));
  const trustPin = { genesisId, publicKeyFingerprint: `sha256:${encode(fingerprintBytes)}` };
  const owner = { participantId, deviceId, keyId, privateKey: pair.privateKey };
  return { genesis, trustPin, owner };
}

async function compatibilityRecord(ctx, overrides = {}) {
  const record = { id: uuid(), recordType: "future-membership", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.genesis.groupId, author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-08T00:00:01.000Z", membershipHeads: [ctx.genesis.id], causalHeads: [], dependsOn: [], payload: { future: true },
    ...overrides };
  record.signature = await signRecord(record, ctx.owner.privateKey);
  return record;
}

function reasons(projection, id) {
  return projection.diagnostics.filter((item) => item.recordId === id).map((item) => `${item.status}:${item.reason}`);
}

test("only an enrolled signer can make an unknown membership record a compatibility barrier", async () => {
  const ctx = await setup();
  const trusted = await compatibilityRecord(ctx);
  const projection = await projectSignedMembership([ctx.genesis, trusted], { trustPin: ctx.trustPin });
  assert.equal(projection.groupId, ctx.genesis.groupId);
  assert.equal(projection.readOnly, true);
  assert.deepEqual(reasons(projection, trusted.id), ["unsupported:unsupported-membership-record"]);
  assert.equal(projection.rawRecords.some((item) => item.id === trusted.id), true);
  assert.equal(projection.heads.includes(trusted.id), false);

  const unsigned = { ...trusted, id: uuid(), signature: "A".repeat(86) };
  const unknownDevice = await compatibilityRecord(ctx, { id: uuid(), author: { participantId: uuid(), deviceId: uuid(), keyId: uuid() } });
  const crossGroup = await compatibilityRecord(ctx, { id: uuid(), groupId: uuid() });
  const malformed = await compatibilityRecord(ctx, { id: uuid(), payload: [] });
  const invalidType = await compatibilityRecord(ctx, { id: uuid(), recordType: 42 });
  const oversizedType = await compatibilityRecord(ctx, { id: uuid(), recordType: "x".repeat(65) });
  for (const candidate of [unsigned, unknownDevice, crossGroup, malformed, invalidType, oversizedType]) {
    const untrusted = await projectSignedMembership([ctx.genesis, candidate], { trustPin: ctx.trustPin });
    assert.equal(untrusted.readOnly, false, candidate.id);
    assert.equal(untrusted.groupId, ctx.genesis.groupId);
    assert.ok(reasons(untrusted, candidate.id).some((reason) => reason.startsWith("pending:") || reason.startsWith("quarantined:")));
  }
});

test("unsupported versions require a valid common envelope, signer, and signature", async () => {
  const ctx = await setup();
  const futureVersion = await compatibilityRecord(ctx, { recordType: "participant-added", membershipSchemaVersion: 2,
    payload: { participantId: uuid(), name: "Future" } });
  const trusted = await projectSignedMembership([ctx.genesis, futureVersion], { trustPin: ctx.trustPin });
  assert.equal(trusted.readOnly, true);
  assert.deepEqual(reasons(trusted, futureVersion.id), ["unsupported:unsupported-membership-version"]);

  const forged = structuredClone(futureVersion);
  forged.id = uuid();
  forged.payload.name = "Forged";
  const invalid = await projectSignedMembership([ctx.genesis, forged], { trustPin: ctx.trustPin });
  assert.equal(invalid.readOnly, false);
  assert.ok(reasons(invalid, forged.id).includes("quarantined:invalid-membership-signature"));
});

test("compatibility record collisions and input permutations cannot choose a barrier", async () => {
  const ctx = await setup();
  const future = await compatibilityRecord(ctx);
  const conflicting = structuredClone(future);
  conflicting.payload.future = "different signed content";
  conflicting.signature = await signRecord(conflicting, ctx.owner.privateKey);
  const another = await compatibilityRecord(ctx, { id: uuid() });
  for (const records of [[ctx.genesis, future, conflicting, another], [another, conflicting, future, ctx.genesis]]) {
    const projection = await projectSignedMembership(records, { trustPin: ctx.trustPin });
    assert.equal(projection.readOnly, true); // the independent valid future record remains a barrier
    assert.ok(reasons(projection, future.id).includes("quarantined:id-content-collision"));
    assert.ok(reasons(projection, another.id).includes("unsupported:unsupported-membership-record"));
    assert.deepEqual(projection.diagnostics.map((item) => `${item.recordId || ""}:${item.status}:${item.reason}`),
      (await projectSignedMembership([...records].reverse(), { trustPin: ctx.trustPin })).diagnostics
        .map((item) => `${item.recordId || ""}:${item.status}:${item.reason}`));
  }

  const onlyCollision = await projectSignedMembership([ctx.genesis, future, conflicting], { trustPin: ctx.trustPin });
  assert.equal(onlyCollision.readOnly, false);

  const baseRecord = { id: uuid(), recordType: "participant-added", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.genesis.groupId, author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-08T00:00:01.000Z", membershipHeads: [ctx.genesis.id], causalHeads: [], dependsOn: [],
    payload: { participantId: uuid(), name: "Member" } };
  baseRecord.signature = await signRecord(baseRecord, ctx.owner.privateKey);
  const collision = await compatibilityRecord(ctx, { id: baseRecord.id });
  for (const records of [[ctx.genesis, baseRecord, collision], [collision, ctx.genesis, baseRecord]]) {
    const projection = await projectSignedMembership(records, { trustPin: ctx.trustPin });
    assert.equal(projection.readOnly, false);
    assert.ok(reasons(projection, collision.id).includes("quarantined:id-content-collision"));
  }
});

test("unknown and unsupported records with missing membership heads stay pending", async () => {
  const ctx = await setup();
  const future = await compatibilityRecord(ctx, { id: uuid(), membershipHeads: [uuid()] });
  const projection = await projectSignedMembership([ctx.genesis, future], { trustPin: ctx.trustPin });
  assert.equal(projection.readOnly, false);
  assert.ok(reasons(projection, future.id).includes("pending:missing-membership-head"));
});
