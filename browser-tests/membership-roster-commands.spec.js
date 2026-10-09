import assert from "node:assert/strict";
import { test } from "@playwright/test";

test("browser roster commands sign each transition and enforce verified authority", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createGroupGenesis } = await import("/src/group-genesis.js");
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    const { generateDeviceSigningKeyPair } = await import("/src/identity-crypto.js");
    const { projectSignedMembership } = await import("/src/signed-membership-projector.js");
    const { createOrganizerGrantCommand, createOrganizerRevokeCommand, createParticipantAddCommand, createParticipantRenameCommand } = await import("/src/membership-roster-commands.js");
    const { record: genesis, trustPin } = await createGroupGenesis({ name: "Trip", currency: "USD", ownerName: "Owner" });
    const identity = { ...await getOrCreateDeviceIdentity(), participantId: genesis.author.participantId };
    const records = [genesis];
    const participantId = crypto.randomUUID();
    const input = (membershipHeads, extra = {}) => ({ groupId: genesis.groupId, membershipHeads, identity, records, trustPin, ...extra });
    const added = await createParticipantAddCommand(input([genesis.id], { participantId, name: "Alice" })); records.push(added);
    const renamed = await createParticipantRenameCommand(input([added.id], { participantId, name: "Alice Two" })); records.push(renamed);
    const granted = await createOrganizerGrantCommand(input([renamed.id], { participantId })); records.push(granted);
    const revoked = await createOrganizerRevokeCommand(input([granted.id], { participantId })); records.push(revoked);
    const wrongKey = await generateDeviceSigningKeyPair();
    let mismatchRejected = false;
    try { await createParticipantRenameCommand(input([revoked.id], { identity: { ...identity, privateKey: wrongKey.privateKey }, participantId, name: "Bad" })); }
    catch (error) { mismatchRejected = /signature-key-mismatch/.test(error.message); }
    let staleRejected = false;
    try { await createParticipantRenameCommand(input([added.id], { participantId, name: "Stale" })); }
    catch (error) { staleRejected = /stale-membership-heads/.test(error.message); }
    const projection = await projectSignedMembership(records, { trustPin });
    return { projection, participantId, mismatchRejected, staleRejected, types: [added, renamed, granted, revoked].map((item) => item.recordType) };
  });
  assert.deepEqual(result.types, ["participant-added", "participant-renamed", "organizer-granted", "organizer-revoked"]);
  assert.equal(result.projection.participants.find((item) => item.id === result.participantId)?.name, "Alice Two");
  assert.equal(result.projection.organizers.includes(result.participantId), false);
  assert.equal(result.projection.readOnly, false);
  assert.equal(result.mismatchRejected, true);
  assert.equal(result.staleRejected, true);
});
