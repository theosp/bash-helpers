#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

class CompareGuiError extends Error {}

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

function loadCompareData(args) {
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

    const repoAbs = path.join(this.rootRepo, repoRel);
    if (!repoWorktreeExists(repoAbs)) {
      throw new CompareGuiError(
        `Repo path missing in working tree: ${repoAbs}\nRestore/check out repo and refresh.`
      );
    }

    const repoPart = repoComponent(repoRel);
    const tempRepo = path.join(this.repoWorkDir, repoPart);
    rmRf(tempRepo);
    ensureDir(tempRepo);

    const initProc = run("git", ["-C", tempRepo, "init", "-q"], { encoding: "utf8" });
    if (initProc.status !== 0) {
      throw new CompareGuiError(`Failed to initialize compare workspace for ${repoRel}.`);
    }

    const tempRepoFile = path.join(tempRepo, filePath);
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

    const snapshotOut = path.join(this.snapshotFilesDir, repoPart, filePath);
    ensureDir(path.dirname(snapshotOut));
    if (fs.existsSync(tempRepoFile)) {
      fs.copyFileSync(tempRepoFile, snapshotOut);
    } else {
      fs.writeFileSync(snapshotOut, "", "utf8");
    }
    return snapshotOut;
  }

  currentFilePath(repoRel, filePath) {
    return path.join(this.rootRepo, repoRel, filePath);
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
  for (const candidate of ["meld", "opendiff", "code"]) {
    const check = run("which", [candidate], { encoding: "utf8" });
    if (check.status === 0) return candidate;
  }
  return "";
}

function launchExternalDiff(tool, snapshotFile, currentFile) {
  const args = tool === "code" ? ["--diff", snapshotFile, currentFile] : [snapshotFile, currentFile];
  const child = spawn(tool, args, { detached: true, stdio: "ignore" });
  child.unref();
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
    body { margin: 0; background: linear-gradient(120deg, #f3f1e8, #ecebe4); color: var(--ink); font: 14px/1.4 Menlo, Monaco, Consolas, monospace; }
    .top { padding: 10px 14px; border-bottom: 1px solid var(--line); background: rgba(255,255,255,0.7); position: sticky; top: 0; backdrop-filter: blur(4px); }
    .title { font-weight: 700; }
    .meta, .summary { color: var(--muted); margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .actions { margin-top: 8px; display: flex; gap: 8px; }
    button { background: var(--accent); color: #fff; border: 0; border-radius: 6px; padding: 7px 10px; cursor: pointer; font: inherit; }
    button:disabled { opacity: 0.45; cursor: not-allowed; }
    .main { display: grid; grid-template-columns: minmax(260px, 38%) 1fr; height: calc(100vh - 115px); }
    .left { border-right: 1px solid var(--line); overflow: auto; background: var(--panel); }
    .right { overflow: auto; padding: 10px; }
    .repo { padding: 8px 10px; font-weight: 700; border-top: 1px solid var(--line); background: #f5f3ea; }
    .row { padding: 6px 10px; cursor: pointer; border-top: 1px dashed #ece9dd; }
    .row:hover { background: #f0eee3; }
    .row.active { background: #e5f2ef; border-left: 3px solid var(--accent); padding-left: 7px; }
    .status { color: var(--muted); }
    .loading { color: var(--muted); font-style: italic; }
    pre { margin: 0; white-space: pre; min-height: 100%; }
    .empty { color: var(--muted); padding: 10px; }
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
    <div id="list" class="left"></div>
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

    function cacheKey(repo, file) {
      return String(repo || "") + "\\t" + String(file || "");
    }

    function setDiffLoading(row) {
      diffEl.classList.add("loading");
      diffEl.textContent = "Loading diff for " + (row.repo || "") + "/" + (row.file || "") + "...";
    }

    function setDiffText(text) {
      diffEl.classList.remove("loading");
      diffEl.textContent = text;
    }

    async function loadData(forceRefresh) {
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
      selected = null;
      openBtn.disabled = true;
      setDiffText(rows.length ? "Select a file to preview diff." : "No rows to display for current visibility filter.");
      renderList();
    }

    function renderList() {
      listEl.innerHTML = "";
      if (!rows.length) {
        listEl.innerHTML = "<div class='empty'>No rows to display.</div>";
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
          const rowNode = document.createElement("div");
          rowNode.className = "row";
          rowNode.textContent = (row.file || "(unknown)") + " [" + (row.status || "") + "]";
          rowNode.onclick = () => selectRow(row, rowNode);
          listEl.appendChild(rowNode);
        }
      }
    }

    async function selectRow(row, rowNode) {
      for (const node of listEl.querySelectorAll(".row.active")) node.classList.remove("active");
      rowNode.classList.add("active");
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
        alert(String(err));
      } finally {
        refreshBtn.disabled = false;
      }
    };
    openBtn.onclick = () => openExternal().catch(err => alert(String(err)));
    loadData(false).catch(err => { setDiffText(String(err)); });
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
  const state = {
    compareData: null,
    compareLoadedAt: 0,
    diffCache: new Map(),
  };

  function refreshCompareCache() {
    state.compareData = loadCompareData(args);
    state.compareLoadedAt = Date.now();
    state.diffCache.clear();
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
        const key = rowKey(repoRel, filePath);
        const known = data.rows.some((row) => rowKey(row.repo || "", row.file || "") === key);
        if (!known) {
          text(res, 404, "File is not part of the currently cached compare rows. Click Refresh.");
          return;
        }
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
        const tool = detectExternalDiffTool();
        if (!tool) {
          json(res, 200, { ok: false, error: "No external diff tool found. Install meld, opendiff, or code." });
          return;
        }
        const key = rowKey(repoRel, filePath);
        let cached = state.diffCache.get(key);
        if (!cached) {
          const snapshotFile = resolver.materializeSnapshotFile(repoRel, filePath);
          const currentFile = resolver.currentFilePath(repoRel, filePath);
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
      const opener = launchBrowser(url);
      console.log(`Compare GUI server: ${url}`);
      if (opener) console.log(`Opened in browser via: ${opener}`);
      else console.log(`Open URL manually in a browser.`);
      console.log(`Press Ctrl-C to stop the GUI server.`);
      resolve(server);
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

  const server = await startServer(args);
  process.on("SIGINT", () => {
    server.close(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    server.close(() => process.exit(143));
  });
}

main().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});
