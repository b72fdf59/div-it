import { canonicalJsonBytes } from "./identity-crypto.js";
import { projectGroup } from "./prototype-events.js";

const ARCHIVE_FORMAT = "div-it-legacy-raw-v1";
const PROJECTION_GROUP_ID = "00000000-0000-4000-8000-000000000000";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const CURRENCIES = new Set(["USD", "INR", "EUR", "GBP"]);

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function diagnostic(reason, id) {
  return { reason, ...(typeof id === "string" ? { id } : {}) };
}

function sourceEvents(source) {
  if (source.events !== undefined && !Array.isArray(source.events)) {
    throw new Error("invalid-event-array");
  }
  if (source.eventsById !== undefined
    && (!source.eventsById || typeof source.eventsById !== "object" || Array.isArray(source.eventsById))) {
    throw new Error("invalid-scalar-event-store");
  }
  if (source.events === undefined && source.eventsById === undefined) throw new Error("missing-event-store");
  const legacy = source.events || [];
  const mapped = source.eventsById ? Object.values(source.eventsById).map((value) => {
    if (typeof value !== "string") return value;
    try { return JSON.parse(value); } catch { return value; }
  }) : [];
  const remaining = new Map();
  for (const event of legacy) {
    let key;
    try { key = new TextDecoder().decode(canonicalJsonBytes(event)); } catch { key = "<invalid>"; }
    remaining.set(key, (remaining.get(key) || 0) + 1);
  }
  const events = [...legacy];
  for (const event of mapped) {
    let key;
    try { key = new TextDecoder().decode(canonicalJsonBytes(event)); } catch { key = "<invalid>"; }
    const copies = remaining.get(key) || 0;
    if (copies) remaining.set(key, copies - 1);
    else events.push(event);
  }
  return events;
}

function validateSource(source) {
  const errors = [];
  if (!source || typeof source !== "object" || Array.isArray(source)) return { errors: [diagnostic("invalid-group-source")] };
  if (typeof source.name !== "string" || !source.name.trim()) errors.push(diagnostic("invalid-group-name"));
  if (!CURRENCIES.has(source.currency)) errors.push(diagnostic("unsupported-currency"));
  if (!Array.isArray(source.people)) errors.push(diagnostic("invalid-participant-list"));
  else {
    const ids = new Set();
    for (const person of source.people) {
      if (!person || typeof person !== "object" || Array.isArray(person)
        || typeof person.id !== "string" || !person.id.trim()
        || typeof person.name !== "string" || !person.name.trim()) {
        errors.push(diagnostic("invalid-participant", person?.id));
      } else if (ids.has(person.id)) errors.push(diagnostic("duplicate-participant-id", person.id));
      else ids.add(person.id);
    }
  }
  if (source.groupId !== undefined && !UUID.test(source.groupId || "")) errors.push(diagnostic("invalid-source-group-id"));
  return { errors };
}

function projectionGroupId(source, events) {
  if (UUID.test(source.groupId || "")) return source.groupId;
  const ids = new Set(events.flatMap((event) => event && typeof event === "object"
    && Object.hasOwn(event, "schemaVersion") && UUID.test(event.groupId || "") ? [event.groupId] : []));
  return ids.size === 1 ? [...ids][0] : PROJECTION_GROUP_ID;
}

function sourceGroupId(source, events) {
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  if (source.groupId !== undefined) return source.groupId;
  const ids = new Set(events.flatMap((event) => event && typeof event === "object"
    && Object.hasOwn(event, "schemaVersion") && UUID.test(event.groupId || "") ? [event.groupId] : []));
  return ids.size === 1 ? [...ids][0] : null;
}

function participantIdsFor(people) {
  return new Set((Array.isArray(people) ? people : []).flatMap((person) => typeof person?.id === "string" ? [person.id] : []));
}

function copyArchiveBytes(rawArchiveBytes) {
  return typeof rawArchiveBytes === "string" ? new TextEncoder().encode(rawArchiveBytes)
    : rawArchiveBytes instanceof Uint8Array ? Uint8Array.from(rawArchiveBytes)
      : rawArchiveBytes instanceof ArrayBuffer ? new Uint8Array(rawArchiveBytes.slice(0)) : null;
}

function archiveMember(source, rawArchiveBytes, canonicalSourceBytes) {
  if (rawArchiveBytes === undefined) {
    return { kind: "canonical-object", mediaType: "application/json", canonicalization: "RFC 8785", bytes: canonicalSourceBytes };
  }
  const bytes = copyArchiveBytes(rawArchiveBytes);
  if (!bytes) throw new Error("invalid-raw-archive-bytes");
  let parsed;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("invalid-raw-archive-json"); }
  if (new TextDecoder().decode(canonicalJsonBytes(parsed)) !== new TextDecoder().decode(canonicalJsonBytes(source))) {
    throw new Error("raw-archive-source-mismatch");
  }
  return { kind: "original-bytes", mediaType: "application/json", bytes };
}

/** Build an owner-review draft from parsed legacy data without changing or activating it. */
export async function prepareLegacyActivationReview(source, { rawArchiveBytes } = {}) {
  let canonicalSourceBytes;
  let archive;
  let digest;
  const diagnostics = [];
  try {
    canonicalSourceBytes = canonicalJsonBytes(source);
    archive = archiveMember(source, rawArchiveBytes, canonicalSourceBytes);
    const digestInput = canonicalJsonBytes({ archiveFormat: ARCHIVE_FORMAT, group: source });
    digest = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", digestInput)));
  } catch (error) {
    return {
      legacyUnverified: true,
      activationReady: false,
      archiveFormat: ARCHIVE_FORMAT,
      sourceGroupId: source?.groupId ?? null,
      archive: rawArchiveBytes === undefined ? null : (() => {
        const bytes = copyArchiveBytes(rawArchiveBytes);
        return bytes ? { kind: "original-bytes", mediaType: "application/json", bytes } : null;
      })(),
      digest: null,
      participants: [],
      currency: source?.currency ?? null,
      openingBalances: [],
      diagnostics: [diagnostic(error?.message || "invalid-source")],
      blockers: [diagnostic(error?.message || "invalid-source")]
    };
  }

  const { errors } = validateSource(source);
  diagnostics.push(...errors);
  let events = [];
  if (!errors.length || (Array.isArray(source?.people) && CURRENCIES.has(source?.currency))) {
    try { events = sourceEvents(source); }
    catch (error) { diagnostics.push(diagnostic(error?.message || "invalid-event-store")); }
  }

  let projection = null;
  if (!diagnostics.length) {
    try {
      projection = projectGroup({ ...source, groupId: projectionGroupId(source, events), events });
    } catch {
      diagnostics.push(diagnostic("projection-failed"));
    }
  }

  const blockers = diagnostics.map(({ reason, id }) => diagnostic(reason, id));
  if (projection) {
    for (const field of ["pending", "quarantined", "unsupported", "conflicting"]) {
      for (const item of projection[field]) {
        const finding = { status: field, reason: item.reason || field, ...(item.id || item.event?.id ? { id: item.id || item.event.id } : {}) };
        diagnostics.push(finding);
        blockers.push(finding);
      }
    }
    if (projection.readOnly) {
      const finding = diagnostic("projection-read-only");
      diagnostics.push(finding);
      blockers.push(finding);
    }
  }
  const participantIds = participantIdsFor(source?.people);
  const balances = projection?.balances || {};
  for (const id of Object.keys(balances)) {
    if (!participantIds.has(id)) {
      const finding = diagnostic("unknown-balance-participant", id);
      diagnostics.push(finding);
      blockers.push(finding);
    }
  }
  const openingBalances = [...participantIds].sort().map((participantId) => ({ participantId, amount: balances[participantId] || 0 }));
  let balanceTotal = 0;
  let balanceTotalSafe = true;
  for (const { amount } of openingBalances) {
    balanceTotal += amount;
    balanceTotalSafe &&= Number.isSafeInteger(balanceTotal);
  }
  if (openingBalances.some(({ amount }) => !Number.isSafeInteger(amount)) || !balanceTotalSafe || balanceTotal !== 0) {
    diagnostics.push(diagnostic("opening-balances-not-zero-sum"));
    blockers.push(diagnostic("opening-balances-not-zero-sum"));
  }

  return {
    legacyUnverified: true,
    activationReady: blockers.length === 0,
    archiveFormat: ARCHIVE_FORMAT,
    sourceGroupId: sourceGroupId(source, events),
    archive,
    digest: { algorithm: "SHA-256", encoding: "base64url-no-padding", value: digest },
    participants: (Array.isArray(source?.people) ? source.people : []).flatMap((person) => typeof person?.id === "string" && typeof person?.name === "string"
      ? [{ participantId: person.id, name: person.name }] : []),
    currency: source?.currency ?? null,
    openingBalances,
    legacyEventCount: events.length,
    diagnostics,
    blockers
  };
}
