import assert from "node:assert/strict";
import { test } from "node:test";
import { approveJoinRequestCommand, createDeviceRevocationCommand, createInviteCommand, createJoinRequestCommand,
  createOwnerDeviceConsentCommand, createOwnershipTransferAcceptanceCommand, createOwnershipTransferProposalCommand, createParticipantRemovalCommand,
  createVerifiedCausalContext } from "./src/membership-invitations.js";
import { exportDevicePublicKey, generateDeviceSigningKeyPair, signRecord } from "./src/identity-crypto.js";
import { createSignedLedgerRecord } from "./src/signed-ledger-records.js";
import { createLegacyHistoryAttestation, verifyLegacyHistoryAttestation } from "./src/legacy-history-attestation.js";
import { prepareLegacyActivationReview } from "./src/legacy-activation-review.js";

const uuid = () => crypto.randomUUID();
const encode = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

async function setup() {
  const ownerPair = await generateDeviceSigningKeyPair();
  const owner = { participantId: uuid(), deviceId: uuid(), keyId: uuid(), ...ownerPair };
  const groupId = uuid();
  const genesisId = uuid();
  const publicBytes = await exportDevicePublicKey(owner.publicKey);
  const genesis = {
    id: genesisId, groupId, recordType: "group-created", membershipSchemaVersion: 1, protocolVersion: 2,
    author: { participantId: owner.participantId, deviceId: owner.deviceId, keyId: owner.keyId },
    createdAt: "2026-10-09T10:00:00.000Z", membershipHeads: [], causalHeads: [], dependsOn: [],
    payload: { name: "Current group", currency: "USD", owner: { participantId: owner.participantId, deviceId: owner.deviceId,
      keyId: owner.keyId, name: "Alice", publicKey: encode(publicBytes) } }
  };
  genesis.signature = await signRecord(genesis, owner.privateKey);
  const fingerprint = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", publicBytes)));
  const trustPin = { genesisId, publicKeyFingerprint: `sha256:${fingerprint}` };
  return { groupId, genesis, trustPin, owner, records: [genesis] };
}

async function addMember(ctx) {
  const member = { participantId: uuid(), deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const person = {
    id: uuid(), recordType: "participant-added", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.groupId, author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: new Date().toISOString(), membershipHeads: [ctx.genesis.id], causalHeads: [], dependsOn: [],
    payload: { participantId: member.participantId, name: "Bob" }
  };
  person.signature = await signRecord(person, ctx.owner.privateKey);
  ctx.records.push(person);
  const invite = await createInviteCommand({ groupId: ctx.groupId, participantId: member.participantId,
    membershipHeads: [person.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(invite.record);
  const request = await createJoinRequestCommand({ invite: invite.record, token: invite.token, groupId: ctx.groupId,
    membershipHeads: [invite.record.id], identity: member, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(request);
  const approval = await approveJoinRequestCommand({ invite: invite.record, request, token: invite.token, genesis: ctx.genesis,
    trustPin: ctx.trustPin, membershipHeads: [invite.record.id], identity: ctx.owner, records: ctx.records });
  ctx.records.push(approval);
  return { member, person, invite, request, approval };
}

function legacySource(currency = "USD") {
  return { name: "Old trip", currency, groupId: uuid(), people: [{ id: "old-alice", name: "Alice" }, { id: "old-bob", name: "Bob" }], events: [] };
}

async function reviewArchive(source, rawBytes) {
  return (await prepareLegacyActivationReview(source, rawBytes ? { rawArchiveBytes: rawBytes } : {})).archive;
}

async function create(ctx, archive, identity = ctx.owner, membershipHeads = [ctx.genesis.id], options = {}) {
  return createLegacyHistoryAttestation({ archive, membershipHeads, identity, membershipRecords: ctx.records,
    trustPin: ctx.trustPin, ...options });
}

async function verify(ctx, record, archive, options = {}) {
  return verifyLegacyHistoryAttestation({ record, archive, membershipRecords: ctx.records, trustPin: ctx.trustPin, ...options });
}

test("owner creates and verifies a recomputed legacy snapshot without changing source or membership", async () => {
  const ctx = await setup();
  const source = legacySource();
  const rawBytes = new TextEncoder().encode(JSON.stringify(source, null, 2));
  const archive = await reviewArchive(source, rawBytes);
  const recordsBefore = structuredClone(ctx.records);
  const created = await create(ctx, archive, ctx.owner, [ctx.genesis.id]);
  const result = await verify(ctx, created.record, created.archive);
  assert.equal(result.ok, true);
  assert.equal(created.record.recordType, "legacy-history-adopted");
  assert.equal(created.record.membershipSchemaVersion, 1);
  assert.equal(Object.hasOwn(created.record.payload, "participantMapping"), false);
  assert.deepEqual(created.record.payload.participants.map(({ participantId }) => participantId), ["old-alice", "old-bob"]);
  assert.equal(created.record.payload.legacyAuthorship, "unverified");
  assert.deepEqual(created.archive.bytes, rawBytes);
  assert.deepEqual(ctx.records, recordsBefore, "attestation is not added to the membership graph");
  assert.equal(result.record.signature, created.record.signature);
  assert.equal(Object.hasOwn(result, "mappedOpeningBalances"), false, "v1 remains audit-only");
});

test("legacy participant strings are preserved exactly and caller inputs are snapshotted before async verification", async () => {
  const ctx = await setup();
  const source = legacySource();
  source.people = [{ id: " old-alice ", name: " Alice " }, { id: "old-bob", name: "Bob" }];
  const archive = await reviewArchive(source);
  const created = await create(ctx, archive);
  assert.deepEqual(created.record.payload.participants[0], { participantId: " old-alice ", name: " Alice " });
  assert.equal((await verify(ctx, created.record, created.archive)).ok, true);

  const record = structuredClone(created.record);
  const archiveCopy = structuredClone(created.archive);
  const pending = verify(ctx, record, archiveCopy);
  record.payload.participants[0].name = "changed while verification is pending";
  archiveCopy.bytes.fill(0);
  const result = await pending;
  assert.equal(result.ok, true, "verification uses the record and archive snapshots captured at entry");

  source.people[0].name = "x".repeat(129);
  await assert.rejects(create(ctx, await reviewArchive(source)), /invalid-attestation-payload/);
});

test("ordinary members and organizers cannot attest; actual owner can after ownership transfer", async () => {
  const ctx = await setup();
  const { member, approval } = await addMember(ctx);
  const archive = await reviewArchive(legacySource());
  await assert.rejects(create(ctx, archive, member, [approval.id]), /not-owner/);
  const unknownDevice = { participantId: uuid(), deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  await assert.rejects(create(ctx, archive, unknownDevice, [ctx.genesis.id]), /not-owner/);

  const organizer = {
    id: uuid(), recordType: "organizer-granted", membershipSchemaVersion: 1, protocolVersion: 2, groupId: ctx.groupId,
    author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: new Date().toISOString(), membershipHeads: [approval.id], causalHeads: [], dependsOn: [],
    payload: { participantId: member.participantId }
  };
  organizer.signature = await signRecord(organizer, ctx.owner.privateKey);
  ctx.records.push(organizer);
  await assert.rejects(create(ctx, archive, member, [organizer.id]), /not-owner/);

  const proposal = await createOwnershipTransferProposalCommand({ groupId: ctx.groupId,
    recipientParticipantId: member.participantId, recipientDeviceId: member.deviceId, recipientKeyId: member.keyId,
    membershipHeads: [organizer.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(proposal);
  const acceptance = await createOwnershipTransferAcceptanceCommand({ proposal, groupId: ctx.groupId,
    membershipHeads: [proposal.id], identity: member, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(acceptance);
  const transferred = await create(ctx, archive, member, [acceptance.id]);
  assert.equal((await verify(ctx, transferred.record, archive)).ok, true);
  await assert.rejects(create(ctx, archive, ctx.owner, [acceptance.id]), /not-owner/);
});

test("forged membership ancestry cannot authorize a snapshot attestation", async () => {
  const ctx = await setup();
  const archive = await reviewArchive(legacySource());
  const forged = {
    id: uuid(), recordType: "participant-renamed", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.groupId, author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: new Date().toISOString(), membershipHeads: [ctx.genesis.id], causalHeads: [], dependsOn: [],
    payload: { participantId: ctx.owner.participantId, name: "Forged" }
  };
  const attacker = await generateDeviceSigningKeyPair();
  forged.signature = await signRecord(forged, attacker.privateKey);
  const membershipRecords = [...ctx.records, forged];
  await assert.rejects(create(ctx, archive, ctx.owner, [forged.id], { membershipRecords }), /not-owner|invalid-membership-heads/);
  const genuine = await create(ctx, archive);
  const alteredHeads = structuredClone(genuine.record);
  alteredHeads.membershipHeads = [forged.id];
  assert.equal((await verify(ctx, alteredHeads, archive, { membershipRecords })).ok, false);
});

test("known owner attestations remain verifiable past a signed future membership barrier", async () => {
  const ctx = await setup();
  const archive = await reviewArchive(legacySource());
  const attestation = await create(ctx, archive);
  const futureMembership = {
    id: uuid(), recordType: "future-membership-record", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.groupId,
    author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: new Date().toISOString(), membershipHeads: [ctx.genesis.id], causalHeads: [], dependsOn: [],
    payload: { future: true }
  };
  futureMembership.signature = await signRecord(futureMembership, ctx.owner.privateKey);
  const records = [...ctx.records, futureMembership];
  const verified = await verifyLegacyHistoryAttestation({ record: attestation.record, archive: attestation.archive,
    membershipRecords: records, trustPin: ctx.trustPin });
  assert.equal(verified.ok, true, "the archived owner statement remains verifiable at its trusted signed heads");
  await assert.rejects(createLegacyHistoryAttestation({ archive, membershipHeads: [ctx.genesis.id], identity: ctx.owner,
    membershipRecords: records, trustPin: ctx.trustPin }), /not-owner|invalid-attestation-context/,
  "authoring still refuses a membership projection marked read-only");
});

test("v2 maps source participants bijectively to active matching membership participants", async () => {
  const ctx = await setup();
  const { member, approval } = await addMember(ctx);
  const source = legacySource();
  source.people = [{ id: "old-alice", name: "Alice" }, { id: "old-bob", name: "Bob" }];
  source.events = [{ id: uuid(), type: "expense-created", description: "Lunch", amount: 1000, payerId: "old-alice",
    splits: [{ personId: "old-alice", amount: 500 }, { personId: "old-bob", amount: 500 }], createdAt: "2026-10-09T10:00:00.000Z" }];
  const archive = await reviewArchive(source);
  const mapping = [
    { sourceParticipantId: "old-alice", participantId: ctx.owner.participantId },
    { sourceParticipantId: "old-bob", participantId: member.participantId }
  ];
  const created = await create(ctx, archive, ctx.owner, [approval.id], { participantMapping: mapping });
  assert.equal(created.record.membershipSchemaVersion, 2);
  assert.deepEqual(created.record.payload.participantMapping, mapping);
  assert.deepEqual(Object.fromEntries(created.mappedOpeningBalances.map(({ participantId, amount }) => [participantId, amount])), {
    [ctx.owner.participantId]: 500, [member.participantId]: -500
  });
  const verified = await verify(ctx, created.record, created.archive, { membershipRecords: ctx.records });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.mappedOpeningBalances, created.mappedOpeningBalances);

  const invalidMappings = [
    [mapping[0]],
    [mapping[0], { ...mapping[1], participantId: mapping[0].participantId }],
    [mapping[0], { ...mapping[1], participantId: uuid() }],
    [{ ...mapping[0], participantId: member.participantId }, { ...mapping[1], participantId: ctx.owner.participantId }]
  ];
  for (const participantMapping of invalidMappings) {
    await assert.rejects(create(ctx, archive, ctx.owner, [approval.id], { participantMapping }), /invalid-participant-mapping/);
  }
  const reversedInput = await create(ctx, archive, ctx.owner, [approval.id], { participantMapping: [...mapping].reverse() });
  assert.deepEqual(reversedInput.record.payload.participantMapping, mapping, "the signed mapping is sorted by stable source ID");

  const tampered = structuredClone(created.record);
  tampered.payload.participantMapping[1].participantId = uuid();
  tampered.signature = await signRecord(tampered, ctx.owner.privateKey);
  assert.equal((await verify(ctx, tampered, archive, { membershipRecords: ctx.records })).ok, false);
});

test("v2 permits empty legacy history with an empty map, but rejects removed targets", async () => {
  const ctx = await setup();
  const emptySource = legacySource();
  emptySource.people = [];
  const empty = await create(ctx, await reviewArchive(emptySource), ctx.owner, [ctx.genesis.id], { participantMapping: [] });
  assert.equal(empty.record.membershipSchemaVersion, 2);
  assert.deepEqual(empty.mappedOpeningBalances, []);
  assert.equal((await verify(ctx, empty.record, empty.archive)).ok, true);

  const { member, approval } = await addMember(ctx);
  const causalEvent = await createSignedLedgerRecord({
    id: uuid(), type: "expense-created", groupId: ctx.groupId,
    author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-09T10:02:00.000Z", membershipHeads: [approval.id], causalHeads: [], dependsOn: [],
    payload: { expenseId: uuid(), description: "Removal proof", currency: "USD", amount: 100, payerId: ctx.owner.participantId,
      splits: [{ participantId: ctx.owner.participantId, amount: 100 }] }
  }, ctx.owner.privateKey);
  const causalContext = await createVerifiedCausalContext({ causalRecords: [causalEvent], membershipRecords: ctx.records, trustPin: ctx.trustPin });
  const removal = await createParticipantRemovalCommand({ participantId: member.participantId, groupId: ctx.groupId,
    membershipHeads: [approval.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin, causalContext });
  ctx.records.push(removal);
  const source = legacySource();
  source.people = [{ id: "old-alice", name: "Alice" }, { id: "old-bob", name: "Bob" }];
  const archive = await reviewArchive(source);
  await assert.rejects(create(ctx, archive, ctx.owner, [removal.id], { participantMapping: [
    { sourceParticipantId: "old-alice", participantId: ctx.owner.participantId },
    { sourceParticipantId: "old-bob", participantId: member.participantId }
  ], verifiedCausalContexts: [causalContext] }), /invalid-participant-mapping/);
});

test("verified causal context is forwarded, and a revoked owner device cannot attest", async () => {
  const ctx = await setup();
  const source = legacySource();
  const archive = await reviewArchive(source);
  const nextOwnerDevice = { participantId: ctx.owner.participantId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const invite = await createInviteCommand({ groupId: ctx.groupId, participantId: ctx.owner.participantId,
    membershipHeads: [ctx.genesis.id], identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(invite.record);
  const request = await createJoinRequestCommand({ invite: invite.record, token: invite.token, groupId: ctx.groupId,
    membershipHeads: [invite.record.id], identity: nextOwnerDevice, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(request);
  const approval = await approveJoinRequestCommand({ invite: invite.record, request, token: invite.token, genesis: ctx.genesis,
    trustPin: ctx.trustPin, membershipHeads: [invite.record.id], identity: ctx.owner, records: ctx.records });
  ctx.records.push(approval);
  const consent = await createOwnerDeviceConsentCommand({ approval, groupId: ctx.groupId, membershipHeads: [approval.id],
    identity: ctx.owner, records: ctx.records, trustPin: ctx.trustPin });
  ctx.records.push(consent);
  const causalEvent = await createSignedLedgerRecord({
    id: uuid(), type: "expense-created", groupId: ctx.groupId,
    author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-09T10:01:00.000Z", membershipHeads: [consent.id], causalHeads: [], dependsOn: [],
    payload: { expenseId: uuid(), description: "Observed", currency: "USD", amount: 100, payerId: ctx.owner.participantId,
      splits: [{ participantId: ctx.owner.participantId, amount: 100 }] }
  }, ctx.owner.privateKey);
  const causalContext = await createVerifiedCausalContext({ causalRecords: [causalEvent], membershipRecords: ctx.records, trustPin: ctx.trustPin });
  const removal = await createDeviceRevocationCommand({ participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId,
    keyId: ctx.owner.keyId, groupId: ctx.groupId, membershipHeads: [consent.id], identity: ctx.owner,
    records: ctx.records, trustPin: ctx.trustPin, causalContext });
  ctx.records.push(removal);

  const createdByNewDevice = await create(ctx, archive, nextOwnerDevice, [removal.id], { verifiedCausalContexts: [causalContext] });
  assert.equal((await verify(ctx, createdByNewDevice.record, archive, { verifiedCausalContexts: [causalContext] })).ok, true);
  await assert.rejects(create(ctx, archive, ctx.owner, [removal.id], { verifiedCausalContexts: [causalContext] }), /not-owner/);
});

test("verification rejects signature, archive, group, currency, schema, and payload tampering", async () => {
  const ctx = await setup();
  const source = legacySource();
  const archive = await reviewArchive(source);
  const { record } = await create(ctx, archive);
  const fields = [
    (payload) => { payload.sourceGroupId = uuid(); },
    (payload) => { const value = payload.sourceCanonicalContentDigest.value; payload.sourceCanonicalContentDigest.value = `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`; },
    (payload) => { payload.archiveFormat = "other-format"; },
    (payload) => { payload.participants[0].name = "Changed"; },
    (payload) => { payload.currency = "EUR"; },
    (payload) => { payload.openingBalances[0].amount = 1; },
    (payload) => { payload.legacyEventCount += 1; },
    (payload) => { payload.legacyAuthorship = "verified"; }
  ];
  for (const change of fields) {
    const altered = structuredClone(record);
    change(altered.payload);
    assert.equal((await verify(ctx, altered, archive)).ok, false);
  }

  const badArchiveSource = { ...source, name: "Changed source" };
  const badArchive = await reviewArchive(badArchiveSource);
  assert.equal((await verify(ctx, record, badArchive)).ok, false);
  assert.equal((await verify(ctx, record, { kind: "original-bytes", mediaType: "application/json", bytes: new Uint8Array(8 * 1024 * 1024 + 1) })).reason,
    "legacy-archive-too-large-or-invalid");

  const wrongGroup = structuredClone(record);
  wrongGroup.groupId = uuid();
  wrongGroup.signature = await signRecord(wrongGroup, ctx.owner.privateKey);
  assert.equal((await verify(ctx, wrongGroup, archive)).reason, "group-mismatch");

  const wrongCurrencySource = legacySource("EUR");
  const wrongCurrencyArchive = await reviewArchive(wrongCurrencySource);
  assert.equal((await verify(ctx, record, wrongCurrencyArchive)).reason, "attestation-payload-mismatch");
  await assert.rejects(create(ctx, wrongCurrencyArchive), /currency-mismatch/);

  const unsupported = { ...record, protocolVersion: 3 };
  assert.equal((await verify(ctx, unsupported, archive)).reason, "unsupported-attestation-envelope");
  assert.equal((await verify(ctx, record, archive, { trustPin: { genesisId: uuid(), publicKeyFingerprint: ctx.trustPin.publicKeyFingerprint } })).ok, false);
  assert.equal((await verifyLegacyHistoryAttestation({ record, archive, membershipRecords: ctx.records })).reason, "invalid-attestation-context");

  const invalidInput = structuredClone(record);
  invalidInput.payload.openingBalances[0].amount = 2;
  invalidInput.signature = await signRecord(invalidInput, ctx.owner.privateKey);
  assert.equal((await verify(ctx, invalidInput, archive)).reason, "invalid-attestation-payload");
});
