const { expect } = require("@playwright/test");

async function waitForCompareDataReady(page) {
  await page.waitForFunction(() => {
    const list = document.getElementById("list");
    if (!list) return false;
    if (list.querySelector(".loading")) return false;
    return Boolean(list.querySelector(".row, .empty"));
  }, undefined, { timeout: 15000 });
}

async function openCompareRow(page, rowText) {
  await waitForCompareDataReady(page);

  const rowCount = await page.locator("#list .row").count();
  if (rowCount === 0) {
    const emptyStateText = ((await page.locator("#list .empty").first().textContent()) || "").trim();
    throw new Error(`Compare rows loaded but no selectable rows were rendered. List state: ${emptyStateText}`);
  }

  const targetRow = page.locator(".row").filter({ hasText: rowText });
  await expect(targetRow).toBeVisible({ timeout: 10000 });
  await targetRow.click();
}

async function waitForDiffReady(page) {
  await page.waitForFunction(() => {
    const diff = document.getElementById("diff");
    return diff && !diff.classList.contains("loading");
  });
}

async function collectScrollMetrics(page) {
  return page.evaluate(() => {
    const scroller = document.scrollingElement;
    const list = document.getElementById("list");
    const right = document.querySelector(".right");

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
  openCompareRow,
  waitForCompareDataReady,
  waitForDiffReady,
};
