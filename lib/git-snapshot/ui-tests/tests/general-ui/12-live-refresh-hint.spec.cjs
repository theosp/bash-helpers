const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const {
  ensureRefreshStateRemains,
  openRow,
  selectCompareBase,
  selectMode,
  triggerRefresh,
  waitForGuiDataReady,
  waitForPreviewReady,
  waitForRefreshState,
  waitForRefreshHintState,
  waitForRefreshTabState,
} = require("../helpers/compare-gui.cjs");

test.setTimeout(90000);

function getGuiEnv() {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const repoPath = process.env.GIT_SNAPSHOT_UI_TEST_REPO;

  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(repoPath, "GIT_SNAPSHOT_UI_TEST_REPO must be set by prepare-env").toBeTruthy();

  return { guiUrl, repoPath };
}

function appendLine(targetPath, line) {
  fs.appendFileSync(targetPath, `${line}\n`, "utf8");
}

test("prepared live refresh moves through preparing to stale, clears on refresh or reload, and ignores inspect/ignored-file noise", async ({ page }) => {
  const { guiUrl, repoPath } = getGuiEnv();
  const rootTrackedPath = path.join(repoPath, "inspect-unstaged.txt");
  const compareTrackedPath = path.join(repoPath, "row-001.txt");
  const submoduleTrackedPath = path.join(repoPath, "modules", "clean-sub", "clean-sub.txt");
  const gitExcludePath = path.join(repoPath, ".git", "info", "exclude");
  const ignoredRelativePath = "watcher-ignored.tmp";
  const ignoredPath = path.join(repoPath, ignoredRelativePath);

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await waitForRefreshState(page, "current");

  await selectMode(page, "browse");
  appendLine(rootTrackedPath, "external watched line 1");
  await waitForRefreshState(page, "preparing");
  await waitForRefreshHintState(page, true);

  await triggerRefresh(page);
  await waitForRefreshState(page, "current");
  await openRow(page, "inspect-unstaged.txt [unstaged]");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("external watched line 1");

  appendLine(rootTrackedPath, "external watched line 1b");
  await waitForRefreshState(page, "preparing");
  await waitForRefreshState(page, "stale");
  await page.reload();
  await waitForGuiDataReady(page);
  await waitForRefreshState(page, "current");
  await openRow(page, "inspect-unstaged.txt [unstaged]");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("external watched line 1b");

  fs.appendFileSync(gitExcludePath, `\n${ignoredRelativePath}\n`, "utf8");
  fs.writeFileSync(ignoredPath, "ignored watcher payload\n", "utf8");
  await ensureRefreshStateRemains(page, "current", 1600);

  await selectMode(page, "inspect");
  appendLine(rootTrackedPath, "external watched line 2");
  await ensureRefreshStateRemains(page, "current", 1600);
  await expect(page.locator("#refresh")).toHaveText("Reload Snapshots");
  await expect(page.locator("#refresh")).not.toHaveClass(/refresh-pending/);
  await expect(page.locator("#refresh")).not.toHaveClass(/refresh-preparing/);
  await waitForRefreshTabState(page, "current");

  await selectMode(page, "browse");
  await waitForRefreshState(page, "current");
  await openRow(page, "inspect-unstaged.txt [unstaged]");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("external watched line 2");

  await selectMode(page, "compare");
  await selectCompareBase(page, "snapshot");
  await openRow(page, "row-001.txt [no restore effect]");
  await waitForPreviewReady(page);
  appendLine(compareTrackedPath, "compare-mode external watched line");
  await waitForRefreshHintState(page, true);
  await triggerRefresh(page);
  await waitForRefreshState(page, "current");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("compare-mode external watched line");

  await page.goto(`${guiUrl}?mode=compare&compare_base=working-tree`);
  await waitForGuiDataReady(page);
  await waitForRefreshState(page, "current");
  const workingTreeReloadRequest = page.waitForRequest((request) => {
    const url = request.url();
    return url.includes("/api/data?")
      && url.includes("mode=compare")
      && url.includes("compare_base=working-tree")
      && url.includes("force=1");
  });
  await page.reload();
  await workingTreeReloadRequest;
  await waitForGuiDataReady(page);
  await waitForRefreshState(page, "current");
  await expect(page.locator("#compareBaseWorkingTree")).toBeChecked();

  await selectMode(page, "browse");
  await waitForRefreshState(page, "current");
});
