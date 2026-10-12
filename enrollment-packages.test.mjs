import assert from "node:assert/strict";
import { test } from "node:test";
import { exportDevicePublicKey, generateDeviceSigningKeyPair, signRecord } from "./src/identity-crypto.js";
import { approveJoinRequestCommand, createDeviceRevocationCommand, createInviteCommand, createJoinRequestCommand,
  createVerifiedCausalContext, createOwnerDeviceConsentCommand, createOwnershipTransferProposalCommand,
  createOwnershipTransferAcceptanceCommand } from "./src/membership-invitations.js";
import { createSignedLedgerRecord } from "./src/signed-ledger-records.js";
import { projectAuthenticatedLedger } from "./src/authenticated-ledger.js";
import { createLegacyHistoryAttestation } from "./src/legacy-history-attestation.js";
import { prepareLegacyActivationReview } from "./src/legacy-activation-review.js";
import { createApprovalBootstrapPackage, createInviteBootstrapPackage, createJoinRequestPackage,
  verifyApprovalBootstrapPackage, verifyInviteBootstrapPackage, verifyJoinRequestPackage } from "./src/enrollment-packages.js";

function encode(bytes) {
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return btoa(out).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
const uuid = () => crypto.randomUUID();

async function setup() {
  const pair = await generateDeviceSigningKeyPair();
  const [participantId, deviceId, keyId, groupId, genesisId, inviteeId] = Array.from({ length: 6 }, uuid);
  const publicBytes = await exportDevicePublicKey(pair.publicKey);
  const genesis = { id: genesisId, groupId, recordType: "group-created", membershipSchemaVersion: 1, protocolVersion: 2,
    author: { participantId, deviceId, keyId }, createdAt: "2026-10-07T00:00:00.000Z", membershipHeads: [], causalHeads: [], dependsOn: [],
    payload: { name: "Trip", currency: "USD", owner: { participantId, deviceId, keyId, name: "Owner", publicKey: encode(publicBytes) } } };
  genesis.signature = await signRecord(genesis, pair.privateKey);
  const trustPin = { genesisId, publicKeyFingerprint: `sha256:${encode(new Uint8Array(await crypto.subtle.digest("SHA-256", publicBytes)))}` };
  const owner = { participantId, deviceId, keyId, ...pair };
  const participant = { participantId: inviteeId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const add = { id: uuid(), recordType: "participant-added", membershipSchemaVersion: 1, protocolVersion: 2, groupId,
    author: { participantId, deviceId, keyId }, createdAt: "2026-10-07T00:00:01.000Z", membershipHeads: [genesisId], causalHeads: [], dependsOn: [],
    payload: { participantId: inviteeId, name: "Member" } };
  add.signature = await signRecord(add, pair.privateKey);
  const records = [genesis, add];
  const issued = await createInviteCommand({ groupId, participantId: inviteeId, membershipHeads: [add.id], identity: owner, records,
    trustPin, expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() });
  records.push(issued.record);
  const request = await createJoinRequestCommand({ invite: issued.record, token: issued.token, groupId,
    membershipHeads: [issued.record.id], identity: participant, records, trustPin });
  return { trustPin, owner, participant, genesis, invite: issued.record, token: issued.token, request, records };
}

test("invite, request, and approval handoffs preserve exact signed history and bind the local key", async () => {
  const ctx = await setup();
  const legacySource = { name: "Imported history", currency: "USD", groupId: uuid(), people: [], events: [] };
  const archiveBytes = new TextEncoder().encode(JSON.stringify(legacySource, null, 2));
  const archive = (await prepareLegacyActivationReview(legacySource, { rawArchiveBytes: archiveBytes })).archive;
  const legacyProof = await createLegacyHistoryAttestation({ archive, membershipHeads: [ctx.genesis.id], identity: ctx.owner,
    membershipRecords: ctx.records, trustPin: ctx.trustPin });
  const evidence = [legacyProof];
  const bootstrap = await createInviteBootstrapPackage({ membershipRecords: ctx.records, ledgerRecords: [], legacyAttestations: evidence,
    invite: ctx.invite, token: ctx.token, trustPin: ctx.trustPin });
  assert.equal(JSON.stringify(bootstrap).includes(ctx.token), true); // Only the deliberate invite package carries it.
  const checkedBootstrap = await verifyInviteBootstrapPackage(JSON.stringify(bootstrap));
  assert.equal(checkedBootstrap.ok, true);
  assert.deepEqual(checkedBootstrap.legacyAttestations[0].archive.bytes, archiveBytes);
  const alteredArchive = structuredClone(bootstrap);
  alteredArchive.legacyAttestations[0].archive.bytes.value = `${alteredArchive.legacyAttestations[0].archive.bytes.value.slice(0, -1)}A`;
  assert.equal((await verifyInviteBootstrapPackage(alteredArchive)).ok, false);
  const join = createJoinRequestPackage({ bootstrap: checkedBootstrap, request: ctx.request });
  assert.equal(JSON.stringify(join).includes(ctx.token), false);
  assert.equal((await verifyJoinRequestPackage(JSON.stringify(join), { bootstrap })).ok, true);

  const approval = await approveJoinRequestCommand({ invite: ctx.invite, request: ctx.request, token: ctx.token,
    genesis: ctx.genesis, trustPin: ctx.trustPin, membershipHeads: [ctx.invite.id], identity: ctx.owner, records: [...ctx.records, ctx.request] });
  const proof = await createApprovalBootstrapPackage({ membershipRecords: [...ctx.records, ctx.request, approval], ledgerRecords: [],
    legacyAttestations: evidence, trustPin: ctx.trustPin });
  const duplicateProof = await createApprovalBootstrapPackage({ membershipRecords: [...proof.membershipRecords, structuredClone(ctx.request)],
    ledgerRecords: [...proof.ledgerRecords], legacyAttestations: evidence, trustPin: ctx.trustPin });
  assert.equal(duplicateProof.membershipRecords.length, proof.membershipRecords.length);
  const verified = await verifyApprovalBootstrapPackage(JSON.stringify(proof), { bootstrap, request: ctx.request,
    identity: { ...ctx.participant, publicKey: ctx.participant.publicKey } });
  assert.equal(verified.ok, true, verified.reason);
  assert.equal(verified.enrolledDevice.deviceId, ctx.participant.deviceId);
  assert.deepEqual(verified.legacyAttestations[0].archive.bytes, archiveBytes);
  const realNow = Date.now;
  Date.now = () => Date.parse(ctx.invite.payload.expiresAt) + 1;
  try {
    assert.equal((await verifyApprovalBootstrapPackage(proof, { bootstrap, request: ctx.request, identity: ctx.participant })).ok, true,
      "historical approval proof remains verifiable after expiry");
  } finally { Date.now = realNow; }

  const droppedRequest = { ...proof, membershipRecords: proof.membershipRecords.filter((record) => record.id !== ctx.request.id) };
  assert.equal((await verifyApprovalBootstrapPackage(droppedRequest, { bootstrap, request: ctx.request, identity: ctx.participant })).ok, false);
  const droppedArchive = { ...proof, legacyAttestations: [] };
  assert.equal((await verifyApprovalBootstrapPackage(droppedArchive, { bootstrap, request: ctx.request, identity: ctx.participant })).reason,
    "final-proof-dropped-original-records");
  const wrongPin = { ...proof, trustPin: { ...proof.trustPin, publicKeyFingerprint: `sha256:${"A".repeat(43)}` } };
  assert.equal((await verifyApprovalBootstrapPackage(wrongPin, { bootstrap, request: ctx.request, identity: ctx.participant })).reason,
    "final-proof-trust-mismatch");
  const badApproval = structuredClone(proof);
  badApproval.membershipRecords.find((record) => record.recordType === "device-enrollment-approved").payload.requestId = uuid();
  assert.equal((await verifyApprovalBootstrapPackage(badApproval, { bootstrap, request: ctx.request, identity: ctx.participant })).ok, false);
  const consumed = { ...bootstrap, membershipRecords: [...bootstrap.membershipRecords, ctx.request, approval] };
  assert.equal((await verifyInviteBootstrapPackage(consumed)).reason, "invite-already-consumed");
  const wrongTarget = { ...join, request: { ...join.request, payload: { ...join.request.payload, participantId: uuid() } } };
  assert.equal((await verifyJoinRequestPackage(wrongTarget, { bootstrap })).reason, "request-binding-mismatch");
  const differentKey = { ...ctx.participant, ...await generateDeviceSigningKeyPair() };
  assert.equal((await verifyApprovalBootstrapPackage(proof, { bootstrap, request: ctx.request, identity: differentKey })).reason, "request-local-key-mismatch");
});

test("owner device requires signed owner consent before final proof accepts enrollment", async () => {
  const ctx = await setup();
  const memberApproval = await approveJoinRequestCommand({ invite: ctx.invite, request: ctx.request, token: ctx.token,
    genesis: ctx.genesis, trustPin: ctx.trustPin, membershipHeads: [ctx.invite.id], identity: ctx.owner,
    records: [...ctx.records, ctx.request] });
  let records = [...ctx.records, ctx.request, memberApproval];
  const transfer = await createOwnershipTransferProposalCommand({ groupId: ctx.genesis.groupId,
    recipientParticipantId: ctx.participant.participantId, recipientDeviceId: ctx.participant.deviceId,
    recipientKeyId: ctx.participant.keyId, membershipHeads: [memberApproval.id], identity: ctx.owner, records, trustPin: ctx.trustPin });
  const accepted = await createOwnershipTransferAcceptanceCommand({ proposal: transfer, groupId: ctx.genesis.groupId,
    membershipHeads: [transfer.id], identity: ctx.participant, records: [...records, transfer], trustPin: ctx.trustPin });
  records.push(transfer, accepted);
  const invite = await createInviteCommand({ groupId: ctx.genesis.groupId, participantId: ctx.participant.participantId,
    membershipHeads: [accepted.id], identity: ctx.participant, records, trustPin: ctx.trustPin });
  records.push(invite.record);
  const newDevice = { participantId: ctx.participant.participantId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const request = await createJoinRequestCommand({ invite: invite.record, token: invite.token, groupId: ctx.genesis.groupId,
    membershipHeads: [invite.record.id], identity: newDevice, records, trustPin: ctx.trustPin });
  const bootstrap = await createInviteBootstrapPackage({ membershipRecords: records, ledgerRecords: [], legacyAttestations: [],
    invite: invite.record, token: invite.token, trustPin: ctx.trustPin });
  const approval = await approveJoinRequestCommand({ invite: invite.record, request, token: invite.token, genesis: ctx.genesis,
    trustPin: ctx.trustPin, membershipHeads: [invite.record.id], identity: ctx.owner, records: [...records, request] });
  const unconsented = await createApprovalBootstrapPackage({ membershipRecords: [...records, request, approval], ledgerRecords: [],
    legacyAttestations: [], trustPin: ctx.trustPin });
  assert.equal((await verifyApprovalBootstrapPackage(unconsented, { bootstrap, request, identity: newDevice })).reason,
    "device-not-enrolled-at-final-proof");
  const consent = await createOwnerDeviceConsentCommand({ approval, groupId: ctx.genesis.groupId, membershipHeads: [approval.id],
    identity: ctx.participant, records: [...records, request, approval], trustPin: ctx.trustPin });
  const final = await createApprovalBootstrapPackage({ membershipRecords: [...records, request, approval, consent], ledgerRecords: [],
    legacyAttestations: [], trustPin: ctx.trustPin });
  assert.equal((await verifyApprovalBootstrapPackage(final, { bootstrap, request, identity: newDevice })).ok, true);
});

test("bounded package decoders reject malformed and oversized inputs before projection", async () => {
  assert.equal((await verifyInviteBootstrapPackage("{" )).reason, "invalid-package-json");
  assert.equal((await verifyInviteBootstrapPackage(" ".repeat(32 * 1024 * 1024 + 1))).reason, "package-too-large");
  const ctx = await setup();
  const bootstrap = await createInviteBootstrapPackage({ membershipRecords: ctx.records, ledgerRecords: [], legacyAttestations: [],
    invite: ctx.invite, token: ctx.token, trustPin: ctx.trustPin });
  const duplicateInvite = { ...bootstrap, membershipRecords: [...bootstrap.membershipRecords, structuredClone(ctx.invite)] };
  const duplicateVerified = await verifyInviteBootstrapPackage(duplicateInvite);
  assert.equal(duplicateVerified.ok, true, duplicateVerified.reason);
  assert.equal(duplicateVerified.package.membershipRecords.filter((record) => record.id === ctx.invite.id).length, 1);
  const conflictingInvite = structuredClone(ctx.invite);
  conflictingInvite.payload.expiresAt = null;
  const conflictVerified = await verifyInviteBootstrapPackage({ ...bootstrap,
    membershipRecords: [...bootstrap.membershipRecords, conflictingInvite] });
  assert.equal(conflictVerified.ok, false, "distinct content sharing an invite ID stays a collision");
  bootstrap.legacyAttestations = [{ record: {}, archive: { kind: "original-bytes", mediaType: "application/json",
    bytes: { encoding: "base64url-no-padding", value: "!!!!" } } }];
  assert.equal((await verifyInviteBootstrapPackage(bootstrap)).reason, "invalid-proof-archive");
});

test("non-effective rejected audit entries stay in the handoff without changing authority", async () => {
  const ctx = await setup();
  const offline = { participantId: uuid(), deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const added = { id: uuid(), recordType: "participant-added", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.genesis.groupId, author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-07T00:00:02.000Z", membershipHeads: [ctx.invite.id], causalHeads: [], dependsOn: [],
    payload: { participantId: offline.participantId, name: "Offline member" } };
  added.signature = await signRecord(added, ctx.owner.privateKey);
  const records = [...ctx.records, added];
  const offlineInvite = await createInviteCommand({ groupId: ctx.genesis.groupId, participantId: offline.participantId,
    membershipHeads: [added.id], identity: ctx.owner, records, trustPin: ctx.trustPin });
  records.push(offlineInvite.record);
  const request = await createJoinRequestCommand({ invite: offlineInvite.record, token: offlineInvite.token,
    groupId: ctx.genesis.groupId, membershipHeads: [offlineInvite.record.id], identity: offline, records, trustPin: ctx.trustPin });
  records.push(request);
  const approval = await approveJoinRequestCommand({ invite: offlineInvite.record, request, token: offlineInvite.token,
    genesis: ctx.genesis, trustPin: ctx.trustPin, membershipHeads: [offlineInvite.record.id], identity: ctx.owner, records });
  records.push(approval);
  const event = async (description, amount, expenseId = uuid()) => createSignedLedgerRecord({ id: uuid(), type: "expense-created",
    groupId: ctx.genesis.groupId,
    author: { participantId: offline.participantId, deviceId: offline.deviceId, keyId: offline.keyId },
    createdAt: new Date().toISOString(), membershipHeads: [approval.id], causalHeads: [], dependsOn: [],
    payload: { expenseId, description, currency: "USD", amount, payerId: offline.participantId,
      splits: [{ participantId: ctx.owner.participantId, amount: amount / 2 }, { participantId: offline.participantId, amount: amount / 2 }] }
  }, offline.privateKey);
  const observed = await event("Before revocation", 10_000);
  const causalContext = await createVerifiedCausalContext({ causalRecords: [observed], membershipRecords: records, trustPin: ctx.trustPin });
  const removal = await createDeviceRevocationCommand({ participantId: offline.participantId, deviceId: offline.deviceId,
    keyId: offline.keyId, groupId: ctx.genesis.groupId, membershipHeads: [approval.id], identity: ctx.owner,
    records, trustPin: ctx.trustPin, causalContext });
  records.push(removal);
  const stale = await event("Offline after revocation", 5_000);
  const ledgerRecords = [observed, stale];
  const bootstrap = await createInviteBootstrapPackage({ membershipRecords: records, ledgerRecords, legacyAttestations: [],
    invite: ctx.invite, token: ctx.token, trustPin: ctx.trustPin });
  const verified = await verifyInviteBootstrapPackage(bootstrap);
  assert.equal(verified.ok, true, verified.reason);
  const withoutRejected = await projectAuthenticatedLedger([observed], { membershipRecords: records, trustPin: ctx.trustPin });
  assert.deepEqual(verified.ledger.balances, withoutRejected.balances);
  assert.deepEqual(verified.ledger.rawRecords, ledgerRecords);
  assert.ok(verified.ledger.quarantined.some((item) => item.id === stale.id && item.reason === "author-revoked-at-causal-frontier"));
  const forged = { ...observed, signature: `${observed.signature.slice(0, -1)}${observed.signature.endsWith("A") ? "B" : "A"}` };
  await assert.rejects(createInviteBootstrapPackage({ membershipRecords: records, ledgerRecords: [forged], legacyAttestations: [],
    invite: ctx.invite, token: ctx.token, trustPin: ctx.trustPin }), /incomplete-or-invalid-package-ledger/);
  const longHistory = await createInviteBootstrapPackage({ membershipRecords: records, ledgerRecords: Array(300).fill(observed),
    legacyAttestations: [], invite: ctx.invite, token: ctx.token, trustPin: ctx.trustPin });
  const longHistoryProof = await verifyInviteBootstrapPackage(longHistory);
  assert.equal(longHistoryProof.ok, true, longHistoryProof.reason);
  assert.equal(longHistoryProof.ledger.rawRecords.length, 1, "identical event deliveries normalize at the package boundary");
});
