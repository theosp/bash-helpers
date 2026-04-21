const fs = require("fs");
const { execFileSync } = require("child_process");
const path = require("path");
const os = require("os");
const { test, expect } = require("@playwright/test");
const {
  addReviewRepo,
  closeReviewSelectionTray,
  closeSnapshotPanel,
  closeRefreshMenu,
  closeFiltersPanel,
  deleteReviewPreset,
  dragReviewRepo,
  loadReviewPreset,
  openFilterableSelect,
  openFiltersPanel,
  openRefreshMenu,
  openRow,
  openSnapshotPanel,
  openCreateSnapshotDialog,
  openReviewPresetActionsMenu,
  openReviewSelectionTray,
  selectMode,
  selectCompareBase,
  readGuiViewLoadState,
  selectRepoFilter,
  selectSnapshot,
  setCheckbox,
  saveReviewPreset,
  submitCreateSnapshotDialog,
  triggerHardRefresh,
  triggerRefresh,
  waitForGuiDataReady,
  waitForNextGuiRefresh,
  waitForPreviewReady,
  waitForRefreshHintState,
  waitForRefreshState,
  renameReviewPreset,
  selectReviewBase,
  selectReviewRepoBase,
  waitForReviewReposParam,
  waitForReviewBaseParam,
  waitForReviewRepoBasesParam,
} = require("../helpers/compare-gui.cjs");

const COMPARE_BASE_STORAGE_KEY = "git-snapshot.gui.compare.base.v1";
const ASK_HISTORY_STORAGE_KEY = "git-snapshot.gui.ask.history.v1";
const GIT_SNAPSHOT_BIN = path.resolve(__dirname, "../../../../../bin/git-snapshot");
const BASELINE_FIXTURE_ROOT = process.env.GIT_SNAPSHOT_UI_TEST_REPO || "";
const BASELINE_FIXTURE_HOME = BASELINE_FIXTURE_ROOT
  ? fs.mkdtempSync(path.join(os.tmpdir(), "git-snapshot-shared-controls-baseline-"))
  : "";
const BASELINE_FIXTURE_SNAPSHOT_ID = BASELINE_FIXTURE_ROOT ? uniqueSnapshotId("shared-controls-baseline") : "";
let baselineFixtureHead = "";
const FIXTURE_RECOVERY_SUMMARY_FILE = process.env.GIT_SNAPSHOT_UI_TEST_RUNTIME_DIR
  ? path.join(process.env.GIT_SNAPSHOT_UI_TEST_RUNTIME_DIR, "fixture-recovery-summary.json")
  : "";
const fixtureRecoveryState = {
  events: [],
};

test.setTimeout(120000);

function getGuiEnv() {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const primarySnapshotId = process.env.GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID;
  const primarySnapshotRoot = process.env.GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ROOT;
  const olderSnapshotId = process.env.GIT_SNAPSHOT_UI_TEST_OLDER_SNAPSHOT_ID;
  const repoPath = process.env.GIT_SNAPSHOT_UI_TEST_REPO;

  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(primarySnapshotId, "GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID must be set by prepare-env").toBeTruthy();
  expect(primarySnapshotRoot, "GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ROOT must be set by prepare-env").toBeTruthy();
  expect(olderSnapshotId, "GIT_SNAPSHOT_UI_TEST_OLDER_SNAPSHOT_ID must be set by prepare-env").toBeTruthy();
  expect(repoPath, "GIT_SNAPSHOT_UI_TEST_REPO must be set by prepare-env").toBeTruthy();

  return {
    guiUrl,
    primarySnapshotId,
    primarySnapshotRoot,
    olderSnapshotId,
    repoPath,
    snapshotHome: path.dirname(path.dirname(primarySnapshotRoot)),
  };
}

function getGuiServerPid() {
  const rawPid = String(process.env.GIT_SNAPSHOT_UI_TEST_GUI_PID || "").trim();
  expect(rawPid, "GIT_SNAPSHOT_UI_TEST_GUI_PID must be set by prepare-env").toBeTruthy();
  const pid = Number(rawPid);
  expect(Number.isInteger(pid) && pid > 0, `Invalid GUI pid from prepare-env: ${rawPid}`).toBeTruthy();
  return pid;
}

function expectGuiServerAlive(label) {
  const pid = getGuiServerPid();
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch (_error) {
    alive = false;
  }
  expect(alive, label || `Expected GUI server pid ${pid} to still be alive.`).toBe(true);
}

function recordFixtureRecoveryEvent(type, details) {
  const event = Object.assign({
    type: String(type || "event"),
    at: new Date().toISOString(),
  }, details && typeof details === "object" ? details : {});
  fixtureRecoveryState.events.push(event);
  persistFixtureRecoverySummary();
  console.warn("[fixture-recovery]", JSON.stringify(event));
  return event;
}

function fixtureRecoverySummary() {
  const summary = {
    total: fixtureRecoveryState.events.length,
    byType: {},
  };
  for (const event of fixtureRecoveryState.events) {
    const type = String(event && event.type ? event.type : "event");
    summary.byType[type] = Number(summary.byType[type] || 0) + 1;
  }
  return summary;
}

function persistFixtureRecoverySummary() {
  if (!FIXTURE_RECOVERY_SUMMARY_FILE) {
    return;
  }
  fs.writeFileSync(FIXTURE_RECOVERY_SUMMARY_FILE, JSON.stringify({
    summary: fixtureRecoverySummary(),
    events: fixtureRecoveryState.events,
  }, null, 2) + "\n", "utf8");
}

function physicalPath(targetPath) {
  if (fs.realpathSync && typeof fs.realpathSync.native === "function") {
    return fs.realpathSync.native(targetPath);
  }
  return fs.realpathSync(targetPath);
}

function viewedStateArtifacts(repoPath, snapshotHome) {
  const storeDir = path.join(snapshotHome, "git-snapshots", path.basename(repoPath));
  return {
    stateFile: path.join(storeDir, ".viewed-state.json"),
    previewBlobsDir: path.join(storeDir, "viewed-preview-blobs"),
  };
}

function clearViewedArtifacts(repoPath, snapshotHome) {
  const artifacts = viewedStateArtifacts(repoPath, snapshotHome);
  fs.rmSync(artifacts.stateFile, { force: true });
  fs.rmSync(artifacts.previewBlobsDir, { recursive: true, force: true });
}

async function resetViewedStateForTest(page, guiUrl, repoPath, snapshotHome, mode = "browse") {
  clearViewedArtifacts(repoPath, snapshotHome);
  const clearUrl = new URL("api/viewed/clear", guiUrl);
  clearUrl.searchParams.set("mode", String(mode || "browse"));
  const clearResponse = await page.request.post(clearUrl.toString(), {
    data: { scope: "all" },
  });
  expect(clearResponse.ok()).toBeTruthy();
}

function viewedStateEntryKey(mode, repoRel, category, filePath) {
  return JSON.stringify([
    String(mode || ""),
    String(repoRel || ""),
    String(category || ""),
    String(filePath || ""),
  ]);
}

function readViewedStateFile(repoPath, snapshotHome) {
  const artifacts = viewedStateArtifacts(repoPath, snapshotHome);
  if (!fs.existsSync(artifacts.stateFile)) {
    return { roots: {} };
  }
  return JSON.parse(fs.readFileSync(artifacts.stateFile, "utf8"));
}

function writeViewedStateFile(repoPath, snapshotHome, doc) {
  const artifacts = viewedStateArtifacts(repoPath, snapshotHome);
  fs.mkdirSync(path.dirname(artifacts.stateFile), { recursive: true });
  fs.writeFileSync(artifacts.stateFile, JSON.stringify(doc, null, 2) + "\n", "utf8");
  return artifacts;
}

async function installClipboardProbe(page) {
  await page.evaluate(() => {
    const state = { writes: [] };
    Object.defineProperty(window, "__gitSnapshotClipboardProbe", {
      configurable: true,
      value: state,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(text) {
          state.writes.push(String(text));
        },
        async readText() {
          return state.writes.length ? state.writes[state.writes.length - 1] : "";
        },
      },
    });
  });
}

async function installClipboardFailureProbe(page) {
  await page.evaluate(() => {
    const state = { writes: [], failures: [] };
    Object.defineProperty(window, "__gitSnapshotClipboardProbe", {
      configurable: true,
      value: state,
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        async writeText(text) {
          state.writes.push(String(text));
          state.failures.push("navigator-denied");
          throw new Error("Clipboard denied for test");
        },
        async readText() {
          return state.writes.length ? state.writes[state.writes.length - 1] : "";
        },
      },
    });
    document.execCommand = () => false;
  });
}

async function lastClipboardWrite(page) {
  return page.evaluate(() => {
    const probe = window.__gitSnapshotClipboardProbe && Array.isArray(window.__gitSnapshotClipboardProbe.writes)
      ? window.__gitSnapshotClipboardProbe.writes
      : [];
    return probe.length ? String(probe[probe.length - 1] || "") : "";
  });
}

async function clipboardWriteCount(page) {
  return page.evaluate(() => {
    const probe = window.__gitSnapshotClipboardProbe && Array.isArray(window.__gitSnapshotClipboardProbe.writes)
      ? window.__gitSnapshotClipboardProbe.writes
      : [];
    return probe.length;
  });
}

async function lastDiffSelectionDebugEvent(page) {
  return page.evaluate(() => {
    const debugState = window.__gitSnapshotDiffSelectionDebug && typeof window.__gitSnapshotDiffSelectionDebug === "object"
      ? window.__gitSnapshotDiffSelectionDebug
      : {};
    return {
      lastClipboardFailure: debugState.lastClipboardFailure || null,
      lastSelectionCapture: debugState.lastSelectionCapture || null,
    };
  });
}

async function selectTextRange(page, options) {
  return page.evaluate((selectionOptions) => {
    function nthTextNode(element, index) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
      let textNode = walker.nextNode();
      let currentIndex = 0;
      while (textNode) {
        if (currentIndex === index) {
          return textNode;
        }
        currentIndex += 1;
        textNode = walker.nextNode();
      }
      return null;
    }

    const startElement = document.querySelectorAll(selectionOptions.startSelector || "")[selectionOptions.startIndex || 0] || null;
    const endElement = document.querySelectorAll(selectionOptions.endSelector || selectionOptions.startSelector || "")[selectionOptions.endIndex || 0] || null;
    if (!startElement || !endElement) {
      return "";
    }
    const startNode = nthTextNode(startElement, selectionOptions.startTextNodeIndex || 0);
    const endNode = nthTextNode(endElement, selectionOptions.endTextNodeIndex || 0);
    if (!startNode || !endNode) {
      return "";
    }
    const range = document.createRange();
    range.setStart(startNode, Math.max(0, Math.min(Number(selectionOptions.startOffset || 0) || 0, startNode.textContent.length)));
    range.setEnd(endNode, Math.max(0, Math.min(Number(selectionOptions.endOffset || 0) || 0, endNode.textContent.length)));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  }, options);
}

async function selectTextWithinElement(page, selector, startOffset, endOffset, index = 0) {
  return selectTextRange(page, {
    startSelector: selector,
    endSelector: selector,
    startIndex: index,
    endIndex: index,
    startOffset,
    endOffset,
  });
}

async function triggerDiffSelectionContextMenu(page, selector, index = 0) {
  await page.evaluate(({ targetSelector, targetIndex }) => {
    const nodes = document.querySelectorAll(targetSelector);
    const element = nodes[targetIndex];
    if (!element) {
      return;
    }
    const rect = element.getBoundingClientRect();
    element.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: Math.round(rect.left + Math.min(12, Math.max(4, rect.width / 2))),
      clientY: Math.round(rect.top + Math.min(12, Math.max(4, rect.height / 2))),
    }));
  }, {
    targetSelector: selector,
    targetIndex: Number(index || 0) || 0,
  });
}

async function openDiffSelectionContextMenu(page, selector, index = 0) {
  await triggerDiffSelectionContextMenu(page, selector, index);
  await expect(page.locator("#diffSelectionContextMenu")).toBeVisible();
}

async function firstNonEmptyDiffTextTarget(page) {
  return page.evaluate(() => {
    const candidates = [
      "#diff .diff-line.add .diff-code",
      "#diff .diff-line.del .diff-code",
      "#diff .diff-line .diff-code",
      "#diff .aggregate-preview-block .diff-code",
      "#diff .aggregate-preview-pre",
      "#diff .preview-pre",
    ];
    for (const selector of candidates) {
      const nodes = Array.from(document.querySelectorAll(selector));
      const index = nodes.findIndex((node) => String(node.textContent || "").trim());
      if (index >= 0) {
        return { selector, index };
      }
    }
    return { selector: "", index: -1 };
  });
}

async function openFirstSelectableRowPreview(page) {
  const row = page.locator("#list .row").first();
  if (await row.count()) {
    await row.click();
    await waitForPreviewReady(page);
  }
}

async function mountSyntheticStructuredDiff(page, options) {
  const fixtureOptions = options && typeof options === "object" ? options : {};
  const lineCount = Math.max(1, Number(fixtureOptions.lineCount || 1) || 1);
  const linePrefix = String(fixtureOptions.linePrefix || "synthetic line ");
  return page.evaluate(({ count, prefix }) => {
    const diff = document.getElementById("diff");
    if (!diff) {
      return { lineCount: 0, firstLine: "", lastLine: "" };
    }
    const fragment = document.createDocumentFragment();
    const fileBlock = document.createElement("div");
    fileBlock.className = "diff-file";
    for (let index = 0; index < count; index += 1) {
      const row = document.createElement("div");
      row.className = "diff-line add";
      const gutter = document.createElement("div");
      gutter.className = "diff-gutter";
      gutter.textContent = String(index + 1);
      const code = document.createElement("div");
      code.className = "diff-code";
      code.textContent = `${prefix}${String(index + 1).padStart(4, "0")}`;
      row.append(gutter, code);
      fileBlock.appendChild(row);
    }
    fragment.appendChild(fileBlock);
    diff.className = "diff-view";
    diff.replaceChildren(fragment);
    return {
      lineCount: count,
      firstLine: `${prefix}${String(1).padStart(4, "0")}`,
      lastLine: `${prefix}${String(count).padStart(4, "0")}`,
    };
  }, {
    count: lineCount,
    prefix: linePrefix,
  });
}

async function dragSelectBetweenElements(page, options) {
  const selectionOptions = options && typeof options === "object" ? options : {};
  const points = await page.evaluate((config) => {
    function textNodesForElement(element) {
      const nodes = [];
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, null);
      let node = walker.nextNode();
      while (node) {
        if (String(node.textContent || "").trim()) {
          nodes.push(node);
        }
        node = walker.nextNode();
      }
      return nodes;
    }

    function edgePoint(selector, index, edge) {
      const nodes = document.querySelectorAll(selector);
      const element = nodes[index];
      if (!element) {
        return null;
      }
      const textNodes = textNodesForElement(element);
      if (!textNodes.length) {
        const rect = element.getBoundingClientRect();
        return {
          x: rect.left + Math.max(4, Math.min(12, rect.width / 2)),
          y: rect.top + Math.max(4, Math.min(12, rect.height / 2)),
        };
      }
      const textNode = edge === "start" ? textNodes[0] : textNodes[textNodes.length - 1];
      const textValue = String(textNode.textContent || "");
      const range = document.createRange();
      if (edge === "start") {
        range.setStart(textNode, 0);
        range.setEnd(textNode, Math.min(1, textValue.length));
      } else {
        range.setStart(textNode, Math.max(0, textValue.length - 1));
        range.setEnd(textNode, textValue.length);
      }
      const rect = range.getBoundingClientRect();
      return {
        x: edge === "start" ? (rect.left + 1) : Math.max(rect.left + 1, rect.right - 2),
        y: rect.top + Math.max(2, Math.min(rect.height - 2, rect.height / 2)),
      };
    }

    return {
      start: edgePoint(String(config.startSelector || ""), Number(config.startIndex || 0) || 0, "start"),
      end: edgePoint(String(config.endSelector || config.startSelector || ""), Number(config.endIndex || 0) || 0, "end"),
    };
  }, selectionOptions);
  expect(points && points.start).toBeTruthy();
  expect(points && points.end).toBeTruthy();
  const startX = points.start.x;
  const startY = points.start.y;
  const endX = points.end.x;
  const endY = points.end.y;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(endX, endY, { steps: 18 });
  await page.mouse.up();
  return page.evaluate(() => String(window.getSelection ? window.getSelection().toString() : ""));
}

function runGitSnapshot(repoPath, snapshotHome, args) {
  return execFileSync(GIT_SNAPSHOT_BIN, args, {
    cwd: repoPath,
    encoding: "utf8",
    env: Object.assign({}, process.env, {
      HOME: snapshotHome,
      GIT_SNAPSHOT_CONFIRM_RESTORE: "RESTORE",
    }),
  });
}

function sleepSync(ms) {
  const waitMs = Math.max(0, Number(ms) || 0);
  if (waitMs <= 0) {
    return;
  }
  const buffer = new SharedArrayBuffer(4);
  const view = new Int32Array(buffer);
  Atomics.wait(view, 0, 0, waitMs);
}

function runGitSnapshotWithIndexLockRecovery(repoPath, snapshotHome, args) {
  const indexLockPath = path.join(repoPath, ".git", "index.lock");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const output = runGitSnapshot(repoPath, snapshotHome, args);
      const outputText = String(output || "");
      if (outputText.includes("[git-snapshot] ERROR: Restore failed")) {
        recordFixtureRecoveryEvent("restore-reported-error", {
          repoPath,
          args: Array.isArray(args) ? args.slice() : [],
        });
      }
      if (outputText.includes("Attempting automatic rollback")) {
        recordFixtureRecoveryEvent("restore-automatic-rollback", {
          repoPath,
          args: Array.isArray(args) ? args.slice() : [],
        });
      }
      return output;
    } catch (error) {
      const message = String(
        (error && (error.stderr || error.stdout)) || (error && error.message) || ""
      );
      const lockRelated = message.includes("index.lock") || message.includes("Could not write new index file");
      if (!lockRelated) {
        throw error;
      }
      recordFixtureRecoveryEvent("git-snapshot-index-lock-retry", {
        repoPath,
        args: Array.isArray(args) ? args.slice() : [],
        attempt: attempt + 1,
      });
      if (fs.existsSync(indexLockPath)) {
        fs.rmSync(indexLockPath, { force: true });
      }
      if (attempt === 4) {
        throw error;
      }
      sleepSync(100 * (attempt + 1));
    }
  }
  return "";
}

function runGitWithIndexLockRecovery(repoPath, gitArgs) {
  const indexLockPath = path.join(repoPath, ".git", "index.lock");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      return execFileSync("git", ["-C", repoPath, ...gitArgs], { encoding: "utf8" });
    } catch (error) {
      const message = String(
        (error && (error.stderr || error.stdout)) || (error && error.message) || ""
      );
      const lockRelated = message.includes("index.lock") || message.includes("Could not write new index file");
      if (!lockRelated) {
        throw error;
      }
      recordFixtureRecoveryEvent("git-index-lock-retry", {
        repoPath,
        args: Array.isArray(gitArgs) ? gitArgs.slice() : [],
        attempt: attempt + 1,
      });
      if (fs.existsSync(indexLockPath)) {
        fs.rmSync(indexLockPath, { force: true });
      }
      if (attempt === 4) {
        throw error;
      }
      sleepSync(100 * (attempt + 1));
    }
  }
  return "";
}

function uniqueSnapshotId(prefix) {
  return `${prefix}-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
}

function prepareBaselineFixtureSnapshot() {
  if (!BASELINE_FIXTURE_ROOT || !BASELINE_FIXTURE_HOME || !BASELINE_FIXTURE_SNAPSHOT_ID || baselineFixtureHead) {
    return;
  }
  baselineFixtureHead = execFileSync("git", ["-C", BASELINE_FIXTURE_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  runGitSnapshot(BASELINE_FIXTURE_ROOT, BASELINE_FIXTURE_HOME, ["create", BASELINE_FIXTURE_SNAPSHOT_ID]);
}

function restoreBaselineFixtureState() {
  const { repoPath, snapshotHome } = getGuiEnv();
  if (!baselineFixtureHead || !BASELINE_FIXTURE_HOME || !BASELINE_FIXTURE_SNAPSHOT_ID) {
    return;
  }

  clearViewedArtifacts(repoPath, snapshotHome);
  runGitWithIndexLockRecovery(repoPath, ["reset", "--hard"]);
  runGitWithIndexLockRecovery(repoPath, ["clean", "-fd"]);
  runGitWithIndexLockRecovery(repoPath, ["checkout", "--detach", baselineFixtureHead]);
  runGitWithIndexLockRecovery(repoPath, ["reset", "--hard", baselineFixtureHead]);
  runGitWithIndexLockRecovery(repoPath, ["clean", "-fd"]);
  runGitWithIndexLockRecovery(repoPath, ["-c", "protocol.file.allow=always", "submodule", "update", "--init", "--recursive"]);
  runGitSnapshotWithIndexLockRecovery(repoPath, BASELINE_FIXTURE_HOME, ["restore", BASELINE_FIXTURE_SNAPSHOT_ID]);
}

test.beforeAll(() => {
  prepareBaselineFixtureSnapshot();
});

test.afterEach(() => {
  restoreBaselineFixtureState();
});

test.afterAll(() => {
  persistFixtureRecoverySummary();
  if (fixtureRecoveryState.events.length > 0) {
    console.warn("[fixture-recovery-summary]", JSON.stringify(fixtureRecoverySummary()));
    if (process.env.GIT_SNAPSHOT_UI_TEST_STRICT_FIXTURE_RECOVERY === "1") {
      throw new Error(`Fixture recovery events were observed: ${fixtureRecoveryState.events.length}`);
    }
  }
  if (BASELINE_FIXTURE_HOME) {
    fs.rmSync(BASELINE_FIXTURE_HOME, { recursive: true, force: true });
  }
});

async function submitReviewBaseWithoutWaiting(page, baseRef) {
  const picker = await openFilterableSelect(page, "#reviewBasePicker");
  const search = picker.locator(".filterable-select-search");
  await search.fill(baseRef);
  await search.press("Enter");
  await expect(picker.locator(".filterable-select-popover")).toBeHidden();
}

function fileRowButton(page, rowLabel) {
  return page.getByRole("button", { name: rowLabel, exact: true });
}

function selectionRowButton(page, rowLabel) {
  return page.getByRole("button", { name: rowLabel, exact: true });
}

function selectionRowShell(page, rowLabel) {
  return page.locator(".selection-row-shell", {
    has: selectionRowButton(page, rowLabel),
  }).first();
}

function fileRowShell(page, rowLabel) {
  return page.locator(".file-row-shell", {
    has: fileRowButton(page, rowLabel),
  }).first();
}

async function firstFileRowDescriptor(page, preferredCategories = []) {
  return page.evaluate((categories) => {
    const preferred = Array.isArray(categories) ? categories.map((value) => String(value || "")) : [];
    const rows = Array.from(document.querySelectorAll("#list .file-row-shell .row")).map((button) => {
      let parsed = [];
      try {
        parsed = JSON.parse(button.dataset.rowKey || "[]");
      } catch (_err) {
        parsed = [];
      }
      return {
        label: String(button.getAttribute("aria-label") || "").trim(),
        mode: String(parsed[0] || ""),
        kind: String(parsed[1] || ""),
        repo: String(parsed[2] || ""),
        category: String(parsed[3] || ""),
        file: String(parsed[4] || ""),
      };
    }).filter((row) => row.kind === "file" && row.label);
    for (const category of preferred) {
      const match = rows.find((row) => row.category === category);
      if (match) {
        return match;
      }
    }
    return rows[0] || null;
  }, preferredCategories);
}

async function openFileRowContextMenu(page, rowLabel, method = "trigger") {
  const row = fileRowButton(page, rowLabel);
  await expect(row).toBeVisible();
  if (method === "keyboard") {
    await row.focus();
    await page.keyboard.press("Shift+F10");
  } else if (method === "contextmenu") {
    await row.click({ button: "right" });
  } else {
    await fileRowShell(page, rowLabel).locator(".row-menu-trigger").click();
  }
  await expect(page.locator("#rowContextMenu")).toBeVisible();
}

async function openSelectionRowContextMenu(page, rowLabel, method = "contextmenu") {
  const row = selectionRowButton(page, rowLabel);
  await expect(row).toBeVisible();
  if (method === "keyboard") {
    await row.focus();
    await page.keyboard.press("Shift+F10");
  } else if (method === "trigger") {
    await selectionRowShell(page, rowLabel).locator(".row-menu-trigger").click();
  } else {
    await row.click({ button: "right" });
  }
  await expect(page.locator("#rowContextMenu")).toBeVisible();
}

async function fetchAggregatePreview(page, params = {}) {
  return page.evaluate(async (overrides) => {
    const currentUrl = new URL(window.location.href);
    const requestUrl = new URL("/api/preview", window.location.origin);
    currentUrl.searchParams.forEach((value, key) => requestUrl.searchParams.set(key, value));
    for (const [key, value] of Object.entries(overrides || {})) {
      requestUrl.searchParams.set(key, String(value));
    }
    const response = await fetch(requestUrl.toString());
    const body = await response.json();
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body,
    };
  }, params);
}

async function fetchCurrentGuiData(page, params = {}) {
  const currentUrl = new URL(page.url());
  const requestUrl = new URL("/api/data", currentUrl.origin);
  currentUrl.searchParams.forEach((value, key) => requestUrl.searchParams.set(key, value));
  for (const [key, value] of Object.entries(params || {})) {
    requestUrl.searchParams.set(key, String(value));
  }
  const response = await page.request.get(requestUrl.toString());
  return {
    status: response.status(),
    body: await response.json(),
  };
}

async function fetchAllAggregatePreviewBlocks(page, params = {}) {
  const blocks = [];
  let offset = Math.max(0, Number(params.preview_offset || 0) || 0);

  for (let pageCount = 0; pageCount < 20; pageCount += 1) {
    const result = await fetchAggregatePreview(page, Object.assign({}, params, {
      preview_offset: String(offset),
    }));
    expect(result.status).toBe(200);
    blocks.push(...(Array.isArray(result.body.blocks) ? result.body.blocks : []));
    if (!result.body.has_more) {
      return blocks;
    }
    const nextOffset = Math.max(offset + 1, Number(result.body.next_offset || 0) || 0);
    offset = nextOffset;
  }

  throw new Error("Expected aggregate preview paging to finish within 20 pages.");
}

test("shared browser helpers bootstrap into the embedded page script", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  const helperState = await page.evaluate(() => {
    const shared = globalThis.__gitSnapshotCompareGuiShared || {};
    const normalizedSelection = typeof shared.normalizeSelectedKindShared === "function"
      ? shared.normalizeSelectedKindShared("browse", "file", ".", "unstaged", "row-001.txt")
      : "";
    const grouped = typeof shared.buildPreviewSelectionGroupsFromCollections === "function"
      ? shared.buildPreviewSelectionGroupsFromCollections(
        "browse",
        [{ repo: ".", category: "unstaged", file: "row-001.txt" }],
        [{ repo: ".", category: "unstaged", file_count: "1" }]
      )
      : null;
    const rowKey = typeof shared.buildRowIdentityKeyShared === "function"
      ? shared.buildRowIdentityKeyShared("browse", ".", "unstaged", "row-001.txt")
      : "";
    const selectionKey = typeof shared.buildSelectionIdentityKeyShared === "function"
      ? shared.buildSelectionIdentityKeyShared("browse", "file", ".", "unstaged", "row-001.txt")
      : "";
    const fallbackSequence = typeof shared.buildSelectionFallbackSequenceShared === "function"
      ? shared.buildSelectionFallbackSequenceShared("browse", "file", ".", "unstaged", "row-001.txt")
      : [];
    return {
      normalizedSelection,
      hasNamespace: Boolean(shared && typeof shared === "object"),
      fallbackKinds: Array.isArray(fallbackSequence) ? fallbackSequence.map((entry) => entry.selection_kind) : [],
      hasRowsByRepo: Boolean(grouped && grouped.rowsByRepo instanceof Map && Array.isArray(grouped.rowsByRepo.get("."))),
      hasCategorySummary: Boolean(
        grouped
        && grouped.categorySummaryByRepoCategory instanceof Map
        && grouped.categorySummaryByRepoCategory.has(".\u0000unstaged")
      ),
      rowKey,
      selectionKey,
    };
  });

  expect(helperState.hasNamespace).toBe(true);
  expect(helperState.normalizedSelection).toBe("file");
  expect(helperState.fallbackKinds).toEqual(["file", "category", "repo"]);
  expect(helperState.hasRowsByRepo).toBe(true);
  expect(helperState.hasCategorySummary).toBe(true);
  expect(helperState.rowKey).toBe(JSON.stringify(["browse", ".", "unstaged", "row-001.txt"]));
  expect(helperState.selectionKey).toBe(JSON.stringify(["browse", "file", ".", "unstaged", "row-001.txt"]));
});

test("diff selection context menu appears inside plain preview bodies and Copy preserves exact selected text", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await installClipboardProbe(page);
  await page.evaluate(() => {
    const diff = document.getElementById("diff");
    diff.className = "diff-view";
    diff.replaceChildren(Object.assign(document.createElement("pre"), {
      className: "preview-pre",
      textContent: "Plain preview sample text for Copy.",
    }));
  });
  await expect(page.locator("#diff .preview-pre")).toBeVisible();

  const selectedText = await selectTextWithinElement(page, "#diff .preview-pre", 0, 18);
  expect(selectedText).toBeTruthy();

  await openDiffSelectionContextMenu(page, "#diff .preview-pre");
  await expect(page.getByRole("menuitem", { name: "Copy", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect(page.locator("#diffSelectionContextMenu")).toBeHidden();
  await expect.poll(() => lastClipboardWrite(page)).toBe(selectedText);
});

test("diff selection context menu opens from the keyboard shortcut on selected text", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await installClipboardProbe(page);
  await page.evaluate(() => {
    const diff = document.getElementById("diff");
    diff.className = "diff-view";
    diff.replaceChildren(Object.assign(document.createElement("pre"), {
      className: "preview-pre",
      textContent: "Keyboard selection shortcut sample text.",
    }));
  });
  const selectedText = await selectTextWithinElement(page, "#diff .preview-pre", 0, 18);
  expect(selectedText).toBeTruthy();

  await page.keyboard.press("Shift+F10");
  await expect(page.locator("#diffSelectionContextMenu")).toBeVisible();
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect.poll(() => lastClipboardWrite(page)).toBe(selectedText);
});

test("diff selection Ask freezes the selected text, persists edited history, avoids duplicate default history, and removes saved instructions quickly", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await installClipboardProbe(page);

  const compareRow = await firstFileRowDescriptor(page);
  expect(compareRow).toBeTruthy();
  await openRow(page, compareRow.label);
  await waitForPreviewReady(page);
  await expect(page.locator("#diff .diff-code").first()).toBeVisible();

  let selectedText = "";
  try {
    selectedText = await selectTextWithinElement(page, "#diff .diff-line.add .diff-code", 0, 12);
  } catch (_err) {
    selectedText = await selectTextWithinElement(page, "#diff .diff-code", 0, 12);
  }
  expect(selectedText).toBeTruthy();

  await openDiffSelectionContextMenu(page, "#diff .diff-code");
  await page.getByRole("menuitem", { name: "Ask", exact: true }).click();
  await expect(page.locator("#askPromptDialog")).toBeVisible();
  await expect(page.locator("#askPromptInstruction")).toHaveValue("Explain this selected text.");
  await expect(page.locator("#askPromptSelection")).toHaveText(selectedText);

  await page.locator("#askPromptCopy").click();
  await expect.poll(() => lastClipboardWrite(page)).toBe(`Explain this selected text.\n\n\`\`\`\n${selectedText}\n\`\`\``);
  const defaultHistoryAfterCopy = await page.evaluate((storageKey) => {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "{\"roots\":{}}");
    const rootPath = String(window.__gitSnapshotRootRepoPhysicalPath || "");
    return Array.isArray(parsed.roots && parsed.roots[rootPath]) ? parsed.roots[rootPath] : [];
  }, ASK_HISTORY_STORAGE_KEY);
  expect(defaultHistoryAfterCopy).toEqual([]);

  await page.evaluate(() => {
    const diff = document.getElementById("diff");
    diff.replaceChildren(Object.assign(document.createElement("pre"), {
      className: "preview-pre",
      textContent: "mutated preview text",
    }));
  });
  await expect(page.locator("#askPromptSelection")).toHaveText(selectedText);

  const customInstruction = `Explain why this diff matters (${uniqueSnapshotId("ask-history")})`;
  await page.locator("#askPromptInstruction").fill(customInstruction);
  await page.locator("#askPromptCopy").click();
  await expect.poll(() => lastClipboardWrite(page)).toBe(`${customInstruction}\n\n\`\`\`\n${selectedText}\n\`\`\``);
  await expect(page.locator("#askPromptHistory")).toHaveValue(customInstruction);
  await page.locator("#askPromptCancel").click();

  await page.reload();
  await waitForGuiDataReady(page);
  await installClipboardProbe(page);
  const refreshedRow = await firstFileRowDescriptor(page);
  expect(refreshedRow).toBeTruthy();
  await openRow(page, refreshedRow.label);
  await waitForPreviewReady(page);
  try {
    await selectTextWithinElement(page, "#diff .diff-line.add .diff-code", 0, 12);
  } catch (_err) {
    await selectTextWithinElement(page, "#diff .diff-code", 0, 12);
  }
  await openDiffSelectionContextMenu(page, "#diff .diff-code");
  await page.getByRole("menuitem", { name: "Ask", exact: true }).click();
  await expect(page.locator("#askPromptHistory")).toContainText(customInstruction);
  await expect(page.locator("#askPromptHistoryPicker .filterable-select-trigger")).toContainText("Choose a recent instruction…");

  const previousClipboardWrites = await clipboardWriteCount(page);
  let historyPicker = await openFilterableSelect(page, "#askPromptHistoryPicker");
  await historyPicker.locator(".filterable-select-option", { hasText: customInstruction }).first().click();
  await expect.poll(() => clipboardWriteCount(page)).toBe(previousClipboardWrites + 1);
  await expect(page.locator("#askPromptInstruction")).toHaveValue(customInstruction);
  await expect(page.locator("#askPromptHistoryPicker .filterable-select-trigger")).toContainText(customInstruction);
  const historyAfterReuse = await page.evaluate((storageKey) => {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "{\"roots\":{}}");
    const rootPath = String(window.__gitSnapshotRootRepoPhysicalPath || "");
    return Array.isArray(parsed.roots && parsed.roots[rootPath]) ? parsed.roots[rootPath] : [];
  }, ASK_HISTORY_STORAGE_KEY);
  expect(historyAfterReuse).toEqual([customInstruction]);

  historyPicker = await openFilterableSelect(page, "#askPromptHistoryPicker");
  await historyPicker.getByRole("button", { name: `Remove recent instruction: ${customInstruction}` }).click();
  await expect(page.locator("#askPromptStatus")).toHaveText("Removed from recent instructions.");
  await expect(page.locator("#askPromptInstruction")).toHaveValue(customInstruction);
  await expect(page.locator("#askPromptHistory")).not.toContainText(customInstruction);
  await expect(page.locator("#askPromptHistory")).toHaveValue("");
  await expect(page.locator("#askPromptHistoryPicker .filterable-select-trigger")).toContainText("Choose a recent instruction…");
  const historyAfterRemoval = await page.evaluate((storageKey) => {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "{\"roots\":{}}");
    const rootPath = String(window.__gitSnapshotRootRepoPhysicalPath || "");
    return Array.isArray(parsed.roots && parsed.roots[rootPath]) ? parsed.roots[rootPath] : [];
  }, ASK_HISTORY_STORAGE_KEY);
  expect(historyAfterRemoval).toEqual([]);

  await page.locator("#askPromptCopy").click();
  await expect(page.locator("#askPromptStatus")).toHaveText("Prompt copied to the clipboard.");
  await expect(page.locator("#askPromptHistoryPicker .filterable-select-trigger")).toContainText(customInstruction);
  const historyAfterReuseWithoutEdit = await page.evaluate((storageKey) => {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) || "{\"roots\":{}}");
    const rootPath = String(window.__gitSnapshotRootRepoPhysicalPath || "");
    return Array.isArray(parsed.roots && parsed.roots[rootPath]) ? parsed.roots[rootPath] : [];
  }, ASK_HISTORY_STORAGE_KEY);
  expect(historyAfterReuseWithoutEdit).toEqual([customInstruction]);
});

test("Ask history selection stays synchronized when clipboard copy fails", async ({ page }) => {
  const { guiUrl } = getGuiEnv();
  const customInstruction = `Clipboard denied sync check ${uniqueSnapshotId("ask-history-denied")}`;

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await installClipboardProbe(page);

  const compareRow = await firstFileRowDescriptor(page);
  expect(compareRow).toBeTruthy();
  await openRow(page, compareRow.label);
  await waitForPreviewReady(page);
  await selectTextWithinElement(page, "#diff .diff-code", 0, 12);
  await openDiffSelectionContextMenu(page, "#diff .diff-code");
  await page.getByRole("menuitem", { name: "Ask", exact: true }).click();
  await page.locator("#askPromptInstruction").fill(customInstruction);
  await page.locator("#askPromptCopy").click();
  await expect(page.locator("#askPromptStatus")).toHaveText("Prompt copied to the clipboard.");
  await page.locator("#askPromptCancel").click();

  await installClipboardFailureProbe(page);
  await selectTextWithinElement(page, "#diff .diff-code", 0, 12);
  await openDiffSelectionContextMenu(page, "#diff .diff-code");
  await page.getByRole("menuitem", { name: "Ask", exact: true }).click();
  const historyPicker = await openFilterableSelect(page, "#askPromptHistoryPicker");
  await historyPicker.locator(".filterable-select-option", { hasText: customInstruction }).first().click();
  await expect(page.locator("#askPromptStatus")).toHaveText("Failed to copy the generated prompt.");
  await expect(page.locator("#askPromptInstruction")).toHaveValue(customInstruction);
  await expect(page.locator("#askPromptHistory")).toHaveValue(customInstruction);
  await expect(page.locator("#askPromptHistoryPicker .filterable-select-trigger")).toContainText(customInstruction);
  await expect.poll(() => lastDiffSelectionDebugEvent(page)).toEqual(expect.objectContaining({
    lastClipboardFailure: expect.objectContaining({
      context: "ask-history-selection",
    }),
  }));
});

test("diff selection Copy and Ask preserve newlines across multiple structured diff lines", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await installClipboardProbe(page);

  const compareRow = await firstFileRowDescriptor(page);
  expect(compareRow).toBeTruthy();
  await openRow(page, compareRow.label);
  await waitForPreviewReady(page);
  await expect(page.locator("#diff .diff-line.add .diff-code").first()).toBeVisible();

  const multilineSelection = await page.evaluate(() => {
    const codeRows = Array.from(document.querySelectorAll("#diff .diff-line.add .diff-code")).slice(0, 2);
    const texts = codeRows.map((node) => String(node.textContent || ""));
    return {
      lineCount: texts.length,
      expectedText: texts.join("\n"),
      endOffset: texts[1] ? texts[1].length : 0,
    };
  });
  expect(multilineSelection.lineCount).toBeGreaterThanOrEqual(2);
  expect(multilineSelection.expectedText.includes("\n")).toBe(true);

  await selectTextRange(page, {
    startSelector: "#diff .diff-line.add .diff-code",
    endSelector: "#diff .diff-line.add .diff-code",
    startIndex: 0,
    endIndex: 1,
    startOffset: 0,
    endOffset: multilineSelection.endOffset,
  });
  await openDiffSelectionContextMenu(page, "#diff .diff-line.add .diff-code");
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect.poll(() => lastClipboardWrite(page)).toBe(multilineSelection.expectedText);

  await selectTextRange(page, {
    startSelector: "#diff .diff-line.add .diff-code",
    endSelector: "#diff .diff-line.add .diff-code",
    startIndex: 0,
    endIndex: 1,
    startOffset: 0,
    endOffset: multilineSelection.endOffset,
  });
  await openDiffSelectionContextMenu(page, "#diff .diff-line.add .diff-code");
  await page.getByRole("menuitem", { name: "Ask", exact: true }).click();
  await expect(page.locator("#askPromptDialog")).toBeVisible();
  await expect.poll(() => page.locator("#askPromptSelection").evaluate((node) => node.textContent)).toBe(multilineSelection.expectedText);
  await page.locator("#askPromptCopy").click();
  await expect.poll(() => lastClipboardWrite(page)).toBe(
    `Explain this selected text.\n\n\`\`\`\n${multilineSelection.expectedText}\n\`\`\``
  );
});

test("diff selection real mouse drag across structured diff lines preserves newlines", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await installClipboardProbe(page);

  const compareRow = await firstFileRowDescriptor(page);
  expect(compareRow).toBeTruthy();
  await openRow(page, compareRow.label);
  await waitForPreviewReady(page);
  await expect(page.locator("#diff .diff-line.add .diff-code").first()).toBeVisible();

  const multilineSelection = await page.evaluate(() => {
    const codeRows = Array.from(document.querySelectorAll("#diff .diff-line.add .diff-code")).slice(0, 2);
    const texts = codeRows.map((node) => String(node.textContent || ""));
    return {
      lineCount: texts.length,
      expectedText: texts.join("\n"),
    };
  });
  expect(multilineSelection.lineCount).toBeGreaterThanOrEqual(2);

  await dragSelectBetweenElements(page, {
    startSelector: "#diff .diff-line.add .diff-code",
    endSelector: "#diff .diff-line.add .diff-code",
    startIndex: 0,
    endIndex: 1,
  });
  await openDiffSelectionContextMenu(page, "#diff .diff-line.add .diff-code");
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect.poll(() => lastClipboardWrite(page)).toBe(multilineSelection.expectedText);
  await expect.poll(() => lastDiffSelectionDebugEvent(page)).toEqual(expect.objectContaining({
    lastSelectionCapture: expect.objectContaining({
      lineCount: expect.any(Number),
      elapsedMs: expect.any(Number),
      slowCaptureThresholdMs: expect.any(Number),
      slow: expect.any(Boolean),
    }),
  }));
});

test("diff selection large structured captures stay under a practical latency budget", async ({ page }) => {
  const { guiUrl } = getGuiEnv();
  const syntheticDiff = {
    lineCount: 320,
    linePrefix: "large synthetic diff line ",
  };

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await mountSyntheticStructuredDiff(page, syntheticDiff);
  await expect(page.locator("#diff .diff-line.add .diff-code").first()).toBeVisible();

  const expectedFixture = await page.evaluate(() => {
    const codeRows = Array.from(document.querySelectorAll("#diff .diff-line.add .diff-code"));
    return {
      lineCount: codeRows.length,
      endOffset: codeRows.length ? String(codeRows[codeRows.length - 1].textContent || "").length : 0,
    };
  });
  expect(expectedFixture.lineCount).toBe(syntheticDiff.lineCount);

  await selectTextRange(page, {
    startSelector: "#diff .diff-line.add .diff-code",
    endSelector: "#diff .diff-line.add .diff-code",
    startIndex: 0,
    endIndex: expectedFixture.lineCount - 1,
    startOffset: 0,
    endOffset: expectedFixture.endOffset,
  });
  await openDiffSelectionContextMenu(page, "#diff .diff-line.add .diff-code");

  await expect.poll(() => lastDiffSelectionDebugEvent(page)).toEqual(expect.objectContaining({
    lastSelectionCapture: expect.objectContaining({
      lineCount: syntheticDiff.lineCount,
      elapsedMs: expect.any(Number),
      slowCaptureThresholdMs: expect.any(Number),
      slow: expect.any(Boolean),
    }),
  }));
  const capture = (await lastDiffSelectionDebugEvent(page)).lastSelectionCapture;
  expect(capture.elapsedMs).toBeLessThan(1500);
});

test("diff selection context menu appears inside aggregate preview body content", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await installClipboardProbe(page);
  await selectionRowButton(page, "Repo . compare rows").click();
  await waitForPreviewReady(page);
  await expect(page.locator("#diff .aggregate-preview-block").first()).toBeVisible();

  const aggregateSelector = await page.evaluate(() => {
    if (document.querySelector("#diff .aggregate-preview-block .diff-code")) {
      return "#diff .aggregate-preview-block .diff-code";
    }
    if (document.querySelector("#diff .aggregate-preview-pre")) {
      return "#diff .aggregate-preview-pre";
    }
    return "";
  });
  expect(aggregateSelector).toBeTruthy();

  const selectedText = await selectTextWithinElement(page, aggregateSelector, 0, 10);
  expect(selectedText).toBeTruthy();
  await openDiffSelectionContextMenu(page, aggregateSelector);
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect.poll(() => lastClipboardWrite(page)).toBe(selectedText);
});

test("diff selection context menu tolerates incidental gutter co-selection but stays disabled for headers and content outside #diff", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await installClipboardProbe(page);
  const compareRow = await firstFileRowDescriptor(page);
  expect(compareRow).toBeTruthy();
  await openRow(page, compareRow.label);
  await waitForPreviewReady(page);
  await expect(page.locator("#diff .diff-code").first()).toBeVisible();

  const expectedCodeOnlyText = await page.evaluate(() => {
    const codeCell = document.querySelector("#diff .diff-line.add .diff-code");
    return codeCell ? String(codeCell.textContent || "").slice(0, 4) : "";
  });
  expect(expectedCodeOnlyText).toBeTruthy();
  await selectTextRange(page, {
    startSelector: "#diff .diff-line.add .diff-gutter",
    endSelector: "#diff .diff-line.add .diff-code",
    startIndex: 1,
    startOffset: 0,
    endOffset: 4,
  });
  await openDiffSelectionContextMenu(page, "#diff .diff-line.add .diff-code");
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect.poll(() => lastClipboardWrite(page)).toBe(expectedCodeOnlyText);

  await selectTextRange(page, {
    startSelector: "#diff .diff-file-title",
    endSelector: "#diff .diff-code",
    startOffset: 0,
    endOffset: 4,
  });
  await triggerDiffSelectionContextMenu(page, "#diff .diff-code");
  await expect(page.locator("#diffSelectionContextMenu")).toBeHidden();

  await selectTextRange(page, {
    startSelector: "#list .row",
    endSelector: "#diff .diff-code",
    startOffset: 0,
    endOffset: 4,
  });
  await triggerDiffSelectionContextMenu(page, "#diff .diff-code");
  await expect(page.locator("#diffSelectionContextMenu")).toBeHidden();
});

test("Ask history stays scoped to the current physical root repo", async ({ page }) => {
  const { guiUrl, repoPath } = getGuiEnv();
  const foreignParent = fs.mkdtempSync(path.join(os.tmpdir(), "git-snapshot-ask-copy-"));
  const foreignRoot = path.join(foreignParent, path.basename(repoPath));
  fs.mkdirSync(foreignRoot, { recursive: true });
  const foreignPhysicalRoot = physicalPath(foreignRoot);
  const foreignInstruction = `Foreign ask history ${uniqueSnapshotId("foreign")}`;

  await page.addInitScript(({ storageKey, foreignRootPath, instruction }) => {
    window.localStorage.setItem(storageKey, JSON.stringify({
      roots: {
        [foreignRootPath]: [instruction],
      },
    }));
  }, {
    storageKey: ASK_HISTORY_STORAGE_KEY,
    foreignRootPath: foreignPhysicalRoot,
    instruction: foreignInstruction,
  });

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await installClipboardProbe(page);
  const compareRow = await firstFileRowDescriptor(page);
  expect(compareRow).toBeTruthy();
  await openRow(page, compareRow.label);
  await waitForPreviewReady(page);
  try {
    await selectTextWithinElement(page, "#diff .diff-line.add .diff-code", 0, 12);
  } catch (_err) {
    await selectTextWithinElement(page, "#diff .diff-code", 0, 12);
  }
  await openDiffSelectionContextMenu(page, "#diff .diff-code");
  await page.getByRole("menuitem", { name: "Ask", exact: true }).click();
  await expect(page.locator("#askPromptHistory")).not.toContainText(foreignInstruction);

  fs.rmSync(foreignParent, { recursive: true, force: true });
});

test("diff selection works against real inspect and review previews", async ({ page }) => {
  const { guiUrl, repoPath } = getGuiEnv();
  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await installClipboardProbe(page);

  await selectMode(page, "inspect");
  const inspectRow = await firstFileRowDescriptor(page, ["staged", "unstaged", "untracked"]);
  expect(inspectRow).toBeTruthy();
  await openRow(page, inspectRow.label);
  await waitForPreviewReady(page);
  const inspectTarget = await firstNonEmptyDiffTextTarget(page);
  expect(inspectTarget.selector).toBeTruthy();
  expect(inspectTarget.index).toBeGreaterThanOrEqual(0);
  const inspectSelectedText = await selectTextWithinElement(page, inspectTarget.selector, 0, 12, inspectTarget.index);
  expect(inspectSelectedText).toBeTruthy();
  await openDiffSelectionContextMenu(page, inspectTarget.selector, inspectTarget.index);
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect.poll(() => lastClipboardWrite(page)).toBe(inspectSelectedText);

  const trackedFiles = runGitWithIndexLockRecovery(repoPath, ["ls-files"])
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const reviewTargetFile = trackedFiles.find((file) => file.endsWith(".txt")) || trackedFiles[0];
  expect(reviewTargetFile).toBeTruthy();
  runGitWithIndexLockRecovery(repoPath, ["config", "user.email", "tests@example.com"]);
  runGitWithIndexLockRecovery(repoPath, ["config", "user.name", "git-snapshot-tests"]);
  runGitWithIndexLockRecovery(repoPath, ["checkout", "-B", uniqueSnapshotId("review-diff-selection-branch")]);
  const reviewBaseTag = uniqueSnapshotId("review-diff-selection-base");
  runGitWithIndexLockRecovery(repoPath, ["tag", "-f", reviewBaseTag]);
  fs.appendFileSync(path.join(repoPath, reviewTargetFile), "review diff selection delta\n", "utf8");
  runGitWithIndexLockRecovery(repoPath, ["add", "--", reviewTargetFile]);
  runGitWithIndexLockRecovery(repoPath, ["commit", "-m", "review diff selection delta"]);

  const reviewUrl = new URL(guiUrl);
  reviewUrl.searchParams.set("mode", "review");
  reviewUrl.searchParams.set("review_repos", JSON.stringify(["."]));
  reviewUrl.searchParams.set("review_base", reviewBaseTag);
  await page.goto(reviewUrl.toString());
  await waitForGuiDataReady(page);
  await installClipboardProbe(page);
  await waitForReviewReposParam(page, ["."]);
  await waitForReviewBaseParam(page, reviewBaseTag);
  const reviewRow = await firstFileRowDescriptor(page);
  expect(reviewRow).toBeTruthy();
  await openRow(page, reviewRow.label);
  await waitForPreviewReady(page);
  const reviewTarget = await firstNonEmptyDiffTextTarget(page);
  expect(reviewTarget.selector).toBeTruthy();
  expect(reviewTarget.index).toBeGreaterThanOrEqual(0);
  const reviewSelectedText = await selectTextWithinElement(page, reviewTarget.selector, 0, 12, reviewTarget.index);
  expect(reviewSelectedText).toBeTruthy();
  await openDiffSelectionContextMenu(page, reviewTarget.selector, reviewTarget.index);
  await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await expect.poll(() => lastClipboardWrite(page)).toBe(reviewSelectedText);
});

test("shared controls long-run smoke keeps the GUI server alive across repeated cross-mode interactions", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);

  for (let cycle = 0; cycle < 2; cycle += 1) {
    await waitForGuiDataReady(page);
    expectGuiServerAlive(`GUI server died before compare cycle ${cycle + 1} was ready.`);
    await openFirstSelectableRowPreview(page);
    expectGuiServerAlive(`GUI server died during compare cycle ${cycle + 1}.`);

    await selectMode(page, "browse");
    await waitForGuiDataReady(page);
    expectGuiServerAlive(`GUI server died before browse cycle ${cycle + 1} was ready.`);
    await openFirstSelectableRowPreview(page);
    expectGuiServerAlive(`GUI server died during browse cycle ${cycle + 1}.`);

    await selectMode(page, "inspect");
    await waitForGuiDataReady(page);
    expectGuiServerAlive(`GUI server died before inspect cycle ${cycle + 1} was ready.`);
    await openFirstSelectableRowPreview(page);
    expectGuiServerAlive(`GUI server died during inspect cycle ${cycle + 1}.`);

    await selectMode(page, "review");
    await waitForGuiDataReady(page);
    expectGuiServerAlive(`GUI server died before review cycle ${cycle + 1} was ready.`);
    await openFirstSelectableRowPreview(page);
    expectGuiServerAlive(`GUI server died during review cycle ${cycle + 1}.`);
  }
});

test("mode switch preserves snapshot and repo context across browse, compare, inspect, and review", async ({ page }) => {
  const { guiUrl, primarySnapshotId, olderSnapshotId } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await expect(page.locator("#modeSelect")).toHaveValue("compare");
  await expect(page.locator("#snapshotSelect")).toHaveValue(primarySnapshotId);
  await expect(page.locator("#snapshotPickerButton")).toBeVisible();
  await expect(page.locator("#snapshotPickerButton")).toContainText(primarySnapshotId);
  await expect(page.locator("#filtersButton")).toHaveText("Filters (2)");
  await expect(page.locator("#repoFilter")).toBeHidden();
  await expect(page.locator("#compareIncludeNoEffect")).toBeHidden();
  await expect(page.locator("#compareBaseWorkingTree")).toBeVisible();
  await expect(page.locator("#compareBaseSnapshot")).toBeVisible();
  await expect(page.locator("#compareBaseSnapshot")).toBeChecked();
  await expect(page.locator("#resetAll")).toBeHidden();
  await openFiltersPanel(page);
  await expect(page.locator("#repoFilterPicker")).toBeVisible();
  await expect(page.locator("#repoFilter")).toHaveValue(".");
  await expect(page.locator("#compareIncludeNoEffect")).toBeChecked();
  await closeFiltersPanel(page);

  await expect(page.locator("#modeSelect option")).toHaveText(["Browse", "Snapshot compare", "Inspect", "Review"]);
  await expect(page.locator("#modePicker .filterable-select-trigger")).toContainText("Snapshot compare");
  await page.locator("#modePicker .filterable-select-trigger").click();
  await expect(page.locator('#modePicker .filterable-select-option[data-value="compare"]')).toContainText(
    "Compare the current workspace against a saved snapshot’s restore effect."
  );
  await expect(page.locator('#modePicker .filterable-select-option[data-value="compare"] .mode-picker-help')).toHaveAttribute(
    "title",
    /Shows what would change if you restored this snapshot now\./
  );
  await page.keyboard.press("Escape");

  await selectMode(page, "browse");
  await expect(page.locator("#modeSelect")).toHaveValue("browse");
  await expect(page.locator("#snapshotPickerButton")).toBeHidden();
  await expect(page.locator("#createSnapshot")).toBeVisible();
  await expect(page.locator("#createSnapshot")).toHaveText("Create Snapshot");
  await expect(page.locator("#resetAll")).toBeVisible();
  await expect(page.locator("#openExternal")).toHaveText("Edit File");
  await expect(page.locator("#filtersButton")).toHaveText("Filters (1)");
  await expect(page.locator("#compareBaseWorkingTree")).toBeHidden();
  await openFiltersPanel(page);
  await expect(page.locator("#repoFilterPicker")).toBeVisible();
  await expect(page.locator("#repoFilter")).toHaveValue(".");
  await expect(page.locator("#browseStaged")).toBeChecked();
  await expect(page.locator("#browseUnstaged")).toBeChecked();
  await expect(page.locator("#browseUntracked")).toBeChecked();
  await expect(page.locator("#browseSubmodules")).toBeChecked();
  await closeFiltersPanel(page);

  await selectMode(page, "inspect");
  await expect(page.locator("#modeSelect")).toHaveValue("inspect");
  await expect(page.locator("#snapshotSelect")).toHaveValue(primarySnapshotId);
  await expect(page.locator("#snapshotPickerButton")).toBeVisible();
  await expect(page.locator("#resetAll")).toBeHidden();
  await expect(page.locator("#filtersButton")).toHaveText("Filters (1)");
  await expect(page.locator("#compareBaseWorkingTree")).toBeHidden();
  await openFiltersPanel(page);
  await expect(page.locator("#repoFilterPicker")).toBeVisible();
  await expect(page.locator("#repoFilter")).toHaveValue(".");
  await closeFiltersPanel(page);

  await selectSnapshot(page, olderSnapshotId);
  await expect(page.locator("#modeSelect")).toHaveValue("inspect");
  await expect(page.locator("#snapshotSelect")).toHaveValue(olderSnapshotId);
  await expect(page.getByRole("button", { name: "older-only.txt", exact: true })).toBeVisible();

  await selectMode(page, "review");
  await expect(page.locator("#modeSelect")).toHaveValue("review");
  await expect(page.locator("#snapshotPickerButton")).toBeHidden();
  await expect(page.locator("#filtersButton")).toBeHidden();
  await expect(page.locator("#refreshMenuButton")).toBeHidden();
  await expect(page.locator("#openExternal")).toBeHidden();
  await expect(page.locator("#reviewRepoPicker")).toBeVisible();
  await expect(page.locator("#reviewBasePicker")).toBeVisible();
  await expect(page.locator("#reviewPresetPicker")).toBeVisible();
  await expect(page.locator("#reviewSelectionSummary")).toHaveText("0 repos selected");
  await expect(page.locator("#reviewSelectedTray")).toBeHidden();

  await selectMode(page, "compare");
  await expect(page.locator("#modeSelect")).toHaveValue("compare");
  await expect(page.locator("#snapshotSelect")).toHaveValue(olderSnapshotId);
  await expect(page.locator("#resetAll")).toBeHidden();
  await expect(page.locator("#filtersButton")).toHaveText("Filters (2)");
  await expect(page.locator("#compareBaseWorkingTree")).toBeVisible();
  await expect(page.locator("#compareBaseSnapshot")).toBeChecked();
  await openFiltersPanel(page);
  await expect(page.locator("#repoFilterPicker")).toBeVisible();
  await expect(page.locator("#repoFilter")).toHaveValue(".");
  await closeFiltersPanel(page);
  await expect(page.getByRole("button", { name: "older-only.txt [unresolved_diverged]", exact: true })).toBeVisible();
});

test("review repo picker filters, auto-adds, preserves ordered URL state, and reorders the review list", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await selectMode(page, "review");

  const availableRepos = await page.evaluate(() => {
    const select = document.getElementById("reviewRepoSelect");
    return Array.from(select ? select.options : []).map((option) => option.value).filter(Boolean);
  });
  expect(availableRepos.length).toBeGreaterThan(1);

  const firstRepo = availableRepos[0];
  const secondRepo = availableRepos.find((repo) => repo !== firstRepo);
  expect(secondRepo).toBeTruthy();

  await addReviewRepo(page, firstRepo);
  await waitForReviewReposParam(page, [firstRepo]);

  const reviewPicker = await openFilterableSelect(page, "#reviewRepoPicker");
  await reviewPicker.locator(".filterable-select-search").fill(firstRepo.split("/").slice(-1)[0] || firstRepo);
  await expect(reviewPicker.locator(".filterable-select-option", { hasText: firstRepo })).toHaveCount(0);
  await expect(reviewPicker.locator(".filterable-select-empty")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(reviewPicker.locator(".filterable-select-popover")).toBeHidden();

  await addReviewRepo(page, secondRepo);
  await waitForReviewReposParam(page, [firstRepo, secondRepo]);

  await expect(page.locator("#reviewSelectionSummary")).toHaveText("2 repos selected");
  await expect(page.locator("#reviewSelectedTray")).toBeHidden();
  await openReviewSelectionTray(page);
  await expect(page.locator("#reviewSelectedRepos .review-repo-chip .review-repo-chip-label")).toHaveText([firstRepo, secondRepo]);
  await expect(page.locator("#list .repo .repo-title").first()).toContainText(firstRepo);
  await expect(page.locator("#list .repo .repo-title").nth(1)).toContainText(secondRepo);

  await dragReviewRepo(page, secondRepo, firstRepo);
  await waitForReviewReposParam(page, [secondRepo, firstRepo]);
  await expect(page.locator("#reviewSelectedRepos .review-repo-chip .review-repo-chip-label")).toHaveText([secondRepo, firstRepo]);
  await expect(page.locator("#list .repo .repo-title").first()).toContainText(secondRepo);
  await expect(page.locator("#list .repo .repo-title").nth(1)).toContainText(firstRepo);

  await page.reload();
  await waitForGuiDataReady(page);
  await expect(page.locator("#modeSelect")).toHaveValue("review");
  await expect(page.locator("#reviewSelectedTray")).toBeHidden();
  await expect(page.locator("#reviewSelectionSummary")).toHaveText("2 repos selected");
  await openReviewSelectionTray(page);
  await expect(page.locator("#reviewSelectedRepos .review-repo-chip .review-repo-chip-label")).toHaveText([secondRepo, firstRepo]);
  await expect(page.locator("#list .repo .repo-title").first()).toContainText(secondRepo);
  await page.getByRole("button", { name: `Move review repo right ${secondRepo}` }).click();
  await waitForReviewReposParam(page, [firstRepo, secondRepo]);
  await expect(page.locator("#reviewSelectedRepos .review-repo-chip .review-repo-chip-label")).toHaveText([firstRepo, secondRepo]);
  await closeReviewSelectionTray(page);
});

test("review presets save, load, rename, delete, and persist exact repo order with base settings", async ({ page }) => {
  const { guiUrl, repoPath } = getGuiEnv();
  const presetName = uniqueSnapshotId("review-preset");
  const renamedPresetName = `${presetName}-renamed`;

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await selectMode(page, "review");

  const availableRepos = await page.evaluate(() => {
    const select = document.getElementById("reviewRepoSelect");
    return Array.from(select ? select.options : []).map((option) => option.value).filter(Boolean);
  });
  expect(availableRepos.length).toBeGreaterThan(1);
  const firstRepo = availableRepos[0];
  const secondRepo = availableRepos.find((repo) => repo !== firstRepo);
  expect(secondRepo).toBeTruthy();
  const firstRepoPath = firstRepo === "." ? repoPath : path.join(repoPath, firstRepo);
  const secondRepoPath = secondRepo === "." ? repoPath : path.join(repoPath, secondRepo);

  execFileSync("git", ["-C", firstRepoPath, "tag", "-f", "ui-review-base-tag"], { encoding: "utf8" });
  execFileSync("git", ["-C", secondRepoPath, "branch", "-f", "ui-review-base-main"], { encoding: "utf8" });

  await addReviewRepo(page, firstRepo);
  await addReviewRepo(page, secondRepo);
  await dragReviewRepo(page, secondRepo, firstRepo);
  await waitForReviewReposParam(page, [secondRepo, firstRepo]);
  await selectReviewBase(page, "ui-review-base-main");
  await waitForReviewBaseParam(page, "ui-review-base-main");
  await selectReviewRepoBase(page, firstRepo, "ui-review-base-tag");
  await waitForReviewRepoBasesParam(page, JSON.stringify({ [firstRepo]: "ui-review-base-tag" }));

  await saveReviewPreset(page, presetName);
  await expect(page.locator("#reviewPresetActionsButton")).toBeEnabled();
  await expect(page.locator("#reviewPresetPicker .filterable-select-trigger")).toContainText(presetName);
  await expect(page.locator("#reviewPresetPicker .filterable-select-trigger")).toHaveClass(/review-preset-active/);

  await openReviewSelectionTray(page);
  await page.getByRole("button", { name: `Remove review repo ${firstRepo}` }).click();
  await waitForReviewReposParam(page, [secondRepo]);
  await expect(page.locator("#reviewBasePicker .filterable-select-trigger")).toContainText("ui-review-base-main");
  await expect(page.locator("#reviewPresetPicker .filterable-select-trigger")).toHaveClass(/review-preset-inactive/);
  await loadReviewPreset(page, presetName);
  await waitForReviewReposParam(page, [secondRepo, firstRepo]);
  await waitForReviewBaseParam(page, "ui-review-base-main");
  await waitForReviewRepoBasesParam(page, JSON.stringify({ [firstRepo]: "ui-review-base-tag" }));
  await expect(page.locator("#reviewSelectedTray")).toBeHidden();
  await expect(page.locator("#reviewSelectionSummary")).toHaveText("2 repos selected");
  await openReviewSelectionTray(page);
  await expect(page.locator("#reviewSelectedRepos .review-repo-chip .review-repo-chip-label")).toHaveText([secondRepo, firstRepo]);
  await expect(page.locator("#reviewBasePicker .filterable-select-trigger")).toContainText("ui-review-base-main");
  await expect(page.locator("#reviewPresetPicker .filterable-select-trigger")).toHaveClass(/review-preset-active/);
  await expect(page.locator("#list .repo .repo-title").first()).toContainText(secondRepo);
  await expect(page.locator("#list .repo .repo-title").nth(1)).toContainText(firstRepo);

  await renameReviewPreset(page, renamedPresetName);
  await expect(page.locator("#reviewPresetPicker .filterable-select-trigger")).toContainText(renamedPresetName);
  const presetOptionValuesAfterRename = await page.evaluate(() => {
    const select = document.getElementById("reviewPresetSelect");
    return Array.from(select ? select.options : []).map((option) => option.value).filter(Boolean);
  });
  expect(presetOptionValuesAfterRename).toContain(renamedPresetName);
  expect(presetOptionValuesAfterRename).not.toContain(presetName);

  await page.reload();
  await waitForGuiDataReady(page);
  await expect(page.locator("#modeSelect")).toHaveValue("review");
  await waitForReviewReposParam(page, [secondRepo, firstRepo]);
  await waitForReviewBaseParam(page, "ui-review-base-main");
  await waitForReviewRepoBasesParam(page, JSON.stringify({ [firstRepo]: "ui-review-base-tag" }));
  await expect(page.locator("#reviewPresetPicker .filterable-select-trigger")).toContainText(renamedPresetName);
  await expect(page.locator("#reviewPresetPicker .filterable-select-trigger")).toHaveClass(/review-preset-active/);
  await expect(page.locator("#reviewSelectedTray")).toBeHidden();
  await expect(page.locator("#reviewSelectionSummary")).toHaveText("2 repos selected");
  await openReviewSelectionTray(page);
  await expect(page.locator("#reviewSelectedRepos .review-repo-chip .review-repo-chip-label")).toHaveText([secondRepo, firstRepo]);
  await expect(page.locator("#reviewBasePicker .filterable-select-trigger")).toContainText("ui-review-base-main");

  await deleteReviewPreset(page);
  await openReviewPresetActionsMenu(page);
  await expect(page.locator("#reviewPresetRename")).toBeDisabled();
  await expect(page.locator("#reviewPresetDelete")).toBeDisabled();
  await expect(page.locator("#reviewPresetPicker .filterable-select-trigger")).toContainText("Load preset");
  await expect(page.locator("#reviewPresetPicker .filterable-select-trigger")).toHaveClass(/review-preset-inactive/);
  await page.keyboard.press("Escape");

  const deletedPresetPicker = await openFilterableSelect(page, "#reviewPresetPicker");
  await deletedPresetPicker.locator(".filterable-select-search").fill(renamedPresetName);
  await expect(deletedPresetPicker.locator(".filterable-select-option", { hasText: renamedPresetName })).toHaveCount(0);
  await expect(deletedPresetPicker.locator(".filterable-select-empty")).toBeVisible();
});

test("review refresh reloads current branch metadata for selected repos", async ({ page }) => {
  const { guiUrl, repoPath } = getGuiEnv();
  const branchName = uniqueSnapshotId("review-refresh");

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await selectMode(page, "review");

  const availableRepos = await page.evaluate(() => {
    const select = document.getElementById("reviewRepoSelect");
    return Array.from(select ? select.options : []).map((option) => option.value).filter(Boolean);
  });
  expect(availableRepos.length).toBeGreaterThan(0);
  const targetRepo = availableRepos.find((repo) => repo !== ".") || availableRepos[0];
  const targetRepoPath = targetRepo === "."
    ? repoPath
    : path.join(repoPath, targetRepo);

  await addReviewRepo(page, targetRepo);
  await expect(page.locator("#list .repo .repo-title").first()).toContainText(targetRepo);

  execFileSync("git", ["-C", targetRepoPath, "checkout", "-B", branchName], {
    encoding: "utf8",
  });

  await triggerRefresh(page);
  await expect(page.locator("#list .repo .repo-title").first()).toContainText(`(${branchName})`);
});

test("rapid review base changes cancel stale slow loads and settle on the latest selection", async ({ page }) => {
  const { guiUrl } = getGuiEnv();
  const firstMissingBase = uniqueSnapshotId("review-base-a");
  const secondMissingBase = uniqueSnapshotId("review-base-b");

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await selectMode(page, "review");

  const availableRepos = await page.evaluate(() => {
    const select = document.getElementById("reviewRepoSelect");
    return Array.from(select ? select.options : []).map((option) => option.value).filter(Boolean);
  });
  expect(availableRepos.length).toBeGreaterThan(0);
  const targetRepo = availableRepos.find((repo) => repo !== ".") || availableRepos[0];

  await addReviewRepo(page, targetRepo);

  let firstSlowRequestObserved = false;
  let resolveFirstSlowRequest = null;
  const firstSlowRequestStarted = new Promise((resolve) => {
    resolveFirstSlowRequest = resolve;
  });
  await page.route("**/api/data?**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!firstSlowRequestObserved
      && requestUrl.searchParams.get("mode") === "review"
      && requestUrl.searchParams.get("review_base") === firstMissingBase) {
      firstSlowRequestObserved = true;
      resolveFirstSlowRequest();
    }
    await route.continue();
  });

  const startedAt = Date.now();
  await submitReviewBaseWithoutWaiting(page, firstMissingBase);
  await firstSlowRequestStarted;
  await submitReviewBaseWithoutWaiting(page, secondMissingBase);
  await waitForReviewBaseParam(page, secondMissingBase);
  await waitForGuiDataReady(page);
  const elapsedMs = Date.now() - startedAt;

  await expect(page.locator("#reviewBasePicker .filterable-select-trigger")).toContainText(secondMissingBase);
  await expect(page.locator("#list .repo .repo-meta")).toContainText(secondMissingBase);
  await expect(page.locator("#list .repo .repo-meta")).not.toContainText(firstMissingBase);
  expect(elapsedMs).toBeLessThan(1700);
});

test("review base controls make fallback-to-master and missing overrides explicit", async ({ page }) => {
  const { guiUrl, repoPath } = getGuiEnv();
  const missingOverrideRef = uniqueSnapshotId("missing-review-base");

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await selectMode(page, "review");

  const availableRepos = await page.evaluate(() => {
    const select = document.getElementById("reviewRepoSelect");
    return Array.from(select ? select.options : []).map((option) => option.value).filter(Boolean);
  });
  expect(availableRepos.length).toBeGreaterThan(0);
  const targetRepo = availableRepos.find((repo) => repo !== ".") || availableRepos[0];
  const targetRepoPath = targetRepo === "."
    ? repoPath
    : path.join(repoPath, targetRepo);

  execFileSync("git", ["-C", targetRepoPath, "checkout", "--detach"], { encoding: "utf8" });
  execFileSync("git", ["-C", targetRepoPath, "branch", "-f", "master"], { encoding: "utf8" });
  try {
    execFileSync("git", ["-C", targetRepoPath, "branch", "-D", "main"], { encoding: "utf8" });
  } catch (_err) {
    // main may already be absent; that's fine for this regression.
  }

  await addReviewRepo(page, targetRepo);
  await selectReviewBase(page, "main");
  await waitForReviewBaseParam(page, "main");

  const repoHeader = page.locator(`#list .repo:has(.review-repo-base-control[data-repo="${targetRepo}"])`).first();
  await expect(repoHeader.locator(".repo-meta")).toContainText("base master");
  await expect(repoHeader.locator(".repo-meta")).toContainText("fell back from default main");
  await expect(repoHeader.locator(".repo-meta .list-pill.danger")).toContainText("fell back from default main");
  await expect(repoHeader.locator(".review-repo-base-control-label")).toHaveText("Base");
  await expect(repoHeader.locator(".review-repo-base-control .filterable-select-trigger")).toContainText("Use default (main; fell back to master here)");

  await selectReviewRepoBase(page, targetRepo, missingOverrideRef);
  await waitForReviewRepoBasesParam(page, JSON.stringify({ [targetRepo]: missingOverrideRef }));

  await expect(repoHeader.locator(".repo-meta")).toContainText(`fell back from override ${missingOverrideRef}`);
  await expect(repoHeader.locator(".repo-meta .list-pill.danger")).toContainText(`fell back from override ${missingOverrideRef}`);
  await expect(repoHeader.locator(".review-repo-base-control-label")).toHaveText("Base");
  await expect(repoHeader.locator(".review-repo-base-control .filterable-select-trigger")).toContainText(`${missingOverrideRef} (missing here; using master)`);
});

test("repo filter picker stays reusable across compare, browse, and inspect and applies filter selections", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await selectRepoFilter(page, "");
  await expect(page.locator("#repoFilter")).toHaveValue("");

  await selectRepoFilter(page, ".");
  await expect(page.locator("#repoFilter")).toHaveValue(".");

  await selectMode(page, "browse");
  await openFiltersPanel(page);
  await expect(page.locator("#repoFilterPicker")).toBeVisible();
  await closeFiltersPanel(page);

  await selectMode(page, "inspect");
  await openFiltersPanel(page);
  await expect(page.locator("#repoFilterPicker")).toBeVisible();
  await closeFiltersPanel(page);
});

test("legacy repeated review_repo URL params still hydrate ordered review selections", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await selectMode(page, "review");

  const availableRepos = await page.evaluate(() => {
    const select = document.getElementById("reviewRepoSelect");
    return Array.from(select ? select.options : []).map((option) => option.value).filter(Boolean);
  });
  expect(availableRepos.length).toBeGreaterThan(1);
  const firstRepo = availableRepos[0];
  const secondRepo = availableRepos.find((repo) => repo !== firstRepo);
  expect(secondRepo).toBeTruthy();

  const legacyUrl = `${guiUrl}?mode=review&review_repo=${encodeURIComponent(firstRepo)}&review_repo=${encodeURIComponent(secondRepo)}`;
  await page.goto(legacyUrl);
  await waitForGuiDataReady(page);
  await expect(page.locator("#modeSelect")).toHaveValue("review");
  await expect(page.locator("#reviewSelectedTray")).toBeHidden();
  await expect(page.locator("#reviewSelectionSummary")).toHaveText("2 repos selected");
  await openReviewSelectionTray(page);
  await expect(page.locator("#reviewSelectedRepos .review-repo-chip .review-repo-chip-label")).toHaveText([firstRepo, secondRepo]);
  await expect(page.locator("#list .repo .repo-title").first()).toContainText(firstRepo);
  await expect(page.locator("#list .repo .repo-title").nth(1)).toContainText(secondRepo);
});

test("status strip shows the physical root repo path and server connection state", async ({ page }) => {
  const { guiUrl, repoPath } = getGuiEnv();
  const expectedRootPath = physicalPath(repoPath);
  const pathParts = expectedRootPath.split(path.sep).filter(Boolean);
  const expectedCompactPath = (pathParts.slice(-2).join("/") || path.basename(expectedRootPath));

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  const rootChip = page.locator("#statusStrip #rootRepoChip");
  await expect(rootChip).toBeVisible();
  await expect(rootChip).toHaveAttribute(
    "title",
    new RegExp(expectedRootPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    { timeout: 20000 }
  );

  const chipText = ((await rootChip.textContent()) || "").trim();
  expect(chipText).toBe(expectedCompactPath);
  expect(chipText.length).toBeGreaterThan(0);

  const serverStatusChip = page.locator("#serverStatusChip");
  await expect(serverStatusChip).toBeVisible();
  await expect(serverStatusChip).toContainText("server connected");
  await expect.poll(() => page.title()).toContain(expectedCompactPath);
});

test("refresh split button adapts across compare, browse, inspect, and review", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await expect(page.locator("#refresh")).toBeEnabled();
  await expect(page.locator("#refreshMenuButton")).toBeEnabled();
  await openRefreshMenu(page);
  await expect(page.locator("#refreshMenu")).toContainText("Refresh reloads the current view.");
  await expect(page.locator("#refreshMenu")).toContainText("Reload Snapshots also refreshes snapshot inventory.");
  await expect(page.locator("#hardRefresh")).toHaveText("Reload Snapshots");
  await expect.poll(() => {
    return page.evaluate(() => {
      const menu = document.getElementById("refreshMenu");
      if (!menu) return false;
      const rect = menu.getBoundingClientRect();
      const probeX = Math.max(rect.left + 16, Math.min(rect.right - 16, rect.left + rect.width / 2));
      const probeY = Math.max(rect.top + 16, Math.min(rect.bottom - 16, rect.bottom - 20));
      const topElement = document.elementFromPoint(probeX, probeY);
      return Boolean(topElement && menu.contains(topElement));
    });
  }).toBe(true);
  await closeRefreshMenu(page);

  await selectMode(page, "browse");
  await expect(page.locator("#refresh")).toBeEnabled();
  await expect(page.locator("#refresh")).toHaveText("Refresh");
  await expect(page.locator("#refreshMenuButton")).toBeHidden();

  await selectMode(page, "inspect");
  await expect(page.locator("#refresh")).toBeEnabled();
  await expect(page.locator("#refresh")).toHaveText("Reload Snapshots");
  await expect(page.locator("#refresh")).toHaveAttribute("aria-label", "Reload snapshots and inspect data.");
  await expect(page.locator("#refreshMenuButton")).toBeHidden();

  await selectMode(page, "review");
  await expect(page.locator("#refresh")).toBeEnabled();
  await expect(page.locator("#refresh")).toHaveText("Refresh");
  await expect(page.locator("#refreshMenuButton")).toBeHidden();
});

test("snapshot picker sorts newest first and supports rename/delete across compare and inspect", async ({ page }) => {
  const { guiUrl, primarySnapshotId, olderSnapshotId } = getGuiEnv();
  const createdSnapshotId = "snapshot-picker-created";
  const renamedSnapshotId = "snapshot-picker-renamed";

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await openSnapshotPanel(page);
  await expect(page.locator("#snapshotList .snapshot-entry").first()).toHaveAttribute("data-snapshot-id", primarySnapshotId);
  await expect(page.locator("#snapshotList .snapshot-entry").nth(1)).toHaveAttribute("data-snapshot-id", olderSnapshotId);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${primarySnapshotId}"]`)).toHaveClass(/active/);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${primarySnapshotId}"] .snapshot-entry-meta`)).toContainText("Created ");
  await closeSnapshotPanel(page);

  await selectMode(page, "browse");
  await openCreateSnapshotDialog(page);
  await page.locator("#createSnapshotIdInput").fill(createdSnapshotId);
  await submitCreateSnapshotDialog(page);
  await expect(page.locator("#modeSelect")).toHaveValue("compare");
  await expect(page.locator("#snapshotSelect")).toHaveValue(createdSnapshotId);

  await openSnapshotPanel(page);
  await expect(page.locator("#snapshotList .snapshot-entry").first()).toHaveAttribute("data-snapshot-id", createdSnapshotId);
  await page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${createdSnapshotId}"] .snapshot-entry-action.rename`).click();
  await expect(page.locator("#snapshotOverlay")).toBeVisible();
  await expect(page.locator("#renameSnapshotDialog")).toBeVisible();
  await expect(page.locator("#renameSnapshotMeta")).toContainText("Created ");
  await page.locator("#renameSnapshotInput").fill(renamedSnapshotId);
  await page.locator("#renameSnapshotSubmit").click();
  await expect(page.locator("#renameSnapshotDialog")).toBeHidden({ timeout: 15000 });
  await waitForGuiDataReady(page);
  await expect(page.locator("#snapshotOverlay")).toBeVisible();
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${renamedSnapshotId}"]`)).toBeVisible();
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${createdSnapshotId}"]`)).toHaveCount(0);

  await expect(page.locator("#snapshotSelect")).toHaveValue(renamedSnapshotId);

  await selectMode(page, "inspect");
  await expect(page.locator("#snapshotSelect")).toHaveValue(renamedSnapshotId);

  await openSnapshotPanel(page);
  await page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${renamedSnapshotId}"] .snapshot-entry-action.delete`).click();
  await expect(page.locator("#snapshotOverlay")).toBeVisible();
  await expect(page.locator("#deleteSnapshotDialog")).toBeVisible();
  await expect(page.locator("#deleteSnapshotMessage")).toContainText(renamedSnapshotId);
  await page.locator("#deleteSnapshotConfirm").click();
  await expect(page.locator("#deleteSnapshotDialog")).toBeHidden({ timeout: 15000 });
  await waitForGuiDataReady(page);
  await expect(page.locator("#snapshotOverlay")).toBeVisible();
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${renamedSnapshotId}"]`)).toHaveCount(0);

  await expect(page.locator("#snapshotSelect")).toHaveValue(primarySnapshotId);
  await selectMode(page, "compare");
  await expect(page.locator("#snapshotSelect")).toHaveValue(primarySnapshotId);
});

test("refresh keeps snapshot inventory stale until Reload Snapshots refreshes it", async ({ page }) => {
  const { guiUrl, repoPath, snapshotHome } = getGuiEnv();
  const createdCompareSnapshotId = uniqueSnapshotId("compare-refresh-created");
  const renamedCompareSnapshotId = uniqueSnapshotId("compare-refresh-renamed");
  const createdBrowseSnapshotId = uniqueSnapshotId("browse-refresh-created");
  let forcedSnapshotRefreshRequests = 0;

  page.on("request", (request) => {
    if (request.method() !== "GET") {
      return;
    }
    const url = request.url();
    if (url.includes("/api/snapshots?") && url.includes("force=1")) {
      forcedSnapshotRefreshRequests += 1;
    }
  });

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  runGitSnapshot(repoPath, snapshotHome, ["create", createdCompareSnapshotId]);
  const compareSoftRequestCount = forcedSnapshotRefreshRequests;
  await triggerRefresh(page);
  expect(forcedSnapshotRefreshRequests).toBe(compareSoftRequestCount);
  await openSnapshotPanel(page);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${createdCompareSnapshotId}"]`)).toHaveCount(0);
  await closeSnapshotPanel(page);

  await triggerHardRefresh(page);
  expect(forcedSnapshotRefreshRequests).toBeGreaterThan(compareSoftRequestCount);
  await openSnapshotPanel(page);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${createdCompareSnapshotId}"]`)).toHaveCount(1);
  await closeSnapshotPanel(page);

  runGitSnapshot(repoPath, snapshotHome, ["rename", createdCompareSnapshotId, renamedCompareSnapshotId]);
  await triggerRefresh(page);
  await openSnapshotPanel(page);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${createdCompareSnapshotId}"]`)).toBeVisible();
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${renamedCompareSnapshotId}"]`)).toHaveCount(0);
  await closeSnapshotPanel(page);

  await triggerHardRefresh(page);
  await openSnapshotPanel(page);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${createdCompareSnapshotId}"]`)).toHaveCount(0);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${renamedCompareSnapshotId}"]`)).toHaveCount(1);
  await closeSnapshotPanel(page);

  runGitSnapshot(repoPath, snapshotHome, ["delete", renamedCompareSnapshotId]);
  await triggerRefresh(page);
  await openSnapshotPanel(page);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${renamedCompareSnapshotId}"]`)).toBeVisible();
  await closeSnapshotPanel(page);

  await triggerHardRefresh(page);
  await openSnapshotPanel(page);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${renamedCompareSnapshotId}"]`)).toHaveCount(0);
  await closeSnapshotPanel(page);

  await selectMode(page, "browse");
  await expect(page.locator("#refreshMenuButton")).toBeHidden();
  runGitSnapshot(repoPath, snapshotHome, ["create", createdBrowseSnapshotId]);
  const browseSoftRequestCount = forcedSnapshotRefreshRequests;
  await triggerRefresh(page);
  expect(forcedSnapshotRefreshRequests).toBe(browseSoftRequestCount);

  await selectMode(page, "compare");
  await openSnapshotPanel(page);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${createdBrowseSnapshotId}"]`)).toHaveCount(0);
  await closeSnapshotPanel(page);

  await selectMode(page, "compare");
  await triggerHardRefresh(page);
  expect(forcedSnapshotRefreshRequests).toBeGreaterThan(browseSoftRequestCount);

  await openSnapshotPanel(page);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${createdBrowseSnapshotId}"]`)).toHaveCount(1);
});

test("refresh reloads current-view data without using force=1", async ({ page }) => {
  const { guiUrl } = getGuiEnv();
  let forcedDataRequests = 0;
  let regularDataRequests = 0;

  page.on("request", (request) => {
    if (request.method() !== "GET") {
      return;
    }
    const url = request.url();
    if (url.includes("/api/data?")) {
      if (url.includes("force=1")) {
        forcedDataRequests += 1;
      } else {
        regularDataRequests += 1;
      }
    }
  });

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  forcedDataRequests = 0;
  regularDataRequests = 0;
  await triggerRefresh(page);
  expect(forcedDataRequests).toBe(0);
  expect(regularDataRequests).toBeGreaterThan(0);

  await selectMode(page, "browse");
  forcedDataRequests = 0;
  regularDataRequests = 0;
  await triggerRefresh(page);
  expect(forcedDataRequests).toBe(0);
  expect(regularDataRequests).toBeGreaterThan(0);
});

test("refresh helper rejects failed gui-data reloads instead of treating stale DOM as success", async ({ page }) => {
  const { guiUrl } = getGuiEnv();
  let aborted = false;

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  const beforeRefreshState = await readGuiViewLoadState(page);
  expect(beforeRefreshState.viewDataToken).toBeTruthy();

  await page.route("**/api/data?*", async (route, request) => {
    if (!aborted && request.method() === "GET") {
      aborted = true;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await expect(triggerRefresh(page)).rejects.toThrow(/GUI data refresh failed:/);
  await page.unroute("**/api/data?*");

  const afterRefreshState = await readGuiViewLoadState(page);
  expect([
    "",
    beforeRefreshState.viewDataToken,
  ]).toContain(afterRefreshState.viewDataToken);
});

test("inspect primary refresh reloads snapshot inventory", async ({ page }) => {
  const { guiUrl, repoPath, snapshotHome } = getGuiEnv();
  const createdInspectSnapshotId = uniqueSnapshotId("inspect-refresh-created");

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await selectMode(page, "inspect");

  await expect(page.locator("#refresh")).toBeEnabled();
  await expect(page.locator("#refresh")).toHaveText("Reload Snapshots");
  await expect(page.locator("#refreshMenuButton")).toBeHidden();

  runGitSnapshot(repoPath, snapshotHome, ["create", createdInspectSnapshotId]);
  await openSnapshotPanel(page);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${createdInspectSnapshotId}"]`)).toHaveCount(0);
  await closeSnapshotPanel(page);

  await triggerRefresh(page);
  await openSnapshotPanel(page);
  await expect(page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${createdInspectSnapshotId}"]`)).toHaveCount(1);
});

test("compare no-effect toggle auto-refreshes row visibility", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await expect(page.locator("#filtersButton")).toHaveText("Filters (2)");
  await openFiltersPanel(page);
  await expect(page.locator("#compareIncludeNoEffect")).toBeChecked();
  await expect(page.getByRole("button", { name: "row-001.txt [no restore effect]", exact: true })).toBeVisible();

  await setCheckbox(page, "#compareIncludeNoEffect", false);
  await expect(page.locator("#filtersButton")).toHaveText("Filters (1)");
  await expect(page.locator("#compareIncludeNoEffect")).not.toBeChecked();
  await expect(page.getByRole("button", { name: "row-001.txt [no restore effect]", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "000-scroll-target.txt [unresolved_diverged]", exact: true })).toBeVisible();

  await setCheckbox(page, "#compareIncludeNoEffect", true);
  await expect(page.locator("#filtersButton")).toHaveText("Filters (2)");
  await expect(page.locator("#compareIncludeNoEffect")).toBeChecked();
  await expect(page.getByRole("button", { name: "row-001.txt [no restore effect]", exact: true })).toBeVisible();
});

test("filters panel shows active state, closes outside, and can reset current-mode defaults", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await expect(page.locator("#filtersButton")).toHaveText("Filters (2)");

  await openFiltersPanel(page);
  await page.mouse.click(8, 8);
  await expect(page.locator("#filtersOverlay")).toBeHidden();

  await openFiltersPanel(page);
  await expect(page.locator("#repoFilter")).toHaveValue(".");
  await expect(page.locator("#compareIncludeNoEffect")).toBeChecked();
  await expect.poll(() => {
    return page.evaluate(() => {
      const panel = document.getElementById("filtersPanel");
      return panel ? panel.scrollWidth - panel.clientWidth : 999;
    });
  }).toBeLessThanOrEqual(1);
  await expect(page.locator("#compareBaseSnapshot")).toBeChecked();

  const refreshPromise = waitForNextGuiRefresh(page);
  await page.locator("#filtersReset").click();
  await refreshPromise;

  await expect(page.locator("#filtersButton")).toHaveText("Filters");
  await expect(page.locator("#repoFilter")).toHaveValue("");
  await expect(page.locator("#compareIncludeNoEffect")).not.toBeChecked();
  await expect(page.locator("#compareBaseSnapshot")).toBeChecked();
  await expect(page.locator("#compareBaseWorkingTree")).not.toBeChecked();
  await closeFiltersPanel(page);
});

test("browse state is encoded in the URL, survives reload, and can create a snapshot", async ({ page }) => {
  const { guiUrl, primarySnapshotId } = getGuiEnv();
  const createdSnapshotId = "browse-ui-created";

  await page.goto(guiUrl);
  await selectMode(page, "browse");

  await setCheckbox(page, "#browseUntracked", false);
  await setCheckbox(page, "#browseAllRepos", true);
  await expect(page.locator("#filtersButton")).toHaveText("Filters (3)");
  await closeFiltersPanel(page);
  await page.getByRole("button", { name: "inspect-staged.txt [staged]", exact: true }).click();
  await waitForPreviewReady(page);

  await expect.poll(async () => {
    return page.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        mode: url.searchParams.get("mode"),
        browseIncludeStaged: url.searchParams.get("browse_include_staged"),
        browseIncludeUnstaged: url.searchParams.get("browse_include_unstaged"),
        browseIncludeUntracked: url.searchParams.get("browse_include_untracked"),
        browseIncludeSubmodules: url.searchParams.get("browse_include_submodules"),
        browseShowAllRepos: url.searchParams.get("browse_show_all_repos"),
        selectedRepo: url.searchParams.get("selected_repo"),
        selectedCategory: url.searchParams.get("selected_category"),
        selectedFile: url.searchParams.get("selected_file"),
      };
    });
  }).toEqual({
    mode: "browse",
    browseIncludeStaged: "true",
    browseIncludeUnstaged: "true",
    browseIncludeUntracked: "false",
    browseIncludeSubmodules: "true",
    browseShowAllRepos: "true",
    selectedRepo: ".",
    selectedCategory: "staged",
    selectedFile: "inspect-staged.txt",
  });

  await expect.poll(() => page.title()).toContain("Browse");
  await expect.poll(() => page.title()).toContain("HEAD");
  await expect.poll(() => page.title()).toContain("staged, unstaged, submodules");

  await page.reload();
  await waitForGuiDataReady(page);
  await waitForPreviewReady(page);

  await expect(page.locator("#modeSelect")).toHaveValue("browse");
  await expect(page.locator("#filtersButton")).toHaveText("Filters (3)");
  await openFiltersPanel(page);
  await expect(page.locator("#browseStaged")).toBeChecked();
  await expect(page.locator("#browseUnstaged")).toBeChecked();
  await expect(page.locator("#browseUntracked")).not.toBeChecked();
  await expect(page.locator("#browseSubmodules")).toBeChecked();
  await expect(page.locator("#browseAllRepos")).toBeChecked();
  await expect(page.getByRole("button", { name: "inspect-staged.txt [staged]", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#diff")).toContainText("captured staged line");

  await openCreateSnapshotDialog(page);
  await expect(page.locator("#createSnapshotClear")).not.toBeChecked();
  const suggestedId = await page.locator("#createSnapshotIdInput").inputValue();
  expect(suggestedId).toMatch(/^\d{4}-\d{2}-\d{2}--\d{2}-\d{2}-\d{2}(?:-\d{2})?$/);
  expect(suggestedId).not.toBe(primarySnapshotId);
  await page.locator("#createSnapshotIdInput").fill(createdSnapshotId);
  await submitCreateSnapshotDialog(page);

  await expect(page.locator("#modeSelect")).toHaveValue("compare");
  await expect(page.locator("#snapshotSelect")).toHaveValue(createdSnapshotId);
  await expect(page.locator("#snapshotPickerButton")).toContainText(createdSnapshotId);
  await waitForGuiDataReady(page);
  await expect(page.locator("#compareBaseWorkingTree")).toBeVisible();
  await expect(page.locator("#compareIncludeNoEffect")).toBeChecked();
  await expect(page.locator("#list")).toContainText("inspect-staged.txt");
});

test("browse repo and category headers are selectable and drive aggregate preview", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await selectMode(page, "browse");

  const repoButton = page.locator("#list .repo-select").first();
  const repoTitle = ((await repoButton.locator(".repo-title").textContent()) || "").trim();
  expect(repoTitle).toBeTruthy();

  await repoButton.click();
  await waitForPreviewReady(page);

  await expect(page.locator("#diff .aggregate-preview-title")).toContainText(`Repo ${repoTitle}`);
  const repoBlockCount = await page.locator("#diff .aggregate-preview-block").count();
  expect(repoBlockCount).toBeGreaterThan(0);
  await expect(page.locator("#openExternal")).toBeDisabled();
  await expect.poll(async () => {
    return page.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        selectedKind: url.searchParams.get("selected_kind"),
        selectedRepo: url.searchParams.get("selected_repo"),
      };
    });
  }).toEqual({
    selectedKind: "repo",
    selectedRepo: repoTitle,
  });

  const categoryButton = page.locator("#list .category-select").first();
  const categoryLabel = ((await categoryButton.locator(".category-label").textContent()) || "").trim();
  expect(categoryLabel).toBeTruthy();
  await categoryButton.click();
  await waitForPreviewReady(page);

  await expect(page.locator("#diff .aggregate-preview-title")).toContainText(categoryLabel);
  await expect(page.locator("#diff .aggregate-preview-block").first()).toBeVisible();
  await expect(page.locator("#openExternal")).toBeDisabled();
  await expect.poll(async () => {
    return page.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        selectedKind: url.searchParams.get("selected_kind"),
        selectedRepo: url.searchParams.get("selected_repo"),
        selectedCategory: url.searchParams.get("selected_category"),
      };
    });
  }).toEqual({
    selectedKind: "category",
    selectedRepo: repoTitle,
    selectedCategory: categoryLabel,
  });
});

test("malformed browse file URLs without a category recover to a repo selection", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(`${guiUrl}?mode=browse&selected_kind=file&selected_repo=.&selected_file=inspect-staged.txt`);
  await waitForGuiDataReady(page);
  await waitForPreviewReady(page);

  await expect(page.locator("#diff .aggregate-preview-title")).toContainText("Repo .");
  await expect.poll(async () => {
    return page.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        selectedKind: url.searchParams.get("selected_kind"),
        selectedRepo: url.searchParams.get("selected_repo"),
        selectedCategory: url.searchParams.get("selected_category"),
        selectedFile: url.searchParams.get("selected_file"),
      };
    });
  }).toEqual({
    selectedKind: "repo",
    selectedRepo: ".",
    selectedCategory: null,
    selectedFile: null,
  });
});

test("browse repo aggregate preview keeps partially staged paths in both staged and unstaged sections", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await selectMode(page, "browse");

  const repoButton = page.locator("#list .repo-select").first();
  const repoTitle = ((await repoButton.locator(".repo-title").textContent()) || "").trim();
  expect(repoTitle).toBeTruthy();
  await repoButton.click();
  await waitForPreviewReady(page);

  const aggregateBlocks = await fetchAllAggregatePreviewBlocks(page, {
    selection_kind: "repo",
    repo: repoTitle,
    preview_limit: "9999",
  });
  expect(aggregateBlocks.filter((block) => String(block && block.file ? block.file : "").trim() === "browse-partial.txt")).toHaveLength(2);
});

test("browse live refresh updates category summary pills after refresh", async ({ page }) => {
  const { guiUrl, repoPath } = getGuiEnv();
  const rootTrackedPath = path.join(repoPath, "inspect-unstaged.txt");
  const seededLine = uniqueSnapshotId("browse-live-refresh-seed");

  runGitWithIndexLockRecovery(repoPath, ["restore", "--staged", "--worktree", "--", "inspect-unstaged.txt"]);
  fs.appendFileSync(rootTrackedPath, seededLine + "\n", "utf8");

  await page.goto(`${guiUrl}?mode=browse`);
  await waitForGuiDataReady(page);
  await expect(page.locator("#modeSelect")).toHaveValue("browse");
  await waitForRefreshState(page, "current");

  const rootUnstagedCategory = page.getByRole("button", { name: "unstaged rows in .", exact: true });
  const unstagedPlusLocator = rootUnstagedCategory.locator(".diff-stat-add strong").first();
  await expect(rootUnstagedCategory).toBeVisible();
  const initialUnstagedPlus = ((await unstagedPlusLocator.textContent()) || "").trim();

  fs.appendFileSync(rootTrackedPath, "shared-controls browse live refresh delta\n", "utf8");
  await waitForRefreshHintState(page, true);
  await page.locator("#refresh").click();
  await waitForGuiDataReady(page);
  await waitForRefreshState(page, "current");
  await expect.poll(async () => {
    return ((await unstagedPlusLocator.textContent()) || "").trim();
  }).not.toBe(initialUnstagedPlus);
  await expect.poll(async () => {
    const categoryPlusText = ((await unstagedPlusLocator.textContent()) || "").trim().replace(/^\+/, "");
    const categoryData = await fetchCurrentGuiData(page, { force: "1" });
    const payload = categoryData && categoryData.body ? categoryData.body : {};
    const unstagedRow = Array.isArray(payload.categoryRows)
      ? payload.categoryRows.find((row) => String(row.repo || "") === "." && String(row.category || "") === "unstaged")
      : null;
    return categoryPlusText === String(unstagedRow && unstagedRow.lines_added ? unstagedRow.lines_added : "");
  }, { timeout: 15000 }).toBe(true);
});

test("browse selection preserves a surviving file when it moves categories on refresh", async ({ page }) => {
  const { guiUrl, repoPath } = getGuiEnv();

  await page.goto(`${guiUrl}?mode=browse`);
  await waitForGuiDataReady(page);
  await expect(page.locator("#modeSelect")).toHaveValue("browse");

  await openRow(page, "inspect-staged.txt [staged]");
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("captured staged line");

  execFileSync("git", ["-C", repoPath, "restore", "--staged", "inspect-staged.txt"], { encoding: "utf8" });
  await page.reload();
  await waitForGuiDataReady(page);
  await waitForRefreshState(page, "current");

  await expect.poll(async () => {
    return page.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        selectedKind: url.searchParams.get("selected_kind"),
        selectedRepo: url.searchParams.get("selected_repo"),
        selectedCategory: url.searchParams.get("selected_category"),
        selectedFile: url.searchParams.get("selected_file"),
      };
    });
  }).toEqual({
    selectedKind: "file",
    selectedRepo: ".",
    selectedCategory: "unstaged",
    selectedFile: "inspect-staged.txt",
  });
  await expect(page.locator("#list .row.active")).toHaveAttribute(
    "data-row-key",
    JSON.stringify(["browse", "file", ".", "unstaged", "inspect-staged.txt"])
  );
  await expect(page.locator("#diff")).toContainText("captured staged line");
});

test("inspect repo and category headers are selectable and drive aggregate preview", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(`${guiUrl}?mode=inspect`);
  await waitForGuiDataReady(page);
  await expect(page.locator("#modeSelect")).toHaveValue("inspect");

  const repoButton = page.locator("#list .repo-select").first();
  const repoTitle = ((await repoButton.locator(".repo-title").textContent()) || "").trim();
  expect(repoTitle).toBeTruthy();

  await repoButton.click();
  await waitForPreviewReady(page);

  await expect(page.locator("#diff .aggregate-preview-title")).toContainText(`Repo ${repoTitle}`);
  await expect(page.locator("#diff .aggregate-preview-block").first()).toBeVisible();
  await expect(page.locator("#diff")).toContainText("captured");
  await expect.poll(async () => {
    return page.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        selectedKind: url.searchParams.get("selected_kind"),
        selectedRepo: url.searchParams.get("selected_repo"),
      };
    });
  }).toEqual({
    selectedKind: "repo",
    selectedRepo: repoTitle,
  });

  const categoryButton = page.locator("#list .category-select").first();
  const categoryLabel = ((await categoryButton.locator(".category-label").textContent()) || "").trim();
  expect(categoryLabel).toBeTruthy();

  await categoryButton.click();
  await waitForPreviewReady(page);

  await expect(page.locator("#diff .aggregate-preview-title")).toContainText(categoryLabel);
  await expect(page.locator("#diff .aggregate-preview-block").first()).toBeVisible();
  await expect.poll(async () => {
    return page.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        selectedKind: url.searchParams.get("selected_kind"),
        selectedRepo: url.searchParams.get("selected_repo"),
        selectedCategory: url.searchParams.get("selected_category"),
      };
    });
  }).toEqual({
    selectedKind: "category",
    selectedRepo: repoTitle,
    selectedCategory: categoryLabel,
  });
});

test("compare rows render simplified labels and line stats", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  const unresolvedRow = page.getByRole("button", { name: "000-scroll-target.txt [unresolved_diverged]", exact: true });
  await expect(unresolvedRow.locator(".compare-display-pill")).toHaveCount(0);
  await expect(unresolvedRow.locator(".diff-stat.diff-stat-add, .diff-stat.diff-stat-remove")).not.toHaveCount(0);

  await setCheckbox(page, "#compareIncludeNoEffect", true);

  const resolvedRow = page.getByRole("button", { name: "row-001.txt [no restore effect]", exact: true });
  const resolvedPill = resolvedRow.locator(".compare-display-pill");
  await expect(resolvedPill).toHaveText("no restore effect");
  await expect(resolvedPill).toHaveAttribute("title", /Restore would not change this path\./);
});

test("compare repo aggregate preview paginates, renders structured diff blocks, and disables file-only actions", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await setCheckbox(page, "#compareIncludeNoEffect", true);
  await closeFiltersPanel(page);

  const repoButton = page.locator("#list .repo-select").first();
  await repoButton.click();
  await waitForPreviewReady(page);

  await expect(page.locator("#diff .aggregate-preview-title")).toContainText("Repo");
  await expect(page.locator("#diff .aggregate-preview-show-all")).toHaveText("Show more");
  await expect(page.locator("#diff.aggregate-preview .diff-table").first()).toBeVisible();
  await expect(page.locator("#openExternal")).toBeDisabled();

  const initialBlockCount = await page.locator("#diff .aggregate-preview-block").count();
  expect(initialBlockCount).toBe(25);

  const repoTitle = ((await repoButton.locator(".repo-title").textContent()) || "").trim();
  const cappedAggregatePreview = await fetchAggregatePreview(page, {
    selection_kind: "repo",
    repo: repoTitle,
    preview_offset: "0",
    preview_limit: "9999",
  });
  expect(cappedAggregatePreview.status).toBe(200);
  expect(cappedAggregatePreview.body.page_size).toBe(25);
  expect(cappedAggregatePreview.body.page_rows).toBe(25);
  expect(cappedAggregatePreview.body.rendered_rows).toBe(25);
  expect(cappedAggregatePreview.headers["x-git-snapshot-aggregate-preview-rows"]).toBe("25");

  const secondPageAggregatePreview = await fetchAggregatePreview(page, {
    selection_kind: "repo",
    repo: repoTitle,
    preview_offset: "25",
    preview_limit: "9999",
  });
  expect(secondPageAggregatePreview.status).toBe(200);
  expect(secondPageAggregatePreview.body.page_size).toBe(25);
  expect(secondPageAggregatePreview.body.page_rows).toBe(25);
  expect(secondPageAggregatePreview.body.rendered_rows).toBe(50);
  expect(secondPageAggregatePreview.headers["x-git-snapshot-aggregate-preview-rows"]).toBe("25");

  let delayedAppendPreview = false;
  await page.route("**/api/preview?**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!delayedAppendPreview
      && requestUrl.searchParams.get("selection_kind") === "repo"
      && requestUrl.searchParams.get("repo") === repoTitle
      && requestUrl.searchParams.get("preview_offset") === "25") {
      delayedAppendPreview = true;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    await route.continue();
  });

  await page.locator("#diff .aggregate-preview-show-all").click();
  await expect(page.locator("#diff .aggregate-preview-title")).toContainText("Repo");
  await expect(page.locator("#diff .aggregate-preview-block")).toHaveCount(initialBlockCount);
  await expect(page.locator("#diff .aggregate-preview-show-all")).toHaveText("Loading more...");
  await waitForPreviewReady(page);

  await expect.poll(async () => page.locator("#diff .aggregate-preview-block").count()).toBeGreaterThan(initialBlockCount);
  await expect(page.locator("#diff .aggregate-preview-subtitle")).toContainText("showing");
  await expect(page.locator("#diff .aggregate-preview-show-all")).toHaveText("Show more");
  await expect(page.locator("#openExternal")).toBeDisabled();
  await expect.poll(async () => {
    return page.evaluate(() => new URL(window.location.href).searchParams.get("selected_kind"));
  }).toBe("repo");
});

test("aggregate append failures keep existing preview blocks and surface an inline error", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await setCheckbox(page, "#compareIncludeNoEffect", true);
  await closeFiltersPanel(page);

  const repoButton = page.locator("#list .repo-select").first();
  await repoButton.click();
  await waitForPreviewReady(page);

  const repoTitle = ((await repoButton.locator(".repo-title").textContent()) || "").trim();
  const initialBlockCount = await page.locator("#diff .aggregate-preview-block").count();
  expect(initialBlockCount).toBe(25);

  let appendRequestAborted = false;
  await page.route("**/api/preview?**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!appendRequestAborted
      && requestUrl.searchParams.get("selection_kind") === "repo"
      && requestUrl.searchParams.get("repo") === repoTitle
      && requestUrl.searchParams.get("preview_offset") === "25") {
      appendRequestAborted = true;
      await route.abort("failed");
      return;
    }
    await route.continue();
  });

  await page.locator("#diff .aggregate-preview-show-all").click();
  await expect.poll(() => appendRequestAborted).toBe(true);
  await expect(page.locator("#diff .aggregate-preview-title")).toContainText("Repo");
  await expect(page.locator("#diff .aggregate-preview-block")).toHaveCount(initialBlockCount);
  await expect(page.locator("#diff .aggregate-preview-error")).toContainText("Failed to load more preview rows.");
  await expect(page.locator("#diff .aggregate-preview-show-all")).toHaveText("Show more");
  await expect(page.locator("#diff .aggregate-preview-show-all")).toBeEnabled();
});

test("aggregate previews remain usable at narrow viewport widths", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await setCheckbox(page, "#compareIncludeNoEffect", true);
  await closeFiltersPanel(page);

  const repoButton = page.locator("#list .repo-select").first();
  await repoButton.click();
  await waitForPreviewReady(page);

  await expect(page.locator("#diff .aggregate-preview-title")).toContainText("Repo");
  await expect(page.locator("#diff .aggregate-preview-show-all")).toBeVisible();
  await page.locator("#diff .aggregate-preview-show-all").scrollIntoViewIfNeeded();
  await page.locator("#diff .aggregate-preview-show-all").click();
  await expect.poll(async () => page.locator("#diff .aggregate-preview-block").count()).toBeGreaterThan(25);
  await expect(page.locator("#diff .aggregate-preview-show-all")).toHaveText("Show more");
});

test("stale aggregate preview responses do not override a newer aggregate selection", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);
  await selectMode(page, "browse");
  const repoButton = page.locator("#list .repo-select").first();
  await expect(repoButton).toBeVisible({ timeout: 60000 });
  const repoTitle = ((await repoButton.locator(".repo-title").textContent()) || "").trim();
  expect(repoTitle).toBeTruthy();
  const categoryButton = page.locator("#list .category-select").first();
  await expect(categoryButton).toBeVisible({ timeout: 60000 });
  const categoryLabel = ((await categoryButton.locator(".category-label").textContent()) || "").trim();
  expect(categoryLabel).toBeTruthy();

  let delayedFirstRepoPreview = false;
  let releaseFirstRepoPreview = null;
  const firstRepoPreviewReleased = new Promise((resolve) => {
    releaseFirstRepoPreview = resolve;
  });
  let resolveFirstRepoPreviewStarted = null;
  const firstRepoPreviewStarted = new Promise((resolve) => {
    resolveFirstRepoPreviewStarted = resolve;
  });
  await page.route("**/api/preview?**", async (route) => {
    const requestUrl = new URL(route.request().url());
    if (!delayedFirstRepoPreview
      && requestUrl.searchParams.get("selection_kind") === "repo"
      && requestUrl.searchParams.get("repo") === repoTitle) {
      delayedFirstRepoPreview = true;
      resolveFirstRepoPreviewStarted();
      await firstRepoPreviewReleased;
    }
    await route.continue();
  });

  await repoButton.click();
  await firstRepoPreviewStarted;
  await categoryButton.click();
  await waitForPreviewReady(page);

  await expect(page.locator("#diff .aggregate-preview-title")).toContainText(categoryLabel);
  await expect.poll(async () => {
    return page.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        selectedKind: url.searchParams.get("selected_kind"),
        selectedCategory: url.searchParams.get("selected_category"),
      };
    });
  }).toEqual({
    selectedKind: "category",
    selectedCategory: categoryLabel,
  });

  releaseFirstRepoPreview();
  await expect(page.locator("#diff .aggregate-preview-title")).toContainText(categoryLabel);
  await expect.poll(async () => {
    return page.evaluate(() => new URL(window.location.href).searchParams.get("selected_category"));
  }).toBe(categoryLabel);
});

test("compare state is encoded in the URL and survives reload", async ({ page }) => {
  const { guiUrl, olderSnapshotId } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await setCheckbox(page, "#compareIncludeNoEffect", false);
  await selectCompareBase(page, "snapshot");
  await expect(page.locator("#filtersButton")).toHaveText("Filters (1)");
  await closeFiltersPanel(page);
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
        compareIncludeNoEffect: url.searchParams.get("compare_include_no_effect"),
        compareBase: url.searchParams.get("compare_base"),
        selectedRepo: url.searchParams.get("selected_repo"),
        selectedFile: url.searchParams.get("selected_file"),
      };
    });
  }).toEqual({
    mode: "compare",
    snapshotId: olderSnapshotId,
    repoFilter: ".",
    compareIncludeNoEffect: "false",
    compareBase: "snapshot",
    selectedRepo: ".",
    selectedFile: "older-only.txt",
  });

  await expect.poll(() => page.title()).toContain("Snapshot compare");
  await expect.poll(() => page.title()).toContain(olderSnapshotId);
  await expect.poll(() => page.title()).toContain("effect rows only");
  await expect.poll(() => page.title()).toContain("base snapshot");

  await page.reload();
  await waitForGuiDataReady(page);
  await waitForPreviewReady(page);

  await expect(page.locator("#modeSelect")).toHaveValue("compare");
  await expect(page.locator("#snapshotSelect")).toHaveValue(olderSnapshotId);
  await expect(page.locator("#filtersButton")).toHaveText("Filters (1)");
  await expect(page.locator("#compareBaseSnapshot")).toBeChecked();
  await openFiltersPanel(page);
  await expect(page.locator("#repoFilter")).toHaveValue(".");
  await expect(page.locator("#compareIncludeNoEffect")).not.toBeChecked();
  await expect(page.locator("#compareBaseSnapshot")).toBeChecked();
  await expect(page.getByRole("button", { name: "older-only.txt [unresolved_diverged]", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "older-only.txt [unresolved_diverged]", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#diff")).toContainText("older-only.txt");
  await expect(page.locator("#diff")).toContainText("compare base: snapshot");
  await expect(page.getByRole("button", { name: "row-001.txt [no restore effect]", exact: true })).toHaveCount(0);
  await expect(page).toHaveTitle(new RegExp(olderSnapshotId));
});

test("compare base falls back to localStorage when the URL and CLI do not set it", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(storageKey, "snapshot");
  }, COMPARE_BASE_STORAGE_KEY);

  const compareDataResponse = page.waitForResponse((response) => {
    return response.url().includes("/api/data?")
      && response.url().includes("mode=compare")
      && response.status() === 200;
  }, { timeout: 60000 });
  await page.goto(guiUrl);
  await compareDataResponse;
  await waitForGuiDataReady(page);

  await expect(page.locator("#filtersButton")).toHaveText("Filters (2)");
  await expect(page.locator("#compareBaseSnapshot")).toBeChecked();
  await expect.poll(async () => {
    return page.evaluate(() => new URL(window.location.href).searchParams.get("compare_base"));
  }).toBe("snapshot");
});

test("URL compare_base overrides localStorage fallback", async ({ page }) => {
  const { guiUrl } = getGuiEnv();
  const url = new URL(guiUrl);
  url.searchParams.set("compare_base", "working-tree");

  await page.addInitScript((storageKey) => {
    window.localStorage.setItem(storageKey, "snapshot");
  }, COMPARE_BASE_STORAGE_KEY);

  const compareDataResponse = page.waitForResponse((response) => {
    return response.url().includes("/api/data?")
      && response.url().includes("mode=compare")
      && response.status() === 200;
  }, { timeout: 60000 });
  await page.goto(url.toString());
  await compareDataResponse;
  await waitForGuiDataReady(page);

  await expect(page.locator("#filtersButton")).toHaveText("Filters (2)");
  await expect(page.locator("#compareBaseWorkingTree")).toBeChecked();
  await expect(page.locator("#compareBaseSnapshot")).not.toBeChecked();
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
  await expect(page.locator("#meta")).toContainText("Mode: Inspect");
  await expect(page.locator("#list")).toContainText("inspect-staged.txt");
  await expect(page.getByRole("button", { name: "row-001.txt [no restore effect]", exact: true })).toHaveCount(0);
});

test("browse create dialog can clear the working tree after capture", async ({ page }) => {
  const { guiUrl, repoPath } = getGuiEnv();
  const createdSnapshotId = "browse-ui-cleared";

  await page.goto(guiUrl);
  await selectMode(page, "browse");
  await expect(page.locator("#createSnapshot")).toBeVisible();

  await openCreateSnapshotDialog(page);
  await expect(page.locator("#createSnapshotClear")).not.toBeChecked();
  await page.locator("#createSnapshotIdInput").fill(createdSnapshotId);
  await page.locator("#createSnapshotClear").check();
  await submitCreateSnapshotDialog(page);

  await expect(page.getByRole("button", { name: "inspect-staged.txt [staged]", exact: true })).toHaveCount(0);
  expect(execFileSync("git", ["-C", repoPath, "status", "--short"], { encoding: "utf8" }).trim()).toBe("");

  await selectMode(page, "compare");
  await expect(page.locator("#modeSelect")).toHaveValue("compare");
  await expect(page.locator("#meta")).toContainText("Mode: Snapshot compare");
  await expect(page.locator("#snapshotSelect")).toHaveValue(createdSnapshotId);
  await expect(page.locator("#snapshotPickerButton")).toContainText(createdSnapshotId);
  await expect(page.locator("#list")).toContainText("inspect-staged.txt");
});

test("review repo aggregate preview uses the effective custom base in the diff metadata", async ({ page }) => {
  const { guiUrl, repoPath } = getGuiEnv();
  const reviewBranch = uniqueSnapshotId("review-aggregate-branch");
  const reviewBaseTag = uniqueSnapshotId("review-aggregate-base");
  const trackedFiles = execFileSync("git", ["-C", repoPath, "ls-files"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const targetFile = trackedFiles.find((file) => file.endsWith(".txt")) || trackedFiles[0];
  expect(targetFile).toBeTruthy();

  execFileSync("git", ["-C", repoPath, "config", "user.email", "tests@example.com"], { encoding: "utf8" });
  execFileSync("git", ["-C", repoPath, "config", "user.name", "git-snapshot-tests"], { encoding: "utf8" });
  execFileSync("git", ["-C", repoPath, "checkout", "-B", reviewBranch], { encoding: "utf8" });
  execFileSync("git", ["-C", repoPath, "tag", "-f", reviewBaseTag], { encoding: "utf8" });
  fs.appendFileSync(path.join(repoPath, targetFile), "review aggregate preview delta\n", "utf8");
  execFileSync("git", ["-C", repoPath, "add", "--", targetFile], { encoding: "utf8" });
  execFileSync("git", ["-C", repoPath, "commit", "-m", "review aggregate preview delta"], { encoding: "utf8" });

  const reviewUrl = new URL(guiUrl);
  reviewUrl.searchParams.set("mode", "review");
  reviewUrl.searchParams.set("review_repos", JSON.stringify(["."]));
  reviewUrl.searchParams.set("review_base", "master");
  reviewUrl.searchParams.set("review_repo_bases", JSON.stringify({ ".": reviewBaseTag }));
  await page.goto(reviewUrl.toString());
  await waitForGuiDataReady(page);
  await waitForReviewReposParam(page, ["."]);
  await waitForReviewRepoBasesParam(page, JSON.stringify({ ".": reviewBaseTag }));

  const repoButton = page.locator("#list .repo-select").first();
  await repoButton.click();
  await waitForPreviewReady(page);

  await expect(page.locator("#diff .aggregate-preview-title")).toContainText("Repo .");
  await expect(page.locator("#diff .aggregate-preview-block").first()).toBeVisible();
  await expect(page.locator("#diff")).toContainText("review base: " + reviewBaseTag);
  await expect(page.locator("#diff")).toContainText("merge-base:");
  await expect.poll(async () => {
    return page.evaluate(() => {
      const url = new URL(window.location.href);
      return {
        selectedKind: url.searchParams.get("selected_kind"),
        selectedRepo: url.searchParams.get("selected_repo"),
      };
    });
  }).toEqual({
    selectedKind: "repo",
    selectedRepo: ".",
  });
});

test("browse file rows can be marked viewed with right-click, persist across reload, and be unmarked", async ({ page }) => {
  const { guiUrl, repoPath, snapshotHome } = getGuiEnv();
  runGitSnapshot(repoPath, snapshotHome, ["create", uniqueSnapshotId("viewed-mark-bootstrap")]);
  const targetFile = uniqueSnapshotId("viewed-mark-persist") + ".txt";
  await resetViewedStateForTest(page, guiUrl, repoPath, snapshotHome, "browse");
  fs.writeFileSync(path.join(repoPath, targetFile), "mark viewed persistence\n", "utf8");
  let postMutationDataRequests = 0;
  let previewRequests = 0;
  const onResponse = (response) => {
    if (response.url().includes("/api/data?") && response.status() === 200) {
      postMutationDataRequests += 1;
    }
    if (response.url().includes("/api/preview?")) {
      previewRequests += 1;
    }
  };
  page.on("response", onResponse);

  await page.goto(`${guiUrl}?mode=browse`);
  await waitForGuiDataReady(page);
  await expect(page.locator("#modeSelect")).toHaveValue("browse");

  const rowLabel = `${targetFile} [untracked]`;
  await expect(fileRowButton(page, rowLabel)).toBeVisible();
  await openFileRowContextMenu(page, rowLabel, "contextmenu");
  await expect(page.getByRole("menuitem", { name: "Mark as viewed", exact: true })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#rowContextMenu")).toBeHidden();
  previewRequests = 0;
  await openFileRowContextMenu(page, rowLabel, "trigger");
  await expect.poll(() => previewRequests).toBe(0);
  postMutationDataRequests = 0;
  await page.getByRole("menuitem", { name: "Mark as viewed", exact: true }).click();
  await expect(page.locator("#viewedActionsButton")).toContainText("Viewed (1)", { timeout: 15000 });
  await expect(fileRowShell(page, rowLabel)).toContainText("Viewed", { timeout: 15000 });
  await expect.poll(() => postMutationDataRequests).toBe(0);

  await page.reload();
  await waitForGuiDataReady(page);
  await expect(page.locator("#modeSelect")).toHaveValue("browse");
  await expect(fileRowButton(page, rowLabel)).toBeVisible();
  await expect(fileRowShell(page, rowLabel)).toContainText("Viewed");

  await openFileRowContextMenu(page, rowLabel, "trigger");
  postMutationDataRequests = 0;
  await page.getByRole("menuitem", { name: "Unmark as viewed", exact: true }).click();
  await expect(page.locator("#viewedActionsButton")).toBeDisabled();
  await expect(fileRowShell(page, rowLabel)).not.toContainText("Viewed");
  await expect.poll(() => postMutationDataRequests).toBe(0);
  page.off("response", onResponse);
});

test("viewed counts stay aligned across mode switches and reload without a full data reload", async ({ page }) => {
  const { guiUrl, repoPath, snapshotHome, primarySnapshotId } = getGuiEnv();
  const targetFile = uniqueSnapshotId("viewed-mode-switch") + ".txt";
  await resetViewedStateForTest(page, guiUrl, repoPath, snapshotHome, "browse");
  fs.writeFileSync(path.join(repoPath, targetFile), "alpha\n", "utf8");

  await page.goto(`${guiUrl}?mode=browse`);
  await waitForGuiDataReady(page);

  const rowLabel = `${targetFile} [untracked]`;
  await openFileRowContextMenu(page, rowLabel, "trigger");
  await page.getByRole("menuitem", { name: "Mark as viewed", exact: true }).click();
  await expect(page.locator("#viewedActionsButton")).toContainText("Viewed (1)", { timeout: 15000 });
  await expect(fileRowShell(page, rowLabel)).toContainText("Viewed", { timeout: 15000 });

  await page.goto(`${guiUrl}?mode=compare&snapshot_id=${encodeURIComponent(primarySnapshotId)}&repo_filter=.`);
  await waitForGuiDataReady(page);
  await expect(page.locator("#viewedActionsButton")).toContainText("Viewed (1)");
  await page.locator("#viewedActionsButton").click();
  await expect(page.locator("#viewedActionsMenu")).toBeVisible();
  await expect(page.locator("#clearViewedMode")).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.goto(`${guiUrl}?mode=browse`);
  await waitForGuiDataReady(page);
  await expect(page.locator("#viewedActionsButton")).toContainText("Viewed (1)");
  await expect(fileRowShell(page, rowLabel)).toContainText("Viewed");

  await page.reload();
  await waitForGuiDataReady(page);
  await expect(page.locator("#viewedActionsButton")).toContainText("Viewed (1)");
  await expect(fileRowShell(page, rowLabel)).toContainText("Viewed");
});

test("viewed state ignores entries stored for another physical copy sharing the same snapshot root", async ({ page }) => {
  const { guiUrl, repoPath, snapshotHome } = getGuiEnv();
  const targetFile = uniqueSnapshotId("viewed-foreign-root") + ".txt";
  await resetViewedStateForTest(page, guiUrl, repoPath, snapshotHome, "browse");
  fs.writeFileSync(path.join(repoPath, targetFile), "alpha\n", "utf8");

  const foreignParent = fs.mkdtempSync(path.join(os.tmpdir(), "git-snapshot-viewed-copy-"));
  const foreignRoot = path.join(foreignParent, path.basename(repoPath));
  fs.mkdirSync(foreignRoot, { recursive: true });
  const foreignPhysicalRoot = physicalPath(foreignRoot);
  writeViewedStateFile(repoPath, snapshotHome, {
    roots: {
      [foreignPhysicalRoot]: {
        entries: {
          [viewedStateEntryKey("browse", ".", "untracked", targetFile)]: {
            mode: "browse",
            repo: ".",
            category: "untracked",
            file: targetFile,
            view_token: "foreign-token",
            marked_at: new Date().toISOString(),
            context_label: `.:untracked:${targetFile}`,
            preview_kind: "text",
            preview_blob_id: "",
          },
        },
      },
    },
  });

  await page.goto(`${guiUrl}?mode=browse`);
  await waitForGuiDataReady(page);
  const rowLabel = `${targetFile} [untracked]`;
  await expect(fileRowButton(page, rowLabel)).toBeVisible();
  await expect(page.locator("#viewedActionsButton")).toBeDisabled();
  await expect(fileRowShell(page, rowLabel)).not.toContainText("Viewed");

  await openFileRowContextMenu(page, rowLabel, "trigger");
  await page.getByRole("menuitem", { name: "Mark as viewed", exact: true }).click();
  await expect(page.locator("#viewedActionsButton")).toContainText("Viewed (1)", { timeout: 15000 });
  await expect(fileRowShell(page, rowLabel)).toContainText("Viewed", { timeout: 15000 });

  fs.rmSync(foreignParent, { recursive: true, force: true });
});

test("browse changed-since-viewed rows expose current versus since-viewed preview and current-mode clear", async ({ page }) => {
  const { guiUrl, repoPath, snapshotHome } = getGuiEnv();
  runGitSnapshot(repoPath, snapshotHome, ["create", uniqueSnapshotId("viewed-diff-bootstrap")]);
  const targetFile = uniqueSnapshotId("viewed-diff-target") + ".txt";
  const appendedLine = "since viewed delta " + uniqueSnapshotId("line");
  await resetViewedStateForTest(page, guiUrl, repoPath, snapshotHome, "browse");
  fs.writeFileSync(path.join(repoPath, targetFile), "alpha\n", "utf8");

  await page.goto(`${guiUrl}?mode=browse`);
  await waitForGuiDataReady(page);
  await expect(page.locator("#modeSelect")).toHaveValue("browse");

  const rowLabel = `${targetFile} [untracked]`;
  const markResponse = await page.request.post(
    `${guiUrl}api/viewed/mark?mode=browse&repo_filter=&browse_include_staged=true&browse_include_unstaged=true&browse_include_untracked=true&browse_include_submodules=true&browse_show_all_repos=false&selected_kind=file&selected_repo=.&selected_category=untracked&selected_file=${encodeURIComponent(targetFile)}`,
    {
      data: {
        repo: ".",
        category: "untracked",
        file: targetFile,
      },
    }
  );
  expect(markResponse.ok()).toBeTruthy();
  await page.reload();
  await waitForGuiDataReady(page);
  await expect(page.locator("#viewedActionsButton")).toContainText("Viewed (1)", { timeout: 15000 });
  await expect(fileRowShell(page, rowLabel)).toContainText("Viewed", { timeout: 15000 });

  fs.appendFileSync(path.join(repoPath, targetFile), appendedLine + "\n", "utf8");
  await waitForRefreshHintState(page, true);
  await triggerRefresh(page);
  await openRow(page, rowLabel);
  await waitForPreviewReady(page);

  await expect(fileRowShell(page, rowLabel)).toContainText("Changed since viewed", { timeout: 15000 });
  await expect(page.locator("#previewControls")).toBeVisible();
  await expect(page.locator("#previewSinceViewedButton")).toBeEnabled();

  await page.locator("#previewSinceViewedButton").click();
  await waitForPreviewReady(page);
  await expect(page.locator("#diff")).toContainText("viewed:" + targetFile);
  await expect(page.locator("#diff")).toContainText("current:" + targetFile);
  await expect(page.locator("#diff")).toContainText(appendedLine);
  await expect(page.locator("#openExternal")).toBeDisabled();

  await page.locator("#previewCurrentButton").click();
  await waitForPreviewReady(page);
  await expect(page.locator("#openExternal")).toBeEnabled();
});

test("changed viewed rows fall back to the current preview when the stored viewed blob is corrupt", async ({ page }) => {
  const { guiUrl, repoPath, snapshotHome } = getGuiEnv();
  const targetFile = uniqueSnapshotId("viewed-corrupt-blob") + ".txt";
  const appendedLine = "corrupt viewed blob " + uniqueSnapshotId("line");
  await resetViewedStateForTest(page, guiUrl, repoPath, snapshotHome, "browse");
  fs.writeFileSync(path.join(repoPath, targetFile), "alpha\n", "utf8");

  await page.goto(`${guiUrl}?mode=browse`);
  await waitForGuiDataReady(page);

  const rowLabel = `${targetFile} [untracked]`;
  const markResponse = await page.request.post(
    `${guiUrl}api/viewed/mark?mode=browse&repo_filter=&browse_include_staged=true&browse_include_unstaged=true&browse_include_untracked=true&browse_include_submodules=true&browse_show_all_repos=false&selected_kind=file&selected_repo=.&selected_category=untracked&selected_file=${encodeURIComponent(targetFile)}`,
    {
      data: {
        repo: ".",
        category: "untracked",
        file: targetFile,
      },
    }
  );
  expect(markResponse.ok()).toBeTruthy();

  const artifacts = viewedStateArtifacts(repoPath, snapshotHome);
  const viewedDoc = readViewedStateFile(repoPath, snapshotHome);
  const currentRoot = physicalPath(repoPath);
  const viewedEntry = viewedDoc.roots[currentRoot].entries[viewedStateEntryKey("browse", ".", "untracked", targetFile)];
  expect(viewedEntry).toBeTruthy();
  fs.writeFileSync(path.join(artifacts.previewBlobsDir, `${viewedEntry.preview_blob_id}.json`), "{not valid json", "utf8");

  fs.appendFileSync(path.join(repoPath, targetFile), appendedLine + "\n", "utf8");
  await triggerRefresh(page);
  await openRow(page, rowLabel);
  await waitForPreviewReady(page);

  await expect(fileRowShell(page, rowLabel)).toContainText("Changed since viewed", { timeout: 15000 });
  await expect(page.locator("#previewControls")).toBeHidden();
  await expect(page.locator("#openExternal")).toBeEnabled();
});

test("browse category and repo rows can bulk mark and unmark viewed state without a full data reload", async ({ page }) => {
  const { guiUrl, repoPath, snapshotHome } = getGuiEnv();
  const firstFile = uniqueSnapshotId("bulk-viewed-a") + ".txt";
  const secondFile = uniqueSnapshotId("bulk-viewed-b") + ".txt";
  const stagedOnlyFile = uniqueSnapshotId("bulk-viewed-staged") + ".txt";
  await resetViewedStateForTest(page, guiUrl, repoPath, snapshotHome, "browse");
  fs.writeFileSync(path.join(repoPath, firstFile), "alpha\n", "utf8");
  fs.writeFileSync(path.join(repoPath, secondFile), "beta\n", "utf8");
  fs.writeFileSync(path.join(repoPath, stagedOnlyFile), "staged only\n", "utf8");
  execFileSync("git", ["-C", repoPath, "add", stagedOnlyFile], { encoding: "utf8" });
  let postMutationDataRequests = 0;
  let previewRequests = 0;
  const onResponse = (response) => {
    if (response.url().includes("/api/data?") && response.status() === 200) {
      postMutationDataRequests += 1;
    }
    if (response.url().includes("/api/preview?")) {
      previewRequests += 1;
    }
  };
  page.on("response", onResponse);

  await page.goto(`${guiUrl}?mode=browse&browse_include_staged=false&browse_include_unstaged=false&browse_include_untracked=true&browse_include_submodules=false&browse_show_all_repos=false`);
  await waitForGuiDataReady(page);

  previewRequests = 0;
  await openSelectionRowContextMenu(page, "untracked rows in .", "trigger");
  await expect.poll(() => previewRequests).toBe(0);
  const markAllItem = page.getByRole("menuitem", { name: /Mark all as viewed \(\d+\)/ });
  await expect(markAllItem).toBeVisible();
  const markAllLabel = String(await markAllItem.textContent() || "");
  const markAllCount = Number((markAllLabel.match(/\((\d+)\)/) || [])[1] || 0);
  expect(markAllCount).toBeGreaterThanOrEqual(2);
  postMutationDataRequests = 0;
  await markAllItem.click();
  await expect(page.locator("#viewedActionsButton")).toContainText(`Viewed (${markAllCount})`, { timeout: 15000 });
  await expect(fileRowShell(page, `${firstFile} [untracked]`)).toContainText("Viewed", { timeout: 15000 });
  await expect(fileRowShell(page, `${secondFile} [untracked]`)).toContainText("Viewed", { timeout: 15000 });
  await expect.poll(() => postMutationDataRequests).toBe(0);

  await page.goto(`${guiUrl}?mode=browse&browse_include_staged=true&browse_include_unstaged=false&browse_include_untracked=true&browse_include_submodules=false&browse_show_all_repos=false`);
  await waitForGuiDataReady(page);
  await expect(fileRowButton(page, `${stagedOnlyFile} [staged]`)).toBeVisible();
  await expect(fileRowShell(page, `${stagedOnlyFile} [staged]`)).not.toContainText("Viewed");

  await openSelectionRowContextMenu(page, "Repo . live rows", "trigger");
  const unmarkAllItem = page.getByRole("menuitem", { name: /Unmark all as viewed \(\d+\)/ });
  await expect(unmarkAllItem).toBeVisible();
  const unmarkAllLabel = String(await unmarkAllItem.textContent() || "");
  const unmarkAllCount = Number((unmarkAllLabel.match(/\((\d+)\)/) || [])[1] || 0);
  expect(unmarkAllCount).toBe(markAllCount);
  postMutationDataRequests = 0;
  await unmarkAllItem.click();
  await expect(page.locator("#viewedActionsButton")).toBeDisabled();
  await expect(fileRowShell(page, `${firstFile} [untracked]`)).not.toContainText("Viewed");
  await expect(fileRowShell(page, `${secondFile} [untracked]`)).not.toContainText("Viewed");
  await expect.poll(() => postMutationDataRequests).toBe(0);
  page.off("response", onResponse);
});

test("browse bulk mark uses current live file signatures and stays viewed after explicit refresh", async ({ page }) => {
  const { guiUrl, repoPath, snapshotHome } = getGuiEnv();
  const firstFile = uniqueSnapshotId("bulk-live-signature-a") + ".txt";
  const secondFile = uniqueSnapshotId("bulk-live-signature-b") + ".txt";
  await resetViewedStateForTest(page, guiUrl, repoPath, snapshotHome, "browse");
  fs.writeFileSync(path.join(repoPath, firstFile), "alpha\n", "utf8");
  fs.writeFileSync(path.join(repoPath, secondFile), "beta\n", "utf8");
  let explicitRefreshRequests = 0;
  let forcedRefreshRequests = 0;
  const onRequest = (request) => {
    if (request.method() !== "GET") {
      return;
    }
    const url = request.url();
    if (!url.includes("/api/data?")) {
      return;
    }
    if (url.includes("explicit_refresh=1")) {
      explicitRefreshRequests += 1;
    }
    if (url.includes("force=1")) {
      forcedRefreshRequests += 1;
    }
  };
  page.on("request", onRequest);

  await page.goto(`${guiUrl}?mode=browse&browse_include_staged=false&browse_include_unstaged=false&browse_include_untracked=true&browse_include_submodules=false&browse_show_all_repos=false`);
  await waitForGuiDataReady(page);

  fs.appendFileSync(path.join(repoPath, firstFile), "gamma\n", "utf8");

  await openSelectionRowContextMenu(page, "untracked rows in .", "trigger");
  await page.getByRole("menuitem", { name: /Mark all as viewed \(\d+\)/ }).click();
  await expect(fileRowShell(page, `${firstFile} [untracked]`)).toContainText("Viewed", { timeout: 15000 });

  explicitRefreshRequests = 0;
  forcedRefreshRequests = 0;
  await triggerRefresh(page);
  expect(explicitRefreshRequests).toBeGreaterThan(0);
  expect(forcedRefreshRequests).toBe(0);
  await expect(fileRowShell(page, `${firstFile} [untracked]`)).toContainText("Viewed", { timeout: 15000 });
  await expect(fileRowShell(page, `${firstFile} [untracked]`)).not.toContainText("Changed since viewed");
  page.off("request", onRequest);
});

test("compare repo rows expose bulk viewed actions from the visible trigger context menu", async ({ page }) => {
  const { guiUrl } = getGuiEnv();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await openSelectionRowContextMenu(page, "Repo . compare rows", "trigger");
  await expect(page.getByRole("menuitem", { name: /Mark all as viewed \(\d+\)|Unmark all as viewed \(\d+\)/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#rowContextMenu")).toBeHidden();
});

test("file-row context menu opens from keyboard across compare, inspect, and review", async ({ page }) => {
  const { guiUrl, repoPath, snapshotHome } = getGuiEnv();
  runGitSnapshot(repoPath, snapshotHome, ["create", uniqueSnapshotId("viewed-keyboard-bootstrap")]);
  clearViewedArtifacts(repoPath, snapshotHome);

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  const compareRow = await firstFileRowDescriptor(page);
  expect(compareRow).toBeTruthy();
  await openFileRowContextMenu(page, compareRow.label, "keyboard");
  await expect(page.locator("#rowContextMenu .row-context-menu-section-title")).toContainText("View state");
  await page.keyboard.press("Escape");
  await expect(page.locator("#rowContextMenu")).toBeHidden();

  await selectMode(page, "inspect");
  const inspectRow = await firstFileRowDescriptor(page, ["staged", "unstaged", "untracked"]);
  expect(inspectRow).toBeTruthy();
  await openFileRowContextMenu(page, inspectRow.label, "keyboard");
  await expect(page.locator("#rowContextMenu")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#rowContextMenu")).toBeHidden();

  const trackedFiles = execFileSync("git", ["-C", repoPath, "ls-files"], { encoding: "utf8" })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const reviewTargetFile = trackedFiles.find((file) => file.endsWith(".txt")) || trackedFiles[0];
  expect(reviewTargetFile).toBeTruthy();
  execFileSync("git", ["-C", repoPath, "config", "user.email", "tests@example.com"], { encoding: "utf8" });
  execFileSync("git", ["-C", repoPath, "config", "user.name", "git-snapshot-tests"], { encoding: "utf8" });
  execFileSync("git", ["-C", repoPath, "checkout", "-B", uniqueSnapshotId("review-menu-branch")], { encoding: "utf8" });
  const reviewBaseTag = uniqueSnapshotId("review-menu-base");
  execFileSync("git", ["-C", repoPath, "tag", "-f", reviewBaseTag], { encoding: "utf8" });
  fs.appendFileSync(path.join(repoPath, reviewTargetFile), "review context menu delta\n", "utf8");
  execFileSync("git", ["-C", repoPath, "add", "--", reviewTargetFile], { encoding: "utf8" });
  execFileSync("git", ["-C", repoPath, "commit", "-m", "review context menu delta"], { encoding: "utf8" });

  const reviewUrl = new URL(guiUrl);
  reviewUrl.searchParams.set("mode", "review");
  reviewUrl.searchParams.set("review_repos", JSON.stringify(["."]));
  reviewUrl.searchParams.set("review_base", reviewBaseTag);
  await page.goto(reviewUrl.toString());
  await waitForGuiDataReady(page);
  await waitForReviewReposParam(page, ["."]);
  await waitForReviewBaseParam(page, reviewBaseTag);
  await expect(page.locator("#list .file-row-shell .row").first()).toBeVisible({ timeout: 15000 });
  const reviewRow = await firstFileRowDescriptor(page);
  expect(reviewRow).toBeTruthy();
  await openFileRowContextMenu(page, reviewRow.label, "keyboard");
  await expect(page.locator("#rowContextMenu")).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Mark as viewed|Unmark as viewed|Mark current version as viewed/ })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#rowContextMenu")).toBeHidden();
});
