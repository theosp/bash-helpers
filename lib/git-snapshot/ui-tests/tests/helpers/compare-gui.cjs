const { expect } = require("@playwright/test");
const GUI_READY_TIMEOUT_MS = 60000;

async function waitForGuiListHydrated(page, timeout = GUI_READY_TIMEOUT_MS) {
  await page.waitForFunction(() => {
    const list = document.getElementById("list");
    if (!list) return false;
    if (list.querySelector(".loading")) return false;
    return Boolean(list.querySelector(".row, .empty, .repo-empty"));
  }, undefined, { timeout });
}

function normalizeGuiReadyOptions(options) {
  const readyOptions = options && typeof options === "object"
    ? options
    : {};
  return {
    timeout: Number.isFinite(readyOptions.timeout) && readyOptions.timeout > 0
      ? readyOptions.timeout
      : GUI_READY_TIMEOUT_MS,
    mode: readyOptions.mode ? String(readyOptions.mode) : "",
    readySelector: readyOptions.readySelector ? String(readyOptions.readySelector) : "",
    readyCheck: typeof readyOptions.readyCheck === "function" ? readyOptions.readyCheck : null,
  };
}

async function waitForGuiDataReadyOnce(page, readyOptions) {
  await waitForGuiListHydrated(page, readyOptions.timeout);
  await expect.poll(async () => {
    const state = await readGuiViewLoadState(page);
    const mode = String((state && state.mode) || "");
    const viewDataToken = String((state && state.viewDataToken) || "");
    if (!mode || !viewDataToken) {
      return false;
    }
    if (readyOptions.mode && mode !== readyOptions.mode) {
      return false;
    }
    return true;
  }, { timeout: readyOptions.timeout }).toBe(true);
  if (readyOptions.readySelector) {
    await expect.poll(async () => {
      return page.locator(readyOptions.readySelector).count();
    }, { timeout: readyOptions.timeout }).toBeGreaterThan(0);
  }
  if (readyOptions.readyCheck) {
    await expect.poll(async () => {
      return Boolean(await readyOptions.readyCheck(page, await readGuiViewLoadState(page)));
    }, { timeout: readyOptions.timeout }).toBe(true);
  }
}

async function readGuiBootstrapState(page) {
  return page.evaluate(() => {
    const body = document.body;
    const list = document.getElementById("list");
    const serverChip = document.querySelector(".server-status-chip");
    return {
      pageText: body ? (body.textContent || "") : "",
      listText: list ? (list.textContent || "") : "",
      serverText: serverChip ? (serverChip.textContent || "") : "",
    };
  });
}

function guiBootstrapLooksRecoverable(state) {
  const pageText = String(state && state.pageText ? state.pageText : "");
  const listText = String(state && state.listText ? state.listText : "");
  const serverText = String(state && state.serverText ? state.serverText : "");
  return /Failed to fetch|data unavailable/i.test(pageText)
    || /Failed to load compare rows|Failed to load browse rows|Failed to load inspect rows|Failed to load review rows/i.test(listText)
    || /server connecting|cannot currently reach/i.test(serverText);
}

async function waitForGuiDataReady(page, options) {
  const readyOptions = normalizeGuiReadyOptions(options);
  let lastError = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await waitForGuiDataReadyOnce(page, readyOptions);
      return;
    } catch (error) {
      lastError = error;
      if (attempt > 0) {
        break;
      }
      const bootstrapState = await readGuiBootstrapState(page).catch(() => null);
      if (!guiBootstrapLooksRecoverable(bootstrapState)) {
        break;
      }
      await page.reload({ waitUntil: "domcontentloaded" });
    }
  }
  throw lastError;
}

function isGuiDataRequest(resource) {
  const method = typeof resource.method === "function"
    ? resource.method()
    : resource.request().method();
  return method === "GET" && resource.url().includes("/api/data?");
}

function isGuiSnapshotsRequest(resource) {
  const method = typeof resource.method === "function"
    ? resource.method()
    : resource.request().method();
  return method === "GET" && resource.url().includes("/api/snapshots?");
}

function requestFailureMessage(request) {
  const failure = request && typeof request.failure === "function" ? request.failure() : null;
  return String((failure && failure.errorText) || "unknown request failure");
}

async function waitForTrackedRequest(page, matcher, label, timeout = GUI_READY_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      page.off("response", handleResponse);
      page.off("requestfailed", handleRequestFailed);
      clearTimeout(timer);
    };
    const settle = (fn, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      fn(value);
    };
    const handleResponse = (response) => {
      if (!matcher(response)) {
        return;
      }
      if (response.status() >= 400) {
        settle(reject, new Error(`${label} returned HTTP ${response.status()}.`));
        return;
      }
      settle(resolve, response);
    };
    const handleRequestFailed = (request) => {
      if (!matcher(request)) {
        return;
      }
      settle(reject, new Error(`${label} failed: ${requestFailureMessage(request)}`));
    };
    const timer = setTimeout(() => {
      settle(reject, new Error(`${label} timed out after ${timeout}ms.`));
    }, timeout);
    page.on("response", handleResponse);
    page.on("requestfailed", handleRequestFailed);
  });
}

async function readGuiViewLoadState(page) {
  return page.evaluate(() => {
    if (typeof window.__gitSnapshotTestReadViewLoadState === "function") {
      return window.__gitSnapshotTestReadViewLoadState();
    }
    const refresh = document.getElementById("refresh");
    const refreshState = !refresh
      ? null
      : {
        status: refresh.classList.contains("refresh-preparing")
          ? "preparing"
          : (refresh.classList.contains("refresh-pending") ? "stale" : "current"),
        title: refresh.getAttribute("aria-label") || refresh.getAttribute("title") || "",
      };
    return {
      mode: "",
      viewDataToken: "",
      selectionKey: "",
      refresh: refreshState,
    };
  });
}

async function waitForFunctionValue(page, param, expectedValue) {
  await page.waitForFunction(({ name, expected }) => {
    const url = new URL(window.location.href);
    return (url.searchParams.get(name) || "") === expected;
  }, { name: param, expected: String(expectedValue ?? "") }, { timeout: GUI_READY_TIMEOUT_MS });
}

async function waitForUrlParam(page, param, expectedValue) {
  await waitForFunctionValue(page, param, expectedValue);
}

async function waitForReviewReposParam(page, expectedRepos) {
  await page.waitForFunction((expected) => {
    const url = new URL(window.location.href);
    const raw = url.searchParams.get("review_repos") || "";
    if (!raw) {
      return Array.isArray(expected) && expected.length === 0;
    }
    try {
      const parsed = JSON.parse(raw);
      return JSON.stringify(parsed) === JSON.stringify(expected);
    } catch (_err) {
      return false;
    }
  }, expectedRepos, { timeout: GUI_READY_TIMEOUT_MS });
}

async function waitForReviewBaseParam(page, expectedBase) {
  await waitForFunctionValue(page, "review_base", expectedBase);
}

async function waitForReviewRepoBasesParam(page, expectedValue) {
  await waitForFunctionValue(page, "review_repo_bases", expectedValue || "");
}

async function waitForNextGuiRefresh(page, options) {
  const refreshOptions = options && typeof options === "object" ? options : {};
  const previousState = refreshOptions.previousState || await readGuiViewLoadState(page);
  await waitForTrackedRequest(page, isGuiDataRequest, "GUI data refresh", refreshOptions.timeout);
  await waitForGuiDataReady(page, {
    timeout: refreshOptions.timeout,
    mode: refreshOptions.mode || String((previousState && previousState.mode) || ""),
    readySelector: refreshOptions.readySelector,
    readyCheck: refreshOptions.readyCheck,
  });
  const nextState = await readGuiViewLoadState(page);
  if (refreshOptions.requireViewDataTokenChange === true) {
    const previousToken = String(previousState && previousState.viewDataToken ? previousState.viewDataToken : "");
    const nextToken = String(nextState && nextState.viewDataToken ? nextState.viewDataToken : "");
    if (previousToken) {
      expect(nextToken, "Expected GUI refresh to load a new view-data token.").not.toBe(previousToken);
    } else {
      expect(nextToken, "Expected GUI refresh to expose a view-data token.").toBeTruthy();
    }
  }
  return {
    previousState,
    nextState,
  };
}

async function waitForNextSnapshotsRefresh(page) {
  await waitForTrackedRequest(page, isGuiSnapshotsRequest, "GUI snapshots refresh");
}

async function openRow(page, rowText) {
  await waitForGuiDataReady(page);
  await closeFiltersPanel(page);

  const rowCount = await page.locator("#list .row").count();
  if (rowCount === 0) {
    const emptyStateText = ((await page.locator("#list .empty").first().textContent()) || "").trim();
    throw new Error(`GUI rows loaded but no selectable rows were rendered. List state: ${emptyStateText}`);
  }

  const targetRow = page.getByRole("button", { name: rowText, exact: true });
  await expect(targetRow).toBeVisible({ timeout: 10000 });
  await targetRow.click();
}

async function waitForPreviewReady(page) {
  await page.waitForFunction(() => {
    const diff = document.getElementById("diff");
    return diff && !diff.classList.contains("loading");
  });
}

async function waitForRefreshState(page, expectedState, timeout = GUI_READY_TIMEOUT_MS) {
  const normalizedExpectedState = expectedState === true
    ? "stale"
    : (expectedState === false ? "current" : String(expectedState || "current"));
  const allowedTitles = normalizedExpectedState === "stale"
    ? ["New live data is ready. Refresh to load it."]
    : (normalizedExpectedState === "preparing"
      ? ["Preparing updated live data..."]
      : ["Refresh", "Reload snapshots and inspect data."]);
  await expect.poll(async () => {
    const state = await page.evaluate(() => {
      if (typeof window.__gitSnapshotTestForceRefreshStatePoll === "function") {
        return window.__gitSnapshotTestForceRefreshStatePoll();
      }
      const refresh = document.getElementById("refresh");
      if (!refresh) return null;
      const status = refresh.classList.contains("refresh-preparing")
        ? "preparing"
        : (refresh.classList.contains("refresh-pending") ? "stale" : "current");
      return {
        status,
        title: refresh.getAttribute("aria-label") || refresh.getAttribute("title") || "",
      };
    });
    return Boolean(state
      && state.status === normalizedExpectedState
      && allowedTitles.includes(state.title));
  }, { timeout }).toBe(true);
  await waitForRefreshTabState(page, normalizedExpectedState, timeout);
}

async function waitForRefreshHintState(page, expectedPending, timeout = GUI_READY_TIMEOUT_MS) {
  await waitForRefreshState(page, expectedPending ? "stale" : "current", timeout);
}

async function ensureRefreshStateRemains(page, expectedState, durationMs = 1500, sampleMs = 100) {
  const normalizedExpectedState = expectedState === true
    ? "stale"
    : (expectedState === false ? "current" : String(expectedState || "current"));
  await waitForRefreshState(page, normalizedExpectedState);
  await page.evaluate(({ stableState, stableForMs, probeMs }) => {
    function readRefreshState() {
      const refresh = document.getElementById("refresh");
      if (!refresh) {
        return "missing";
      }
      if (refresh.classList.contains("refresh-preparing")) {
        return "preparing";
      }
      if (refresh.classList.contains("refresh-pending")) {
        return "stale";
      }
      return "current";
    }

    return new Promise((resolve, reject) => {
      if (readRefreshState() !== stableState) {
        reject(new Error(`Expected refresh state ${stableState} before stability window.`));
        return;
      }
      const intervalId = window.setInterval(() => {
        if (readRefreshState() !== stableState) {
          window.clearInterval(intervalId);
          window.clearTimeout(timeoutId);
          reject(new Error(`Refresh state changed during ${stableForMs}ms stability window.`));
        }
      }, probeMs);
      const timeoutId = window.setTimeout(() => {
        window.clearInterval(intervalId);
        resolve();
      }, stableForMs);
    });
  }, {
    stableState: normalizedExpectedState,
    stableForMs: durationMs,
    probeMs: sampleMs,
  });
  await waitForRefreshTabState(page, normalizedExpectedState);
}

async function waitForRefreshTabState(page, expectedState, timeout = 15000) {
  const normalizedExpectedState = expectedState === true
    ? "stale"
    : (expectedState === false ? "current" : String(expectedState || "current"));
  await expect.poll(async () => {
    return page.evaluate(() => {
      const title = document.title || "";
      const favicon = document.getElementById("dynamicFavicon") || document.querySelector('link[rel="icon"]');
      let titleStatus = "current";
      if (title.startsWith("[Refresh Available] ")) {
        titleStatus = "stale";
      } else if (title.startsWith("[Preparing] ")) {
        titleStatus = "preparing";
      }
      return {
        titleStatus,
        faviconStatus: favicon ? String(favicon.getAttribute("data-refresh-status") || "current") : "missing",
      };
    });
  }, { timeout }).toEqual({
    titleStatus: normalizedExpectedState,
    faviconStatus: normalizedExpectedState,
  });
}

async function triggerRefresh(page, options) {
  await waitForGuiDataReady(page, options && options.ready ? options.ready : undefined);
  await closeFiltersPanel(page);
  const refreshPromise = waitForNextGuiRefresh(page, options);
  await page.locator("#refresh").click();
  await refreshPromise;
}

async function openRefreshMenu(page) {
  await waitForGuiDataReady(page);
  await closeFiltersPanel(page);
  const menu = page.locator("#refreshMenu");
  if (await menu.isVisible()) {
    return;
  }
  await page.locator("#refreshMenuButton").click();
  await expect(menu).toBeVisible();
}

async function closeRefreshMenu(page) {
  const menu = page.locator("#refreshMenu");
  if (!await menu.isVisible()) {
    return;
  }
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

async function triggerReloadSnapshots(page, options) {
  await waitForGuiDataReady(page, options && options.ready ? options.ready : undefined);
  await closeFiltersPanel(page);
  const refreshPromise = waitForNextGuiRefresh(page, options && options.guiRefresh ? options.guiRefresh : options);
  const snapshotsPromise = waitForNextSnapshotsRefresh(page);
  await openRefreshMenu(page);
  await page.locator("#hardRefresh").click();
  await Promise.all([snapshotsPromise, refreshPromise]);
}

async function openCreateSnapshotDialog(page) {
  await waitForGuiDataReady(page);
  await closeFiltersPanel(page);
  await page.locator("#createSnapshot").click();
  await expect(page.locator("#createSnapshotDialog")).toBeVisible();
  await expect(page.locator("#createSnapshotIdInput")).toBeEnabled({ timeout: 15000 });
}

async function openResetAllDialog(page) {
  await waitForGuiDataReady(page);
  await closeFiltersPanel(page);
  await page.locator("#resetAll").click();
  await expect(page.locator("#resetAllDialog")).toBeVisible();
}

async function submitCreateSnapshotDialog(page) {
  await page.locator("#createSnapshotSubmit").click();
  await expect(page.locator("#createSnapshotDialog")).toBeHidden({ timeout: 15000 });
  await waitForGuiDataReady(page);
}

async function openFiltersPanel(page) {
  await waitForGuiDataReady(page);
  const overlay = page.locator("#filtersOverlay");
  if (await overlay.isVisible()) {
    return;
  }
  await page.locator("#filtersButton").click();
  await expect(overlay).toBeVisible();
}

async function closeFiltersPanel(page) {
  const overlay = page.locator("#filtersOverlay");
  if (!await overlay.isVisible()) {
    return;
  }
  await page.locator("#filtersDone").click();
  await expect(overlay).toBeHidden();
}

async function openSnapshotPanel(page) {
  await waitForGuiDataReady(page);
  await closeFiltersPanel(page);
  const overlay = page.locator("#snapshotOverlay");
  if (await overlay.isVisible()) {
    return;
  }
  await page.locator("#snapshotPickerButton").click();
  await expect(overlay).toBeVisible();
}

async function closeSnapshotPanel(page) {
  const overlay = page.locator("#snapshotOverlay");
  if (!await overlay.isVisible()) {
    return;
  }
  await page.keyboard.press("Escape");
  await expect(overlay).toBeHidden();
}

async function ensureFilterControlVisible(page, selector) {
  const control = page.locator(selector);
  if (await control.isVisible()) {
    return control;
  }
  await openFiltersPanel(page);
  await expect(control).toBeVisible();
  return control;
}

function attrSelectorValue(value) {
  return String(value || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

async function openFilterableSelect(page, selector) {
  await waitForGuiDataReady(page);
  const root = page.locator(selector);
  const trigger = root.locator(".filterable-select-trigger");
  const popover = root.locator(".filterable-select-popover");
  await expect(trigger).toBeVisible();
  if (!await popover.isVisible()) {
    await trigger.click();
  }
  await expect(popover).toBeVisible();
  return root;
}

async function chooseFilterableSelectOption(page, selector, optionLabel, searchText = optionLabel) {
  const root = await openFilterableSelect(page, selector);
  const search = root.locator(".filterable-select-search");
  await search.fill(searchText);
  const option = root.locator(".filterable-select-option", { hasText: optionLabel }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(root.locator(".filterable-select-popover")).toBeHidden();
}

async function selectMode(page, mode) {
  await waitForGuiDataReady(page);
  const modeSelect = page.locator("#modeSelect");
  if ((await modeSelect.inputValue()) === mode) {
    await waitForGuiDataReady(page, { mode });
    return;
  }
  const previousState = await readGuiViewLoadState(page);
  const refreshPromise = waitForNextGuiRefresh(page, {
    previousState,
    mode,
    requireViewDataTokenChange: true,
  });
  await modeSelect.selectOption(mode);
  await expect(modeSelect).toHaveValue(mode);
  await refreshPromise;
}

async function selectSnapshot(page, snapshotId) {
  await waitForGuiDataReady(page);
  const snapshotSelect = page.locator("#snapshotSelect");
  if ((await snapshotSelect.inputValue()) === snapshotId) {
    return;
  }
  const previousState = await readGuiViewLoadState(page);
  const refreshPromise = waitForNextGuiRefresh(page, {
    previousState,
    mode: String((previousState && previousState.mode) || ""),
    requireViewDataTokenChange: true,
  });
  await openSnapshotPanel(page);
  await page.locator(`#snapshotList .snapshot-entry[data-snapshot-id="${snapshotId}"] .snapshot-entry-select`).click();
  await expect(page.locator("#snapshotOverlay")).toBeHidden();
  await expect(snapshotSelect).toHaveValue(snapshotId);
  await waitForUrlParam(page, "snapshot_id", snapshotId);
  await refreshPromise;
}

async function selectRepoFilter(page, repoFilter) {
  await waitForGuiDataReady(page);
  const repoFilterSelect = page.locator("#repoFilter");
  if ((await repoFilterSelect.inputValue()) === repoFilter) {
    return;
  }
  const visibleControl = await ensureFilterControlVisible(page, "#repoFilterPicker");
  await expect(visibleControl).toBeVisible();
  const optionLabel = repoFilter || "(all repos)";
  const searchText = repoFilter ? repoFilter.split("/").slice(-1)[0] : "(all repos)";
  await chooseFilterableSelectOption(page, "#repoFilterPicker", optionLabel, searchText);
  await expect(repoFilterSelect).toHaveValue(repoFilter);
  await waitForUrlParam(page, "repo_filter", repoFilter);
  await waitForGuiDataReady(page);
}

async function addReviewRepo(page, repo) {
  await chooseFilterableSelectOption(page, "#reviewRepoPicker", repo, repo);
  await waitForGuiDataReady(page);
}

async function openReviewSelectionTray(page) {
  await waitForGuiDataReady(page);
  const toggle = page.locator("#reviewSelectionToggle");
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute("aria-expanded")) === "true") {
    return;
  }
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#reviewSelectedTray")).toBeVisible();
}

async function closeReviewSelectionTray(page) {
  const toggle = page.locator("#reviewSelectionToggle");
  if (!await toggle.isVisible()) {
    return;
  }
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    return;
  }
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#reviewSelectedTray")).toBeHidden();
}

async function setFilterableSelectValue(page, selector, value) {
  const root = await openFilterableSelect(page, selector);
  const search = root.locator(".filterable-select-search");
  await search.fill(value);
  await search.press("Enter");
  await expect(root.locator(".filterable-select-popover")).toBeHidden();
  await waitForGuiDataReady(page);
}

async function selectReviewBase(page, baseRef) {
  await setFilterableSelectValue(page, "#reviewBasePicker", baseRef);
}

async function selectReviewRepoBase(page, repo, baseRef) {
  const selector = `.review-repo-base-control[data-repo="${attrSelectorValue(repo)}"] .filterable-select`;
  await setFilterableSelectValue(page, selector, baseRef);
}

async function dragReviewRepo(page, sourceRepo, targetRepo) {
  await openReviewSelectionTray(page);
  const sourceSelector = `.review-repo-chip[data-repo="${attrSelectorValue(sourceRepo)}"] .review-repo-chip-handle`;
  const targetSelector = `.review-repo-chip[data-repo="${attrSelectorValue(targetRepo)}"]`;
  await expect(page.locator(sourceSelector)).toBeVisible();
  await expect(page.locator(targetSelector)).toBeVisible();
  await page.dragAndDrop(sourceSelector, targetSelector);
  await waitForGuiDataReady(page);
}

async function loadReviewPreset(page, presetName) {
  await chooseFilterableSelectOption(page, "#reviewPresetPicker", presetName, presetName);
  await waitForGuiDataReady(page);
}

async function openReviewPresetActionsMenu(page) {
  await waitForGuiDataReady(page);
  const button = page.locator("#reviewPresetActionsButton");
  await expect(button).toBeVisible();
  if ((await button.getAttribute("aria-expanded")) === "true") {
    return;
  }
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#reviewPresetActionsMenu")).toBeVisible();
}

async function saveReviewPreset(page, presetName) {
  await waitForGuiDataReady(page);
  await openReviewPresetActionsMenu(page);
  await page.locator("#reviewPresetSave").click();
  await expect(page.locator("#saveReviewPresetDialog")).toBeVisible();
  await page.locator("#saveReviewPresetInput").fill(presetName);
  await page.locator("#saveReviewPresetSubmit").click();
  await expect(page.locator("#saveReviewPresetDialog")).toBeHidden({ timeout: 15000 });
}

async function renameReviewPreset(page, presetName) {
  await waitForGuiDataReady(page);
  await openReviewPresetActionsMenu(page);
  await page.locator("#reviewPresetRename").click();
  await expect(page.locator("#renameReviewPresetDialog")).toBeVisible();
  await page.locator("#renameReviewPresetInput").fill(presetName);
  await page.locator("#renameReviewPresetSubmit").click();
  await expect(page.locator("#renameReviewPresetDialog")).toBeHidden({ timeout: 15000 });
}

async function deleteReviewPreset(page) {
  await waitForGuiDataReady(page);
  await openReviewPresetActionsMenu(page);
  await page.locator("#reviewPresetDelete").click();
  await expect(page.locator("#deleteReviewPresetDialog")).toBeVisible();
  await page.locator("#deleteReviewPresetConfirm").click();
  await expect(page.locator("#deleteReviewPresetDialog")).toBeHidden({ timeout: 15000 });
}

async function setCheckbox(page, selector, checked) {
  await waitForGuiDataReady(page);
  const checkbox = await ensureFilterControlVisible(page, selector);
  if (await checkbox.isChecked() !== checked) {
    await checkbox.click();
    if (checked) {
      await expect(checkbox).toBeChecked();
    } else {
      await expect(checkbox).not.toBeChecked();
    }
    const paramBySelector = {
      "#compareIncludeNoEffect": "compare_include_no_effect",
      "#inspectStaged": "inspect_include_staged",
      "#inspectUnstaged": "inspect_include_unstaged",
      "#inspectUntracked": "inspect_include_untracked",
      "#inspectAllRepos": "inspect_show_all_repos",
      "#browseStaged": "browse_include_staged",
      "#browseUnstaged": "browse_include_unstaged",
      "#browseUntracked": "browse_include_untracked",
      "#browseSubmodules": "browse_include_submodules",
      "#browseAllRepos": "browse_show_all_repos",
    };
    if (Object.prototype.hasOwnProperty.call(paramBySelector, selector)) {
      await waitForUrlParam(page, paramBySelector[selector], checked ? "true" : "false");
    }
    await waitForGuiDataReady(page);
  }
}

async function selectCompareBase(page, compareBase) {
  await waitForGuiDataReady(page);
  await closeFiltersPanel(page);
  const selector = compareBase === "snapshot" ? "#compareBaseSnapshot" : "#compareBaseWorkingTree";
  const radio = await ensureFilterControlVisible(page, selector);
  if (await radio.isChecked()) {
    return;
  }
  const previousState = await readGuiViewLoadState(page);
  const refreshPromise = waitForNextGuiRefresh(page, {
    previousState,
    mode: "compare",
    requireViewDataTokenChange: true,
  });
  await radio.locator("xpath=..").click();
  await expect(radio).toBeChecked();
  await page.waitForFunction((expectedBase) => {
    const url = new URL(window.location.href);
    return url.searchParams.get("compare_base") === expectedBase;
  }, compareBase, { timeout: 15000 });
  await refreshPromise;
  await waitForPreviewReady(page);
}

async function collectScrollMetrics(page) {
  return page.evaluate(() => {
    const scroller = document.scrollingElement;
    const list = document.getElementById("list");
    const right = document.querySelector(".preview-panel");

    return {
      docScrollHeight: scroller ? scroller.scrollHeight : 0,
      docClientHeight: scroller ? scroller.clientHeight : 0,
      listScrollHeight: list ? list.scrollHeight : 0,
      listClientHeight: list ? list.clientHeight : 0,
      rightScrollHeight: right ? right.scrollHeight : 0,
      rightClientHeight: right ? right.clientHeight : 0,
    };
  });
}

module.exports = {
  collectScrollMetrics,
  closeFiltersPanel,
  closeRefreshMenu,
  closeSnapshotPanel,
  addReviewRepo,
  closeReviewSelectionTray,
  deleteReviewPreset,
  dragReviewRepo,
  loadReviewPreset,
  openReviewPresetActionsMenu,
  openReviewSelectionTray,
  openFilterableSelect,
  openFiltersPanel,
  openRefreshMenu,
  openSnapshotPanel,
  openCreateSnapshotDialog,
  openResetAllDialog,
  openRow,
  openCompareRow,
  renameReviewPreset,
  readGuiViewLoadState,
  saveReviewPreset,
  selectMode,
  selectCompareBase,
  selectRepoFilter,
  selectReviewBase,
  selectReviewRepoBase,
  selectSnapshot,
  setCheckbox,
  submitCreateSnapshotDialog,
  triggerHardRefresh: triggerReloadSnapshots,
  triggerReloadSnapshots,
  triggerRefresh,
  waitForCompareDataReady,
  waitForNextGuiRefresh,
  waitForNextSnapshotsRefresh,
  waitForGuiDataReady,
  waitForDiffReady,
  waitForPreviewReady,
  ensureRefreshStateRemains,
  waitForRefreshState,
  waitForRefreshHintState,
  waitForRefreshTabState,
  waitForReviewBaseParam,
  waitForReviewRepoBasesParam,
  waitForReviewReposParam,
};

async function openCompareRow(page, rowText) {
  await openRow(page, rowText);
}

async function waitForCompareDataReady(page) {
  await waitForGuiDataReady(page);
}

async function waitForDiffReady(page) {
  await waitForPreviewReady(page);
}
