import { expect, test } from "@playwright/test";

test("adds people and an equal-split expense", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();

  await page.getByRole("button", { name: "Group" }).click();
  const personInput = page.getByLabel("Person name");
  const people = page.getByRole("heading", { name: "People" }).locator("..");
  await personInput.fill("Alice");
  await people.getByRole("button", { name: "Add" }).click();
  await expect(people.getByRole("listitem").filter({ hasText: "Alice" })).toBeVisible();

  await personInput.fill("Bob");
  await people.getByRole("button", { name: "Add" }).click();
  await expect(people.getByRole("listitem").filter({ hasText: "Bob" })).toBeVisible();

  await page.getByRole("button", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Add expense" }).click();
  await page.getByLabel("Description").fill("Dinner");
  await page.getByRole("textbox", { name: "Amount" }).fill("20.00");
  await expect(page.getByRole("checkbox", { name: "Alice" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Bob" }).check();
  await expect(page.getByRole("checkbox", { name: "Bob" })).toBeChecked();
  await page.getByRole("dialog").getByRole("button", { name: "Add expense" }).click();

  const history = page.getByRole("heading", { name: "Recent activity" }).locator("..");
  await expect(history).toContainText("Dinner");
  await expect(history).toContainText("Alice");

  await page.getByRole("button", { name: "Balances" }).click();
  await expect(page.getByRole("heading", { name: "Everyone" }).locator("..")).toContainText("$10.00");
  await expect(page.getByRole("heading", { name: "Suggested settlements" }).locator("..")).toContainText("Bob");
  await expect(page.getByRole("heading", { name: "Suggested settlements" }).locator("..")).toContainText("Alice");
});
