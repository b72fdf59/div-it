import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";

async function exportBackup(page) {
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  return JSON.parse(await fs.readFile(await (await download).path(), "utf8"));
}

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
  await dialog.getByRole("button", { name: "Add expense" }).click();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText(description);
}

test("migrates the prior single-group key and isolates groups across switching and reload", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await addPerson(page, "Alice");
  await addPerson(page, "Bob");
  await addExpense(page, "First group dinner", "20.00");
  const original = await exportBackup(page);
  const originalId = await page.evaluate(() => localStorage.getItem("div-it-group-id"));

  await page.evaluate(() => localStorage.removeItem("div-it-groups"));
  await page.reload();
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  assert.equal(await page.evaluate(() => localStorage.getItem("div-it-group-id")), originalId);
  const migratedRegistry = await page.evaluate(() => JSON.parse(localStorage.getItem("div-it-groups")));
  assert.equal(migratedRegistry.activeDocumentId, originalId);
  assert.deepEqual(migratedRegistry.groups.map(({ documentId }) => documentId), [originalId]);
  assert.deepEqual(await exportBackup(page), original);

  await page.getByRole("button", { name: "Create new" }).click();
  await expect(page.getByRole("heading", { name: "New group" })).toBeVisible();
  await addPerson(page, "Cara");
  await addExpense(page, "Second group snack", "5.00");
  const secondId = await page.evaluate(() => JSON.parse(localStorage.getItem("div-it-groups")).activeDocumentId);
  assert.notEqual(secondId, originalId);

  await expect(page.getByRole("heading", { name: "New group" })).toBeVisible();
  await page.getByLabel("Current group").selectOption(originalId);
  await expect(page.getByRole("heading", { name: "My group" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Alice" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("First group dinner");
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).not.toContainText("Second group snack");

  await page.getByRole("button", { name: "Open audit history" }).click();
  await expect(page.getByRole("heading", { name: "Complete audit history" })).toBeVisible();
  await expect(page.locator(".audit-entry")).toContainText("First group dinner");
  await page.getByLabel("Current group").selectOption(secondId);
  await expect(page.getByRole("heading", { name: "New group" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Complete audit history" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open audit history" }).click();
  await expect(page.locator(".audit-entry")).toContainText("Second group snack");
  await expect(page.locator(".audit-entry")).not.toContainText("First group dinner");
  await page.getByRole("button", { name: "Back to Activity" }).click();

  await page.getByLabel("Current group").selectOption(originalId);
  await expect(page.getByRole("heading", { name: "My group" })).toBeVisible();
  await page.getByRole("button", { name: "Add expense" }).click();
  await page.getByRole("dialog").getByLabel("Description").fill("Draft from first group");
  await page.evaluate((documentId) => {
    const select = document.querySelector('[aria-label="Current group"]');
    select.value = documentId;
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }, secondId);
  await expect(page.getByRole("heading", { name: "New group" })).toBeVisible();
  await page.getByRole("button", { name: "Add expense" }).click();
  await expect(page.getByRole("dialog").getByLabel("Description")).toHaveValue("");
  await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

  await expect(page.getByRole("heading", { name: "New group" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Cara" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Alice" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("Second group snack");
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).not.toContainText("First group dinner");
  await page.getByRole("button", { name: "Balances" }).click();
  const everyone = page.getByRole("heading", { name: "Everyone" }).locator("..");
  await expect(everyone).toContainText("Cara");
  await expect(everyone).not.toContainText("Alice");

  await page.reload();
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "New group" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("Second group snack");
  await page.getByLabel("Current group").selectOption(originalId);
  await expect(page.getByRole("heading", { name: "My group" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Alice" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("First group dinner");
});
