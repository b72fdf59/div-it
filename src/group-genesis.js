import { exportDevicePublicKey, signRecord, verifyRecord } from "./identity-crypto.js";
import { getOrCreateDeviceIdentity } from "./device-identity-store.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const BASE64URL_32 = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_64 = /^[A-Za-z0-9_-]{86}$/;
const FINGERPRINT = /^sha256:[A-Za-z0-9_-]{43}$/;
const CURRENCIES = new Set(["USD", "INR", "EUR", "GBP"]);
const MAX_GENESIS_BYTES = 8192;
const RECORD_FIELDS = ["id", "recordType", "membershipSchemaVersion", "protocolVersion", "groupId", "author", "createdAt", "membershipHeads", "causalHeads", "dependsOn", "payload", "signature"];
const AUTHOR_FIELDS = ["participantId", "deviceId", "keyId"];
const PAYLOAD_FIELDS = ["name", "currency", "owner"];
const OWNER_FIELDS = ["participantId", "deviceId", "keyId", "name", "publicKey"];

function exactObject(value, fields) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Object.keys(value);
  return Object.getOwnPropertySymbols(value).length === 0
    && keys.length === fields.length
    && fields.every((field) => Object.hasOwn(value, field))
    && keys.every((key) => fields.includes(key));
}

function validName(value) {
  return typeof value === "string" && value.length > 0 && value === value.trim()
    && [...value].length <= 128;
}

function isUuid(value) {
  return typeof value === "string" && UUID.test(value);
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeBase64Url(value, pattern, expectedLength) {
  if (typeof value !== "string" || !pattern.test(value)) return null;
  try {
    const padding = value.length % 4 === 2 ? "==" : value.length % 4 === 3 ? "=" : "";
    const binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.length === expectedLength && encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

function validTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function schemaError(record) {
  if (!exactObject(record, RECORD_FIELDS)) return "invalid-genesis-schema";
  if (record.recordType !== "group-created" || record.membershipSchemaVersion !== 1 || record.protocolVersion !== 2) {
    return "unsupported-genesis-version";
  }
  if (!isUuid(record.id) || !isUuid(record.groupId)) return "invalid-genesis-id";
  if (!exactObject(record.author, AUTHOR_FIELDS)
      || !AUTHOR_FIELDS.every((field) => isUuid(record.author[field]))) return "invalid-genesis-author";
  if (!validTimestamp(record.createdAt)) return "invalid-genesis-timestamp";
  if (!Array.isArray(record.membershipHeads) || record.membershipHeads.length !== 0
      || !Array.isArray(record.causalHeads) || record.causalHeads.length !== 0
      || !Array.isArray(record.dependsOn) || record.dependsOn.length !== 0) return "invalid-genesis-frontier";
  if (!exactObject(record.payload, PAYLOAD_FIELDS)) return "invalid-genesis-payload";
  if (!validName(record.payload.name)
      || !CURRENCIES.has(record.payload.currency)) return "invalid-genesis-payload";
  const owner = record.payload.owner;
  if (!exactObject(owner, OWNER_FIELDS)
      || !isUuid(owner.participantId) || !isUuid(owner.deviceId) || !isUuid(owner.keyId)
      || !validName(owner.name)) return "invalid-genesis-owner";
  if (owner.participantId !== record.author.participantId
      || owner.deviceId !== record.author.deviceId || owner.keyId !== record.author.keyId) {
    return "genesis-owner-author-mismatch";
  }
  if (!decodeBase64Url(owner.publicKey, BASE64URL_32, 32)) return "invalid-genesis-public-key";
  if (!decodeBase64Url(record.signature, BASE64URL_64, 64)) return "invalid-genesis-signature";
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(record));
    if (bytes.byteLength > MAX_GENESIS_BYTES) return "genesis-too-large";
  } catch {
    return "invalid-genesis-schema";
  }
  return null;
}

async function fingerprint(publicKeyBytes) {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", publicKeyBytes);
  return `sha256:${encodeBase64Url(new Uint8Array(digest))}`;
}

function validateCreationInput({ name, currency, ownerName }) {
  if (!validName(name) || !validName(ownerName)) throw new TypeError("invalid-genesis-name");
  if (!CURRENCIES.has(currency)) throw new TypeError("invalid-genesis-currency");
}

export async function createGroupGenesis({ name, currency, ownerName }) {
  validateCreationInput({ name, currency, ownerName });
  const identity = await getOrCreateDeviceIdentity();
  const publicKeyBytes = await exportDevicePublicKey(identity.publicKey);
  if (publicKeyBytes.byteLength !== 32) throw new Error("invalid-device-public-key");
  const participantId = globalThis.crypto.randomUUID();
  const record = {
    id: globalThis.crypto.randomUUID(),
    recordType: "group-created",
    membershipSchemaVersion: 1,
    protocolVersion: 2,
    groupId: globalThis.crypto.randomUUID(),
    author: {
      participantId,
      deviceId: identity.deviceId,
      keyId: identity.keyId
    },
    createdAt: new Date().toISOString(),
    membershipHeads: [],
    causalHeads: [],
    dependsOn: [],
    payload: {
      name,
      currency,
      owner: {
        participantId,
        deviceId: identity.deviceId,
        keyId: identity.keyId,
        name: ownerName,
        publicKey: encodeBase64Url(publicKeyBytes)
      }
    }
  };
  record.signature = await signRecord(record, identity.privateKey);
  const publicKeyFingerprint = await fingerprint(publicKeyBytes);
  return {
    record,
    trustPin: { genesisId: record.id, publicKeyFingerprint }
  };
}

export async function verifyGroupGenesis(record, trustPin) {
  let error;
  try {
    error = schemaError(record);
  } catch {
    return { ok: false, reason: "invalid-genesis-schema" };
  }
  if (error) return { ok: false, reason: error };
  let validPin;
  try {
    validPin = exactObject(trustPin, ["genesisId", "publicKeyFingerprint"])
      && isUuid(trustPin.genesisId)
      && typeof trustPin.publicKeyFingerprint === "string"
      && FINGERPRINT.test(trustPin.publicKeyFingerprint);
  } catch {
    return { ok: false, reason: "invalid-genesis-trust-pin" };
  }
  if (!validPin) {
    return { ok: false, reason: "invalid-genesis-trust-pin" };
  }
  if (trustPin.genesisId !== record.id) return { ok: false, reason: "genesis-id-pin-mismatch" };
  const publicKeyBytes = decodeBase64Url(record.payload.owner.publicKey, BASE64URL_32, 32);
  let actualFingerprint;
  try {
    actualFingerprint = await fingerprint(publicKeyBytes);
  } catch (cause) {
    return { ok: false, reason: "genesis-crypto-unavailable", cause };
  }
  if (trustPin.publicKeyFingerprint !== actualFingerprint) {
    return { ok: false, reason: "genesis-key-pin-mismatch" };
  }
  try {
    const publicKey = await globalThis.crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
    if (!(await verifyRecord(record, publicKey))) return { ok: false, reason: "invalid-genesis-signature" };
  } catch (cause) {
    return { ok: false, reason: "genesis-crypto-unavailable", cause };
  }
  return { ok: true, genesisId: record.id, groupId: record.groupId, publicKeyFingerprint: actualFingerprint };
}
