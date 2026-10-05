import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";

const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const expenseId = "11111111-1111-4111-8111-111111111111";
const baseId = "22222222-2222-4222-8222-222222222222";
const aliceBranchId = "33333333-3333-4333-8333-333333333333";
const bobBranchId = "44444444-4444-4444-8444-444444444444";
const aliceFollowupId = "77777777-7777-4777-8777-777777777777";
const aliceId = "55555555-5555-4555-8555-555555555555";
const bobId = "66666666-6666-4666-8666-666666666666";

function event(id, type, payload, dependsOn = []) {
  return {
    id, type, schemaVersion: 1, protocolVersion: 1, groupId,
    author: { participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" },
    createdAt: "2026-09-05T10:00:00.000Z",
    dependsOn: [...dependsOn].sort(), payload, signature: "development-only"
  };
}

const backup = {
  groupId,
  name: "Trip",
  currency: "USD",
  people: [{ id: aliceId, name: "Alice" }, { id: bobId, name: "Bob" }],
  events: [
    event(baseId, "expense-created", {
      expenseId, description: "Concert", currency: "USD", amount: 2000, payerId: aliceId,
      splits: [{ participantId: aliceId, amount: 1500 }, { participantId: bobId, amount: 500 }]
    }),
    event(aliceBranchId, "expense-revised", {
      expenseId, supersedesEventId: baseId, description: "Concert revised by Alice", currency: "USD", amount: 2400, payerId: aliceId,
      splits: [{ participantId: aliceId, amount: 1200 }, { participantId: bobId, amount: 1200 }]
    }, [baseId]),
    event(bobBranchId, "expense-revised", {
      expenseId, supersedesEventId: baseId, description: "Concert revised by Bob", currency: "USD", amount: 1600, payerId: bobId,
      splits: [{ participantId: aliceId, amount: 400 }, { participantId: bobId, amount: 1200 }]
    }, [baseId]),
    event(aliceFollowupId, "expense-revised", {
      expenseId, supersedesEventId: aliceBranchId, description: "Concert final", currency: "USD", amount: 5000, payerId: bobId,
      splits: [{ participantId: aliceId, amount: 1000 }, { participantId: bobId, amount: 4000 }]
    }, [aliceBranchId])
  ]
};

const contestedBackup = structuredClone(backup);
const branchSet = [aliceBranchId, bobBranchId].sort();
contestedBackup.events.push(
  event("88888888-8888-4888-8888-888888888888", "conflict-resolved", {
    resolutionId: "99999999-9999-4999-8999-999999999999", expenseId,
    resolvesEventIds: branchSet, chosenEventId: aliceBranchId, supersedesResolutionEventIds: []
  }, branchSet),
  event("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab", "conflict-resolved", {
    resolutionId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc", expenseId,
    resolvesEventIds: branchSet, chosenEventId: bobBranchId, supersedesResolutionEventIds: []
  }, branchSet)
);

test("keeps the uncontested balance until an explicit conflict choice and preserves both branches", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await page.getByRole("button", { name: "Group" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "conflict-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup))
  });
  await expect(page.locator("#notice")).toHaveText("Backup imported.");
  await page.getByRole("button", { name: "Activity" }).click();

  const review = page.locator(".conflict-card");
  await expect(page.locator(".conflict-inbox")).toContainText("current uncontested amount stays in balances");
  await expect(review).toContainText("$24.00, paid by Alice");
  await expect(review).toContainText("Alice $12.00, Bob $12.00");
  await expect(review).toContainText("$16.00, paid by Bob");
  await expect(review).toContainText("Alice $4.00, Bob $12.00");
  await expect(review).toContainText("Concert final: $50.00, paid by Bob");
  await expect(review).toContainText("Alice $10.00, Bob $40.00");
  await expect(review).toContainText("Latest uncontested value after: Concert revised by Alice: $24.00");
  const choices = review.locator('input[type="radio"]');
  await expect(choices).toHaveCount(2);
  await expect(choices.nth(0)).not.toBeChecked();
  await expect(choices.nth(1)).not.toBeChecked();
  await expect(review.getByRole("button", { name: "Keep selected change" })).toBeDisabled();

  await page.getByRole("button", { name: "Balances" }).click();
  const everyone = page.getByRole("heading", { name: "Everyone" }).locator("..");
  await expect(everyone).toContainText("Owed $5.00");
  await expect(everyone).toContainText("Owes $5.00");

  await page.getByRole("button", { name: "Activity" }).click();
  await review.locator(`input[value="${aliceBranchId}"]`).check();
  await review.getByRole("button", { name: "Keep selected change" }).click();
  await expect(page.locator(".conflict-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Balances" }).click();
  await expect(everyone).toContainText("Owes $10.00");
  await expect(everyone).toContainText("Owed $10.00");

  await page.reload();
  await page.getByRole("button", { name: "Balances" }).click();
  await expect(page.getByRole("heading", { name: "Everyone" }).locator("..")).toContainText("Owes $10.00");
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group" }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  const saved = JSON.parse(await fs.readFile(await (await downloadPromise).path(), "utf8"));
  assert.deepEqual(saved.events.map(({ type }) => type), ["expense-created", "expense-revised", "expense-revised", "expense-revised", "conflict-resolved"]);
  assert.equal(saved.events[1].id, aliceBranchId);
  assert.equal(saved.events[2].id, bobBranchId);
  assert.equal(saved.events[3].id, aliceFollowupId);
  assert.deepEqual(saved.events[4].payload.resolvesEventIds, [aliceBranchId, bobBranchId].sort());
  assert.equal(saved.events[4].payload.chosenEventId, aliceBranchId);
});

test("requires a new choice to supersede competing earlier resolutions", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await page.getByRole("button", { name: "Group" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "contested-resolutions.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(contestedBackup))
  });
  await expect(page.locator("#notice")).toHaveText("Backup imported.");
  await page.getByRole("button", { name: "Activity" }).click();
  const review = page.locator(".conflict-card");
  await expect(review).toContainText("Earlier choices disagree");
  await expect(review).toContainText("supersede all 2 current choices");
  await expect(review.locator('input[type="radio"]').nth(0)).not.toBeChecked();
  await expect(review.locator('input[type="radio"]').nth(1)).not.toBeChecked();
  await review.locator(`input[value="${bobBranchId}"]`).check();
  await review.getByRole("button", { name: "Keep selected change" }).click();
  await expect(page.locator(".conflict-card")).toHaveCount(0);
  await page.getByRole("button", { name: "Balances" }).click();
  const everyone = page.getByRole("heading", { name: "Everyone" }).locator("..");
  await expect(everyone).toContainText("Owes $4.00");
  await expect(everyone).toContainText("Owed $4.00");

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group" }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  const saved = JSON.parse(await fs.readFile(await (await downloadPromise).path(), "utf8"));
  const finalResolution = saved.events.find((entry) => entry.type === "conflict-resolved" && entry.payload.supersedesResolutionEventIds.length);
  assert.deepEqual(finalResolution.payload.supersedesResolutionEventIds, ["88888888-8888-4888-8888-888888888888", "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"].sort());
  assert.equal(finalResolution.payload.chosenEventId, bobBranchId);
});
