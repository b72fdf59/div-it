import assert from "node:assert/strict";
import { test } from "node:test";
import { exportDevicePublicKey, generateDeviceSigningKeyPair, signRecord } from "./src/identity-crypto.js";
import { approveJoinRequestCommand, createInviteCommand, createJoinRequestCommand, createInviteRevocationCommand, createInviteConflictResolutionCommand, createOwnerDeviceConsentCommand, createOwnershipTransferProposalCommand, createOwnershipTransferAcceptanceCommand, createOwnershipTransferResolutionCommand, createDeviceRevocationCommand, createParticipantRemovalCommand, createVerifiedCausalContext, projectMembershipEnrollment } from "./src/membership-invitations.js";
import { createSignedLedgerRecord } from "./src/signed-ledger-records.js";

function encode(bytes) { let out = ""; for (const byte of bytes) out += String.fromCharCode(byte); return btoa(out).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_"); }
const uuid = () => crypto.randomUUID();

async function setup() {
  const pair = await generateDeviceSigningKeyPair();
  const ids = [uuid(), uuid(), uuid(), uuid(), uuid()];
  const [participantId, deviceId, keyId, groupId, genesisId] = ids;
  const bytes = await exportDevicePublicKey(pair.publicKey);
  const genesis = { id: genesisId, groupId, recordType: "group-created", membershipSchemaVersion: 1, protocolVersion: 2,
    author: { participantId, deviceId, keyId }, createdAt: "2026-10-07T00:00:00.000Z", membershipHeads: [], causalHeads: [], dependsOn: [],
    payload: { name: "Trip", currency: "USD", owner: { participantId, deviceId, keyId, name: "Owner", publicKey: encode(bytes) } } };
  genesis.signature = await signRecord(genesis, pair.privateKey);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const trustPin = { genesisId, publicKeyFingerprint: `sha256:${encode(digest)}` };
  const owner = { participantId, deviceId, keyId, publicKey: pair.publicKey, privateKey: pair.privateKey };
  const member = { participantId: uuid(), deviceId: uuid(), keyId: uuid(), pair: await generateDeviceSigningKeyPair() };
  const memberRecord = await rosterRecord({ groupId, author: owner, privateKey: pair.privateKey, head: genesisId,
    recordType: "participant-added", payload: { participantId: member.participantId, name: "Member" } });
  const records = [genesis, memberRecord];
  return { genesis, trustPin, owner, member, records };
}

test("causal proof contexts cannot cross group or trusted-genesis pins", async () => {
  const ctx = await setup();
  const local = await createVerifiedCausalContext({ causalRecords: [], membershipRecords: ctx.records, trustPin: ctx.trustPin });
  await assert.rejects(createVerifiedCausalContext({ causalRecords: [], membershipRecords: ctx.records, trustPin: ctx.trustPin,
    priorContexts: [{ groupId: ctx.genesis.groupId, frontier: [] }] }), /causal-context-invalid-prior-context/);
  const otherGroup = await setup();
  const otherGroupContext = await createVerifiedCausalContext({ causalRecords: [], membershipRecords: otherGroup.records, trustPin: otherGroup.trustPin });
  await assert.rejects(createVerifiedCausalContext({ causalRecords: [], membershipRecords: ctx.records, trustPin: ctx.trustPin,
    priorContexts: [otherGroupContext] }), /causal-context-invalid-prior-context/);
  const foreignGenesis = structuredClone(ctx.genesis);
  foreignGenesis.id = uuid();
  foreignGenesis.payload.name = "Other trusted history";
  foreignGenesis.signature = await signRecord(foreignGenesis, ctx.owner.privateKey);
  const foreignContext = await createVerifiedCausalContext({ causalRecords: [], membershipRecords: [foreignGenesis],
    trustPin: { genesisId: foreignGenesis.id, publicKeyFingerprint: ctx.trustPin.publicKeyFingerprint } });
  assert.equal(foreignContext.groupId, ctx.genesis.groupId);
  await assert.rejects(createVerifiedCausalContext({ causalRecords: [], membershipRecords: ctx.records, trustPin: ctx.trustPin,
    priorContexts: [foreignContext] }), /causal-context-invalid-prior-context/);
  assert.deepEqual(local.frontier, []);
});

async function rosterRecord({ groupId, author, privateKey, head, recordType, payload }) {
  const record = { id: uuid(), recordType, membershipSchemaVersion: 1, protocolVersion: 2, groupId,
    author: { participantId: author.participantId, deviceId: author.deviceId, keyId: author.keyId },
    createdAt: "2026-10-07T00:00:01.000Z", membershipHeads: [head], causalHeads: [], dependsOn: [], payload };
  record.signature = await signRecord(record, privateKey); return record;
}

async function issueInvite(ctx, identity, participantId, heads = [ctx.records.at(-1).id]) {
  const result = await createInviteCommand({ groupId: ctx.genesis.groupId, participantId, membershipHeads: heads,
    identity, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(result.record); return result;
}
async function requestJoin(ctx, invite, member, heads = [invite.record.id]) {
  const request = await createJoinRequestCommand({ invite: invite.record, token: invite.token, groupId: ctx.genesis.groupId,
    membershipHeads: heads, identity: member, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(request); return request;
}
async function approve(ctx, invite, request, identity, heads = [invite.record.id]) {
  const approval = await approveJoinRequestCommand({ invite: invite.record, request, token: invite.token, genesis: ctx.genesis,
    trustPin: ctx.trustPin, membershipHeads: heads, identity, records: ctx.records });
  ctx.records.push(approval); return approval;
}

test("invite bearer remains private and approval activates only its proved device key", async () => {
  const ctx = await setup();
  const invite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const request = await requestJoin(ctx, invite, { ...ctx.member, ...ctx.member.pair });
  await assert.rejects(approveJoinRequestCommand({ invite: invite.record, request, token: "A".repeat(43), genesis: ctx.genesis,
    trustPin: ctx.trustPin, membershipHeads: [invite.record.id], identity: ctx.owner, records: ctx.records }), /invalid-invite-token/);
  const altered = structuredClone(invite.record); altered.payload.tokenHash = `sha256:${"A".repeat(43)}`;
  await assert.rejects(approveJoinRequestCommand({ invite: altered, request, token: invite.token, genesis: ctx.genesis,
    trustPin: ctx.trustPin, membershipHeads: [invite.record.id], identity: ctx.owner, records: ctx.records }), /invite-not-authenticated-at-heads/);
  const approval = await approve(ctx, invite, request, ctx.owner);
  assert.equal(JSON.stringify([invite.record, request, approval]).includes(invite.token), false);
  const projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(projection.devices.some((item) => item.deviceId === ctx.member.deviceId && item.approvalId === approval.id), true);
  assert.deepEqual(projection.devices, (await projectMembershipEnrollment([...ctx.records].reverse(), { trustPin: ctx.trustPin })).devices);
});

test("enrolled organizer can invite and approve from verified heads; ordinary member cannot", async () => {
  const ctx = await setup();
  const invite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const request = await requestJoin(ctx, invite, { ...ctx.member, ...ctx.member.pair });
  const approval = await approve(ctx, invite, request, ctx.owner);
  const organizerId = ctx.member.participantId;
  const grant = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: approval.id, recordType: "organizer-granted", payload: { participantId: organizerId } });
  ctx.records.push(grant);
  const organizer = { ...ctx.member, ...ctx.member.pair };
  await assert.rejects(issueInvite(ctx, organizer, organizerId, [ctx.records[1].id]), /not-organizer/);
  const secondInvite = await issueInvite(ctx, organizer, organizerId, [grant.id]);
  const secondMember = { participantId: organizerId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const secondRequest = await requestJoin(ctx, secondInvite, secondMember);
  await approve(ctx, secondInvite, secondRequest, organizer);
  const projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(projection.devices.length, 3);
  const ordinaryId = uuid();
  const ordinaryAdd = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: grant.id, recordType: "participant-added", payload: { participantId: ordinaryId, name: "Ordinary" } });
  ctx.records.push(ordinaryAdd);
  const ordinaryInvite = await issueInvite(ctx, ctx.owner, ordinaryId, [ordinaryAdd.id]);
  const ordinary = { participantId: ordinaryId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const ordinaryRequest = await requestJoin(ctx, ordinaryInvite, ordinary);
  await approve(ctx, ordinaryInvite, ordinaryRequest, ctx.owner);
  await assert.rejects(issueInvite(ctx, ordinary, organizerId, [ordinaryAdd.id]), /not-organizer/);
  const revoke = await createInviteRevocationCommand({ inviteId: secondInvite.record.payload.inviteId,
    groupId: ctx.genesis.groupId, membershipHeads: [secondInvite.record.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(revoke);
  const roleRevoke = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: revoke.id, recordType: "organizer-revoked", payload: { participantId: organizerId } });
  ctx.records.push(roleRevoke);
  await assert.rejects(issueInvite(ctx, organizer, organizerId, [roleRevoke.id]), /not-organizer/);
});

test("forged parent and revoked organizer head cannot authorize an invite", async () => {
  const ctx = await setup();
  const forged = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: ctx.genesis.id, recordType: "organizer-granted", payload: { participantId: ctx.member.participantId } });
  forged.payload.participantId = uuid(); // keep original signature invalid
  const invite = { ...ctx.genesis, id: uuid(), recordType: "invite-issued", membershipHeads: [forged.id] };
  ctx.records.push(forged, invite);
  const projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, atHeads: [forged.id] });
  assert.equal(projection.groupId, null);
  assert.equal(projection.readOnly, true);
  const alternateGenesis = structuredClone(ctx.genesis);
  alternateGenesis.payload.name = "Foreign";
  alternateGenesis.signature = await signRecord(alternateGenesis, ctx.owner.privateKey);
  for (const records of [[ctx.genesis, alternateGenesis], [alternateGenesis, ctx.genesis]]) {
    const collision = await projectMembershipEnrollment(records, { trustPin: ctx.trustPin });
    assert.equal(collision.groupId, null);
    assert.equal(collision.diagnostics.some((item) => item.reason === "trusted-genesis-id-collision"), true);
  }
  const alternateMember = structuredClone(ctx.records[1]);
  alternateMember.payload.name = "Impostor";
  alternateMember.signature = await signRecord(alternateMember, ctx.owner.privateKey);
  for (const records of [[ctx.genesis, ctx.records[1], alternateMember], [alternateMember, ctx.records[1], ctx.genesis]]) {
    const collision = await projectMembershipEnrollment(records, { trustPin: ctx.trustPin });
    assert.equal(collision.diagnostics.some((item) => item.recordId === alternateMember.id && item.reason === "id-content-collision"), true);
    assert.equal(collision.participants.some((item) => item.id === ctx.member.participantId), false);
  }
  const duplicateCollision = await projectMembershipEnrollment([ctx.genesis, ctx.records[1], alternateMember,
    ...Array.from({ length: 300 }, () => structuredClone(alternateMember))], { trustPin: ctx.trustPin });
  assert.equal(duplicateCollision.groupId, ctx.genesis.groupId);
  assert.equal(duplicateCollision.diagnostics.some((item) => item.reason === "membership-record-limit"), false);
  const future = { id: uuid(), groupId: ctx.genesis.groupId, recordType: "future-membership", membershipSchemaVersion: 1, protocolVersion: 2,
    author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-07T00:00:02.000Z", membershipHeads: [ctx.records[1].id], causalHeads: [], dependsOn: [], payload: { future: true } };
  future.signature = await signRecord(future, ctx.owner.privateKey);
  ctx.records.push(future);
  const futureProjection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(futureProjection.readOnly, true);
  assert.ok(futureProjection.diagnostics.some((item) => item.recordId === future.id
    && item.status === "unsupported" && item.reason === "unsupported-membership-record"));
  await assert.rejects(issueInvite(ctx, ctx.owner, ctx.member.participantId, [ctx.records[1].id]), /not-organizer/);
  ctx.records.pop();
  ctx.records = [ctx.genesis, ctx.records[1]];
  const seedInvite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const missing = structuredClone(seedInvite.record);
  missing.id = uuid(); missing.payload.inviteId = uuid(); missing.membershipHeads = [uuid()];
  missing.signature = await signRecord(missing, ctx.owner.privateKey);
  const a = structuredClone(seedInvite.record); const b = structuredClone(seedInvite.record);
  a.id = uuid(); b.id = uuid(); a.payload.inviteId = uuid(); b.payload.inviteId = uuid();
  a.membershipHeads = [b.id]; b.membershipHeads = [a.id];
  a.signature = await signRecord(a, ctx.owner.privateKey); b.signature = await signRecord(b, ctx.owner.privateKey);
  const malformed = await projectMembershipEnrollment([ctx.genesis, ctx.records[1], missing, a, b], { trustPin: ctx.trustPin });
  assert.equal(malformed.diagnostics.some((item) => item.recordId === missing.id && item.reason === "missing-membership-head"), true);
  assert.equal(malformed.diagnostics.some((item) => [a.id, b.id].includes(item.recordId) && item.reason === "membership-cycle"), true);
});

test("same-invite approval branches need a complete owner resolution; competing resolutions stay pending", async () => {
  const ctx = await setup();
  const invite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const first = { ...ctx.member, ...ctx.member.pair };
  const second = { ...ctx.member, ...await generateDeviceSigningKeyPair(), deviceId: uuid(), keyId: uuid() };
  const requests = [await requestJoin(ctx, invite, first), await requestJoin(ctx, invite, second)];
  const approvals = [await approve(ctx, invite, requests[0], ctx.owner), await approve(ctx, invite, requests[1], ctx.owner)];
  let projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(projection.devices.length, 1); // genesis owner only
  assert.ok(projection.diagnostics.some((item) => item.reason === "conflicting-join-approvals"));
  const [left, right] = approvals;
  const resolutionA = await createInviteConflictResolutionCommand({ inviteId: invite.record.payload.inviteId,
    conflictRecordIds: approvals.map((record) => record.id).sort(), selectedRecordId: left.id, groupId: ctx.genesis.groupId,
    membershipHeads: approvals.map((record) => record.id).sort(), identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(resolutionA);
  const resolutionB = await createInviteConflictResolutionCommand({ inviteId: invite.record.payload.inviteId,
    conflictRecordIds: approvals.map((record) => record.id).sort(), selectedRecordId: right.id, groupId: ctx.genesis.groupId,
    membershipHeads: approvals.map((record) => record.id).sort(), identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(resolutionB);
  projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(projection.devices.length, 1);
  assert.ok(projection.diagnostics.some((item) => item.reason === "conflicting-join-approvals"));
  const finalResolution = await createInviteConflictResolutionCommand({ inviteId: invite.record.payload.inviteId,
    conflictRecordIds: approvals.map((record) => record.id).sort(), selectedRecordId: left.id, groupId: ctx.genesis.groupId,
    membershipHeads: [resolutionA.id, resolutionB.id].sort(), identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(finalResolution);
  projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(projection.devices.length, 2);
  assert.equal(projection.devices.some((device) => device.deviceId === left.payload.deviceId), true);
  assert.equal(projection.devices.some((device) => device.deviceId === right.payload.deviceId), false);
});

test("a newly conflicting enrollment retracts descendant organizer writes", async () => {
  const ctx = await setup();
  const invite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const first = { ...ctx.member, ...ctx.member.pair };
  const alternate = { ...ctx.member, ...await generateDeviceSigningKeyPair(), deviceId: uuid(), keyId: uuid() };
  const requestA = await requestJoin(ctx, invite, first);
  const requestB = await requestJoin(ctx, invite, alternate);
  const approvalA = await approve(ctx, invite, requestA, ctx.owner);
  const grant = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: approvalA.id, recordType: "organizer-granted", payload: { participantId: ctx.member.participantId } });
  ctx.records.push(grant);
  const childInvite = await issueInvite(ctx, first, ctx.member.participantId, [grant.id]);
  const approvalB = await approve(ctx, invite, requestB, ctx.owner, [invite.record.id]);
  const projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(projection.invites.some((item) => item.recordId === childInvite.record.id), false);
  assert.equal(projection.devices.some((item) => item.approvalId === approvalA.id || item.approvalId === approvalB.id), false);
  assert.ok(projection.diagnostics.some((item) => item.reason === "conflicting-join-approvals"));
});

test("owner device approved by a co-organizer needs an active owner-device countersignature", async () => {
  const ctx = await setup();
  const memberInvite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const memberRequest = await requestJoin(ctx, memberInvite, { ...ctx.member, ...ctx.member.pair });
  const memberApproval = await approve(ctx, memberInvite, memberRequest, ctx.owner);
  const grant = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: memberApproval.id, recordType: "organizer-granted", payload: { participantId: ctx.member.participantId } });
  ctx.records.push(grant);
  const ownerInvite = await issueInvite(ctx, { ...ctx.member, ...ctx.member.pair }, ctx.owner.participantId, [grant.id]);
  const replacement = { participantId: ctx.owner.participantId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const request = await requestJoin(ctx, ownerInvite, replacement);
  const approval = await approve(ctx, ownerInvite, request, { ...ctx.member, ...ctx.member.pair });
  const beforeConsent = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(beforeConsent.devices.some((item) => item.approvalId === approval.id), false);
  const consent = await createOwnerDeviceConsentCommand({ approval, groupId: ctx.genesis.groupId, membershipHeads: [approval.id],
    identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(consent);
  const afterConsent = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(afterConsent.devices.some((item) => item.approvalId === approval.id), true);
  const replacementIdentity = { ...replacement };
  const ownerIssuedInvite = await issueInvite(ctx, replacementIdentity, ctx.member.participantId, [consent.id]);
  assert.equal(ownerIssuedInvite.record.author.deviceId, replacement.deviceId);
});

test("owner resolution names every concurrent approval and revocation branch", async () => {
  const ctx = await setup();
  const invite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const first = { ...ctx.member, ...ctx.member.pair };
  const second = { ...ctx.member, ...await generateDeviceSigningKeyPair(), deviceId: uuid(), keyId: uuid() };
  const requestA = await requestJoin(ctx, invite, first);
  const requestB = await requestJoin(ctx, invite, second);
  const approvalA = await approve(ctx, invite, requestA, ctx.owner);
  const approvalB = await approve(ctx, invite, requestB, ctx.owner);
  const revocationA = await createInviteRevocationCommand({ inviteId: invite.record.payload.inviteId, groupId: ctx.genesis.groupId,
    membershipHeads: [invite.record.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(revocationA);
  const revocationB = await createInviteRevocationCommand({ inviteId: invite.record.payload.inviteId, groupId: ctx.genesis.groupId,
    membershipHeads: [invite.record.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(revocationB);
  const allBranches = [approvalA.id, approvalB.id, revocationA.id, revocationB.id].sort();
  const resolution = await createInviteConflictResolutionCommand({ inviteId: invite.record.payload.inviteId,
    conflictRecordIds: allBranches, selectedRecordId: approvalA.id, groupId: ctx.genesis.groupId,
    membershipHeads: allBranches, identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(resolution);
  const projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(projection.devices.some((item) => item.approvalId === approvalA.id), true);
  assert.equal(projection.devices.some((item) => item.approvalId === approvalB.id), false);
  assert.equal(projection.invites.find((item) => item.inviteId === invite.record.payload.inviteId).revoked, false);
});

test("conflicting public keys for one device ID cannot authorize descendants", async () => {
  const ctx = await setup();
  const deviceId = uuid();
  const firstIdentity = { participantId: ctx.member.participantId, deviceId, keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const inviteA = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const requestA = await requestJoin(ctx, inviteA, firstIdentity);
  const approvalA = await approve(ctx, inviteA, requestA, ctx.owner);
  const grant = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: approvalA.id, recordType: "organizer-granted", payload: { participantId: ctx.member.participantId } });
  ctx.records.push(grant);
  const childInvite = await issueInvite(ctx, firstIdentity, ctx.member.participantId, [grant.id]);
  const secondIdentity = { participantId: ctx.member.participantId, deviceId, keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const inviteB = await issueInvite(ctx, ctx.owner, ctx.member.participantId, [ctx.records[1].id]);
  const requestB = await requestJoin(ctx, inviteB, secondIdentity);
  const approvalB = await approve(ctx, inviteB, requestB, ctx.owner, [inviteB.record.id]);
  const projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(projection.devices.some((item) => item.deviceId === deviceId), false);
  assert.equal(projection.invites.some((item) => item.recordId === childInvite.record.id), false);
  assert.ok(projection.diagnostics.some((item) => item.reason === "device-id-collision"));
});

test("accepted ownership follows the recipient key and prior owner remains an organizer until revoked", async () => {
  const ctx = await setup();
  const invite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const request = await requestJoin(ctx, invite, { ...ctx.member, ...ctx.member.pair });
  const approval = await approve(ctx, invite, request, ctx.owner);
  const grant = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: approval.id, recordType: "organizer-granted", payload: { participantId: ctx.member.participantId } });
  ctx.records.push(grant);
  const memberIdentity = { ...ctx.member, ...ctx.member.pair };
  const proposal = await createOwnershipTransferProposalCommand({ groupId: ctx.genesis.groupId,
    recipientParticipantId: ctx.member.participantId, recipientDeviceId: ctx.member.deviceId, recipientKeyId: ctx.member.keyId,
    membershipHeads: [grant.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(proposal);
  assert.equal((await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, atHeads: [proposal.id] })).ownerParticipantId, ctx.owner.participantId);
  const wrongKey = { ...memberIdentity, ...await generateDeviceSigningKeyPair() };
  await assert.rejects(createOwnershipTransferAcceptanceCommand({ proposal, groupId: ctx.genesis.groupId, membershipHeads: [proposal.id],
    identity: wrongKey, records: ctx.records, trustPin: ctx.trustPin }), /transfer-recipient-key-mismatch/);
  const accepted = await createOwnershipTransferAcceptanceCommand({ proposal, groupId: ctx.genesis.groupId,
    membershipHeads: [proposal.id], identity: memberIdentity, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(accepted);
  const afterTransfer = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, atHeads: [accepted.id] });
  assert.equal(afterTransfer.ownerParticipantId, ctx.member.participantId);
  assert.equal(afterTransfer.organizers.includes(ctx.owner.participantId), true);
  const newOwnerInvite = await issueInvite(ctx, memberIdentity, ctx.member.participantId, [accepted.id]);
  assert.equal(newOwnerInvite.record.author.participantId, ctx.member.participantId);
  const priorOwnerInvite = await issueInvite(ctx, ctx.owner, ctx.member.participantId, [accepted.id]);
  assert.equal(priorOwnerInvite.record.author.participantId, ctx.owner.participantId);
  await assert.rejects(createOwnershipTransferProposalCommand({ groupId: ctx.genesis.groupId,
    recipientParticipantId: ctx.member.participantId, recipientDeviceId: ctx.member.deviceId, recipientKeyId: ctx.member.keyId,
    membershipHeads: [accepted.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin }), /not-owner/);
  const secondOwnerDevice = { participantId: ctx.member.participantId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const ownDeviceInvite = await issueInvite(ctx, memberIdentity, ctx.member.participantId, [accepted.id]);
  const ownDeviceRequest = await requestJoin(ctx, ownDeviceInvite, secondOwnerDevice);
  const ownDeviceApproval = await approve(ctx, ownDeviceInvite, ownDeviceRequest, ctx.owner);
  const ownDeviceConsent = await createOwnerDeviceConsentCommand({ approval: ownDeviceApproval, groupId: ctx.genesis.groupId,
    membershipHeads: [ownDeviceApproval.id], identity: memberIdentity, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(ownDeviceConsent);
  assert.equal((await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, atHeads: [ownDeviceConsent.id] }))
    .devices.some((device) => device.deviceId === secondOwnerDevice.deviceId), true);
  const revokeOldOwner = await rosterRecord({ groupId: ctx.genesis.groupId, author: memberIdentity, privateKey: memberIdentity.privateKey,
    head: ownDeviceConsent.id, recordType: "organizer-revoked", payload: { participantId: ctx.owner.participantId } });
  ctx.records.push(revokeOldOwner);
  const afterRevoke = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, atHeads: [revokeOldOwner.id] });
  assert.equal(afterRevoke.organizers.includes(ctx.owner.participantId), false);
  const nextProposal = await createOwnershipTransferProposalCommand({ groupId: ctx.genesis.groupId,
    recipientParticipantId: ctx.owner.participantId, recipientDeviceId: ctx.owner.deviceId, recipientKeyId: ctx.owner.keyId,
    membershipHeads: [revokeOldOwner.id], identity: secondOwnerDevice, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(nextProposal);
  const nextAcceptance = await createOwnershipTransferAcceptanceCommand({ proposal: nextProposal, groupId: ctx.genesis.groupId,
    membershipHeads: [nextProposal.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(nextAcceptance);
  const restored = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, atHeads: [nextAcceptance.id] });
  assert.equal(restored.ownerParticipantId, ctx.owner.participantId);
});

test("concurrent accepted transfers retain prior owner until one complete nonconflicting resolution", async () => {
  const ctx = await setup();
  const otherId = uuid();
  const otherAdd = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: ctx.records[1].id, recordType: "participant-added", payload: { participantId: otherId, name: "Other" } });
  ctx.records.push(otherAdd);
  const memberInvite = await issueInvite(ctx, ctx.owner, ctx.member.participantId, [otherAdd.id]);
  const memberRequest = await requestJoin(ctx, memberInvite, { ...ctx.member, ...ctx.member.pair });
  const memberApproval = await approve(ctx, memberInvite, memberRequest, ctx.owner);
  const otherInvite = await issueInvite(ctx, ctx.owner, otherId, [otherAdd.id]);
  const otherIdentity = { participantId: otherId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const otherRequest = await requestJoin(ctx, otherInvite, otherIdentity);
  const otherApproval = await approve(ctx, otherInvite, otherRequest, ctx.owner);
  const heads = [memberApproval.id, otherApproval.id].sort();
  const proposalA = await createOwnershipTransferProposalCommand({ groupId: ctx.genesis.groupId,
    recipientParticipantId: ctx.member.participantId, recipientDeviceId: ctx.member.deviceId, recipientKeyId: ctx.member.keyId,
    membershipHeads: heads, identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(proposalA);
  const proposalB = await createOwnershipTransferProposalCommand({ groupId: ctx.genesis.groupId,
    recipientParticipantId: otherId, recipientDeviceId: otherIdentity.deviceId, recipientKeyId: otherIdentity.keyId,
    membershipHeads: heads, identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(proposalB);
  const acceptanceA = await createOwnershipTransferAcceptanceCommand({ proposal: proposalA, groupId: ctx.genesis.groupId,
    membershipHeads: [proposalA.id], identity: { ...ctx.member, ...ctx.member.pair }, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(acceptanceA);
  const branchGrant = await rosterRecord({ groupId: ctx.genesis.groupId, author: { ...ctx.member, ...ctx.member.pair },
    privateKey: ctx.member.pair.privateKey, head: acceptanceA.id, recordType: "organizer-granted", payload: { participantId: otherId } });
  ctx.records.push(branchGrant);
  const acceptanceB = await createOwnershipTransferAcceptanceCommand({ proposal: proposalB, groupId: ctx.genesis.groupId,
    membershipHeads: [proposalB.id], identity: otherIdentity, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(acceptanceB);
  const conflictHeads = [acceptanceA.id, acceptanceB.id].sort();
  let projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(projection.ownerParticipantId, ctx.owner.participantId);
  assert.deepEqual(projection.transferConflictRecordIds, conflictHeads);
  assert.equal(projection.organizers.includes(otherId), false);
  const resolutionA = await createOwnershipTransferResolutionCommand({ conflictRecordIds: conflictHeads,
    selectedRecordId: acceptanceA.id, groupId: ctx.genesis.groupId, membershipHeads: conflictHeads, identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(resolutionA);
  const resolutionB = await createOwnershipTransferResolutionCommand({ conflictRecordIds: conflictHeads,
    selectedRecordId: acceptanceB.id, groupId: ctx.genesis.groupId, membershipHeads: conflictHeads, identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(resolutionB);
  projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(projection.ownerParticipantId, ctx.owner.participantId);
  assert.deepEqual(projection.transferConflictRecordIds, conflictHeads);
  const finalResolution = await createOwnershipTransferResolutionCommand({ conflictRecordIds: conflictHeads,
    selectedRecordId: acceptanceA.id, groupId: ctx.genesis.groupId, membershipHeads: [resolutionA.id, resolutionB.id].sort(),
    identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(finalResolution);
  projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(projection.ownerParticipantId, ctx.member.participantId);
  assert.deepEqual(projection.transferConflictRecordIds, []);
  assert.equal(projection.organizers.includes(otherId), true);
});

test("multi-generation transfer forks retain common owner independent of record order", async () => {
  const ctx = await setup();
  const participantC = uuid();
  const addC = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: ctx.records.at(-1).id, recordType: "participant-added", payload: { participantId: participantC, name: "C" } });
  ctx.records.push(addC);
  const participantD = uuid();
  const addD = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: addC.id, recordType: "participant-added", payload: { participantId: participantD, name: "D" } });
  ctx.records.push(addD);
  const enroll = async (participantId, name) => {
    const invite = await issueInvite(ctx, ctx.owner, participantId, [addD.id]);
    const identity = { participantId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
    const request = await requestJoin(ctx, invite, identity);
    const approval = await approve(ctx, invite, request, ctx.owner);
    return { identity, approval };
  };
  const b = { identity: { ...ctx.member, ...ctx.member.pair }, approval: null };
  const inviteB = await issueInvite(ctx, ctx.owner, ctx.member.participantId, [addD.id]);
  const requestB = await requestJoin(ctx, inviteB, b.identity);
  b.approval = await approve(ctx, inviteB, requestB, ctx.owner);
  const c = await enroll(participantC, "C");
  const d = await enroll(participantD, "D");
  const commonHeads = [b.approval.id, c.approval.id, d.approval.id].sort();
  const proposalB = await createOwnershipTransferProposalCommand({ groupId: ctx.genesis.groupId,
    recipientParticipantId: ctx.member.participantId, recipientDeviceId: b.identity.deviceId, recipientKeyId: b.identity.keyId,
    membershipHeads: commonHeads, identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(proposalB);
  const proposalC = await createOwnershipTransferProposalCommand({ groupId: ctx.genesis.groupId,
    recipientParticipantId: participantC, recipientDeviceId: c.identity.deviceId, recipientKeyId: c.identity.keyId,
    membershipHeads: commonHeads, identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(proposalC);
  const acceptB = await createOwnershipTransferAcceptanceCommand({ proposal: proposalB, groupId: ctx.genesis.groupId,
    membershipHeads: [proposalB.id], identity: b.identity, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(acceptB);
  const grant = await rosterRecord({ groupId: ctx.genesis.groupId, author: b.identity, privateKey: b.identity.privateKey,
    head: acceptB.id, recordType: "organizer-granted", payload: { participantId: participantC } });
  ctx.records.push(grant);
  const proposalD = await createOwnershipTransferProposalCommand({ groupId: ctx.genesis.groupId,
    recipientParticipantId: participantD, recipientDeviceId: d.identity.deviceId, recipientKeyId: d.identity.keyId,
    membershipHeads: [grant.id], identity: b.identity, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(proposalD);
  const acceptD = await createOwnershipTransferAcceptanceCommand({ proposal: proposalD, groupId: ctx.genesis.groupId,
    membershipHeads: [proposalD.id], identity: d.identity, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(acceptD);
  const acceptC = await createOwnershipTransferAcceptanceCommand({ proposal: proposalC, groupId: ctx.genesis.groupId,
    membershipHeads: [proposalC.id], identity: c.identity, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(acceptC);
  for (const records of [ctx.records, [...ctx.records].reverse()]) {
    const projection = await projectMembershipEnrollment(records, { trustPin: ctx.trustPin });
    assert.equal(projection.ownerParticipantId, ctx.owner.participantId);
    assert.equal(projection.organizers.includes(participantC), false);
    assert.deepEqual(projection.transferConflictRecordIds, [acceptB.id, acceptC.id].sort());
  }
  const resolution = await createOwnershipTransferResolutionCommand({ conflictRecordIds: [acceptB.id, acceptC.id].sort(),
    selectedRecordId: acceptB.id, groupId: ctx.genesis.groupId, membershipHeads: [acceptB.id, acceptC.id].sort(),
    identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(resolution);
  const resolved = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.equal(resolved.ownerParticipantId, participantD);
  assert.equal(resolved.organizers.includes(participantC), true);
  assert.deepEqual(resolved.transferConflictRecordIds, []);
});

test("device tombstones require verified causal heads and preserve earlier membership keys", async () => {
  const ctx = await setup();
  const invite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const memberIdentity = { ...ctx.member, ...ctx.member.pair };
  const request = await requestJoin(ctx, invite, memberIdentity);
  const approval = await approve(ctx, invite, request, ctx.owner);
  const grant = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: approval.id, recordType: "organizer-granted", payload: { participantId: ctx.member.participantId } });
  ctx.records.push(grant);
  const ledgerRecord = await createSignedLedgerRecord({ id: uuid(), type: "expense-created", groupId: ctx.genesis.groupId,
    author: { participantId: memberIdentity.participantId, deviceId: memberIdentity.deviceId, keyId: memberIdentity.keyId },
    createdAt: "2026-10-08T00:00:00.000Z", membershipHeads: [grant.id], causalHeads: [], dependsOn: [],
    payload: { expenseId: uuid(), description: "Observed expense", currency: "USD", amount: 100,
      payerId: memberIdentity.participantId, splits: [{ participantId: memberIdentity.participantId, amount: 100 }] }
  }, memberIdentity.privateKey);
  const causalContext = await createVerifiedCausalContext({ causalRecords: [ledgerRecord], membershipRecords: ctx.records, trustPin: ctx.trustPin });
  assert.deepEqual(causalContext.frontier, [ledgerRecord.id]);
  await assert.rejects(createDeviceRevocationCommand({ participantId: ctx.member.participantId, deviceId: ctx.member.deviceId,
    keyId: ctx.member.keyId, groupId: ctx.genesis.groupId, membershipHeads: [grant.id], identity: ctx.owner,
    records: ctx.records, trustPin: ctx.trustPin, causalContext: { groupId: ctx.genesis.groupId, frontier: [ledgerRecord.id] } }), /causal-frontier-unverified/);
  const removal = await createDeviceRevocationCommand({ participantId: ctx.member.participantId, deviceId: ctx.member.deviceId,
    keyId: ctx.member.keyId, groupId: ctx.genesis.groupId, membershipHeads: [grant.id], identity: ctx.owner,
    records: ctx.records, trustPin: ctx.trustPin, causalContext });
  ctx.records.push(removal);
  const withoutCausalProof = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin });
  assert.ok(withoutCausalProof.diagnostics.some((item) => item.recordId === removal.id && item.reason === "causal-frontier-unverified"));
  assert.equal(withoutCausalProof.devices.some((device) => device.deviceId === ctx.member.deviceId), true);
  const oversized = structuredClone(removal);
  oversized.id = uuid();
  oversized.causalHeads = Array.from({ length: 65 }, uuid).sort();
  const malformed = await projectMembershipEnrollment([...ctx.records, oversized], { trustPin: ctx.trustPin, verifiedCausalContexts: [causalContext] });
  assert.ok(malformed.diagnostics.some((item) => item.recordId === oversized.id && item.reason === "invalid-enrollment-schema"));
  const projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, verifiedCausalContexts: [causalContext] });
  assert.equal(projection.devices.some((device) => device.deviceId === ctx.member.deviceId), false);
  assert.equal(projection.tombstones.devices.length, 1);
  assert.deepEqual(projection.tombstones.devices[0].causalHeads, [ledgerRecord.id]);
  assert.equal(projection.tombstones.keyEpoch, 2);
  const historical = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, atHeads: [grant.id] });
  assert.equal(historical.devices.some((device) => device.deviceId === ctx.member.deviceId), true);
  await assert.rejects(createInviteCommand({ groupId: ctx.genesis.groupId, participantId: ctx.member.participantId,
    membershipHeads: [removal.id], identity: memberIdentity, records: ctx.records, trustPin: ctx.trustPin }), /not-organizer/);
  const postRemovalInvite = await createInviteCommand({ groupId: ctx.genesis.groupId, participantId: ctx.member.participantId,
    membershipHeads: [removal.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin,
    verifiedCausalContexts: [causalContext] });
  assert.ok(postRemovalInvite.record);
  const rotatedIdentity = { participantId: ctx.member.participantId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const rotatedRequest = await createJoinRequestCommand({ invite: postRemovalInvite.record, token: postRemovalInvite.token,
    groupId: ctx.genesis.groupId, membershipHeads: [postRemovalInvite.record.id], identity: rotatedIdentity,
    records: [...ctx.records, postRemovalInvite.record], trustPin: ctx.trustPin, verifiedCausalContexts: [causalContext] });
  const rotatedApproval = await approveJoinRequestCommand({ invite: postRemovalInvite.record, request: rotatedRequest,
    token: postRemovalInvite.token, genesis: ctx.genesis, trustPin: ctx.trustPin, membershipHeads: [postRemovalInvite.record.id],
    identity: ctx.owner, records: [...ctx.records, postRemovalInvite.record, rotatedRequest], verifiedCausalContexts: [causalContext] });
  const rotatedProjection = await projectMembershipEnrollment([...ctx.records, postRemovalInvite.record, rotatedRequest, rotatedApproval],
    { trustPin: ctx.trustPin, verifiedCausalContexts: [causalContext] });
  assert.equal(rotatedProjection.devices.some((device) => device.deviceId === rotatedIdentity.deviceId), true);
  assert.equal(rotatedProjection.devices.some((device) => device.deviceId === ctx.member.deviceId), false);
});

test("participant tombstones remove concurrent devices and prevent reenrollment", async () => {
  const ctx = await setup();
  const invite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const memberIdentity = { ...ctx.member, ...ctx.member.pair };
  const request = await requestJoin(ctx, invite, memberIdentity);
  const approval = await approve(ctx, invite, request, ctx.owner);
  const concurrentInvite = await issueInvite(ctx, ctx.owner, ctx.member.participantId, [approval.id]);
  const concurrentIdentity = { participantId: ctx.member.participantId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const concurrentRequest = await requestJoin(ctx, concurrentInvite, concurrentIdentity);
  const concurrentApproval = await approve(ctx, concurrentInvite, concurrentRequest, ctx.owner);
  const futureInvite = await issueInvite(ctx, ctx.owner, ctx.member.participantId, [approval.id]);
  const context = await createVerifiedCausalContext({ causalRecords: [], membershipRecords: ctx.records, trustPin: ctx.trustPin });
  const removal = await createParticipantRemovalCommand({ participantId: ctx.member.participantId, groupId: ctx.genesis.groupId,
    membershipHeads: [futureInvite.record.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin, causalContext: context });
  ctx.records.push(removal);
  const projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, verifiedCausalContexts: [context] });
  assert.equal(projection.participants.some((person) => person.id === ctx.member.participantId), false);
  assert.equal(projection.devices.some((device) => device.participantId === ctx.member.participantId), false);
  assert.deepEqual(projection.tombstones.participants.map((item) => item.participantId), [ctx.member.participantId]);
  assert.ok(projection.diagnostics.some((item) => item.recordId === concurrentApproval.id && item.reason === "identity-already-removed"));
  const reenrollmentIdentity = { participantId: ctx.member.participantId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const reenrollmentRequest = await requestJoin(ctx, futureInvite, reenrollmentIdentity, [removal.id]);
  const reenrollmentApproval = await approve(ctx, futureInvite, reenrollmentRequest, ctx.owner, [removal.id]);
  const afterAttempt = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, verifiedCausalContexts: [context] });
  assert.equal(afterAttempt.devices.some((device) => device.deviceId === reenrollmentIdentity.deviceId), false);
  assert.ok(afterAttempt.diagnostics.some((item) => item.recordId === reenrollmentApproval.id && item.reason === "identity-already-removed"));
  assert.equal(afterAttempt.devices.some((device) => device.deviceId === concurrentIdentity.deviceId), false);
  assert.equal(afterAttempt.tombstones.participants[0].recordId, removal.id);
  const reordered = await projectMembershipEnrollment([...ctx.records].reverse(), { trustPin: ctx.trustPin, verifiedCausalContexts: [context] });
  assert.deepEqual(reordered.devices, afterAttempt.devices);
  assert.deepEqual(reordered.tombstones, afterAttempt.tombstones);
});

test("only active organizers can remove identities; revoking the last owner device locks owner administration", async () => {
  const ctx = await setup();
  const invite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const identity = { ...ctx.member, ...ctx.member.pair };
  const request = await requestJoin(ctx, invite, identity);
  const approval = await approve(ctx, invite, request, ctx.owner);
  const grant = await rosterRecord({ groupId: ctx.genesis.groupId, author: ctx.owner, privateKey: ctx.owner.privateKey,
    head: approval.id, recordType: "organizer-granted", payload: { participantId: identity.participantId } });
  ctx.records.push(grant);
  const context = await createVerifiedCausalContext({ causalRecords: [], membershipRecords: ctx.records, trustPin: ctx.trustPin });
  await assert.rejects(createParticipantRemovalCommand({ participantId: ctx.owner.participantId, groupId: ctx.genesis.groupId,
    membershipHeads: [approval.id], identity, records: ctx.records, trustPin: ctx.trustPin, causalContext: context }), /not-organizer/);
  const removal = await createDeviceRevocationCommand({ participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId,
    keyId: ctx.owner.keyId, groupId: ctx.genesis.groupId, membershipHeads: [grant.id], identity, records: ctx.records,
    trustPin: ctx.trustPin, causalContext: context });
  ctx.records.push(removal);
  const projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, verifiedCausalContexts: [context] });
  assert.equal(projection.ownerParticipantId, ctx.owner.participantId);
  assert.equal(projection.devices.some((device) => device.deviceId === ctx.owner.deviceId), false);
  await assert.rejects(createOwnershipTransferProposalCommand({ transferId: uuid(), ownerParticipantId: identity.participantId,
    recipientParticipantId: ctx.owner.participantId, recipientDeviceId: ctx.owner.deviceId, recipientKeyId: ctx.owner.keyId,
    groupId: ctx.genesis.groupId, membershipHeads: [removal.id], identity, records: ctx.records, trustPin: ctx.trustPin }), /not-owner/);
  await assert.rejects(createInviteCommand({ groupId: ctx.genesis.groupId, participantId: identity.participantId,
    membershipHeads: [removal.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin }), /not-organizer/);
});

test("participant removal concurrent with ownership acceptance keeps the prior owner", async () => {
  const ctx = await setup();
  const invite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const identity = { ...ctx.member, ...ctx.member.pair };
  const request = await requestJoin(ctx, invite, identity);
  const approval = await approve(ctx, invite, request, ctx.owner);
  const proposal = await createOwnershipTransferProposalCommand({ transferId: uuid(), ownerParticipantId: ctx.owner.participantId,
    recipientParticipantId: identity.participantId, recipientDeviceId: identity.deviceId, recipientKeyId: identity.keyId,
    groupId: ctx.genesis.groupId, membershipHeads: [approval.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(proposal);
  const acceptance = await createOwnershipTransferAcceptanceCommand({ proposal, transferId: proposal.payload.transferId,
    groupId: ctx.genesis.groupId, membershipHeads: [proposal.id], identity, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(acceptance);
  const context = await createVerifiedCausalContext({ causalRecords: [], membershipRecords: ctx.records, trustPin: ctx.trustPin });
  const removal = await createParticipantRemovalCommand({ participantId: identity.participantId, groupId: ctx.genesis.groupId,
    membershipHeads: [approval.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin, causalContext: context });
  ctx.records.push(removal);
  const projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, verifiedCausalContexts: [context] });
  assert.equal(projection.ownerParticipantId, ctx.owner.participantId);
  assert.equal(projection.devices.some((device) => device.participantId === identity.participantId), false);
  const historical = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, atHeads: [acceptance.id] });
  assert.equal(historical.ownerParticipantId, identity.participantId);
});

test("a completed transfer stays with the new owner after their last device is revoked", async () => {
  const ctx = await setup();
  const invite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const identity = { ...ctx.member, ...ctx.member.pair };
  const request = await requestJoin(ctx, invite, identity);
  const approval = await approve(ctx, invite, request, ctx.owner);
  const proposal = await createOwnershipTransferProposalCommand({ transferId: uuid(), ownerParticipantId: ctx.owner.participantId,
    recipientParticipantId: identity.participantId, recipientDeviceId: identity.deviceId, recipientKeyId: identity.keyId,
    groupId: ctx.genesis.groupId, membershipHeads: [approval.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(proposal);
  const acceptance = await createOwnershipTransferAcceptanceCommand({ proposal, groupId: ctx.genesis.groupId,
    membershipHeads: [proposal.id], identity, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(acceptance);
  const context = await createVerifiedCausalContext({ causalRecords: [], membershipRecords: ctx.records, trustPin: ctx.trustPin });
  const removal = await createDeviceRevocationCommand({ participantId: identity.participantId, deviceId: identity.deviceId,
    keyId: identity.keyId, groupId: ctx.genesis.groupId, membershipHeads: [acceptance.id], identity: ctx.owner,
    records: ctx.records, trustPin: ctx.trustPin, causalContext: context });
  ctx.records.push(removal);
  const projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, verifiedCausalContexts: [context] });
  assert.equal(projection.ownerParticipantId, identity.participantId);
  assert.equal(projection.devices.some((device) => device.deviceId === identity.deviceId), false);
  await assert.rejects(createOwnershipTransferProposalCommand({ groupId: ctx.genesis.groupId,
    recipientParticipantId: ctx.owner.participantId, recipientDeviceId: ctx.owner.deviceId, recipientKeyId: ctx.owner.keyId,
    membershipHeads: [removal.id], identity, records: ctx.records, trustPin: ctx.trustPin, verifiedCausalContexts: [context] }), /not-owner/);
});

test("participant removal after an accepted transfer preserves owner history but removes the participant", async () => {
  const ctx = await setup();
  const invite = await issueInvite(ctx, ctx.owner, ctx.member.participantId);
  const identity = { ...ctx.member, ...ctx.member.pair };
  const request = await requestJoin(ctx, invite, identity);
  const approval = await approve(ctx, invite, request, ctx.owner);
  const proposal = await createOwnershipTransferProposalCommand({ transferId: uuid(), ownerParticipantId: ctx.owner.participantId,
    recipientParticipantId: identity.participantId, recipientDeviceId: identity.deviceId, recipientKeyId: identity.keyId,
    groupId: ctx.genesis.groupId, membershipHeads: [approval.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(proposal);
  const acceptance = await createOwnershipTransferAcceptanceCommand({ proposal, groupId: ctx.genesis.groupId,
    membershipHeads: [proposal.id], identity, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(acceptance);
  const context = await createVerifiedCausalContext({ causalRecords: [], membershipRecords: ctx.records, trustPin: ctx.trustPin });
  const removal = await createParticipantRemovalCommand({ participantId: identity.participantId, groupId: ctx.genesis.groupId,
    membershipHeads: [acceptance.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin, causalContext: context });
  ctx.records.push(removal);
  const projection = await projectMembershipEnrollment(ctx.records, { trustPin: ctx.trustPin, verifiedCausalContexts: [context] });
  assert.equal(projection.ownerParticipantId, identity.participantId);
  assert.equal(projection.participants.some((person) => person.id === identity.participantId), false);
  assert.equal(projection.devices.some((device) => device.participantId === identity.participantId), false);
});
