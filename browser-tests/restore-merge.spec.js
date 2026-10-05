import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";

test("an older backup merges idempotently without erasing newer people or expenses", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await page.getByRole("button", { name: "Group" }).click();
  const people = page.getByRole("heading", { name: "People" }).locator("..");
  for (const name of ["Alice", "Bob"]) {
    await page.getByLabel("Person name").fill(name);
    await people.getByRole("button", { name: "Add" }).click();
  }
  await page.getByRole("button", { name: "Activity" }).click();
  const activity = page.getByRole("heading", { name: "Recent activity" }).locator("..");
  const addExpense = async (description, amount, payer, split) => {
    await page.getByRole("button", { name: "Add expense" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Description").fill(description);
    await dialog.getByRole("textbox", { name: "Amount" }).fill(amount);
    await dialog.getByLabel("Paid by").selectOption({ label: payer });
    if (split) await dialog.getByRole("checkbox", { name: split }).check();
    await dialog.getByRole("button", { name: "Add expense" }).click();
    await expect(activity).toContainText(description);
  };
  await addExpense("Older expense", "20.00", "Alice", "Bob");

  const oldDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group" }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  const oldBackup = JSON.parse(await fs.readFile(await (await oldDownload).path(), "utf8"));

  await page.getByRole("button", { name: "Activity" }).click();
  await addExpense("Newer expense", "10.00", "Bob", "Alice");
  await page.getByRole("button", { name: "Group" }).click();
  await page.getByLabel("Person name").fill("Cara");
  await people.getByRole("button", { name: "Add" }).click();

  const beforeRejectedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup" }).click();
  const beforeRejected = JSON.parse(await fs.readFile(await (await beforeRejectedDownload).path(), "utf8"));
  const collision = { ...oldBackup, events: oldBackup.events.map((event) => ({ ...event, signature: "changed same-ID content" })) };
  const malformed = { ...oldBackup, events: [{ id: "33333333-3333-4333-8333-333333333333", type: "expense", amount: -1 }] };
  for (const [index, backup] of [collision, malformed].entries()) {
    await page.locator('input[type="file"]').setInputFiles({
      name: `invalid-restore-${index}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup))
    });
    await expect(page.locator("#notice")).toContainText(index === 0 ? "conflicts with this group" : "invalid ledger events");
  }
  const afterRejectedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup" }).click();
  const afterRejected = JSON.parse(await fs.readFile(await (await afterRejectedDownload).path(), "utf8"));
  assert.deepEqual(afterRejected, beforeRejected);

  const oldEvents = oldBackup.events;
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.locator('input[type="file"]').setInputFiles({
      name: "older-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(oldBackup))
    });
    await expect(page.locator("#notice")).toHaveText("Backup imported.");
  }
  await page.reload();
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("Older expense");
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("Newer expense");
  await page.getByRole("button", { name: "Group" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Cara" })).toBeVisible();

  const mergedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup" }).click();
  const merged = JSON.parse(await fs.readFile(await (await mergedDownload).path(), "utf8"));
  assert.equal(merged.groupId, oldBackup.groupId);
  assert.deepEqual(merged.people, [...oldBackup.people, merged.people.find(({ name }) => name === "Cara")]);
  assert.deepEqual(merged.events.filter((event) => oldEvents.some((old) => old.id === event.id)), oldEvents);
  assert.equal(merged.events.length, 2);

  await page.getByRole("button", { name: "Balances" }).click();
  const balances = page.getByRole("heading", { name: "Everyone" }).locator("..");
  await expect(balances).toContainText("Alice");
  await expect(balances).toContainText("Owed $5.00");
  await expect(balances).toContainText("Bob");
  await expect(balances).toContainText("Owes $5.00");
  await expect(balances).toContainText("Cara");
  await expect(balances).toContainText("Settled");
});
