import assert from "node:assert/strict";
import { test } from "node:test";
import { createInviteCommand, createJoinRequestCommand, approveJoinRequestCommand } from "./src/membership-invitations.js";
import { exportDevicePublicKey, generateDeviceSigningKeyPair, signRecord } from "./src/identity-crypto.js";
import { createSignedLedgerRecord, parseSignedLedgerRecord } from "./src/signed-ledger-records.js";
import { projectAuthenticatedLedger } from "./src/authenticated-ledger.js";

const uuid = () => crypto.randomUUID();
const base64url = (bytes) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
};

async function setup({ approveMember = true } = {}) {
  const ownerPair = await generateDeviceSigningKeyPair();
  const owner = { participantId: uuid(), deviceId: uuid(), keyId: uuid(), ...ownerPair };
  const groupId = uuid();
  const genesisId = uuid();
  const publicBytes = await exportDevicePublicKey(owner.publicKey);
  const genesis = {
    id: genesisId,
    recordType: "group-created",
    membershipSchemaVersion: 1,
    protocolVersion: 2,
    groupId,
    author: { participantId: owner.participantId, deviceId: owner.deviceId, keyId: owner.keyId },
    createdAt: "2026-10-08T10:00:00.000Z",
    membershipHeads: [],
    causalHeads: [],
    dependsOn: [],
    payload: {
      name: "Authenticated test",
      currency: "USD",
      owner: {
        participantId: owner.participantId,
        deviceId: owner.deviceId,
        keyId: owner.keyId,
        name: "Alice",
        publicKey: base64url(publicBytes)
      }
    }
  };
  genesis.signature = await signRecord(genesis, owner.privateKey);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", publicBytes));
  const trustPin = { genesisId, publicKeyFingerprint: `sha256:${base64url(digest)}` };
  const records = [genesis];
  const person = { id: uuid(), recordType: "participant-added", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId, author: { participantId: owner.participantId, deviceId: owner.deviceId, keyId: owner.keyId },
    createdAt: "2026-10-08T10:00:01.000Z", membershipHeads: [genesisId], causalHeads: [], dependsOn: [],
    payload: { participantId: uuid(), name: "Bob" } };
  person.signature = await signRecord(person, owner.privateKey);
  records.push(person);

  const member = { participantId: person.payload.participantId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const invitation = await createInviteCommand({ groupId, participantId: member.participantId,
    membershipHeads: [person.id], identity: owner, records, trustPin });
  records.push(invitation.record);
  const request = await createJoinRequestCommand({ invite: invitation.record, token: invitation.token, groupId,
    membershipHeads: [invitation.record.id], identity: member, records, trustPin });
  records.push(request);

  let approval;
  if (approveMember) {
    approval = await approveJoinRequestCommand({ invite: invitation.record, request, token: invitation.token,
      genesis, trustPin, membershipHeads: [invitation.record.id], identity: owner, records });
    records.push(approval);
  }
  return { owner, member, groupId, genesis, trustPin, records, person, invitation, request, approval,
    author: { participantId: member.participantId, deviceId: member.deviceId, keyId: member.keyId },
    membershipHeads: [approval?.id ?? invitation.record.id] };
}

function eventInput(ctx, type, payload, { id = uuid(), membershipHeads = ctx.membershipHeads, causalHeads = [], dependsOn = [], groupId = ctx.groupId, author = ctx.author } = {}) {
  return { id, type, groupId, author, createdAt: "2026-10-08T10:01:00.000Z", membershipHeads, causalHeads, dependsOn, payload };
}

async function signEvent(ctx, type, payload, options = {}) {
  const key = options.privateKey ?? ctx.member.privateKey;
  return createSignedLedgerRecord(eventInput(ctx, type, payload, options), key);
}

async function project(ctx, rawRecords, options = {}) {
  return projectAuthenticatedLedger(rawRecords, {
    membershipRecords: ctx.records,
    trustPin: ctx.trustPin,
    ...options
  });
}

function expensePayload(ctx, { expenseId = uuid(), description = "Meal", amount = 1000, payerId = ctx.member.participantId, each = amount / 2 } = {}) {
  return { expenseId, description, currency: "USD", amount, payerId,
    splits: [{ participantId: ctx.owner.participantId, amount: each }, { participantId: ctx.member.participantId, amount: amount - each }] };
}

async function allFinancialTypes(ctx) {
  const created = await signEvent(ctx, "expense-created", expensePayload(ctx));
  const revised = await signEvent(ctx, "expense-revised", { ...created.payload, description: "Meal revised", amount: 1200,
    splits: [{ participantId: ctx.owner.participantId, amount: 600 }, { participantId: ctx.member.participantId, amount: 600 }],
    supersedesEventId: created.id }, { dependsOn: [created.id] });
  const voided = await signEvent(ctx, "expense-voided", { expenseId: created.payload.expenseId, supersedesEventId: revised.id, reason: "Refunded" }, { dependsOn: [revised.id] });

  const settlement = await signEvent(ctx, "settlement-recorded", { settlementId: uuid(), currency: "USD",
    fromParticipantId: ctx.member.participantId, toParticipantId: ctx.owner.participantId, amount: 300 });
  const reversed = await signEvent(ctx, "settlement-reversed", { settlementId: settlement.payload.settlementId,
    reversesEventId: settlement.id, reason: "Returned" }, { dependsOn: [settlement.id] });
  const opening = await signEvent(ctx, "opening-balances-imported", { importId: uuid(), currency: "USD", sourceFormat: "splitwise-csv",
    balances: [{ participantId: ctx.owner.participantId, amount: 200 }, { participantId: ctx.member.participantId, amount: -200 }] });

  const base = await signEvent(ctx, "expense-created", expensePayload(ctx, { description: "Second meal", amount: 1000, payerId: ctx.owner.participantId }));
  const branchA = await signEvent(ctx, "expense-revised", { ...base.payload, description: "Branch A", amount: 1200,
    splits: [{ participantId: ctx.owner.participantId, amount: 600 }, { participantId: ctx.member.participantId, amount: 600 }],
    supersedesEventId: base.id }, { dependsOn: [base.id] });
  const branchB = await signEvent(ctx, "expense-revised", { ...base.payload, description: "Branch B", amount: 1400,
    payerId: ctx.member.participantId,
    splits: [{ participantId: ctx.owner.participantId, amount: 700 }, { participantId: ctx.member.participantId, amount: 700 }],
    supersedesEventId: base.id }, { dependsOn: [base.id] });
  const branches = [branchA.id, branchB.id].sort();
  const resolution = await signEvent(ctx, "conflict-resolved", { resolutionId: uuid(), expenseId: base.payload.expenseId,
    resolvesEventIds: branches, chosenEventId: branchB.id, supersedesResolutionEventIds: [] }, { dependsOn: [base.id, ...branches].sort() });
  return [created, revised, voided, settlement, reversed, opening, base, branchA, branchB, resolution];
}

test("enrolled ordinary member's seven signed event types project deterministically", async () => {
  const ctx = await setup();
  const records = await allFinancialTypes(ctx);
  const forward = await project(ctx, records);
  const reverse = await project(ctx, [...records].reverse());
  const expectedTypes = new Set(["expense-created", "expense-revised", "expense-voided", "settlement-recorded",
    "settlement-reversed", "opening-balances-imported", "conflict-resolved"]);

  assert.equal(forward.groupId, ctx.groupId);
  assert.equal(forward.currency, "USD");
  assert.equal(forward.readOnly, false);
  assert.equal(forward.quarantined.length, 0);
  assert.equal(forward.pending.length, 0);
  assert.equal(forward.conflicting.length, 0);
  assert.equal(forward.effective.some((item) => item.type === "conflict-resolved"), true);
  assert.deepEqual(new Set(records.map((record) => parseSignedLedgerRecord(record).event.type)), expectedTypes);
  assert.deepEqual(forward.balances, { [ctx.owner.participantId]: -500, [ctx.member.participantId]: 500 });
  assert.deepEqual(reverse.balances, forward.balances);
  assert.deepEqual(reverse.effective.map(({ id }) => id), forward.effective.map(({ id }) => id));
  assert.deepEqual(forward.rawRecords, records, "original signed records remain auditable");
});

test("unknown and proof-only devices, wrong keys, wrong groups, and unknown participants cannot affect balances", async () => {
  const ctx = await setup();
  const payload = expensePayload(ctx);
  const valid = await signEvent(ctx, "expense-created", payload);
  const stranger = { participantId: ctx.member.participantId, deviceId: uuid(), keyId: uuid(), ...await generateDeviceSigningKeyPair() };
  const unknownDevice = await signEvent(ctx, "expense-created", payload, {
    author: { participantId: stranger.participantId, deviceId: stranger.deviceId, keyId: stranger.keyId }, privateKey: stranger.privateKey
  });
  const mismatchedAttribution = await signEvent(ctx, "expense-created", payload, {
    author: { participantId: ctx.owner.participantId, deviceId: ctx.member.deviceId, keyId: ctx.member.keyId }
  });
  const wrongKey = await signEvent(ctx, "expense-created", payload, { privateKey: ctx.owner.privateKey });
  const wrongGroup = await signEvent(ctx, "expense-created", payload, { groupId: uuid() });
  const unknownParticipant = await signEvent(ctx, "expense-created", { ...payload, payerId: "not-in-roster",
    splits: [{ participantId: "not-in-roster", amount: 500 }, { participantId: ctx.member.participantId, amount: 500 }] });
  const wrongCurrency = await signEvent(ctx, "expense-created", { ...payload, currency: "EUR" });

  const diagnosticsForward = await project(ctx, [valid, unknownDevice, mismatchedAttribution, wrongKey, wrongGroup, unknownParticipant, wrongCurrency]);
  const diagnosticsReverse = await project(ctx, [wrongCurrency, unknownParticipant, wrongGroup, wrongKey, mismatchedAttribution, unknownDevice, valid]);
  for (const field of ["pending", "quarantined", "unsupported", "membershipDiagnostics"]) {
    assert.deepEqual(diagnosticsForward[field], diagnosticsReverse[field], `${field} ordering is stable across input permutations`);
  }

  for (const [record, reason] of [[unknownDevice, "unknown-device-at-membership-heads"], [mismatchedAttribution, "unknown-device-at-membership-heads"], [wrongKey, "invalid-signature"],
    [wrongGroup, "group-mismatch"], [unknownParticipant, "unknown-participant-reference"], [wrongCurrency, "currency-mismatch"]]) {
    const result = await project(ctx, [record]);
    assert.deepEqual(result.balances, {});
    assert.equal(result.quarantined.some((item) => item.reason === reason), true, reason);
  }
  const ignoredCallerCallback = await project(ctx, [unknownDevice], { isEventAuthorized: () => true });
  assert.deepEqual(ignoredCallerCallback.balances, {}, "caller authorization callbacks are ignored");

  const changedFrontier = structuredClone(valid);
  changedFrontier.causalHeads = [uuid()];
  const tampered = await project(ctx, [changedFrontier]);
  assert.deepEqual(tampered.balances, {});
  assert.equal(tampered.quarantined.some((item) => item.reason === "invalid-signature"), true);

  const proofOnly = await setup({ approveMember: false });
  const proofRecord = await signEvent(proofOnly, "expense-created", expensePayload(proofOnly));
  const deniedRequestDevice = await project(proofOnly, [proofRecord]);
  assert.deepEqual(deniedRequestDevice.balances, {});
  assert.equal(deniedRequestDevice.quarantined.some((item) => item.reason === "proof-only-device"), true);
});

test("unverified ledger head claims cannot force read-only; authenticated invalid heads are diagnosed", async () => {
  const ctx = await setup();
  const valid = await signEvent(ctx, "expense-created", expensePayload(ctx));

  const invalidHead = {
    id: uuid(), recordType: "participant-renamed", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.groupId,
    author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-08T10:02:00.000Z", membershipHeads: [ctx.approval.id], causalHeads: [], dependsOn: [],
    payload: { participantId: ctx.member.participantId, name: "Forged roster" }
  };
  invalidHead.signature = await signRecord(invalidHead, ctx.member.privateKey);
  const membershipRecords = [...ctx.records, invalidHead];

  const tampered = structuredClone(valid);
  tampered.membershipHeads = [invalidHead.id];
  const tamperedProjection = await project({ ...ctx, records: membershipRecords }, [valid, tampered]);
  assert.equal(tamperedProjection.readOnly, false);
  assert.deepEqual(tamperedProjection.balances, { [ctx.owner.participantId]: -500, [ctx.member.participantId]: 500 });
  assert.equal(tamperedProjection.quarantined.some((item) => item.id === valid.id && item.reason === "invalid-membership-heads"), true);
  assert.equal(tamperedProjection.pending.some((item) => item.id === valid.id), false);

  const authenticInvalidHead = await signEvent(ctx, "expense-created", expensePayload(ctx), { membershipHeads: [invalidHead.id] });
  const authenticatedProjection = await project({ ...ctx, records: membershipRecords }, [authenticInvalidHead]);
  assert.equal(authenticatedProjection.readOnly, false);
  assert.deepEqual(authenticatedProjection.balances, {});
  assert.equal(authenticatedProjection.quarantined.some((item) => item.id === authenticInvalidHead.id && item.reason === "invalid-membership-heads"), true);
});

test("unknown dependencies stay pending and invalid trust cannot authorize a group", async () => {
  const ctx = await setup();
  const missingDomainDependency = uuid();
  const dependent = await signEvent(ctx, "expense-revised", {
    ...expensePayload(ctx), supersedesEventId: missingDomainDependency
  }, { dependsOn: [missingDomainDependency] });
  const domainPending = await project(ctx, [dependent]);
  assert.deepEqual(domainPending.balances, {});
  assert.equal(domainPending.pending.some((item) => item.reason === "missing-dependency"), true);

  const missingHead = uuid();
  const record = await signEvent(ctx, "expense-created", expensePayload(ctx), { membershipHeads: [missingHead] });
  const result = await project(ctx, [record]);
  assert.deepEqual(result.balances, {});
  assert.equal(result.pending.some((item) => item.reason === "missing-membership-head"), true);

  const untrusted = await project(ctx, [await signEvent(ctx, "expense-created", expensePayload(ctx))], {
    trustPin: { ...ctx.trustPin, genesisId: uuid() }
  });
  assert.equal(untrusted.groupId, null);
  assert.equal(untrusted.readOnly, true);
  assert.deepEqual(untrusted.balances, {});
});

test("same-ID authorized v2 variants collide before v1 conversion; invalid variants do not shadow valid ones", async () => {
  const ctx = await setup();
  const rename = {
    id: uuid(), recordType: "participant-renamed", membershipSchemaVersion: 1, protocolVersion: 2,
    groupId: ctx.groupId,
    author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-08T10:03:00.000Z", membershipHeads: [ctx.approval.id], causalHeads: [], dependsOn: [],
    payload: { participantId: ctx.member.participantId, name: "Robert" }
  };
  rename.signature = await signRecord(rename, ctx.owner.privateKey);
  ctx.records.push(rename);
  const payload = expensePayload(ctx, { amount: 2000, each: 1000 });
  const base = eventInput(ctx, "expense-created", payload, { id: uuid(), membershipHeads: [ctx.approval.id] });
  const first = await createSignedLedgerRecord(base, ctx.member.privateKey);
  const second = await createSignedLedgerRecord({ ...base, membershipHeads: [rename.id] }, ctx.member.privateKey);
  const firstView = parseSignedLedgerRecord(first).event;
  const secondView = parseSignedLedgerRecord(second).event;
  const { signature: _firstSignature, ...firstUnsignedView } = firstView;
  const { signature: _secondSignature, ...secondUnsignedView } = secondView;
  assert.deepEqual(firstUnsignedView, secondUnsignedView);

  const collision = await project(ctx, [first, second]);
  assert.deepEqual(collision.balances, {});
  assert.equal(collision.quarantined.filter((item) => item.reason === "id-content-collision").length, 2);

  const invalidVariant = structuredClone(second);
  invalidVariant.signature = `${invalidVariant.signature.slice(0, -1)}${invalidVariant.signature.endsWith("A") ? "B" : "A"}`;
  const retained = await project(ctx, [first, invalidVariant]);
  assert.deepEqual(retained.balances, { [ctx.owner.participantId]: -1000, [ctx.member.participantId]: 1000 });
  assert.equal(retained.quarantined.some((item) => item.reason === "invalid-signature"), true);
  const duplicate = await project(ctx, [first, first]);
  assert.deepEqual(duplicate.balances, retained.balances, "identical signed delivery applies once");
});

test("unsupported signed ledger versions and unsupported membership fail read-only", async () => {
  const ctx = await setup();
  const known = await signEvent(ctx, "expense-created", expensePayload(ctx));
  const future = { ...known, protocolVersion: 3 };
  future.signature = await signRecord(future, ctx.member.privateKey);
  const futureProjection = await project(ctx, [future]);
  assert.equal(futureProjection.readOnly, true);
  assert.equal(futureProjection.unsupported.some((item) => item.reason === "unsupported-version"), true);
  assert.deepEqual(futureProjection.balances, {});
  const forgedFuture = { ...future, signature: known.signature };
  const forgedFutureProjection = await project(ctx, [forgedFuture]);
  assert.equal(forgedFutureProjection.readOnly, false, "unauthenticated future records cannot force read-only mode");
  assert.equal(forgedFutureProjection.unsupported.length, 0);
  assert.equal(forgedFutureProjection.quarantined.some((item) => item.reason === "invalid-signature"), true);

  const unsupportedMembership = {
    id: uuid(),
    recordType: "future-membership-record",
    membershipSchemaVersion: 1,
    protocolVersion: 2,
    groupId: ctx.groupId,
    author: { participantId: ctx.owner.participantId, deviceId: ctx.owner.deviceId, keyId: ctx.owner.keyId },
    createdAt: "2026-10-08T10:02:00.000Z",
    membershipHeads: [ctx.approval.id],
    causalHeads: [],
    dependsOn: [],
    payload: { future: true }
  };
  unsupportedMembership.signature = await signRecord(unsupportedMembership, ctx.owner.privateKey);
  const readOnly = await project({ ...ctx, records: [...ctx.records, unsupportedMembership] }, [known]);
  assert.equal(readOnly.readOnly, true);
});
