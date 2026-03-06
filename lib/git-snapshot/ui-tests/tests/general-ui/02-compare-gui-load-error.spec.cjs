const { test, expect } = require("@playwright/test");
const { waitForCompareDataReady } = require("../helpers/compare-gui.cjs");

test("compare data load failures render a real inline error state", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  let dialogSeen = false;
  page.on("dialog", async (dialog) => {
    dialogSeen = true;
    await dialog.dismiss();
  });

  await page.goto(guiUrl);
  await waitForCompareDataReady(page);

  const listMessage = page.locator("#list .empty").first();
  await expect(listMessage).toHaveClass(/error/);
  await expect(listMessage).toContainText("Failed to load compare rows:");
  await expect(listMessage).toContainText("Forced compare data load failure for test.");
  await expect(page.locator("#diff")).toHaveText("Unable to load compare rows.");
  await expect(page.locator("#openExternal")).toBeDisabled();

  await page.locator("#refresh").click();
  await waitForCompareDataReady(page);

  await expect(listMessage).toContainText("Forced compare data load failure for test.");
  expect(dialogSeen).toBeFalsy();
});
