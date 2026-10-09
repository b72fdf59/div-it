import { canonicalJsonBytes, verifyRecord } from "./identity-crypto.js";
import { projectLedger } from "./ledger.js";
import { createVerifiedCausalContext, projectSignedMembership } from "./signed-membership-projector.js";
import { analyzeCausalGraph, causalReachability, maximalCausalFrontier } from "./causal-graph.js";
import { parseSignedLedgerRecord } from "./signed-ledger-records.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_KEY = /^[A-Za-z0-9_-]{43}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{85}[AQgw]$/;
const AUTHOR_FIELDS = ["participantId", "deviceId", "keyId"];
const ENVELOPE_FIELDS = ["id", "type", "schemaVersion", "protocolVersion", "groupId", "author", "createdAt", "membershipHeads", "causalHeads", "dependsOn", "payload", "signature"];
const MAX_LEDGER_EVENTS = 10_000;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;
const MAX_CAUSAL_CONTEXT_ROUNDS = 256;

function isRecord(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function diagnostic(id, reason, rawRecord) {
  return { ...(id ? { id } : {}), reason, ...(rawRecord === undefined ? {} : { rawRecord }) };
}

function diagnosticSortKey(item) {
  let raw = "";
  try { raw = item.rawRecord === undefined ? "" : stableJson(item.rawRecord); } catch { raw = "<invalid-raw-record>"; }
  return `${item.id || item.recordId || ""}:${item.reason || ""}:${item.status || ""}:${raw}`;
}

function sortedDiagnostics(items) {
  return items.sort((left, right) => diagnosticSortKey(left).localeCompare(diagnosticSortKey(right)));
}

function stableJson(value) {
  return new TextDecoder().decode(canonicalJsonBytes(value));
}

function cloneRaw(value) {
  try { return structuredClone(value); } catch { return value; }
}

function ledgerInputTooLarge(records) {
  let bytes = 0;
  for (const record of records) {
    if (bytes > MAX_LEDGER_BYTES || records.length > MAX_LEDGER_EVENTS) return true;
    try {
      const encoded = typeof record === "string" ? record : JSON.stringify(record);
      bytes += new TextEncoder().encode(encoded ?? "").byteLength;
    } catch {
      return true;
    }
  }
  return bytes > MAX_LEDGER_BYTES;
}

function decodePublicKey(value) {
  if (typeof value !== "string" || !BASE64URL_KEY.test(value)) return null;
  try {
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + "=");
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    let encoded = "";
    for (const byte of bytes) encoded += String.fromCharCode(byte);
    const canonical = btoa(encoded).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
    return bytes.length === 32 && canonical === value ? bytes : null;
  } catch {
    return null;
  }
}

function validIdentifier(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim() && [...value].length <= 128;
}

function validUuidList(values, { minimum = 0, maximum = 64 } = {}) {
  return Array.isArray(values) && values.length >= minimum && values.length <= maximum
    && values.every((id, index) => typeof id === "string" && UUID.test(id) && (index === 0 || values[index - 1] < id));
}

function validUnsupportedEnvelope(record) {
  if (!isRecord(record) || !isRecord(record.author)) return false;
  const timestamp = typeof record.createdAt === "string"
    && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/.exec(record.createdAt);
  const validTimestamp = timestamp && (() => {
    const [, year, month, day, hour, minute, second] = timestamp.map(Number);
    if (hour > 23 || minute > 59 || second > 59) return false;
    const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  })();
  return ENVELOPE_FIELDS.length === Object.keys(record).length
    && Object.keys(record).every((field) => ENVELOPE_FIELDS.includes(field))
    && typeof record.type === "string"
    && AUTHOR_FIELDS.length === Object.keys(record.author || {}).length
    && AUTHOR_FIELDS.every((field) => validIdentifier(record.author[field]))
    && UUID.test(record.id || "") && UUID.test(record.groupId || "")
    && Number.isSafeInteger(record.schemaVersion) && Number.isSafeInteger(record.protocolVersion)
    && record.schemaVersion >= 1 && record.protocolVersion >= 1 && validTimestamp
    && validUuidList(record.membershipHeads, { minimum: 1 })
    && validUuidList(record.causalHeads)
    && validUuidList(record.dependsOn, { maximum: 256 })
    && typeof record.signature === "string" && SIGNATURE.test(record.signature);
}

function eventParticipantIds(event) {
  const payload = event.payload;
  if (event.type === "expense-created" || event.type === "expense-revised") {
    return [payload.payerId, ...payload.splits.map(({ participantId }) => participantId)];
  }
  if (event.type === "settlement-recorded") return [payload.fromParticipantId, payload.toParticipantId];
  if (event.type === "opening-balances-imported") return payload.balances.map(({ participantId }) => participantId);
  return [];
}

function emptyProjection(rawRecords, diagnostics = [], readOnly = true) {
  return {
    groupId: null,
    currency: null,
    balances: {},
    effective: [],
    pending: [],
    conflicting: [],
    quarantined: diagnostics,
    unsupported: [],
    duplicates: [],
    ignored: [],
    readOnly,
    rawRecords: rawRecords.map(cloneRaw),
    membershipDiagnostics: []
  };
}

function ledgerContext(events, groupId, currency, allowedViews) {
  return projectLedger(events, {
    groupId,
    currency,
    // projectLedger requires a callback; this closed set is derived only from verified
    // membership and signature checks performed below, never from caller input.
    isEventAuthorized: (event) => {
      try { return allowedViews.has(stableJson(event)); } catch { return false; }
    }
  });
}

function checkpointObservedAtAllRemovalFrontiers(record, graph, membership) {
  const removals = [
    ...(membership.tombstones?.devices || []).map((item) => ({ ...item, recordType: "device-revoked" })),
    ...(membership.tombstones?.participants || []).map((item) => ({ ...item, recordType: "participant-removed" }))
  ].filter((item) => item.recordType === "participant-removed"
    ? item.participantId === record.author.participantId
    : item.participantId === record.author.participantId && item.deviceId === record.author.deviceId);
  return removals.every((removal) => (removal.causalHeads || []).some((head) =>
    causalReachability(graph, head, record.id).reachable === true));
}

async function removeUnverifiedCheckpointInputs(sources, membershipRecords, trustPin, contexts) {
  const graph = analyzeCausalGraph(sources, { groupId: sources[0]?.groupId });
  if (!graph.ok) return sources;
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const byId = new Map(sources.map((record) => [record.id, record]));
  const rejected = new Set();
  for (const checkpoint of sources.filter((record) => record.recordType === "frontier-checkpoint")) {
    const closure = new Set();
    const stack = [checkpoint.id];
    let complete = true;
    while (stack.length) {
      const id = stack.pop();
      if (closure.has(id)) continue;
      const node = nodes.get(id);
      if (!node || node.status !== "valid" || !byId.has(id)) { complete = false; break; }
      closure.add(id);
      stack.push(...node.parents);
    }
    if (!complete) { rejected.add(checkpoint.id); continue; }
    try {
      await createVerifiedCausalContext({ causalRecords: [...closure].map((id) => byId.get(id)),
        membershipRecords, trustPin, authorizationContexts: contexts, allowReadOnlyKnownState: true });
    } catch { rejected.add(checkpoint.id); }
  }
  return sources.filter((record) => !rejected.has(record.id));
}

async function authenticatedCausalSources(rawRecords, membershipRecords, trustPin, contexts, groupId) {
  const verified = new Map();
  const unsupportedIds = new Set();
  const membershipIds = new Set(membershipRecords.map((record) => record?.id).filter((id) => typeof id === "string"));
  const views = new Map();
  const membership = await projectSignedMembership(membershipRecords, { trustPin, verifiedCausalContexts: contexts });
  if (membership.groupId === groupId) {
    for (const checkpoint of membership.causalCheckpointCandidates || []) verified.set(stableJson(checkpoint), checkpoint);
  }
  for (const raw of rawRecords) {
    const parsed = parseSignedLedgerRecord(raw);
    // Unknown future record semantics cannot provide causal ancestry.
    const unsupported = !parsed.ok && ["unsupported-version", "unsupported-event-type"].includes(parsed.reason) && parsed.record;
    if ((!parsed.ok && !unsupported) || (unsupported && !validUnsupportedEnvelope(parsed.record))) continue;
    if (parsed.record.groupId !== groupId || !parsed.record.membershipHeads.every((head) => membershipIds.has(head))) continue;
    const record = parsed.record;
    const headsKey = JSON.stringify(record.membershipHeads);
    if (!views.has(headsKey)) {
      views.set(headsKey, await projectSignedMembership(membershipRecords, { trustPin, atHeads: record.membershipHeads,
        verifiedCausalContexts: contexts }));
    }
    const membership = views.get(headsKey);
    // A later unsupported barrier can make the current roster read-only without
    // invalidating signatures anchored to an earlier, fully verified frontier.
    if (membership.groupId !== groupId) continue;
    const participantExists = membership.participants.some((participant) => participant.id === record.author.participantId);
    const device = membership.devices.find((item) => item.participantId === record.author.participantId
      && item.deviceId === record.author.deviceId && item.keyId === record.author.keyId);
    const bytes = device && decodePublicKey(device.publicKey);
    if (!participantExists || !bytes) continue;
    try {
      const publicKey = await crypto.subtle.importKey("raw", bytes, { name: "Ed25519" }, false, ["verify"]);
      if (await verifyRecord(record, publicKey)) {
        if (unsupported) unsupportedIds.add(record.id);
        else verified.set(stableJson(record), record);
      }
    } catch { /* failed crypto operations cannot contribute causal proof */ }
  }
  let sources = [...verified.values()].filter((record) => !unsupportedIds.has(record.id));
  sources = await removeUnverifiedCheckpointInputs(sources, membershipRecords, trustPin, contexts);
  const graph = analyzeCausalGraph(sources, { groupId });
  if (graph.ok && sources.some((record) => record.recordType === "frontier-checkpoint")) {
    sources = sources.filter((record) => record.recordType !== "frontier-checkpoint"
      || checkpointObservedAtAllRemovalFrontiers(record, graph, membership));
  }
  return sources;
}

async function deriveCausalContexts(rawRecords, membershipRecords, trustPin, groupId) {
  let contexts = [];
  let previousSourceSet = null;
  const observedSourceSets = new Set();
  for (let round = 0; round < MAX_CAUSAL_CONTEXT_ROUNDS; round += 1) {
    const sources = await authenticatedCausalSources(rawRecords, membershipRecords, trustPin, contexts, groupId);
    const graph = analyzeCausalGraph(sources, { groupId });
    if (!graph.ok) break;
    const validIds = new Set(graph.nodes.filter((node) => node.status === "valid").map((node) => node.id));
    const graphNodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const validSources = sources.filter((record) => validIds.has(record.id));
    const sourceSet = validSources.map(stableJson).sort().join("\n");
    if (sourceSet === previousSourceSet) return contexts;
    if (observedSourceSets.has(sourceSet)) return [];
    observedSourceSets.add(sourceSet);
    previousSourceSet = sourceSet;

    // A removal proves only the ancestry named by its own frontier. Unrelated valid
    // ledger heads must not turn an otherwise bounded proof into a group lockout.
    const rebuilt = [];
    for (const removal of membershipRecords.filter((record) =>
      ["device-revoked", "participant-removed"].includes(record?.recordType) && record.groupId === groupId)) {
      const frontier = removal.causalHeads;
      if (!validUuidList(frontier, { minimum: 1 }) || frontier.some((head) => !validIds.has(head))) continue;
      const closure = new Set();
      const stack = [...frontier];
      let complete = true;
      while (stack.length) {
        const id = stack.pop();
        if (closure.has(id)) continue;
        if (!validIds.has(id)) { complete = false; break; }
        closure.add(id);
        const node = graphNodes.get(id);
        if (!node) { complete = false; break; }
        stack.push(...node.parents);
      }
      if (!complete) continue;
      const causalRecords = validSources.filter((record) => closure.has(record.id));
      try {
        const context = await createVerifiedCausalContext({ causalRecords,
          membershipRecords: membershipRecords.filter((item) => item?.id !== removal.id), trustPin,
          authorizationContexts: contexts, allowReadOnlyKnownState: true });
        rebuilt.push(context);
      } catch { /* incomplete or circular authorization remains unproven */ }
    }
    contexts = rebuilt;
  }
  return [];
}

/** Project signed v2 ledger records against concrete membership state at each record's heads. */
export async function projectAuthenticatedLedger(rawRecords, { membershipRecords, trustPin } = {}) {
  if (!Array.isArray(rawRecords) || !Array.isArray(membershipRecords) || !trustPin) {
    return emptyProjection(Array.isArray(rawRecords) ? rawRecords : [], [diagnostic(null, "invalid-authenticated-ledger-input")]);
  }
  if (ledgerInputTooLarge(rawRecords)) return emptyProjection(rawRecords, [diagnostic("ledger", "ledger-too-large")]);

  try {
    rawRecords = structuredClone(rawRecords);
    membershipRecords = structuredClone(membershipRecords);
    trustPin = structuredClone(trustPin);
  } catch {
    return emptyProjection(rawRecords, [diagnostic(null, "uncloneable-authenticated-ledger-input")]);
  }

  let currentMembership;
  let verifiedCausalContexts;
  try {
    const initialMembership = await projectSignedMembership(membershipRecords, { trustPin });
    if (!initialMembership.groupId || !initialMembership.currency) {
      return {
        ...emptyProjection(rawRecords, [diagnostic(null, "untrusted-membership")]),
        membershipDiagnostics: sortedDiagnostics([...initialMembership.diagnostics]),
        readOnly: true
      };
    }
    verifiedCausalContexts = await deriveCausalContexts(rawRecords, membershipRecords, trustPin, initialMembership.groupId);
    currentMembership = await projectSignedMembership(membershipRecords, { trustPin, verifiedCausalContexts });
  } catch {
    return emptyProjection(rawRecords, [diagnostic(null, "membership-crypto-unavailable")]);
  }
  if (!currentMembership.groupId || !currentMembership.currency) {
    return {
      ...emptyProjection(rawRecords, [diagnostic(null, "untrusted-membership")]),
      membershipDiagnostics: sortedDiagnostics([...currentMembership.diagnostics]),
      readOnly: true
    };
  }

  const groupId = currentMembership.groupId;
  const currency = currentMembership.currency;
  const membershipRecordIds = new Set(membershipRecords.map((record) => record?.id).filter((id) => typeof id === "string"));
  const unprovenRemovalRecords = membershipRecords.filter((record) =>
    ["device-revoked", "participant-removed"].includes(record?.recordType)
    && currentMembership.diagnostics.some((item) => item.recordId === record.id && item.status === "pending"
      && item.reason === "causal-frontier-unverified"));
  const membershipsAtHeads = new Map();
  const authorizedById = new Map();
  const causalVariants = new Map();
  const causalPoisonIds = new Set();
  const membershipDiagnosticsByKey = new Map();
  const pending = [];
  const quarantined = [];
  const unsupported = [];
  let membershipReadOnly = currentMembership.readOnly === true;
  let ledgerReadOnly = false;
  const addMembershipDiagnostics = (projection) => {
    for (const item of projection.diagnostics || []) {
      let key;
      try { key = stableJson(item); } catch { key = `${item.reason}:${item.recordId || ""}`; }
      membershipDiagnosticsByKey.set(key, item);
    }
  };
  addMembershipDiagnostics(currentMembership);

  const getMembershipAt = async (heads) => {
    const key = JSON.stringify(heads);
    if (!membershipsAtHeads.has(key)) {
      membershipsAtHeads.set(key, await projectSignedMembership(membershipRecords, { trustPin, atHeads: heads, verifiedCausalContexts }));
    }
    return membershipsAtHeads.get(key);
  };

  for (const raw of rawRecords) {
    const parsed = parseSignedLedgerRecord(raw);
    const isUnsupported = !parsed.ok && ["unsupported-version", "unsupported-event-type"].includes(parsed.reason) && parsed.record;
    if (!parsed.ok && !isUnsupported) {
      quarantined.push(diagnostic(parsed.record?.id, parsed.reason, cloneRaw(raw)));
      continue;
    }

    const record = parsed.ok ? parsed.record : parsed.record;
    const event = parsed.ok ? parsed.event : null;
    if (isUnsupported && !validUnsupportedEnvelope(record)) {
      quarantined.push(diagnostic(record.id, "invalid-envelope", cloneRaw(raw)));
      continue;
    }
    if (record.groupId !== groupId) {
      quarantined.push(diagnostic(record.id, "group-mismatch", cloneRaw(raw)));
      continue;
    }
    if (!record.membershipHeads.every((head) => membershipRecordIds.has(head))) {
      pending.push(diagnostic(record.id, "missing-membership-head", cloneRaw(raw)));
      continue;
    }

    let atHeads;
    try {
      atHeads = await getMembershipAt(record.membershipHeads);
    } catch {
      quarantined.push(diagnostic(record.id, "membership-projection-failed", cloneRaw(raw)));
      membershipReadOnly = true;
      continue;
    }
    addMembershipDiagnostics(atHeads);
    if (!atHeads.groupId) {
      const membershipError = atHeads.diagnostics?.find((item) => item.reason === "missing-membership-head");
      if (membershipError) pending.push(diagnostic(record.id, "missing-membership-head", cloneRaw(raw)));
      else if (atHeads.diagnostics?.some((item) => item.status === "unsupported")) {
        pending.push(diagnostic(record.id, "unsupported-membership-head", cloneRaw(raw)));
      } else {
        const ancestryError = atHeads.diagnostics?.find((item) => item.reason === "invalid-membership-ancestor"
          || item.reason === "membership-head-not-effective" || item.reason === "membership-cycle"
          || item.reason === "cross-group-reference" || item.reason === "invalid-membership-head-type");
        quarantined.push(diagnostic(record.id, ancestryError ? "invalid-membership-heads" : "unauthenticated-membership-heads", cloneRaw(raw)));
      }
      continue;
    }
    if (atHeads.groupId !== groupId || record.groupId !== atHeads.groupId) {
      quarantined.push(diagnostic(record.id, "group-mismatch", cloneRaw(raw)));
      continue;
    }

    const participantExists = atHeads.participants.some((participant) => participant.id === record.author.participantId);
    const device = atHeads.devices.find((candidate) => candidate.participantId === record.author.participantId
      && candidate.deviceId === record.author.deviceId && candidate.keyId === record.author.keyId);
    if (!participantExists || !device) {
      const proofOnly = atHeads.requests?.some((request) => request.participantId === record.author.participantId
        && request.deviceId === record.author.deviceId && request.keyId === record.author.keyId);
      quarantined.push(diagnostic(record.id, proofOnly ? "proof-only-device" : "unknown-device-at-membership-heads", cloneRaw(raw)));
      continue;
    }

    const publicKeyBytes = decodePublicKey(device.publicKey);
    if (!publicKeyBytes) {
      quarantined.push(diagnostic(record.id, "invalid-enrolled-public-key", cloneRaw(raw)));
      continue;
    }

    let signatureValid = false;
    try {
      const publicKey = await crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
      signatureValid = await verifyRecord(record, publicKey);
    } catch {
      quarantined.push(diagnostic(record.id, "ledger-crypto-unavailable", cloneRaw(raw)));
      ledgerReadOnly = true;
      continue;
    }
    if (!signatureValid) {
      quarantined.push(diagnostic(record.id, "invalid-signature", cloneRaw(raw)));
      continue;
    }

    if (!isUnsupported) {
      const causalKey = stableJson(record);
      const causalEntries = causalVariants.get(record.id) || new Map();
      causalEntries.set(causalKey, record);
      causalVariants.set(record.id, causalEntries);
    }

    if (isUnsupported) {
      causalPoisonIds.add(record.id);
      ledgerReadOnly = true;
      unsupported.push(diagnostic(record.id, parsed.reason, cloneRaw(raw)));
      const key = stableJson(record);
      const variants = authorizedById.get(record.id) || new Map();
      variants.set(key, { record, event: null, raw: cloneRaw(raw), unsupported: true });
      authorizedById.set(record.id, variants);
      continue;
    }

    if (event.groupId !== atHeads.groupId) {
      quarantined.push(diagnostic(record.id, "group-mismatch", cloneRaw(raw)));
      continue;
    }
    if (["expense-created", "expense-revised", "settlement-recorded", "opening-balances-imported"].includes(event.type)
        && event.payload.currency !== atHeads.currency) {
      quarantined.push(diagnostic(record.id, "currency-mismatch", cloneRaw(raw)));
      continue;
    }
    const participantIds = eventParticipantIds(event);
    if (participantIds.some((id) => !atHeads.participants.some((participant) => participant.id === id))) {
      quarantined.push(diagnostic(record.id, "unknown-participant-reference", cloneRaw(raw)));
      continue;
    }

    const removalProofPending = unprovenRemovalRecords.some((removal) => removal.recordType === "participant-removed"
      ? removal.payload?.participantId === record.author.participantId
      : removal.payload?.participantId === record.author.participantId && removal.payload?.deviceId === record.author.deviceId);
    if (removalProofPending) {
      pending.push(diagnostic(record.id, "removal-frontier-unverified", cloneRaw(raw)));
      continue;
    }

    const key = stableJson(record);
    const variants = authorizedById.get(record.id) || new Map();
    variants.set(key, { record, event, raw: cloneRaw(raw), unsupported: false });
    authorizedById.set(record.id, variants);
  }

  const eventMap = new Map();
  const allowedViews = new Set();
  let causalRecords = [...causalVariants.values()].flatMap((variants) => [...variants.values()])
    .concat(currentMembership.causalCheckpointCandidates || []).filter((record) => !causalPoisonIds.has(record.id));
  causalRecords = await removeUnverifiedCheckpointInputs(causalRecords, membershipRecords, trustPin, verifiedCausalContexts);
  const allCausalGraph = analyzeCausalGraph(causalRecords, { groupId });
  if (allCausalGraph.ok && causalRecords.some((record) => record.recordType === "frontier-checkpoint")) {
    causalRecords = causalRecords.filter((record) => record.recordType !== "frontier-checkpoint"
      || checkpointObservedAtAllRemovalFrontiers(record, allCausalGraph, currentMembership));
  }
  const causalGraph = analyzeCausalGraph(causalRecords, { groupId });
  const causalNodes = new Map(causalGraph.ok ? causalGraph.nodes.map((node) => [node.id, node]) : []);
  const activeTombstones = [
    ...(currentMembership.tombstones?.devices || []).map((item) => ({ ...item, recordType: "device-revoked" })),
    ...(currentMembership.tombstones?.participants || []).map((item) => ({ ...item, recordType: "participant-removed" }))
  ];
  for (const [id, variants] of authorizedById) {
    if (variants.size > 1) {
      for (const variant of variants.values()) quarantined.push(diagnostic(id, "id-content-collision", variant.raw));
      continue;
    }
    const variant = variants.values().next().value;
    if (variant.unsupported) continue;
    const node = causalNodes.get(id);
    if (!causalGraph.ok || !node || node.status === "invalid") {
      const reason = !causalGraph.ok ? causalGraph.reason : node?.reason || (node?.status === "pending" ? "missing-causal-parent" : "invalid-causal-ancestry");
      quarantined.push(diagnostic(id, reason, variant.raw));
      continue;
    }
    if (node.status === "pending" && variant.record.causalHeads.some((head) => causalNodes.get(head)?.status !== "valid")) {
      pending.push(diagnostic(id, "missing-causal-parent", variant.raw));
      continue;
    }
    let cutoffPending = false;
    let cutoffRejected = false;
    for (const tombstone of activeTombstones) {
      const applies = tombstone.recordType === "participant-removed"
        ? tombstone.participantId === variant.record.author.participantId
        : tombstone.participantId === variant.record.author.participantId
          && tombstone.deviceId === variant.record.author.deviceId;
      if (!applies) continue;
      if (node.status !== "valid") {
        cutoffPending = true;
        break;
      }
      const frontier = tombstone.causalHeads || [];
      const frontierNodes = frontier.map((head) => causalNodes.get(head));
      if (frontierNodes.some((headNode) => !headNode || headNode.status !== "valid")) {
        cutoffPending = true;
        break;
      }
      const observed = frontier.some((head) => causalReachability(causalGraph, head, id).reachable === true);
      if (!observed) { cutoffRejected = true; break; }
    }
    if (cutoffPending) {
      pending.push(diagnostic(id, "causal-removal-ancestry-pending", variant.raw));
      continue;
    }
    if (cutoffRejected) {
      quarantined.push(diagnostic(id, "author-revoked-at-causal-frontier", variant.raw));
      continue;
    }
    eventMap.set(id, variant.event);
    allowedViews.add(stableJson(variant.event));
  }

  const ledger = ledgerContext(eventMap, groupId, currency, allowedViews);
  const validCausalIds = causalGraph.ok ? causalGraph.nodes.filter((node) => node.status === "valid").map((node) => node.id) : [];
  const causalFrontierResult = causalGraph.ok
    ? maximalCausalFrontier(causalGraph, validCausalIds)
    : { ok: false, reason: causalGraph.reason };
  return {
    ...ledger,
    pending: sortedDiagnostics([...ledger.pending, ...pending]),
    quarantined: sortedDiagnostics([...ledger.quarantined, ...quarantined]),
    unsupported: sortedDiagnostics([...ledger.unsupported, ...unsupported]),
    readOnly: ledger.readOnly || membershipReadOnly || ledgerReadOnly,
    groupId,
    currency,
    causalFrontier: causalFrontierResult.ok
      ? { ok: true, heads: [...causalFrontierResult.heads] }
      : { ...causalFrontierResult, ok: false },
    verifiedCausalContexts,
    rawRecords: rawRecords.map(cloneRaw),
    membershipDiagnostics: sortedDiagnostics([...membershipDiagnosticsByKey.values()])
  };
}
