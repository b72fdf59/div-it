import test from "node:test";
import assert from "node:assert/strict";
import { validateBackup, validateGroupSettings, validatePersonName } from "./src/group.js";

test("local command inputs are validated before document writes", () => {
  assert.equal(validatePersonName("  Ana  "), "Ana");
  assert.deepEqual(validateGroupSettings({ name: "  Trip  ", currency: "USD" }), { name: "Trip", currency: "USD" });
  assert.throws(() => validatePersonName("  "), /Enter a name/);
  assert.throws(() => validateGroupSettings({ name: "Trip", currency: "BAD" }), /supported currency/);
});

test("legacy prototype backup shape is accepted as a detached copy", () => {
  const backup = {
    name: "Trip",
    currency: "EUR",
    people: [{ id: "ana", name: "Ana" }],
    events: [{ id: "old-expense", type: "expense", amount: 100 }],
  };
  const imported = validateBackup(backup);
  imported.people[0].name = "Changed";
  assert.equal(backup.people[0].name, "Ana");
  assert.throws(() => validateBackup({ people: [], events: [] }), /Not a Div It backup/);
});

test("modern backup keeps the group identity carried by its events", () => {
  const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const event = { id: "11111111-1111-4111-8111-111111111111", schemaVersion: 1, groupId };
  assert.equal(validateBackup({ name: "Trip", currency: "USD", people: [], events: [event] }).groupId, groupId);
  assert.throws(() => validateBackup({ name: "Trip", currency: "USD", groupId, people: [], events: [{ ...event, groupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }] }), /does not match/);
  assert.throws(() => validateBackup({ name: "Trip", currency: "USD", people: [], events: [event, { ...event, id: "21111111-1111-4111-8111-111111111111", groupId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }] }), /multiple ledger groups/);
});
