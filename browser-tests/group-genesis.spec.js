import assert from "node:assert/strict";
import { test } from "@playwright/test";

test("creates and verifies a pinned signed genesis without serializing private keys", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createGroupGenesis, verifyGroupGenesis } = await import("/src/group-genesis.js");
    const created = await createGroupGenesis({ name: "Trip", currency: "USD", ownerName: "Alice" });
    return {
      created,
      trusted: await verifyGroupGenesis(created.record, created.trustPin),
      noPin: await verifyGroupGenesis(created.record),
      serializedPrivateKey: JSON.stringify(created.record).includes("privateKey")
    };
  });
  assert.equal(result.trusted.ok, true);
  assert.equal(result.trusted.genesisId, result.created.record.id);
  assert.equal(result.trusted.groupId, result.created.record.groupId);
  assert.deepEqual(result.noPin, { ok: false, reason: "invalid-genesis-trust-pin" });
  assert.equal(result.serializedPrivateKey, false);
  assert.deepEqual(result.created.record.membershipHeads, []);
  assert.deepEqual(result.created.record.causalHeads, []);
  assert.deepEqual(result.created.record.dependsOn, []);
});

test("rejects altered, foreign, and malformed genesis records with stable reasons", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createGroupGenesis, verifyGroupGenesis } = await import("/src/group-genesis.js");
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    const { signRecord } = await import("/src/identity-crypto.js");
    const created = await createGroupGenesis({ name: "Trip", currency: "USD", ownerName: "Alice" });
    const altered = structuredClone(created.record);
    altered.payload.name = "Altered";
    const groupMismatch = { ...created.record, groupId: crypto.randomUUID() };
    const foreign = { ...created.record, id: crypto.randomUUID(), groupId: crypto.randomUUID() };
    foreign.signature = await signRecord(foreign, (await getOrCreateDeviceIdentity()).privateKey);
    const bindingMismatch = structuredClone(created.record);
    bindingMismatch.payload.owner.keyId = crypto.randomUUID();
    bindingMismatch.signature = await signRecord(bindingMismatch, (await getOrCreateDeviceIdentity()).privateKey);
    const unsupported = { ...created.record, protocolVersion: 99 };
    const uppercaseId = { ...created.record, id: created.record.id.toUpperCase() };
    const nonEmptyDependencies = { ...created.record, dependsOn: [created.record.id] };
    return {
      altered: await verifyGroupGenesis(altered, created.trustPin),
      groupMismatch: await verifyGroupGenesis(groupMismatch, created.trustPin),
      foreign: await verifyGroupGenesis(foreign, created.trustPin),
      bindingMismatch: await verifyGroupGenesis(bindingMismatch, created.trustPin),
      unsupported: await verifyGroupGenesis(unsupported, created.trustPin),
      uppercaseId: await verifyGroupGenesis(uppercaseId, created.trustPin),
      nonEmptyDependencies: await verifyGroupGenesis(nonEmptyDependencies, created.trustPin),
      malformedPin: await verifyGroupGenesis(created.record, { genesisId: created.record.id, publicKeyFingerprint: "bad" })
    };
  });
  assert.equal(result.altered.reason, "invalid-genesis-signature");
  assert.equal(result.groupMismatch.reason, "invalid-genesis-signature");
  assert.equal(result.foreign.reason, "genesis-id-pin-mismatch");
  assert.equal(result.bindingMismatch.reason, "genesis-owner-author-mismatch");
  assert.equal(result.unsupported.reason, "unsupported-genesis-version");
  assert.equal(result.uppercaseId.reason, "invalid-genesis-id");
  assert.equal(result.nonEmptyDependencies.reason, "invalid-genesis-frontier");
  assert.equal(result.malformedPin.reason, "invalid-genesis-trust-pin");
});
