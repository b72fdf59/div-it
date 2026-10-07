import assert from "node:assert/strict";
import { test } from "@playwright/test";

test("device identity persists through reload and its private key remains non-extractable", async ({ page }) => {
  await page.goto("/");
  const before = await page.evaluate(async () => {
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    const { signRecord, verifyRecord } = await import("/src/identity-crypto.js");
    const identity = await getOrCreateDeviceIdentity();
    const record = { purpose: "reload-check", deviceId: identity.deviceId };
    const signature = await signRecord(record, identity.privateKey);
    let privateExportRejected = false;
    try {
      await crypto.subtle.exportKey("pkcs8", identity.privateKey);
    } catch {
      privateExportRejected = true;
    }
    return {
      deviceId: identity.deviceId,
      keyId: identity.keyId,
      record,
      signature,
      privateNotExtractable: !identity.privateKey.extractable,
      privateExportRejected,
      verifies: await verifyRecord({ ...record, signature }, identity.publicKey)
    };
  });
  await page.reload();
  const after = await page.evaluate(async (expected) => {
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    const { verifyRecord } = await import("/src/identity-crypto.js");
    const identity = await getOrCreateDeviceIdentity();
    return {
      deviceId: identity.deviceId,
      keyId: identity.keyId,
      verifiesPriorSignature: await verifyRecord({ ...expected.record, signature: expected.signature }, identity.publicKey)
    };
  }, before);
  assert.deepEqual(after, {
    deviceId: before.deviceId,
    keyId: before.keyId,
    verifiesPriorSignature: true
  });
  assert.equal(before.privateNotExtractable, true);
  assert.equal(before.privateExportRejected, true);
  assert.equal(before.verifies, true);
});

test("concurrent tabs use one identity and separate browser contexts get distinct identities", async ({ page, browser }) => {
  await page.goto("/");
  const secondTab = await page.context().newPage();
  await secondTab.goto("/");
  const initialize = () => page.evaluate(async () => {
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    const identity = await getOrCreateDeviceIdentity();
    return { deviceId: identity.deviceId, keyId: identity.keyId };
  });
  const initializeSecond = () => secondTab.evaluate(async () => {
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    const identity = await getOrCreateDeviceIdentity();
    return { deviceId: identity.deviceId, keyId: identity.keyId };
  });
  const [first, second] = await Promise.all([initialize(), initializeSecond()]);
  assert.deepEqual(first, second);

  const isolated = await browser.newContext();
  const isolatedPage = await isolated.newPage();
  await isolatedPage.goto("http://127.0.0.1:5173/");
  const other = await isolatedPage.evaluate(async () => {
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    const identity = await getOrCreateDeviceIdentity();
    return { deviceId: identity.deviceId, keyId: identity.keyId };
  });
  assert.notDeepEqual(other, first);
  await isolated.close();
  await secondTab.close();
});

test("corrupt persisted identity fails without replacing the record", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("div-it-device-identity", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("identities");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("identities", "readwrite");
      transaction.objectStore("identities").put({ version: 1, deviceId: "broken" }, "local-device-v1");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    let message;
    try {
      await getOrCreateDeviceIdentity();
    } catch (error) {
      message = error.message;
    }
    const retained = await new Promise((resolve, reject) => {
      const request = db.transaction("identities").objectStore("identities").get("local-device-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    db.close();
    return { message, retained };
  });
  assert.equal(result.message, "identity-record-corrupt");
  assert.deepEqual(result.retained, { version: 1, deviceId: "broken" });
});

test("mismatched persisted signing keys fail without replacing the record", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { generateDeviceSigningKeyPair, exportDevicePublicKey } = await import("/src/identity-crypto.js");
    const first = await generateDeviceSigningKeyPair();
    const second = await generateDeviceSigningKeyPair();
    const expectedPublic = Array.from(await exportDevicePublicKey(second.publicKey));
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("div-it-device-identity", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("identities");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("identities", "readwrite");
      transaction.objectStore("identities").put({
        version: 1,
        deviceId: crypto.randomUUID(),
        keyId: crypto.randomUUID(),
        privateKey: first.privateKey,
        publicKey: second.publicKey
      }, "local-device-v1");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    let message;
    try {
      await getOrCreateDeviceIdentity();
    } catch (error) {
      message = error.message;
    }
    const retained = await new Promise((resolve, reject) => {
      const request = db.transaction("identities").objectStore("identities").get("local-device-v1");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const retainedPublic = Array.from(await exportDevicePublicKey(retained.publicKey));
    db.close();
    return { message, retainedPublic, expectedPublic };
  });
  assert.equal(result.message, "identity-record-corrupt");
  assert.deepEqual(result.retainedPublic, result.expectedPublic);
});

test("unavailable IndexedDB fails explicitly", async ({ page }) => {
  await page.goto("/");
  const message = await page.evaluate(async () => {
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: undefined });
    try {
      await getOrCreateDeviceIdentity();
      return "unexpected-success";
    } catch (error) {
      return error.message;
    }
  });
  assert.equal(message, "identity-storage-unavailable");
});

test("unavailable Web Crypto fails explicitly without creating an identity", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
    let message;
    try {
      await getOrCreateDeviceIdentity();
    } catch (error) {
      message = error.message;
    }
    const stored = await new Promise((resolve, reject) => {
      const request = indexedDB.open("div-it-device-identity", 1);
      request.onsuccess = () => {
        const db = request.result;
        const get = db.transaction("identities").objectStore("identities").get("local-device-v1");
        get.onsuccess = () => { db.close(); resolve(get.result); };
        get.onerror = () => reject(get.error);
      };
      request.onerror = () => reject(request.error);
    });
    return { message, hasStoredIdentity: stored !== undefined };
  });
  assert.deepEqual(result, { message: "webcrypto-unavailable", hasStoredIdentity: false });
});

test("blocked database open closes a late connection", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    let closed = false;
    const fakeDb = { close: () => { closed = true; } };
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
      open() {
        const request = {};
        setTimeout(() => request.onblocked?.(), 0);
        setTimeout(() => { request.result = fakeDb; request.onsuccess?.(); }, 5);
        return request;
      }
    } });
    let message;
    try {
      await getOrCreateDeviceIdentity();
    } catch (error) {
      message = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return { message, closed };
  });
  assert.deepEqual(result, { message: "identity-storage-blocked", closed: true });
});

test("transaction abort is observed when its read request fails", async ({ page }) => {
  await page.goto("/");
  const result = await page.evaluate(async () => {
    const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
    const unhandled = [];
    const onUnhandled = (event) => { unhandled.push(String(event.reason)); event.preventDefault(); };
    addEventListener("unhandledrejection", onUnhandled);
    const transaction = {};
    transaction.objectStore = () => ({
      get() {
        const request = {};
        setTimeout(() => {
          request.error = new Error("read-failed");
          request.onerror?.();
          transaction.error = new Error("transaction-aborted");
          transaction.onabort?.();
        }, 0);
        return request;
      }
    });
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: {
      open() {
        const request = {};
        setTimeout(() => { request.result = { transaction: () => transaction, close() {} }; request.onsuccess?.(); }, 0);
        return request;
      }
    } });
    let message;
    try {
      await getOrCreateDeviceIdentity();
    } catch (error) {
      message = error.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    removeEventListener("unhandledrejection", onUnhandled);
    return { message, unhandled };
  });
  assert.equal(result.message, "identity-storage-request-failed");
  assert.deepEqual(result.unhandled, []);
});
