import assert from "node:assert/strict";
import { test } from "node:test";
import { balances, settlementPlan } from "./src/ledger.js";

const people = [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }];
const events = [{ type: "expense", payerId: "a", amount: 1001, splits: [{ personId: "a", amount: 501 }, { personId: "b", amount: 500 }] }];

test("calculates balances", () => {
  assert.deepEqual(balances(events, people), { a: 500, b: -500 });
});

test("creates a settlement plan", () => {
  assert.deepEqual(settlementPlan({ a: 500, b: -500 }), [{ from: "b", to: "a", amount: 500 }]);
});
