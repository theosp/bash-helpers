const fs = require("fs");
const { test, expect } = require("@playwright/test");
const {
  openCompareRow,
  waitForDiffReady,
} = require("../helpers/compare-gui.cjs");

const EXTERNAL_DIFF_LOG_WAIT_ATTEMPTS = 50;
const EXTERNAL_DIFF_LOG_WAIT_INTERVAL_MS = 100;

function getGuiTestEnv() {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const logFile = process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG;
  const spawnLogFile = process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG;

  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(logFile, "GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG must be set by prepare-env").toBeTruthy();
  expect(spawnLogFile, "GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG must be set by prepare-env").toBeTruthy();

  return { guiUrl, logFile, spawnLogFile };
}

function resetLogFile(logFile) {
  if (logFile && fs.existsSync(logFile)) {
    fs.unlinkSync(logFile);
  }
}

async function postOpenRequest(page, guiUrl, repoRel, filePath) {
  const requestUrl = new URL("/api/open", guiUrl);
  requestUrl.searchParams.set("repo", repoRel);
  requestUrl.searchParams.set("file", filePath);
  return page.request.post(requestUrl.toString());
}

async function waitForExternalDiffLog(logFile) {
  for (let attempt = 0; attempt < EXTERNAL_DIFF_LOG_WAIT_ATTEMPTS; attempt += 1) {
    if (fs.existsSync(logFile)) {
      const text = fs.readFileSync(logFile, "utf8");
      if (text.trim()) return text;
    }
    await new Promise((resolve) => setTimeout(resolve, EXTERNAL_DIFF_LOG_WAIT_INTERVAL_MS));
  }

  throw new Error(`Timed out waiting for external diff log: ${logFile}`);
}

test.beforeEach(() => {
  const { logFile, spawnLogFile } = getGuiTestEnv();
  resetLogFile(logFile);
  resetLogFile(spawnLogFile);
});

test("open external diff routes through /api/open with the selected file pair", async ({ page }) => {
  const { guiUrl, logFile, spawnLogFile } = getGuiTestEnv();

  await page.goto(guiUrl);

  await openCompareRow(page, "000-scroll-target.txt [unresolved_diverged]");
  await waitForDiffReady(page);
  await expect(page.locator("#openExternal")).toBeEnabled();

  const openResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === "POST" && response.url().includes("/api/open?");
  });

  await page.locator("#openExternal").click();

  const openResponse = await openResponsePromise;
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: true,
    tool: "fake-tool",
  });

  const logText = await waitForExternalDiffLog(logFile);
  const spawnLogText = await waitForExternalDiffLog(spawnLogFile);
  expect(logText).toContain("tool=fake-tool");
  expect(spawnLogText).toContain("command=fake-tool");
  expect(spawnLogText).toContain("detached=true");

  const snapshotMatch = logText.match(/^snapshot_file=(.+)$/m);
  const currentMatch = logText.match(/^current_file=(.+)$/m);
  expect(snapshotMatch, "snapshot_file should be recorded in the launch log").toBeTruthy();
  expect(currentMatch, "current_file should be recorded in the launch log").toBeTruthy();
  expect(fs.existsSync(snapshotMatch[1])).toBeTruthy();
  expect(fs.existsSync(currentMatch[1])).toBeTruthy();
});

test("open external diff rejects rows outside the cached compare set", async ({ page }) => {
  const { guiUrl, logFile, spawnLogFile } = getGuiTestEnv();
  const openResponse = await postOpenRequest(page, guiUrl, ".", "not-in-compare.txt");

  expect(openResponse.ok()).toBeFalsy();
  expect(openResponse.status()).toBe(404);
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("not part of the currently cached compare rows"),
  });
  expect(fs.existsSync(logFile)).toBeFalsy();
  expect(fs.existsSync(spawnLogFile)).toBeFalsy();
});

test("open external diff rejects traversal-style file paths", async ({ page }) => {
  const { guiUrl, logFile, spawnLogFile } = getGuiTestEnv();
  const openResponse = await postOpenRequest(page, guiUrl, ".", "../outside.txt");

  expect(openResponse.ok()).toBeFalsy();
  expect(openResponse.status()).toBe(404);
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("not part of the currently cached compare rows"),
  });
  expect(fs.existsSync(logFile)).toBeFalsy();
  expect(fs.existsSync(spawnLogFile)).toBeFalsy();
});
