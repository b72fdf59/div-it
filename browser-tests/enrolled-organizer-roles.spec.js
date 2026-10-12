import { promises as fs } from "node:fs";
import { expect, test } from "@playwright/test";

async function downloadJson(page, action) {
  const pending = page.waitForEvent("download");
  await action();
  return JSON.parse(await fs.readFile(await (await pending).path(), "utf8"));
}

async function setJson(input, value, name) {
  await input.setInputFiles({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(value)) });
}

test("an enrolled organizer can rename a participant after explicit invite approval", async ({ page, browser }) => {
  const targetContext = await browser.newContext();
  const target = await targetContext.newPage();
  try {
    await Promise.all([page.goto("/"), target.goto("/")]);
    await page.getByRole("button", { name: "Create new" }).click();
    const create = page.getByRole("dialog", { name: "Create signed group" });
    await create.getByLabel("Name for new group").fill("Organizer handoff");
    await create.getByLabel("Your name").fill("Owner");
    await create.getByRole("button", { name: "Create signed group" }).click();
    await expect(page.getByRole("heading", { name: "Organizer handoff" })).toBeVisible();

    await page.getByRole("button", { name: "Group", exact: true }).click();
    const roster = page.getByRole("region", { name: "People and roles" });
    await roster.getByLabel("Person name").fill("Guest");
    await roster.getByRole("button", { name: "Add" }).click();
    await expect(roster.locator("ul.people").getByText("Guest", { exact: true })).toBeVisible();
    const guestId = await roster.getByLabel("Participant for role change").locator("option").filter({ hasText: "Guest ·" }).getAttribute("value");
    await roster.getByLabel("Participant for role change").selectOption(guestId);
    await roster.getByRole("button", { name: "Review organizer grant" }).click();
    await roster.getByRole("button", { name: "Confirm grant" }).click();
    await expect(roster.getByText("Organizer", { exact: true })).toBeVisible();

    const organizerTools = page.getByRole("region", { name: "Device enrollment" });
    await organizerTools.getByRole("button", { name: "Invite or enroll a device" }).click();
    await organizerTools.getByLabel("Existing participant").selectOption(guestId);
    const invite = await downloadJson(page, () => organizerTools.getByRole("button", { name: /Issue 24-hour invitation/ }).click());

    await target.getByRole("button", { name: "Group", exact: true }).click();
    const targetTools = target.getByRole("region", { name: "Device enrollment" });
    await targetTools.getByRole("button", { name: "Invite or enroll a device" }).click();
    const requestFile = target.waitForEvent("download");
    await setJson(targetTools.getByLabel("Organizer invitation bootstrap package"), invite, "invite.json");
    const request = JSON.parse(await fs.readFile(await (await requestFile).path(), "utf8"));

    const organizerRequest = organizerTools.getByLabel("Device request package");
    await setJson(organizerRequest, request, "request.json");
    await expect(organizerTools.getByText(request.request.payload.publicKeyFingerprint)).toBeVisible();
    const proof = await downloadJson(page, () => organizerTools.getByRole("button", { name: /Approve this exact device/ }).click());

    await setJson(targetTools.getByLabel("Organizer's refreshed proof package"), proof, "proof.json");
    await targetTools.getByLabel("I verified the group ID and genesis fingerprint with the organizer out of band.").check();
    await targetTools.getByRole("button", { name: "Confirm and trust this signed group on this device" }).click();
    await expect(target.getByRole("heading", { name: "Organizer handoff" })).toBeVisible();
    await target.getByRole("button", { name: "Group", exact: true }).click();
    const targetRoster = target.getByRole("region", { name: "People and roles" });
    await expect(targetRoster.locator("ul.people")).toContainText("Guest");
    await expect(targetRoster.locator("ul.people")).toContainText("Organizer");
    await expect(targetRoster.getByLabel("New participant name")).toBeVisible();

    const ownerId = await targetRoster.getByLabel("Participant to rename").locator("option").filter({ hasText: "Owner ·" }).getAttribute("value");
    await targetRoster.getByLabel("Participant to rename").selectOption(ownerId);
    await targetRoster.getByLabel("New participant name").fill("Trip owner");
    await targetRoster.getByRole("button", { name: "Review rename" }).click();
    await expect(targetRoster).toContainText(`Confirm rename: Owner (${ownerId}) to Trip owner`);
    await targetRoster.getByRole("button", { name: "Confirm this rename" }).click();
    await expect(targetRoster.locator("ul.people")).toContainText("Trip owner");
    await expect(target.locator("#notice")).toContainText("renamed");

    await target.reload();
    await expect(target.getByRole("heading", { name: "Organizer handoff" })).toBeVisible();
    await target.getByRole("button", { name: "Group", exact: true }).click();
    await expect(target.getByRole("region", { name: "People and roles" }).locator("ul.people")).toContainText("Trip owner");
  } finally {
    await targetContext.close();
  }
});
