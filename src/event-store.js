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
  const events = [];
  const addStore = (store, includeValueConflicts = false) => {
    for (const event of readStore(store, includeValueConflicts)) events.push(cloneValue(event));
  };
  const addRootField = (field) => {
    const conflicts = getConflicts(document, field);
    if (conflicts) {
      // getConflicts returns all root alternatives, including the visible winner.
      for (const store of Object.values(conflicts)) addStore(store);
    } else {
      addStore(document?.[field], true);
    }
  };
  addRootField("events");
  addRootField("eventsById");
  return events.sort((left, right) => {
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

export function appendStoredEvent(document, event) {
  const previous = eventsFromDocument(document).filter((item) => item?.id === event?.id);
  const content = canonicalEventContent(event);
  if (previous.some((item) => canonicalEventContent(item) === content)) return false;

  ensureEventMap(document);
  const id = eventStorageId(event, Object.keys(document.eventsById).length, new Set(Object.keys(document.eventsById)));
  document.eventsById[`${id}:${crypto.randomUUID()}`] = encodeEvent(event);
  return true;
}
