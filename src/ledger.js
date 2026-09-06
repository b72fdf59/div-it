import { parseEvent } from "./events.js";

const MAX_LEDGER_EVENTS = 10_000;
const MAX_LEDGER_BYTES = 8 * 1024 * 1024;

export function cents(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("Enter an amount greater than zero.");
  return Math.round(number * 100);
}

function eventEntries(eventsById) {
  const sources = eventsById instanceof Map
    ? [...eventsById.entries()]
    : eventsById && typeof eventsById === "object" && !Array.isArray(eventsById) ? Object.entries(eventsById) : null;
  if (!sources) throw new TypeError("eventsById must be an object or Map");

  const entries = [];
  let encodedBytes = 0;
  for (const [id, value] of sources) {
    const variants = Array.isArray(value) ? value : [value];
    for (const variant of variants) {
      entries.push([id, variant]);
      if (entries.length > MAX_LEDGER_EVENTS) return null;
      try {
        const encoded = typeof variant === "string" ? variant : JSON.stringify(variant);
        encodedBytes += new TextEncoder().encode(encoded ?? "").byteLength;
      } catch {
        encodedBytes = MAX_LEDGER_BYTES + 1;
      }
      if (encodedBytes > MAX_LEDGER_BYTES) return null;
    }
  }
  return entries;
}

function compareIds([left], [right]) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function addBalance(balancesByParticipant, participantId, amount) {
  balancesByParticipant.set(participantId, (balancesByParticipant.get(participantId) ?? 0n) + BigInt(amount));
}

function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

function signedContent(event) {
  const { signature, ...unsigned } = event;
  return canonicalJson(unsigned);
}

function fullEventContent(event) {
  return canonicalJson(event);
}

function logicalIdentity(event) {
  if (event.type === "expense-created") return ["expense", event.payload.expenseId];
  if (event.type === "settlement-recorded") return ["settlement", event.payload.settlementId];
  if (event.type === "opening-balances-imported") return ["import", event.payload.importId];
  if (event.type === "conflict-resolved") return ["resolution", event.payload.resolutionId];
  return null;
}

export function projectLedger(eventsById, context) {
  if (!context
    || typeof context !== "object"
    || typeof context.groupId !== "string"
    || typeof context.currency !== "string"
    || typeof context.isEventAuthorized !== "function") throw new TypeError("invalid-projection-context");

  const entries = eventEntries(eventsById);
  if (entries === null) return {
    balances: {},
    effective: [],
    pending: [],
    conflicting: [],
    quarantined: [{ id: "ledger", reason: "ledger-too-large" }],
    unsupported: [],
    readOnly: true,
    duplicates: [],
    ignored: []
  };
  entries.sort(compareIds);
  const balancesByParticipant = new Map();
  const effective = [];
  const pending = [];
  const conflicting = [];
  const quarantined = [];
  const unsupported = [];
  const duplicates = [];
  const ignored = [];
  const parsedEntries = [];
  const variantsById = new Map();

  const isAuthorized = (event) => {
    try {
      return context.isEventAuthorized(structuredClone(event)) === true;
    } catch {
      return false;
    }
  };

  for (const [id, rawEvent] of entries) {
    const parsed = parseEvent(rawEvent);
    if (!parsed.ok) {
      const diagnostic = { id, reason: parsed.reason };
      if ((parsed.reason === "unsupported-version" || parsed.reason === "unsupported-event-type") && parsed.event) {
        if (id !== parsed.event.id) quarantined.push({ id, reason: "event-id-mismatch" });
        else if (parsed.event.groupId !== context.groupId) quarantined.push({ id, reason: "group-mismatch" });
        else if (!isAuthorized(parsed.event)) quarantined.push({ id, reason: "unauthenticated" });
        else unsupported.push(diagnostic);
      } else quarantined.push(diagnostic);
      continue;
    }
    if (id !== parsed.event.id) {
      quarantined.push({ id, reason: "event-id-mismatch" });
      continue;
    }
    if (parsed.event.groupId !== context.groupId) {
      quarantined.push({ id, reason: "group-mismatch" });
      continue;
    }
    if (Object.hasOwn(parsed.event.payload, "currency")
      && parsed.event.payload.currency !== context.currency) {
      quarantined.push({ id, reason: "currency-mismatch" });
      continue;
    }
    if (!variantsById.has(id)) variantsById.set(id, []);
    variantsById.get(id).push(parsed.event);
  }

  for (const [id, variants] of [...variantsById.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
    const authorizedVariants = [];
    for (const event of variants) {
      if (isAuthorized(event)) authorizedVariants.push(event);
      else quarantined.push({ id, reason: "unauthenticated" });
    }
    const contentGroups = new Map();
    for (const event of authorizedVariants) {
      const content = signedContent(event);
      if (!contentGroups.has(content)) contentGroups.set(content, []);
      contentGroups.get(content).push(event);
    }
    if (contentGroups.size > 1) {
      quarantined.push({ id, reason: "id-content-collision" });
      continue;
    }
    if (authorizedVariants.length === 0) continue;

    const selected = [...authorizedVariants].sort((left, right) => {
      const leftContent = fullEventContent(left);
      const rightContent = fullEventContent(right);
      return leftContent < rightContent ? -1 : leftContent > rightContent ? 1 : 0;
    })[0];
    if (authorizedVariants.length > 1) duplicates.push({ id, reason: "duplicate-ignored", count: authorizedVariants.length - 1 });
    parsedEntries.push([id, selected]);
  }

  const logicalGroups = new Map();
  for (const [id, event] of parsedEntries) {
    const identity = logicalIdentity(event);
    if (!identity) continue;
    const key = canonicalJson(identity);
    if (!logicalGroups.has(key)) logicalGroups.set(key, []);
    logicalGroups.get(key).push([id, event]);
  }

  const rejectedLogicalIds = new Set();
  for (const group of logicalGroups.values()) {
    if (group.length < 2) continue;
    for (const [id] of group) {
      rejectedLogicalIds.add(id);
      quarantined.push({ id, reason: "logical-id-content-collision" });
    }
  }
  parsedEntries.splice(0, parsedEntries.length, ...parsedEntries.filter(([id]) => !rejectedLogicalIds.has(id)));

  const eventsByValidId = new Map(parsedEntries);
  const dependentsById = new Map(parsedEntries.map(([id]) => [id, []]));
  const blockedByMissing = new Set();
  for (const [id, event] of parsedEntries) {
    for (const dependencyId of event.dependsOn) {
      if (eventsByValidId.has(dependencyId)) dependentsById.get(dependencyId).push(id);
      else blockedByMissing.add(id);
    }
  }

  const blockedQueue = [...blockedByMissing];
  for (let index = 0; index < blockedQueue.length; index++) {
    for (const dependentId of dependentsById.get(blockedQueue[index]) ?? []) {
      if (!blockedByMissing.has(dependentId)) {
        blockedByMissing.add(dependentId);
        blockedQueue.push(dependentId);
      }
    }
  }

  const unresolvedDependencies = new Map();
  const readyQueue = [];
  for (const [id, event] of parsedEntries) {
    if (blockedByMissing.has(id)) continue;
    const count = event.dependsOn.length;
    unresolvedDependencies.set(id, count);
    if (count === 0) readyQueue.push(id);
  }

  const readyEventIds = new Set();
  for (let index = 0; index < readyQueue.length; index++) {
    const id = readyQueue[index];
    readyEventIds.add(id);
    for (const dependentId of dependentsById.get(id)) {
      if (blockedByMissing.has(dependentId)) continue;
      const remaining = unresolvedDependencies.get(dependentId) - 1;
      unresolvedDependencies.set(dependentId, remaining);
      if (remaining === 0) readyQueue.push(dependentId);
    }
  }

  const cyclicEventIds = new Set();
  for (const [id] of parsedEntries) {
    if (!blockedByMissing.has(id) && !readyEventIds.has(id)) {
      cyclicEventIds.add(id);
      quarantined.push({ id, reason: "cyclic-dependency" });
    }
  }

  const expenseEventsById = new Map();
  const childrenByParentId = new Map();
  for (const [id, event] of parsedEntries) {
    if (!readyEventIds.has(id) || !["expense-created", "expense-revised", "expense-voided"].includes(event.type)) continue;
    expenseEventsById.set(id, event);
    childrenByParentId.set(id, []);
  }

  const invalidExpenseEventIds = new Set();
  const quarantineExpenseReference = (id) => {
    if (!invalidExpenseEventIds.has(id)) {
      invalidExpenseEventIds.add(id);
      quarantined.push({ id, reason: "invalid-reference" });
    }
  };
  for (const [id, event] of expenseEventsById) {
    if (event.type === "expense-created") continue;
    const parent = eventsByValidId.get(event.payload.supersedesEventId);
    if (!parent
      || !["expense-created", "expense-revised"].includes(parent.type)
      || parent.payload.expenseId !== event.payload.expenseId) {
      quarantineExpenseReference(id);
      continue;
    }
    childrenByParentId.get(parent.id).push(id);
  }

  const invalidQueue = [...invalidExpenseEventIds];
  for (let index = 0; index < invalidQueue.length; index++) {
    for (const childId of childrenByParentId.get(invalidQueue[index]) ?? []) {
      if (!invalidExpenseEventIds.has(childId)) {
        quarantineExpenseReference(childId);
        invalidQueue.push(childId);
      }
    }
  }

  const conflictGroups = new Map();
  const conflictGroupByBranches = new Map();
  for (const [parentId, childIds] of childrenByParentId) {
    const validChildIds = childIds.filter((id) => !invalidExpenseEventIds.has(id));
    childrenByParentId.set(parentId, validChildIds);
    if (validChildIds.length >= 2) {
      const branchIds = [...validChildIds].sort();
      conflictGroups.set(parentId, branchIds);
      conflictGroupByBranches.set(canonicalJson(branchIds), parentId);
    }
  }

  const resolutionEventsById = new Map();
  for (const [id, event] of parsedEntries) {
    if (readyEventIds.has(id) && event.type === "conflict-resolved") resolutionEventsById.set(id, event);
  }

  const invalidResolutionEventIds = new Set();
  const quarantineResolution = (id, reason = "invalid-resolution") => {
    if (!invalidResolutionEventIds.has(id)) {
      invalidResolutionEventIds.add(id);
      (reason === "conflicting-resolution" ? conflicting : quarantined).push({ id, reason });
    }
  };
  const resolutionGroupById = new Map();
  const resolutionGroups = new Map();
  for (const [id, event] of resolutionEventsById) {
    const resolvedBranchIds = event.payload.resolvesEventIds;
    const parentId = conflictGroupByBranches.get(canonicalJson(resolvedBranchIds));
    if (!parentId || !resolvedBranchIds.every((branchId) => expenseEventsById.get(branchId).payload.expenseId === event.payload.expenseId)) {
      quarantineResolution(id);
      continue;
    }
    resolutionGroupById.set(id, parentId);
    if (!resolutionGroups.has(parentId)) resolutionGroups.set(parentId, []);
    resolutionGroups.get(parentId).push(id);
  }

  for (const [id, event] of resolutionEventsById) {
    if (invalidResolutionEventIds.has(id)) continue;
    const parentId = resolutionGroupById.get(id);
    if (event.payload.supersedesResolutionEventIds.some((resolutionId) => resolutionGroupById.get(resolutionId) !== parentId)) {
      quarantineResolution(id);
    }
  }

  const resolvedBranchByParentId = new Map();
  const effectiveResolutionIds = new Set();
  for (const [parentId, resolutionIds] of resolutionGroups) {
    const validResolutionIds = resolutionIds.filter((id) => !invalidResolutionEventIds.has(id));
    const supersededResolutionIds = new Set(validResolutionIds.flatMap((id) => resolutionEventsById.get(id).payload.supersedesResolutionEventIds));
    const maximalResolutionIds = validResolutionIds.filter((id) => !supersededResolutionIds.has(id));
    const historicalChosenEventIds = new Set(validResolutionIds.map((id) => resolutionEventsById.get(id).payload.chosenEventId));
    const chosenEventIds = new Set(maximalResolutionIds.map((id) => resolutionEventsById.get(id).payload.chosenEventId));
    const disputeFullySuperseded = historicalChosenEventIds.size <= 1 || maximalResolutionIds.length === 1;
    if (chosenEventIds.size === 1 && maximalResolutionIds.length > 0 && disputeFullySuperseded) {
      resolvedBranchByParentId.set(parentId, [...chosenEventIds][0]);
      effectiveResolutionIds.add([...maximalResolutionIds].sort()[0]);
    } else {
      for (const id of maximalResolutionIds) quarantineResolution(id, "conflicting-resolution");
    }
  }

  const conflictingExpenseEventIds = new Set();
  const markConflictingTree = (rootId, report) => {
    const queue = [rootId];
    for (let index = 0; index < queue.length; index++) {
      const id = queue[index];
      if (invalidExpenseEventIds.has(id) || conflictingExpenseEventIds.has(id)) continue;
      conflictingExpenseEventIds.add(id);
      if (report) conflicting.push({ id, reason: "conflicting-revision" });
      queue.push(...(childrenByParentId.get(id) ?? []));
    }
  };
  for (const [parentId, childIds] of conflictGroups) {
    const chosenEventId = resolvedBranchByParentId.get(parentId);
    for (const childId of childIds) {
      if (chosenEventId === undefined || childId !== chosenEventId) markConflictingTree(childId, chosenEventId === undefined);
    }
  }

  const activeExpenseEventIds = new Set();
  for (const [id] of expenseEventsById) {
    if (invalidExpenseEventIds.has(id) || conflictingExpenseEventIds.has(id)) continue;
    const activeChildren = (childrenByParentId.get(id) ?? []).filter((childId) => !invalidExpenseEventIds.has(childId) && !conflictingExpenseEventIds.has(childId));
    if (activeChildren.length === 0) activeExpenseEventIds.add(id);
  }

  const reversedSettlementIds = new Set();
  const contributionsByEventId = new Map();
  const contribute = (eventId, participantId, amount) => {
    addBalance(balancesByParticipant, participantId, amount);
    if (!contributionsByEventId.has(eventId)) contributionsByEventId.set(eventId, new Map());
    addBalance(contributionsByEventId.get(eventId), participantId, amount);
  };
  for (const [id, event] of parsedEntries) {
    if (blockedByMissing.has(id)) {
      const missingDependencyIds = event.dependsOn.filter((dependencyId) => !readyEventIds.has(dependencyId));
      pending.push({ event, reason: "missing-dependency", missingDependencyIds });
      continue;
    }
    if (cyclicEventIds.has(id)) continue;
    if (event.type === "conflict-resolved") {
      if (effectiveResolutionIds.has(id)) effective.push(event);
      continue;
    }
    if (["expense-created", "expense-revised", "expense-voided"].includes(event.type)) {
      if (!activeExpenseEventIds.has(id)) continue;
      if (event.type === "expense-voided") {
        effective.push(event);
        continue;
      }
      contribute(id, event.payload.payerId, event.payload.amount);
      for (const split of event.payload.splits) contribute(id, split.participantId, -split.amount);
      effective.push(event);
      continue;
    }
    if (event.type === "opening-balances-imported") {
      for (const balance of event.payload.balances) contribute(id, balance.participantId, balance.amount);
      effective.push(event);
      continue;
    }
    if (event.type === "settlement-recorded") {
      contribute(id, event.payload.fromParticipantId, event.payload.amount);
      contribute(id, event.payload.toParticipantId, -event.payload.amount);
      effective.push(event);
      continue;
    }
    if (event.type === "settlement-reversed") {
      const target = eventsByValidId.get(event.payload.reversesEventId);
      if (!target
        || target.type !== "settlement-recorded"
        || target.payload.settlementId !== event.payload.settlementId) {
        quarantined.push({ id, reason: "invalid-reference" });
        continue;
      }
      if (reversedSettlementIds.has(event.payload.settlementId)) {
        ignored.push({ id, reason: "duplicate-reversal-ignored" });
        continue;
      }
      reversedSettlementIds.add(event.payload.settlementId);
      contribute(id, target.payload.fromParticipantId, -target.payload.amount);
      contribute(id, target.payload.toParticipantId, target.payload.amount);
      effective.push(event);
      continue;
    }
  }

  const overflowEventIds = new Set();
  while ([...balancesByParticipant.values()].some((balance) => balance > BigInt(Number.MAX_SAFE_INTEGER) || balance < BigInt(Number.MIN_SAFE_INTEGER))) {
    const unsafeParticipantIds = new Set([...balancesByParticipant].filter(([, balance]) => balance > BigInt(Number.MAX_SAFE_INTEGER) || balance < BigInt(Number.MIN_SAFE_INTEGER)).map(([id]) => id));
    for (const [id, contributions] of contributionsByEventId) {
      if ([...contributions.keys()].some((participantId) => unsafeParticipantIds.has(participantId))) overflowEventIds.add(id);
    }
    balancesByParticipant.clear();
    for (const [id, contributions] of contributionsByEventId) {
      if (overflowEventIds.has(id)) continue;
      for (const [participantId, amount] of contributions) addBalance(balancesByParticipant, participantId, amount);
    }
  }
  if (overflowEventIds.size > 0) {
    for (const id of [...overflowEventIds].sort()) quarantined.push({ id, reason: "balance-overflow" });
    const retainedEffective = effective.filter((event) => !overflowEventIds.has(event.id));
    effective.splice(0, effective.length, ...retainedEffective);
  }

  const balances = Object.fromEntries([...balancesByParticipant.entries()].sort(compareIds).map(([id, balance]) => [id, Number(balance)]));
  const total = Object.values(balances).reduce((sum, balance) => sum + BigInt(balance), 0n);
  if (total !== 0n) throw new Error("non-zero-sum");

  conflicting.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0);
  quarantined.sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : left.reason < right.reason ? -1 : left.reason > right.reason ? 1 : 0);

  return { balances, effective, pending, conflicting, quarantined, unsupported, readOnly: unsupported.length > 0, duplicates, ignored };
}

export function formatCents(value, currency = "USD") {
  return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(value / 100);
}

export function makeExpense({ description, amount, payerId, splits, createdAt = new Date().toISOString() }) {
  if (!description.trim()) throw new Error("Enter a description.");
  if (!payerId || !splits.length) throw new Error("Choose payer and at least one participant.");
  if (!Number.isInteger(amount) || amount <= 0 || splits.some((split) => !split.personId || !Number.isInteger(split.amount) || split.amount <= 0)) throw new Error("Expense amounts must be positive whole cents.");
  if (splits.reduce((sum, split) => sum + split.amount, 0) !== amount) throw new Error("Splits must equal total amount.");
  return { id: crypto.randomUUID(), type: "expense-created", description: description.trim(), amount, payerId, splits, createdAt };
}

export function balances(events, people) {
  const result = Object.fromEntries(people.map((person) => [person.id, 0]));
  for (const event of events) {
    if (event.type !== "expense" && event.type !== "expense-created") continue;
    result[event.payerId] = (result[event.payerId] || 0) + event.amount;
    for (const split of event.splits) result[split.personId] = (result[split.personId] || 0) - split.amount;
  }
  return result;
}

export function settlementPlan(balanceMap) {
  const debtors = Object.entries(balanceMap).filter(([, value]) => value < 0).map(([id, value]) => ({ id, value: -value }));
  const creditors = Object.entries(balanceMap).filter(([, value]) => value > 0).map(([id, value]) => ({ id, value }));
  const transfers = [];
  let debtor = 0;
  let creditor = 0;
  while (debtors[debtor] && creditors[creditor]) {
    const amount = Math.min(debtors[debtor].value, creditors[creditor].value);
    transfers.push({ from: debtors[debtor].id, to: creditors[creditor].id, amount });
    debtors[debtor].value -= amount;
    creditors[creditor].value -= amount;
    if (!debtors[debtor].value) debtor++;
    if (!creditors[creditor].value) creditor++;
  }
  return transfers;
}
