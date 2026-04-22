const fs = require("fs");
const { test, expect } = require("@playwright/test");
const {
  openCompareRow,
  selectCompareBase,
  selectMode,
  selectRepoFilter,
  waitForDiffReady,
  waitForGuiDataReady,
} = require("../helpers/compare-gui.cjs");

const SPLIT_STORAGE_KEY = "git-snapshot.gui.split.left-ratio.v1";
const DEFAULT_SPLITTER_MIN_RATIO = 0.24;
const DEFAULT_SPLITTER_MAX_RATIO = 0.76;
const FALLBACK_SPLITTER_MIN_RATIO = 0.34;
const FALLBACK_SPLITTER_MAX_RATIO = 0.66;
const SPLITTER_WIDTH_PX = 12;

test("compare diff preview renders a structured GitHub-style diff view", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  await page.goto(guiUrl);
  await openCompareRow(page, "000-scroll-target.txt [unresolved_diverged]");
  await waitForDiffReady(page);

  const diffState = await page.evaluate(() => {
    const diff = document.getElementById("diff");
    const addCode = diff ? diff.querySelector(".diff-line.add .diff-code") : null;
    const contextCode = diff ? diff.querySelector(".diff-line.context .diff-code") : null;
    const hunkCode = diff ? diff.querySelector(".diff-line.hunk .diff-code") : null;

    return {
      rendered: diff ? diff.classList.contains("rendered-diff") : false,
      fileCount: diff ? diff.querySelectorAll(".diff-file").length : 0,
      addCount: diff ? diff.querySelectorAll(".diff-line.add").length : 0,
      deleteCount: diff ? diff.querySelectorAll(".diff-line.delete").length : 0,
      hunkCount: diff ? diff.querySelectorAll(".diff-line.hunk").length : 0,
      title: diff && diff.querySelector(".diff-file-title") ? diff.querySelector(".diff-file-title").textContent : "",
      addLegend: diff && diff.querySelector(".diff-file-chip-add") ? diff.querySelector(".diff-file-chip-add").textContent : "",
      deleteLegend: diff && diff.querySelector(".diff-file-chip-delete") ? diff.querySelector(".diff-file-chip-delete").textContent : "",
      addLegendTitle: diff && diff.querySelector(".diff-file-chip-add") ? diff.querySelector(".diff-file-chip-add").getAttribute("title") : "",
      deleteLegendTitle: diff && diff.querySelector(".diff-file-chip-delete") ? diff.querySelector(".diff-file-chip-delete").getAttribute("title") : "",
      addBackground: addCode ? getComputedStyle(addCode).backgroundColor : "",
      deleteBackground: diff && diff.querySelector(".diff-line.delete .diff-code")
        ? getComputedStyle(diff.querySelector(".diff-line.delete .diff-code")).backgroundColor
        : "",
      contextBackground: contextCode ? getComputedStyle(contextCode).backgroundColor : "",
      hunkBackground: hunkCode ? getComputedStyle(hunkCode).backgroundColor : "",
    };
  });

  expect(diffState.rendered).toBeTruthy();
  expect(diffState.fileCount).toBeGreaterThanOrEqual(1);
  expect(diffState.addCount + diffState.deleteCount).toBeGreaterThan(0);
  expect(diffState.hunkCount).toBeGreaterThan(0);
  expect(diffState.title).toContain("000-scroll-target.txt");
  expect(diffState.addLegend).toContain("working-tree changes since snapshot");
  expect(diffState.deleteLegend).toContain("snapshot-only content replaced or removed");
  expect(diffState.addLegendTitle).toContain("exists now in the working tree but was not present in the snapshot target");
  expect(diffState.deleteLegendTitle).toContain("existed in the snapshot target but has since been removed or replaced in the working tree");
  expect(diffState.addBackground || diffState.deleteBackground).toBeTruthy();
  expect(diffState.hunkBackground).toBeTruthy();
  if (diffState.addBackground) {
    expect(diffState.addBackground).not.toBe(diffState.contextBackground);
  }
  if (diffState.deleteBackground) {
    expect(diffState.deleteBackground).not.toBe(diffState.contextBackground);
  }
  expect(diffState.hunkBackground).not.toBe(diffState.contextBackground);
});

test("compare base toggle reloads compare rows and flips diff orientation", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  let dataRequestCount = 0;
  page.on("request", (request) => {
    if (request.url().includes("/api/data?")) {
      dataRequestCount += 1;
    }
  });

  await page.goto(guiUrl);
  await openCompareRow(page, "000-scroll-target.txt [unresolved_diverged]");
  await waitForDiffReady(page);

  await expect(page.locator("#diff")).toContainText("compare base: snapshot");
  await expect(page.locator(".diff-file-chip-add")).toContainText("working-tree changes since snapshot");
  await expect(page.locator(".diff-file-chip-delete")).toContainText("snapshot-only content replaced or removed");

  const dataRequestsBeforeToggle = dataRequestCount;
  await selectCompareBase(page, "working-tree");

  await expect(page.locator("#diff")).toContainText("compare base: working tree");
  await expect(page.locator(".diff-file-chip-add")).toContainText("restore snapshot content");
  await expect(page.locator(".diff-file-chip-delete")).toContainText("remove current-only content");
  expect(dataRequestCount).toBeGreaterThan(dataRequestsBeforeToggle);
});

test("compare diff preview keeps captured untracked snapshot content visible for diverged rows", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  await page.goto(guiUrl);
  await openCompareRow(page, "inspect-untracked.txt [unresolved_diverged]");
  await waitForDiffReady(page);

  const diffState = await page.evaluate(() => {
    const diff = document.getElementById("diff");
    return {
      rendered: diff ? diff.classList.contains("rendered-diff") : false,
      title: diff && diff.querySelector(".diff-file-title") ? diff.querySelector(".diff-file-title").textContent : "",
      addCount: diff ? diff.querySelectorAll(".diff-line.add").length : 0,
      deleteCount: diff ? diff.querySelectorAll(".diff-line.delete").length : 0,
      text: diff ? (diff.textContent || "") : "",
    };
  });

  expect(diffState.rendered).toBeTruthy();
  expect(diffState.title).toContain("inspect-untracked.txt");
  expect(diffState.addCount).toBeGreaterThan(0);
  expect(diffState.deleteCount).toBe(0);
  expect(diffState.text).toContain("compare base: snapshot");
  expect(diffState.text).toContain("captured untracked line 1");
  expect(diffState.text).toContain("captured untracked line 2");
  expect(diffState.text).toContain("current untracked divergence");
});

test("unresolved missing rows show snapshot-only content with a concise tooltip", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  await page.goto(guiUrl);
  await openCompareRow(page, "missing-preview.txt [unresolved_missing]");
  await waitForDiffReady(page);

  const previewState = await page.evaluate(() => {
    const diff = document.getElementById("diff");
    return {
      rendered: diff ? diff.classList.contains("rendered-diff") : false,
      title: diff && diff.querySelector(".diff-file-title") ? diff.querySelector(".diff-file-title").textContent : "",
      meta: diff && diff.querySelector(".diff-file-meta") ? diff.querySelector(".diff-file-meta").textContent : "",
      addCount: diff ? diff.querySelectorAll(".diff-line.add").length : 0,
      deleteCount: diff ? diff.querySelectorAll(".diff-line.delete").length : 0,
      addLegend: diff && diff.querySelector(".diff-file-chip-add") ? diff.querySelector(".diff-file-chip-add").textContent : "",
      deleteLegend: diff && diff.querySelector(".diff-file-chip-delete") ? diff.querySelector(".diff-file-chip-delete").textContent : "",
      noteLegend: diff && diff.querySelector(".diff-file-chip-note") ? diff.querySelector(".diff-file-chip-note").textContent : "",
      text: diff ? diff.textContent || "" : "",
    };
  });

  expect(previewState.rendered).toBeTruthy();
  expect(previewState.title).toContain("missing-preview.txt");
  expect(previewState.meta).toContain("current-working-tree preview: path missing");
  expect(previewState.addCount).toBe(0);
  expect(previewState.deleteCount).toBeGreaterThan(0);
  expect(previewState.deleteLegend).toContain("current path removes snapshot content");
  expect(previewState.noteLegend).toContain("current copy missing");
  expect(previewState.text).toContain("compare base: snapshot");
  expect(previewState.text).toContain("captured missing line 1");
  expect(previewState.text).toContain("captured missing line 2");

  await selectCompareBase(page, "working-tree");
  await waitForDiffReady(page);

  await expect(page.locator("#diff")).toContainText("compare base: working tree");
  await expect(page.locator(".diff-file-meta")).toContainText("snapshot-only preview: working tree path missing");
  await expect(page.locator(".diff-file-chip-add")).toContainText("restore missing snapshot content");
  await expect(page.locator(".diff-file-chip-note")).toContainText("current copy missing");
});

test("current-only rows preview against an empty snapshot side and flip with compare base", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  await page.goto(guiUrl);
  await openCompareRow(page, "late-current-only.txt [unresolved_diverged]");
  await waitForDiffReady(page);

  const snapshotBaseState = await page.evaluate(() => {
    const diff = document.getElementById("diff");
    return {
      rendered: diff ? diff.classList.contains("rendered-diff") : false,
      title: diff && diff.querySelector(".diff-file-title") ? diff.querySelector(".diff-file-title").textContent : "",
      addCount: diff ? diff.querySelectorAll(".diff-line.add").length : 0,
      deleteCount: diff ? diff.querySelectorAll(".diff-line.delete").length : 0,
      text: diff ? (diff.textContent || "") : "",
    };
  });

  expect(snapshotBaseState.rendered).toBeTruthy();
  expect(snapshotBaseState.title).toContain("late-current-only.txt");
  expect(snapshotBaseState.addCount).toBeGreaterThan(0);
  expect(snapshotBaseState.deleteCount).toBe(0);
  expect(snapshotBaseState.text).toContain("compare base: snapshot");
  expect(snapshotBaseState.text).toContain("late current only line 1");
  expect(snapshotBaseState.text).toContain("late current only line 2");
  expect(snapshotBaseState.text).not.toContain("Compare preview is unavailable");

  await selectCompareBase(page, "working-tree");
  await waitForDiffReady(page);

  const workingTreeState = await page.evaluate(() => {
    const diff = document.getElementById("diff");
    return {
      addCount: diff ? diff.querySelectorAll(".diff-line.add").length : 0,
      deleteCount: diff ? diff.querySelectorAll(".diff-line.delete").length : 0,
      text: diff ? (diff.textContent || "") : "",
    };
  });

  await expect(page.locator("#diff")).toContainText("compare base: working tree");
  expect(workingTreeState.addCount).toBe(0);
  expect(workingTreeState.deleteCount).toBeGreaterThan(0);
  expect(workingTreeState.text).toContain("late current only line 1");
  expect(workingTreeState.text).not.toContain("Compare preview is unavailable");
});

test("compare header, repo sections, and rows expose exact line stats and flip with compare base", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  const snapshotStats = await page.evaluate(() => {
    const listHeader = document.querySelector("#list .list-header");
    const repoHeader = document.querySelector("#list .repo-header");
    const rows = Array.from(document.querySelectorAll("#list .row"));
    const byLabel = (label) => rows.find((node) => node.getAttribute("aria-label") === label);
    const readPair = (node) => ({
      add: node && node.querySelector(".diff-stat-add strong") ? node.querySelector(".diff-stat-add strong").textContent : "",
      remove: node && node.querySelector(".diff-stat-remove strong") ? node.querySelector(".diff-stat-remove strong").textContent : "",
    });

    return {
      header: readPair(listHeader),
      repo: readPair(repoHeader),
      currentOnly: readPair(byLabel("late-current-only.txt [unresolved_diverged]")),
      scroll: readPair(byLabel("000-scroll-target.txt [unresolved_diverged]")),
    };
  });

  expect(snapshotStats.header).toEqual({ add: "+243", remove: "-2" });
  expect(snapshotStats.repo).toEqual({ add: "+243", remove: "-2" });
  expect(snapshotStats.currentOnly).toEqual({ add: "+2", remove: "-0" });
  expect(snapshotStats.scroll).toEqual({ add: "+240", remove: "-0" });

  await selectCompareBase(page, "working-tree");
  await waitForGuiDataReady(page);

  const workingTreeStats = await page.evaluate(() => {
    const listHeader = document.querySelector("#list .list-header");
    const repoHeader = document.querySelector("#list .repo-header");
    const rows = Array.from(document.querySelectorAll("#list .row"));
    const byLabel = (label) => rows.find((node) => node.getAttribute("aria-label") === label);
    const readPair = (node) => ({
      add: node && node.querySelector(".diff-stat-add strong") ? node.querySelector(".diff-stat-add strong").textContent : "",
      remove: node && node.querySelector(".diff-stat-remove strong") ? node.querySelector(".diff-stat-remove strong").textContent : "",
    });

    return {
      header: readPair(listHeader),
      repo: readPair(repoHeader),
      currentOnly: readPair(byLabel("late-current-only.txt [unresolved_diverged]")),
      scroll: readPair(byLabel("000-scroll-target.txt [unresolved_diverged]")),
    };
  });

  expect(workingTreeStats.header).toEqual({ add: "+2", remove: "-243" });
  expect(workingTreeStats.repo).toEqual({ add: "+2", remove: "-243" });
  expect(workingTreeStats.currentOnly).toEqual({ add: "+0", remove: "-2" });
  expect(workingTreeStats.scroll).toEqual({ add: "+0", remove: "-240" });
});

test("submodule compare rows render a friendly summary with commit subjects", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const expectedCommitCount = Number(process.env.GIT_SNAPSHOT_UI_TEST_CLEAN_SUB_ADVANCE_COUNT || "0");
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(expectedCommitCount, "GIT_SNAPSHOT_UI_TEST_CLEAN_SUB_ADVANCE_COUNT must be set by the shell wrapper").toBeGreaterThanOrEqual(24);

  await page.goto(guiUrl);
  const submoduleRow = page.getByRole("button", { name: "modules/clean-sub [submodule change]", exact: true });
  await submoduleRow.click();
  await waitForDiffReady(page);

  const summaryState = await page.evaluate(() => {
    const summary = document.querySelector(".submodule-summary");
    const openExternal = document.getElementById("openExternal");
    const relationField = summary ? Array.from(summary.querySelectorAll(".submodule-summary-field")).find((node) => {
      const label = node.querySelector(".submodule-summary-field-label");
      return label && (label.textContent || "") === "Relation";
    }) : null;
    const relationKeyword = relationField ? relationField.querySelector(".submodule-relation-keyword") : null;
    const commitItems = summary ? Array.from(summary.querySelectorAll(".submodule-summary-commits li")).map((node) => node.textContent || "") : [];
    const moreNode = summary ? summary.querySelector(".submodule-summary-more") : null;
    return {
      rendered: Boolean(summary),
      text: summary ? (summary.textContent || "") : "",
      openDisabled: openExternal ? openExternal.disabled : null,
      relationFieldClass: relationField ? relationField.className : "",
      relationKeywordText: relationKeyword ? relationKeyword.textContent : "",
      relationKeywordClass: relationKeyword ? relationKeyword.className : "",
      commitItems,
      hasMoreNode: Boolean(moreNode),
    };
  });

  expect(summaryState.rendered).toBeTruthy();
  expect(summaryState.text).toContain("Submodule summary");
  expect(summaryState.text).toContain("modules/clean-sub");
  expect(summaryState.text).toContain("submodule (gitlink)");
  expect(summaryState.text).toContain(`Current checkout is ahead of the snapshot target by ${expectedCommitCount} commits.`);
  expect(summaryState.text).toContain("Current-only commits");
  expect(summaryState.commitItems).toHaveLength(expectedCommitCount);
  expect(summaryState.text).toContain("advance clean submodule 1");
  expect(summaryState.text).toContain(`advance clean submodule ${expectedCommitCount}`);
  expect(summaryState.hasMoreNode).toBe(false);
  expect(summaryState.relationFieldClass).toContain("relation-ahead");
  expect(summaryState.relationKeywordText).toBe("ahead");
  expect(summaryState.relationKeywordClass).toContain("ahead");
  expect(summaryState.text).not.toContain('{"ok":false');
  expect(summaryState.text).not.toContain("EISDIR");
  expect(summaryState.openDisabled).toBe(true);
});

test("browse submodule rows render a live HEAD-relative summary", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const expectedCommitCount = Number(process.env.GIT_SNAPSHOT_UI_TEST_CLEAN_SUB_ADVANCE_COUNT || "0");
  const expectedAheadCount = expectedCommitCount + 1;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(expectedCommitCount, "GIT_SNAPSHOT_UI_TEST_CLEAN_SUB_ADVANCE_COUNT must be set by the shell wrapper").toBeGreaterThanOrEqual(24);

  await page.goto(guiUrl);
  await selectMode(page, "browse");

  const submoduleRow = page.getByRole("button", { name: "modules/clean-sub [submodules]", exact: true });
  await submoduleRow.click();
  await waitForDiffReady(page);

  const summaryState = await page.evaluate(() => {
    const summary = document.querySelector(".submodule-summary");
    const openExternal = document.getElementById("openExternal");
    const relationField = summary ? Array.from(summary.querySelectorAll(".submodule-summary-field")).find((node) => {
      const label = node.querySelector(".submodule-summary-field-label");
      return label && (label.textContent || "") === "Relation";
    }) : null;
    return {
      rendered: Boolean(summary),
      text: summary ? (summary.textContent || "") : "",
      openDisabled: openExternal ? openExternal.disabled : null,
      relationFieldClass: relationField ? relationField.className : "",
    };
  });

  expect(summaryState.rendered).toBeTruthy();
  expect(summaryState.text).toContain("Submodule summary");
  expect(summaryState.text).toContain("modules/clean-sub");
  expect(summaryState.text).toContain(`Current checkout is ahead of the HEAD gitlink by ${expectedAheadCount} commits.`);
  expect(summaryState.text).toContain("Current-only commits (not yet recorded in HEAD)");
  expect(summaryState.text).toContain("advance clean submodule 1");
  expect(summaryState.text).toContain(`advance clean submodule ${expectedCommitCount}`);
  expect(summaryState.relationFieldClass).toContain("relation-ahead");
  expect(summaryState.openDisabled).toBe(true);
});

test("browse staged-only submodule rows explain staged gitlink drift when checkout still matches HEAD", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  await page.goto(guiUrl);
  await selectMode(page, "browse");

  const submoduleRow = page.getByRole("button", { name: "modules/staged-sub [submodules]", exact: true });
  await submoduleRow.click();
  await waitForDiffReady(page);

  const summaryState = await page.evaluate(() => {
    const summary = document.querySelector(".submodule-summary");
    const openExternal = document.getElementById("openExternal");
    const relationField = summary ? Array.from(summary.querySelectorAll(".submodule-summary-field")).find((node) => {
      const label = node.querySelector(".submodule-summary-field-label");
      return label && (label.textContent || "") === "Relation";
    }) : null;
    return {
      rendered: Boolean(summary),
      text: summary ? (summary.textContent || "") : "",
      openDisabled: openExternal ? openExternal.disabled : null,
      relationFieldClass: relationField ? relationField.className : "",
    };
  });

  expect(summaryState.rendered).toBeTruthy();
  expect(summaryState.text).toContain("Submodule summary");
  expect(summaryState.text).toContain("modules/staged-sub");
  expect(summaryState.text).toContain("Staged gitlink is ahead of the HEAD gitlink");
  expect(summaryState.text).toContain("The checked-out submodule still matches HEAD.");
  expect(summaryState.text).toContain("The staged gitlink commit differs from HEAD for this submodule path.");
  expect(summaryState.text).toContain("The checked-out submodule HEAD differs from the superproject index gitlink.");
  expect(summaryState.text).not.toContain("Current checkout matches the HEAD gitlink commit.");
  expect(summaryState.relationFieldClass).toContain("relation-ahead");
  expect(summaryState.openDisabled).toBe(true);
});

test("repo-missing compare rows keep previews read-only and block external diff", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  const snapshotId = process.env.GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID;
  const missingRepoRel = process.env.GIT_SNAPSHOT_UI_TEST_MISSING_REPO_REL;
  const missingRepoFile = process.env.GIT_SNAPSHOT_UI_TEST_MISSING_REPO_FILE;
  const missingRepoAbs = process.env.GIT_SNAPSHOT_UI_TEST_MISSING_REPO_ABS;

  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  expect(snapshotId, "GIT_SNAPSHOT_UI_TEST_PRIMARY_SNAPSHOT_ID must be set by the shell wrapper").toBeTruthy();
  expect(missingRepoRel, "GIT_SNAPSHOT_UI_TEST_MISSING_REPO_REL must be set by the shell wrapper").toBeTruthy();
  expect(missingRepoFile, "GIT_SNAPSHOT_UI_TEST_MISSING_REPO_FILE must be set by the shell wrapper").toBeTruthy();
  expect(missingRepoAbs, "GIT_SNAPSHOT_UI_TEST_MISSING_REPO_ABS must be set by the shell wrapper").toBeTruthy();

  await page.goto(guiUrl);
  await selectRepoFilter(page, missingRepoRel);

  await openCompareRow(page, `${missingRepoFile} [unresolved_missing]`);
  await waitForDiffReady(page);

  await expect(page.locator("#diff")).toContainText(`The repository is missing at ${missingRepoRel}.`);
  await expect(page.locator("#openExternal")).toBeDisabled();

  const requestUrl = new URL("/api/open", guiUrl);
  requestUrl.searchParams.set("mode", "compare");
  requestUrl.searchParams.set("snapshot_id", snapshotId);
  requestUrl.searchParams.set("repo_filter", missingRepoRel);
  requestUrl.searchParams.set("compare_include_no_effect", "true");
  requestUrl.searchParams.set("repo", missingRepoRel);
  requestUrl.searchParams.set("file", missingRepoFile);

  const openResponse = await page.request.post(requestUrl.toString());
  expect(openResponse.ok()).toBeTruthy();
  await expect(openResponse.json()).resolves.toMatchObject({
    ok: false,
    error: "External diff is not available until the missing repo/path is restored.",
  });
  expect(fs.existsSync(missingRepoAbs)).toBe(false);
});

test("compare moves snapshot summary into a compact navigator header", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  const headerState = await page.evaluate(() => {
    const toolbar = document.querySelector(".top");
    const listHeader = document.querySelector("#list .list-header");
    const actionsControl = document.querySelector(".actions-control");

    return {
      toolbarHeight: toolbar ? Math.round(toolbar.getBoundingClientRect().height) : 0,
      hasVisibleTitleBlock: Boolean(document.querySelector(".top .title, .top .meta, .top .summary")),
      hasActionsLabel: Boolean(actionsControl && actionsControl.querySelector("label, .toggle-group-title")),
      listHeaderText: listHeader ? (listHeader.textContent || "") : "",
      pillCount: listHeader ? listHeader.querySelectorAll(".list-pill").length : 0,
      listAddPills: listHeader ? listHeader.querySelectorAll(".diff-stat-add").length : 0,
      listRemovePills: listHeader ? listHeader.querySelectorAll(".diff-stat-remove").length : 0,
      repoHeaderText: document.querySelector(".repo-header") ? (document.querySelector(".repo-header").textContent || "") : "",
      repoAddPills: document.querySelector(".repo-header") ? document.querySelector(".repo-header").querySelectorAll(".diff-stat-add").length : 0,
      repoRemovePills: document.querySelector(".repo-header") ? document.querySelector(".repo-header").querySelectorAll(".diff-stat-remove").length : 0,
    };
  });

  expect(headerState.hasVisibleTitleBlock).toBeFalsy();
  expect(headerState.hasActionsLabel).toBeFalsy();
  expect(headerState.toolbarHeight).toBeLessThanOrEqual(120);
  expect(headerState.listHeaderText).toContain("Compare rows");
  expect(headerState.listHeaderText).toContain("compare");
  expect(headerState.listHeaderText).toContain("effect");
  expect(headerState.listHeaderText).toContain("repos");
  expect(headerState.pillCount).toBeGreaterThanOrEqual(4);
  expect(headerState.listAddPills).toBeGreaterThanOrEqual(1);
  expect(headerState.listRemovePills).toBeGreaterThanOrEqual(1);
  expect(headerState.repoHeaderText).toContain("effect");
  expect(headerState.repoAddPills).toBeGreaterThanOrEqual(1);
  expect(headerState.repoRemovePills).toBeGreaterThanOrEqual(1);
});

test("desktop splitter resizes the navigator and persists across reload", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();
  test.slow();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(guiUrl);
  await waitForGuiDataReady(page, { timeout: 90000 });

  await page.evaluate((storageKey) => {
    window.localStorage.removeItem(storageKey);
  }, SPLIT_STORAGE_KEY);

  await page.reload();
  await waitForGuiDataReady(page, { timeout: 90000 });

  const before = await page.evaluate(() => {
    const left = document.querySelector(".left");
    const right = document.querySelector(".right");
    return {
      leftWidth: left ? left.getBoundingClientRect().width : 0,
      rightWidth: right ? right.getBoundingClientRect().width : 0,
    };
  });

  const splitter = page.locator("#splitter");
  await expect(splitter).toBeVisible();
  const box = await splitter.boundingBox();
  expect(box, "splitter should have a measurable box").toBeTruthy();

  const startX = box.x + (box.width / 2);
  const startY = box.y + (box.height / 2);
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 160, startY, { steps: 12 });
  await page.mouse.up();

  const after = await page.evaluate((storageKey) => {
    const left = document.querySelector(".left");
    const right = document.querySelector(".right");
    return {
      leftWidth: left ? left.getBoundingClientRect().width : 0,
      rightWidth: right ? right.getBoundingClientRect().width : 0,
      storedRatio: window.localStorage.getItem(storageKey),
    };
  }, SPLIT_STORAGE_KEY);

  expect(after.leftWidth).toBeGreaterThan(before.leftWidth + 100);
  expect(after.rightWidth).toBeLessThan(before.rightWidth - 100);
  expect(after.storedRatio).toBeTruthy();

  await page.reload();
  await waitForGuiDataReady(page, { timeout: 90000 });

  const reloaded = await page.evaluate((storageKey) => {
    const left = document.querySelector(".left");
    return {
      leftWidth: left ? left.getBoundingClientRect().width : 0,
      storedRatio: window.localStorage.getItem(storageKey),
    };
  }, SPLIT_STORAGE_KEY);

  expect(reloaded.storedRatio).toBe(after.storedRatio);
  expect(Math.abs(reloaded.leftWidth - after.leftWidth)).toBeLessThanOrEqual(14);
});

test("desktop splitter aria bounds follow responsive width limits", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  const splitState = await page.evaluate((args) => {
    const {
      defaultMinRatio,
      defaultMaxRatio,
      fallbackMinRatio,
      fallbackMaxRatio,
      splitterWidthPx,
    } = args;
    const main = document.getElementById("main");
    const splitterNode = document.getElementById("splitter");
    const totalWidth = Math.max(0, (main ? main.clientWidth : 0) - splitterWidthPx);
    let min = defaultMinRatio;
    let max = defaultMaxRatio;

    if (totalWidth > 0) {
      min = Math.max(defaultMinRatio, 260 / totalWidth);
      max = Math.min(defaultMaxRatio, 1 - (320 / totalWidth));
      if (!(min < max)) {
        min = fallbackMinRatio;
        max = fallbackMaxRatio;
      }
    }

    return {
      ariaMin: Number(splitterNode ? splitterNode.getAttribute("aria-valuemin") || 0 : 0),
      ariaMax: Number(splitterNode ? splitterNode.getAttribute("aria-valuemax") || 0 : 0),
      expectedMin: Math.round(min * 100),
      expectedMax: Math.round(max * 100),
    };
  }, {
    defaultMinRatio: DEFAULT_SPLITTER_MIN_RATIO,
    defaultMaxRatio: DEFAULT_SPLITTER_MAX_RATIO,
    fallbackMinRatio: FALLBACK_SPLITTER_MIN_RATIO,
    fallbackMaxRatio: FALLBACK_SPLITTER_MAX_RATIO,
    splitterWidthPx: SPLITTER_WIDTH_PX,
  });

  expect(splitState.expectedMin).toBeGreaterThan(DEFAULT_SPLITTER_MIN_RATIO * 100);
  expect(splitState.expectedMax).toBeLessThan(DEFAULT_SPLITTER_MAX_RATIO * 100);
  expect(splitState.ariaMin).toBe(splitState.expectedMin);
  expect(splitState.ariaMax).toBe(splitState.expectedMax);
});

test("desktop splitter supports keyboard resizing shortcuts", async ({ page }) => {
  const guiUrl = process.env.GIT_SNAPSHOT_COMPARE_GUI_URL;
  expect(guiUrl, "GIT_SNAPSHOT_COMPARE_GUI_URL must be set by the shell wrapper").toBeTruthy();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(guiUrl);
  await waitForGuiDataReady(page);

  await page.evaluate((storageKey) => {
    window.localStorage.removeItem(storageKey);
  }, SPLIT_STORAGE_KEY);

  await page.reload();
  await waitForGuiDataReady(page);

  const splitter = page.locator("#splitter");
  await expect(splitter).toBeVisible();
  await splitter.focus();

  const before = await page.evaluate(() => {
    const left = document.querySelector(".left");
    const splitterNode = document.getElementById("splitter");
    return {
      leftWidth: left ? left.getBoundingClientRect().width : 0,
      ariaValueNow: splitterNode ? Number(splitterNode.getAttribute("aria-valuenow") || 0) : 0,
      storedRatio: window.localStorage.getItem("git-snapshot.gui.split.left-ratio.v1"),
    };
  });

  await page.keyboard.press("ArrowRight");
  const afterArrow = await page.evaluate(() => {
    const left = document.querySelector(".left");
    const splitterNode = document.getElementById("splitter");
    return {
      leftWidth: left ? left.getBoundingClientRect().width : 0,
      ariaValueNow: splitterNode ? Number(splitterNode.getAttribute("aria-valuenow") || 0) : 0,
      storedRatio: window.localStorage.getItem("git-snapshot.gui.split.left-ratio.v1"),
    };
  });

  expect(afterArrow.leftWidth).toBeGreaterThan(before.leftWidth + 10);
  expect(afterArrow.ariaValueNow).toBeGreaterThan(before.ariaValueNow);
  expect(afterArrow.storedRatio).toBeTruthy();

  await page.keyboard.press("Home");
  const afterHome = await page.evaluate(() => {
    const left = document.querySelector(".left");
    const splitterNode = document.getElementById("splitter");
    return {
      leftWidth: left ? left.getBoundingClientRect().width : 0,
      ariaValueNow: splitterNode ? Number(splitterNode.getAttribute("aria-valuenow") || 0) : 0,
    };
  });

  expect(afterHome.leftWidth).toBeLessThan(afterArrow.leftWidth - 100);

  await page.keyboard.press("End");
  const afterEnd = await page.evaluate(() => {
    const left = document.querySelector(".left");
    const splitterNode = document.getElementById("splitter");
    return {
      leftWidth: left ? left.getBoundingClientRect().width : 0,
      ariaValueNow: splitterNode ? Number(splitterNode.getAttribute("aria-valuenow") || 0) : 0,
      ariaValueText: splitterNode ? splitterNode.getAttribute("aria-valuetext") : "",
    };
  });

  expect(afterEnd.leftWidth).toBeGreaterThan(afterHome.leftWidth + 100);
  expect(afterEnd.ariaValueNow).toBeGreaterThan(afterHome.ariaValueNow);
  expect(afterEnd.ariaValueText).toContain("% file list width");

  await page.keyboard.press("0");
  const afterReset = await page.evaluate(() => {
    const left = document.querySelector(".left");
    const splitterNode = document.getElementById("splitter");
    return {
      leftWidth: left ? left.getBoundingClientRect().width : 0,
      ariaValueNow: splitterNode ? Number(splitterNode.getAttribute("aria-valuenow") || 0) : 0,
      storedRatio: window.localStorage.getItem("git-snapshot.gui.split.left-ratio.v1"),
    };
  });

  expect(Math.abs(afterReset.leftWidth - before.leftWidth)).toBeLessThan(30);
  expect(Math.abs(afterReset.ariaValueNow - before.ariaValueNow)).toBeLessThanOrEqual(2);
  expect(afterReset.storedRatio).toBeTruthy();
});
