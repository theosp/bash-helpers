const { test, expect } = require("@playwright/test");

function getGuiEnv() {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  return { guiUrl };
}

test("invalid forced external diff overrides fail in-band without killing the GUI", async ({ page }) => {
  const { guiUrl } = getGuiEnv();
  const requestUrl = new URL("/api/open", guiUrl);
  requestUrl.searchParams.set("repo", ".");
  requestUrl.searchParams.set("file", "000-scroll-target.txt");

  const openResponse = await page.request.post(requestUrl.toString());
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining('Forced external diff command "definitely-missing-tool" is not available.'),
  });

  const dataResponse = await page.request.get(guiUrl + "api/data?mode=compare");
  expect(dataResponse.ok()).toBeTruthy();
  await expect(dataResponse.json()).resolves.toMatchObject({
    mode: "compare",
    rows: expect.any(Array),
  });
});
