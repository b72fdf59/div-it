import { parseEvent } from "./events.js";

export function cents(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error("Enter an amount greater than zero.");
  return Math.round(number * 100);
}

function eventEntries(eventsById) {
  const entries = eventsById instanceof Map
    ? [...eventsById.entries()]
    : eventsById && typeof eventsById === "object" && !Array.isArray(eventsById) ? Object.entries(eventsById) : null;
  if (entries) return entries.flatMap(([id, value]) => Array.isArray(value)
    ? value.map((variant) => [id, variant])
    : [[id, value]]);
  throw new TypeError("eventsById must be an object or Map");
}

function compareIds([left], [right]) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function addBalance(balancesByParticipant, participantId, amount) {
  const next = (balancesByParticipant.get(participantId) ?? 0) + amount;
  if (!Number.isSafeInteger(next)) throw new RangeError("balance-overflow");
  balancesByParticipant.set(participantId, next);
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

export function projectLedger(eventsById, context) {
  if (!context
    || typeof context !== "object"
    || typeof context.groupId !== "string"
    || typeof context.currency !== "string"
    || typeof context.isEventAuthorized !== "function") throw new TypeError("invalid-projection-context");

  const entries = eventEntries(eventsById).sort(compareIds);
  const balancesByParticipant = new Map();
  const effective = [];
  const pending = [];
  const quarantined = [];
  const unsupported = [];
  const duplicates = [];
  const parsedEntries = [];
  const variantsById = new Map();

  for (const [id, rawEvent] of entries) {
    const parsed = parseEvent(rawEvent);
    if (!parsed.ok) {
      const diagnostic = { id, reason: parsed.reason };
      if (parsed.reason === "unsupported-version" || parsed.reason === "unsupported-event-type") unsupported.push(diagnostic);
      else quarantined.push(diagnostic);
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
      let authorized = false;
      try {
        authorized = context.isEventAuthorized(structuredClone(event)) === true;
      } catch {
        authorized = false;
      }
      if (authorized) authorizedVariants.push(event);
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

  for (const [id, event] of parsedEntries) {
    if (blockedByMissing.has(id)) {
      const missingDependencyIds = event.dependsOn.filter((dependencyId) => !readyEventIds.has(dependencyId));
      pending.push({ event, reason: "missing-dependency", missingDependencyIds });
      continue;
    }
    if (cyclicEventIds.has(id)) continue;
    if (event.type !== "expense-created") continue;

    addBalance(balancesByParticipant, event.payload.payerId, event.payload.amount);
    for (const split of event.payload.splits) addBalance(balancesByParticipant, split.participantId, -split.amount);
    effective.push(event);
  }

  const balances = Object.fromEntries([...balancesByParticipant.entries()].sort(compareIds));
  const total = Object.values(balances).reduce((sum, balance) => sum + BigInt(balance), 0n);
  if (total !== 0n) throw new Error("non-zero-sum");

  return { balances, effective, pending, quarantined, unsupported, readOnly: unsupported.length > 0, duplicates };
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
