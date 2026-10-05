import { expect, test } from "@playwright/test";

test("records, reloads, and reverses a partial manual settlement", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();

  await page.getByRole("button", { name: "Group" }).click();
  const aliceId = "11111111-1111-4111-8111-111111111111";
  const bobId = "22222222-2222-4222-8222-222222222222";
  const legacyBackup = {
    name: "Older trip",
    currency: "USD",
    people: [{ id: aliceId, name: "Alice" }, { id: bobId, name: "Bob" }],
    events: [{
      id: "33333333-3333-4333-8333-333333333333",
      type: "expense",
      description: "Lunch",
      amount: 2000,
      payerId: aliceId,
      splits: [{ personId: aliceId, amount: 1000 }, { personId: bobId, amount: 1000 }],
      createdAt: "2026-09-05T10:00:00.000Z"
    }]
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "legacy-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(legacyBackup))
  });
  await expect(page.locator("#notice")).toHaveText("Backup imported.");
  await page.getByRole("button", { name: "Activity" }).click();

  await page.getByRole("button", { name: "Balances" }).click();
  const everyone = page.getByRole("heading", { name: "Everyone" }).locator("..");
  await expect(everyone).toContainText("Alice");
  await expect(everyone).toContainText("Owed $10.00");
  await expect(everyone).toContainText("Bob");
  await expect(everyone).toContainText("Owes $10.00");

  const payment = page.getByRole("heading", { name: "Record a manual payment" }).locator("..");
  await payment.getByLabel("Paid by").selectOption({ label: "Bob" });
  await payment.getByLabel("Paid to").selectOption({ label: "Alice" });
  await payment.getByLabel("Amount").fill("4.50");
  await payment.getByRole("button", { name: "Record payment" }).click();
  await expect(everyone).toContainText("Owed $5.50");
  await expect(everyone).toContainText("Owes $5.50");
  await expect(page.locator(".prototype-attribution")).toContainText("signatures are not active");

  await page.reload();
  await page.getByRole("button", { name: "Balances" }).click();
  await expect(page.getByRole("heading", { name: "Everyone" }).locator("..")).toContainText("Owes $5.50");
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Bob paid Alice" })).toContainText("$4.50");

  await page.getByRole("button", { name: "Reverse settlement" }).click();
  await page.getByLabel("Reason for reversal").fill("Transfer returned");
  await page.getByRole("button", { name: "Confirm reversal" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Settlement reversed" })).toContainText("Transfer returned");
  await page.getByRole("button", { name: "Balances" }).click();
  await expect(page.getByRole("heading", { name: "Everyone" }).locator("..")).toContainText("Owes $10.00");

  await page.reload();
  await page.getByRole("button", { name: "Balances" }).click();
  await expect(page.getByRole("heading", { name: "Everyone" }).locator("..")).toContainText("Owes $10.00");
  await page.getByRole("button", { name: "Activity" }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Settlement reversed" })).toContainText("Transfer returned");
});
