import assert from "node:assert/strict";
import { test } from "node:test";
import { balances, cents, makeExpense, settlementPlan } from "./src/ledger.js";

const people = [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }];
const events = [{ type: "expense", payerId: "a", amount: 1001, splits: [{ personId: "a", amount: 501 }, { personId: "b", amount: 500 }] }];

function assertZeroSum(balanceMap) {
  assert.equal(Object.values(balanceMap).reduce((sum, balance) => sum + balance, 0), 0);
}

test("converts positive amounts to whole cents", () => {
  assert.equal(cents("12.34"), 1234);
  assert.equal(cents(10.005), 1001);
});

test("rejects invalid, zero, and negative amounts", () => {
  for (const value of [NaN, Infinity, -1, 0, "", "not money"]) {
    assert.throws(() => cents(value), /Enter an amount greater than zero/);
  }
});

test("creates an expense with trimmed description and exact cents", () => {
  const expense = makeExpense({
    description: "  Lunch  ",
    amount: 1001,
    payerId: "a",
    splits: [{ personId: "a", amount: 501 }, { personId: "b", amount: 500 }],
    createdAt: "2026-01-01T00:00:00.000Z"
  });

  assert.match(expense.id, /^[0-9a-f-]{36}$/i);
  assert.deepEqual({ ...expense, id: undefined }, {
    id: undefined,
    type: "expense-created",
    description: "Lunch",
    amount: 1001,
    payerId: "a",
    splits: [{ personId: "a", amount: 501 }, { personId: "b", amount: 500 }],
    createdAt: "2026-01-01T00:00:00.000Z"
  });
});

test("rejects expenses with missing fields or invalid totals", () => {
  const validSplits = [{ personId: "a", amount: 500 }, { personId: "b", amount: 500 }];
  const expense = (overrides = {}) => makeExpense({ description: "Lunch", amount: 1000, payerId: "a", splits: validSplits, ...overrides });

  assert.throws(() => expense({ description: "   " }), /Enter a description/);
  assert.throws(() => expense({ payerId: "" }), /Choose payer and at least one participant/);
  assert.throws(() => expense({ splits: [] }), /Choose payer and at least one participant/);
  assert.throws(() => expense({ amount: 0 }), /positive whole cents/);
  assert.throws(() => expense({ amount: -1 }), /positive whole cents/);
  assert.throws(() => expense({ amount: 1000.5 }), /positive whole cents/);
  assert.throws(() => expense({ splits: [{ personId: "a", amount: 0 }] }), /positive whole cents/);
  assert.throws(() => expense({ splits: [{ personId: "a", amount: 500.5 }, { personId: "b", amount: 499.5 }] }), /positive whole cents/);
  assert.throws(() => expense({ splits: [{ personId: "a", amount: 600 }, { personId: "b", amount: 500 }] }), /Splits must equal total amount/);
});

test("calculates balances", () => {
  const balanceMap = balances(events, people);
  assert.deepEqual(balanceMap, { a: 500, b: -500 });
  assertZeroSum(balanceMap);
});

test("ignores unknown event types without changing balances", () => {
  const balanceMap = balances([{ type: "unknown", payerId: "a", amount: 1000, splits: [] }], people);
  assert.deepEqual(balanceMap, { a: 0, b: 0 });
  assertZeroSum(balanceMap);
});

test("creates a settlement plan", () => {
  assert.deepEqual(settlementPlan({ a: 500, b: -500 }), [{ from: "b", to: "a", amount: 500 }]);
  assert.deepEqual(settlementPlan({ a: 0, b: 0 }), []);
});
