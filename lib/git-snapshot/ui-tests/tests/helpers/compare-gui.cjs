const { expect } = require("@playwright/test");

async function waitForGuiDataReady(page) {
  await page.waitForFunction(() => {
    const list = document.getElementById("list");
    if (!list) return false;
    if (list.querySelector(".loading")) return false;
    return Boolean(list.querySelector(".row, .empty, .repo-empty"));
  }, undefined, { timeout: 15000 });
}

function isGuiDataRequest(resource) {
  const method = typeof resource.method === "function"
    ? resource.method()
    : resource.request().method();
  return method === "GET" && resource.url().includes("/api/data?");
}

async function waitForNextGuiRefresh(page) {
  await Promise.race([
    page.waitForResponse((response) => isGuiDataRequest(response), { timeout: 15000 }),
    page.waitForEvent("requestfailed", {
      predicate: (request) => isGuiDataRequest(request),
      timeout: 15000,
    }),
  ]);
  await waitForGuiDataReady(page);
}

async function openRow(page, rowText) {
  await waitForGuiDataReady(page);

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

async function selectMode(page, mode) {
  await waitForGuiDataReady(page);
  await page.locator("#modeSelect").selectOption(mode);
  await page.waitForFunction((expectedMode) => {
    const meta = document.getElementById("meta");
    return meta && meta.textContent && meta.textContent.includes(`Mode: ${expectedMode}`);
  }, mode, { timeout: 15000 });
  await waitForGuiDataReady(page);
}

async function selectSnapshot(page, snapshotId) {
  await waitForGuiDataReady(page);
  const snapshotSelect = page.locator("#snapshotSelect");
  if ((await snapshotSelect.inputValue()) === snapshotId) {
    return;
  }

  const refreshPromise = waitForNextGuiRefresh(page);
  await snapshotSelect.selectOption(snapshotId);
  await refreshPromise;
}

async function selectRepoFilter(page, repoFilter) {
  await waitForGuiDataReady(page);
  const repoFilterSelect = page.locator("#repoFilter");
  if ((await repoFilterSelect.inputValue()) === repoFilter) {
    return;
  }

  const refreshPromise = waitForNextGuiRefresh(page);
  await repoFilterSelect.selectOption(repoFilter);
  await refreshPromise;
}

async function setCheckbox(page, selector, checked) {
  await waitForGuiDataReady(page);
  const checkbox = page.locator(selector);
  if (await checkbox.isChecked() !== checked) {
    const refreshPromise = waitForNextGuiRefresh(page);
    await checkbox.click();
    await refreshPromise;
  }
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
  openRow,
  openCompareRow,
  selectMode,
  selectRepoFilter,
  selectSnapshot,
  setCheckbox,
  waitForCompareDataReady,
  waitForGuiDataReady,
  waitForDiffReady,
  waitForPreviewReady,
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
