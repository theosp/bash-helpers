const { test, expect } = require("@playwright/test");
const {
  openRow,
  selectMode,
  setCheckbox,
  waitForGuiDataReady,
  waitForPreviewReady,
} = require("../helpers/compare-gui.cjs");

function getGuiEnv() {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const cleanRepo = process.env.GIT_SNAPSHOT_UI_TEST_CLEAN_REPO;
  const maliciousBranch = process.env.GIT_SNAPSHOT_UI_TEST_MALICIOUS_BRANCH;

  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(cleanRepo, "GIT_SNAPSHOT_UI_TEST_CLEAN_REPO must be set by prepare-env").toBeTruthy();
  expect(maliciousBranch, "GIT_SNAPSHOT_UI_TEST_MALICIOUS_BRANCH must be set by prepare-env").toBeTruthy();

  return { guiUrl, cleanRepo, maliciousBranch };
}

test("inspect mode previews captured staged, unstaged, and untracked data", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await selectMode(page, "inspect");

  await expect(page.locator("#openExternal")).toBeHidden();
  await expect(page.locator("#inspectSummaryPanel")).toBeVisible();
  await expect(page.locator("#inspectSummaryBody")).toContainText("relation:");
  await expect(page.locator("#inspectSummaryBody")).toContainText("apply staged:");
  await expect(page.locator("#inspectSummaryBody")).toContainText("collisions:");

  await openRow(page, "inspect-staged.txt");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("captured staged line");

  await openRow(page, "inspect-unstaged.txt");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("captured unstaged line");

  await openRow(page, "inspect-untracked.txt");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("captured untracked line 1");
  await expect(page.locator("#diff")).toContainText("captured untracked line 2");

  await openRow(page, "--inspect-untracked.txt");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("captured dash-prefixed untracked line");
});

test("inspect toggles auto-refresh and all-repos reveals clean repo summaries", async ({ page }) => {
  const { guiUrl, cleanRepo } = getGuiEnv();

  await page.goto(guiUrl);
  await selectMode(page, "inspect");

  await expect(page.locator("#list")).toContainText("inspect-untracked.txt");
  await expect(page.locator("#list")).not.toContainText(cleanRepo);

  await setCheckbox(page, "#inspectUntracked", false);
  await expect(page.locator("#list")).not.toContainText("inspect-untracked.txt");

  await setCheckbox(page, "#inspectUntracked", true);
  await expect(page.locator("#list")).toContainText("inspect-untracked.txt");

  await setCheckbox(page, "#inspectAllRepos", true);
  await expect(page.locator("#repoFilter")).toContainText(cleanRepo);

  await page.locator("#repoFilter").selectOption(cleanRepo);
  await waitForGuiDataReady(page);

  await expect(page.locator("#list")).toContainText(cleanRepo);
  await expect(page.locator("#list")).toContainText("No captured files for the selected categories.");
  await expect(page.locator("#inspectSummaryBody")).toContainText(`repo:`);
  await expect(page.locator("#inspectSummaryBody")).toContainText(cleanRepo);
  await expect(page.locator("#inspectSummaryBody")).toContainText("relation:");
});

test("inspect summary renders branch metadata as literal text", async ({ page }) => {
  const { guiUrl, maliciousBranch } = getGuiEnv();

  await page.goto(guiUrl);
  await selectMode(page, "inspect");

  await expect(page.locator("#inspectSummaryBody")).toContainText(maliciousBranch);
  await expect(page.locator("#inspectSummaryBody svg")).toHaveCount(0);
  await expect.poll(async () => {
    return page.evaluate(() => typeof window.__inspectSummaryXss === "undefined");
  }).toBe(true);
});
