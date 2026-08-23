import { openGroup } from "./src/group.js";

function demoState() {
  const alice = { id: crypto.randomUUID(), name: "Alice" };
  const bob = { id: crypto.randomUUID(), name: "Bob" };
  const carol = { id: crypto.randomUUID(), name: "Carol" };
  const event = (description, amount, payerId, splits) => ({ id: crypto.randomUUID(), type: "expense-created", description, amount, payerId, splits, createdAt: new Date().toISOString() });
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
  const group = await openGroup(() => {});
  group.replace(state);
  return state;
}
