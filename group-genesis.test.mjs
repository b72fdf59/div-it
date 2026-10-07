import assert from "node:assert/strict";
import { test } from "node:test";
import { exportDevicePublicKey, generateDeviceSigningKeyPair, signRecord } from "./src/identity-crypto.js";
import { verifyGroupGenesis } from "./src/group-genesis.js";

const ids = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  groupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  participantId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  deviceId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  keyId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
};

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function fixture() {
  const pair = await generateDeviceSigningKeyPair();
  const rawPublicKey = await exportDevicePublicKey(pair.publicKey);
  const record = {
    id: ids.id,
    groupId: ids.groupId,
    recordType: "group-created",
    membershipSchemaVersion: 1,
    protocolVersion: 2,
    author: { participantId: ids.participantId, deviceId: ids.deviceId, keyId: ids.keyId },
    createdAt: "2026-10-07T00:00:00.000Z",
    membershipHeads: [],
    causalHeads: [],
    dependsOn: [],
    payload: {
      name: "Trip",
      currency: "USD",
      owner: {
        participantId: ids.participantId,
        deviceId: ids.deviceId,
        keyId: ids.keyId,
        name: "Alice",
        publicKey: encodeBase64Url(rawPublicKey)
      }
    }
  };
  record.signature = await signRecord(record, pair.privateKey);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", rawPublicKey));
  return {
    record,
    pair,
    pin: { genesisId: record.id, publicKeyFingerprint: `sha256:${encodeBase64Url(digest)}` }
  };
}

test("accepts a self-signed genesis only with its explicit ID and key fingerprint pin", async () => {
  const { record, pin } = await fixture();
  const trusted = await verifyGroupGenesis(record, pin);
  assert.equal(trusted.ok, true);
  assert.equal(trusted.genesisId, record.id);
  assert.equal(trusted.groupId, record.groupId);

  assert.deepEqual(await verifyGroupGenesis(record), { ok: false, reason: "invalid-genesis-trust-pin" });
  assert.deepEqual(await verifyGroupGenesis(record, { ...pin, genesisId: Symbol("id") }),
    { ok: false, reason: "invalid-genesis-trust-pin" });
  assert.equal((await verifyGroupGenesis(record, { ...pin, publicKeyFingerprint: "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" })).reason,
    "genesis-key-pin-mismatch");
});

test("a different correctly signed genesis with the same owner key cannot reuse the original ID pin", async () => {
  const { record, pin, pair } = await fixture();
  const other = {
    ...record,
    id: "66666666-6666-4666-8666-666666666666",
    groupId: "77777777-7777-4777-8777-777777777777"
  };
  other.signature = await signRecord(other, pair.privateKey);
  assert.deepEqual(await verifyGroupGenesis(other, pin), { ok: false, reason: "genesis-id-pin-mismatch" });
});

test("rejects changed content and creator/owner identity mismatch", async () => {
  const { record, pin, pair } = await fixture();
  assert.equal((await verifyGroupGenesis({ ...record, payload: { ...record.payload, name: "Changed" } }, pin)).reason,
    "invalid-genesis-signature");

  const mismatch = structuredClone(record);
  mismatch.payload.owner.deviceId = "88888888-8888-4888-8888-888888888888";
  mismatch.signature = await signRecord(mismatch, pair.privateKey);
  assert.equal((await verifyGroupGenesis(mismatch, pin)).reason, "genesis-owner-author-mismatch");
});

test("rejects tampered group binding, uppercase or non-string UUIDs, and non-empty genesis frontiers", async () => {
  const { record, pin } = await fixture();
  const changedGroup = { ...record, groupId: "99999999-9999-4999-8999-999999999999" };
  assert.equal((await verifyGroupGenesis(changedGroup, pin)).reason, "invalid-genesis-signature");
  assert.equal((await verifyGroupGenesis({ ...record, id: record.id.toUpperCase() }, pin)).reason,
    "invalid-genesis-id");
  assert.equal((await verifyGroupGenesis({ ...record, id: Symbol("id") }, pin)).reason,
    "invalid-genesis-id");
  assert.equal((await verifyGroupGenesis({ ...record, causalHeads: [ids.id] }, pin)).reason,
    "invalid-genesis-frontier");
  assert.equal((await verifyGroupGenesis({ ...record, dependsOn: [ids.id] }, pin)).reason,
    "invalid-genesis-frontier");
  assert.equal((await verifyGroupGenesis({ ...record, membershipSchemaVersion: 2 }, pin)).reason,
    "unsupported-genesis-version");
});

test("rejects unsupported, malformed, oversized-name, and non-empty-frontier genesis records", async () => {
  const { record, pin } = await fixture();
  const cases = [
    [{ ...record, protocolVersion: 3 }, "unsupported-genesis-version"],
    [{ ...record, unexpected: true }, "invalid-genesis-schema"],
    [{ ...record, membershipHeads: [ids.id] }, "invalid-genesis-frontier"],
    [{ ...record, signature: "%%%" }, "invalid-genesis-signature"],
    [{ ...record, payload: { ...record.payload, owner: { ...record.payload.owner, publicKey: "%%%" } } }, "invalid-genesis-public-key"],
    [{ ...record, payload: { ...record.payload, name: "x".repeat(129) } }, "invalid-genesis-payload"]
  ];
  for (const [candidate, reason] of cases) {
    assert.equal((await verifyGroupGenesis(candidate, pin)).reason, reason);
  }
});
