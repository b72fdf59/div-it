import { expect, test } from "@playwright/test";

test("navigation works by keyboard and the expense dialog restores focus", async ({ page }) => {
  await page.goto("/");
  const activity = page.getByRole("button", { name: "Activity" });
  const group = page.getByRole("button", { name: "Group" });

  await group.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
  await activity.click();

  const addExpense = page.getByRole("button", { name: "Add expense" });
  await addExpense.click();
  const dialog = page.getByRole("dialog", { name: "Add expense" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(addExpense).toBeFocused();
});

test("shell fits mobile and desktop widths", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await page.getByRole("button", { name: "Group" }).click();
  await page.getByLabel("Group name").fill("G".repeat(100));
  await page.getByRole("button", { name: "Save group" }).click();

  for (const viewport of [{ width: 320, height: 700 }, { width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
    await page.getByRole("button", { name: "Group", exact: true }).click();
    await expect(page.getByRole("heading", { name: "People" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "G".repeat(100) })).toBeVisible();
    await page.getByRole("button", { name: "Activity" }).click();
    await page.getByRole("button", { name: "Add expense" }).click();
    await expect(page.getByRole("dialog", { name: "Add expense" })).toBeVisible();
    const widths = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth
    }));
    expect(widths.document).toBeLessThanOrEqual(widths.viewport);
    await page.keyboard.press("Escape");
  }
});
