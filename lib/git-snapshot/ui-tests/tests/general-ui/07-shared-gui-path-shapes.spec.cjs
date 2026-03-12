const { test, expect } = require("@playwright/test");

function getGuiEnv() {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const snapshotId = process.env.GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID;
  const trailingPath = process.env.GIT_SNAPSHOT_UI_TEST_TRAILING_SPACE_PATH;

  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(snapshotId, "GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID must be set by prepare-env").toBeTruthy();
  expect(trailingPath, "GIT_SNAPSHOT_UI_TEST_TRAILING_SPACE_PATH must be set by prepare-env").toBeTruthy();

  return { guiUrl, snapshotId, trailingPath };
}

test("shared GUI compare and inspect APIs preserve trailing-space filenames", async ({ page }) => {
  const { guiUrl, snapshotId, trailingPath } = getGuiEnv();
  const encodedPath = encodeURIComponent(trailingPath);

  const compareDataResponse = await page.request.get(
    guiUrl +
      "api/data?" +
      new URLSearchParams({
        mode: "compare",
        snapshot_id: snapshotId,
        repo_filter: ".",
        compare_show_all: "true",
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
    `${guiUrl}api/preview?mode=compare&snapshot_id=${encodeURIComponent(snapshotId)}&repo_filter=.&compare_show_all=true&inspect_include_staged=true&inspect_include_unstaged=true&inspect_include_untracked=true&inspect_show_all_repos=false&repo=.&file=${encodedPath}`
  );
  expect(comparePreviewResponse.ok()).toBeTruthy();
  const comparePreviewText = await comparePreviewResponse.text();
  expect(comparePreviewText.length).toBeGreaterThan(0);
  expect(comparePreviewText).not.toContain("Unknown compare row");
  expect(
    comparePreviewText.includes(`No textual differences. (${trailingPath})`) ||
      comparePreviewText.includes("captured trailing-space payload")
  ).toBeTruthy();

  const inspectDataResponse = await page.request.get(
    guiUrl +
      "api/data?" +
      new URLSearchParams({
        mode: "inspect",
        snapshot_id: snapshotId,
        repo_filter: ".",
        compare_show_all: "true",
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
    `${guiUrl}api/preview?mode=inspect&snapshot_id=${encodeURIComponent(snapshotId)}&repo_filter=.&compare_show_all=true&inspect_include_staged=false&inspect_include_unstaged=false&inspect_include_untracked=true&inspect_show_all_repos=false&repo=.&category=untracked&file=${encodedPath}`
  );
  expect(inspectPreviewResponse.ok()).toBeTruthy();
  await expect(inspectPreviewResponse.text()).resolves.toContain("captured trailing-space payload");
});
