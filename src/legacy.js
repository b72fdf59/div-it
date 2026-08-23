export async function legacyGroup() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open("div-it", 1);
    request.onupgradeneeded = () => resolve(request.result);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  if (!db.objectStoreNames.contains("state")) return null;
  return new Promise((resolve, reject) => {
    const request = db.transaction("state").objectStore("state").get("group");
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}
