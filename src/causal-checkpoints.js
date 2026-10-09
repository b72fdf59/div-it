import { canonicalJsonBytes, signRecord } from "./identity-crypto.js";
import { planCausalCheckpoints } from "./causal-graph.js";
import { createVerifiedCausalContext, parseCausalFrontierCheckpoint, resolveMembershipAuthority } from "./signed-membership-projector.js";
import { parseSignedLedgerRecord } from "./signed-ledger-records.js";

const MAX_BYTES = 8192;
const MAX_HEADS = 64;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function sortedIds(ids, { nonempty = true } = {}) {
  return Array.isArray(ids) && ids.length <= MAX_HEADS && (!nonempty || ids.length > 0)
    && ids.every((id, index) => typeof id === "string" && UUID.test(id) && (!index || ids[index - 1] < id));
}

function causalRecord(raw) {
  const ledger = parseSignedLedgerRecord(raw);
  if (ledger.ok) return ledger.record;
  const checkpoint = parseCausalFrontierCheckpoint(raw);
  return checkpoint.ok ? checkpoint.record : null;
}

/** Create signed, lossless checkpoint records for the authenticated observed causal frontier. */
export async function createCausalFrontierCheckpointCommands({
  causalRecords, membershipRecords, trustPin, identity, membershipHeads, verifiedCausalContexts = [], checkpointIds
} = {}) {
  if (!Array.isArray(causalRecords) || !Array.isArray(membershipRecords) || !trustPin || !identity
      || !Array.isArray(verifiedCausalContexts) || !sortedIds(membershipHeads)) {
    throw new TypeError("invalid-causal-checkpoint-input");
  }
  try {
    causalRecords = structuredClone(causalRecords);
    membershipRecords = structuredClone(membershipRecords);
    trustPin = structuredClone(trustPin);
    membershipHeads = structuredClone(membershipHeads);
    verifiedCausalContexts = [...verifiedCausalContexts];
  } catch { throw new TypeError("uncloneable-causal-checkpoint-input"); }
  const signer = Object.freeze({ participantId: identity.participantId, deviceId: identity.deviceId, keyId: identity.keyId,
    privateKey: identity.privateKey, publicKey: identity.publicKey });
  if (![signer.participantId, signer.deviceId, signer.keyId].every((id) => typeof id === "string" && UUID.test(id))) {
    throw new TypeError("invalid-causal-checkpoint-identity");
  }

  const verified = await createVerifiedCausalContext({ causalRecords, membershipRecords, trustPin,
    authorizationContexts: verifiedCausalContexts, allowLargeFrontier: true });
  if (verified.groupId !== causalRecords[0]?.groupId && causalRecords.length) throw new Error("causal-checkpoint-group-mismatch");
  const currentAuthority = await resolveMembershipAuthority({ identity: signer, membershipHeads,
    records: membershipRecords, trustPin, verifiedCausalContexts });
  if (!currentAuthority) throw new Error("causal-checkpoint-signer-inactive");

  // The signer must be active at each direct frontier input's authorization state.
  const sourceById = new Map(causalRecords.map((raw) => causalRecord(raw)).filter(Boolean).map((record) => [record.id, record]));
  for (const id of verified.frontier) {
    const record = sourceById.get(id);
    if (!record) throw new Error("causal-checkpoint-invalid-source");
    const authority = await resolveMembershipAuthority({ identity: signer, membershipHeads: record.membershipHeads,
      records: membershipRecords, trustPin, verifiedCausalContexts });
    if (!authority) throw new Error("causal-checkpoint-signer-not-active-at-frontier-heads");
  }

  const required = verified.frontier.length <= MAX_HEADS ? 0
    : 1 + Math.ceil((verified.frontier.length - MAX_HEADS) / (MAX_HEADS - 1));
  const ids = checkpointIds ?? Array.from({ length: required }, () => crypto.randomUUID());
  const occupiedIds = new Set([...verified.sourceRecordIds, ...membershipRecords.map((record) => record?.id)]);
  if (ids.some((id) => occupiedIds.has(id))) throw new Error("causal-checkpoint-id-collision");
  const plan = planCausalCheckpoints(verified.frontier, ids);
  if (!plan.ok) throw new Error(`causal-checkpoint-${plan.reason}`);

  const records = [];
  let causalContext = verified;
  for (const step of plan.steps) {
    const record = {
      id: step.id,
      recordType: "frontier-checkpoint",
      membershipSchemaVersion: 1,
      protocolVersion: 2,
      groupId: verified.groupId,
      author: { participantId: signer.participantId, deviceId: signer.deviceId, keyId: signer.keyId },
      createdAt: new Date().toISOString(),
      membershipHeads: [...membershipHeads],
      causalHeads: [...step.causalHeads],
      dependsOn: [],
      payload: { frontierKind: "causal" }
    };
    record.signature = await signRecord(record, signer.privateKey);
    if (canonicalJsonBytes(record).byteLength > MAX_BYTES || !parseCausalFrontierCheckpoint(record).ok) {
      throw new Error("causal-checkpoint-invalid-generated-record");
    }
    records.push(record);
  }

  if (records.length) {
    causalContext = await createVerifiedCausalContext({ causalRecords: [...causalRecords, ...records], membershipRecords,
      trustPin, authorizationContexts: verifiedCausalContexts });
    if (causalContext.frontier.length !== 1 || causalContext.frontier[0] !== plan.frontier[0]) throw new Error("causal-checkpoint-frontier-mismatch");
  }
  return { records, frontier: [...plan.frontier], causalContext };
}
