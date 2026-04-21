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

async function waitForExternalDiffLog(logFile) {
  for (let attempt = 0; attempt < EXTERNAL_DIFF_LOG_WAIT_ATTEMPTS; attempt += 1) {
    if (fs.existsSync(logFile)) {
      const text = fs.readFileSync(logFile, "utf8");
      if (/\n\s*\n\s*$/.test(text)) return text;
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
    tool: "fake-template",
  });

  const logFields = parseKeyValueLog(await waitForExternalDiffLog(logFile));
  const spawnLogText = await waitForExternalDiffLog(spawnLogFile);
  expect(logFields.tool).toBe("fake-template");
  expect(logFields.arg_0).toBe("--left");
  expect(logFields.arg_1, "template snapshot path should be captured").toBeTruthy();
  expect(logFields.arg_2).toBe("--title");
  expect(logFields.arg_3).toBe("Snapshot file");
  expect(logFields.arg_4).toBe("--right");
  expect(logFields.arg_5, "template current path should be captured").toBeTruthy();
  expect(fs.existsSync(logFields.arg_1)).toBeTruthy();
  expect(fs.existsSync(logFields.arg_5)).toBeTruthy();

  expect(spawnLogText).toContain("command=fake-template");
  expect(spawnLogText).toContain("detached=true");
  expect(spawnLogText).toContain("arg_0=--left");
  expect(spawnLogText).toContain("arg_2=--title");
  expect(spawnLogText).toContain("arg_3=Snapshot file");
  expect(spawnLogText).toContain("arg_4=--right");
});

test("compare preview and external diff materialize untracked snapshot targets from untracked.tar", async ({ page }) => {
  const { guiUrl, logFile, spawnLogFile } = getGuiTestEnv();

  await page.goto(guiUrl);

  await openCompareRow(page, "inspect-untracked.txt [unresolved_diverged]");
  await waitForDiffReady(page);
  await expect(page.locator("#diff")).toContainText("captured untracked line 1");
  await expect(page.locator("#diff")).toContainText("captured untracked line 2");
  await expect(page.locator("#diff")).toContainText("current untracked divergence");
  await expect(page.locator("#openExternal")).toBeEnabled();

  const openResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === "POST" && response.url().includes("/api/open?");
  });

  await page.locator("#openExternal").click();

  const openResponse = await openResponsePromise;
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: true,
    tool: "fake-template",
  });

  const logFields = parseKeyValueLog(await waitForExternalDiffLog(logFile));
  const spawnLogText = await waitForExternalDiffLog(spawnLogFile);
  const snapshotFileText = fs.readFileSync(logFields.arg_1, "utf8");
  const currentFileText = fs.readFileSync(logFields.arg_5, "utf8");

  expect(snapshotFileText).toContain("captured untracked line 1");
  expect(snapshotFileText).toContain("captured untracked line 2");
  expect(snapshotFileText).not.toContain("current untracked divergence");
  expect(currentFileText).toContain("captured untracked line 1");
  expect(currentFileText).toContain("captured untracked line 2");
  expect(currentFileText).toContain("current untracked divergence");

  expect(spawnLogText).toContain("command=fake-template");
  expect(spawnLogText).toContain("detached=true");
  expect(spawnLogText).toContain("arg_0=--left");
  expect(spawnLogText).toContain("arg_4=--right");
});

test("current-only compare rows materialize an empty snapshot side for external diff", async ({ page }) => {
  const { guiUrl, logFile, spawnLogFile } = getGuiTestEnv();

  await page.goto(guiUrl);

  await openCompareRow(page, "late-current-only.txt [unresolved_diverged]");
  await waitForDiffReady(page);
  await expect(page.locator("#diff")).toContainText("late current only line 1");
  await expect(page.locator("#openExternal")).toBeEnabled();

  const openResponsePromise = page.waitForResponse((response) => {
    return response.request().method() === "POST" && response.url().includes("/api/open?");
  });

  await page.locator("#openExternal").click();

  const openResponse = await openResponsePromise;
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: true,
    tool: "fake-template",
  });

  const logFields = parseKeyValueLog(await waitForExternalDiffLog(logFile));
  const spawnLogText = await waitForExternalDiffLog(spawnLogFile);
  const snapshotFileText = fs.readFileSync(logFields.arg_1, "utf8");
  const currentFileText = fs.readFileSync(logFields.arg_5, "utf8");

  expect(snapshotFileText).toBe("");
  expect(currentFileText).toContain("late current only line 1");
  expect(currentFileText).toContain("late current only line 2");
  expect(spawnLogText).toContain("command=fake-template");
});

test("custom external diff templates keep $SOURCE and $TARGET stable when compare_base=snapshot", async ({ page }) => {
  const { guiUrl, logFile, spawnLogFile } = getGuiTestEnv();
  const requestUrl = new URL("/api/open", guiUrl);
  requestUrl.searchParams.set("repo", ".");
  requestUrl.searchParams.set("file", "inspect-untracked.txt");
  requestUrl.searchParams.set("compare_base", "snapshot");

  const openResponse = await page.request.post(requestUrl.toString());
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: true,
    tool: "fake-template",
  });

  const logFields = parseKeyValueLog(await waitForExternalDiffLog(logFile));
  const spawnLogText = await waitForExternalDiffLog(spawnLogFile);
  const snapshotFileText = fs.readFileSync(logFields.arg_1, "utf8");
  const currentFileText = fs.readFileSync(logFields.arg_5, "utf8");

  expect(snapshotFileText).toContain("captured untracked line 1");
  expect(snapshotFileText).toContain("captured untracked line 2");
  expect(snapshotFileText).not.toContain("current untracked divergence");
  expect(currentFileText).toContain("captured untracked line 1");
  expect(currentFileText).toContain("captured untracked line 2");
  expect(currentFileText).toContain("current untracked divergence");
  expect(spawnLogText).toContain("command=fake-template");
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
