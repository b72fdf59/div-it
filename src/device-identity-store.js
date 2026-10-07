import { exportDevicePublicKey, generateDeviceSigningKeyPair, signRecord, verifyRecord } from "./identity-crypto.js";

const DATABASE = "div-it-device-identity";
const STORE = "identities";
const SLOT = "local-device-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error("identity-storage-request-failed", { cause: request.error }));
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(new Error("identity-storage-transaction-failed", { cause: transaction.error }));
    transaction.onerror = () => reject(new Error("identity-storage-transaction-failed", { cause: transaction.error }));
  });
}

function openDatabase() {
  if (!globalThis.indexedDB) throw new Error("identity-storage-unavailable");
  return new Promise((resolve, reject) => {
    let blocked = false;
    const request = globalThis.indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(new Error("identity-storage-unavailable", { cause: request.error }));
    request.onblocked = () => {
      blocked = true;
      reject(new Error("identity-storage-blocked"));
    };
  });
}

function assertStoredShape(record) {
  if (!record || record.version !== 1 || !UUID.test(record.deviceId) || !UUID.test(record.keyId) ||
      record.privateKey?.type !== "private" || record.privateKey.algorithm?.name !== "Ed25519" ||
      record.privateKey.extractable !== false || !record.privateKey.usages?.includes("sign") ||
      record.publicKey?.type !== "public" || record.publicKey.algorithm?.name !== "Ed25519" ||
      record.publicKey.extractable !== true || !record.publicKey.usages?.includes("verify")) {
    throw new Error("identity-record-corrupt");
  }
}

async function validate(record) {
  assertStoredShape(record);
  try {
    const proof = { purpose: "device-identity-storage-check", deviceId: record.deviceId, keyId: record.keyId };
    const signature = await signRecord(proof, record.privateKey);
    if (!(await verifyRecord({ ...proof, signature }, record.publicKey))) throw new Error("key-mismatch");
    const publicKey = await exportDevicePublicKey(record.publicKey);
    if (publicKey.length !== 32) throw new Error("invalid-public-key");
  } catch (error) {
    throw new Error("identity-record-corrupt", { cause: error });
  }
  return {
    deviceId: record.deviceId,
    keyId: record.keyId,
    privateKey: record.privateKey,
    publicKey: record.publicKey
  };
}

async function createCandidate() {
  const pair = await generateDeviceSigningKeyPair();
  return {
    version: 1,
    deviceId: globalThis.crypto.randomUUID(),
    keyId: globalThis.crypto.randomUUID(),
    privateKey: pair.privateKey,
    publicKey: pair.publicKey
  };
}

export async function getOrCreateDeviceIdentity() {
  const database = await openDatabase();
  try {
    const read = database.transaction(STORE, "readonly");
    const readDone = transactionResult(read);
    let existing;
    try {
      existing = await requestResult(read.objectStore(STORE).get(SLOT));
      await readDone;
    } catch (error) {
      await readDone.catch(() => {});
      throw error;
    }
    if (existing !== undefined) return await validate(existing);

    const candidate = await createCandidate();
    const write = database.transaction(STORE, "readwrite");
    const writeDone = transactionResult(write);
    const store = write.objectStore(STORE);
    let winner;
    try {
      winner = await requestResult(store.get(SLOT));
      if (winner === undefined) store.add(candidate, SLOT);
      await writeDone;
    } catch (error) {
      await writeDone.catch(() => {});
      throw error;
    }
    return await validate(winner === undefined ? candidate : winner);
  } finally {
    database.close();
  }
}
