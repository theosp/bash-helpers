const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const {
  openRow,
  openSnapshotPanel,
  selectMode,
  waitForGuiDataReady,
  waitForPreviewReady,
} = require("../helpers/compare-gui.cjs");

const LOG_WAIT_ATTEMPTS = 50;
const LOG_WAIT_INTERVAL_MS = 100;

function getGuiConfigEnv() {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const repoPath = process.env.GIT_SNAPSHOT_UI_TEST_REPO;
  const configFile = process.env.GIT_SNAPSHOT_UI_TEST_CONFIG_FILE;
  const configPortStart = Number(process.env.GIT_SNAPSHOT_UI_TEST_CONFIG_PORT_START || 0);
  const configPortCount = Number(process.env.GIT_SNAPSHOT_UI_TEST_CONFIG_PORT_COUNT || 0);
  const editorLog = process.env.GIT_SNAPSHOT_GUI_TEST_EDITOR_LOG;
  const externalDiffLog = process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG;

  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(repoPath, "GIT_SNAPSHOT_UI_TEST_REPO must be set by prepare-env").toBeTruthy();
  expect(configFile, "GIT_SNAPSHOT_UI_TEST_CONFIG_FILE must be set by prepare-env").toBeTruthy();
  expect(configPortStart, "GIT_SNAPSHOT_UI_TEST_CONFIG_PORT_START must be set by prepare-env").toBeGreaterThan(0);
  expect(configPortCount, "GIT_SNAPSHOT_UI_TEST_CONFIG_PORT_COUNT must be set by prepare-env").toBeGreaterThan(0);
  expect(editorLog, "GIT_SNAPSHOT_GUI_TEST_EDITOR_LOG must be set by prepare-env").toBeTruthy();
  expect(externalDiffLog, "GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG must be set by prepare-env").toBeTruthy();

  return {
    guiUrl,
    repoPath,
    configFile,
    configPortStart,
    configPortCount,
    editorLog,
    externalDiffLog,
  };
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
  const { editorLog, externalDiffLog } = getGuiConfigEnv();
  resetLogFile(editorLog);
  resetLogFile(externalDiffLog);
});

test("repo config seeds compare base, show-auto, editor launch, external diff launch, and server port defaults", async ({ page }) => {
  const {
    guiUrl,
    repoPath,
    configFile,
    configPortStart,
    configPortCount,
    editorLog,
    externalDiffLog,
  } = getGuiConfigEnv();

  expect(fs.existsSync(configFile)).toBeTruthy();
  const guiPort = Number(new URL(guiUrl).port);
  expect(guiPort).toBeGreaterThanOrEqual(configPortStart);
  expect(guiPort).toBeLessThan(configPortStart + configPortCount);

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await expect(page.locator("#compareBaseSnapshot")).toBeChecked();

  await openSnapshotPanel(page);
  await expect(page.locator("#snapshotShowAuto")).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(page.locator("#snapshotOverlay")).toBeHidden();

  await selectMode(page, "browse");
  await openRow(page, "inspect-staged.txt [staged]");
  await waitForPreviewReady(page);

  const browseOpenResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === "POST" && response.url().includes("/api/open?");
  });
  await page.locator("#openExternal").click();
  const browseOpenResponse = await browseOpenResponsePromise;
  expect(browseOpenResponse.ok()).toBeTruthy();
  await expect(browseOpenResponse.json()).resolves.toMatchObject({
    ok: true,
    tool: "code",
  });

  let logFields = parseKeyValueLog(await waitForLogText(editorLog));
  expect(logFields.arg_0).toBe("-g");
  expect(logFields.arg_1).toBe(realRepoPath(repoPath, "inspect-staged.txt"));

  resetLogFile(externalDiffLog);
  await selectMode(page, "compare");
  await expect(page.locator("#compareBaseSnapshot")).toBeChecked();
  await openRow(page, "000-scroll-target.txt [unresolved_diverged]");
  await waitForPreviewReady(page);

  const diffOpenResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === "POST" && response.url().includes("/api/open?");
  });
  await page.locator("#openExternal").click();
  const diffOpenResponse = await diffOpenResponsePromise;
  expect(diffOpenResponse.ok()).toBeTruthy();
  await expect(diffOpenResponse.json()).resolves.toMatchObject({
    ok: true,
    tool: "code",
  });

  logFields = parseKeyValueLog(await waitForLogText(externalDiffLog));
  expect(logFields.tool).toBe("code");
  expect(logFields.arg_0).toBe("--diff");
  expect(path.basename(logFields.arg_1 || "")).toBe("000-scroll-target.txt");
  expect(path.basename(logFields.arg_2 || "")).toBe("000-scroll-target.txt");
});
