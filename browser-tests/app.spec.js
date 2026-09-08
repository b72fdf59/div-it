import { expect, test } from "@playwright/test";

test("loads the Div It interface", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Div It");
  await expect(page.getByRole("heading", { name: "Div It" })).toBeVisible();
});
