const DB_NAME = "div-it";
const STORE_NAME = "state";
const GROUP_KEY = "group";

export const emptyGroup = () => ({ name: "My group", currency: "USD", people: [], events: [] });

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadGroup() {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME).objectStore(STORE_NAME).get(GROUP_KEY);
    request.onsuccess = () => resolve(request.result || emptyGroup());
    request.onerror = () => reject(request.error);
  });
}

export async function saveGroup(group) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, "readwrite").objectStore(STORE_NAME).put(group, GROUP_KEY);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
