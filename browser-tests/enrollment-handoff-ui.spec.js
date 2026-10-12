import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";

async function createSignedGroup(page, name, owner) {
  await page.getByRole("button", { name: "Create new" }).click();
  const dialog = page.getByRole("dialog", { name: "Create signed group" });
  await dialog.getByLabel("Name for new group").fill(name);
  await dialog.getByLabel("Your name").fill(owner);
  await dialog.getByRole("button", { name: "Create signed group" }).click();
  await expect(page.getByRole("heading", { name })).toBeVisible();
}

async function downloadedJson(page, action) {
  const downloadPromise = page.waitForEvent("download");
  await action();
  const download = await downloadPromise;
  return JSON.parse(await fs.readFile(await download.path(), "utf8"));
}

async function setJson(input, value, name) {
  await input.setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
}

test("two isolated browser profiles complete explicit invite, approval, and trust handoff", async ({ page, browser }) => {
  const targetContext = await browser.newContext();
  const target = await targetContext.newPage();
  try {
    await Promise.all([page.goto("/"), target.goto("/")]);

    await createSignedGroup(page, "Handoff trip", "Organizer");
    await page.getByRole("button", { name: "Group", exact: true }).click();
    const people = page.getByRole("heading", { name: "People" }).locator("..");
    await people.getByLabel("Person name").fill("Guest");
    await people.getByRole("button", { name: "Add" }).click();
    await expect(people.getByRole("listitem").filter({ hasText: "Guest" })).toBeVisible();

    const invitePanel = page.getByRole("region", { name: "Device enrollment" });
    await invitePanel.getByRole("button", { name: "Invite or enroll a device" }).click();
    await invitePanel.getByLabel("Existing participant").selectOption({ label: "Guest" });
    const invite = await downloadedJson(page, () => invitePanel.getByRole("button", { name: /Issue 24-hour invitation/ }).click());
    assert.equal(invite.format, "div-it-invite-bootstrap-v1");
    const inviteToken = invite.token;
    assert.equal(JSON.stringify(invite.membershipRecords).includes(inviteToken), false);
    const inviteRecord = invite.membershipRecords.find((record) => record.recordType === "invite-issued");
    invite.membershipRecords.push(structuredClone(inviteRecord));

    await target.getByRole("button", { name: "Group", exact: true }).click();
    const targetPanel = target.getByRole("region", { name: "Device enrollment" });
    await targetPanel.getByRole("button", { name: "Invite or enroll a device" }).click();
    const requestDownload = target.waitForEvent("download");
    await setJson(targetPanel.getByLabel("Organizer invitation bootstrap package"), invite, "invite.json");
    const requestFile = await requestDownload;
    const request = JSON.parse(await fs.readFile(await requestFile.path(), "utf8"));
    assert.equal(request.format, "div-it-join-request-v1");
    assert.equal(JSON.stringify(request).includes(inviteToken), false);
    assert.notEqual(request.request.author.deviceId, invite.membershipRecords.find((record) => record.recordType === "group-created").author.deviceId);

    await expect(target.getByRole("heading", { name: "Handoff trip" })).toHaveCount(0);
    const before = await target.evaluate(() => ({ registry: localStorage.getItem("div-it-groups"), pins: localStorage.getItem("div-it-signed-group-trust-pins") }));
    await expect(targetPanel.getByText(/signed request is ready/)).toBeVisible();
    await setJson(targetPanel.getByLabel("Organizer's refreshed proof package"), invite, "unapproved.json");
    await expect(target.locator("#notice")).toContainText("invalid-package-schema");
    assert.deepEqual(await target.evaluate(() => ({ registry: localStorage.getItem("div-it-groups"), pins: localStorage.getItem("div-it-signed-group-trust-pins") })), before);

    await setJson(invitePanel.getByLabel("Device request package"), request, "request.json");
    await expect(invitePanel.getByText("Participant:").locator("..")).toContainText("Guest");
    await expect(invitePanel.getByText(request.request.payload.publicKeyFingerprint)).toBeVisible();
    const proof = await downloadedJson(page, () => invitePanel.getByRole("button", { name: /Approve this exact device/ }).click());
    assert.equal(proof.format, "div-it-enrollment-proof-v1");
    assert.equal(JSON.stringify(proof).includes(inviteToken), false);
    const organizerBackup = await downloadedJson(page, () => page.getByRole("button", { name: "Export backup" }).click());
    assert.equal(JSON.stringify(organizerBackup).includes(inviteToken), false);
    const organizerStorage = await page.evaluate(() => [localStorage.getItem("div-it-groups"), localStorage.getItem("div-it-signed-group-trust-pins")]);
    assert.equal(JSON.stringify(organizerStorage).includes(inviteToken), false);

    await setJson(targetPanel.getByLabel("Organizer's refreshed proof package"), proof, "proof.json");
    await expect(targetPanel.getByText(proof.groupId)).toBeVisible();
    await expect(targetPanel.getByText(invite.trustPin.publicKeyFingerprint)).toBeVisible();
    const beforeConfirm = await target.evaluate(() => ({ registry: localStorage.getItem("div-it-groups"), pins: localStorage.getItem("div-it-signed-group-trust-pins") }));
    assert.deepEqual(beforeConfirm, before);
    await targetPanel.getByRole("checkbox", { name: /verified the group ID and genesis fingerprint/ }).check();
    await targetPanel.getByRole("button", { name: /Confirm and trust this signed group/ }).click();
    await expect(target.getByRole("heading", { name: "Handoff trip" })).toBeVisible();
    const final = await target.evaluate(() => ({ registry: JSON.parse(localStorage.getItem("div-it-groups")), pins: JSON.parse(localStorage.getItem("div-it-signed-group-trust-pins")) }));
    assert.equal(final.registry.groups.length, 2);
    const targetDocumentId = final.registry.activeDocumentId;
    assert.equal(final.pins[targetDocumentId].genesisId, invite.genesisId);

    const identityBeforeReload = await target.evaluate(async () => {
      const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
      const identity = await getOrCreateDeviceIdentity();
      return { deviceId: identity.deviceId, keyId: identity.keyId };
    });
    assert.deepEqual(identityBeforeReload, { deviceId: request.request.author.deviceId, keyId: request.request.author.keyId });

    const memberAuthority = await target.evaluate(async (args) => {
      const { openGroup } = await import("/src/group.js");
      const controller = await openGroup(() => {});
      const canManage = await controller.canManageEnrollment();
      let inviteError = "";
      let approvalError = "";
      let renameError = "";
      let grantError = "";
      let revokeError = "";
      try { await controller.createEnrollmentInvite(args.participantId); } catch (cause) { inviteError = cause.message; }
      try { await controller.approveEnrollmentRequest(args.bootstrap, args.request); } catch (cause) { approvalError = cause.message; }
      try { await controller.renameParticipant(args.participantId, "Unauthorized rename"); } catch (cause) { renameError = cause.message; }
      try { await controller.grantOrganizer(args.participantId); } catch (cause) { grantError = cause.message; }
      try { await controller.revokeOrganizer(args.participantId); } catch (cause) { revokeError = cause.message; }
      return { canManage, inviteError, approvalError, renameError, grantError, revokeError };
    }, { participantId: invite.membershipRecords.find((record) => record.recordType === "invite-issued").payload.participantId,
      bootstrap: invite, request });
    assert.deepEqual(memberAuthority, { canManage: false, inviteError: "not-organizer", approvalError: "not-organizer",
      renameError: "not-organizer", grantError: "not-owner", revokeError: "not-owner" });

    await target.getByRole("button", { name: "Group", exact: true }).click();
    const backup = await downloadedJson(target, () => target.getByRole("button", { name: "Export backup" }).click());
    assert.equal(JSON.stringify(backup).includes(inviteToken), false);
    const persisted = JSON.stringify(await target.evaluate(async () => {
      const keys = await new Promise((resolve, reject) => {
        const request = indexedDB.open("div-it-device-identity");
        request.onsuccess = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains("identities")) return resolve([]);
          const tx = db.transaction("identities", "readonly");
          const get = tx.objectStore("identities").get("local-device-v1");
          get.onsuccess = () => { resolve([get.result?.deviceId, get.result?.keyId]); db.close(); };
          get.onerror = () => reject(get.error);
        };
        request.onerror = () => reject(request.error);
      });
      return { keys, registry: localStorage.getItem("div-it-groups"), pins: localStorage.getItem("div-it-signed-group-trust-pins") };
    }));
    assert.equal(persisted.includes(inviteToken), false);

    await target.reload();
    await expect(target.getByRole("heading", { name: "Handoff trip" })).toBeVisible();
    const identityAfterReload = await target.evaluate(async () => {
      const { getOrCreateDeviceIdentity } = await import("/src/device-identity-store.js");
      const identity = await getOrCreateDeviceIdentity();
      return { deviceId: identity.deviceId, keyId: identity.keyId };
    });
    assert.deepEqual(identityAfterReload, identityBeforeReload);
    await target.getByRole("button", { name: "Add expense" }).click();
    const expense = target.getByRole("dialog", { name: "Add expense" });
    await expense.getByLabel("Description").fill("Guest device expense");
    await expense.getByRole("textbox", { name: "Amount" }).fill("10.00");
    await expense.getByLabel("Paid by").selectOption({ label: "Guest" });
    await expense.getByRole("button", { name: "Add expense" }).click();
    await expect(target.locator("#notice")).toContainText("Signed expense saved locally");
    await target.getByRole("button", { name: "Group", exact: true }).click();
    const postExpenseBackup = await downloadedJson(target, () => target.getByRole("button", { name: "Export backup" }).click());
    const created = postExpenseBackup.ledgerRecords.find((record) => record.type === "expense-created" && record.payload.description === "Guest device expense");
    assert.equal(created.author.deviceId, request.request.author.deviceId);
    assert.equal(created.author.keyId, request.request.author.keyId);
    assert.equal(JSON.stringify(postExpenseBackup).includes(inviteToken), false);
  } finally {
    await targetContext.close();
  }
});
