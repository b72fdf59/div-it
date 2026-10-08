import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";

test("browser projection authorizes an enrolled member's original v2 ledger signature", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Activity", exact: true })).toBeVisible();
  const result = await page.evaluate(async () => {
    const [genesisApi, identityStore, cryptoApi, commands, ledgerRecords, authenticated] = await Promise.all([
      import("/src/group-genesis.js"),
      import("/src/device-identity-store.js"),
      import("/src/identity-crypto.js"),
      import("/src/membership-invitations.js"),
      import("/src/signed-ledger-records.js"),
      import("/src/authenticated-ledger.js")
    ]);
    const { record: genesis, trustPin } = await genesisApi.createGroupGenesis({ name: "Signed ledger test", currency: "USD", ownerName: "Alice" });
    const storedOwner = await identityStore.getOrCreateDeviceIdentity();
    const owner = { ...storedOwner, participantId: genesis.author.participantId };
    const records = [genesis];
    const participantId = crypto.randomUUID();
    const participant = {
      id: crypto.randomUUID(), recordType: "participant-added", membershipSchemaVersion: 1, protocolVersion: 2,
      groupId: genesis.groupId,
      author: { participantId: owner.participantId, deviceId: owner.deviceId, keyId: owner.keyId },
      createdAt: new Date().toISOString(), membershipHeads: [genesis.id], causalHeads: [], dependsOn: [],
      payload: { participantId, name: "Bob" }
    };
    participant.signature = await cryptoApi.signRecord(participant, owner.privateKey);
    records.push(participant);

    const pair = await cryptoApi.generateDeviceSigningKeyPair();
    const member = { participantId, deviceId: crypto.randomUUID(), keyId: crypto.randomUUID(), ...pair };
    const invitation = await commands.createInviteCommand({ groupId: genesis.groupId, participantId,
      membershipHeads: [participant.id], identity: owner, records, trustPin });
    records.push(invitation.record);
    const request = await commands.createJoinRequestCommand({ invite: invitation.record, token: invitation.token,
      groupId: genesis.groupId, membershipHeads: [invitation.record.id], identity: member, records, trustPin });
    records.push(request);
    const approval = await commands.approveJoinRequestCommand({ invite: invitation.record, request, token: invitation.token,
      genesis, trustPin, membershipHeads: [invitation.record.id], identity: owner, records });
    records.push(approval);

    const signedExpense = await ledgerRecords.createSignedLedgerRecord({
      id: crypto.randomUUID(), type: "expense-created", groupId: genesis.groupId,
      author: { participantId, deviceId: member.deviceId, keyId: member.keyId },
      createdAt: new Date().toISOString(), membershipHeads: [approval.id], causalHeads: [], dependsOn: [],
      payload: { expenseId: crypto.randomUUID(), description: "Signed dinner", currency: "USD", amount: 1000,
        payerId: participantId, splits: [{ participantId: genesis.author.participantId, amount: 500 }, { participantId, amount: 500 }] }
    }, member.privateKey);
    const projection = await authenticated.projectAuthenticatedLedger([signedExpense], { membershipRecords: records, trustPin });
    const changedFrontier = { ...signedExpense, causalHeads: [crypto.randomUUID()] };
    const rejected = await authenticated.projectAuthenticatedLedger([changedFrontier], { membershipRecords: records, trustPin });
    return {
      groupId: projection.groupId,
      currency: projection.currency,
      readOnly: projection.readOnly,
      balances: projection.balances,
      retainedRawEnvelope: projection.rawRecords.some((record) => record.id === signedExpense.id
        && record.signature === signedExpense.signature && record.membershipHeads[0] === approval.id),
      rejectedBalances: rejected.balances,
      rejectedSignature: rejected.quarantined.some((item) => item.reason === "invalid-signature")
    };
  });

  assert.equal(result.groupId.length, 36);
  assert.equal(result.currency, "USD");
  assert.equal(result.readOnly, false);
  assert.deepEqual(Object.values(result.balances).sort((a, b) => a - b), [-500, 500]);
  assert.equal(result.retainedRawEnvelope, true);
  assert.deepEqual(result.rejectedBalances, {});
  assert.equal(result.rejectedSignature, true);
});
