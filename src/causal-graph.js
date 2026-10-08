import { canonicalJsonBytes } from "./identity-crypto.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MAX_RECORDS = 10_000;
const MAX_GRAPH_BYTES = 16 * 1024 * 1024;
const MAX_FRONTIER = 64;

const isUuid = (value) => typeof value === "string" && UUID.test(value);
const isSortedUniqueIds = (values) => Array.isArray(values)
  && values.every((value, index) => isUuid(value) && (!index || values[index - 1] < value));

function stableRecord(record) {
  try { return new TextDecoder().decode(canonicalJsonBytes(record)); }
  catch { return null; }
}

function diagnostic(id, status, reason) {
  return { recordId: id, status, reason };
}

/** Analyze explicit causalHeads and dependsOn edges on caller-verified records. */
export function analyzeCausalGraph(records, { groupId } = {}) {
  if (!isUuid(groupId)) return { ok: false, reason: "invalid-group-id" };
  if (!Array.isArray(records)) return { ok: false, reason: "invalid-record-list" };
  if (records.length > MAX_RECORDS) return { ok: false, reason: "causal-graph-too-large" };

  const variants = new Map();
  const invalidInputs = [];
  let totalBytes = 0;
  for (const source of records) {
    const encoded = stableRecord(source);
    if (encoded === null) { invalidInputs.push(diagnostic(null, "quarantined", "invalid-causal-record")); continue; }
    totalBytes += new TextEncoder().encode(encoded).byteLength;
    if (totalBytes > MAX_GRAPH_BYTES) return { ok: false, reason: "causal-graph-too-large" };
    let sourceId;
    try { sourceId = source?.id; } catch { sourceId = undefined; }
    if (!source || typeof source !== "object" || !isUuid(sourceId)) {
      invalidInputs.push(diagnostic(typeof sourceId === "string" ? sourceId : null, "quarantined", "invalid-causal-record"));
      continue;
    }
    const entries = variants.get(sourceId) || (variants.set(sourceId, new Map()).get(sourceId));
    if (!entries.has(encoded)) entries.set(encoded, source);
  }

  const collisions = new Set([...variants].filter(([, entries]) => entries.size > 1).map(([id]) => id));
  const recordsById = new Map();
  for (const [id, entries] of variants) if (entries.size === 1) recordsById.set(id, entries.values().next().value);
  const status = new Map();
  const reasons = new Map();

  function isAncestor(descendantId, ancestorId) {
    if (descendantId === ancestorId) return true;
    const seen = new Set();
    const stack = [...(recordsById.get(descendantId)?.causalHeads || []), ...(recordsById.get(descendantId)?.dependsOn || [])];
    while (stack.length) {
      const current = stack.pop();
      if (current === ancestorId) return true;
      if (seen.has(current)) continue;
      seen.add(current);
      const parent = recordsById.get(current);
      if (parent) stack.push(...(parent.causalHeads || []), ...(parent.dependsOn || []));
    }
    return false;
  }

  function resolve(rootId) {
    if (status.has(rootId)) return;
    const stack = [];
    const pathIndex = new Map();
    function push(id) {
      if (status.has(id)) return;
      const record = recordsById.get(id);
      if (!record) return;
      let failure = null;
      if (record.groupId !== groupId) failure = "cross-group-record";
      else if (!Array.isArray(record.causalHeads) || !Array.isArray(record.dependsOn)
          || !isSortedUniqueIds(record.causalHeads) || record.causalHeads.length > MAX_FRONTIER
          || !isSortedUniqueIds(record.dependsOn) || record.dependsOn.length > 256) failure = "invalid-causal-edges";
      else if ([...record.causalHeads, ...record.dependsOn].includes(id)) failure = "causal-cycle";
      if (failure) {
        status.set(id, "invalid"); reasons.set(id, failure); return;
      }
      stack.push({ id, record, parents: [...new Set([...record.causalHeads, ...record.dependsOn])].sort(), index: 0, failure: null });
      pathIndex.set(id, stack.length - 1);
    }
    push(rootId);
    while (stack.length) {
      const frame = stack.at(-1);
      if (status.has(frame.id)) {
        stack.pop(); pathIndex.delete(frame.id); continue;
      }
      if (frame.index < frame.parents.length && !frame.failure) {
        const parentId = frame.parents[frame.index];
        if (!recordsById.has(parentId) && !collisions.has(parentId)) { frame.failure = "missing-causal-parent"; frame.index += 1; }
        else if (collisions.has(parentId)) { frame.failure = "causal-parent-id-collision"; frame.index += 1; }
        else if (recordsById.get(parentId).groupId !== groupId) { frame.failure = "cross-group-ancestry"; frame.index += 1; }
        else if (pathIndex.has(parentId)) {
          frame.index += 1;
          for (const cycleFrame of stack.slice(pathIndex.get(parentId))) {
            status.set(cycleFrame.id, "invalid"); reasons.set(cycleFrame.id, "causal-cycle");
          }
        } else if (status.has(parentId)) {
          frame.index += 1;
          if (status.get(parentId) !== "valid") frame.failure = status.get(parentId) === "pending"
            ? "missing-causal-parent" : "invalid-causal-ancestry";
        } else push(parentId);
        continue;
      }
      if (!status.has(frame.id) && !frame.failure) {
        for (let i = 0; i < frame.record.causalHeads.length && !frame.failure; i += 1) {
          for (let j = i + 1; j < frame.record.causalHeads.length; j += 1) {
            if (isAncestor(frame.record.causalHeads[i], frame.record.causalHeads[j])
                || isAncestor(frame.record.causalHeads[j], frame.record.causalHeads[i])) {
              frame.failure = "redundant-causal-heads"; break;
            }
          }
        }
      }
      if (!status.has(frame.id)) {
        const reason = frame.failure;
        status.set(frame.id, reason ? (reason === "missing-causal-parent" ? "pending" : "invalid") : "valid");
        if (reason) reasons.set(frame.id, reason);
      }
      stack.pop(); pathIndex.delete(frame.id);
    }
  }

  for (const id of collisions) { status.set(id, "invalid"); reasons.set(id, "causal-id-collision"); }
  for (const id of recordsById.keys()) resolve(id);
  const diagnostics = [...invalidInputs];
  for (const [id, entries] of variants) {
    if (collisions.has(id)) diagnostics.push(diagnostic(id, "quarantined", "causal-id-collision"));
    else if (!recordsById.has(id)) diagnostics.push(diagnostic(id, "quarantined", "invalid-record-id"));
    else if (reasons.has(id)) diagnostics.push(diagnostic(id, status.get(id), reasons.get(id)));
    else diagnostics.push(diagnostic(id, "valid", "causal-record"));
  }
  diagnostics.sort((a, b) => (a.recordId || "").localeCompare(b.recordId || "") || a.reason.localeCompare(b.reason));
  const nodes = [...recordsById].map(([id, record]) => ({ id, groupId: record.groupId,
    parents: [...new Set([...(Array.isArray(record.causalHeads) ? record.causalHeads : []),
      ...(Array.isArray(record.dependsOn) ? record.dependsOn : [])])].sort(),
    status: status.get(id) || "invalid", reason: reasons.get(id) || null }))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const id of collisions) nodes.push({ id, groupId, parents: [], status: "invalid", reason: "causal-id-collision" });
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  return { ok: true, groupId, nodes, diagnostics };
}

/** Check causal reachability; both edge kinds count, membershipHeads never do. */
export function causalReachability(graph, descendantId, ancestorId) {
  if (!graph?.ok || !isUuid(descendantId) || !isUuid(ancestorId)) return { ok: false, reason: "invalid-causal-query" };
  const node = graph.nodes.find((item) => item.id === descendantId);
  if (!node) return { ok: false, reason: "missing-causal-record" };
  if (node.status !== "valid") return { ok: false, reason: node.reason || "invalid-causal-record" };
  if (!graph.nodes.some((item) => item.id === ancestorId)) return { ok: false, reason: "missing-causal-record" };
  const nodes = new Map(graph.nodes.map((item) => [item.id, item]));
  const seen = new Set();
  const stack = [...node.parents];
  while (stack.length) {
    const current = stack.pop();
    if (current === ancestorId) return { ok: true, reachable: true };
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(nodes.get(current)?.parents || []));
  }
  return { ok: true, reachable: descendantId === ancestorId };
}

/** Validate a sorted, unique, bounded antichain of known causal record IDs. */
export function validateCausalFrontier(graph, headIds) {
  if (!graph?.ok) return { ok: false, reason: "invalid-causal-graph" };
  if (!isSortedUniqueIds(headIds)) return { ok: false, reason: "invalid-causal-frontier" };
  if (headIds.length > MAX_FRONTIER) return { ok: false, reason: "causal-frontier-too-large" };
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const id of headIds) {
    const node = nodeById.get(id);
    if (!node) return { ok: false, reason: "missing-causal-head", recordId: id };
    if (node.status !== "valid") return { ok: false, reason: node.reason || "invalid-causal-head", recordId: id };
  }
  for (let i = 0; i < headIds.length; i += 1) {
    for (let j = i + 1; j < headIds.length; j += 1) {
      if (causalReachability(graph, headIds[i], headIds[j]).reachable || causalReachability(graph, headIds[j], headIds[i]).reachable) {
        return { ok: false, reason: "redundant-causal-heads", recordIds: [headIds[i], headIds[j]] };
      }
    }
  }
  return { ok: true, heads: [...headIds] };
}

/** Compute the maximal records in a caller-specified observed set. */
export function maximalCausalFrontier(graph, observedIds) {
  if (!graph?.ok) return { ok: false, reason: "invalid-causal-graph" };
  if (!Array.isArray(observedIds) || observedIds.some((id) => !isUuid(id))) return { ok: false, reason: "invalid-causal-frontier" };
  const ids = [...new Set(observedIds)].sort();
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const id of ids) {
    const node = nodeById.get(id);
    if (!node) return { ok: false, reason: "missing-causal-head", recordId: id };
    if (node.status !== "valid") return { ok: false, reason: node.reason || "invalid-causal-head", recordId: id };
  }
  const observed = new Set(ids);
  const nonMaximal = new Set();
  const visited = new Set();
  const stack = ids.flatMap((id) => nodeById.get(id).parents);
  while (stack.length) {
    const parentId = stack.pop();
    if (observed.has(parentId)) nonMaximal.add(parentId);
    if (visited.has(parentId)) continue;
    visited.add(parentId);
    stack.push(...(nodeById.get(parentId)?.parents || []));
  }
  const heads = ids.filter((id) => !nonMaximal.has(id));
  if (heads.length > MAX_FRONTIER) return { ok: false, reason: "causal-frontier-too-large", heads };
  return validateCausalFrontier(graph, heads);
}

/** Plan lossless, unsigned checkpoint inputs; a later signer integration creates these records. */
export function planCausalCheckpoints(headIds, checkpointIds) {
  if (!Array.isArray(headIds) || headIds.length > MAX_RECORDS || headIds.some((id) => !isUuid(id))) {
    return { ok: false, reason: "invalid-causal-frontier" };
  }
  if (!Array.isArray(checkpointIds)) return { ok: false, reason: "invalid-checkpoint-ids" };
  const heads = [...new Set(headIds)].sort();
  if (heads.length <= MAX_FRONTIER) {
    return checkpointIds.length ? { ok: false, reason: "unexpected-checkpoint-ids" } : { ok: true, steps: [], frontier: heads };
  }
  const required = 1 + Math.ceil((heads.length - MAX_FRONTIER) / (MAX_FRONTIER - 1));
  if (checkpointIds.length !== required || checkpointIds.some((id) => !isUuid(id))
      || new Set(checkpointIds).size !== checkpointIds.length || checkpointIds.some((id) => heads.includes(id))) {
    return { ok: false, reason: "invalid-checkpoint-ids" };
  }
  const steps = [];
  let offset = 0;
  for (let i = 0; i < checkpointIds.length; i += 1) {
    const room = i === 0 ? MAX_FRONTIER : MAX_FRONTIER - 1;
    const inputs = i === 0 ? heads.slice(0, room) : [checkpointIds[i - 1], ...heads.slice(offset, offset + room)];
    offset += i === 0 ? room : room;
    steps.push({ id: checkpointIds[i], causalHeads: inputs.sort(), dependsOn: [] });
  }
  return { ok: true, steps, frontier: [checkpointIds.at(-1)] };
}
