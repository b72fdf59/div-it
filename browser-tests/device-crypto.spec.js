import assert from "node:assert/strict";
import { test } from "@playwright/test";

test("browser supports non-extractable Ed25519 device signing", async ({ page, browserName }, testInfo) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    try {
      const {
        exportDevicePublicKey,
        generateDeviceSigningKeyPair,
        signRecord,
        verifyRecord
      } = await import("/src/identity-crypto.js");
      const pair = await generateDeviceSigningKeyPair();
      const otherPair = await generateDeviceSigningKeyPair();
      const publicBytes = await exportDevicePublicKey(pair.publicKey);
      const record = { id: "browser-check", payload: { amount: 10 } };
      const signature = await signRecord(record, pair.privateKey);
      const signed = { ...record, signature };
      const knownPublic = Uint8Array.from("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a".match(/../g), (byte) => parseInt(byte, 16));
      const knownSignature = Uint8Array.from("e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b".match(/../g), (byte) => parseInt(byte, 16));
      const knownKey = await crypto.subtle.importKey("raw", knownPublic, { name: "Ed25519" }, false, ["verify"]);
      return {
        supported: true,
        privateNotExtractable: !pair.privateKey.extractable,
        publicExportable: pair.publicKey.extractable && publicBytes.length === 32,
        signatureLength: atob(signature.replace(/-/g, "+").replace(/_/g, "/") + "==").length,
        verifies: await verifyRecord(signed, pair.publicKey),
        rejectsChangedContent: !(await verifyRecord({ ...signed, payload: { amount: 11 } }, pair.publicKey)),
        rejectsWrongKey: !(await verifyRecord(signed, otherPair.publicKey)),
        rfc8032Vector: await crypto.subtle.verify({ name: "Ed25519" }, knownKey, knownSignature, new Uint8Array())
      };
    } catch (error) {
      return { supported: false, name: error?.name, message: error?.message };
    }
  });

  if (!result.supported && ["NotSupportedError", "ed25519-unavailable", "webcrypto-unavailable"].some((reason) => `${result.name}:${result.message}`.includes(reason))) {
    testInfo.annotations.push({ type: "unsupported-runtime", description: `${browserName}: ${result.message}` });
    test.skip(true, `${browserName} does not support Web Crypto Ed25519`);
  }
  assert.equal(result.supported, true, JSON.stringify(result));
  assert.deepEqual({
    privateNotExtractable: result.privateNotExtractable,
    publicExportable: result.publicExportable,
    signatureLength: result.signatureLength,
    verifies: result.verifies,
    rejectsChangedContent: result.rejectsChangedContent,
    rejectsWrongKey: result.rejectsWrongKey,
    rfc8032Vector: result.rfc8032Vector
  }, {
    privateNotExtractable: true,
    publicExportable: true,
    signatureLength: 64,
    verifies: true,
    rejectsChangedContent: true,
    rejectsWrongKey: true,
    rfc8032Vector: true
  });
});
