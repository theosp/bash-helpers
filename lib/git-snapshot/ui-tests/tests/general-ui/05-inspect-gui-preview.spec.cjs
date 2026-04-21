const { test, expect } = require("@playwright/test");
const {
  openFiltersPanel,
  openRow,
  selectMode,
  selectRepoFilter,
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
  await expect(page.locator(".diff-file-chip-add")).toContainText("captured staged additions");
  await expect(page.locator(".diff-file-chip-delete")).toContainText("captured staged removals");

  await openRow(page, "inspect-unstaged.txt");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("captured unstaged line");
  await expect(page.locator(".diff-file-chip-add")).toContainText("captured unstaged additions");
  await expect(page.locator(".diff-file-chip-delete")).toContainText("captured unstaged removals");

  await openRow(page, "inspect-untracked.txt");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("captured untracked line 1");
  await expect(page.locator("#diff")).toContainText("captured untracked line 2");

  await openRow(page, "--inspect-untracked.txt");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("captured dash-prefixed untracked line");
});

test("browse mode previews live staged, unstaged, and untracked data", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await selectMode(page, "browse");

  await expect(page.locator("#openExternal")).toBeVisible();
  await expect(page.locator("#openExternal")).toHaveText("Edit File");
  await expect(page.locator("#createSnapshot")).toBeVisible();

  await openRow(page, "inspect-staged.txt [staged]");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("captured staged line");
  await expect(page.locator(".diff-file-chip-add")).toContainText("staged in index");
  await expect(page.locator(".diff-file-chip-delete")).toContainText("from HEAD baseline");

  await openRow(page, "inspect-unstaged.txt [unstaged]");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("captured unstaged line");
  await expect(page.locator(".diff-file-chip-add")).toContainText("working tree only");
  await expect(page.locator(".diff-file-chip-delete")).toContainText("currently in index");

  await openRow(page, "inspect-untracked.txt [untracked]");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("captured untracked line 1");
  await expect(page.locator(".diff-file-chip-add")).toContainText("untracked working tree content");
  await expect(page.locator(".diff-file-chip-note")).toContainText("baseline empty");

  await openRow(page, "--inspect-untracked.txt [untracked]");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("captured dash-prefixed untracked line");
});

test("browse repo filter keeps alternate repo options after selecting a repo", async ({ page }) => {
  const { guiUrl, cleanRepo } = getGuiEnv();

  await page.goto(guiUrl);
  await selectMode(page, "browse");

  await setCheckbox(page, "#browseAllRepos", true);
  await expect(page.locator("#repoFilter")).toContainText(cleanRepo);

  await selectRepoFilter(page, cleanRepo);
  await expect(page.locator("#repoFilter")).toHaveValue(cleanRepo);
  await expect(page.locator("#repoFilter")).toContainText(".");

  await selectRepoFilter(page, ".");
  await expect(page.locator("#repoFilter")).toHaveValue(".");
  await expect(page.locator("#repoFilter")).toContainText(cleanRepo);
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

  await selectRepoFilter(page, cleanRepo);

  await expect(page.locator("#list")).toContainText(cleanRepo);
  await expect(page.locator("#list")).toContainText("No captured files for the selected categories.");
  await expect(page.locator("#inspectSummaryBody")).toContainText(`repo:`);
  await expect(page.locator("#inspectSummaryBody")).toContainText(cleanRepo);
  await expect(page.locator("#inspectSummaryBody")).toContainText("relation:");
});

test("inspect state is encoded in the URL and survives reload", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await selectMode(page, "inspect");

  const expectedSnapshotId = await page.locator("#snapshotSelect").inputValue();

  await setCheckbox(page, "#inspectAllRepos", true);
  await selectRepoFilter(page, ".");
  await setCheckbox(page, "#inspectUntracked", false);
  await openRow(page, "inspect-staged.txt");
  await waitForPreviewReady(page);

  await expect.poll(async () => {
    return page.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        mode: url.searchParams.get("mode"),
        snapshotId: url.searchParams.get("snapshot_id"),
        repoFilter: url.searchParams.get("repo_filter") || "",
        inspectIncludeStaged: url.searchParams.get("inspect_include_staged"),
        inspectIncludeUnstaged: url.searchParams.get("inspect_include_unstaged"),
        inspectIncludeUntracked: url.searchParams.get("inspect_include_untracked"),
        inspectShowAllRepos: url.searchParams.get("inspect_show_all_repos"),
        selectedRepo: url.searchParams.get("selected_repo"),
        selectedCategory: url.searchParams.get("selected_category"),
        selectedFile: url.searchParams.get("selected_file"),
      };
    });
  }).toEqual({
    mode: "inspect",
    snapshotId: expectedSnapshotId,
    repoFilter: ".",
    inspectIncludeStaged: "true",
    inspectIncludeUnstaged: "true",
    inspectIncludeUntracked: "false",
    inspectShowAllRepos: "true",
    selectedRepo: ".",
    selectedCategory: "staged",
    selectedFile: "inspect-staged.txt",
  });

  await expect.poll(() => page.title()).toContain("inspect");
  await expect.poll(() => page.title()).toContain(expectedSnapshotId);
  await expect.poll(() => page.title()).toContain(".");
  await expect.poll(() => page.title()).toContain("staged, unstaged");

  await page.reload();
  await waitForGuiDataReady(page);
  await waitForPreviewReady(page);

  await expect(page.locator("#modeSelect")).toHaveValue("inspect");
  await expect(page.locator("#snapshotSelect")).toHaveValue(expectedSnapshotId);
  await openFiltersPanel(page);
  await expect(page.locator("#repoFilter")).toHaveValue(".");
  await expect(page.locator("#inspectStaged")).toBeChecked();
  await expect(page.locator("#inspectUnstaged")).toBeChecked();
  await expect(page.locator("#inspectUntracked")).not.toBeChecked();
  await expect(page.locator("#inspectAllRepos")).toBeChecked();
  await expect(page.getByRole("button", { name: "inspect-staged.txt", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#diff")).toContainText("captured staged line");
  await expect(page).toHaveTitle(/\./);
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
