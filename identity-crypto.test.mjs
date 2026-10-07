import assert from "node:assert/strict";
import { test } from "node:test";
import {
  canonicalJsonBytes,
  exportDevicePublicKey,
  generateDeviceSigningKeyPair,
  signRecord,
  signedRecordBytes,
  verifyRecord
} from "./src/identity-crypto.js";

const decoder = new TextDecoder("utf-8", { fatal: true });
const fromHex = (value) => Uint8Array.from(value.match(/../g), (byte) => Number.parseInt(byte, 16));

test("canonicalizes RFC 8785 number and string samples", () => {
  const input = JSON.parse(String.raw`{"numbers":[333333333.33333329,1e30,4.50,2e-3,1e-27],"string":"€$\u000f\u000aA'\u0042\u0022\u005c\\\"\/","literals":[null,true,false]}`);
  const expected = String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`;
  assert.equal(decoder.decode(canonicalJsonBytes(input)), expected);
});

test("canonicalizes object properties recursively without changing array order", () => {
  const first = { z: [{ second: 2, first: 1 }, "last"], a: true };
  const second = { a: true, z: [{ first: 1, second: 2 }, "last"] };
  assert.deepEqual(canonicalJsonBytes(first), canonicalJsonBytes(second));
  assert.equal(decoder.decode(canonicalJsonBytes(first)), '{"a":true,"z":[{"first":1,"second":2},"last"]}');
  assert.equal(decoder.decode(canonicalJsonBytes({ values: ["b", "a"] })), '{"values":["b","a"]}');
  assert.equal(decoder.decode(canonicalJsonBytes({ "\r": 1, "1": 2, "\u0080": 3, "ö": 4, "€": 5, "😀": 6, "דּ": 7 })), '{"\\r":1,"1":2,"\u0080":3,"ö":4,"€":5,"😀":6,"דּ":7}');
  assert.equal(decoder.decode(canonicalJsonBytes(-0)), "0");
});

test("rejects values outside the JSON/I-JSON domain", () => {
  const circular = {};
  circular.self = circular;
  const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => 1 });
  const symbolProperty = { [Symbol("not-json")]: 1 };
  const sparse = Array(1);

  for (const value of [undefined, 1n, Symbol("x"), () => {}, NaN, Infinity, -Infinity, new Date(), circular, accessor, symbolProperty, sparse, "\ud800", { "\udfff": 1 }]) {
    assert.throws(() => canonicalJsonBytes(value));
  }
});

test("signs complete records without the signature field", async (t) => {
  let pair;
  try {
    pair = await generateDeviceSigningKeyPair();
  } catch (error) {
    if (error.message === "ed25519-unavailable" || error.message === "webcrypto-unavailable") {
      t.skip(error.message);
      return;
    }
    throw error;
  }

  assert.equal(pair.privateKey.extractable, false);
  assert.equal(pair.publicKey.extractable, true);
  assert.deepEqual(pair.privateKey.usages, ["sign"]);
  assert.deepEqual(pair.publicKey.usages, ["verify"]);
  assert.equal((await exportDevicePublicKey(pair.publicKey)).length, 32);
  await assert.rejects(crypto.subtle.exportKey("pkcs8", pair.privateKey));

  const record = { id: "event-1", payload: { amount: 200, splits: [1, 2] }, groupId: "group-1" };
  const reordered = { groupId: "group-1", payload: { splits: [1, 2], amount: 200 }, id: "event-1" };
  assert.deepEqual(signedRecordBytes(record), signedRecordBytes(reordered));
  const signature = await signRecord(record, pair.privateKey);
  const signed = { ...record, signature };
  assert.equal(await verifyRecord(signed, pair.publicKey), true);
  assert.equal(await verifyRecord({ ...signed, payload: { ...record.payload, amount: 201 } }, pair.publicKey), false);
  assert.equal(await verifyRecord({ ...signed, signature: "not-a-signature" }, pair.publicKey), false);
  assert.equal(await verifyRecord({ ...signed, signature: `${signature}=` }, pair.publicKey), false);

  const other = await generateDeviceSigningKeyPair();
  assert.equal(await verifyRecord(signed, other.publicKey), false);
  await assert.rejects(signRecord(record, pair.publicKey), /unsupported-signing-key/);
  const hmacKey = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  await assert.rejects(signRecord(record, hmacKey), /unsupported-signing-key/);
  await assert.rejects(verifyRecord(signed, hmacKey), /unsupported-signing-key/);
});

test("passes the RFC 8032 Ed25519 test vector", async (t) => {
  const publicKeyBytes = fromHex("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  const signature = fromHex("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey("raw", publicKeyBytes, { name: "Ed25519" }, false, ["verify"]);
  } catch (error) {
    if (error?.name === "NotSupportedError") {
      t.skip("ed25519-unavailable");
      return;
    }
    throw error;
  }
  assert.equal(await crypto.subtle.verify({ name: "Ed25519" }, publicKey, signature, new Uint8Array()), true);
});
