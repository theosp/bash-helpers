const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const {
  ensureRefreshStateRemains,
  openRow,
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

async function waitForRefreshPreparingOrHint(page, timeout = 60000) {
  await expect.poll(async () => {
    return page.evaluate(() => {
      const refresh = document.getElementById("refresh");
      if (!refresh) {
        return "";
      }
      if (refresh.classList.contains("refresh-preparing")) {
        return "preparing";
      }
      if (refresh.classList.contains("refresh-pending")) {
        return "stale";
      }
      return "current";
    });
  }, { timeout }).toMatch(/^(preparing|stale)$/);
}

test("prepared live refresh surfaces pending changes, clears on refresh or reload, and ignores inspect/ignored-file noise", async ({ page }) => {
  const { guiUrl, repoPath } = getGuiEnv();
  const rootTrackedPath = path.join(repoPath, "inspect-unstaged.txt");
  const gitExcludePath = path.join(repoPath, ".git", "info", "exclude");
  const ignoredRelativePath = "watcher-ignored.tmp";
  const ignoredPath = path.join(repoPath, ignoredRelativePath);

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await waitForRefreshState(page, "current");

  await selectMode(page, "browse");
  appendLine(rootTrackedPath, "external watched line 1");
  await waitForRefreshPreparingOrHint(page);
  await waitForRefreshHintState(page, true);

  await triggerRefresh(page);
  await waitForRefreshState(page, "current");
  await openRow(page, "inspect-unstaged.txt [unstaged]");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("external watched line 1");

  appendLine(rootTrackedPath, "external watched line 1b");
  await waitForRefreshPreparingOrHint(page);
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
});
