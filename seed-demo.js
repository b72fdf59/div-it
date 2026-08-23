const DB_NAME = "div-it";
const STORE = "state";
const KEY = "group";

function demoState() {
  const alice = { id: crypto.randomUUID(), name: "Alice" };
  const bob = { id: crypto.randomUUID(), name: "Bob" };
  const carol = { id: crypto.randomUUID(), name: "Carol" };
  const event = (description, amount, payerId, splits) => ({ id: crypto.randomUUID(), type: "expense", description, amount, payerId, splits, createdAt: new Date().toISOString() });
  return {
    name: "Weekend in Seoul",
    currency: "USD",
    people: [alice, bob, carol],
    events: [
      event("Airport taxi", 4500, alice.id, [{ personId: alice.id, amount: 1500 }, { personId: bob.id, amount: 1500 }, { personId: carol.id, amount: 1500 }]),
      event("Dinner", 7200, bob.id, [{ personId: alice.id, amount: 2400 }, { personId: bob.id, amount: 2400 }, { personId: carol.id, amount: 2400 }]),
      event("Museum tickets", 3600, carol.id, [{ personId: alice.id, amount: 1800 }, { personId: carol.id, amount: 1800 }]),
    ],
  };
}

export async function seedDemo() {
  const state = demoState();
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const request = db.transaction(STORE, "readwrite").objectStore(STORE).put(state, KEY);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
  return state;
}
