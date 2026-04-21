const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const {
  openRow,
  selectMode,
  waitForPreviewReady,
} = require("../helpers/compare-gui.cjs");

const LOG_WAIT_ATTEMPTS = 50;
const LOG_WAIT_INTERVAL_MS = 100;

function getGuiTestEnv() {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const repoPath = process.env.GIT_SNAPSHOT_UI_TEST_REPO;
  const editorTool = process.env.GIT_SNAPSHOT_UI_TEST_EDITOR_TOOL;
  const logFile = process.env.GIT_SNAPSHOT_GUI_TEST_EDITOR_LOG;
  const spawnLogFile = process.env.GIT_SNAPSHOT_GUI_TEST_EDITOR_SPAWN_LOG;

  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(repoPath, "GIT_SNAPSHOT_UI_TEST_REPO must be set by prepare-env").toBeTruthy();
  expect(editorTool, "GIT_SNAPSHOT_UI_TEST_EDITOR_TOOL must be set by prepare-env").toBeTruthy();
  expect(logFile, "GIT_SNAPSHOT_GUI_TEST_EDITOR_LOG must be set by prepare-env").toBeTruthy();
  expect(spawnLogFile, "GIT_SNAPSHOT_GUI_TEST_EDITOR_SPAWN_LOG must be set by prepare-env").toBeTruthy();

  return { guiUrl, repoPath, editorTool, logFile, spawnLogFile };
}

function resetLogFile(logFile) {
  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }
}

function parseKeyValueLog(text) {
  const fields = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    fields[line.slice(0, eq)] = line.slice(eq + 1);
  }
  return fields;
}

async function waitForLogText(logFile) {
  for (let attempt = 0; attempt < LOG_WAIT_ATTEMPTS; attempt += 1) {
    if (fs.existsSync(logFile)) {
      const text = fs.readFileSync(logFile, "utf8");
      if (/\n\s*\n\s*$/.test(text)) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, LOG_WAIT_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for log file: ${logFile}`);
}

function realRepoPath(repoPath, filePath) {
  return fs.realpathSync(path.join(repoPath, filePath));
}

async function postBrowseOpenRequest(page, guiUrl, repoRel, category, filePath) {
  const requestUrl = new URL("/api/open", guiUrl);
  requestUrl.searchParams.set("mode", "browse");
  requestUrl.searchParams.set("repo", repoRel);
  requestUrl.searchParams.set("category", category);
  requestUrl.searchParams.set("file", filePath);
  return page.request.post(requestUrl.toString());
}

test.beforeEach(() => {
  const { logFile, spawnLogFile } = getGuiTestEnv();
  resetLogFile(logFile);
  resetLogFile(spawnLogFile);
});

test("browse Edit File uses the configured editor template and opens working-tree paths", async ({ page }) => {
  const { guiUrl, repoPath, editorTool, logFile, spawnLogFile } = getGuiTestEnv();
  const stagedPath = realRepoPath(repoPath, "inspect-staged.txt");
  const unstagedPath = realRepoPath(repoPath, "inspect-unstaged.txt");
  const untrackedPath = realRepoPath(repoPath, "inspect-untracked.txt");

  await page.goto(guiUrl);
  await selectMode(page, "browse");

  await openRow(page, "inspect-staged.txt [staged]");
  await waitForPreviewReady(page);
  await expect(page.locator("#openExternal")).toHaveText("Edit File");
  await expect(page.locator("#openExternal")).toBeEnabled();

  const uiOpenResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === "POST" && response.url().includes("/api/open?");
  });
  await page.locator("#openExternal").click();

  const uiOpenResponse = await uiOpenResponsePromise;
  expect(uiOpenResponse.ok()).toBeTruthy();
  await expect(uiOpenResponse.json()).resolves.toMatchObject({
    ok: true,
    tool: editorTool,
  });

  let logFields = parseKeyValueLog(await waitForLogText(logFile));
  let spawnLogText = await waitForLogText(spawnLogFile);
  expect(logFields.tool).toBe(editorTool);
  expect(logFields.arg_0).toBe("--goto");
  expect(logFields.arg_1).toBe(stagedPath);
  expect(spawnLogText).toContain(`command=${editorTool}`);
  expect(spawnLogText).toContain("detached=true");
  expect(spawnLogText).toContain("arg_0=--goto");
  expect(spawnLogText).toContain(`arg_1=${stagedPath}`);

  resetLogFile(logFile);
  resetLogFile(spawnLogFile);
  let openResponse = await postBrowseOpenRequest(page, guiUrl, ".", "unstaged", "inspect-unstaged.txt");
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: true,
    tool: editorTool,
  });
  logFields = parseKeyValueLog(await waitForLogText(logFile));
  spawnLogText = await waitForLogText(spawnLogFile);
  expect(logFields.arg_1).toBe(unstagedPath);
  expect(spawnLogText).toContain(`arg_1=${unstagedPath}`);

  resetLogFile(logFile);
  resetLogFile(spawnLogFile);
  openResponse = await postBrowseOpenRequest(page, guiUrl, ".", "untracked", "inspect-untracked.txt");
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: true,
    tool: editorTool,
  });
  logFields = parseKeyValueLog(await waitForLogText(logFile));
  spawnLogText = await waitForLogText(spawnLogFile);
  expect(logFields.arg_1).toBe(untrackedPath);
  expect(spawnLogText).toContain(`arg_1=${untrackedPath}`);
});

test("browse Edit File stays disabled for submodule and missing-file rows and rejects invalid requests", async ({ page }) => {
  const { guiUrl, logFile, spawnLogFile } = getGuiTestEnv();

  await page.goto(guiUrl);
  await selectMode(page, "browse");

  await openRow(page, "modules/clean-sub [submodules]");
  await waitForPreviewReady(page);
  await expect(page.locator("#openExternal")).toHaveText("Edit File");
  await expect(page.locator("#openExternal")).toBeDisabled();

  let openResponse = await postBrowseOpenRequest(page, guiUrl, ".", "submodules", "modules/clean-sub");
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: false,
    error: "Edit File is not available for submodule summary rows.",
  });
  expect(fs.existsSync(logFile)).toBeFalsy();
  expect(fs.existsSync(spawnLogFile)).toBeFalsy();

  await openRow(page, "missing-preview.txt [staged]");
  await waitForPreviewReady(page);
  await expect(page.locator("#openExternal")).toBeDisabled();

  openResponse = await postBrowseOpenRequest(page, guiUrl, ".", "staged", "missing-preview.txt");
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: false,
    error: "Edit File is not available because the working tree file is missing.",
  });
  expect(fs.existsSync(logFile)).toBeFalsy();
  expect(fs.existsSync(spawnLogFile)).toBeFalsy();

  openResponse = await postBrowseOpenRequest(page, guiUrl, ".", "untracked", "not-in-browse.txt");
  expect(openResponse.ok()).toBeFalsy();
  expect(openResponse.status()).toBe(404);
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("not part of the currently cached browse rows"),
  });

  openResponse = await postBrowseOpenRequest(page, guiUrl, ".", "untracked", "../outside.txt");
  expect(openResponse.ok()).toBeFalsy();
  expect(openResponse.status()).toBe(404);
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("not part of the currently cached browse rows"),
  });
  expect(fs.existsSync(logFile)).toBeFalsy();
  expect(fs.existsSync(spawnLogFile)).toBeFalsy();
});
