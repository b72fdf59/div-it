import { expect, test } from "@playwright/test";

test("unsupported money events label balances incomplete and make the group read-only", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Group" }).click();
  const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const aliceId = "11111111-1111-4111-8111-111111111111";
  const bobId = "22222222-2222-4222-8222-222222222222";
  const backup = {
    name: "Future ledger",
    currency: "USD",
    groupId,
    people: [{ id: aliceId, name: "Alice" }, { id: bobId, name: "Bob" }],
    events: [{
      id: "33333333-3333-4333-8333-333333333333",
      type: "expense-created",
      schemaVersion: 2,
      protocolVersion: 1,
      groupId,
      author: { participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" },
      createdAt: "2026-09-05T10:00:00.000Z",
      dependsOn: [],
      payload: {},
      signature: "development-only"
    }]
  };
  await page.locator('input[type="file"]').setInputFiles({
    name: "future-backup.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(backup))
  });

  await expect(page.getByRole("alert")).toContainText(/balances may be incomplete/i);
  await expect(page.locator(".expense-fab")).toBeDisabled();
  await expect(page.getByLabel("Person name")).toBeDisabled();
  await expect(page.getByLabel("Group name")).toBeDisabled();
  await page.getByRole("button", { name: "Balances" }).click();
  await expect(page.getByRole("heading", { name: "Everyone" }).locator("..")).toContainText("Incomplete");
  await expect(page.getByRole("heading", { name: "Record a manual payment" }).locator("..").getByRole("button", { name: "Record payment" })).toBeDisabled();
});
