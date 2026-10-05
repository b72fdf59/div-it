import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";

test("invalid backup metadata cannot replace a populated group", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await page.getByRole("button", { name: "Group" }).click();
  const people = page.getByRole("heading", { name: "People" }).locator("..");
  for (const name of ["Alice", "Bob"]) {
    await page.getByLabel("Person name").fill(name);
    await people.getByRole("button", { name: "Add" }).click();
    await expect(people.getByRole("listitem").filter({ hasText: name })).toBeVisible();
  }
  await page.getByRole("button", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Add expense" }).click();
  await page.getByLabel("Description").fill("Keep this expense");
  await page.getByRole("textbox", { name: "Amount" }).fill("20.00");
  await page.getByRole("checkbox", { name: "Bob" }).check();
  await page.getByRole("dialog").getByRole("button", { name: "Add expense" }).click();

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group" }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  const current = JSON.parse(await fs.readFile(await (await download).path(), "utf8"));
  const invalidBackups = [
    { ...current, people: [null] },
    { ...current, people: [current.people[0], { ...current.people[1], id: current.people[0].id }] },
    { ...current, people: [current.people[0], { ...current.people[1], name: "  " }] },
    { ...current, currency: "invalid" }
  ];
  for (const [index, backup] of invalidBackups.entries()) {
    await page.locator('input[type="file"]').setInputFiles({
      name: `invalid-${index}.json`, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup))
    });
    await expect(page.locator("#notice")).toContainText(index === 3 ? "supported currency" : index === 1 ? "duplicate participant IDs" : index === 2 ? "name" : "participant");
  }

  await page.reload();
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  const restoredDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Alice" })).toBeVisible();
  await expect(page.getByRole("listitem").filter({ hasText: "Bob" })).toBeVisible();
  await page.getByRole("button", { name: "Export backup" }).click();
  const restored = JSON.parse(await fs.readFile(await (await restoredDownload).path(), "utf8"));
  assert.deepEqual(restored.people, current.people);
  assert.deepEqual(restored.events, current.events);
  await page.getByRole("button", { name: "Balances" }).click();
  await expect(page.getByRole("heading", { name: "Everyone" }).locator("..")).toContainText("$10.00");

  await page.getByRole("button", { name: "Group" }).click();
  const legacy = {
    name: "Old trip", currency: "EUR", people: [{ id: "legacy-ana", name: "Ana" }, { id: "legacy-ben", name: "Ben" }],
    events: [{ id: "15151515-1515-4151-8151-151515151515", type: "expense", description: "Old meal", amount: 1000, payerId: "legacy-ana",
      splits: [{ personId: "legacy-ana", amount: 500 }, { personId: "legacy-ben", amount: 500 }] }]
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "legacy-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(legacy))
  });
  await expect(page.locator("#notice")).toHaveText("Backup imported.");
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("Old meal");
});
