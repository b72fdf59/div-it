import assert from "node:assert/strict";
import { test } from "node:test";
import { exportDevicePublicKey, generateDeviceSigningKeyPair, signRecord } from "./src/identity-crypto.js";
import { approveJoinRequestCommand, createInviteCommand, createJoinRequestCommand, createInviteRevocationCommand, createInviteConflictResolutionCommand, createOwnerDeviceConsentCommand, projectMembershipEnrollment } from "./src/membership-invitations.js";

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
  const future = { id: uuid(), groupId: ctx.genesis.groupId, recordType: "future-membership", membershipSchemaVersion: 1, protocolVersion: 2 };
  ctx.records.push(future);
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
