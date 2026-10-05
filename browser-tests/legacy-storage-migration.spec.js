import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";

test("opens and preserves the pre-CRDT IndexedDB group through migration and reload", async ({ page }) => {
  const rawEvent = {
    id: "15151515-1515-4151-8151-151515151515", type: "expense-created", description: "Old indexed meal",
    amount: 1234, payerId: "legacy-ana", splits: [{ personId: "legacy-ana", amount: 617 }, { personId: "legacy-ben", amount: 617 }],
    createdAt: "2020-01-02T03:04:05.000Z", legacyNote: { source: "pre-crdt", keep: true }
  };
  const legacyGroup = {
    name: "Pre-CRDT trip", currency: "EUR",
    people: [{ id: "legacy-ana", name: "Ana" }, { id: "legacy-ben", name: "Ben" }], events: [rawEvent]
  };

  await page.route("**/src/main.js", (route) => route.abort());
  await page.goto("/");
  await page.evaluate(async (group) => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("div-it", 1);
      request.onupgradeneeded = () => request.result.createObjectStore("state");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise((resolve, reject) => {
      const transaction = db.transaction("state", "readwrite");
      transaction.objectStore("state").put(group, "group");
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
    });
    db.close();
  }, legacyGroup);
  await page.unroute("**/src/main.js");
  await page.reload();

  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator(".."))
    .toContainText("Old indexed meal");
  await page.getByRole("button", { name: "Balances" }).click();
  await expect(page.getByRole("heading", { name: "Everyone" }).locator(".."))
    .toContainText("€6.17");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group" }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  const firstBackup = JSON.parse(await fs.readFile(await (await download).path(), "utf8"));
  assert.deepEqual(firstBackup.people, legacyGroup.people);
  assert.deepEqual(firstBackup.events, legacyGroup.events);
  assert.equal(firstBackup.eventsById, undefined);
  assert.equal(firstBackup.eventStoreFormatVersion, undefined);
  assert.equal(firstBackup.events[0].id, rawEvent.id);
  assert.equal(firstBackup.events[0].amount, 1234);
  assert.deepEqual(firstBackup.events[0].legacyNote, rawEvent.legacyNote);

  await page.reload();
  await expect(page.getByRole("button", { name: "Activity" })).toBeVisible();
  const restoredDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group" }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  const restored = JSON.parse(await fs.readFile(await (await restoredDownload).path(), "utf8"));
  assert.equal(restored.groupId, firstBackup.groupId);
  assert.deepEqual(restored.people, firstBackup.people);
  assert.deepEqual(restored.events, firstBackup.events);
});
