import assert from "node:assert/strict";
import { test } from "@playwright/test";

test("browser invite approval stores only the verifier and enrolls the requested key", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const [{ createGroupGenesis }, { getOrCreateDeviceIdentity }, { generateDeviceSigningKeyPair }, commands] = await Promise.all([
      import("/src/group-genesis.js"), import("/src/device-identity-store.js"), import("/src/identity-crypto.js"), import("/src/membership-invitations.js")
    ]);
    const { record: genesis, trustPin } = await createGroupGenesis({ name: "Trip", currency: "USD", ownerName: "Alice" });
    const owner = await getOrCreateDeviceIdentity();
    const identity = { ...owner, participantId: genesis.author.participantId, deviceId: genesis.author.deviceId, keyId: genesis.author.keyId };
    const records = [genesis];
    const invitation = await commands.createInviteCommand({ groupId: genesis.groupId, participantId: genesis.author.participantId, membershipHeads: [genesis.id], identity, records, trustPin });
    records.push(invitation.record);
    const pair = await generateDeviceSigningKeyPair();
    const requestIdentity = { ...pair, participantId: invitation.record.payload.participantId, deviceId: crypto.randomUUID(), keyId: crypto.randomUUID() };
    const request = await commands.createJoinRequestCommand({ invite: invitation.record, token: invitation.token, groupId: genesis.groupId, membershipHeads: [invitation.record.id], identity: requestIdentity, records, trustPin });
    records.push(request);
    const approval = await commands.approveJoinRequestCommand({ invite: invitation.record, request, token: invitation.token, genesis, trustPin, membershipHeads: [invitation.record.id], identity, records });
    const projection = await commands.projectMembershipEnrollment([...records, approval], { trustPin });
    return { token: invitation.token, invitation: invitation.record, request, approval, projection, requestIdentity };
  });
  assert.equal(JSON.stringify([result.invitation, result.request, result.approval]).includes(result.token), false);
  assert.equal(result.projection.devices.some((device) => device.deviceId === result.requestIdentity.deviceId), true);
  assert.equal(result.projection.readOnly, false);
});
