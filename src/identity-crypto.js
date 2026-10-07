const utf8 = new TextEncoder();
const signaturePattern = /^[A-Za-z0-9_-]{86}$/;

function isPlainObject(value) {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertWellFormedString(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new TypeError("invalid-unicode-string");
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("invalid-unicode-string");
    }
  }
}

function serialize(value, ancestors = new Set()) {
  if (value === null) return "null";
  if (typeof value === "string") {
    assertWellFormedString(value);
    return JSON.stringify(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("invalid-json-number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new TypeError("invalid-json-value");
  if (ancestors.has(value)) throw new TypeError("cyclic-json-value");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) {
        throw new TypeError("invalid-json-array");
      }
      const keys = Object.getOwnPropertyNames(value);
      if (keys.length !== value.length + 1 || keys.at(-1) !== "length") throw new TypeError("invalid-json-array");
      const elements = [];
      for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new TypeError("invalid-json-array");
        }
        elements.push(serialize(descriptor.value, ancestors));
      }
      return `[${elements.join(",")}]`;
    }

    if (!isPlainObject(value) || Object.getOwnPropertySymbols(value).length) throw new TypeError("invalid-json-object");
    const keys = Object.getOwnPropertyNames(value).sort();
    const properties = [];
    for (const key of keys) {
      assertWellFormedString(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("invalid-json-object");
      properties.push(`${JSON.stringify(key)}:${serialize(descriptor.value, ancestors)}`);
    }
    return `{${properties.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalJsonBytes(value) {
  return utf8.encode(serialize(value));
}

export function signedRecordBytes(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record) || !isPlainObject(record)) {
    throw new TypeError("invalid-signed-record");
  }
  if (Object.getOwnPropertySymbols(record).length) throw new TypeError("invalid-signed-record");

  const unsigned = Object.create(null);
  for (const key of Object.getOwnPropertyNames(record)) {
    assertWellFormedString(key);
    const descriptor = Object.getOwnPropertyDescriptor(record, key);
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw new TypeError("invalid-signed-record");
    if (key !== "signature") unsigned[key] = descriptor.value;
  }
  return canonicalJsonBytes(unsigned);
}

function getSubtleCrypto() {
  if (!globalThis.crypto?.subtle) throw new Error("webcrypto-unavailable");
  return globalThis.crypto.subtle;
}

function assertEd25519Key(key, type) {
  if (!key || key.type !== type || key.algorithm?.name !== "Ed25519") {
    throw new TypeError("unsupported-signing-key");
  }
}

export async function generateDeviceSigningKeyPair() {
  const subtle = getSubtleCrypto();
  let pair;
  try {
    pair = await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  } catch (error) {
    if (error?.name === "NotSupportedError") throw new Error("ed25519-unavailable", { cause: error });
    throw error;
  }
  if (pair.privateKey.extractable || !pair.publicKey.extractable) throw new Error("invalid-key-extractability");
  return pair;
}

export async function exportDevicePublicKey(publicKey) {
  assertEd25519Key(publicKey, "public");
  if (!publicKey.extractable) throw new TypeError("public-key-not-extractable");
  return new Uint8Array(await getSubtleCrypto().exportKey("raw", publicKey));
}

function encodeBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function decodeSignature(value) {
  if (typeof value !== "string" || !signaturePattern.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "==";
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return bytes.length === 64 && encodeBase64Url(bytes) === value ? bytes : null;
  } catch {
    return null;
  }
}

export async function signRecord(record, privateKey) {
  assertEd25519Key(privateKey, "private");
  if (!privateKey.usages.includes("sign")) throw new TypeError("signing-key-cannot-sign");
  const signature = await getSubtleCrypto().sign({ name: "Ed25519" }, privateKey, signedRecordBytes(record));
  return encodeBase64Url(new Uint8Array(signature));
}

export async function verifyRecord(record, publicKey) {
  assertEd25519Key(publicKey, "public");
  if (!publicKey.usages.includes("verify")) throw new TypeError("verification-key-cannot-verify");
  const signature = decodeSignature(record?.signature);
  if (!signature) return false;
  let message;
  try {
    message = signedRecordBytes(record);
  } catch {
    return false;
  }
  try {
    return await getSubtleCrypto().verify({ name: "Ed25519" }, publicKey, signature, message);
  } catch (error) {
    if (error?.name === "NotSupportedError") throw new Error("ed25519-unavailable", { cause: error });
    return false;
  }
}
