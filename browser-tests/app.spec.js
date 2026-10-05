import { expect, test } from "@playwright/test";

test("loads the Div It interface", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Div It");
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
});
