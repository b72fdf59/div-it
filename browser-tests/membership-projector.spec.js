import assert from "node:assert/strict";
import { test } from "@playwright/test";

test("projects an owner-signed participant record from trusted genesis heads", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createGroupGenesis } = await import("/src/group-genesis.js");
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    const { signRecord } = await import("/src/identity-crypto.js");
    const { projectMembershipRecords } = await import("/src/membership-projector.js");
    const { record: genesis, trustPin } = await createGroupGenesis({ name: "Trip", currency: "USD", ownerName: "Alice" });
    const identity = await getOrCreateDeviceIdentity();
    const participantId = crypto.randomUUID();
    const member = {
      id: crypto.randomUUID(),
      recordType: "participant-added",
      membershipSchemaVersion: 1,
      protocolVersion: 2,
      groupId: genesis.groupId,
      author: genesis.author,
      createdAt: new Date().toISOString(),
      membershipHeads: [genesis.id],
      causalHeads: [],
      dependsOn: [],
      payload: { participantId, name: "Bob" }
    };
    member.signature = await signRecord(member, identity.privateKey);
    const projection = await projectMembershipRecords([member, genesis], { trustPin });
    return { participantId, projection };
  });
  assert.equal(result.projection.participants.find((person) => person.id === result.participantId)?.name, "Bob");
  assert.equal(result.projection.organizers.includes(result.projection.ownerParticipantId), true);
  assert.equal(result.projection.readOnly, false);
  assert.ok(result.projection.heads.length === 1);
});
