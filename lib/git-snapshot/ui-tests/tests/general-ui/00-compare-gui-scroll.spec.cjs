const { test, expect } = require("@playwright/test");
const {
  collectScrollMetrics,
  openCompareRow,
  waitForGuiDataReady,
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
  const modePickerTrigger = page.locator("#modePicker .filterable-select-trigger");
  const repoFilterPickerTrigger = page.locator("#repoFilterPicker .filterable-select-trigger");

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await page.keyboard.press("Tab");
  await expect(modePickerTrigger).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.locator("#snapshotPickerButton")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.locator("#snapshotOverlay")).toBeVisible();
  await expect(page.locator("#snapshotList .snapshot-entry.active .snapshot-entry-select")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator("#snapshotOverlay")).toBeHidden();
  await expect(page.locator("#snapshotPickerButton")).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.locator("#compareBaseSnapshot")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.locator("#compareBaseSnapshot")).toBeChecked();

  await page.keyboard.press("Tab");
  await expect(page.locator("#filtersButton")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.locator("#filtersOverlay")).toBeVisible();
  await expect(repoFilterPickerTrigger).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.locator("#compareIncludeNoEffect")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator("#filtersOverlay")).toBeHidden();
  await expect(page.locator("#filtersButton")).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.locator("#refresh")).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(page.locator("#refreshMenuButton")).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(page.locator("#refreshMenu")).toBeVisible();
  await expect(page.locator("#hardRefresh")).toBeFocused();

  await page.keyboard.press("Escape");
  await expect(page.locator("#refreshMenu")).toBeHidden();
  await expect(page.locator("#refreshMenuButton")).toBeFocused();

  const repoRow = page.getByRole("button", { name: "Repo . compare rows", exact: true });
  const repoRowActions = page.getByRole("button", { name: "Row actions for repo .", exact: true });
  const firstFileRow = page.getByRole("button", { name: "000-scroll-target.txt [unresolved_diverged]", exact: true });

  await page.keyboard.press("Tab");
  await expect(repoRow).toBeFocused();

  await page.keyboard.press("Enter");
  await waitForDiffReady(page);

  await expect(repoRow).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Tab");
  await expect(repoRowActions).toBeFocused();

  await page.keyboard.press("Tab");
  await expect(firstFileRow).toBeFocused();

  await page.keyboard.press("Enter");
  await waitForDiffReady(page);

  await expect(firstFileRow).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#openExternal")).toBeEnabled();
});
