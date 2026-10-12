import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";

const sourceGroup = {
  name: "Old trip", currency: "USD", groupId: "11111111-1111-4111-8111-111111111111",
  people: [{ id: "old-alice", name: "Alice" }, { id: "old-bob", name: "Bob" }],
  events: [{ id: "22222222-2222-4222-8222-222222222222", type: "expense-created", description: "Old meal", amount: 1000,
    payerId: "old-alice", splits: [{ personId: "old-alice", amount: 500 }, { personId: "old-bob", amount: 500 }],
    createdAt: "2026-10-08T10:00:00.000Z" }], eventsById: {}, eventStoreFormatVersion: 1
};

async function loadLegacyGroup(page) {
  await page.goto("/");
  const sourceId = await page.evaluate(async (source) => {
    const { installLegacyGroup } = await import("/browser-tests/legacy-activation-fixture.js");
    return installLegacyGroup(source);
  }, sourceGroup);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Old trip" })).toBeVisible();
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Review legacy activation" }).click();
  return sourceId;
}

async function stage(page) {
  const dialog = page.getByRole("dialog", { name: "Review legacy activation" });
  const digest = await dialog.locator("code").first().textContent();
  await dialog.getByLabel("Choose the current source owner").selectOption("old-alice");
  await dialog.getByLabel("Type the source digest to approve").fill(digest);
  await dialog.getByRole("button", { name: "Approve digest and review mapping" }).click();
  await expect(dialog.getByRole("heading", { name: "Exact participant mapping" })).toBeVisible();
  return dialog;
}

test("activates a reviewed legacy group atomically, preserving source and proof archive", async ({ page }) => {
  const sourceId = await loadLegacyGroup(page);
  const dialog = await stage(page);
  const mappingRows = await dialog.locator("ul").nth(1).locator("li").allTextContents();
  assert.equal(mappingRows.length, 2);
  assert.ok(mappingRows.some((row) => row.startsWith("Alice → ")));
  const before = await page.evaluate(async (id) => (await (await import("/browser-tests/legacy-activation-fixture.js")).readGroup(id)), sourceId);
  await dialog.getByRole("button", { name: "Confirm and activate signed group" }).click();
  await dialog.press("Escape");
  await expect(dialog).toBeVisible();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Signed local group", { exact: false })).toBeVisible();
  const state = await page.evaluate(() => ({ registry: JSON.parse(localStorage.getItem("div-it-groups")), pins: JSON.parse(localStorage.getItem("div-it-signed-group-trust-pins")) }));
  assert.equal(state.registry.groups.length, 2);
  const targetId = state.registry.activeDocumentId;
  assert.notEqual(targetId, sourceId);
  assert.ok(state.pins[targetId]);
  const after = await page.evaluate(async (id) => (await (await import("/browser-tests/legacy-activation-fixture.js")).readGroup(id)), sourceId);
  assert.deepEqual(after, before);
  const target = await page.evaluate(async (id) => (await (await import("/browser-tests/legacy-activation-fixture.js")).readGroup(id)), targetId);
  assert.equal(target.signedGroupVersion, 1);
  assert.equal(Object.keys(target.membershipRecordsById).length, 2);
  assert.equal(Object.keys(target.ledgerRecordsById).length, 1);
  assert.equal(Object.keys(target.legacyAttestationsById).length, 1);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Old trip" })).toBeVisible();
  await expect(page.getByText("Signed local group", { exact: false })).toBeVisible();
});

test("rolls back a registry write failure and retries the staged activation", async ({ page }) => {
  const sourceId = await loadLegacyGroup(page);
  const dialog = await stage(page);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function (key, value) {
      if (!failed && key === "div-it-groups") { failed = true; throw new DOMException("storage failure", "QuotaExceededError"); }
      return original.call(this, key, value);
    };
    window.restoreStorage = () => { Storage.prototype.setItem = original; };
  });
  await dialog.getByRole("button", { name: "Confirm and activate signed group" }).click();
  await expect(dialog.getByRole("alert")).toContainText("storage failure");
  let state = await page.evaluate(() => ({ registry: JSON.parse(localStorage.getItem("div-it-groups")), pins: JSON.parse(localStorage.getItem("div-it-signed-group-trust-pins") || "{}") }));
  assert.equal(state.registry.activeDocumentId, sourceId);
  assert.equal(state.registry.groups.length, 1);
  assert.deepEqual(Object.keys(state.pins), []);
  await page.evaluate(() => window.restoreStorage());
  await dialog.getByRole("button", { name: "Confirm and activate signed group" }).click();
  await expect(dialog).toBeHidden();
  state = await page.evaluate(() => JSON.parse(localStorage.getItem("div-it-groups")));
  assert.equal(state.groups.length, 2);
  assert.notEqual(state.activeDocumentId, sourceId);
});

test("rejects stale source data after the mapping review without publishing a new group", async ({ page }) => {
  const sourceId = await loadLegacyGroup(page);
  const dialog = await stage(page);
  await page.evaluate(async (id) => {
    const { mutateGroup } = await import("/browser-tests/legacy-activation-fixture.js");
    await mutateGroup(id, (document) => { document.name = "Changed during review"; });
  }, sourceId);
  await dialog.getByRole("button", { name: "Confirm and activate signed group" }).click();
  await expect(dialog.getByRole("alert")).toContainText("source group changed");
  const state = await page.evaluate(() => ({ registry: JSON.parse(localStorage.getItem("div-it-groups")), pins: JSON.parse(localStorage.getItem("div-it-signed-group-trust-pins") || "{}") }));
  assert.equal(state.registry.activeDocumentId, sourceId);
  assert.equal(state.registry.groups.length, 1);
  assert.deepEqual(Object.keys(state.pins), []);
});

test("cancels a stage when the owner closes the review dialog while signing", async ({ page }) => {
  await loadLegacyGroup(page);
  let dialog = page.getByRole("dialog", { name: "Review legacy activation" });
  const digest = await dialog.locator("code").first().textContent();
  await dialog.getByLabel("Choose the current source owner").selectOption("old-alice");
  await dialog.getByLabel("Type the source digest to approve").fill(digest);
  await page.evaluate(() => {
    const original = SubtleCrypto.prototype.sign;
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    window.signEntered = false;
    SubtleCrypto.prototype.sign = async function (...args) {
      window.signEntered = true;
      await blocked;
      return original.apply(this, args);
    };
    window.releaseStageSign = () => release();
    window.restoreStageSign = () => { SubtleCrypto.prototype.sign = original; };
  });
  await dialog.getByRole("button", { name: "Approve digest and review mapping" }).evaluate((button) => button.click());
  await expect.poll(() => page.evaluate(() => window.signEntered)).toBe(true);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
  await page.evaluate(() => { window.releaseStageSign(); window.restoreStageSign(); });
  await page.getByRole("button", { name: "Review legacy activation" }).click();
  dialog = page.getByRole("dialog", { name: "Review legacy activation" });
  const stageButton = dialog.getByRole("button", { name: "Approve digest and review mapping" });
  const refreshedDigest = await dialog.locator("code").first().textContent();
  await dialog.getByLabel("Choose the current source owner").selectOption("old-alice");
  await dialog.getByLabel("Type the source digest to approve").fill(refreshedDigest);
  await expect(stageButton).toBeEnabled();
  await expect(dialog.getByRole("heading", { name: "Exact participant mapping" })).toHaveCount(0);
  await stageButton.click();
  await expect(dialog.getByRole("heading", { name: "Exact participant mapping" })).toBeVisible();
});

test("a document flush failure leaves source active and allows retry", async ({ page }) => {
  const sourceId = await loadLegacyGroup(page);
  const dialog = await stage(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    let failed = false;
    IDBObjectStore.prototype.put = function (...args) {
      if (!failed) { failed = true; throw new DOMException("disk write failed", "QuotaExceededError"); }
      return original.apply(this, args);
    };
    window.restoreStorage = () => { IDBObjectStore.prototype.put = original; };
  });
  await dialog.getByRole("button", { name: "Confirm and activate signed group" }).click();
  await expect(dialog.getByRole("alert")).toContainText("flush");
  let state = await page.evaluate(() => ({ registry: JSON.parse(localStorage.getItem("div-it-groups")), pins: JSON.parse(localStorage.getItem("div-it-signed-group-trust-pins") || "{}") }));
  assert.equal(state.registry.activeDocumentId, sourceId);
  assert.equal(state.registry.groups.length, 1);
  assert.deepEqual(Object.keys(state.pins), []);
  await page.evaluate(() => window.restoreStorage());
  await dialog.getByRole("button", { name: "Confirm and activate signed group" }).click();
  await expect(dialog).toBeHidden();
  state = await page.evaluate(() => JSON.parse(localStorage.getItem("div-it-groups")));
  assert.equal(state.groups.length, 2);
});

test("review rejects a hidden Automerge conflict variant", async ({ page }) => {
  await page.goto("/");
  const conflict = (amount) => ({ id: "22222222-2222-4222-8222-222222222222", type: "expense-created", description: "Conflicted meal",
    amount, payerId: "old-alice", splits: [{ personId: "old-alice", amount: amount / 2 }, { personId: "old-bob", amount: amount / 2 }],
    createdAt: "2026-10-08T10:00:00.000Z" });
  await page.evaluate(async ({ source, left, right }) => {
    const { installLegacyConflictGroup } = await import("/browser-tests/legacy-activation-fixture.js");
    return installLegacyConflictGroup(source, left, right);
  }, { source: { ...sourceGroup, events: [] }, left: conflict(1000), right: conflict(1200) });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Old trip" })).toBeVisible();
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Review legacy activation" }).click();
  const dialog = page.getByRole("dialog", { name: "Review legacy activation" });
  await expect(dialog.getByRole("alert")).toContainText("id-content-collision");
  await expect(dialog.getByRole("button", { name: "Approve digest and review mapping" })).toHaveCount(0);
});
