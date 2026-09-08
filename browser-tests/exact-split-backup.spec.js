import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";

async function addPerson(page, people, name) {
  const personInput = page.getByLabel("Person name");
  await personInput.fill(name);
  await people.getByRole("button", { name: "Add" }).click();
  await expect(people.getByRole("listitem").filter({ hasText: name })).toBeVisible();
}

test("preserves exact splits through reload and backup round-trip", async ({ browser, page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Div It" })).toBeVisible();

  const people = page.getByRole("heading", { name: "People" }).locator("..");
  await addPerson(page, people, "Alice");
  await addPerson(page, people, "Bob");

  await page.getByLabel("Description").fill("Shared dinner");
  await page.getByRole("textbox", { name: "Amount" }).fill("20.00");
  await page.getByRole("checkbox", { name: "Bob" }).check();
  await page.getByRole("combobox", { name: /Split type/ }).selectOption("exact");

  const exactSplits = page.locator(".exact-splits");
  await exactSplits.getByRole("textbox").nth(0).fill("12.34");
  await exactSplits.getByRole("textbox").nth(1).fill("7.66");
  await page.getByRole("button", { name: "Add expense" }).click();

  const history = page.getByRole("heading", { name: "History" }).locator("..");
  await expect(history).toContainText("Shared dinner");
  await expect(people).toContainText("$7.66");

  await page.reload();
  await expect(page.getByRole("heading", { name: "History" })).toBeVisible();
  await expect(history).toContainText("Shared dinner");
  await expect(people).toContainText("$7.66");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export backup" }).click();
  const backupPath = await (await downloadPromise).path();
  assert.ok(backupPath);
  const backup = JSON.parse(await fs.readFile(backupPath, "utf8"));
  const savedExpense = backup.events.find((event) => event.description === "Shared dinner");
  assert.deepEqual(savedExpense.splits, [
    { personId: savedExpense.splits[0].personId, amount: 1234 },
    { personId: savedExpense.splits[1].personId, amount: 766 }
  ]);

  const importedContext = await browser.newContext();
  const importedPage = await importedContext.newPage();
  await importedPage.goto("/");
  await expect(importedPage.getByRole("heading", { name: "Div It" })).toBeVisible();
  await importedPage.locator('input[type="file"]').setInputFiles({
    name: "div-it-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup))
  });

  await expect(importedPage.locator("#notice")).toHaveText("Backup imported.");
  await expect(importedPage.getByRole("heading", { name: "History" }).locator("..")).toContainText("Shared dinner");
  await expect(importedPage.getByRole("heading", { name: "People" }).locator("..")).toContainText("$7.66");
  await importedContext.close();
});
