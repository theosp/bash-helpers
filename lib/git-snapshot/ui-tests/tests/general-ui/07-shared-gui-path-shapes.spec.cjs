const fs = require("fs");
const { test, expect } = require("@playwright/test");

test.setTimeout(120000);

function getGuiEnv() {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const snapshotId = process.env.GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID;
  const repoBundleDir = process.env.GIT_SNAPSHOT_UI_TEST_PRIMARY_REPO_BUNDLE_DIR;
  const trailingPath = process.env.GIT_SNAPSHOT_UI_TEST_TRAILING_SPACE_PATH;
  const newlinePath = process.env.GIT_SNAPSHOT_UI_TEST_NEWLINE_PATH;
  const tabPath = process.env.GIT_SNAPSHOT_UI_TEST_TAB_PATH;

  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(snapshotId, "GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID must be set by prepare-env").toBeTruthy();
  expect(repoBundleDir, "GIT_SNAPSHOT_UI_TEST_PRIMARY_REPO_BUNDLE_DIR must be set by prepare-env").toBeTruthy();
  expect(trailingPath, "GIT_SNAPSHOT_UI_TEST_TRAILING_SPACE_PATH must be set by prepare-env").toBeTruthy();
  expect(newlinePath, "GIT_SNAPSHOT_UI_TEST_NEWLINE_PATH must be set by prepare-env").toBeTruthy();
  expect(tabPath, "GIT_SNAPSHOT_UI_TEST_TAB_PATH must be set by prepare-env").toBeTruthy();

  return { guiUrl, snapshotId, repoBundleDir, trailingPath, newlinePath, tabPath };
}

async function fetchGuiRequest(page, url, timeout = 120000) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await page.request.get(url, { timeout });
    } catch (error) {
      const message = String((error && error.message) || error || "");
      const transient = message.includes("ECONNRESET")
        || message.includes("ERR_CONNECTION_REFUSED")
        || message.includes("socket hang up");
      if (!transient || attempt === 3) {
        throw error;
      }
      lastError = error;
      await page.waitForTimeout(250 * (attempt + 1));
    }
  }
  throw lastError || new Error(`Failed to fetch GUI request: ${url}`);
}

test("shared GUI compare and inspect APIs preserve trailing-space filenames", async ({ page }) => {
  const { guiUrl, snapshotId, trailingPath, newlinePath, tabPath } = getGuiEnv();
  const encodedPath = encodeURIComponent(trailingPath);
  const encodedNewlinePath = encodeURIComponent(newlinePath);
  const encodedTabPath = encodeURIComponent(tabPath);

  const compareDataResponse = await page.request.get(
    guiUrl +
      "api/data?" +
      new URLSearchParams({
        mode: "compare",
        snapshot_id: snapshotId,
        repo_filter: ".",
        compare_include_no_effect: "true",
        inspect_include_staged: "true",
        inspect_include_unstaged: "true",
        inspect_include_untracked: "true",
        inspect_show_all_repos: "false",
      }).toString()
  );
  expect(compareDataResponse.ok()).toBeTruthy();
  const compareData = await compareDataResponse.json();
  expect(compareData.rows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        file: trailingPath,
      }),
    ])
  );

  const comparePreviewResponse = await page.request.get(
    `${guiUrl}api/preview?mode=compare&snapshot_id=${encodeURIComponent(snapshotId)}&repo_filter=.&compare_include_no_effect=true&inspect_include_staged=true&inspect_include_unstaged=true&inspect_include_untracked=true&inspect_show_all_repos=false&repo=.&file=${encodedPath}`
  );
  expect(comparePreviewResponse.ok()).toBeTruthy();
  const comparePreviewText = await comparePreviewResponse.text();
  expect(comparePreviewText.length).toBeGreaterThan(0);
  expect(comparePreviewText).not.toContain("Unknown compare row");
  expect(comparePreviewText).toContain("captured trailing-space payload");
  expect(comparePreviewText).toContain("current trailing-space divergence");

  const inspectDataResponse = await page.request.get(
    guiUrl +
      "api/data?" +
      new URLSearchParams({
        mode: "inspect",
        snapshot_id: snapshotId,
        repo_filter: ".",
        compare_include_no_effect: "true",
        inspect_include_staged: "false",
        inspect_include_unstaged: "false",
        inspect_include_untracked: "true",
        inspect_show_all_repos: "false",
      }).toString()
  );
  expect(inspectDataResponse.ok()).toBeTruthy();
  const inspectData = await inspectDataResponse.json();
  expect(inspectData.fileRows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        category: "untracked",
        file: trailingPath,
      }),
    ])
  );

  const inspectPreviewResponse = await page.request.get(
    `${guiUrl}api/preview?mode=inspect&snapshot_id=${encodeURIComponent(snapshotId)}&repo_filter=.&compare_include_no_effect=true&inspect_include_staged=false&inspect_include_unstaged=false&inspect_include_untracked=true&inspect_show_all_repos=false&repo=.&category=untracked&file=${encodedPath}`
  );
  expect(inspectPreviewResponse.ok()).toBeTruthy();
  await expect(inspectPreviewResponse.text()).resolves.toContain("captured trailing-space payload");

  const browseDataResponse = await page.request.get(
    guiUrl +
      "api/data?" +
      new URLSearchParams({
        mode: "browse",
        repo_filter: ".",
        browse_include_staged: "false",
        browse_include_unstaged: "false",
        browse_include_untracked: "true",
        browse_include_submodules: "false",
        browse_show_all_repos: "false",
      }).toString()
  );
  expect(browseDataResponse.ok()).toBeTruthy();
  const browseData = await browseDataResponse.json();
  expect(browseData.fileRows).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        category: "untracked",
        file: newlinePath,
      }),
    ])
  );

  const browsePreviewResponse = await page.request.get(
    `${guiUrl}api/preview?mode=browse&repo_filter=.&browse_include_staged=false&browse_include_unstaged=false&browse_include_untracked=true&browse_include_submodules=false&browse_show_all_repos=false&repo=.&category=untracked&file=${encodedNewlinePath}`
  );
  expect(browsePreviewResponse.ok()).toBeTruthy();
  const browsePreviewText = await browsePreviewResponse.text();
  expect(browsePreviewText).toContain("captured newline payload");
  expect(browsePreviewText).toContain("current newline divergence");

  const inspectNewlinePreviewResponse = await page.request.get(
    `${guiUrl}api/preview?mode=inspect&snapshot_id=${encodeURIComponent(snapshotId)}&repo_filter=.&compare_include_no_effect=true&inspect_include_staged=false&inspect_include_unstaged=false&inspect_include_untracked=true&inspect_show_all_repos=false&repo=.&category=untracked&file=${encodedNewlinePath}`
  );
  expect(inspectNewlinePreviewResponse.ok()).toBeTruthy();
  await expect(inspectNewlinePreviewResponse.text()).resolves.toContain("captured newline payload");

  await page.goto(
    `${guiUrl}?mode=browse&repo_filter=.&browse_include_staged=false&browse_include_unstaged=false&browse_include_untracked=true&browse_include_submodules=false&browse_show_all_repos=false&selected_kind=file&selected_repo=.&selected_category=untracked&selected_file=${encodedTabPath}`
  );
  await page.waitForSelector("#list .row.active");
  await page.waitForFunction(() => {
    const diff = document.getElementById("diff");
    return diff && !diff.classList.contains("loading");
  });
  await expect(page.locator("#diff")).toContainText("captured tab payload");
  await expect(page.locator("#list .row.active")).toContainText("tab");
  await expect(page.locator("#list .row.active")).toContainText("path.txt");

  await page.reload();
  await page.waitForSelector("#list .row.active");
  await page.waitForFunction(() => {
    const diff = document.getElementById("diff");
    return diff && !diff.classList.contains("loading");
  });
  await expect(page.locator("#diff")).toContainText("captured tab payload");
  await expect(page.locator("#list .row.active")).toContainText("tab");
  await expect(page.locator("#list .row.active")).toContainText("path.txt");
});

test("browse viewed-state keeps tab-shaped file identity stable across reload", async ({ page }) => {
  const { guiUrl, tabPath } = getGuiEnv();
  const encodedTabPath = encodeURIComponent(tabPath);

  await page.goto(
    `${guiUrl}?mode=browse&repo_filter=.&browse_include_staged=false&browse_include_unstaged=false&browse_include_untracked=true&browse_include_submodules=false&browse_show_all_repos=false&selected_kind=file&selected_repo=.&selected_category=untracked&selected_file=${encodedTabPath}`
  );
  await page.waitForSelector("#list .file-row-shell.active");
  await page.waitForFunction(() => {
    const diff = document.getElementById("diff");
    return diff && !diff.classList.contains("loading");
  });
  const activeShell = page.locator("#list .file-row-shell.active");
  await expect(activeShell).toContainText("tab");
  await expect(activeShell).toContainText("path.txt");
  const markResponse = await page.request.post(
    `${guiUrl}api/viewed/mark?mode=browse&repo_filter=.&browse_include_staged=false&browse_include_unstaged=false&browse_include_untracked=true&browse_include_submodules=false&browse_show_all_repos=false&selected_kind=file&selected_repo=.&selected_category=untracked&selected_file=${encodedTabPath}`,
    {
      data: {
        repo: ".",
        category: "untracked",
        file: tabPath,
      },
    }
  );
  expect(markResponse.ok()).toBeTruthy();
  const markPayload = await markResponse.json();
  expect(markPayload.ok).toBeTruthy();

  await page.reload();
  await page.waitForSelector("#list .file-row-shell.active");
  await page.waitForFunction(() => {
    const diff = document.getElementById("diff");
    return diff && !diff.classList.contains("loading");
  });
  await expect(page.locator("#viewedActionsButton")).toContainText("Viewed (1)");
  await expect(page.locator("#list .file-row-shell.active")).toContainText("Viewed");
  await expect(page.locator("#list .row.active")).toContainText("tab");
  await expect(page.locator("#list .row.active")).toContainText("path.txt");
});

test("compare preview surfaces staged snapshot materialization failures instead of diffing against empty content", async ({ page }) => {
  const { guiUrl, snapshotId, repoBundleDir } = getGuiEnv();
  const stagedPatchPath = `${repoBundleDir}/staged.patch`;
  const originalPatch = fs.readFileSync(stagedPatchPath, "utf8");
  const refreshParams = new URLSearchParams({
    mode: "compare",
    snapshot_id: snapshotId,
    repo_filter: ".",
    compare_include_no_effect: "true",
    inspect_include_staged: "true",
    inspect_include_unstaged: "true",
    inspect_include_untracked: "true",
    inspect_show_all_repos: "false",
    force: "1",
  });

  try {
    fs.writeFileSync(stagedPatchPath, "this-is-not-a-valid-patch\n", "utf8");

    const refreshResponse = await fetchGuiRequest(page, `${guiUrl}api/data?${refreshParams.toString()}`);
    expect(refreshResponse.ok()).toBeTruthy();

    const previewResponse = await page.request.get(
      `${guiUrl}api/preview?mode=compare&snapshot_id=${encodeURIComponent(snapshotId)}&repo_filter=.&compare_include_no_effect=true&inspect_include_staged=true&inspect_include_unstaged=true&inspect_include_untracked=true&inspect_show_all_repos=false&repo=.&file=${encodeURIComponent("000-scroll-target.txt")}`
    );

    expect(previewResponse.ok()).toBeFalsy();
    expect(previewResponse.status()).toBe(500);
    const previewText = await previewResponse.text();
    expect(previewText).toContain("Compare preview is unavailable for 000-scroll-target.txt.");
    expect(previewText).toContain("Failed to materialize staged snapshot bundle for compare.");
    expect(previewText).not.toContain("@@ -1,");

    const aggregatePreviewResponse = await page.request.get(
      `${guiUrl}api/preview?mode=compare&snapshot_id=${encodeURIComponent(snapshotId)}&repo_filter=.&compare_include_no_effect=true&inspect_include_staged=true&inspect_include_unstaged=true&inspect_include_untracked=true&inspect_show_all_repos=false&selection_kind=repo&repo=.&preview_limit=9999`
    );
    expect(aggregatePreviewResponse.ok()).toBeTruthy();
    expect(aggregatePreviewResponse.headers()["x-git-snapshot-aggregate-preview-errors"]).not.toBe("0");
    const aggregatePreviewBody = await aggregatePreviewResponse.json();
    expect(aggregatePreviewBody.preview_kind).toBe("aggregate_preview");
    expect(aggregatePreviewBody.partial_failure).toBe(true);
    expect(Number(aggregatePreviewBody.error_block_count || 0)).toBeGreaterThan(0);
    expect(String(aggregatePreviewBody.warning_message || "")).toContain("could not be rendered");
  } finally {
    fs.writeFileSync(stagedPatchPath, originalPatch, "utf8");
    await fetchGuiRequest(page, `${guiUrl}api/data?${refreshParams.toString()}`);
  }
});
