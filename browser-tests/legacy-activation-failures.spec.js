import assert from "node:assert/strict";
import { expect, test } from "@playwright/test";

const sourceGroup = {
  name: "Old trip", currency: "USD", groupId: "11111111-1111-4111-8111-111111111111",
  people: [{ id: "old-alice", name: "Alice" }, { id: "old-bob", name: "Bob" }],
  events: [{ id: "22222222-2222-4222-8222-222222222222", type: "expense-created", description: "Old meal", amount: 1000,
    payerId: "old-alice", splits: [{ personId: "old-alice", amount: 500 }, { personId: "old-bob", amount: 500 }],
    createdAt: "2026-10-08T10:00:00.000Z" }], eventsById: {}, eventStoreFormatVersion: 1
};

async function openReview(page) {
  await page.goto("/");
  const sourceId = await page.evaluate(async (source) => {
    const { installLegacyGroup } = await import("/browser-tests/legacy-activation-fixture.js");
    return installLegacyGroup(source);
  }, sourceGroup);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Old trip" })).toBeVisible();
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Review legacy activation" }).click();
  return { sourceId, dialog: page.getByRole("dialog", { name: "Review legacy activation" }) };
}

async function stage(dialog) {
  const digest = await dialog.locator("code").first().textContent();
  await dialog.getByLabel("Choose the current source owner").selectOption("old-alice");
  await dialog.getByLabel("Type the source digest to approve").fill(digest);
  await dialog.getByRole("button", { name: "Approve digest and review mapping" }).click();
  await expect(dialog.getByRole("heading", { name: "Exact participant mapping" })).toBeVisible();
}

async function localState(page) {
  return page.evaluate(() => ({
    registry: JSON.parse(localStorage.getItem("div-it-groups")),
    pins: JSON.parse(localStorage.getItem("div-it-signed-group-trust-pins") || "{}")
  }));
}

async function assertNoActivation(page, sourceId) {
  const state = await localState(page);
  assert.equal(state.registry.activeDocumentId, sourceId);
  assert.equal(state.registry.groups.length, 1);
  assert.deepEqual(Object.keys(state.pins), []);
}

test("persisted proof corruption leaves the source active and permits retry", async ({ page }) => {
  const { sourceId, dialog } = await openReview(page);
  await stage(dialog);
  const sourceBefore = await page.evaluate(async (id) => (await (await import("/browser-tests/legacy-activation-fixture.js")).readGroup(id)), sourceId);
  await page.evaluate(async (sourceId) => {
    const { Repo } = await import("/node_modules/.vite/deps/@automerge_automerge-repo.js");
    const original = Repo.prototype.find;
    let corrupted = false;
    Repo.prototype.find = async function (id, ...args) {
      const handle = await original.call(this, id, ...args);
      if (!corrupted && id !== sourceId && handle.doc()?.signedGroupVersion === 1) {
        corrupted = true;
        handle.change((document) => { document.legacyAttestationsById = {}; });
        await this.flush([id]);
      }
      return handle;
    };
    window.restoreFind = () => { Repo.prototype.find = original; };
  }, sourceId);

  await dialog.getByRole("button", { name: "Confirm and activate signed group" }).click();
  await expect(dialog.getByRole("alert")).toContainText("persisted activation failed verification");
  await page.evaluate(() => window.restoreFind());
  await assertNoActivation(page, sourceId);
  const sourceAfter = await page.evaluate(async (id) => (await (await import("/browser-tests/legacy-activation-fixture.js")).readGroup(id)), sourceId);
  assert.deepEqual(sourceAfter, sourceBefore);

  await dialog.getByRole("button", { name: "Confirm and activate signed group" }).click();
  await expect(dialog).toBeHidden();
  const state = await localState(page);
  assert.equal(state.registry.groups.length, 2);
  assert.ok(state.pins[state.registry.activeDocumentId]);
});

test("source changed during persisted verification stays active and requires a fresh review", async ({ page }) => {
  const { sourceId, dialog } = await openReview(page);
  await stage(dialog);
  await page.evaluate(async (sourceId) => {
    const { Repo } = await import("/node_modules/.vite/deps/@automerge_automerge-repo.js");
    const original = Repo.prototype.find;
    let signalStarted;
    let release;
    const started = new Promise((resolve) => { signalStarted = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    window.findStarted = started;
    window.releaseFind = release;
    window.findPaused = false;
    Repo.prototype.find = async function (id, ...args) {
      const handle = await original.call(this, id, ...args);
      if (!window.findPaused && id !== sourceId && handle.doc()?.signedGroupVersion === 1) {
        window.findPaused = true;
        signalStarted();
        await gate;
      }
      return handle;
    };
    window.restoreFind = () => { Repo.prototype.find = original; };
  }, sourceId);

  await dialog.getByRole("button", { name: "Confirm and activate signed group" }).click();
  await page.evaluate(() => window.findStarted);
  const changedSource = await page.evaluate(async (id) => {
    const { mutateGroup, readGroup } = await import("/browser-tests/legacy-activation-fixture.js");
    await mutateGroup(id, (document) => { document.name = "Changed during proof verification"; });
    return readGroup(id);
  }, sourceId);
  await page.evaluate(() => window.releaseFind());
  await expect(dialog.getByRole("alert")).toContainText("source group changed during activation");
  await page.evaluate(() => window.restoreFind());
  await assertNoActivation(page, sourceId);
  assert.equal(changedSource.name, "Changed during proof verification");
  assert.deepEqual(await page.evaluate(async (id) => (await (await import("/browser-tests/legacy-activation-fixture.js")).readGroup(id)), sourceId), changedSource);

  await dialog.getByRole("button", { name: "Close" }).click();
  await page.getByRole("button", { name: "Review legacy activation" }).click();
  const refreshed = page.getByRole("dialog", { name: "Review legacy activation" });
  await stage(refreshed);
  await refreshed.getByRole("button", { name: "Confirm and activate signed group" }).click();
  await expect(refreshed).toBeHidden();
  const state = await localState(page);
  assert.equal(state.registry.groups.length, 2);
  assert.ok(state.pins[state.registry.activeDocumentId]);
});

test("trust-pin storage failure leaves the source active and permits retry", async ({ page }) => {
  const { sourceId, dialog } = await openReview(page);
  await stage(dialog);
  const sourceBefore = await page.evaluate(async (id) => (await (await import("/browser-tests/legacy-activation-fixture.js")).readGroup(id)), sourceId);
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    let failed = false;
    Storage.prototype.setItem = function (key, value) {
      if (!failed && key === "div-it-signed-group-trust-pins") {
        failed = true;
        throw new DOMException("trust-pin storage failure", "QuotaExceededError");
      }
      return original.call(this, key, value);
    };
    window.restoreStorage = () => { Storage.prototype.setItem = original; };
  });

  await dialog.getByRole("button", { name: "Confirm and activate signed group" }).click();
  await expect(dialog.getByRole("alert")).toContainText("trust-pin storage failure");
  await page.evaluate(() => window.restoreStorage());
  await assertNoActivation(page, sourceId);
  assert.deepEqual(await page.evaluate(async (id) => (await (await import("/browser-tests/legacy-activation-fixture.js")).readGroup(id)), sourceId), sourceBefore);

  await dialog.getByRole("button", { name: "Confirm and activate signed group" }).click();
  await expect(dialog).toBeHidden();
  const state = await localState(page);
  assert.equal(state.registry.groups.length, 2);
  assert.ok(state.pins[state.registry.activeDocumentId]);
});
