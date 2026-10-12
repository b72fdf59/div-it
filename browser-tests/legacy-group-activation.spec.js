import assert from "node:assert/strict";
import { test } from "@playwright/test";

test("stages a verified owner-selected legacy group without changing its source", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { prepareLegacyActivationReview } = await import("/src/legacy-activation-review.js");
    const { stageLegacyGroupActivation, legacyActivationSourceMatches } = await import("/src/legacy-group-activation.js");
    const { legacyAttestationsFromDocument, verifyLegacyOpeningBalanceImport } = await import("/src/legacy-opening-balances.js");
    const { recordsFromDocument } = await import("/src/event-store.js");
    const { projectAuthenticatedLedger } = await import("/src/authenticated-ledger.js");
    const { persistedRoundTrip } = await import("/browser-tests/automerge-roundtrip.js");
    const source = { name: "Old trip", currency: "USD", groupId: crypto.randomUUID(),
      people: [{ id: "old-alice", name: "Alice" }, { id: "old-bob", name: "Bob" }],
      events: [{ id: crypto.randomUUID(), type: "expense-created", description: "Meal", amount: 1000, payerId: "old-alice",
        splits: [{ personId: "old-alice", amount: 400 }, { personId: "old-bob", amount: 600 }], createdAt: "2026-10-08T10:00:00.000Z" }] };
    const original = structuredClone(source);
    const rawArchiveBytes = new TextEncoder().encode(JSON.stringify(source, null, 2));
    const review = await prepareLegacyActivationReview(source, { rawArchiveBytes });
    const plan = await stageLegacyGroupActivation({ source, rawArchiveBytes, approvedDigest: review.digest,
      selectedOwnerSourceParticipantId: "old-alice" });
    const openingEvent = plan.proofPlan.ledgerRecords[0];
    const gate = await verifyLegacyOpeningBalanceImport(openingEvent, { legacyAttestations: plan.proofPlan.attestations,
      membershipRecords: plan.proofPlan.membershipRecords, trustPin: plan.proofPlan.trustPin });
    const persistedDocument = persistedRoundTrip(plan.document);
    const persistedMembership = recordsFromDocument(persistedDocument, "membershipRecordsById");
    const persistedLedger = recordsFromDocument(persistedDocument, "ledgerRecordsById");
    const persistedAttestations = legacyAttestationsFromDocument(persistedDocument);
    const persistedProjection = await projectAuthenticatedLedger(persistedLedger, { membershipRecords: persistedMembership,
      trustPin: plan.proofPlan.trustPin, legacyAttestations: persistedAttestations });
    const stale = structuredClone(source);
    stale.events[0].amount += 1;
    let wrongDigestRejected = false;
    try {
      await stageLegacyGroupActivation({ source, rawArchiveBytes, approvedDigest: { ...review.digest, value: "A".repeat(43) },
        selectedOwnerSourceParticipantId: "old-alice" });
    } catch (error) { wrongDigestRejected = error.message === "legacy-review-digest-mismatch"; }
    let wrongOwnerRejected = false;
    try {
      await stageLegacyGroupActivation({ source, rawArchiveBytes, approvedDigest: review.digest,
        selectedOwnerSourceParticipantId: "unknown-source-person" });
    } catch (error) { wrongOwnerRejected = error.message === "invalid-selected-legacy-owner"; }

    const emptySource = { name: "Empty", currency: "USD", groupId: crypto.randomUUID(), people: [], events: [] };
    const emptyReview = await prepareLegacyActivationReview(emptySource);
    const emptyPlan = await stageLegacyGroupActivation({ source: emptySource, approvedDigest: emptyReview.digest, emptySourceOwnerName: "New owner" });
    return {
      originalUnchanged: JSON.stringify(source) === JSON.stringify(original),
      sourceMatches: legacyActivationSourceMatches(source, plan.sourceFingerprint),
      staleSourceMatches: legacyActivationSourceMatches(stale, plan.sourceFingerprint),
      rawBytesPreserved: plan.archive.kind === "original-bytes" && JSON.stringify([...plan.archive.bytes]) === JSON.stringify([...rawArchiveBytes]),
      ownerMapping: plan.proofPlan.participantMapping.find(({ sourceParticipantId }) => sourceParticipantId === "old-alice"),
      balances: openingEvent.payload.balances,
      importId: openingEvent.payload.importId,
      genesisId: plan.proofPlan.genesis.id,
      eventType: openingEvent.type,
      gate,
      documentMetadata: { signedGroupVersion: plan.document.signedGroupVersion, hasSharedTrustPin: Object.hasOwn(plan.document, "trustPin"),
        membershipCount: persistedMembership.length, ledgerCount: persistedLedger.length, proofCount: persistedAttestations.length,
        proofBytesPreserved: JSON.stringify([...persistedAttestations[0].archive.bytes]) === JSON.stringify([...rawArchiveBytes]),
        projectionBalances: persistedProjection.balances, projectionReadOnly: persistedProjection.readOnly },
      wrongDigestRejected,
      wrongOwnerRejected,
      empty: { ledgerRecordCount: emptyPlan.proofPlan.ledgerRecords.length,
        mapping: emptyPlan.proofPlan.participantMapping, people: emptyPlan.document.people,
        genesisOwnerName: emptyPlan.proofPlan.genesis.payload.owner.name }
    };
  });

  assert.equal(result.originalUnchanged, true);
  assert.equal(result.sourceMatches, true);
  assert.equal(result.staleSourceMatches, false);
  assert.equal(result.rawBytesPreserved, true);
  assert.equal(result.ownerMapping.participantId, result.gate.event.author.participantId);
  assert.deepEqual(Object.fromEntries(result.balances.map(({ participantId, amount }) => [participantId, amount])),
    Object.fromEntries(result.gate.mappedOpeningBalances.map(({ participantId, amount }) => [participantId, amount])));
  assert.equal(result.importId, result.genesisId);
  assert.equal(result.eventType, "opening-balances-imported");
  assert.equal(result.gate.status, "authorized");
  assert.deepEqual(result.documentMetadata, { signedGroupVersion: 1, hasSharedTrustPin: false, membershipCount: 2, ledgerCount: 1,
    proofCount: 1, proofBytesPreserved: true,
    projectionBalances: Object.fromEntries(result.balances.map(({ participantId, amount }) => [participantId, amount])), projectionReadOnly: false });
  assert.equal(result.wrongDigestRejected, true);
  assert.equal(result.wrongOwnerRejected, true);
  assert.equal(result.empty.ledgerRecordCount, 0);
  assert.deepEqual(result.empty.mapping, []);
  assert.deepEqual(result.empty.people, [], "staged signed documents keep prototype fields empty");
  assert.equal(result.empty.genesisOwnerName, "New owner", "empty source still creates the selected new genesis owner");
});
