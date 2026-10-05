import { getConflicts, ImmutableString, isImmutableString } from "@automerge/automerge";
import { canonicalEventContent } from "./ledger.js";

const INVALID_KEY_PREFIX = "!invalid-event:";
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function encodeEvent(event) {
  return new ImmutableString(JSON.stringify(event));
}

function decodeValue(value) {
  const text = isImmutableString(value) ? value.toString() : typeof value === "string" ? value : null;
  if (text === null) return [value];
  try {
    return [JSON.parse(text)];
  } catch {
    return [value];
  }
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function eventStorageId(event, index, used) {
  if (typeof event?.id === "string" && event.id.length && !UNSAFE_KEYS.has(event.id)) return event.id;
  const base = `${INVALID_KEY_PREFIX}${index}`;
  let key = base;
  let suffix = 1;
  while (used.has(key)) key = `${base}:${suffix++}`;
  used.add(key);
  return key;
}

function readStore(store, includeValueConflicts = false) {
  if (Array.isArray(store)) return store;
  if (!store || typeof store !== "object") return [];
  const events = [];
  for (const key of Object.keys(store)) {
    const values = includeValueConflicts && getConflicts(store, key)
      ? Object.values(getConflicts(store, key))
      : [store[key]];
    for (const value of values) events.push(...decodeValue(value));
  }
  return events;
}

function fieldStores(document, field) {
  const conflicts = getConflicts(document, field);
  return conflicts ? { stores: Object.values(conflicts), hasRootConflicts: true } : { stores: [document?.[field]], hasRootConflicts: false };
}

function eventsInField(document, field) {
  const { stores, hasRootConflicts } = fieldStores(document, field);
  // Conflict alternatives are detached materializations; getConflicts only accepts live document roots.
  return stores.flatMap((store) => readStore(store, !hasRootConflicts));
}

function sameContent(left, right) {
  return canonicalEventContent(left) === canonicalEventContent(right);
}

function appendVariant(document, event) {
  const id = eventStorageId(event, Object.keys(document.eventsById).length, new Set(Object.keys(document.eventsById)));
  document.eventsById[`${id}:${crypto.randomUUID()}`] = encodeEvent(event);
}

export function eventMapFromArray(events) {
  const used = new Set(events.flatMap((event) => typeof event?.id === "string" ? [event.id] : []));
  const entries = [];
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const id = eventStorageId(event, index, used);
    entries.push([`${id}:${crypto.randomUUID()}`, encodeEvent(event)]);
  }
  return Object.fromEntries(entries);
}

export function eventsFromDocument(document) {
  const legacy = eventsInField(document, "events");
  const mapped = eventsInField(document, "eventsById");
  // The map mirrors legacy records during additive migration; expose each mirror once.
  const legacyCopies = new Map();
  for (const event of legacy) {
    const key = `${event?.id ?? ""}:${canonicalEventContent(event)}`;
    legacyCopies.set(key, (legacyCopies.get(key) ?? 0) + 1);
  }
  const events = [...legacy];
  for (const event of mapped) {
    const key = `${event?.id ?? ""}:${canonicalEventContent(event)}`;
    const copies = legacyCopies.get(key) ?? 0;
    if (copies) legacyCopies.set(key, copies - 1);
    else events.push(event);
  }
  const detached = events.map(cloneValue);
  return detached.sort((left, right) => {
    const leftId = typeof left?.id === "string" ? left.id : "";
    const rightId = typeof right?.id === "string" ? right.id : "";
    return leftId.localeCompare(rightId) || String(canonicalEventContent(left) ?? "").localeCompare(String(canonicalEventContent(right) ?? ""));
  });
}

export function ensureEventMap(document) {
  if (!document.eventsById || typeof document.eventsById !== "object" || Array.isArray(document.eventsById)) {
    document.eventsById = {};
  }
}

export function needsEventStoreMigration(document) {
  if (document.eventStoreFormatVersion !== 1) return true;
  const stored = eventsInField(document, "eventsById");
  return eventsInField(document, "events").some((legacy) =>
    !stored.some((current) => current?.id === legacy?.id && sameContent(current, legacy)));
}

export function migrateEventStore(document) {
  const stored = eventsInField(document, "eventsById");
  const pending = eventsInField(document, "events").filter((legacy) =>
    !stored.some((current) => current?.id === legacy?.id && sameContent(current, legacy)));
  const shouldSetVersion = document.eventStoreFormatVersion !== 1;
  if (!pending.length && !shouldSetVersion) return false;

  ensureEventMap(document);
  for (const event of pending) appendVariant(document, event);
  // This identifies the scalar-map encoding, not a promise that older replicas stopped writing.
  document.eventStoreFormatVersion = 1;
  return true;
}

export function appendStoredEvent(document, event) {
  const previous = eventsFromDocument(document).filter((item) => item?.id === event?.id);
  const content = canonicalEventContent(event);
  if (previous.some((item) => canonicalEventContent(item) === content)) return false;

  ensureEventMap(document);
  appendVariant(document, event);
  return true;
}
