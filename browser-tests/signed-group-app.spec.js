import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";
import * as Automerge from "@automerge/automerge";
import { appendStoredRecord, recordsFromDocument } from "../src/event-store.js";

async function createSignedGroup(page, { name = "Signed trip", owner = "Mina", currency = "EUR" } = {}) {
  await page.getByRole("button", { name: "Create new" }).click();
  const dialog = page.getByRole("dialog", { name: "Create signed group" });
  await dialog.getByLabel("Name for new group").fill(name);
  await dialog.getByLabel("Your name").fill(owner);
  await dialog.getByLabel("Currency").selectOption(currency);
  await dialog.getByRole("button", { name: "Create signed group" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
  await expect(page.getByText(/Signed local group/)).toBeVisible();
}

async function rewriteActiveRawGroup(page, change) {
  const binary = await page.evaluate(() => window.__divItTestSync.exportBinary());
  const document = Automerge.load(Uint8Array.from(binary));
  const changed = Automerge.change(document, change);
  await page.evaluate((bytes) => sessionStorage.setItem("div-it-test-replica", JSON.stringify(bytes)),
    Array.from(Automerge.save(changed)));
  await page.goto("/?testSync=1&testReplica=1");
}

async function addSignedExpense(page, description) {
  await page.getByRole("button", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Add expense" }).click();
  const dialog = page.getByRole("dialog", { name: "Add expense" });
  await dialog.getByLabel("Description").fill(description);
  await dialog.getByRole("textbox", { name: "Amount" }).fill("10.00");
  await dialog.getByRole("button", { name: "Add expense" }).click();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText(description);
}

async function reviseSignedExpense(page, description, amount) {
  await page.getByRole("button", { name: "Revise expense" }).click();
  const dialog = page.getByRole("dialog", { name: "Revise expense" });
  await dialog.getByLabel("Description").fill(description);
  await dialog.getByRole("textbox", { name: "Amount" }).fill(amount);
  await dialog.getByRole("textbox", { name: "Owner" }).fill(amount);
  await dialog.getByRole("button", { name: "Save revision" }).click();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText(description);
}

async function injectInvalidSignedRevision(page) {
  const binary = await page.evaluate(() => window.__divItTestSync.exportBinary());
  const document = Automerge.load(Uint8Array.from(binary));
  const parent = recordsFromDocument(document, "ledgerRecordsById").find((record) => record.type === "expense-revised");
  assert.ok(parent, "a valid signed revision is available to clone");
  const forged = { ...parent, id: crypto.randomUUID(), payload: { ...parent.payload, description: "Forged branch not to preview" } };
  const changed = Automerge.change(document, (draft) => appendStoredRecord(draft, "ledgerRecordsById", forged));
  await page.evaluate((bytes) => sessionStorage.setItem("div-it-test-replica", JSON.stringify(bytes)), Array.from(Automerge.save(changed)));
  await page.goto("/?testSync=1&testReplica=1");
}

test("creates, signs, backs up, and reloads a real signed group", async ({ page }) => {
  await page.goto("/");
  await createSignedGroup(page);
  await page.getByRole("button", { name: "Group", exact: true }).click();
  const people = page.getByRole("heading", { name: "People" }).locator("..");
  await page.getByLabel("Person name").fill("Alice");
  await people.getByRole("button", { name: "Add" }).click();
  await expect(people.getByRole("listitem").filter({ hasText: "Alice" })).toBeVisible();

  await page.getByRole("button", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Add expense" }).click();
  const dialog = page.getByRole("dialog", { name: "Add expense" });
  await dialog.getByLabel("Description").fill("Signed dinner");
  await dialog.getByRole("textbox", { name: "Amount" }).fill("20.00");
  await dialog.getByRole("checkbox", { name: "Alice" }).check();
  await dialog.getByRole("button", { name: "Add expense" }).click();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("Signed dinner");
  await expect(page.getByText("Signed expense saved locally.")).toBeVisible();

  await page.getByRole("button", { name: "Revise expense" }).click();
  const revision = page.getByRole("dialog", { name: "Revise expense" });
  await revision.getByLabel("Description").fill("Revised signed dinner");
  await revision.getByRole("textbox", { name: "Amount" }).fill("24.00");
  await revision.getByRole("textbox", { name: "Mina" }).fill("12.00");
  await revision.getByRole("textbox", { name: "Alice" }).fill("12.00");
  await revision.getByRole("button", { name: "Save revision" }).click();
  await expect(page.locator("#notice")).toContainText("Signed expense revision saved locally.");
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("Revised signed dinner");

  await page.getByRole("button", { name: "Void expense" }).click();
  const voidForm = page.locator("form").filter({ has: page.getByLabel("Reason for voiding") });
  await voidForm.getByLabel("Reason for voiding").fill("Duplicate receipt");
  await voidForm.getByRole("button", { name: "Confirm void" }).click();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("Duplicate receipt");

  await page.getByRole("button", { name: "Add expense" }).click();
  const secondExpense = page.getByRole("dialog", { name: "Add expense" });
  await secondExpense.getByLabel("Description").fill("Settlement meal");
  await secondExpense.getByRole("textbox", { name: "Amount" }).fill("20.00");
  await secondExpense.getByRole("checkbox", { name: "Alice" }).check();
  await secondExpense.getByRole("button", { name: "Add expense" }).click();
  await page.getByRole("button", { name: "Balances" }).click();
  const settlement = page.getByRole("heading", { name: "Record a manual payment" }).locator("..");
  await settlement.getByLabel("Paid by").selectOption({ label: "Alice" });
  await settlement.getByLabel("Paid to").selectOption({ label: "Mina" });
  await settlement.getByRole("textbox", { name: "Amount" }).fill("10.00");
  await settlement.getByRole("button", { name: "Record payment" }).click();
  await expect(page.getByText("Signed settlement saved locally.")).toBeVisible();
  await page.getByRole("button", { name: "Activity" }).click();
  await page.getByRole("button", { name: "Reverse settlement" }).click();
  const reversalForm = page.locator("form").filter({ has: page.getByLabel("Reason for reversal") });
  await reversalForm.getByLabel("Reason for reversal").fill("Payment entered twice");
  await reversalForm.getByRole("button", { name: "Confirm reversal" }).click();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("Payment entered twice");

  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  const backup = JSON.parse(await fs.readFile(await (await download).path(), "utf8"));
  assert.equal(backup.format, "div-it-signed-group-backup-v1");
  assert.equal(backup.name, "Signed trip");
  assert.ok(backup.membershipRecords.some((record) => record.recordType === "group-created"));
  assert.ok(backup.membershipRecords.some((record) => record.recordType === "participant-added"));
  assert.ok(backup.ledgerRecords.some((record) => record.type === "expense-created" && record.protocolVersion === 2));
  assert.ok(backup.ledgerRecords.some((record) => record.type === "expense-revised"));
  assert.ok(backup.ledgerRecords.some((record) => record.type === "expense-voided"));
  assert.ok(backup.ledgerRecords.some((record) => record.type === "settlement-recorded"));
  assert.ok(backup.ledgerRecords.some((record) => record.type === "settlement-reversed"));
  assert.deepEqual(backup.legacyAttestations, []);
  assert.equal(JSON.stringify(backup).includes("privateKey"), false);
  assert.equal(Object.hasOwn(backup, "trustPin"), false);

  await page.reload();
  await expect(page.getByRole("heading", { name: "Signed trip" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("Expense voided");
  await page.getByRole("button", { name: "Balances" }).click();
  await expect(page.getByRole("heading", { name: "Everyone" }).locator("..")).toContainText("Alice");
  await expect(page.getByRole("heading", { name: "Everyone" }).locator("..")).toContainText("€10.00");
});

test("signed restore is rejected without mutating a legacy group, and missing local trust never falls back", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByLabel("Person name").fill("Legacy person");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("listitem").filter({ hasText: "Legacy person" })).toBeVisible();

  const signedBackup = { format: "div-it-signed-group-backup-v1", groupId: crypto.randomUUID(), name: "Foreign", currency: "USD",
    membershipRecords: [], ledgerRecords: [] };
  await page.locator('input[type="file"]').setInputFiles({ name: "signed.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(signedBackup)) });
  await expect(page.locator("#notice")).toContainText("Signed group backup restore is not supported");
  await expect(page.getByRole("listitem").filter({ hasText: "Legacy person" })).toBeVisible();

  await createSignedGroup(page, { name: "Pinned group", owner: "Owner" });
  await page.evaluate(() => localStorage.removeItem("div-it-signed-group-trust-pins"));
  await page.reload();
  await expect(page.getByRole("heading", { name: "Pinned group" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add expense" })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("incomplete or has an ambiguous group identity");
  await expect(page.getByText(/Local prototype only/)).toHaveCount(0);
});

test("signed classification survives raw marker removal and unknown shared versions", async ({ page }) => {
  await page.goto("/?testSync=1");
  await expect.poll(() => page.evaluate(() => typeof window.__divItTestSync?.exportBinary)).toBe("function");
  await createSignedGroup(page, { name: "Raw marker group", owner: "Owner" });
  await rewriteActiveRawGroup(page, (document) => { delete document.signedGroupVersion; });
  await expect(page.getByRole("heading", { name: "Raw marker group" })).toBeVisible();
  await expect(page.getByText(/Signed local group/)).toBeVisible();
  await addSignedExpense(page, "Signed after marker removal");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  const backup = JSON.parse(await fs.readFile(await (await download).path(), "utf8"));
  assert.ok(backup.ledgerRecords.some((record) => record.type === "expense-created" && record.protocolVersion === 2));
  await rewriteActiveRawGroup(page, (document) => {
    document.signedGroupVersion = 2;
    delete document.membershipRecordsById;
    delete document.ledgerRecordsById;
  });
  await expect(page.getByRole("heading", { name: "Raw marker group" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add expense" })).toBeDisabled();
  await expect(page.getByText(/Local prototype only/)).toHaveCount(0);
  const unsupportedWrite = await page.evaluate(async () => {
    const { openGroup } = await import("/src/group.js");
    const controller = await openGroup(() => {});
    try { await controller.addPerson("Must not be added"); return "saved"; }
    catch (cause) { return cause.message; }
  });
  assert.match(unsupportedWrite, /version is not supported for writing/);
  await page.evaluate(() => localStorage.removeItem("div-it-signed-group-trust-pins"));
  await rewriteActiveRawGroup(page, (document) => {
    document.signedGroupVersion = 1;
    delete document.membershipRecordsById;
    delete document.ledgerRecordsById;
    delete document.legacyAttestationsById;
  });
  await expect(page.getByRole("heading", { name: "Raw marker group" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Add expense" })).toBeDisabled();
  await expect(page.getByText(/Local prototype only/)).toHaveCount(0);
});

test("signed ledger records converge across tabs and stale group writes are rejected", async ({ page, context }) => {
  await page.goto("/?testSync=1");
  await createSignedGroup(page, { name: "First signed group", owner: "Owner" });
  const second = await context.newPage();
  const initialBinary = await page.evaluate(() => window.__divItTestSync.exportBinary());
  await second.addInitScript((binary) => sessionStorage.setItem("div-it-test-replica", JSON.stringify(binary)), initialBinary);
  await second.goto("/?testSync=1&testReplica=1");
  await expect(second.getByRole("heading", { name: "First signed group" })).toBeVisible();
  await Promise.all([page, second].map((tab) => tab.evaluate(() => window.__divItTestSync.disconnect())));
  await addSignedExpense(page, "First tab expense");
  await addSignedExpense(second, "Second tab expense");
  await Promise.all([page, second].map((tab) => tab.evaluate(() => window.__divItTestSync.reconnect())));
  for (const tab of [page, second]) {
    const activity = tab.getByRole("heading", { name: "Recent activity" }).locator("..");
    await expect(activity).toContainText("First tab expense");
    await expect(activity).toContainText("Second tab expense");
  }

  await page.getByRole("button", { name: "Create new" }).click();
  const create = page.getByRole("dialog", { name: "Create signed group" });
  await create.getByLabel("Name for new group").fill("Second signed group");
  await create.getByLabel("Your name").fill("Owner");
  await create.getByRole("button", { name: "Create signed group" }).click();
  await expect(page.getByRole("heading", { name: "Second signed group" })).toBeVisible();
  await page.getByLabel("Current group").selectOption({ label: "First signed group" });
  await expect(page.getByRole("heading", { name: "First signed group" })).toBeVisible();

  await page.evaluate(() => {
    const nativeSign = crypto.subtle.sign.bind(crypto.subtle);
    const nativeVerify = crypto.subtle.verify.bind(crypto.subtle);
    window.__signStarted = false;
    window.__verifyCompleted = 0;
    window.__releaseSign = undefined;
    crypto.subtle.sign = (...args) => {
      window.__signStarted = true;
      return new Promise((resolve, reject) => {
        window.__releaseSign = () => nativeSign(...args).then(resolve, reject);
      });
    };
    crypto.subtle.verify = (...args) => nativeVerify(...args).then((verified) => {
      window.__verifyCompleted += 1;
      return verified;
    });
  });
  await page.getByRole("button", { name: "Add expense" }).click();
  const expenseDialog = page.getByRole("dialog", { name: "Add expense" });
  await expenseDialog.getByLabel("Description").fill("Must not land in the old group");
  await expenseDialog.getByRole("textbox", { name: "Amount" }).fill("7.00");
  await expenseDialog.getByRole("button", { name: "Add expense" }).click();
  await expect.poll(() => page.evaluate(() => window.__signStarted)).toBe(true);
  await page.getByLabel("Current group").selectOption({ label: "Second signed group" });
  await expect(page.getByRole("heading", { name: "Second signed group" })).toBeVisible();
  await page.evaluate(() => window.__releaseSign());
  await expect.poll(() => page.evaluate(() => window.__verifyCompleted)).toBeGreaterThan(0);
  await page.getByLabel("Current group").selectOption({ label: "First signed group" });
  await expect(page.getByRole("heading", { name: "First signed group" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).not.toContainText("Must not land in the old group");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  const backup = JSON.parse(await fs.readFile(await (await download).path(), "utf8"));
  assert.ok(!backup.ledgerRecords.some((record) => record.payload?.description === "Must not land in the old group"));
});

test("new group activation leaves the prior group selected if local registry storage fails", async ({ page }) => {
  await page.goto("/");
  await createSignedGroup(page, { name: "Stable group", owner: "Owner" });
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === "div-it-groups") throw new DOMException("Storage is full", "QuotaExceededError");
      return original.call(this, key, value);
    };
  });
  await page.getByRole("button", { name: "Create new" }).click();
  const create = page.getByRole("dialog", { name: "Create signed group" });
  await create.getByLabel("Name for new group").fill("Must remain unregistered");
  await create.getByLabel("Your name").fill("Owner");
  await create.getByRole("button", { name: "Create signed group" }).click();
  await expect(page.getByRole("heading", { name: "Stable group" })).toBeVisible();
  await expect(page.getByLabel("Current group").locator("option", { hasText: "Must remain unregistered" })).toHaveCount(0);
});

test("signed concurrent revisions preserve the original and resolve only authenticated branches", async ({ page, context }) => {
  await page.goto("/?testSync=1");
  await createSignedGroup(page, { name: "Signed conflict group", owner: "Owner" });
  await addSignedExpense(page, "Conflict base");
  await page.getByRole("button", { name: "View audit chain" }).click();
  await expect(page.getByRole("heading", { name: "Audit chain" })).toBeVisible();
  await expect(page.locator(".audit-entry")).toContainText("Conflict base");
  await page.getByRole("button", { name: "Back to Activity" }).click();
  const second = await context.newPage();
  const initialBinary = await page.evaluate(() => window.__divItTestSync.exportBinary());
  await second.addInitScript((binary) => sessionStorage.setItem("div-it-test-replica", JSON.stringify(binary)), initialBinary);
  await second.goto("/?testSync=1&testReplica=1");
  await expect(second.locator(".activity-list")).toContainText("Conflict base");
  await expect.poll(() => second.evaluate(() => typeof window.__divItTestSync?.disconnect)).toBe("function");
  await Promise.all([page, second].map((tab) => tab.evaluate(() => window.__divItTestSync.disconnect())));
  await reviseSignedExpense(page, "Proposal one", "24.00");
  await reviseSignedExpense(second, "Proposal two", "26.00");
  await Promise.all([page, second].map((tab) => tab.evaluate(() => window.__divItTestSync.reconnect())));
  const review = page.locator(".conflict-card");
  await expect(review).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" }).locator("..")).toContainText("Conflict base");
  await expect(review).toContainText("Proposal one");
  await expect(review).toContainText("Proposal two");
  await expect(review.locator('input[type="radio"]')).toHaveCount(2);
  await injectInvalidSignedRevision(page);
  const authenticatedReview = page.locator(".conflict-card");
  await expect(authenticatedReview).toContainText("Proposal one");
  await expect(authenticatedReview).toContainText("Proposal two");
  await expect(authenticatedReview).not.toContainText("Forged branch not to preview");
  await expect(authenticatedReview.locator('input[type="radio"]')).toHaveCount(2);
  await authenticatedReview.locator(".conflict-choice").filter({ hasText: "Proposal two" }).locator('input[type="radio"]').check();
  await authenticatedReview.getByRole("button", { name: "Keep selected change" }).click();
  await expect(page.locator(".conflict-card")).toHaveCount(0);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("button", { name: "Export backup" }).click();
  const backup = JSON.parse(await fs.readFile(await (await download).path(), "utf8"));
  assert.ok(backup.ledgerRecords.some((record) => record.type === "conflict-resolved"));
  assert.ok(backup.ledgerRecords.some((record) => record.payload?.description === "Proposal one"));
  assert.ok(backup.ledgerRecords.some((record) => record.payload?.description === "Proposal two"));
});
