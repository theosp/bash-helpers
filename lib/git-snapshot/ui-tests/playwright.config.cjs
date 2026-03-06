const { defineConfig } = require("@playwright/test");

module.exports = defineConfig({
  testDir: "./tests",
  timeout: 30000,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: 1,
  reporter: "line",
  use: {
    baseURL: process.env.GIT_SNAPSHOT_COMPARE_GUI_URL || "http://127.0.0.1:0/",
    browserName: "chromium",
    headless: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    viewport: {
      width: 1200,
      height: 520,
    },
  },
});
