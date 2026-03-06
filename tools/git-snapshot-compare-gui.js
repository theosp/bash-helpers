#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

class CompareGuiError extends Error {}

const UNKNOWN_COMPARE_ROW_ERROR = "File is not part of the currently cached compare rows. Click Refresh.";
const FORCE_COMPARE_DATA_FAILURE = process.env.GIT_SNAPSHOT_GUI_TEST_FAIL_DATA === "1";
const MELD_ACTIVATE_RETRIES = 30;
const MELD_ACTIVATE_DELAY_SECONDS = 0.1;
const SERVER_SHUTDOWN_GRACE_MS = 400;

function parseArgs(argv) {
  const out = {
    rootRepo: "",
    snapshotId: "",
    selectionMode: "",
    repoFilter: "",
    showAll: "",
    gitSnapshotBin: "",
  };

  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--")) {
      throw new CompareGuiError(`Unexpected argument: ${key}`);
    }
    if (value === undefined) {
      throw new CompareGuiError(`Missing value for ${key}`);
    }
    i += 1;
    if (key === "--root-repo") out.rootRepo = value;
    else if (key === "--snapshot-id") out.snapshotId = value;
    else if (key === "--selection-mode") out.selectionMode = value;
    else if (key === "--repo-filter") out.repoFilter = value;
    else if (key === "--show-all") out.showAll = value;
    else if (key === "--git-snapshot-bin") out.gitSnapshotBin = value;
    else throw new CompareGuiError(`Unknown option: ${key}`);
  }

  if (!out.rootRepo) throw new CompareGuiError("Missing --root-repo");
  if (!out.snapshotId) throw new CompareGuiError("Missing --snapshot-id");
  if (!out.selectionMode) throw new CompareGuiError("Missing --selection-mode");
  if (!out.gitSnapshotBin) throw new CompareGuiError("Missing --git-snapshot-bin");
  if (out.showAll !== "true" && out.showAll !== "false") {
    throw new CompareGuiError("--show-all must be true or false");
  }
  return out;
}

function run(cmd, args, opts) {
  const proc = spawnSync(cmd, args, Object.assign({ encoding: "utf8" }, opts || {}));
  return proc;
}

function parsePorcelain(stdoutText) {
  const target = {};
  const rows = [];
  const summary = {};

  for (const rawLine of stdoutText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split("\t");
    const kind = parts[0];
    const fields = {};
    for (const kv of parts.slice(1)) {
      const eq = kv.indexOf("=");
      if (eq === -1) continue;
      const key = kv.slice(0, eq);
      const value = kv.slice(eq + 1);
      fields[key] = value;
    }
    if (kind === "compare_target") target.selected = fields;
    else if (kind === "compare_file") rows.push(fields);
    else if (kind === "compare_summary") summary.value = fields;
  }

  return {
    targetFields: target.selected || {},
    rows: rows,
    summaryFields: summary.value || {},
  };
}

function rowKey(repoRel, filePath) {
  return `${repoRel}\t${filePath}`;
}

function findCompareRow(data, repoRel, filePath) {
  const rows = data && Array.isArray(data.rows) ? data.rows : [];
  const key = rowKey(repoRel, filePath);
  return rows.find((row) => rowKey(row.repo || "", row.file || "") === key) || null;
}

function loadCompareData(args) {
  if (FORCE_COMPARE_DATA_FAILURE) {
    throw new CompareGuiError("Forced compare data load failure for test.");
  }

  const cmd = [args.gitSnapshotBin, "compare", args.snapshotId, "--porcelain"];
  if (args.repoFilter) cmd.push("--repo", args.repoFilter);
  if (args.showAll === "true") cmd.push("--all");

  const proc = run(cmd[0], cmd.slice(1), { encoding: "utf8" });
  if (proc.status !== 0) {
    throw new CompareGuiError(
      `Failed to load compare data (exit ${proc.status}).\n${(proc.stderr || proc.stdout || "").trim()}`
    );
  }
  return parsePorcelain(proc.stdout || "");
}

function loadReposMap(snapshotDir) {
  const reposTsv = path.join(snapshotDir, "repos.tsv");
  if (!fs.existsSync(reposTsv)) {
    throw new CompareGuiError(`Snapshot metadata missing: ${reposTsv}`);
  }
  const reposMap = {};
  const text = fs.readFileSync(reposTsv, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    reposMap[parts[1]] = { repoId: parts[0], snapshotHead: parts[2] };
  }
  return reposMap;
}

function repoWorktreeExists(repoAbs) {
  const proc = run("git", ["-C", repoAbs, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return proc.status === 0;
}

function isBinary(buf) {
  return buf && buf.includes(0);
}

function repoComponent(repoRel) {
  return repoRel === "." ? "__root__" : repoRel;
}

function rmRf(targetPath) {
  if (!fs.existsSync(targetPath)) return;
  if (fs.rmSync) {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return;
  }
  if (fs.lstatSync(targetPath).isDirectory()) {
    for (const entry of fs.readdirSync(targetPath)) {
      rmRf(path.join(targetPath, entry));
    }
    fs.rmdirSync(targetPath);
  } else {
    fs.unlinkSync(targetPath);
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function isPathInside(basePath, targetPath) {
  const relativePath = path.relative(basePath, targetPath);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

function resolveContainedPath(basePath, childPath, label) {
  const resolvedBase = path.resolve(basePath);
  const resolvedTarget = path.resolve(resolvedBase, childPath || ".");
  if (!isPathInside(resolvedBase, resolvedTarget)) {
    throw new CompareGuiError(`${label} escapes ${resolvedBase}.`);
  }
  return resolvedTarget;
}

class SnapshotFileResolver {
  constructor(rootRepo, snapshotId) {
    this.rootRepo = path.resolve(rootRepo);
    this.snapshotId = snapshotId;
    this.snapshotDir = path.join(os.homedir(), "git-snapshots", path.basename(this.rootRepo), snapshotId);
    this.reposMap = loadReposMap(this.snapshotDir);
    this.sessionDir = path.join(os.tmpdir(), `git-snapshot-gui.${process.pid}`);
    this.snapshotFilesDir = path.join(this.sessionDir, "snapshot-files");
    this.repoWorkDir = path.join(this.sessionDir, "repo-work");
    ensureDir(this.snapshotFilesDir);
    ensureDir(this.repoWorkDir);
  }

  materializeSnapshotFile(repoRel, filePath) {
    const repoMeta = this.reposMap[repoRel];
    if (!repoMeta) {
      throw new CompareGuiError(`Repo [${repoRel}] not found in snapshot metadata.`);
    }

    const repoAbs = resolveContainedPath(this.rootRepo, repoRel || ".", `Repo path for [${repoRel || "."}]`);
    if (!repoWorktreeExists(repoAbs)) {
      throw new CompareGuiError(
        `Repo path missing in working tree: ${repoAbs}\nRestore/check out repo and refresh.`
      );
    }

    const repoPart = repoComponent(repoRel);
    const tempRepo = resolveContainedPath(this.repoWorkDir, repoPart, `Compare workspace for repo [${repoRel}]`);
    rmRf(tempRepo);
    ensureDir(tempRepo);

    const initProc = run("git", ["-C", tempRepo, "init", "-q"], { encoding: "utf8" });
    if (initProc.status !== 0) {
      throw new CompareGuiError(`Failed to initialize compare workspace for ${repoRel}.`);
    }

    const tempRepoFile = resolveContainedPath(tempRepo, filePath, `Snapshot temp file for repo [${repoRel}]`);
    ensureDir(path.dirname(tempRepoFile));

    const showProc = spawnSync("git", ["-C", repoAbs, "show", `${repoMeta.snapshotHead}:${filePath}`], {
      encoding: null,
    });
    if (showProc.status === 0 && showProc.stdout) {
      fs.writeFileSync(tempRepoFile, showProc.stdout);
    }

    const patchBase = path.join(this.snapshotDir, "repos", repoMeta.repoId);
    for (const patchName of ["staged.patch", "unstaged.patch"]) {
      const patchPath = path.join(patchBase, patchName);
      if (!fs.existsSync(patchPath)) continue;
      const stat = fs.statSync(patchPath);
      if (stat.size === 0) continue;
      run("git", ["-C", tempRepo, "apply", "--unsafe-paths", `--include=${filePath}`, patchPath], {
        encoding: "utf8",
      });
    }

    const snapshotRepoDir = resolveContainedPath(
      this.snapshotFilesDir,
      repoPart,
      `Snapshot output directory for repo [${repoRel}]`
    );
    const snapshotOut = resolveContainedPath(
      snapshotRepoDir,
      filePath,
      `Snapshot output path for repo [${repoRel}]`
    );
    ensureDir(path.dirname(snapshotOut));
    if (fs.existsSync(tempRepoFile)) {
      fs.copyFileSync(tempRepoFile, snapshotOut);
    } else {
      fs.writeFileSync(snapshotOut, "", "utf8");
    }
    return snapshotOut;
  }

  currentFilePath(repoRel, filePath) {
    const repoAbs = resolveContainedPath(this.rootRepo, repoRel || ".", `Repo path for [${repoRel || "."}]`);
    return resolveContainedPath(repoAbs, filePath, `Current file path for repo [${repoRel}]`);
  }
}

function buildUnifiedDiff(currentFile, snapshotFile, relFilePath) {
  const currentBytes = fs.existsSync(currentFile) ? fs.readFileSync(currentFile) : Buffer.alloc(0);
  const snapshotBytes = fs.existsSync(snapshotFile) ? fs.readFileSync(snapshotFile) : Buffer.alloc(0);

  if (isBinary(currentBytes) || isBinary(snapshotBytes)) {
    return "Binary/non-text diff preview unavailable; use external tool.";
  }

  const proc = run("git", ["--no-pager", "diff", "--no-index", "--no-color", "--", currentFile, snapshotFile], {
    encoding: "utf8",
  });
  if (proc.status !== 0 && proc.status !== 1) {
    const msg = (proc.stderr || proc.stdout || "").trim();
    return `Diff generation failed: ${msg || "unknown error"}`;
  }
  const out = proc.stdout || "";
  if (!out.trim()) {
    return `No textual differences. (${relFilePath})`;
  }
  return out;
}

function detectExternalDiffTool() {
  const forcedTool = process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL || "";
  if (forcedTool) return forcedTool;

  for (const candidate of ["meld", "opendiff", "code"]) {
    const check = run("which", [candidate], { encoding: "utf8" });
    if (check.status === 0) return candidate;
  }
  return "";
}

function recordExternalDiffLaunch(tool, snapshotFile, currentFile) {
  const logFile = process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG || "";
  if (!logFile) return false;

  ensureDir(path.dirname(logFile));
  fs.appendFileSync(
    logFile,
    `tool=${tool}\nsnapshot_file=${snapshotFile}\ncurrent_file=${currentFile}\nplatform=${process.platform}\n\n`,
    "utf8"
  );
  return true;
}

function recordDetachedSpawn(command, args, childPid) {
  const logFile = process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG || "";
  if (!logFile) return;

  ensureDir(path.dirname(logFile));
  const argsText = Array.isArray(args)
    ? args.map((arg, index) => `arg_${index}=${arg}`).join("\n")
    : "";

  fs.appendFileSync(
    logFile,
    `command=${command}\nchild_pid=${childPid}\ndetached=true\n${argsText}\n\n`,
    "utf8"
  );
}

function spawnDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  recordDetachedSpawn(command, args, child.pid);
  child.unref();
  return child;
}

function activateMeldForegroundMac() {
  if (process.platform !== "darwin") return;
  const script =
    `repeat ${MELD_ACTIVATE_RETRIES} times\n` +
    '  try\n' +
    '    tell application "Meld" to activate\n' +
    "    return\n" +
    "  end try\n" +
    `  delay ${MELD_ACTIVATE_DELAY_SECONDS}\n` +
    "end repeat";
  spawnDetached("osascript", ["-e", script]);
}

function launchExternalDiff(tool, snapshotFile, currentFile) {
  const args = tool === "code" ? ["--diff", snapshotFile, currentFile] : [snapshotFile, currentFile];

  if (recordExternalDiffLaunch(tool, snapshotFile, currentFile)) {
    return;
  }

  // Launch the external tool in its own process group so stopping compare --gui
  // does not also terminate the opened diff application.
  spawnDetached(tool, args);

  if (tool === "meld" && process.platform === "darwin") {
    activateMeldForegroundMac();
  }
}

function json(res, code, data) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(data));
}

function text(res, code, body) {
  res.statusCode = code;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function htmlPage() {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>git-snapshot compare --gui</title>
  <style>
    :root { --bg: #f7f6f2; --panel: #fffefb; --ink: #1f1f1a; --muted: #6b6a62; --line: #d9d6c8; --accent: #1f6f5f; }
    * { box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; }
    body {
      margin: 0;
      min-height: 100vh;
      overflow: hidden;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      background: linear-gradient(120deg, #f3f1e8, #ecebe4);
      color: var(--ink);
      font: 14px/1.4 Menlo, Monaco, Consolas, monospace;
    }
    .top { padding: 10px 14px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.7); backdrop-filter: blur(4px); }
    .title { font-weight: 700; }
    .meta, .summary { color: var(--muted); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .actions { margin-top: 8px; display: flex; gap: 8px; }
    .actions button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 7px 10px; cursor: pointer; font: inherit; }
    .actions button:disabled { opacity: 0.45; cursor: not-allowed; }
    .main { display: grid; grid-template-columns: minmax(260px, 38%) minmax(0, 1fr); min-height: 0; overflow: hidden; }
    .left { border-right: 1px solid var(--line); overflow: auto; min-height: 0; background: var(--panel); }
    .right { overflow: auto; min-height: 0; padding: 10px; }
    .repo { padding: 8px 10px; font-weight: 700; border-top: 1px solid var(--line); background: #f5f3ea; }
    .row {
      display: block;
      width: 100%;
      padding: 6px 10px;
      color: var(--ink);
      background: transparent;
      border: 0;
      border-top: 1px dashed #ece9dd;
      text-align: left;
      cursor: pointer;
      font: inherit;
    }
    .row:hover { background: #f0eee3; }
    .row.active { background: #e5f2ef; border-left: 3px solid var(--accent); padding-left: 7px; }
    .row:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
    .status { color: var(--muted); }
    .loading { color: var(--muted); font-style: italic; }
    .error { color: #8a2b2b; }
    pre { margin: 0; white-space: pre; }
    .empty { color: var(--muted); padding: 10px; }
    @media (max-width: 700px) {
      .top { padding: 10px 12px; }
      .meta, .summary { white-space: normal; }
      .actions { flex-wrap: wrap; }
      .main {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(180px, 38vh) minmax(0, 1fr);
      }
      .left {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .right { padding: 8px; }
    }
  </style>
</head>
<body>
  <div class="top">
    <div class="title">git-snapshot compare --gui (Node)</div>
    <div id="meta" class="meta"></div>
    <div id="summary" class="summary"></div>
    <div class="actions">
      <button id="refresh">Refresh</button>
      <button id="openExternal" disabled>Open External Diff</button>
    </div>
  </div>
  <div class="main">
    <div id="list" class="left" role="group" aria-label="Compare rows"></div>
    <div class="right"><pre id="diff">Select a file to preview diff.</pre></div>
  </div>
  <script>
    const listEl = document.getElementById("list");
    const diffEl = document.getElementById("diff");
    const metaEl = document.getElementById("meta");
    const summaryEl = document.getElementById("summary");
    const refreshBtn = document.getElementById("refresh");
    const openBtn = document.getElementById("openExternal");
    let rows = [];
    let selected = null;
    let diffCache = new Map();
    let selectionToken = 0;
    let emptyStateMessage = "No rows to display.";

    function cacheKey(repo, file) {
      return String(repo || "") + "\\t" + String(file || "");
    }

    function rowButtons() {
      return Array.from(listEl.querySelectorAll(".row"));
    }

    function setActiveRow(rowNode) {
      for (const node of rowButtons()) {
        const isActive = node === rowNode;
        node.classList.toggle("active", isActive);
        node.setAttribute("aria-selected", isActive ? "true" : "false");
      }
    }

    function focusRowByIndex(index) {
      const nodes = rowButtons();
      if (!nodes.length) return;

      const boundedIndex = Math.max(0, Math.min(nodes.length - 1, index));
      const nextRow = nodes[boundedIndex];
      if (!nextRow) return;

      nextRow.focus();
      nextRow.click();
    }

    function handleRowKeydown(event, rowNode) {
      const nodes = rowButtons();
      const currentIndex = nodes.indexOf(rowNode);
      if (currentIndex === -1) return;

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          focusRowByIndex(currentIndex + 1);
          break;
        case "ArrowUp":
          event.preventDefault();
          focusRowByIndex(currentIndex - 1);
          break;
        case "Home":
          event.preventDefault();
          focusRowByIndex(0);
          break;
        case "End":
          event.preventDefault();
          focusRowByIndex(nodes.length - 1);
          break;
        default:
          break;
      }
    }

    function setDiffLoading(row) {
      diffEl.classList.add("loading");
      diffEl.textContent = "Loading diff for " + (row.repo || "") + "/" + (row.file || "") + "...";
    }

    function setDiffText(text) {
      diffEl.classList.remove("loading");
      diffEl.textContent = text;
    }

    function setListMessage(message, className) {
      listEl.innerHTML = "";
      const node = document.createElement("div");
      node.className = className || "empty";
      node.textContent = String(message || "");
      listEl.appendChild(node);
    }

    function setListLoading(message) {
      setListMessage(message || "Loading...", "empty loading");
    }

    function setListError(message) {
      setListMessage(message || "Failed to load compare rows.", "empty error");
    }

    function renderLoadFailure(error) {
      const message = error && error.message ? error.message : String(error);
      rows = [];
      selected = null;
      diffCache = new Map();
      selectionToken += 1;
      emptyStateMessage = "No rows to display.";
      openBtn.disabled = true;
      metaEl.textContent = "Compare data unavailable.";
      summaryEl.textContent = message;
      setListError("Failed to load compare rows: " + message);
      setDiffText("Unable to load compare rows.");
    }

    async function loadData(forceRefresh) {
      setListLoading("Loading compare rows...");
      setDiffText("Loading compare rows...");
      const suffix = forceRefresh ? "?force=1" : "";
      const res = await fetch("/api/data" + suffix);
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load compare data.");
      }
      rows = data.rows || [];
      diffCache = new Map();
      selectionToken += 1;
      const t = data.targetFields || {};
      const s = data.summaryFields || {};
      metaEl.textContent = "Snapshot: " + (t.selected_snapshot_id || "?") +
        " | Mode: " + (t.selection_mode || "?") +
        " | Repo filter: " + (data.repoFilter || "(all)") +
        " | Rows: " + (data.showAll === "true" ? "all statuses" : "unresolved only");
      summaryEl.textContent = "repos_checked=" + (s.repos_checked || "?") +
        " files_total=" + (s.files_total || "?") +
        " unresolved_total=" + (s.unresolved_total || "?") +
        " shown_files=" + (s.shown_files || "?");
      const unresolvedTotal = Number(s.unresolved_total || 0);
      const filesTotal = Number(s.files_total || 0);
      if (!rows.length && data.showAll !== "true" && unresolvedTotal === 0 && filesTotal > 0) {
        emptyStateMessage = "No unresolved rows. Relaunch with --all to include resolved rows.";
      } else {
        emptyStateMessage = "No rows to display.";
      }
      selected = null;
      openBtn.disabled = true;
      setDiffText(rows.length ? "Select a file to preview diff." : "No rows to display for current visibility filter.");
      renderList();
    }

    function renderList() {
      listEl.innerHTML = "";
      if (!rows.length) {
        listEl.innerHTML = "<div class='empty'>" + emptyStateMessage + "</div>";
        return;
      }
      const grouped = {};
      for (const row of rows) {
        const repo = row.repo || "";
        if (!grouped[repo]) grouped[repo] = [];
        grouped[repo].push(row);
      }
      for (const repo of Object.keys(grouped)) {
        const repoNode = document.createElement("div");
        repoNode.className = "repo";
        repoNode.textContent = repo;
        listEl.appendChild(repoNode);
        for (const row of grouped[repo]) {
          const rowNode = document.createElement("button");
          rowNode.type = "button";
          rowNode.className = "row";
          rowNode.setAttribute("aria-selected", "false");
          rowNode.textContent = (row.file || "(unknown)") + " [" + (row.status || "") + "]";
          rowNode.onclick = () => selectRow(row, rowNode);
          rowNode.onkeydown = (event) => handleRowKeydown(event, rowNode);
          listEl.appendChild(rowNode);
        }
      }
    }

    async function selectRow(row, rowNode) {
      setActiveRow(rowNode);
      selected = row;
      openBtn.disabled = false;
      const key = cacheKey(row.repo, row.file);
      if (diffCache.has(key)) {
        setDiffText(diffCache.get(key));
        return;
      }

      setDiffLoading(row);
      const token = selectionToken + 1;
      selectionToken = token;
      const q = new URLSearchParams({ repo: row.repo || "", file: row.file || "" });
      const res = await fetch("/api/diff?" + q.toString());
      const text = await res.text();
      if (token !== selectionToken) return;
      if (!res.ok) {
        setDiffText(text || "Failed to load diff preview.");
        return;
      }
      diffCache.set(key, text);
      setDiffText(text);
    }

    async function openExternal() {
      if (!selected) return;
      const q = new URLSearchParams({ repo: selected.repo || "", file: selected.file || "" });
      const res = await fetch("/api/open?" + q.toString(), { method: "POST" });
      const data = await res.json();
      if (!data.ok) alert(data.error || "Failed to open external diff.");
    }

    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      openBtn.disabled = true;
      try {
        await loadData(true);
      } catch (err) {
        renderLoadFailure(err);
      } finally {
        refreshBtn.disabled = false;
      }
    };
    openBtn.onclick = () => openExternal().catch(err => alert(String(err)));
    loadData(false).catch(err => { renderLoadFailure(err); });
  </script>
</body>
</html>`;
}

function launchBrowser(url) {
  for (const cmd of ["open", "xdg-open"]) {
    const proc = run("which", [cmd], { encoding: "utf8" });
    if (proc.status !== 0) continue;
    const openProc = run(cmd, [url], { encoding: "utf8" });
    if (openProc.status === 0) return cmd;
  }
  return "";
}

function runTestMode(args) {
  const compareData = loadCompareData(args);
  const resolver = new SnapshotFileResolver(args.rootRepo, args.snapshotId);
  if (compareData.rows.length > 0) {
    const row = compareData.rows[0];
    const repoRel = row.repo || "";
    const filePath = row.file || "";
    if (repoRel && filePath) {
      try {
        const snapshotFile = resolver.materializeSnapshotFile(repoRel, filePath);
        const currentFile = resolver.currentFilePath(repoRel, filePath);
        buildUnifiedDiff(currentFile, snapshotFile, filePath);
      } catch (_err) {
        // Ignore in test mode; parity with prior behavior.
      }
    }
  }
  console.log(`GUI_TEST snapshot_id=${args.snapshotId} rows=${compareData.rows.length} show_all=${args.showAll}`);
  return 0;
}

function startServer(args) {
  const resolver = new SnapshotFileResolver(args.rootRepo, args.snapshotId);
  const sockets = new Set();
  const state = {
    compareData: null,
    compareLoadedAt: 0,
    diffCache: new Map(),
  };

  function refreshCompareCache() {
    const startedAt = Date.now();
    console.log("Loading compare data...");
    state.compareData = loadCompareData(args);
    state.compareLoadedAt = Date.now();
    state.diffCache.clear();
    const elapsedMs = state.compareLoadedAt - startedAt;
    const rowCount = (state.compareData && Array.isArray(state.compareData.rows)) ? state.compareData.rows.length : 0;
    console.log(`Compare data loaded in ${elapsedMs}ms (rows=${rowCount}).`);
    return state.compareData;
  }

  function getCompareCache() {
    if (!state.compareData) return refreshCompareCache();
    return state.compareData;
  }

  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(htmlPage());
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/data") {
        const forceRefresh = url.searchParams.get("force") === "1";
        const data = forceRefresh ? refreshCompareCache() : getCompareCache();
        json(res, 200, {
          targetFields: data.targetFields,
          rows: data.rows,
          summaryFields: data.summaryFields,
          repoFilter: args.repoFilter,
          showAll: args.showAll,
          cacheLoadedAt: state.compareLoadedAt,
        });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/diff") {
        const repoRel = url.searchParams.get("repo") || "";
        const filePath = url.searchParams.get("file") || "";
        if (!repoRel || !filePath) {
          text(res, 400, "Missing repo/file query parameters.");
          return;
        }
        const data = getCompareCache();
        const knownRow = findCompareRow(data, repoRel, filePath);
        if (!knownRow) {
          text(res, 404, UNKNOWN_COMPARE_ROW_ERROR);
          return;
        }
        const key = rowKey(knownRow.repo || "", knownRow.file || "");
        const cached = state.diffCache.get(key);
        if (cached) {
          text(res, 200, cached.diffText);
          return;
        }

        const snapshotFile = resolver.materializeSnapshotFile(repoRel, filePath);
        const currentFile = resolver.currentFilePath(repoRel, filePath);
        const diffText = buildUnifiedDiff(currentFile, snapshotFile, filePath);
        state.diffCache.set(key, {
          diffText: diffText,
          snapshotFile: snapshotFile,
          currentFile: currentFile,
        });
        text(res, 200, diffText);
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/open") {
        const repoRel = url.searchParams.get("repo") || "";
        const filePath = url.searchParams.get("file") || "";
        if (!repoRel || !filePath) {
          json(res, 400, { ok: false, error: "Missing repo/file query parameters." });
          return;
        }
        const data = getCompareCache();
        const knownRow = findCompareRow(data, repoRel, filePath);
        if (!knownRow) {
          json(res, 404, { ok: false, error: UNKNOWN_COMPARE_ROW_ERROR });
          return;
        }
        const tool = detectExternalDiffTool();
        if (!tool) {
          json(res, 200, { ok: false, error: "No external diff tool found. Install meld, opendiff, or code." });
          return;
        }
        const key = rowKey(knownRow.repo || "", knownRow.file || "");
        let cached = state.diffCache.get(key);
        if (!cached) {
          const snapshotFile = resolver.materializeSnapshotFile(knownRow.repo || "", knownRow.file || "");
          const currentFile = resolver.currentFilePath(knownRow.repo || "", knownRow.file || "");
          cached = {
            diffText: "",
            snapshotFile: snapshotFile,
            currentFile: currentFile,
          };
          state.diffCache.set(key, cached);
        }
        const snapshotFile = cached.snapshotFile;
        const currentFile = cached.currentFile;
        ensureDir(path.dirname(currentFile));
        if (!fs.existsSync(currentFile)) fs.writeFileSync(currentFile, "", "utf8");
        launchExternalDiff(tool, snapshotFile, currentFile);
        json(res, 200, { ok: true, tool: tool });
        return;
      }

      text(res, 404, "Not found");
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (req.url && req.url.indexOf("/api/") === 0) {
        json(res, 500, { ok: false, error: msg });
      } else {
        text(res, 500, msg);
      }
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && addr.port ? addr.port : 0;
      if (!port) {
        reject(new CompareGuiError("Failed to allocate GUI server port."));
        return;
      }
      const url = `http://127.0.0.1:${port}/`;
      console.log(`Compare GUI server: ${url}`);
      if (process.env.GIT_SNAPSHOT_GUI_NO_BROWSER === "1") {
        console.log("Browser launch skipped by GIT_SNAPSHOT_GUI_NO_BROWSER=1.");
      } else {
        const opener = launchBrowser(url);
        if (opener) console.log(`Opened in browser via: ${opener}`);
        else console.log("Open URL manually in a browser.");
      }
      console.log(`Press Ctrl-C to stop the GUI server.`);
      resolve({ server, sockets });
    });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (process.env.GIT_SNAPSHOT_GUI_FORCE_ABORT === "1") {
    process.abort();
  }
  if (process.env.GIT_SNAPSHOT_GUI_TEST_MODE === "1") {
    process.exit(runTestMode(args));
    return;
  }

  const runtime = await startServer(args);
  let shuttingDown = false;
  let shutdownTimer = null;

  function shutdown(exitCode) {
    if (shuttingDown) {
      for (const socket of runtime.sockets) socket.destroy();
      process.exit(exitCode);
      return;
    }
    shuttingDown = true;

    runtime.server.close(() => process.exit(exitCode));
    for (const socket of runtime.sockets) socket.destroy();

    shutdownTimer = setTimeout(() => process.exit(exitCode), SERVER_SHUTDOWN_GRACE_MS);
    if (shutdownTimer && typeof shutdownTimer.unref === "function") {
      shutdownTimer.unref();
    }
  }

  process.on("SIGINT", () => shutdown(130));
  process.on("SIGTERM", () => shutdown(143));
}

main().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
