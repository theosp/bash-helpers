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
  const fallbackCommand = process.env.GIT_SNAPSHOT_UI_TEST_EDITOR_FALLBACK_COMMAND;
  const logFile = process.env.GIT_SNAPSHOT_GUI_TEST_EDITOR_LOG;
  const spawnLogFile = process.env.GIT_SNAPSHOT_GUI_TEST_EDITOR_SPAWN_LOG;

  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(repoPath, "GIT_SNAPSHOT_UI_TEST_REPO must be set by prepare-env").toBeTruthy();
  expect(logFile, "GIT_SNAPSHOT_GUI_TEST_EDITOR_LOG must be set by prepare-env").toBeTruthy();
  expect(spawnLogFile, "GIT_SNAPSHOT_GUI_TEST_EDITOR_SPAWN_LOG must be set by prepare-env").toBeTruthy();

  return { guiUrl, repoPath, fallbackCommand, logFile, spawnLogFile };
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

test.beforeEach(() => {
  const { logFile, spawnLogFile } = getGuiTestEnv();
  resetLogFile(logFile);
  resetLogFile(spawnLogFile);
});

test("browse Edit File falls back to the OS-default opener when no editor template is configured", async ({ page }) => {
  const { guiUrl, repoPath, fallbackCommand, logFile, spawnLogFile } = getGuiTestEnv();
  const stagedPath = realRepoPath(repoPath, "inspect-staged.txt");
  test.skip(!fallbackCommand, "OS-default opener fallback is only exercised on Darwin/Linux.");
  const expectedArgs = process.platform === "darwin"
    ? ["-t", stagedPath]
    : [stagedPath];

  await page.goto(guiUrl);
  await selectMode(page, "browse");
  await openRow(page, "inspect-staged.txt [staged]");
  await waitForPreviewReady(page);

  await expect(page.locator("#openExternal")).toHaveText("Edit File");
  await expect(page.locator("#openExternal")).toBeEnabled();

  const openResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === "POST" && response.url().includes("/api/open?");
  });
  await page.locator("#openExternal").click();

  const openResponse = await openResponsePromise;
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: true,
    tool: fallbackCommand,
  });

  const logFields = parseKeyValueLog(await waitForLogText(logFile));
  const spawnLogText = await waitForLogText(spawnLogFile);
  expect(logFields.tool).toBe(fallbackCommand);
  expectedArgs.forEach((arg, index) => {
    expect(logFields[`arg_${index}`]).toBe(arg);
    expect(spawnLogText).toContain(`arg_${index}=${arg}`);
  });
  expect(spawnLogText).toContain(`command=${fallbackCommand}`);
  expect(spawnLogText).toContain("detached=true");
});
