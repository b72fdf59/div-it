import assert from "node:assert/strict";
import { test } from "@playwright/test";

test("browser creates and verifies an owner-signed legacy snapshot attestation", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { createGroupGenesis } = await import("/src/group-genesis.js");
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    const { prepareLegacyActivationReview } = await import("/src/legacy-activation-review.js");
    const { createLegacyHistoryAttestation, verifyLegacyHistoryAttestation } = await import("/src/legacy-history-attestation.js");
    const created = await createGroupGenesis({ name: "Current trip", currency: "USD", ownerName: "Alice" });
    const identity = await getOrCreateDeviceIdentity();
    identity.participantId = created.record.payload.owner.participantId;
    const source = { name: "Old trip", currency: "USD", groupId: crypto.randomUUID(),
      people: [{ id: "legacy-alice", name: "Alice" }], events: [] };
    const rawBytes = new TextEncoder().encode(JSON.stringify(source, null, 2));
    const review = await prepareLegacyActivationReview(source, { rawArchiveBytes: rawBytes });
    const createdAttestation = await createLegacyHistoryAttestation({ archive: review.archive,
      membershipHeads: [created.record.id], identity, membershipRecords: [created.record], trustPin: created.trustPin,
      participantMapping: [{ sourceParticipantId: "legacy-alice", participantId: identity.participantId }] });
    const verification = await verifyLegacyHistoryAttestation({ record: createdAttestation.record,
      archive: createdAttestation.archive, membershipRecords: [created.record], trustPin: created.trustPin });
    return { record: createdAttestation.record, verification, rawBytes, savedBytes: createdAttestation.archive.bytes,
      mappedOpeningBalances: createdAttestation.mappedOpeningBalances };
  });

  assert.equal(result.verification.ok, true);
  assert.equal(result.record.recordType, "legacy-history-adopted");
  assert.equal(result.record.membershipSchemaVersion, 2);
  assert.equal(result.record.payload.legacyAuthorship, "unverified");
  assert.deepEqual(result.record.payload.participantMapping, [{ sourceParticipantId: "legacy-alice", participantId: result.record.author.participantId }]);
  assert.deepEqual(result.mappedOpeningBalances, [{ participantId: result.record.author.participantId, amount: 0 }]);
  assert.deepEqual(result.verification.mappedOpeningBalances, result.mappedOpeningBalances);
  assert.deepEqual(result.savedBytes, result.rawBytes);
  assert.notEqual(result.record.signature, "development-only");
});
