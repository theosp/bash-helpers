const fs = require("fs");
const path = require("path");
const { test, expect } = require("@playwright/test");
const {
  openCompareRow,
  waitForDiffReady,
} = require("../helpers/compare-gui.cjs");

const EXTERNAL_DIFF_LOG_WAIT_ATTEMPTS = 50;
const EXTERNAL_DIFF_LOG_WAIT_INTERVAL_MS = 100;
const TARGET_REPO = ".";
const TARGET_FILE = "000-scroll-target.txt";

function getGuiTestEnv() {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const logFile = process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG;
  const spawnLogFile = process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG;
  const fakeBinDir = process.env.GIT_SNAPSHOT_UI_TEST_FAKE_BIN_DIR;

  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(logFile, "GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG must be set by prepare-env").toBeTruthy();
  expect(spawnLogFile, "GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG must be set by prepare-env").toBeTruthy();
  expect(fakeBinDir, "GIT_SNAPSHOT_UI_TEST_FAKE_BIN_DIR must be set by prepare-env").toBeTruthy();

  return { guiUrl, logFile, spawnLogFile, fakeBinDir };
}

function resetLogFile(logFile) {
  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }
}

function setToolEnabled(fakeBinDir, toolName, enabled) {
  const toolPath = path.join(fakeBinDir, toolName);
  expect(fs.existsSync(toolPath), `missing fake tool fixture: ${toolName}`).toBeTruthy();
  fs.chmodSync(toolPath, enabled ? 0o755 : 0o644);
}

function setToolAvailability(fakeBinDir, availability) {
  setToolEnabled(fakeBinDir, "meld", Boolean(availability.meld));
  setToolEnabled(fakeBinDir, "opendiff", Boolean(availability.opendiff));
  setToolEnabled(fakeBinDir, "code", Boolean(availability.code));
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

async function postOpenRequest(page, guiUrl, repoRel, filePath) {
  const requestUrl = new URL("/api/open", guiUrl);
  requestUrl.searchParams.set("repo", repoRel);
  requestUrl.searchParams.set("file", filePath);
  return page.request.post(requestUrl.toString());
}

async function waitForLogText(logFile) {
  for (let attempt = 0; attempt < EXTERNAL_DIFF_LOG_WAIT_ATTEMPTS; attempt += 1) {
    if (fs.existsSync(logFile)) {
      const text = fs.readFileSync(logFile, "utf8");
      if (text.trim()) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, EXTERNAL_DIFF_LOG_WAIT_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for log file: ${logFile}`);
}

async function expectSuccessfulAutoDetect(page, availability, expectedTool) {
  const { guiUrl, logFile, spawnLogFile, fakeBinDir } = getGuiTestEnv();
  setToolAvailability(fakeBinDir, availability);

  const openResponse = await postOpenRequest(page, guiUrl, TARGET_REPO, TARGET_FILE);
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: true,
    tool: expectedTool,
  });

  const logFields = parseKeyValueLog(await waitForLogText(logFile));
  const spawnLogText = await waitForLogText(spawnLogFile);

  expect(logFields.tool).toBe(expectedTool);
  expect(spawnLogText).toContain(`command=${expectedTool}`);
  expect(spawnLogText).toContain("detached=true");

  if (expectedTool === "code") {
    expect(logFields.arg_0).toBe("--diff");
    expect(logFields.arg_1, "code snapshot path should be captured").toBeTruthy();
    expect(logFields.arg_2, "code current path should be captured").toBeTruthy();
    expect(fs.existsSync(logFields.arg_1)).toBeTruthy();
    expect(fs.existsSync(logFields.arg_2)).toBeTruthy();
    expect(spawnLogText).toContain("arg_0=--diff");
  } else {
    expect(logFields.arg_0, `${expectedTool} snapshot path should be captured`).toBeTruthy();
    expect(logFields.arg_1, `${expectedTool} current path should be captured`).toBeTruthy();
    expect(fs.existsSync(logFields.arg_0)).toBeTruthy();
    expect(fs.existsSync(logFields.arg_1)).toBeTruthy();
  }
}

test.beforeEach(() => {
  const { logFile, spawnLogFile, fakeBinDir } = getGuiTestEnv();
  resetLogFile(logFile);
  resetLogFile(spawnLogFile);
  setToolAvailability(fakeBinDir, { meld: true, opendiff: true, code: true });
});

test("open external diff auto-detect prefers meld when all tools are available", async ({ page }) => {
  await expectSuccessfulAutoDetect(page, { meld: true, opendiff: true, code: true }, "meld");
});

test("open external diff auto-detect falls back to opendiff when meld is unavailable", async ({ page }) => {
  await expectSuccessfulAutoDetect(page, { meld: false, opendiff: true, code: true }, "opendiff");
});

test("open external diff auto-detect falls back to code --diff when only code is available", async ({ page }) => {
  await expectSuccessfulAutoDetect(page, { meld: false, opendiff: false, code: true }, "code");
});

test("open external diff shows a UI error when no supported tool is available", async ({ page }) => {
  const { guiUrl, logFile, spawnLogFile, fakeBinDir } = getGuiTestEnv();
  setToolAvailability(fakeBinDir, { meld: false, opendiff: false, code: false });

  await page.goto(guiUrl);
  await openCompareRow(page, `${TARGET_FILE} [unresolved_diverged]`);
  await waitForDiffReady(page);
  await expect(page.locator("#openExternal")).toBeEnabled();

  const dialogPromise = page.waitForEvent("dialog");
  const responsePromise = page.waitForResponse((response) => {
    return response.request().method() === "POST" && response.url().includes("/api/open?");
  });

  await page.locator("#openExternal").click();

  const dialog = await dialogPromise;
  expect(dialog.message()).toContain("No external diff tool found. Install meld, opendiff, or code.");
  await dialog.dismiss();

  const openResponse = await responsePromise;
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("No external diff tool found"),
  });

  expect(fs.existsSync(logFile)).toBeFalsy();
  expect(fs.existsSync(spawnLogFile)).toBeFalsy();
});
