import assert from "node:assert/strict";
import { test } from "node:test";
import { generateDeviceSigningKeyPair, signRecord } from "./src/identity-crypto.js";
import { projectMembershipRecords } from "./src/membership-projector.js";

const id = (prefix) => `${prefix.repeat(8)}-${prefix.repeat(4)}-4${prefix.repeat(3)}-8${prefix.repeat(3)}-${prefix.repeat(12)}`;

function encode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

async function fixture() {
  const pair = await generateDeviceSigningKeyPair();
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const fingerprint = encode(new Uint8Array(await crypto.subtle.digest("SHA-256", publicKey)));
  const genesis = {
    id: id("a"),
    recordType: "group-created",
    membershipSchemaVersion: 1,
    protocolVersion: 2,
    groupId: id("b"),
    author: { participantId: id("c"), deviceId: id("d"), keyId: id("e") },
    createdAt: "2026-10-07T00:00:00.000Z",
    membershipHeads: [],
    causalHeads: [],
    dependsOn: [],
    payload: {
      name: "Trip",
      currency: "USD",
      owner: {
        participantId: id("c"),
        deviceId: id("d"),
        keyId: id("e"),
        name: "Owner",
        publicKey: encode(publicKey)
      }
    }
  };
  genesis.signature = await signRecord(genesis, pair.privateKey);
  const trustPin = { genesisId: genesis.id, publicKeyFingerprint: `sha256:${fingerprint}` };
  async function transition(recordType, payload, { recordId = id("f"), membershipHeads = [genesis.id], groupId = genesis.groupId, author = genesis.author } = {}) {
    const record = {
      id: recordId,
      recordType,
      membershipSchemaVersion: 1,
      protocolVersion: 2,
      groupId,
      author: { ...author },
      createdAt: "2026-10-07T00:00:00.000Z",
      membershipHeads: [...membershipHeads].sort(),
      causalHeads: [],
      dependsOn: [],
      payload: structuredClone(payload)
    };
    record.signature = await signRecord(record, pair.privateKey);
    return record;
  }
  return { pair, genesis, trustPin, transition };
}

test("projects independent additions and duplicate delivery identically in any order", async () => {
  const { genesis, trustPin, transition } = await fixture();
  const alice = await transition("participant-added", { participantId: id("1"), name: "Alice" }, { recordId: id("1") });
  const bob = await transition("participant-added", { participantId: id("2"), name: "Bob" }, { recordId: id("2") });
  const merged = await transition("participant-added", { participantId: id("3"), name: "Merged" }, {
    recordId: id("3"), membershipHeads: [alice.id, bob.id]
  });
  const source = [genesis, alice, bob, merged, structuredClone(alice)];
  const before = JSON.stringify(source);
  const first = await projectMembershipRecords(source, { trustPin });
  const reordered = await projectMembershipRecords([merged, structuredClone(alice), bob, genesis, alice], { trustPin });
  assert.deepEqual(first.participants, reordered.participants);
  assert.deepEqual(first.heads, reordered.heads);
  assert.deepEqual(first.diagnostics, reordered.diagnostics);
  assert.equal(first.participants.length, 4);
  assert.equal(first.diagnostics.filter((item) => item.reason === "duplicate-membership-record").length, 1);
  assert.equal(first.diagnostics.find((item) => item.reason === "duplicate-membership-record").duplicateCount, 1);
  assert.equal(JSON.stringify(source), before);
  assert.equal(first.rawRecords.length, source.length);
});

test("re-adding an existing participant cannot rename them or recreate the owner", async () => {
  const { genesis, trustPin, transition } = await fixture();
  const member = await transition("participant-added", { participantId: id("1"), name: "Original" }, { recordId: id("1") });
  const readd = await transition("participant-added", { participantId: id("1"), name: "Changed" }, { recordId: id("2"), membershipHeads: [member.id] });
  const ownerReadd = await transition("participant-added", { participantId: id("c"), name: "Impersonated" }, { recordId: id("3") });
  const result = await projectMembershipRecords([genesis, member, readd, ownerReadd], { trustPin });
  assert.equal(result.participants.find((participant) => participant.id === id("1")).name, "Original");
  assert.equal(result.participants.find((participant) => participant.id === id("c")).name, "Owner");
  assert.equal(result.diagnostics.find((item) => item.recordId === readd.id).reason, "participant-already-exists");
  assert.equal(result.diagnostics.find((item) => item.recordId === ownerReadd.id).reason, "participant-already-exists");
});

test("a rename commutes with an unrelated branch and applies over the shared prior name", async () => {
  const { genesis, trustPin, transition } = await fixture();
  const member = await transition("participant-added", { participantId: id("1"), name: "Old" }, { recordId: id("1") });
  const rename = await transition("participant-renamed", { participantId: id("1"), name: "New" }, { recordId: id("2"), membershipHeads: [member.id] });
  const unrelated = await transition("participant-added", { participantId: id("2"), name: "Other" }, { recordId: id("3"), membershipHeads: [member.id] });
  const result = await projectMembershipRecords([unrelated, rename, member, genesis], { trustPin });
  assert.deepEqual(result.participants, [
    { id: id("1"), name: "New" },
    { id: id("2"), name: "Other" },
    { id: id("c"), name: "Owner" }
  ].sort((a, b) => a.id.localeCompare(b.id)));
  assert.equal(result.diagnostics.some((item) => item.reason === "participant-name-conflict"), false);
});

test("concurrent name and role changes retain the shared prior values with diagnostics", async () => {
  const { genesis, trustPin, transition } = await fixture();
  const member = await transition("participant-added", { participantId: id("1"), name: "Prior" }, { recordId: id("1") });
  const renameA = await transition("participant-renamed", { participantId: id("1"), name: "A" }, { recordId: id("2"), membershipHeads: [member.id] });
  const renameB = await transition("participant-renamed", { participantId: id("1"), name: "B" }, { recordId: id("3"), membershipHeads: [member.id] });
  const priorGrant = await transition("organizer-granted", { participantId: id("1") }, { recordId: id("7"), membershipHeads: [member.id] });
  const grant = await transition("organizer-granted", { participantId: id("1") }, { recordId: id("4"), membershipHeads: [priorGrant.id] });
  const revoke = await transition("organizer-revoked", { participantId: id("1") }, { recordId: id("5"), membershipHeads: [priorGrant.id] });
  const result = await projectMembershipRecords([revoke, renameB, genesis, grant, priorGrant, member, renameA], { trustPin });
  assert.equal(result.participants.find((participant) => participant.id === id("1")).name, "Prior");
  assert.equal(result.organizers.includes(id("1")), true);
  assert.ok(result.diagnostics.some((item) => item.reason === "participant-name-conflict"));
  assert.ok(result.diagnostics.some((item) => item.reason === "organizer-role-conflict"));
});

test("concurrent different names for the same new participant do not select a winner", async () => {
  const { genesis, trustPin, transition } = await fixture();
  const first = await transition("participant-added", { participantId: id("1"), name: "First" }, { recordId: id("2") });
  const second = await transition("participant-added", { participantId: id("1"), name: "Second" }, { recordId: id("3") });
  const result = await projectMembershipRecords([second, genesis, first], { trustPin });
  assert.deepEqual(result.participants.find((participant) => participant.id === id("1")), { id: id("1"), name: null });
  assert.ok(result.diagnostics.some((item) => item.reason === "participant-name-conflict"));
  const resolution = await transition("participant-renamed", { participantId: id("1"), name: "Resolved" }, {
    recordId: id("4"), membershipHeads: [first.id, second.id]
  });
  const resolved = await projectMembershipRecords([resolution, second, genesis, first], { trustPin });
  assert.equal(resolved.participants.find((participant) => participant.id === id("1")).name, "Resolved");
  assert.equal(resolved.diagnostics.some((item) => item.reason === "participant-name-conflict"), false);
});

test("more than 256 duplicate deliveries remain an idempotent trusted projection", async () => {
  const { genesis, trustPin, transition } = await fixture();
  const member = await transition("participant-added", { participantId: id("1"), name: "Member" }, { recordId: id("1") });
  const deliveries = [genesis, member, ...Array.from({ length: 300 }, () => structuredClone(member))];
  const result = await projectMembershipRecords(deliveries, { trustPin });
  assert.equal(result.readOnly, false);
  assert.equal(result.participants.find((participant) => participant.id === id("1")).name, "Member");
  assert.equal(result.rawRecords.length, deliveries.length);
  assert.equal(result.diagnostics.find((item) => item.reason === "duplicate-membership-record").duplicateCount, 300);
  assert.equal(result.diagnostics.some((item) => item.reason === "membership-record-limit"), false);
});

test("rejects unauthorized signers, bad signatures, missing and cross-group references", async () => {
  const { genesis, trustPin, transition } = await fixture();
  const member = await transition("participant-added", { participantId: id("1"), name: "Member" }, { recordId: id("1") });
  const unauthorized = await transition("participant-added", { participantId: id("2"), name: "Unknown" }, {
    recordId: id("2"),
    author: { participantId: id("2"), deviceId: id("3"), keyId: id("4") }
  });
  const tampered = structuredClone(member);
  tampered.id = id("0");
  tampered.payload.name = "Tampered";
  const missing = await transition("participant-added", { participantId: id("5"), name: "Pending" }, { recordId: id("5"), membershipHeads: [id("6")] });
  const foreignParent = await transition("participant-added", { participantId: id("7"), name: "Foreign parent" }, { recordId: id("7"), groupId: id("8") });
  const crossGroupRef = await transition("participant-added", { participantId: id("9"), name: "Cross ref" }, { recordId: id("9"), membershipHeads: [foreignParent.id] });
  const ownerRevocation = await transition("organizer-revoked", { participantId: genesis.author.participantId }, { recordId: id("8") });
  const malformed = { id: Symbol("bad-id") };
  const result = await projectMembershipRecords([genesis, member, unauthorized, tampered, missing, foreignParent, crossGroupRef, ownerRevocation, malformed], { trustPin });
  const reasonFor = (recordId) => result.diagnostics.find((item) => item.recordId === recordId)?.reason;
  assert.equal(reasonFor(unauthorized.id), "unknown-signer");
  assert.equal(reasonFor(tampered.id), "invalid-membership-signature");
  assert.equal(reasonFor(missing.id), "missing-membership-head");
  assert.equal(reasonFor(foreignParent.id), "cross-group-record");
  assert.equal(reasonFor(crossGroupRef.id), "cross-group-reference");
  assert.equal(reasonFor(ownerRevocation.id), "owner-role-immutable");
  assert.ok(result.diagnostics.some((item) => item.reason === "invalid-membership-id"));
  assert.equal(result.participants.some((participant) => participant.id === id("2")), false);
  assert.equal(result.organizers.includes(genesis.author.participantId), true);
});

test("quarantines cycles and same-ID collisions without choosing a variant", async () => {
  const { genesis, trustPin, transition } = await fixture();
  const sameId = id("1");
  const variantA = await transition("participant-added", { participantId: id("2"), name: "A" }, { recordId: sameId });
  const variantB = await transition("participant-added", { participantId: id("3"), name: "B" }, { recordId: sameId });
  const cycleA = await transition("participant-added", { participantId: id("4"), name: "Cycle A" }, { recordId: id("5"), membershipHeads: [id("6")] });
  const cycleB = await transition("participant-added", { participantId: id("6"), name: "Cycle B" }, { recordId: id("6"), membershipHeads: [cycleA.id] });
  const result = await projectMembershipRecords([genesis, variantA, variantB, cycleA, cycleB], { trustPin });
  assert.ok(result.diagnostics.filter((item) => item.recordId === sameId).every((item) => item.reason === "id-content-collision"));
  assert.equal(result.participants.some((participant) => participant.id === id("2") || participant.id === id("3")), false);
  assert.ok(result.diagnostics.some((item) => item.reason === "membership-cycle"));
});

test("retains signed unsupported transitions and marks the group read-only", async () => {
  const { genesis, trustPin, transition, pair } = await fixture();
  const future = await transition("participant-frozen", { participantId: id("1") }, { recordId: id("1") });
  const futureVersion = { ...future, id: id("2"), recordType: "participant-added", protocolVersion: 3 };
  futureVersion.signature = await signRecord(futureVersion, pair.privateKey);
  const result = await projectMembershipRecords([genesis, future, futureVersion], { trustPin });
  assert.equal(result.readOnly, true);
  assert.ok(result.diagnostics.some((item) => item.reason === "unsupported-membership-record" && item.status === "unsupported"));
  assert.ok(result.diagnostics.some((item) => item.reason === "unsupported-membership-version" && item.status === "unsupported"));
});
