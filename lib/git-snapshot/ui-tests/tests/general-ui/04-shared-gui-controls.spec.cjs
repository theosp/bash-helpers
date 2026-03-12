const { test, expect } = require("@playwright/test");
const {
  selectMode,
  selectSnapshot,
  setCheckbox,
  waitForGuiDataReady,
} = require("../helpers/compare-gui.cjs");

function getGuiEnv() {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const primarySnapshotId = process.env.GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID;
  const olderSnapshotId = process.env.GIT_SNAPSHOT_UI_TEST_OLDER_SNAPSHOT_ID;

  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(primarySnapshotId, "GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID must be set by prepare-env").toBeTruthy();
  expect(olderSnapshotId, "GIT_SNAPSHOT_UI_TEST_OLDER_SNAPSHOT_ID must be set by prepare-env").toBeTruthy();

  return { guiUrl, primarySnapshotId, olderSnapshotId };
}

test("mode switch preserves snapshot and repo context across compare and inspect", async ({ page }) => {
  const { guiUrl, primarySnapshotId, olderSnapshotId } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await expect(page.locator("#modeSelect")).toHaveValue("compare");
  await expect(page.locator("#snapshotSelect")).toHaveValue(primarySnapshotId);
  await expect(page.locator("#repoFilter")).toHaveValue(".");
  await expect(page.locator("#compareShowAll")).toBeChecked();

  await selectMode(page, "inspect");
  await expect(page.locator("#modeSelect")).toHaveValue("inspect");
  await expect(page.locator("#snapshotSelect")).toHaveValue(primarySnapshotId);
  await expect(page.locator("#repoFilter")).toHaveValue(".");

  await selectSnapshot(page, olderSnapshotId);
  await expect(page.locator("#modeSelect")).toHaveValue("inspect");
  await expect(page.locator("#snapshotSelect")).toHaveValue(olderSnapshotId);
  await expect(page.locator("#list")).toContainText("older-only.txt");

  await selectMode(page, "compare");
  await expect(page.locator("#modeSelect")).toHaveValue("compare");
  await expect(page.locator("#snapshotSelect")).toHaveValue(olderSnapshotId);
  await expect(page.locator("#repoFilter")).toHaveValue(".");
  await expect(page.locator("#list")).toContainText("older-only.txt [unresolved_diverged]");
});

test("compare show-all toggle auto-refreshes row visibility", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await expect(page.locator("#compareShowAll")).toBeChecked();
  await expect(page.locator("#list")).toContainText("row-001.txt [resolved_uncommitted]");

  await setCheckbox(page, "#compareShowAll", false);
  await expect(page.locator("#compareShowAll")).not.toBeChecked();
  await expect(page.locator("#list")).not.toContainText("row-001.txt [resolved_uncommitted]");
  await expect(page.locator("#list")).toContainText("000-scroll-target.txt [unresolved_diverged]");

  await setCheckbox(page, "#compareShowAll", true);
  await expect(page.locator("#compareShowAll")).toBeChecked();
  await expect(page.locator("#list")).toContainText("row-001.txt [resolved_uncommitted]");
});

test("delayed compare responses do not override a newer inspect selection", async ({ page }) => {
  const { guiUrl } = getGuiEnv();
  const isCompareDataUrl = (resource) => {
    return resource.url().includes("/api/data?")
      && resource.url().includes("mode=compare");
  };

  const compareRequestPromise = page.waitForRequest(isCompareDataUrl);

  await page.goto(guiUrl);
  await page.locator("#modeSelect").waitFor();
  await compareRequestPromise;

  const compareSettlementPromise = Promise.race([
    page.waitForEvent("requestfailed", isCompareDataUrl),
    page.waitForResponse((response) => isCompareDataUrl(response) && response.status() === 200),
  ]);

  const inspectResponsePromise = page.waitForResponse((response) => {
    return response.url().includes("/api/data?")
      && response.url().includes("mode=inspect")
      && response.status() === 200;
  });

  await page.locator("#modeSelect").selectOption("inspect");
  await Promise.all([inspectResponsePromise, compareSettlementPromise]);
  await waitForGuiDataReady(page);

  await expect(page.locator("#modeSelect")).toHaveValue("inspect");
  await expect(page.locator("#meta")).toContainText("Mode: inspect");
  await expect(page.locator("#list")).toContainText("inspect-staged.txt");
  await expect(page.locator("#list")).not.toContainText("[resolved_uncommitted]");
});
