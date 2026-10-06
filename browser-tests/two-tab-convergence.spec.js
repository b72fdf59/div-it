import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";

async function addPerson(page, name) {
  await page.getByRole("button", { name: "Group", exact: true }).click();
  const people = page.getByRole("heading", { name: "People" }).locator("..");
  await page.getByLabel("Person name").fill(name);
  await people.getByRole("button", { name: "Add" }).click();
  await expect(people.getByRole("listitem").filter({ hasText: name })).toBeVisible();
}

async function addExpense(page, description, amount) {
  await page.getByRole("button", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Add expense" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Description").fill(description);
  await dialog.getByRole("textbox", { name: "Amount" }).fill(amount);
  await dialog.getByRole("checkbox", { name: "Bob" }).check();
  await dialog.getByRole("button", { name: "Add expense" }).click();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText(description);
}

async function revise(page, description, amount, payer) {
  await page.getByRole("button", { name: "Activity" }).click();
  const original = page.getByRole("listitem").filter({ hasText: "Shared dinner" });
  await original.getByRole("button", { name: "Revise expense" }).click();
  const dialog = page.getByRole("dialog", { name: "Revise expense" });
  await dialog.getByLabel("Description").fill(description);
  await dialog.getByRole("textbox", { name: "Amount" }).fill(amount);
  await dialog.getByLabel("Paid by").selectOption({ label: payer });
  await dialog.getByLabel("Split type").selectOption("equal");
  await dialog.getByRole("button", { name: "Save revision" }).click();
  await expect(page.locator("#notice")).toContainText("Expense revision saved locally");
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText(description);
}

async function exportBackup(page) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  return JSON.parse(await fs.readFile(await (await download).path(), "utf8"));
}

async function visibleAudit(page) {
  await page.getByRole("button", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Open audit history" }).click();
  await expect(page.getByRole("heading", { name: "Complete audit history" })).toBeVisible();
  return page.locator(".audit-entry").allTextContents();
}

test("offline tabs merge expenses and competing revisions over reconnected BroadcastChannel without refresh", async ({ page, context }) => {
  await page.goto("/?testSync=1");
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await addPerson(page, "Alice");
  await addPerson(page, "Bob");
  await addExpense(page, "Shared dinner", "20.00");

  const second = await context.newPage();
  const initialBinary = await page.evaluate(() => window.__divItTestSync.exportBinary());
  await second.addInitScript((binary) => sessionStorage.setItem("div-it-test-replica", JSON.stringify(binary)), initialBinary);
  // The second tab starts from the exact CRDT history in its own ephemeral Repo storage.
  await second.goto("/?testSync=1&testReplica=1");
  await expect(second.getByRole("button", { name: "Activity" })).toBeVisible();
  await expect(second.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("Shared dinner");
  assert.equal(await page.evaluate(() => typeof window.__divItTestSync?.disconnect), "function");
  assert.equal(await second.evaluate(() => typeof window.__divItTestSync?.disconnect), "function");

  // Disconnect the real Repo BroadcastChannel adapters before making any tab-local writes.
  await Promise.all([page, second].map((tab) => tab.evaluate(() => window.__divItTestSync.disconnect())));
  await addExpense(page, "Offline tab A expense", "4.00");
  await addExpense(second, "Offline tab B expense", "6.00");
  await revise(page, "Alice's offline revision", "30.00", "Alice");
  await revise(second, "Bob's offline revision", "40.00", "Bob");

  const firstOffline = await exportBackup(page);
  const secondOffline = await exportBackup(second);
  assert.ok(firstOffline.events.some(({ payload }) => payload?.description === "Offline tab A expense"));
  assert.ok(!firstOffline.events.some(({ payload }) => payload?.description === "Offline tab B expense"));
  assert.ok(secondOffline.events.some(({ payload }) => payload?.description === "Offline tab B expense"));
  assert.ok(!secondOffline.events.some(({ payload }) => payload?.description === "Offline tab A expense"));
  assert.notDeepEqual(firstOffline.events.map(({ id }) => id).sort(), secondOffline.events.map(({ id }) => id).sort());

  await page.evaluate(() => window.__divItTestSync.reconnect());
  await second.evaluate(() => window.__divItTestSync.reconnect());
  for (const tab of [page, second]) {
    await tab.getByRole("button", { name: "Activity" }).click();
    const activity = tab.getByRole("heading", { name: "Recent activity" }).locator("..");
    await expect(activity).toContainText("Offline tab A expense");
    await expect(activity).toContainText("Offline tab B expense");
    await expect(tab.locator(".conflict-card")).toContainText("Alice's offline revision");
    await expect(tab.locator(".conflict-card")).toContainText("Bob's offline revision");
  }

  const converge = async () => {
    const [a, b] = await Promise.all([exportBackup(page), exportBackup(second)]);
    assert.deepEqual(a.events, b.events);
    assert.deepEqual(a.people, b.people);
    assert.equal(new Set(a.events.map(({ id }) => id)).size, a.events.length);
    const audits = await Promise.all([visibleAudit(page), visibleAudit(second)]);
    assert.deepEqual(audits[0], audits[1]);
    return [a, b];
  };
  let [first, secondBackup] = await converge();
  const firstIds = first.events.map(({ id }) => id);
  const secondIds = secondBackup.events.map(({ id }) => id);
  assert.deepEqual(firstIds, secondIds);

  const balanceText = (tab) => tab.getByRole("heading", { name: "Everyone" }).locator("..").innerText();
  const assertBalancesConverged = async () => {
    await expect.poll(async () => {
      const [left, right] = await Promise.all([balanceText(page), balanceText(second)]);
      return left === right;
    }).toBe(true);
  };
  await Promise.all([page, second].map((tab) => tab.getByRole("button", { name: "Back to Activity" }).click()));
  await Promise.all([page, second].map((tab) => tab.getByRole("button", { name: "Balances" }).click()));
  await assertBalancesConverged();
  expect(await balanceText(page)).toContain("Owed $15.00");
  expect(await balanceText(second)).toContain("Owes $15.00");

  // Resolve the actual concurrent revision conflict in tab A; tab B must update live.
  await Promise.all([page, second].map((tab) => tab.getByRole("button", { name: "Activity", exact: true }).click()));
  const conflict = page.locator(".conflict-card");
  await conflict.locator("label.conflict-choice").filter({ hasText: "Alice's offline revision" }).locator('input[type="radio"]').check();
  await conflict.getByRole("button", { name: "Keep selected change" }).click();
  await expect(page.locator(".conflict-card")).toHaveCount(0);
  await expect(second.locator(".conflict-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Balances" }).click();
  await second.getByRole("button", { name: "Balances" }).click();
  await assertBalancesConverged();
  expect(await balanceText(page)).toContain("Owed $20.00");
  expect(await balanceText(second)).toContain("Owes $20.00");
  [first, secondBackup] = await converge();
  assert.deepEqual(first.events, secondBackup.events);
  assert.equal(first.events.filter(({ type }) => type === "conflict-resolved").length, 1);
});
