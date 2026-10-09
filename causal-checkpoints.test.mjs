import assert from "node:assert/strict";
import { test } from "node:test";
import { createCausalFrontierCheckpointCommands } from "./src/causal-checkpoints.js";
import { exportDevicePublicKey, generateDeviceSigningKeyPair, signRecord } from "./src/identity-crypto.js";
import { createSignedLedgerRecord } from "./src/signed-ledger-records.js";
import { createVerifiedCausalContext, projectSignedMembership } from "./src/signed-membership-projector.js";
import { projectAuthenticatedLedger } from "./src/authenticated-ledger.js";
import { approveJoinRequestCommand, createDeviceRevocationCommand, createInviteCommand, createJoinRequestCommand } from "./src/membership-invitations.js";

const uuid = () => crypto.randomUUID();

async function fixture() {
  const owner = { participantId: uuid(), deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const publicKey = await exportDevicePublicKey(owner.publicKey);
  const encode = (bytes) => {
    let binary = ""; for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  };
  const genesis = { id: uuid(), groupId: uuid(), recordType: "group-created", membershipSchemaVersion: 1, protocolVersion: 2,
    author: { participantId: owner.participantId, deviceId: owner.deviceId, keyId: owner.keyId },
    createdAt: "2026-10-09T00:00:00.000Z", membershipHeads: [], causalHeads: [], dependsOn: [],
    payload: { name: "Checkpoint", currency: "USD", owner: { participantId: owner.participantId, deviceId: owner.deviceId,
      keyId: owner.keyId, name: "Owner", publicKey: encode(publicKey) } } };
  genesis.signature = await signRecord(genesis, owner.privateKey);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey));
  const trustPin = { genesisId: genesis.id, publicKeyFingerprint: "sha256:" + encode(digest) };
  return { genesis, trustPin, owner, membershipRecords: [genesis], ledger: [] };
}

async function event(ctx, index, options = {}) {
  const record = {
    id: uuid(), type: "expense-created", groupId: ctx.genesis.groupId,
    author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-09T00:00:00.000Z", membershipHeads: [ctx.genesis.id],
    causalHeads: options.causalHeads || [], dependsOn: [],
    payload: { expenseId: uuid(), description: `Expense ${index}`, currency: "USD", amount: 100,
      payerId: ctx.owner.participantId, splits: [{ participantId: ctx.owner.participantId, amount: 100 }] }
  };
  return createSignedLedgerRecord(record, ctx.owner.privateKey);
}

test("signed staged checkpoints reduce an authenticated frontier without changing membership or balances", async () => {
  const ctx = await fixture();
  ctx.ledger = await Promise.all(Array.from({ length: 65 }, (_, index) => event(ctx, index)));
  const before = await projectAuthenticatedLedger(ctx.ledger, { membershipRecords: ctx.membershipRecords, trustPin: ctx.trustPin });
  assert.equal(before.causalFrontier.ok, false);
  assert.equal(before.causalFrontier.reason, "causal-frontier-too-large");
  assert.deepEqual(before.causalFrontier.heads, ctx.ledger.map((record) => record.id).sort());
  const result = await createCausalFrontierCheckpointCommands({ causalRecords: ctx.ledger,
    membershipRecords: ctx.membershipRecords, trustPin: ctx.trustPin, identity: ctx.owner,
    membershipHeads: [ctx.genesis.id] });
  assert.equal(result.records.length, 2);
  assert.deepEqual(result.records[0].causalHeads.length, 64);
  assert.deepEqual(result.records[1].causalHeads.length, 2);
  assert.deepEqual(result.records[1].causalHeads[0], result.records[0].id);
  assert.deepEqual(result.frontier, [result.records[1].id]);
  assert.deepEqual(result.causalContext.frontier, result.frontier);

  ctx.membershipRecords.push(...result.records);
  const removal = await createDeviceRevocationCommand({ participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId,
    keyId: ctx.owner.keyId, groupId: ctx.genesis.groupId, membershipHeads: [ctx.genesis.id], identity: ctx.owner,
    records: ctx.membershipRecords, trustPin: ctx.trustPin, causalContext: result.causalContext });
  assert.deepEqual(removal.causalHeads, result.frontier, "large observed frontiers become a single signed removal head");
  ctx.membershipRecords.push(removal);
  const membership = await projectSignedMembership(ctx.membershipRecords, { trustPin: ctx.trustPin,
    verifiedCausalContexts: [result.causalContext] });
  assert.deepEqual(membership.heads, [removal.id]);
  assert.equal(membership.heads.some((id) => result.records.some((checkpoint) => checkpoint.id === id)), false,
    "causal checkpoints do not become membership heads");
  assert.equal(membership.causalCheckpointCandidates.length, 2);
  assert.equal(membership.tombstones.devices.some((item) => item.recordId === removal.id), true);
  const proof = await createVerifiedCausalContext({ causalRecords: [...ctx.ledger, ...result.records],
    membershipRecords: ctx.membershipRecords, trustPin: ctx.trustPin, authorizationContexts: [result.causalContext] });
  assert.deepEqual(proof.frontier, result.frontier);

  const projection = await projectAuthenticatedLedger(ctx.ledger, { membershipRecords: ctx.membershipRecords, trustPin: ctx.trustPin });
  assert.equal(projection.effective.length, 65);
  assert.deepEqual(projection.causalFrontier, { ok: true, heads: result.frontier });
  assert.deepEqual(projection.balances, { [ctx.owner.participantId]: 0 });
});

test("forged or malformed causal checkpoints never enter a verified context", async () => {
  const ctx = await fixture();
  const sources = await Promise.all(Array.from({ length: 65 }, (_, index) => event(ctx, index)));
  const built = await createCausalFrontierCheckpointCommands({ causalRecords: sources, membershipRecords: ctx.membershipRecords,
    trustPin: ctx.trustPin, identity: ctx.owner, membershipHeads: [ctx.genesis.id] });
  const source = sources[0];
  const forged = structuredClone({ ...built.records[0], signature: `${built.records[0].signature.slice(0, -1)}${built.records[0].signature.endsWith("A") ? "B" : "A"}` });
  assert.equal((await projectSignedMembership([...ctx.membershipRecords, forged], { trustPin: ctx.trustPin })).causalCheckpointCandidates.length, 0);
  await assert.rejects(createVerifiedCausalContext({ causalRecords: [source, forged],
    membershipRecords: [...ctx.membershipRecords, forged], trustPin: ctx.trustPin }));
  const malformed = { ...built.records[0], payload: { frontierKind: "membership" } };
  malformed.signature = await signRecord(malformed, ctx.owner.privateKey);
  assert.equal((await projectSignedMembership([...ctx.membershipRecords, malformed], { trustPin: ctx.trustPin })).causalCheckpointCandidates.length, 0);
});

test("checkpoint signer is checked at each direct frontier input membership state", async () => {
  const ctx = await fixture();
  const participantId = uuid();
  const participant = { id: uuid(), recordType: "participant-added", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.genesis.groupId, author: ctx.genesis.author, createdAt: "2026-10-09T00:00:01.000Z",
    membershipHeads: [ctx.genesis.id], causalHeads: [], dependsOn: [], payload: { participantId, name: "New device" } };
  participant.signature = await signRecord(participant, ctx.owner.privateKey);
  ctx.membershipRecords.push(participant);
  const member = { participantId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const invite = await createInviteCommand({ groupId: ctx.genesis.groupId, participantId, membershipHeads: [participant.id],
    identity: ctx.owner, records: ctx.membershipRecords, trustPin: ctx.trustPin });
  ctx.membershipRecords.push(invite.record);
  const request = await createJoinRequestCommand({ invite: invite.record, token: invite.token, groupId: ctx.genesis.groupId,
    membershipHeads: [invite.record.id], identity: member, records: ctx.membershipRecords, trustPin: ctx.trustPin });
  ctx.membershipRecords.push(request);
  const approval = await approveJoinRequestCommand({ invite: invite.record, request, token: invite.token, genesis: ctx.genesis,
    trustPin: ctx.trustPin, membershipHeads: [invite.record.id], identity: ctx.owner, records: ctx.membershipRecords });
  ctx.membershipRecords.push(approval);

  const oldAncestor = await event(ctx, 0);
  const recent = await Promise.all(Array.from({ length: 65 }, (_, index) => createSignedLedgerRecord({
    id: uuid(), type: "expense-created", groupId: ctx.genesis.groupId,
    author: { participantId, deviceId: member.deviceId, keyId: member.keyId },
    createdAt: "2026-10-09T00:00:02.000Z", membershipHeads: [approval.id], causalHeads: [oldAncestor.id], dependsOn: [],
    payload: { expenseId: uuid(), description: `Recent ${index}`, currency: "USD", amount: 100,
      payerId: participantId, splits: [{ participantId: participantId, amount: 100 }] }
  }, member.privateKey)));
  const built = await createCausalFrontierCheckpointCommands({ causalRecords: [oldAncestor, ...recent],
    membershipRecords: ctx.membershipRecords, trustPin: ctx.trustPin, identity: member, membershipHeads: [approval.id] });
  assert.equal(built.records.length, 2, "an older ancestor does not need the newer checkpoint signer to have existed");

  const forged = { id: uuid(), recordType: "frontier-checkpoint", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.genesis.groupId, author: { participantId, deviceId: member.deviceId, keyId: member.keyId },
    createdAt: "2026-10-09T00:00:03.000Z", membershipHeads: [approval.id], causalHeads: [oldAncestor.id], dependsOn: [],
    payload: { frontierKind: "causal" } };
  forged.signature = await signRecord(forged, member.privateKey);
  await assert.rejects(createVerifiedCausalContext({ causalRecords: [oldAncestor, forged],
    membershipRecords: [...ctx.membershipRecords, forged], trustPin: ctx.trustPin }),
  /causal-context-checkpoint-signer-not-active-at-input-heads/);
});

test("an offline checkpoint from a revoked signer cannot validate its descendants", async () => {
  const ctx = await fixture();
  const participantId = uuid();
  const participant = { id: uuid(), recordType: "participant-added", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.genesis.groupId, author: ctx.genesis.author, createdAt: "2026-10-09T00:00:01.000Z",
    membershipHeads: [ctx.genesis.id], causalHeads: [], dependsOn: [], payload: { participantId, name: "Member" } };
  participant.signature = await signRecord(participant, ctx.owner.privateKey);
  ctx.membershipRecords.push(participant);
  const member = { participantId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const invite = await createInviteCommand({ groupId: ctx.genesis.groupId, participantId, membershipHeads: [participant.id],
    identity: ctx.owner, records: ctx.membershipRecords, trustPin: ctx.trustPin });
  ctx.membershipRecords.push(invite.record);
  const request = await createJoinRequestCommand({ invite: invite.record, token: invite.token, groupId: ctx.genesis.groupId,
    membershipHeads: [invite.record.id], identity: member, records: ctx.membershipRecords, trustPin: ctx.trustPin });
  ctx.membershipRecords.push(request);
  const approval = await approveJoinRequestCommand({ invite: invite.record, request, token: invite.token, genesis: ctx.genesis,
    trustPin: ctx.trustPin, membershipHeads: [invite.record.id], identity: ctx.owner, records: ctx.membershipRecords });
  ctx.membershipRecords.push(approval);

  const signed = async (identity, membershipHeads, causalHeads, description) => createSignedLedgerRecord({
    id: uuid(), type: "expense-created", groupId: ctx.genesis.groupId,
    author: { participantId: identity.participantId, deviceId: identity.deviceId, keyId: identity.keyId },
    createdAt: "2026-10-09T00:00:02.000Z", membershipHeads, causalHeads, dependsOn: [],
    payload: { expenseId: uuid(), description, currency: "USD", amount: 100, payerId: identity.participantId,
      splits: identity.participantId === ctx.owner.participantId
        ? [{ participantId: ctx.owner.participantId, amount: 100 }]
        : [{ participantId: ctx.owner.participantId, amount: 50 }, { participantId: identity.participantId, amount: 50 }] }
  }, identity.privateKey);
  const unseen = await signed(member, [approval.id], [], "Unseen offline event");
  const checkpoint = { id: uuid(), recordType: "frontier-checkpoint", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.genesis.groupId, author: { participantId, deviceId: member.deviceId, keyId: member.keyId },
    createdAt: "2026-10-09T00:00:03.000Z", membershipHeads: [approval.id], causalHeads: [unseen.id], dependsOn: [],
    payload: { frontierKind: "causal" } };
  checkpoint.signature = await signRecord(checkpoint, member.privateKey);
  ctx.membershipRecords.push(checkpoint);

  const observed = await signed(ctx.owner, [approval.id], [], "Observed before removal");
  const proof = await createVerifiedCausalContext({ causalRecords: [observed], membershipRecords: ctx.membershipRecords,
    trustPin: ctx.trustPin });
  const removal = await createDeviceRevocationCommand({ participantId, deviceId: member.deviceId, keyId: member.keyId,
    groupId: ctx.genesis.groupId, membershipHeads: [approval.id], identity: ctx.owner, records: ctx.membershipRecords,
    trustPin: ctx.trustPin, causalContext: proof });
  ctx.membershipRecords.push(removal);
  const descendant = await signed(ctx.owner, [removal.id], [checkpoint.id], "Active writer depends on offline checkpoint");
  const projection = await projectAuthenticatedLedger([observed, unseen, descendant], {
    membershipRecords: ctx.membershipRecords, trustPin: ctx.trustPin
  });
  assert.ok(projection.effective.some(({ id }) => id === observed.id));
  assert.equal(projection.effective.some(({ id }) => id === unseen.id || id === descendant.id), false);
  assert.ok(projection.quarantined.some((item) => item.id === unseen.id && item.reason === "author-revoked-at-causal-frontier"));
  assert.ok(projection.pending.some((item) => item.id === descendant.id && item.reason === "missing-causal-parent"));
});
