const { test, expect } = require("@playwright/test");
const {
  selectMode,
  selectSnapshot,
  setCheckbox,
  waitForGuiDataReady,
  waitForPreviewReady,
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
  await expect(page.getByRole("button", { name: "older-only.txt", exact: true })).toBeVisible();

  await selectMode(page, "compare");
  await expect(page.locator("#modeSelect")).toHaveValue("compare");
  await expect(page.locator("#snapshotSelect")).toHaveValue(olderSnapshotId);
  await expect(page.locator("#repoFilter")).toHaveValue(".");
  await expect(page.getByRole("button", { name: "older-only.txt [unresolved_diverged]", exact: true })).toBeVisible();
});

test("compare show-all toggle auto-refreshes row visibility", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await expect(page.locator("#compareShowAll")).toBeChecked();
  await expect(page.getByRole("button", { name: "row-001.txt [resolved_uncommitted]", exact: true })).toBeVisible();

  await setCheckbox(page, "#compareShowAll", false);
  await expect(page.locator("#compareShowAll")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "row-001.txt [resolved_uncommitted]", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "000-scroll-target.txt [unresolved_diverged]", exact: true })).toBeVisible();

  await setCheckbox(page, "#compareShowAll", true);
  await expect(page.locator("#compareShowAll")).toBeChecked();
  await expect(page.getByRole("button", { name: "row-001.txt [resolved_uncommitted]", exact: true })).toBeVisible();
});

test("compare rows render status pills with tooltip explanations", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  const unresolvedRow = page.getByRole("button", { name: "000-scroll-target.txt [unresolved_diverged]", exact: true });
  const unresolvedPill = unresolvedRow.locator(".status-pill");
  await expect(unresolvedPill).toHaveText("unresolved diverged");
  await expect(unresolvedPill).toHaveAttribute("title", /Still diverged\. The working tree does not match the snapshot content or mode\./);

  await setCheckbox(page, "#compareShowAll", true);

  const resolvedRow = page.getByRole("button", { name: "row-001.txt [resolved_uncommitted]", exact: true });
  const resolvedPill = resolvedRow.locator(".status-pill");
  await expect(resolvedPill).toHaveText("resolved uncommitted");
  await expect(resolvedPill).toHaveAttribute("title", /Resolved in the working tree\. HEAD still differs from the snapshot\./);
});

test("compare state is encoded in the URL and survives reload", async ({ page }) => {
  const { guiUrl, olderSnapshotId } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await setCheckbox(page, "#compareShowAll", false);
  await selectSnapshot(page, olderSnapshotId);
  await page.getByRole("button", { name: "older-only.txt [unresolved_diverged]", exact: true }).click();
  await waitForPreviewReady(page);

  await expect.poll(async () => {
    return page.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        mode: url.searchParams.get("mode"),
        snapshotId: url.searchParams.get("snapshot_id"),
        repoFilter: url.searchParams.get("repo_filter"),
        compareShowAll: url.searchParams.get("compare_show_all"),
        selectedRepo: url.searchParams.get("selected_repo"),
        selectedFile: url.searchParams.get("selected_file"),
      };
    });
  }).toEqual({
    mode: "compare",
    snapshotId: olderSnapshotId,
    repoFilter: ".",
    compareShowAll: "false",
    selectedRepo: ".",
    selectedFile: "older-only.txt",
  });

  await expect.poll(() => page.title()).toContain("compare");
  await expect.poll(() => page.title()).toContain(olderSnapshotId);
  await expect.poll(() => page.title()).toContain("unresolved only");

  await page.reload();
  await waitForGuiDataReady(page);
  await waitForPreviewReady(page);

  await expect(page.locator("#modeSelect")).toHaveValue("compare");
  await expect(page.locator("#snapshotSelect")).toHaveValue(olderSnapshotId);
  await expect(page.locator("#repoFilter")).toHaveValue(".");
  await expect(page.locator("#compareShowAll")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "older-only.txt [unresolved_diverged]", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "older-only.txt [unresolved_diverged]", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#diff")).toContainText("older-only.txt");
  await expect(page.getByRole("button", { name: "row-001.txt [resolved_uncommitted]", exact: true })).toHaveCount(0);
  await expect(page).toHaveTitle(new RegExp(olderSnapshotId));
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
  await expect(page.getByRole("button", { name: "row-001.txt [resolved_uncommitted]", exact: true })).toHaveCount(0);
});
