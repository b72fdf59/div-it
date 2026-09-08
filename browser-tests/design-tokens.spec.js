import { expect, test } from "@playwright/test";

test("exposes calm light and dark semantic tokens", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Div It" })).toBeVisible();

  const light = await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
    const style = getComputedStyle(document.documentElement);
    return {
      colorScheme: style.colorScheme,
      paper: style.getPropertyValue("--paper").trim(),
      surface: style.getPropertyValue("--surface").trim(),
      positive: style.getPropertyValue("--positive").trim(),
      review: style.getPropertyValue("--review").trim(),
      debt: style.getPropertyValue("--debt").trim()
    };
  });

  const dark = await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    const style = getComputedStyle(document.documentElement);
    return {
      colorScheme: style.colorScheme,
      paper: style.getPropertyValue("--paper").trim(),
      surface: style.getPropertyValue("--surface").trim(),
      positive: style.getPropertyValue("--positive").trim(),
      review: style.getPropertyValue("--review").trim(),
      debt: style.getPropertyValue("--debt").trim()
    };
  });

  expect(light).toEqual({
    colorScheme: "light",
    paper: "#faf9f5",
    surface: "#ffffff",
    positive: "#476b5b",
    review: "#8a6a2f",
    debt: "#a95f4e"
  });
  expect(dark).toEqual({
    colorScheme: "dark",
    paper: "#0f1915",
    surface: "#17231e",
    positive: "#68c895",
    review: "#d9b769",
    debt: "#e08b78"
  });
  expect(light.positive).not.toBe(dark.positive);
  expect(light.debt).not.toBe(dark.debt);

  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport);
    await expect(page.getByRole("button", { name: "Export backup" })).toBeVisible();
    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth
    }));
    expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  }
});
