const { test, expect } = require("@playwright/test");
const {
  collectScrollMetrics,
  openCompareRow,
  waitForDiffReady,
} = require("../helpers/compare-gui.cjs");

test("window stays fixed while navigator and preview panes scroll internally", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  await page.goto(guiUrl);

  await openCompareRow(page, "000-scroll-target.txt [unresolved_diverged]");
  await waitForDiffReady(page);
  const metrics = await collectScrollMetrics(page);

  expect(metrics.docScrollHeight).toBeLessThanOrEqual(metrics.docClientHeight);
  expect(metrics.listScrollHeight).toBeGreaterThan(metrics.listClientHeight);
  expect(metrics.rightScrollHeight).toBeGreaterThan(metrics.rightClientHeight);
});

test("phone-width layout stacks navigator above the diff pane", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(guiUrl);

  await openCompareRow(page, "000-scroll-target.txt [unresolved_diverged]");
  await waitForDiffReady(page);

  const layout = await page.evaluate(() => {
    const left = document.querySelector(".left");
    const right = document.querySelector(".right");
    if (!left || !right) return null;

    const leftRect = left.getBoundingClientRect();
    const rightRect = right.getBoundingClientRect();

    return {
      leftBottom: leftRect.bottom,
      leftWidth: leftRect.width,
      rightTop: rightRect.top,
      rightWidth: rightRect.width,
    };
  });

  expect(layout, "expected stacked panes to be measurable").toBeTruthy();
  expect(layout.leftBottom).toBeLessThanOrEqual(layout.rightTop + 1);
  expect(Math.abs(layout.leftWidth - layout.rightWidth)).toBeLessThanOrEqual(2);
});

test("keyboard users can tab to and select compare rows", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  await page.goto(guiUrl);

  await page.keyboard.press("Tab");
  await expect(page.locator("#refresh")).toBeFocused();

  await page.keyboard.press("Tab");
  const firstRow = page.locator("#list .row").first();
  await expect(firstRow).toBeFocused();

  await page.keyboard.press("Enter");
  await waitForDiffReady(page);

  await expect(firstRow).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#openExternal")).toBeEnabled();
});
