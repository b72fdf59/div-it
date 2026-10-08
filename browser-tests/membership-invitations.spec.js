import assert from "node:assert/strict";
import { test } from "@playwright/test";

test("browser enrollment and ownership transfer resolve to the accepted recipient device", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const [{ createGroupGenesis }, { getOrCreateDeviceIdentity }, { generateDeviceSigningKeyPair, signRecord }, commands] = await Promise.all([
      import("/src/group-genesis.js"), import("/src/device-identity-store.js"), import("/src/identity-crypto.js"), import("/src/membership-invitations.js")
    ]);
    const { record: genesis, trustPin } = await createGroupGenesis({ name: "Trip", currency: "USD", ownerName: "Alice" });
    const owner = await getOrCreateDeviceIdentity();
    const identity = { ...owner, participantId: genesis.author.participantId, deviceId: genesis.author.deviceId, keyId: genesis.author.keyId };
    const recipientId = crypto.randomUUID();
    const participant = { id: crypto.randomUUID(), recordType: "participant-added", membershipSchemaVersion: 1, protocolVersion: 2,
      groupId: genesis.groupId, author: { participantId: identity.participantId, deviceId: identity.deviceId, keyId: identity.keyId },
      createdAt: new Date().toISOString(), membershipHeads: [genesis.id], causalHeads: [], dependsOn: [],
      payload: { participantId: recipientId, name: "Bob" } };
    participant.signature = await signRecord(participant, identity.privateKey);
    const records = [genesis, participant];
    const invitation = await commands.createInviteCommand({ groupId: genesis.groupId, participantId: recipientId, membershipHeads: [participant.id], identity, records, trustPin });
    records.push(invitation.record);
    const pair = await generateDeviceSigningKeyPair();
    const requestIdentity = { ...pair, participantId: recipientId, deviceId: crypto.randomUUID(), keyId: crypto.randomUUID() };
    const request = await commands.createJoinRequestCommand({ invite: invitation.record, token: invitation.token, groupId: genesis.groupId, membershipHeads: [invitation.record.id], identity: requestIdentity, records, trustPin });
    records.push(request);
    const approval = await commands.approveJoinRequestCommand({ invite: invitation.record, request, token: invitation.token, genesis, trustPin, membershipHeads: [invitation.record.id], identity, records });
    records.push(approval);
    const proposal = await commands.createOwnershipTransferProposalCommand({ groupId: genesis.groupId, recipientParticipantId: recipientId,
      recipientDeviceId: requestIdentity.deviceId, recipientKeyId: requestIdentity.keyId, membershipHeads: [approval.id], identity, records, trustPin });
    records.push(proposal);
    const acceptance = await commands.createOwnershipTransferAcceptanceCommand({ proposal, groupId: genesis.groupId,
      membershipHeads: [proposal.id], identity: requestIdentity, records, trustPin });
    records.push(acceptance);
    const projection = await commands.projectMembershipEnrollment(records, { trustPin });
    return { token: invitation.token, invitation: invitation.record, request, approval, projection, requestIdentity, recipientId };
  });
  assert.equal(JSON.stringify([result.invitation, result.request, result.approval]).includes(result.token), false);
  assert.equal(result.projection.devices.some((device) => device.deviceId === result.requestIdentity.deviceId), true);
  assert.equal(result.projection.ownerParticipantId, result.recipientId);
  assert.equal(result.projection.readOnly, false);
});
