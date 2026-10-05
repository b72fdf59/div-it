import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";

test("revises and voids an expense without deleting its prior events", async ({ page }) => {
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
  await page.getByLabel("Description").fill("Dinner");
  await page.getByRole("textbox", { name: "Amount" }).fill("20.00");
  await page.getByRole("checkbox", { name: "Bob" }).check();
  await page.getByRole("dialog").getByRole("button", { name: "Add expense" }).click();
  const history = page.getByRole("heading", { name: "Recent activity" }).locator("..");
  const original = page.getByRole("listitem").filter({ hasText: "Dinner" });
  await original.getByRole("button", { name: "Revise expense" }).click();
  const reviseDialog = page.getByRole("dialog", { name: "Revise expense" });
  await reviseDialog.getByLabel("Description").fill("Dinner adjustment");
  await reviseDialog.getByRole("textbox", { name: "Amount" }).fill("15.00");
  await reviseDialog.getByLabel("Paid by").selectOption({ label: "Bob" });
  await reviseDialog.getByLabel("Split type").selectOption("exact");
  const splits = reviseDialog.locator(".exact-splits");
  await splits.getByRole("textbox").nth(0).fill("5.00");
  await splits.getByRole("textbox").nth(1).fill("10.00");
  await reviseDialog.getByRole("button", { name: "Save revision" }).click();
  await expect(history).toContainText("Dinner adjustment");
  await expect(history).toContainText("Effective revision");
  await page.getByRole("button", { name: "Balances" }).click();
  const everyone = page.getByRole("heading", { name: "Everyone" }).locator("..");
  await expect(everyone).toContainText("Owes $5.00");
  await page.reload();
  await page.getByRole("button", { name: "Balances" }).click();
  await expect(page.getByRole("heading", { name: "Everyone" }).locator("..")).toContainText("Owes $5.00");

  await page.getByRole("button", { name: "Activity" }).click();
  const revised = page.getByRole("listitem").filter({ hasText: "Dinner adjustment" });
  await revised.getByRole("button", { name: "Void expense" }).click();
  await page.getByLabel("Reason for voiding").fill("Duplicate receipt");
  await page.getByRole("button", { name: "Confirm void" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Expense voided" })).toContainText("Duplicate receipt");
  await page.getByRole("button", { name: "Balances" }).click();
  await expect(page.getByRole("heading", { name: "Everyone" }).locator("..")).toContainText("AliceSettledBobSettled");
  await page.reload();
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Expense voided" })).toContainText("Duplicate receipt");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group" }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  const backup = JSON.parse(await fs.readFile(await (await downloadPromise).path(), "utf8"));
  assert.deepEqual(backup.events.map(({ type }) => type).sort(), ["expense-created", "expense-revised", "expense-voided"].sort());
  const created = backup.events.find(({ type }) => type === "expense-created");
  const changed = backup.events.find(({ type }) => type === "expense-revised");
  const voided = backup.events.find(({ type }) => type === "expense-voided");
  const [alice, bob] = backup.people;
  assert.deepEqual(created.payload, {
    expenseId: created.id,
    description: "Dinner",
    currency: "USD",
    amount: 2000,
    payerId: alice.id,
    splits: [{ participantId: alice.id, amount: 1000 }, { participantId: bob.id, amount: 1000 }]
  });
  assert.deepEqual(changed.payload, {
    expenseId: created.payload.expenseId,
    supersedesEventId: created.id,
    description: "Dinner adjustment",
    currency: "USD",
    amount: 1500,
    payerId: bob.id,
    splits: [{ participantId: alice.id, amount: 500 }, { participantId: bob.id, amount: 1000 }]
  });
  assert.equal(changed.payload.supersedesEventId, created.id);
  assert.equal(voided.payload.supersedesEventId, changed.id);
  assert.equal(voided.payload.reason, "Duplicate receipt");
});
