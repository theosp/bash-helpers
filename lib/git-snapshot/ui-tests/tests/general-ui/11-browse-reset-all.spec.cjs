const { test, expect } = require("@playwright/test");
const {
  openSnapshotPanel,
  openResetAllDialog,
  selectMode,
  waitForGuiDataReady,
} = require("../helpers/compare-gui.cjs");

function getGuiEnv() {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const primarySnapshotId = process.env.GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(primarySnapshotId, "GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID must be set by the shell wrapper").toBeTruthy();
  return { guiUrl, primarySnapshotId };
}

test("browse reset-all exposes snapshot flags and requires final confirmation", async ({ page }) => {
  const { guiUrl, primarySnapshotId } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await selectMode(page, "browse");

  await expect(page.locator("#createSnapshot")).toHaveText("Create Snapshot");
  await expect(page.locator("#resetAll")).toBeVisible();
  await expect(page.getByRole("button", { name: "inspect-staged.txt [staged]", exact: true })).toBeVisible();

  await openResetAllDialog(page);
  await expect(page.locator("#resetAllSnapshot")).toBeChecked();
  await page.locator("#resetAllSnapshot").uncheck();
  await page.locator("#resetAllContinue").click();
  await expect(page.locator("#resetAllConfirmDialog")).toBeVisible();
  await expect(page.locator("#resetAllConfirmMessage")).toContainText("without creating an auto snapshot");
  await page.locator("#resetAllConfirmCancel").click();
  await expect(page.locator("#resetAllConfirmDialog")).toBeHidden();
  await expect(page.getByRole("button", { name: "inspect-staged.txt [staged]", exact: true })).toBeVisible();

  await openResetAllDialog(page);
  await expect(page.locator("#resetAllSnapshot")).toBeChecked();
  await page.locator("#resetAllContinue").click();
  await expect(page.locator("#resetAllConfirmDialog")).toBeVisible();
  await expect(page.locator("#resetAllConfirmMessage")).toContainText("create a pre-clear auto snapshot first");
  const resetResponsePromise = page.waitForResponse((response) => {
    return response.url().includes("/api/reset-all") && response.request().method() === "POST";
  });
  await page.locator("#resetAllConfirmSubmit").click();
  const resetResponse = await resetResponsePromise;
  const resetPayload = await resetResponse.json();
  expect(resetPayload && resetPayload.snapshot_id).toMatch(/^pre-reset-/);
  await expect(page.locator("#resetAllConfirmDialog")).toBeHidden({ timeout: 15000 });
  await waitForGuiDataReady(page);

  await expect(page.locator("#list .row")).toHaveCount(0);
  await expect(page.locator("#list .empty")).toContainText("No repos to display.");

  await selectMode(page, "compare");
  await expect(page.locator("#snapshotSelect")).toHaveValue(primarySnapshotId);

  await openSnapshotPanel(page);
  await expect(page.locator("#snapshotShowAuto")).not.toBeChecked();
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${resetPayload.snapshot_id}"]`)).toHaveCount(0);

  const showAutoResponsePromise = page.waitForResponse((response) => {
    return response.url().includes("/api/snapshots?") && response.request().method() === "GET";
  });
  await page.locator("#snapshotShowAuto").check();
  await showAutoResponsePromise;
  await expect(page.locator("#snapshotShowAuto")).toBeChecked();
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${resetPayload.snapshot_id}"]`)).toBeVisible();
  await expect.poll(() => {
    return page.evaluate(() => {
      return new URL(window.location.href).searchParams.has("include_auto");
    });
  }).toBe(false);

  await page.reload();
  await waitForGuiDataReady(page);
  await expect(page.locator("#modeSelect")).toHaveValue("compare");
  await openSnapshotPanel(page);
  await expect(page.locator("#snapshotShowAuto")).toBeChecked();
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${resetPayload.snapshot_id}"]`)).toBeVisible();

  await page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${resetPayload.snapshot_id}"] .snapshot-entry-select`).click();
  await expect(page.locator("#snapshotOverlay")).toBeHidden({ timeout: 15000 });
  await waitForGuiDataReady(page);
  await expect(page.locator("#snapshotSelect")).toHaveValue(resetPayload.snapshot_id);

  await openSnapshotPanel(page);
  const hideAutoWhileSelectedPromise = page.waitForResponse((response) => {
    return response.url().includes("/api/snapshots?") && response.request().method() === "GET";
  });
  await page.locator("#snapshotShowAuto").click();
  await hideAutoWhileSelectedPromise;
  await expect(page.locator("#snapshotShowAuto")).toBeChecked();
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${resetPayload.snapshot_id}"]`)).toBeVisible();
  await expect.poll(() => {
    return page.evaluate(() => window.localStorage.getItem("git-snapshot.gui.snapshots.show-auto.v1"));
  }).toBe("false");

  await page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${primarySnapshotId}"] .snapshot-entry-select`).click();
  await expect(page.locator("#snapshotOverlay")).toBeHidden({ timeout: 15000 });
  await waitForGuiDataReady(page);
  await expect(page.locator("#snapshotSelect")).toHaveValue(primarySnapshotId);

  await openSnapshotPanel(page);
  await expect(page.locator("#snapshotShowAuto")).not.toBeChecked();
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${resetPayload.snapshot_id}"]`)).toHaveCount(0);
});
