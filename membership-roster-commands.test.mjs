import assert from "node:assert/strict";
import { test } from "node:test";
import { exportDevicePublicKey, generateDeviceSigningKeyPair, signRecord } from "./src/identity-crypto.js";
import {
  approveJoinRequestCommand, createDeviceRevocationCommand, createInviteCommand, createJoinRequestCommand,
  createOwnershipTransferAcceptanceCommand, createOwnershipTransferProposalCommand, createParticipantRemovalCommand,
  createVerifiedCausalContext
} from "./src/membership-invitations.js";
import {
  createOrganizerGrantCommand, createOrganizerRevokeCommand, createParticipantAddCommand, createParticipantRenameCommand
} from "./src/membership-roster-commands.js";
import { projectSignedMembership } from "./src/signed-membership-projector.js";
import { createSignedLedgerRecord } from "./src/signed-ledger-records.js";

const uuid = () => crypto.randomUUID();
function encode(bytes) { let out = ""; for (const byte of bytes) out += String.fromCharCode(byte); return btoa(out).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }

async function setup() {
  const pair = await generateDeviceSigningKeyPair();
  const [participantId, deviceId, keyId, groupId, genesisId] = Array.from({ length: 5 }, uuid);
  const bytes = await exportDevicePublicKey(pair.publicKey);
  const genesis = { id: genesisId, groupId, recordType: "group-created", membershipSchemaVersion: 1, protocolVersion: 2,
    author: { participantId, deviceId, keyId }, createdAt: "2026-10-07T00:00:00.000Z", membershipHeads: [], causalHeads: [], dependsOn: [],
    payload: { name: "Trip", currency: "USD", owner: { participantId, deviceId, keyId, name: "Owner", publicKey: encode(bytes) } } };
  genesis.signature = await signRecord(genesis, pair.privateKey);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const trustPin = { genesisId, publicKeyFingerprint: `sha256:${encode(digest)}` };
  const owner = { participantId, deviceId, keyId, publicKey: pair.publicKey, privateKey: pair.privateKey };
  return { genesis, trustPin, owner, records: [genesis], groupId };
}
function command(ctx, identity, membershipHeads, extra = {}) {
  return { groupId: ctx.groupId, membershipHeads, identity, records: ctx.records, trustPin: ctx.trustPin, ...extra };
}

test("owner roster commands add, rename, grant, and revoke through the combined projector", async () => {
  const ctx = await setup();
  const participantId = uuid();
  const added = await createParticipantAddCommand(command(ctx, ctx.owner, [ctx.genesis.id], { participantId, name: "Alice" }));
  ctx.records.push(added);
  const renamed = await createParticipantRenameCommand(command(ctx, ctx.owner, [added.id], { participantId, name: "Alice Two" }));
  ctx.records.push(renamed);
  const granted = await createOrganizerGrantCommand(command(ctx, ctx.owner, [renamed.id], { participantId }));
  ctx.records.push(granted);
  const revoked = await createOrganizerRevokeCommand(command(ctx, ctx.owner, [granted.id], { participantId }));
  ctx.records.push(revoked);
  const projection = await projectSignedMembership(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(projection.participants.find((item) => item.id === participantId).name, "Alice Two");
  assert.equal(projection.organizers.includes(participantId), false);
  assert.deepEqual([added, renamed, granted, revoked].map((record) => record.recordType),
    ["participant-added", "participant-renamed", "organizer-granted", "organizer-revoked"]);
});

test("only an enrolled active organizer adds or renames; organizers cannot change organizer roles", async () => {
  const ctx = await setup();
  const participantId = uuid();
  const added = await createParticipantAddCommand(command(ctx, ctx.owner, [ctx.genesis.id], { participantId, name: "Member" }));
  ctx.records.push(added);
  const invite = await createInviteCommand({ groupId: ctx.groupId, participantId, membershipHeads: [added.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(invite.record);
  const memberPair = await generateDeviceSigningKeyPair();
  const member = { participantId, deviceId: uuid(), keyId: uuid(), ...memberPair };
  const request = await createJoinRequestCommand({ invite: invite.record, token: invite.token, groupId: ctx.groupId,
    membershipHeads: [invite.record.id], identity: member, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(request);
  const approval = await approveJoinRequestCommand({ invite: invite.record, request, token: invite.token, genesis: ctx.genesis,
    trustPin: ctx.trustPin, membershipHeads: [invite.record.id], identity: ctx.owner, records: ctx.records });
  ctx.records.push(approval);
  await assert.rejects(createParticipantAddCommand(command(ctx, member, [approval.id], { participantId: uuid(), name: "Too Soon" })), /not-organizer/);
  const granted = await createOrganizerGrantCommand(command(ctx, ctx.owner, [approval.id], { participantId }));
  ctx.records.push(granted);

  const organizerAddId = uuid();
  const organizerAdd = await createParticipantAddCommand(command(ctx, member, [granted.id], { participantId: organizerAddId, name: "Guest" }));
  ctx.records.push(organizerAdd);
  const organizerRename = await createParticipantRenameCommand(command(ctx, member, [organizerAdd.id], { participantId: organizerAddId, name: "Guest Two" }));
  ctx.records.push(organizerRename);
  await assert.rejects(createOrganizerGrantCommand(command(ctx, member, [organizerRename.id], { participantId: organizerAddId })), /not-owner/);
  await assert.rejects(createParticipantAddCommand(command(ctx, { ...member, participantId: organizerAddId }, [organizerRename.id], { participantId: uuid(), name: "No" })), /not-organizer/);
});

test("malformed participant IDs and names are rejected by the roster schema", async () => {
  const ctx = await setup();
  await assert.rejects(createParticipantAddCommand(command(ctx, ctx.owner, [ctx.genesis.id], { participantId: "bad-id", name: "Alice" })), /invalid-roster-command-input/);
  await assert.rejects(createParticipantAddCommand(command(ctx, ctx.owner, [ctx.genesis.id], { participantId: uuid(), name: " Alice " })), /invalid-membership-payload/);
  await assert.rejects(createParticipantAddCommand(command(ctx, ctx.owner, [ctx.genesis.id], { participantId: uuid(), name: "x".repeat(129) })), /invalid-membership-payload/);
  await assert.rejects(createParticipantRenameCommand(command(ctx, ctx.owner, [ctx.genesis.id], { participantId: uuid(), name: "Nobody" })), /participant-not-active/);
});

test("forged or untrusted membership ancestry cannot authorize a roster command", async () => {
  const ctx = await setup();
  const forged = { id: uuid(), recordType: "organizer-granted", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.groupId, author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-07T00:00:01.000Z", membershipHeads: [ctx.genesis.id], causalHeads: [], dependsOn: [],
    payload: { participantId: uuid() }, signature: "A".repeat(86) };
  ctx.records.push(forged);
  await assert.rejects(createParticipantAddCommand(command(ctx, ctx.owner, [forged.id], { participantId: uuid(), name: "Untrusted" })), /stale-membership-heads/);
  const foreignPin = { ...ctx.trustPin, genesisId: uuid() };
  await assert.rejects(createParticipantAddCommand({ ...command(ctx, ctx.owner, [ctx.genesis.id], { participantId: uuid(), name: "Untrusted" }), trustPin: foreignPin }), /membership-state-untrusted/);
});

test("former owner loses organizer-role authority after a verified ownership transfer", async () => {
  const ctx = await setup();
  const participantId = uuid();
  const added = await createParticipantAddCommand(command(ctx, ctx.owner, [ctx.genesis.id], { participantId, name: "Recipient" }));
  ctx.records.push(added);
  const invite = await createInviteCommand({ groupId: ctx.groupId, participantId, membershipHeads: [added.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(invite.record);
  const memberPair = await generateDeviceSigningKeyPair();
  const member = { participantId, deviceId: uuid(), keyId: uuid(), ...memberPair };
  const request = await createJoinRequestCommand({ invite: invite.record, token: invite.token, groupId: ctx.groupId,
    membershipHeads: [invite.record.id], identity: member, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(request);
  const approval = await approveJoinRequestCommand({ invite: invite.record, request, token: invite.token, genesis: ctx.genesis,
    trustPin: ctx.trustPin, membershipHeads: [invite.record.id], identity: ctx.owner, records: ctx.records });
  ctx.records.push(approval);
  const proposal = await createOwnershipTransferProposalCommand({ groupId: ctx.groupId, recipientParticipantId: participantId,
    recipientDeviceId: member.deviceId, recipientKeyId: member.keyId, membershipHeads: [approval.id], identity: ctx.owner,
    records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(proposal);
  const accepted = await createOwnershipTransferAcceptanceCommand({ proposal, groupId: ctx.groupId, membershipHeads: [proposal.id],
    identity: member, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(accepted);
  await assert.rejects(createOrganizerGrantCommand(command(ctx, ctx.owner, [accepted.id], { participantId: ctx.owner.participantId })), /not-owner/);
  const newRole = await createOrganizerGrantCommand(command(ctx, member, [accepted.id], { participantId: ctx.owner.participantId }));
  assert.equal(newRole.recordType, "organizer-granted");
});

test("removed devices cannot sign roster commands, while verified nonempty removal proofs allow remaining owner commands", async () => {
  const ctx = await setup();
  const participantId = uuid();
  const added = await createParticipantAddCommand(command(ctx, ctx.owner, [ctx.genesis.id], { participantId, name: "Member" }));
  ctx.records.push(added);
  const invite = await createInviteCommand({ groupId: ctx.groupId, participantId, membershipHeads: [added.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(invite.record);
  const memberPair = await generateDeviceSigningKeyPair();
  const member = { participantId, deviceId: uuid(), keyId: uuid(), ...memberPair };
  const request = await createJoinRequestCommand({ invite: invite.record, token: invite.token, groupId: ctx.groupId,
    membershipHeads: [invite.record.id], identity: member, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(request);
  const approval = await approveJoinRequestCommand({ invite: invite.record, request, token: invite.token, genesis: ctx.genesis,
    trustPin: ctx.trustPin, membershipHeads: [invite.record.id], identity: ctx.owner, records: ctx.records });
  ctx.records.push(approval);
  const memberGrant = await createOrganizerGrantCommand(command(ctx, ctx.owner, [approval.id], { participantId }));
  ctx.records.push(memberGrant);
  const memberAdded = await createParticipantAddCommand(command(ctx, member, [memberGrant.id], { participantId: uuid(), name: "Before revocation" }));
  ctx.records.push(memberAdded);

  const emptyProof = await createVerifiedCausalContext({ causalRecords: [], membershipRecords: ctx.records, trustPin: ctx.trustPin });
  const deviceRemoval = await createDeviceRevocationCommand({ participantId, deviceId: member.deviceId, keyId: member.keyId,
    groupId: ctx.groupId, membershipHeads: [memberAdded.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin, causalContext: emptyProof });
  ctx.records.push(deviceRemoval);
  await assert.rejects(createParticipantAddCommand({ ...command(ctx, member, [deviceRemoval.id], { participantId: uuid(), name: "Removed signer" }),
    verifiedCausalContexts: [emptyProof] }), /not-organizer/);

  const causalRecord = await createSignedLedgerRecord({ id: uuid(), type: "expense-created", groupId: ctx.groupId,
    author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-07T00:00:02.000Z", membershipHeads: [deviceRemoval.id], causalHeads: [], dependsOn: [],
    payload: { expenseId: uuid(), description: "Removal proof", currency: "USD", amount: 100,
      payerId: ctx.owner.participantId, splits: [{ participantId: ctx.owner.participantId, amount: 100 }] } }, ctx.owner.privateKey);
  const causalContext = await createVerifiedCausalContext({ causalRecords: [causalRecord], membershipRecords: ctx.records, trustPin: ctx.trustPin });
  assert.equal(causalContext.frontier.length, 1);
  const participantRemoval = await createParticipantRemovalCommand({ participantId, groupId: ctx.groupId,
    membershipHeads: [deviceRemoval.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin,
    causalContext, verifiedCausalContexts: [emptyProof] });
  assert.deepEqual(participantRemoval.causalHeads, causalContext.frontier);
  ctx.records.push(participantRemoval);

  await assert.rejects(createParticipantAddCommand(command(ctx, ctx.owner, [participantRemoval.id], { participantId: uuid(), name: "No proof" })), /stale-membership-heads/);
  const newParticipantId = uuid();
  const postRemovalAdd = await createParticipantAddCommand({ ...command(ctx, ctx.owner, [participantRemoval.id],
    { participantId: newParticipantId, name: "After removal" }), verifiedCausalContexts: [emptyProof, causalContext] });
  ctx.records.push(postRemovalAdd);
  const postRemovalRename = await createParticipantRenameCommand({ ...command(ctx, ctx.owner, [postRemovalAdd.id],
    { participantId: newParticipantId, name: "After removal renamed" }), verifiedCausalContexts: [emptyProof, causalContext] });
  assert.equal(postRemovalRename.payload.name, "After removal renamed");
});

test("command inputs are snapshotted before asynchronous authorization", async () => {
  const ctx = await setup();
  const pending = createParticipantAddCommand(command(ctx, ctx.owner, [ctx.genesis.id], { participantId: uuid(), name: "Snapshot" }));
  ctx.records.push({ malformed: true });
  const record = await pending;
  assert.equal(record.payload.name, "Snapshot");
});

test("stale heads, permanent participant tombstones, owner revocation, and a mismatched private key are rejected", async () => {
  const ctx = await setup();
  const participantId = uuid();
  const added = await createParticipantAddCommand(command(ctx, ctx.owner, [ctx.genesis.id], { participantId, name: "Alice" }));
  ctx.records.push(added);
  await assert.rejects(createParticipantRenameCommand(command(ctx, ctx.owner, [ctx.genesis.id], { participantId, name: "Old" })), /stale-membership-heads/);
  await assert.rejects(createOrganizerRevokeCommand(command(ctx, ctx.owner, [added.id], { participantId: ctx.owner.participantId })), /cannot-revoke-owner/);
  const wrongPair = await generateDeviceSigningKeyPair();
  await assert.rejects(createParticipantRenameCommand(command(ctx, { ...ctx.owner, privateKey: wrongPair.privateKey }, [added.id], { participantId, name: "Bad" })), /signature-key-mismatch/);
  const causalContext = await createVerifiedCausalContext({ causalRecords: [], membershipRecords: ctx.records, trustPin: ctx.trustPin });
  const removal = await createParticipantRemovalCommand({ groupId: ctx.groupId, participantId, membershipHeads: [added.id],
    identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin, causalContext });
  ctx.records.push(removal);
  await assert.rejects(createParticipantAddCommand({ ...command(ctx, ctx.owner, [removal.id], { participantId, name: "Reused" }),
    verifiedCausalContexts: [causalContext] }), /participant-id-unavailable/);
});
