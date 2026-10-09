import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";

test("browser signs and projects staged causal frontier checkpoints", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const [genesisApi, identityStore, ledgerApi, checkpointApi, authApi] = await Promise.all([
      import("/src/group-genesis.js"),
      import("/src/device-identity-store.js"),
      import("/src/signed-ledger-records.js"),
      import("/src/causal-checkpoints.js"),
      import("/src/authenticated-ledger.js")
    ]);
    const { record: genesis, trustPin } = await genesisApi.createGroupGenesis({ name: "Causal checkpoints", currency: "USD", ownerName: "Owner" });
    const stored = await identityStore.getOrCreateDeviceIdentity();
    const identity = { ...stored, participantId: genesis.author.participantId };
    const records = await Promise.all(Array.from({ length: 65 }, (_, index) => ledgerApi.createSignedLedgerRecord({
      id: crypto.randomUUID(), type: "expense-created", groupId: genesis.groupId,
      author: { participantId: identity.participantId, deviceId: identity.deviceId, keyId: identity.keyId },
      createdAt: new Date().toISOString(), membershipHeads: [genesis.id], causalHeads: [], dependsOn: [],
      payload: { expenseId: crypto.randomUUID(), description: `Expense ${index}`, currency: "USD", amount: 100,
        payerId: identity.participantId, splits: [{ participantId: identity.participantId, amount: 100 }] }
    }, identity.privateKey)));
    const checkpoint = await checkpointApi.createCausalFrontierCheckpointCommands({
      causalRecords: records, membershipRecords: [genesis], trustPin, identity, membershipHeads: [genesis.id]
    });
    const membershipRecords = [genesis, ...checkpoint.records];
    const projection = await authApi.projectAuthenticatedLedger(records, { membershipRecords, trustPin });
    return { count: checkpoint.records.length, frontier: checkpoint.frontier, projected: projection.causalFrontier,
      balanceValues: Object.values(projection.balances) };
  });
  assert.equal(result.count, 2);
  assert.deepEqual(result.projected, { ok: true, heads: result.frontier });
  assert.deepEqual(result.balanceValues, [0]);
  await expect(page.getByRole("button", { name: "Activity", exact: true })).toBeVisible();
});
