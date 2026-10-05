import { normalizeExpenseForProjection } from "./prototype-events.js";
import { parseEvent } from "./events.js";

const referenceFields = ["supersedesEventId", "reversesEventId", "chosenEventId"];
const referenceArrays = ["resolvesEventIds", "supersedesResolutionEventIds"];

function references(event) {
  const payload = event?.payload || {};
  return [...new Set([
    ...(Array.isArray(event?.dependsOn) ? event.dependsOn : []),
    ...referenceFields.flatMap((field) => typeof payload[field] === "string" ? [payload[field]] : []),
    ...referenceArrays.flatMap((field) => Array.isArray(payload[field]) ? payload[field].filter((id) => typeof id === "string") : [])
  ])].sort();
}

function diagnosticMap(projection) {
  const byId = new Map();
  const add = (id, status, reason) => {
    if (typeof id !== "string") return;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push({ status, reason });
  };
  for (const { id, reason } of projection.effective) add(id, "Effective", reason);
  for (const { event, reason } of projection.pending) add(event?.id, "Pending", reason);
  for (const { id, reason } of projection.conflicting) add(id, "Conflicting", reason);
  for (const { id, reason } of projection.quarantined) add(id, "Quarantined", reason);
  for (const { id, reason } of projection.unsupported) add(id, "Unsupported", reason);
  for (const { id, reason } of projection.ignored) add(id, "Ignored", reason);
  for (const { id, reason, count } of projection.duplicates) add(id, "Duplicate", reason || `duplicate-count-${count}`);
  return byId;
}

export function auditEntries(group, projection, filter = null) {
  const diagnostics = diagnosticMap(projection);
  const missingDependencies = new Map(projection.pending.map(({ event, missingDependencyIds }) => [event.id, missingDependencyIds]));
  const effectiveIds = new Set(projection.effective.map(({ id }) => id));
  const reversedSettlementEventIds = new Set(projection.effective
    .filter(({ type }) => type === "settlement-reversed")
    .map(({ payload }) => payload.reversesEventId));
  const supersededIds = new Map();
  const childrenByParent = new Map();
  const rows = (group.events ?? []).map((raw, index) => {
    const event = normalizeExpenseForProjection(raw, group);
    const id = typeof event?.id === "string" ? event.id : `legacy-missing-id-${index}`;
    const parsed = parseEvent(event);
    const normalized = parsed.ok ? parsed.event : parsed.event || null;
    const refs = references(normalized || event);
    if (typeof normalized?.payload?.supersedesEventId === "string") {
      const parentId = normalized.payload.supersedesEventId;
      if (!childrenByParent.has(parentId)) childrenByParent.set(parentId, []);
      childrenByParent.get(parentId).push(id);
    }
    return { id, raw, event: normalized, refs, index, parseReason: parsed.ok ? null : parsed.reason };
  });

  const rowsById = new Map(rows.map((row) => [row.id, row]));
  const blockedIds = new Set([
    ...projection.pending.map(({ event }) => event?.id),
    ...projection.quarantined.map(({ id }) => id),
    ...projection.conflicting.map(({ id }) => id),
    ...projection.unsupported.map(({ id }) => id),
    ...projection.ignored.map(({ id }) => id)
  ]);
  const addSuperseded = (id, byId) => {
    if (!supersededIds.has(id)) supersededIds.set(id, []);
    supersededIds.get(id).push(byId);
  };
  for (const effective of projection.effective) {
    if (effective.type === "conflict-resolved") {
      for (const id of effective.payload.supersedesResolutionEventIds) addSuperseded(id, effective.id);
    }
    let parentId = effective.payload?.supersedesEventId;
    const seen = new Set();
    while (typeof parentId === "string" && !seen.has(parentId) && !blockedIds.has(parentId)) {
      seen.add(parentId);
      const parent = rowsById.get(parentId);
      if (!parent?.event) break;
      addSuperseded(parentId, effective.id);
      parentId = parent.event.payload?.supersedesEventId;
    }
  }

  const rejectedIds = new Set();
  const rejectedRoots = projection.effective.filter((event) => event.type === "conflict-resolved")
    .flatMap(({ payload }) => payload.resolvesEventIds.filter((id) => id !== payload.chosenEventId));
  for (let index = 0; index < rejectedRoots.length; index++) {
    const id = rejectedRoots[index];
    if (rejectedIds.has(id)) continue;
    rejectedIds.add(id);
    rejectedRoots.push(...(childrenByParent.get(id) || []));
  }

  const result = rows.map((row) => {
    const issues = diagnostics.get(row.id) || [];
    const issueStatus = (name) => issues.some(({ status }) => status === name);
    const idCollision = issues.some(({ reason }) => reason === "id-content-collision");
    let status = row.parseReason === "unsupported-version" || row.parseReason === "unsupported-event-type" ? "Unsupported" : "Stored only";
    if ((row.parseReason && status !== "Unsupported") || idCollision) status = "Quarantined";
    else if (issueStatus("Pending")) status = "Pending";
    else if (issueStatus("Conflicting")) status = "Conflicting";
    else if (issueStatus("Quarantined")) status = "Quarantined";
    else if (issueStatus("Unsupported")) status = "Unsupported";
    else if (issueStatus("Ignored")) status = "Ignored";
    else if (row.event?.type === "settlement-recorded" && reversedSettlementEventIds.has(row.id)) status = "Reversed";
    else if (row.event?.type === "expense-voided" && effectiveIds.has(row.id)) status = "Effective void";
    else if (row.event?.type === "settlement-reversed" && effectiveIds.has(row.id)) status = "Effective reversal";
    else if (row.event?.type === "conflict-resolved" && effectiveIds.has(row.id)) status = "Effective resolution";
    else if (rejectedIds.has(row.id)) status = "Rejected branch";
    else if (issueStatus("Effective")) status = "Effective";
    else if (supersededIds.has(row.id)) status = "Superseded";
    return { ...row, status, reasons: [...new Set([row.parseReason, ...issues.map(({ reason }) => reason)].filter(Boolean))],
      missingDependencies: missingDependencies.get(row.id) || [] };
  });

  const rowIds = new Set(result.map(({ id }) => id));
  for (const [id, issues] of diagnostics) {
    if (!rowIds.has(id)) result.push({ id, raw: null, event: null, refs: [], status: issues[0]?.status || "Diagnostic", reasons: issues.map(({ reason }) => reason).filter(Boolean), missingDependencies: [], index: Number.MAX_SAFE_INTEGER });
  }

  if (filter) {
    const included = new Set();
    for (const row of result) {
      if ((filter.eventId && row.id === filter.eventId)
        || (filter.expenseId && (row.event?.payload?.expenseId === filter.expenseId || row.raw?.payload?.expenseId === filter.expenseId))
        || (filter.settlementId && (row.event?.payload?.settlementId === filter.settlementId || row.raw?.payload?.settlementId === filter.settlementId))) included.add(row.id);
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of result) {
        if (included.has(row.id) || !row.refs.some((id) => included.has(id))) continue;
        included.add(row.id);
        changed = true;
      }
    }
    return result.filter((row) => included.has(row.id));
  }

  return result.sort((left, right) => {
    const a = left.event?.createdAt || "";
    const b = right.event?.createdAt || "";
    return b.localeCompare(a) || left.id.localeCompare(right.id) || left.index - right.index;
  });
}

export function auditSummary(event, personName, money) {
  if (!event || typeof event !== "object") return "Malformed stored event";
  const payload = event.payload || {};
  if (event.type === "expense-created" || event.type === "expense-revised") {
    return `${payload.description || "Expense"} · ${money(payload.amount, payload.currency)} paid by ${personName(payload.payerId)}`;
  }
  if (event.type === "expense-voided") return `Void reason: ${payload.reason || "missing"}`;
  if (event.type === "settlement-recorded") {
    return `${personName(payload.fromParticipantId)} paid ${personName(payload.toParticipantId)} · ${money(payload.amount, payload.currency)}`;
  }
  if (event.type === "settlement-reversed") return `Settlement reversal · ${payload.reason || "missing reason"}`;
  if (event.type === "conflict-resolved") return `Selected branch ${payload.chosenEventId || "unknown"} from ${payload.resolvesEventIds?.length || 0} competing changes`;
  return event.type || "Malformed stored event";
}
