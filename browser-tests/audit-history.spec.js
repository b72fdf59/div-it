import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";

const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const expenseA = "11111111-1111-4111-8111-111111111111";
const expenseB = "22222222-2222-4222-8222-222222222222";
const alice = "33333333-3333-4333-8333-333333333333";
const bob = "44444444-4444-4444-8444-444444444444";

function event(id, type, payload, dependsOn = [], schemaVersion = 1) {
  return {
    id, type, schemaVersion, protocolVersion: 1, groupId,
    author: { participantId: "local-prototype", deviceId: "local-prototype-device", keyId: "development-only" },
    createdAt: "2026-09-05T10:00:00.000Z", dependsOn: [...dependsOn].sort(), payload, signature: "development-only"
  };
}

const aCreated = "55555555-5555-4555-8555-555555555555";
const aRevised = "66666666-6666-4666-8666-666666666666";
const aVoided = "77777777-7777-4777-8777-777777777777";
const aPending = "88888888-8888-4888-8888-888888888888";
const missingDependency = "99999999-9999-4999-8999-999999999999";
const bCreated = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab";
const bBranchA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc";
const bBranchB = "cccccccc-cccc-4ccc-8ccc-cccccccccccd";
const settlementId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd1";
const settlementEventId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee1";
const reversalEventId = "ffffffff-ffff-4fff-8fff-fffffffffff1";
const invalidId = "12121212-1212-4121-8121-121212121212";
const futureId = "13131313-1313-4131-8131-131313131313";
const futureEvent = event(futureId, "expense-created", {
  expenseId: "14141414-1414-4141-8141-141414141414", description: "Future expense", currency: "USD", amount: 1000, payerId: alice,
  splits: [{ participantId: alice, amount: 500 }, { participantId: bob, amount: 500 }]
}, [], 2);

const backup = {
  groupId, name: "Audit trip", currency: "USD",
  people: [{ id: alice, name: "Alice" }, { id: bob, name: "Bob" }],
  events: [
    event(aCreated, "expense-created", {
      expenseId: expenseA, description: "Dinner", currency: "USD", amount: 2000, payerId: alice,
      splits: [{ participantId: alice, amount: 1000 }, { participantId: bob, amount: 1000 }]
    }),
    event(aRevised, "expense-revised", {
      expenseId: expenseA, supersedesEventId: aCreated, description: "Dinner corrected", currency: "USD", amount: 2400, payerId: bob,
      splits: [{ participantId: alice, amount: 1200 }, { participantId: bob, amount: 1200 }]
    }, [aCreated]),
    event(aVoided, "expense-voided", { expenseId: expenseA, supersedesEventId: aRevised, reason: "Duplicate receipt" }, [aRevised]),
    event(aPending, "expense-revised", {
      expenseId: expenseA, supersedesEventId: aRevised, description: "Waiting change", currency: "USD", amount: 2600, payerId: alice,
      splits: [{ participantId: alice, amount: 1300 }, { participantId: bob, amount: 1300 }]
    }, [aRevised, missingDependency]),
    event(bCreated, "expense-created", {
      expenseId: expenseB, description: "Cab fare", currency: "USD", amount: 1000, payerId: alice,
      splits: [{ participantId: alice, amount: 500 }, { participantId: bob, amount: 500 }]
    }),
    event(bBranchA, "expense-revised", {
      expenseId: expenseB, supersedesEventId: bCreated, description: "Cab fare Alice proposal", currency: "USD", amount: 1400, payerId: alice,
      splits: [{ participantId: alice, amount: 700 }, { participantId: bob, amount: 700 }]
    }, [bCreated]),
    event(bBranchB, "expense-revised", {
      expenseId: expenseB, supersedesEventId: bCreated, description: "Cab fare Bob proposal", currency: "USD", amount: 1600, payerId: bob,
      splits: [{ participantId: alice, amount: 800 }, { participantId: bob, amount: 800 }]
    }, [bCreated]),
    event(settlementEventId, "settlement-recorded", {
      settlementId, currency: "USD", fromParticipantId: bob, toParticipantId: alice, amount: 300
    }),
    event(reversalEventId, "settlement-reversed", {
      settlementId, reversesEventId: settlementEventId, reason: "Transfer returned"
    }, [settlementEventId])
  ]
};

test("opens audit chains from activity and conflicts, and inspects all diagnostics", async ({ page }) => {
  const malformedStoredEvent = event(invalidId, "expense-revised", {});
  await page.route("**/src/main.js", (route) => route.abort());
  await page.goto("/");
  await page.evaluate(async (stored) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("div-it", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("state", "readwrite");
      transaction.objectStore("state").put(stored, "group");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, { ...backup, events: [malformedStoredEvent] });
  await page.unroute("**/src/main.js");
  await page.reload();
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await page.getByRole("button", { name: "Group" }).click();
  await page.locator('input[type="file"]').setInputFiles({
    name: "audit-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup))
  });
  await expect(page.locator("#notice")).toHaveText("Backup imported.");
  await page.getByRole("button", { name: "Activity" }).click();

  const voidActivity = page.getByRole("listitem").filter({ hasText: "Expense voided" });
  await voidActivity.getByRole("button", { name: "View audit chain" }).click();
  await expect(page.getByRole("heading", { name: "Audit chain" })).toBeVisible();
  const auditRows = page.locator(".audit-entry");
  await expect(auditRows).toHaveCount(4);
  const supersededRows = auditRows.filter({ hasText: "Superseded" });
  await expect(supersededRows).toHaveCount(2);
  await expect(supersededRows.first()).toContainText("Dinner");
  await expect(auditRows.filter({ hasText: "Effective void" })).toContainText("Duplicate receipt");
  await expect(auditRows.filter({ hasText: "Pending" })).toContainText("missing-dependency");
  await page.getByRole("button", { name: "Back to Activity" }).click();

  const conflict = page.locator(".conflict-card");
  await expect(conflict).toContainText("Cab fare Alice proposal");
  await conflict.getByRole("button", { name: "Inspect audit chain" }).click();
  await expect(page.getByRole("heading", { name: "Audit chain" })).toBeVisible();
  await expect(page.locator(".audit-entry")).toHaveCount(3);
  await expect(page.locator(".audit-entry").filter({ hasText: "Conflicting" })).toHaveCount(2);
  await page.getByRole("button", { name: "Back to Activity" }).click();

  await conflict.locator(`input[value="${bBranchB}"]`).check();
  await conflict.getByRole("button", { name: "Keep selected change" }).click();
  await expect(page.locator(".conflict-card")).toHaveCount(0);
  const chosenActivity = page.getByRole("listitem").filter({ hasText: "Cab fare Bob proposal" });
  await chosenActivity.getByRole("button", { name: "View audit chain" }).click();
  await expect(page.locator(".audit-entry").filter({ hasText: "Rejected branch" })).toContainText("Cab fare Alice proposal");
  await page.getByRole("button", { name: "Back to Activity" }).click();

  const backupDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group" }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  const currentBackup = JSON.parse(await fs.readFile(await (await backupDownload).path(), "utf8"));
  await page.locator('input[type="file"]').setInputFiles({
    name: "future-entry-backup.json", mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ ...currentBackup, events: [...currentBackup.events, futureEvent] }))
  });
  await expect(page.locator("#notice")).toHaveText("Backup imported.");
  await page.getByRole("button", { name: "Activity" }).click();

  await page.getByRole("button", { name: "Open audit history" }).click();
  await expect(page.getByRole("heading", { name: "Complete audit history" })).toBeVisible();
  await expect(page.locator(".audit-entry")).toHaveCount(12);
  await expect(page.locator(".audit-entry").filter({ hasText: "Quarantined" })).toContainText("invalid-payload");
  await expect(page.locator(".audit-entry").filter({ hasText: "Unsupported" })).toContainText("unsupported-version");
  await expect(page.locator(".audit-entry").filter({ hasText: "settlement-recorded" })).toContainText("Reversed");
  await expect(page.locator(".audit-entry").filter({ hasText: "settlement-reversed" })).toContainText("Transfer returned");
});
