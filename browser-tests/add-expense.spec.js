import { expect, test } from "@playwright/test";

test("adds people and an equal-split expense", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Div It" })).toBeVisible();

  const personInput = page.getByLabel("Person name");
  const people = page.getByRole("heading", { name: "People" }).locator("..");
  await personInput.fill("Alice");
  await people.getByRole("button", { name: "Add" }).click();
  await expect(people.getByRole("listitem").filter({ hasText: "Alice" })).toBeVisible();

  await personInput.fill("Bob");
  await people.getByRole("button", { name: "Add" }).click();
  await expect(people.getByRole("listitem").filter({ hasText: "Bob" })).toBeVisible();

  await page.getByLabel("Description").fill("Dinner");
  await page.getByRole("textbox", { name: "Amount" }).fill("20.00");
  await expect(page.getByRole("checkbox", { name: "Alice" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Bob" }).check();
  await expect(page.getByRole("checkbox", { name: "Bob" })).toBeChecked();
  await page.getByRole("button", { name: "Add expense" }).click();

  const history = page.getByRole("heading", { name: "History" }).locator("..");
  await expect(history).toContainText("Dinner");
  await expect(history).toContainText("Alice");

  await expect(people).toContainText("Alice");
  await expect(people).toContainText("Bob");
  await expect(people).toContainText("$10.00");
  await expect(page.getByRole("heading", { name: "Settle up" }).locator("..")).toContainText("Bob");
  await expect(page.getByRole("heading", { name: "Settle up" }).locator("..")).toContainText("Alice");
});
