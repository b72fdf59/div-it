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
  const promise = page.waitForEvent("download");
  await action();
  const download = await promise;
  return JSON.parse(await fs.readFile(await download.path(), "utf8"));
}

async function setJson(input, value, name) {
  await input.setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
}

async function prepareHandoff(organizer, target, { twoTargetGroups = false } = {}) {
  await Promise.all([organizer.goto("/"), target.goto("/")]);
  await createSignedGroup(organizer, "Enrollment source", "Organizer");
  await organizer.getByRole("button", { name: "Group", exact: true }).click();
  const people = organizer.getByRole("heading", { name: "People" }).locator("..");
  await people.getByLabel("Person name").fill("Guest");
  await people.getByRole("button", { name: "Add" }).click();
  const organizerPanel = organizer.getByRole("region", { name: "Device enrollment" });
  await organizerPanel.getByRole("button", { name: "Invite or enroll a device" }).click();
  await organizerPanel.getByLabel("Existing participant").selectOption({ label: "Guest" });
  const invite = await downloadedJson(organizer, () => organizerPanel.getByRole("button", { name: /Issue 24-hour invitation/ }).click());

  await createSignedGroup(target, "Target home", "Guest");
  if (twoTargetGroups) await createSignedGroup(target, "Target alternate", "Guest");
  await target.getByRole("button", { name: "Group", exact: true }).click();
  const targetPanel = target.getByRole("region", { name: "Device enrollment" });
  await targetPanel.getByRole("button", { name: "Invite or enroll a device" }).click();
  const requestPromise = target.waitForEvent("download");
  await setJson(targetPanel.getByLabel("Organizer invitation bootstrap package"), invite, "invite.json");
  const requestFile = await requestPromise;
  const request = JSON.parse(await fs.readFile(await requestFile.path(), "utf8"));

  await setJson(organizerPanel.getByLabel("Device request package"), request, "request.json");
  const proof = await downloadedJson(organizer, () => organizerPanel.getByRole("button", { name: /Approve this exact device/ }).click());
  await setJson(targetPanel.getByLabel("Organizer's refreshed proof package"), proof, "proof.json");
  await expect(targetPanel.getByText(proof.groupId)).toBeVisible();
  await targetPanel.getByRole("checkbox", { name: /verified the group ID and genesis fingerprint/ }).check();
  return { invite, request, proof, targetPanel };
}

async function localTrust(target) {
  return target.evaluate(() => ({
    registry: localStorage.getItem("div-it-groups"),
    pins: localStorage.getItem("div-it-signed-group-trust-pins")
  }));
}

test("registry persistence failure rolls back pin and registry, then retry succeeds", async ({ page, browser }) => {
  const targetContext = await browser.newContext();
  const target = await targetContext.newPage();
  try {
    const { invite, targetPanel } = await prepareHandoff(page, target);
    const before = await localTrust(target);
    await target.evaluate(() => {
      const original = Storage.prototype.setItem;
      let fail = true;
      Storage.prototype.setItem = function (key, value) {
        if (key === "div-it-groups" && fail) {
          fail = false;
          throw new DOMException("Injected registry storage failure", "QuotaExceededError");
        }
        return original.call(this, key, value);
      };
    });
    await targetPanel.getByRole("button", { name: /Confirm and trust this signed group/ }).click();
    await expect(target.locator("#notice")).toContainText("Injected registry storage failure");
    assert.deepEqual(await localTrust(target), before, "registry and trust pin rollback after a partial local commit");
    await expect(target.getByRole("heading", { name: "Target home" })).toBeVisible();

    await targetPanel.getByRole("button", { name: /Confirm and trust this signed group/ }).click();
    await expect(target.getByRole("heading", { name: "Enrollment source" })).toBeVisible();
    const final = await localTrust(target);
    assert.notDeepEqual(final.registry, before.registry);
    const registry = JSON.parse(final.registry);
    const enrolledDocumentId = registry.activeDocumentId;
    assert.equal(JSON.parse(final.pins)[enrolledDocumentId].genesisId, invite.genesisId);
  } finally {
    await targetContext.close();
  }
});

test("switching the active local group during enrollment flush aborts without trusting the candidate", async ({ page, browser }) => {
  const targetContext = await browser.newContext();
  const target = await targetContext.newPage();
  try {
    await prepareHandoff(page, target, { twoTargetGroups: true });
    const initial = await localTrust(target);
    const originalActiveId = JSON.parse(initial.registry).activeDocumentId;
    await target.evaluate(async () => {
      const { Repo } = await import("/node_modules/.vite/deps/@automerge_automerge-repo.js");
      const originalFlush = Repo.prototype.flush;
      window.__flushBlocked = new Promise((resolve) => { window.__releaseFlush = resolve; });
      window.__flushReached = new Promise((resolve) => { window.__signalFlushReached = resolve; });
      let pause = true;
      Repo.prototype.flush = async function (...args) {
        if (pause) {
          pause = false;
          window.__signalFlushReached();
          await window.__flushBlocked;
        }
        return originalFlush.apply(this, args);
      };
    });
    await target.getByRole("region", { name: "Device enrollment" })
      .getByRole("button", { name: /Confirm and trust this signed group/ }).click();
    await target.evaluate(() => window.__flushReached);
    await target.getByLabel("Current group").selectOption({ label: "Target home" });
    await expect(target.getByRole("heading", { name: "Target home" })).toBeVisible();
    const switched = await localTrust(target);
    const switchedRegistry = JSON.parse(switched.registry);
    assert.notEqual(switchedRegistry.activeDocumentId, originalActiveId);
    await target.evaluate(() => window.__releaseFlush());
    await expect(target.locator("#notice")).toContainText(/active group or enrollment review changed/i);
    const after = await localTrust(target);
    const finalRegistry = JSON.parse(after.registry);
    assert.equal(finalRegistry.activeDocumentId, switchedRegistry.activeDocumentId);
    assert.equal(finalRegistry.groups.length, switchedRegistry.groups.length);
    assert.equal(after.registry, switched.registry);
    assert.equal(after.pins, switched.pins, "a stale in-flight proof must not persist local trust");
  } finally {
    await targetContext.close();
  }
});
