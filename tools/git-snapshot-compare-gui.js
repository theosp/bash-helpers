#!/usr/bin/env node

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

class SnapshotGuiError extends Error {}

const UNKNOWN_COMPARE_ROW_ERROR = "File is not part of the currently cached compare rows. Click Refresh.";
const UNKNOWN_INSPECT_ROW_ERROR = "File is not part of the currently cached inspect rows. Click Refresh.";
const FORCE_COMPARE_DATA_FAILURE = process.env.GIT_SNAPSHOT_GUI_TEST_FAIL_DATA === "1";
const MELD_ACTIVATE_RETRIES = 30;
const MELD_ACTIVATE_DELAY_SECONDS = 0.1;
const SERVER_SHUTDOWN_GRACE_MS = 400;
const INSPECT_CATEGORY_ORDER = ["staged", "unstaged", "untracked"];
const DEFAULT_EXTERNAL_DIFF_CANDIDATES = ["meld", "kdiff3", "opendiff", "bcompare", "code"];
const EXTERNAL_DIFF_SOURCE_PATTERNS = [/\$\{SOURCE\}/g, /\$SOURCE/g];
const EXTERNAL_DIFF_TARGET_PATTERNS = [/\$\{TARGET\}/g, /\$TARGET/g];
const DEFAULT_GUI_PORT_START = 34757;
const DEFAULT_GUI_PORT_COUNT = 32;

function parseDelayMs(rawValue) {
  const parsed = Number(rawValue || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

const TEST_COMPARE_DATA_DELAY_MS = parseDelayMs(process.env.GIT_SNAPSHOT_GUI_TEST_COMPARE_DATA_DELAY_MS);
const TEST_INSPECT_DATA_DELAY_MS = parseDelayMs(process.env.GIT_SNAPSHOT_GUI_TEST_INSPECT_DATA_DELAY_MS);

function parseBooleanArg(value, label) {
  if (value !== "true" && value !== "false") {
    throw new SnapshotGuiError(`${label} must be true or false`);
  }
  return value;
}

function parsePositiveIntegerSetting(rawValue, fallback, label) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return fallback;
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new SnapshotGuiError(`${label} must be a positive integer.`);
  }
  return parsed;
}

function guiPortBindingConfig() {
  const start = parsePositiveIntegerSetting(
    process.env.GIT_SNAPSHOT_GUI_PORT_START,
    DEFAULT_GUI_PORT_START,
    "GIT_SNAPSHOT_GUI_PORT_START"
  );
  const count = parsePositiveIntegerSetting(
    process.env.GIT_SNAPSHOT_GUI_PORT_COUNT,
    DEFAULT_GUI_PORT_COUNT,
    "GIT_SNAPSHOT_GUI_PORT_COUNT"
  );
  if (start > 65535) {
    throw new SnapshotGuiError("GIT_SNAPSHOT_GUI_PORT_START must be 65535 or lower.");
  }
  if (start + count - 1 > 65535) {
    throw new SnapshotGuiError(
      `Configured GUI port range exceeds 65535: start=${start}, count=${count}.`
    );
  }
  return {
    start,
    count,
    end: start + count - 1,
  };
}

function listenOnPreferredPortRange(server, host, startPort, portCount) {
  return new Promise((resolve, reject) => {
    let nextPort = startPort;
    const finalPort = startPort + portCount - 1;

    const attemptListen = () => {
      if (nextPort > finalPort) {
        reject(new SnapshotGuiError(
          `Failed to bind GUI server on ${host} within preferred port range ${startPort}-${finalPort}.`
        ));
        return;
      }

      const port = nextPort;
      nextPort += 1;

      const cleanup = () => {
        server.off("error", onError);
        server.off("listening", onListening);
      };

      const onError = (err) => {
        cleanup();
        if (err && err.code === "EADDRINUSE") {
          attemptListen();
          return;
        }
        reject(err);
      };

      const onListening = () => {
        cleanup();
        resolve(port);
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, host);
    };

    attemptListen();
  });
}

function parseArgs(argv) {
  const out = {
    mode: "",
    rootRepo: "",
    snapshotId: "",
    repoFilter: "",
    compareShowAll: "false",
    inspectIncludeStaged: "true",
    inspectIncludeUnstaged: "true",
    inspectIncludeUntracked: "true",
    inspectShowAllRepos: "false",
    gitSnapshotBin: "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (!key.startsWith("--")) {
      throw new SnapshotGuiError(`Unexpected argument: ${key}`);
    }
    if (value === undefined) {
      throw new SnapshotGuiError(`Missing value for ${key}`);
    }
    i += 1;
    if (key === "--mode") out.mode = value;
    else if (key === "--root-repo") out.rootRepo = value;
    else if (key === "--snapshot-id") out.snapshotId = value;
    else if (key === "--repo-filter") out.repoFilter = value;
    else if (key === "--compare-show-all") out.compareShowAll = parseBooleanArg(value, "--compare-show-all");
    else if (key === "--inspect-include-staged") out.inspectIncludeStaged = parseBooleanArg(value, "--inspect-include-staged");
    else if (key === "--inspect-include-unstaged") out.inspectIncludeUnstaged = parseBooleanArg(value, "--inspect-include-unstaged");
    else if (key === "--inspect-include-untracked") out.inspectIncludeUntracked = parseBooleanArg(value, "--inspect-include-untracked");
    else if (key === "--inspect-show-all-repos") out.inspectShowAllRepos = parseBooleanArg(value, "--inspect-show-all-repos");
    else if (key === "--git-snapshot-bin") out.gitSnapshotBin = value;
    else throw new SnapshotGuiError(`Unknown option: ${key}`);
  }

  if (out.mode !== "compare" && out.mode !== "inspect") {
    throw new SnapshotGuiError("Missing or unsupported --mode");
  }
  if (!out.rootRepo) throw new SnapshotGuiError("Missing --root-repo");
  if (!out.snapshotId) throw new SnapshotGuiError("Missing --snapshot-id");
  if (!out.gitSnapshotBin) throw new SnapshotGuiError("Missing --git-snapshot-bin");

  out.rootRepo = path.resolve(out.rootRepo);
  out.initialViewState = normalizeViewState({
    mode: out.mode,
    snapshotId: out.snapshotId,
    repoFilter: out.repoFilter,
    compareShowAll: out.compareShowAll,
    inspectIncludeStaged: out.inspectIncludeStaged,
    inspectIncludeUnstaged: out.inspectIncludeUnstaged,
    inspectIncludeUntracked: out.inspectIncludeUntracked,
    inspectShowAllRepos: out.inspectShowAllRepos,
  }, out);
  return out;
}

function run(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({ encoding: "utf8" }, opts || {}));
}

function decodePorcelainValue(value) {
  let out = "";
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = value[i + 1];
    if (next === undefined) {
      out += "\\";
      continue;
    }
    if (next === "t") out += "\t";
    else if (next === "n") out += "\n";
    else if (next === "r") out += "\r";
    else if (next === "\\") out += "\\";
    else out += next;
    i += 1;
  }
  return out;
}

function parsePorcelainFields(line) {
  const parts = line.split("\t");
  const kind = parts[0];
  const fields = {};
  for (const kv of parts.slice(1)) {
    const eq = kv.indexOf("=");
    if (eq === -1) continue;
    const key = kv.slice(0, eq);
    const value = kv.slice(eq + 1);
    fields[key] = decodePorcelainValue(value);
  }
  return { kind, fields };
}

function parseComparePorcelain(stdoutText) {
  const target = {};
  const rows = [];
  const summary = {};

  for (const rawLine of stdoutText.split(/\r?\n/)) {
    const line = rawLine;
    if (!line) continue;
    const { kind, fields } = parsePorcelainFields(line);
    if (kind === "compare_target") target.selected = fields;
    else if (kind === "compare_file") rows.push(fields);
    else if (kind === "compare_summary") summary.value = fields;
  }

  return {
    targetFields: target.selected || {},
    rows,
    summaryFields: summary.value || {},
  };
}

function parseInspectPorcelain(stdoutText) {
  const target = {};
  const repoRows = [];
  const categoryRows = [];
  const fileRows = [];

  for (const rawLine of stdoutText.split(/\r?\n/)) {
    const line = rawLine;
    if (!line) continue;
    const { kind, fields } = parsePorcelainFields(line);
    if (kind === "inspect_target") target.selected = fields;
    else if (kind === "inspect_repo") repoRows.push(fields);
    else if (kind === "inspect") categoryRows.push(fields);
    else if (kind === "inspect_file") fileRows.push(fields);
  }

  return {
    targetFields: target.selected || {},
    repoRows,
    categoryRows,
    fileRows,
  };
}

function parseListPorcelain(stdoutText) {
  const snapshots = [];
  for (const rawLine of stdoutText.split(/\r?\n/)) {
    const line = rawLine;
    if (!line) continue;
    const { kind, fields } = parsePorcelainFields(line);
    if (kind === "snapshot") snapshots.push(fields);
  }
  return snapshots;
}

function boolString(value) {
  return value ? "true" : "false";
}

function normalizeMode(value, fallback) {
  if (value === "compare" || value === "inspect") return value;
  return fallback;
}

function normalizeBool(value, fallback) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

function normalizeViewState(rawState, args) {
  const mode = normalizeMode(rawState.mode, args.initialViewState ? args.initialViewState.mode : args.mode);
  const snapshotId = String(rawState.snapshotId || args.initialViewState?.snapshotId || args.snapshotId || "");
  const repoFilter = String(rawState.repoFilter || "");
  const compareShowAll = normalizeBool(
    rawState.compareShowAll,
    args.initialViewState ? args.initialViewState.compareShowAll : args.compareShowAll === "true"
  );
  let inspectIncludeStaged = normalizeBool(
    rawState.inspectIncludeStaged,
    args.initialViewState ? args.initialViewState.inspectIncludeStaged : args.inspectIncludeStaged === "true"
  );
  let inspectIncludeUnstaged = normalizeBool(
    rawState.inspectIncludeUnstaged,
    args.initialViewState ? args.initialViewState.inspectIncludeUnstaged : args.inspectIncludeUnstaged === "true"
  );
  let inspectIncludeUntracked = normalizeBool(
    rawState.inspectIncludeUntracked,
    args.initialViewState ? args.initialViewState.inspectIncludeUntracked : args.inspectIncludeUntracked === "true"
  );
  const inspectShowAllRepos = normalizeBool(
    rawState.inspectShowAllRepos,
    args.initialViewState ? args.initialViewState.inspectShowAllRepos : args.inspectShowAllRepos === "true"
  );

  if (!inspectIncludeStaged && !inspectIncludeUnstaged && !inspectIncludeUntracked) {
    inspectIncludeStaged = true;
    inspectIncludeUnstaged = true;
    inspectIncludeUntracked = true;
  }

  const selectedFile = String(rawState.selectedFile || "");
  const selectedRepo = selectedFile ? String(rawState.selectedRepo || "") : "";
  const selectedCategory = selectedFile && mode === "inspect" ? String(rawState.selectedCategory || "") : "";

  return {
    mode,
    snapshotId,
    repoFilter,
    compareShowAll,
    inspectIncludeStaged,
    inspectIncludeUnstaged,
    inspectIncludeUntracked,
    inspectShowAllRepos,
    selectedRepo,
    selectedCategory,
    selectedFile,
  };
}

function viewStateKey(viewState) {
  return JSON.stringify({
    mode: viewState.mode,
    snapshotId: viewState.snapshotId,
    repoFilter: viewState.repoFilter,
    compareShowAll: boolString(viewState.compareShowAll),
    inspectIncludeStaged: boolString(viewState.inspectIncludeStaged),
    inspectIncludeUnstaged: boolString(viewState.inspectIncludeUnstaged),
    inspectIncludeUntracked: boolString(viewState.inspectIncludeUntracked),
    inspectShowAllRepos: boolString(viewState.inspectShowAllRepos),
  });
}

function rowKey(mode, repoRel, category, filePath) {
  return `${mode}\t${repoRel || ""}\t${category || ""}\t${filePath || ""}`;
}

function findCompareRow(data, repoRel, filePath) {
  const rows = data && Array.isArray(data.rows) ? data.rows : [];
  const key = rowKey("compare", repoRel, "", filePath);
  return rows.find((row) => rowKey("compare", row.repo || "", "", row.file || "") === key) || null;
}

function findInspectRow(data, repoRel, category, filePath) {
  const rows = data && Array.isArray(data.fileRows) ? data.fileRows : [];
  const key = rowKey("inspect", repoRel, category, filePath);
  return rows.find((row) => rowKey("inspect", row.repo || "", row.category || "", row.file || "") === key) || null;
}

function uniqueStrings(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const text = String(value || "");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function loadReposMap(snapshotDir) {
  const reposTsv = path.join(snapshotDir, "repos.tsv");
  if (!fs.existsSync(reposTsv)) {
    throw new SnapshotGuiError(`Snapshot metadata missing: ${reposTsv}`);
  }
  const reposMap = {};
  const repoOrder = [];
  const text = fs.readFileSync(reposTsv, "utf8");
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    reposMap[parts[1]] = { repoId: parts[0], snapshotHead: parts[2], statusHash: parts[3] || "" };
    repoOrder.push(parts[1]);
  }
  return { reposMap, repoOrder };
}

function repoWorktreeExists(repoAbs) {
  const proc = run("git", ["-C", repoAbs, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
  return proc.status === 0;
}

function isBinary(buf) {
  return Boolean(buf && buf.includes(0));
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
    throw new SnapshotGuiError(`${label} escapes ${resolvedBase}.`);
  }
  return resolvedTarget;
}

function parseDiffGitPaths(line) {
  if (!line.startsWith("diff --git ")) return null;
  const body = line.slice("diff --git ".length);
  const match = body.match(/^(".*?"|\S+)\s+(".*?"|\S+)$/);
  if (!match) return null;
  const normalizeToken = (token) => {
    let out = token;
    if (out.startsWith("\"") && out.endsWith("\"")) {
      out = out.slice(1, -1);
    }
    out = out.replace(/\\\\/g, "\\").replace(/\\"/g, "\"").replace(/\\t/g, "\t").replace(/\\n/g, "\n");
    if (out.startsWith("a/") || out.startsWith("b/")) {
      out = out.slice(2);
    }
    return out;
  };
  return {
    aPath: normalizeToken(match[1]),
    bPath: normalizeToken(match[2]),
  };
}

function extractPatchBlock(patchText, filePath) {
  const lines = patchText.split(/\r?\n/);
  let currentLines = [];
  let currentPath = "";

  const flushCurrent = () => {
    if (currentPath === filePath && currentLines.length > 0) {
      return `${currentLines.join("\n")}\n`;
    }
    return "";
  };

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      const match = flushCurrent();
      if (match) return match;
      currentLines = [line];
      const parsed = parseDiffGitPaths(line);
      if (!parsed) {
        currentPath = "";
      } else if (parsed.bPath && parsed.bPath !== "/dev/null") {
        currentPath = parsed.bPath;
      } else {
        currentPath = parsed.aPath || "";
      }
      continue;
    }
    if (currentLines.length > 0) {
      currentLines.push(line);
    }
  }

  return flushCurrent();
}

class SnapshotBundleResolver {
  constructor(rootRepo) {
    this.rootRepo = path.resolve(rootRepo);
    this.sessionDir = path.join(os.tmpdir(), `git-snapshot-gui.${process.pid}`);
    this.snapshotFilesDir = path.join(this.sessionDir, "snapshot-files");
    this.repoWorkDir = path.join(this.sessionDir, "repo-work");
    this.snapshotCache = new Map();
    this.compareTargetSignatureCache = new Map();
    ensureDir(this.snapshotFilesDir);
    ensureDir(this.repoWorkDir);
  }

  snapshotDir(snapshotId) {
    return path.join(os.homedir(), "git-snapshots", path.basename(this.rootRepo), snapshotId);
  }

  snapshotMeta(snapshotId) {
    if (!this.snapshotCache.has(snapshotId)) {
      const snapshotDir = this.snapshotDir(snapshotId);
      const loaded = loadReposMap(snapshotDir);
      this.snapshotCache.set(snapshotId, {
        snapshotDir,
        reposMap: loaded.reposMap,
        repoOrder: loaded.repoOrder,
      });
    }
    return this.snapshotCache.get(snapshotId);
  }

  repoList(snapshotId) {
    return this.snapshotMeta(snapshotId).repoOrder.slice();
  }

  repoMeta(snapshotId, repoRel) {
    const meta = this.snapshotMeta(snapshotId);
    const repoMeta = meta.reposMap[repoRel];
    if (!repoMeta) {
      throw new SnapshotGuiError(`Repo [${repoRel}] not found in snapshot metadata.`);
    }
    return {
      snapshotDir: meta.snapshotDir,
      repoMeta,
    };
  }

  materializeCompareSnapshotFile(snapshotId, repoRel, filePath) {
    const { snapshotDir, repoMeta } = this.repoMeta(snapshotId, repoRel);
    const repoAbs = resolveContainedPath(this.rootRepo, repoRel || ".", `Repo path for [${repoRel || "."}]`);
    if (!repoWorktreeExists(repoAbs)) {
      throw new SnapshotGuiError(`Repo path missing in working tree: ${repoAbs}\nRestore/check out repo and refresh.`);
    }

    const repoPart = repoComponent(repoRel);
    const tempRepo = resolveContainedPath(this.repoWorkDir, `${snapshotId}/${repoPart}`, `Compare workspace for repo [${repoRel}]`);
    rmRf(tempRepo);
    ensureDir(tempRepo);

    const initProc = run("git", ["-C", tempRepo, "init", "-q"], { encoding: "utf8" });
    if (initProc.status !== 0) {
      throw new SnapshotGuiError(`Failed to initialize compare workspace for ${repoRel}.`);
    }

    const tempRepoFile = resolveContainedPath(tempRepo, filePath, `Snapshot temp file for repo [${repoRel}]`);
    ensureDir(path.dirname(tempRepoFile));

    const showProc = spawnSync("git", ["-C", repoAbs, "show", `${repoMeta.snapshotHead}:${filePath}`], {
      encoding: null,
    });
    if (showProc.status === 0 && showProc.stdout) {
      fs.writeFileSync(tempRepoFile, showProc.stdout);
    }

    const patchBase = path.join(snapshotDir, "repos", repoMeta.repoId);
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
      `${snapshotId}/${repoPart}`,
      `Snapshot output directory for repo [${repoRel}]`
    );
    const snapshotOut = resolveContainedPath(snapshotRepoDir, filePath, `Snapshot output path for repo [${repoRel}]`);
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

  repoAbs(repoRel) {
    return resolveContainedPath(this.rootRepo, repoRel || ".", `Repo path for [${repoRel || "."}]`);
  }

  snapshotPathEntry(snapshotId, repoRel, filePath) {
    const { repoMeta } = this.repoMeta(snapshotId, repoRel);
    return readGitTreeEntry(this.repoAbs(repoRel), repoMeta.snapshotHead, filePath);
  }

  compareTargetSignature(snapshotId, repoRel, filePath) {
    const cacheKey = `${snapshotId}\0${repoRel || "."}`;
    if (!this.compareTargetSignatureCache.has(cacheKey)) {
      const signaturesPath = path.join(this.repoBundleDir(snapshotId, repoRel), "compare-target.signatures.tsv");
      if (!fs.existsSync(signaturesPath)) {
        this.compareTargetSignatureCache.set(cacheKey, null);
      } else {
        const entries = new Map();
        const text = fs.readFileSync(signaturesPath, "utf8");
        for (const line of text.split(/\r?\n/)) {
          const parsed = parseCompareTargetSignatureLine(line);
          if (!parsed) continue;
          entries.set(parsed.encodedPath, parsed);
        }
        this.compareTargetSignatureCache.set(cacheKey, entries);
      }
    }

    const entries = this.compareTargetSignatureCache.get(cacheKey);
    if (entries === null) return undefined;
    return entries.get(encodeCompareTargetPath(filePath)) || null;
  }

  headPathEntry(repoRel, filePath) {
    const repoAbs = this.repoAbs(repoRel);
    const headCheck = run("git", ["-C", repoAbs, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8" });
    if (headCheck.status !== 0) return null;
    return readGitTreeEntry(repoAbs, "HEAD", filePath);
  }

  currentTempIndexEntry(repoRel, filePath) {
    const repoAbs = this.repoAbs(repoRel);
    const currentAbs = this.currentFilePath(repoRel, filePath);
    const knownProc = run("git", ["-C", repoAbs, "ls-files", "--error-unmatch", "--", filePath], { encoding: "utf8" });
    const shouldAdd = knownProc.status === 0 || fs.existsSync(currentAbs);
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-snapshot-gui-index-"));
    const indexFile = path.join(tempDir, "index");

    try {
      const indexProc = run("git", ["-C", repoAbs, "rev-parse", "--git-path", "index"], { encoding: "utf8" });
      let indexSource = String(indexProc.stdout || "").trim();
      if (indexSource && !path.isAbsolute(indexSource)) {
        indexSource = path.join(repoAbs, indexSource);
      }
      if (indexSource && fs.existsSync(indexSource)) {
        fs.copyFileSync(indexSource, indexFile);
      } else {
        fs.writeFileSync(indexFile, "", "utf8");
      }

      if (shouldAdd) {
        const addProc = run("git", ["-C", repoAbs, "add", "-A", "--", filePath], {
          encoding: "utf8",
          env: Object.assign({}, process.env, { GIT_INDEX_FILE: indexFile }),
        });
        if (addProc.status !== 0) {
          return null;
        }
      }

      const lsProc = run("git", ["-C", repoAbs, "ls-files", "-s", "-z", "--", filePath], {
        encoding: "utf8",
        env: Object.assign({}, process.env, { GIT_INDEX_FILE: indexFile }),
      });
      if (lsProc.status !== 0) return null;
      return parseIndexEntry(String(lsProc.stdout || ""));
    } finally {
      rmRf(tempDir);
    }
  }

  submoduleCheckoutInfo(repoRel, filePath) {
    const checkoutPath = this.currentFilePath(repoRel, filePath);
    let stat = null;
    try {
      stat = fs.statSync(checkoutPath);
    } catch (_err) {
      return {
        path: checkoutPath,
        exists: false,
        isDirectory: false,
        isRepo: false,
        headOid: "",
      };
    }

    if (!stat.isDirectory()) {
      return {
        path: checkoutPath,
        exists: true,
        isDirectory: false,
        isRepo: false,
        headOid: "",
      };
    }

    const repoCheck = run("git", ["-C", checkoutPath, "rev-parse", "--is-inside-work-tree"], { encoding: "utf8" });
    if (repoCheck.status !== 0 || String(repoCheck.stdout || "").trim() !== "true") {
      return {
        path: checkoutPath,
        exists: true,
        isDirectory: true,
        isRepo: false,
        headOid: "",
      };
    }

    const headProc = run("git", ["-C", checkoutPath, "rev-parse", "--verify", "-q", "HEAD"], { encoding: "utf8" });
    return {
      path: checkoutPath,
      exists: true,
      isDirectory: true,
      isRepo: true,
      headOid: headProc.status === 0 ? String(headProc.stdout || "").trim() : "",
    };
  }

  repoBundleDir(snapshotId, repoRel) {
    const { snapshotDir, repoMeta } = this.repoMeta(snapshotId, repoRel);
    return path.join(snapshotDir, "repos", repoMeta.repoId);
  }

  inspectPatchPreview(snapshotId, repoRel, category, filePath) {
    const patchName = category === "staged" ? "staged.patch" : "unstaged.patch";
    const patchPath = path.join(this.repoBundleDir(snapshotId, repoRel), patchName);
    if (!fs.existsSync(patchPath) || fs.statSync(patchPath).size === 0) {
      return `No captured ${category} patch for ${filePath}.`;
    }
    const patchText = fs.readFileSync(patchPath, "utf8");
    const block = extractPatchBlock(patchText, filePath);
    if (!block.trim()) {
      return `Patch preview unavailable for ${filePath}.`;
    }
    if (/^GIT binary patch$/m.test(block) || /^Binary files /m.test(block)) {
      return "Binary/non-text patch preview unavailable.";
    }
    return block;
  }

  inspectUntrackedPreview(snapshotId, repoRel, filePath) {
    const tarFile = path.join(this.repoBundleDir(snapshotId, repoRel), "untracked.tar");
    if (!fs.existsSync(tarFile)) {
      return `No captured untracked archive for ${repoRel}.`;
    }
    // Pass the member path after `--` so dash-prefixed filenames are not parsed as tar options.
    const proc = spawnSync("tar", ["-xOf", tarFile, "--", filePath], { encoding: null });
    if (proc.status !== 0) {
      const message = String((proc.stderr || proc.stdout || "")).trim();
      return `Captured untracked preview unavailable: ${message || "file not found in archive"}`;
    }
    const out = proc.stdout || Buffer.alloc(0);
    if (isBinary(out)) {
      return "Binary/non-text preview unavailable for captured untracked file.";
    }
    const text = out.toString("utf8");
    return text.length > 0 ? text : `Captured file is empty. (${filePath})`;
  }
}

function shortOid(oid) {
  const text = String(oid || "").trim();
  return text ? text.slice(0, 12) : "";
}

function parseLsTreeEntry(output) {
  const firstRow = String(output || "").split("\0").find((row) => row);
  if (!firstRow) return null;
  const tabIndex = firstRow.indexOf("\t");
  if (tabIndex === -1) return null;
  const meta = firstRow.slice(0, tabIndex);
  const filePath = firstRow.slice(tabIndex + 1);
  const parts = meta.split(" ");
  if (parts.length < 3) return null;
  return {
    mode: parts[0],
    type: parts[1],
    oid: parts[2],
    path: filePath,
  };
}

function parseIndexEntry(output) {
  const firstRow = String(output || "").split("\0").find((row) => row);
  if (!firstRow) return null;
  const tabIndex = firstRow.indexOf("\t");
  if (tabIndex === -1) return null;
  const meta = firstRow.slice(0, tabIndex);
  const filePath = firstRow.slice(tabIndex + 1);
  const parts = meta.trim().split(/\s+/);
  if (parts.length < 3) return null;
  return {
    mode: parts[0],
    oid: parts[1],
    stage: parts[2],
    path: filePath,
  };
}

function encodeCompareTargetPath(filePath) {
  return Buffer.from(String(filePath || ""), "utf8").toString("base64");
}

function parseCompareTargetSignatureLine(line) {
  const text = String(line || "");
  if (!text) return null;
  const parts = text.split("\t");
  if (parts.length < 3) return null;
  return {
    encodedPath: parts[0],
    mode: parts[1],
    oid: parts[2],
  };
}

function readGitTreeEntry(repoAbs, revision, filePath) {
  const proc = run("git", ["-C", repoAbs, "ls-tree", "--full-tree", "-z", revision, "--", filePath], {
    encoding: "utf8",
  });
  if (proc.status !== 0) return null;
  return parseLsTreeEntry(String(proc.stdout || ""));
}

function gitCommitExists(repoDir, oid) {
  if (!repoDir || !oid) return false;
  const proc = run("git", ["-C", repoDir, "cat-file", "-e", `${oid}^{commit}`], { encoding: "utf8" });
  return proc.status === 0;
}

function gitCommitSubject(repoDir, oid) {
  if (!repoDir || !oid || !gitCommitExists(repoDir, oid)) return "";
  const proc = run("git", ["-C", repoDir, "show", "-s", "--format=%s", oid], { encoding: "utf8" });
  if (proc.status !== 0) return "";
  return String(proc.stdout || "").trim();
}

function formatCommitDisplay(repoDir, oid, emptyText) {
  if (!oid) return emptyText || "";
  const short = shortOid(oid);
  const subject = gitCommitSubject(repoDir, oid);
  return subject ? `${short} ${subject}` : short;
}

function gitRevListCount(repoDir, range) {
  if (!repoDir || !range) return 0;
  const proc = run("git", ["-C", repoDir, "rev-list", "--count", range], { encoding: "utf8" });
  if (proc.status !== 0) return 0;
  const parsed = Number(String(proc.stdout || "").trim());
  return Number.isFinite(parsed) ? parsed : 0;
}

function gitRangeSubjects(repoDir, range, limit) {
  if (!repoDir || !range) return [];
  const args = ["-C", repoDir, "log", "--format=%h %s"];
  if (Number.isFinite(limit) && limit > 0) {
    args.push(`--max-count=${Math.floor(limit)}`);
  }
  args.push(range);
  const proc = run("git", args, { encoding: "utf8" });
  if (proc.status !== 0) return [];
  return String(proc.stdout || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function compareStatusSummary(row) {
  const status = String(row && row.status ? row.status : "");
  const reason = String(row && row.reason ? row.reason : "").trim();
  if (status === "unresolved_missing") {
    if (reason.startsWith("repo missing at ")) {
      return "The submodule checkout is missing on disk.";
    }
    return "The snapshot expects this submodule, but the current checkout is missing.";
  }
  if (status === "unresolved_diverged") {
    if (reason === "path still exists while snapshot target removes it") {
      return "The snapshot removes this submodule path, but a checkout still exists locally.";
    }
    return "The current submodule checkout does not match the snapshot target commit.";
  }
  if (status === "resolved_uncommitted") {
    return "The current checkout matches the snapshot target, but HEAD still records a different gitlink commit.";
  }
  if (status === "resolved_committed") {
    return "The current checkout and HEAD both match the snapshot target commit.";
  }
  return "";
}

function buildSubmoduleRelation(repoDir, snapshotOid, currentOid) {
  if (!snapshotOid) {
    return {
      label: "Snapshot removes this submodule path.",
      sections: [],
    };
  }
  if (!currentOid) {
    return {
      label: "The current submodule checkout is missing.",
      sections: [],
    };
  }
  if (snapshotOid === currentOid) {
    return {
      label: "Current checkout matches the snapshot target commit.",
      sections: [],
    };
  }
  if (!repoDir || !gitCommitExists(repoDir, snapshotOid) || !gitCommitExists(repoDir, currentOid)) {
    return {
      label: "Commit relation is unavailable locally for this submodule checkout.",
      sections: [],
    };
  }

  const snapshotAncestor = run("git", ["-C", repoDir, "merge-base", "--is-ancestor", snapshotOid, currentOid], { encoding: "utf8" }).status === 0;
  const currentAncestor = run("git", ["-C", repoDir, "merge-base", "--is-ancestor", currentOid, snapshotOid], { encoding: "utf8" }).status === 0;

  if (snapshotAncestor) {
    const range = `${snapshotOid}..${currentOid}`;
    const total = gitRevListCount(repoDir, range);
    const commits = gitRangeSubjects(repoDir, range);
    return {
      label: `Current checkout is ahead of the snapshot target by ${total} commit${total === 1 ? "" : "s"}.`,
      sections: [{
        title: "Current-only commits (would be removed to match the snapshot)",
        commits,
      }],
    };
  }

  if (currentAncestor) {
    const range = `${currentOid}..${snapshotOid}`;
    const total = gitRevListCount(repoDir, range);
    const commits = gitRangeSubjects(repoDir, range);
    return {
      label: `Current checkout is behind the snapshot target by ${total} commit${total === 1 ? "" : "s"}.`,
      sections: [{
        title: "Snapshot-only commits (needed to restore the snapshot target)",
        commits,
      }],
    };
  }

  const currentRange = `${snapshotOid}..${currentOid}`;
  const snapshotRange = `${currentOid}..${snapshotOid}`;
  const currentTotal = gitRevListCount(repoDir, currentRange);
  const snapshotTotal = gitRevListCount(repoDir, snapshotRange);
  const currentCommits = gitRangeSubjects(repoDir, currentRange);
  const snapshotCommits = gitRangeSubjects(repoDir, snapshotRange);
  return {
    label: "Current checkout and snapshot target have diverged.",
    sections: [
      {
        title: "Current-only commits (would be removed to match the snapshot)",
        commits: currentCommits,
      },
      {
        title: "Snapshot-only commits (needed to restore the snapshot target)",
        commits: snapshotCommits,
      },
    ],
  };
}

function buildSubmoduleSummary(resolver, snapshotId, repoRel, filePath, knownRow) {
  const compareTargetEntry = resolver.compareTargetSignature(snapshotId, repoRel, filePath);
  const snapshotEntry = compareTargetEntry !== undefined
    ? compareTargetEntry
    : resolver.snapshotPathEntry(snapshotId, repoRel, filePath);
  const currentEntry = resolver.currentTempIndexEntry(repoRel, filePath);
  const headEntry = resolver.headPathEntry(repoRel, filePath);
  const checkoutInfo = resolver.submoduleCheckoutInfo(repoRel, filePath);

  const snapshotGitlink = snapshotEntry && snapshotEntry.mode === "160000" ? snapshotEntry : null;
  const currentGitlink = currentEntry && currentEntry.mode === "160000" ? currentEntry : null;
  const headGitlink = headEntry && headEntry.mode === "160000" ? headEntry : null;
  const isSubmodule = Boolean(snapshotGitlink || currentGitlink || headGitlink || checkoutInfo.isRepo);
  if (!isSubmodule) return null;

  const repoDir = checkoutInfo.isRepo ? checkoutInfo.path : "";
  const snapshotOid = snapshotGitlink ? snapshotGitlink.oid : "";
  const currentCheckoutOid = checkoutInfo.headOid || (currentGitlink ? currentGitlink.oid : "");
  const currentGitlinkOid = currentGitlink ? currentGitlink.oid : "";
  const headOid = headGitlink ? headGitlink.oid : "";
  const relation = buildSubmoduleRelation(repoDir, snapshotOid, currentCheckoutOid);
  const notes = [];

  if (!currentGitlinkOid && checkoutInfo.isRepo) {
    notes.push("A submodule checkout directory still exists on disk, but the current superproject state does not track it as a gitlink.");
  }
  if (currentGitlinkOid && checkoutInfo.headOid && currentGitlinkOid !== checkoutInfo.headOid) {
    notes.push("The superproject's current gitlink commit differs from the checked-out submodule HEAD.");
  }
  if (!checkoutInfo.exists && currentGitlinkOid) {
    notes.push("The current superproject state references this submodule, but its checkout is missing or not initialized.");
  }

  return {
    path: filePath,
    repo: repoRel || ".",
    status: String(knownRow && knownRow.status ? knownRow.status : ""),
    summary: compareStatusSummary(knownRow),
    relation: relation.label,
    fields: [
      { label: "Type", value: "submodule (gitlink)" },
      { label: "Snapshot target", value: snapshotOid ? formatCommitDisplay(repoDir, snapshotOid, shortOid(snapshotOid)) : "snapshot removes this path" },
      { label: "Current checkout", value: currentCheckoutOid ? formatCommitDisplay(repoDir, currentCheckoutOid, shortOid(currentCheckoutOid)) : "missing checkout" },
      { label: "Current superproject gitlink", value: currentGitlinkOid ? formatCommitDisplay(repoDir, currentGitlinkOid, shortOid(currentGitlinkOid)) : "not tracked as a current gitlink" },
      { label: "HEAD gitlink", value: headOid ? formatCommitDisplay(repoDir, headOid, shortOid(headOid)) : "not present in HEAD" },
      { label: "Relation", value: relation.label },
    ],
    sections: relation.sections,
    notes,
  };
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

function quoteUnifiedDiffPath(prefix, relFilePath) {
  const escaped = String(relFilePath || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n");
  return `"${prefix}${escaped}"`;
}

function buildSnapshotOnlyDiff(snapshotFile, relFilePath) {
  if (!fs.existsSync(snapshotFile)) {
    return `Working tree file is missing. Snapshot preview unavailable. (${relFilePath})`;
  }

  const snapshotBytes = fs.readFileSync(snapshotFile);
  if (isBinary(snapshotBytes)) {
    return "Working tree file is missing. Captured snapshot file is binary/non-text; use external tool.";
  }

  const snapshotText = snapshotBytes.toString("utf8");
  if (snapshotText.length === 0) {
    return `Working tree file is missing. Captured snapshot file is empty. (${relFilePath})`;
  }

  const normalizedText = snapshotText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const hasTrailingNewline = normalizedText.endsWith("\n");
  const lines = normalizedText.split("\n");
  if (hasTrailingNewline) {
    lines.pop();
  }

  const hunkLength = lines.length;
  const diffLines = [
    `diff --git ${quoteUnifiedDiffPath("a/", relFilePath)} ${quoteUnifiedDiffPath("b/", relFilePath)}`,
    "snapshot-only preview: working tree path missing",
    "--- /dev/null",
    "+++ " + quoteUnifiedDiffPath("b/", relFilePath),
    `@@ -0,0 +1,${hunkLength} @@`,
  ];

  for (const line of lines) {
    diffLines.push("+" + line);
  }
  if (!hasTrailingNewline) {
    diffLines.push("\\ No newline at end of file");
  }

  return diffLines.join("\n");
}

function comparePreviewExternalDiffSupport(previewResult) {
  return !(previewResult && previewResult.externalDiffSupported === false);
}

function comparePreviewExternalDiffHeaderValue(previewResult) {
  return comparePreviewExternalDiffSupport(previewResult) ? "1" : "0";
}

function compareReasonDetailText(row) {
  const status = String(row && row.status ? row.status : "");
  const reason = String(row && row.reason ? row.reason : "").trim();
  if (!reason) return "";

  const genericReasons = {
    resolved_committed: "snapshot target content and mode match HEAD and working tree",
    resolved_uncommitted: "snapshot target content and mode match working tree but not HEAD",
    unresolved_missing: "snapshot target path is missing from working tree",
    unresolved_diverged: "current content or mode diverges from snapshot target",
  };
  if (reason === genericReasons[status]) {
    return "";
  }
  if (reason.startsWith("repo missing at ")) {
    return "The repository is missing at " + reason.slice("repo missing at ".length) + ".";
  }
  if (reason === "path still exists while snapshot target removes it") {
    return "The path still exists locally, but the snapshot expects it to be removed.";
  }
  return "Detail: " + reason + ".";
}

function configuredExternalDiffCandidates() {
  const configured = String(process.env.GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_CANDIDATES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  return configured.length > 0 ? configured : DEFAULT_EXTERNAL_DIFF_CANDIDATES;
}

function tokenizeCommandTemplate(templateText) {
  const tokens = [];
  let current = "";
  let quote = "";
  let escaping = false;

  for (let i = 0; i < templateText.length; i += 1) {
    const ch = templateText[i];

    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }

    if (quote) {
      if (ch === "\\") {
        escaping = true;
        continue;
      }
      if (ch === quote) {
        quote = "";
        continue;
      }
      current += ch;
      continue;
    }

    if (ch === "'" || ch === "\"") {
      quote = ch;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }

  if (escaping) {
    current += "\\";
  }
  if (quote) {
    throw new SnapshotGuiError("Unterminated quote in GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE.");
  }
  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function applyExternalDiffPlaceholders(token, snapshotFile, currentFile) {
  let out = String(token || "");
  for (const pattern of EXTERNAL_DIFF_SOURCE_PATTERNS) {
    out = out.replace(pattern, snapshotFile);
  }
  for (const pattern of EXTERNAL_DIFF_TARGET_PATTERNS) {
    out = out.replace(pattern, currentFile);
  }
  return out;
}

function hasExternalDiffPlaceholder(token, name) {
  const value = String(token || "");
  if (name === "SOURCE") {
    return EXTERNAL_DIFF_SOURCE_PATTERNS.some((pattern) => {
      pattern.lastIndex = 0;
      return pattern.test(value);
    });
  }
  return EXTERNAL_DIFF_TARGET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function defaultExternalDiffArgsTemplate(tool) {
  return tool === "code" ? ["--diff", "$SOURCE", "$TARGET"] : ["$SOURCE", "$TARGET"];
}

function resolveExternalDiffSelector(rawSelector) {
  const selector = String(rawSelector || "").trim();
  if (!selector) return null;

  if (/\s/.test(selector)) {
    throw new SnapshotGuiError(
      `Unsupported external diff selector "${selector}". Use a bare tool name or GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE.`
    );
  }

  return {
    selector,
    label: selector,
    command: selector,
    argsTemplate: defaultExternalDiffArgsTemplate(selector),
  };
}

function resolveExternalDiffCommandTemplate(templateText) {
  const tokens = tokenizeCommandTemplate(String(templateText || "").trim());
  if (!tokens.length) {
    throw new SnapshotGuiError("GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE cannot be empty.");
  }

  if (!tokens.some((token) => hasExternalDiffPlaceholder(token, "SOURCE"))) {
    throw new SnapshotGuiError("GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE must include $SOURCE or ${SOURCE}.");
  }
  if (!tokens.some((token) => hasExternalDiffPlaceholder(token, "TARGET"))) {
    throw new SnapshotGuiError("GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE must include $TARGET or ${TARGET}.");
  }

  return {
    selector: "template",
    label: path.basename(tokens[0]) || tokens[0],
    command: tokens[0],
    argsTemplate: tokens.slice(1),
  };
}

function resolveForcedExternalDiffSpec() {
  const templateText = String(process.env.GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE || "").trim();
  if (templateText) {
    return resolveExternalDiffCommandTemplate(templateText);
  }

  const forcedTool = process.env.GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL
    || process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL
    || "";
  if (!forcedTool) return null;
  return resolveExternalDiffSelector(forcedTool);
}

function externalDiffCommandExists(command) {
  const text = String(command || "").trim();
  if (!text) return false;

  if (text.includes("/") || text.includes("\\")) {
    const resolvedPath = path.resolve(text);
    try {
      fs.accessSync(resolvedPath, fs.constants.X_OK);
      return true;
    } catch (_err) {
      return false;
    }
  }

  const check = run("which", [text], { encoding: "utf8" });
  return check.status === 0;
}

function forcedExternalDiffUnavailableMessage(spec) {
  const sourceVar = spec && spec.selector === "template"
    ? "GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE"
    : "GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL";
  return `Forced external diff command "${spec.command}" is not available. Update ${sourceVar} or install the command.`;
}

function externalDiffMissingMessage() {
  const candidates = configuredExternalDiffCandidates().join(", ");
  return `No external diff tool found. Set GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL, GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE, or install one of: ${candidates}.`;
}

function detectExternalDiffSpec() {
  const forcedSpec = resolveForcedExternalDiffSpec();
  if (forcedSpec) {
    if (!externalDiffCommandExists(forcedSpec.command)) {
      throw new SnapshotGuiError(forcedExternalDiffUnavailableMessage(forcedSpec));
    }
    return forcedSpec;
  }

  for (const candidate of configuredExternalDiffCandidates()) {
    const spec = resolveExternalDiffSelector(candidate);
    if (externalDiffCommandExists(spec.command)) return spec;
  }
  return null;
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

function isExternalDiffTestMode() {
  return Boolean(
    process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG
    || process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG
    || process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL
  );
}

function spawnDetached(command, args) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", (error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`External diff launch failed for ${command}: ${message}`);
  });
  recordDetachedSpawn(command, args, child.pid);
  child.unref();
  return child;
}

function activateMeldForegroundMac() {
  if (process.platform !== "darwin") return;
  if (isExternalDiffTestMode()) return;
  const script =
    `repeat ${MELD_ACTIVATE_RETRIES} times\n` +
    "  try\n" +
    '    tell application "Meld" to activate\n' +
    "    return\n" +
    "  end try\n" +
    `  delay ${MELD_ACTIVATE_DELAY_SECONDS}\n` +
    "end repeat";
  spawnDetached("osascript", ["-e", script]);
}

function instantiateExternalDiffLaunch(spec, snapshotFile, currentFile) {
  const command = applyExternalDiffPlaceholders(spec.command, snapshotFile, currentFile);
  const args = Array.isArray(spec.argsTemplate)
    ? spec.argsTemplate.map((arg) => applyExternalDiffPlaceholders(arg, snapshotFile, currentFile))
    : [];
  return { command, args };
}

function launchExternalDiff(spec, snapshotFile, currentFile) {
  const launch = instantiateExternalDiffLaunch(spec, snapshotFile, currentFile);

  if (recordExternalDiffLaunch(spec.label, snapshotFile, currentFile)) {
    return;
  }

  // Launch the external tool in its own process group so stopping compare --gui
  // does not also terminate the opened diff application.
  spawnDetached(launch.command, launch.args);

  if (path.basename(launch.command) === "meld" && process.platform === "darwin") {
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

function serializeViewStateToQuery(viewState) {
  const params = new URLSearchParams();
  params.set("mode", viewState.mode);
  params.set("snapshot_id", viewState.snapshotId);
  params.set("repo_filter", viewState.repoFilter || "");
  params.set("compare_show_all", boolString(viewState.compareShowAll));
  params.set("inspect_include_staged", boolString(viewState.inspectIncludeStaged));
  params.set("inspect_include_unstaged", boolString(viewState.inspectIncludeUnstaged));
  params.set("inspect_include_untracked", boolString(viewState.inspectIncludeUntracked));
  params.set("inspect_show_all_repos", boolString(viewState.inspectShowAllRepos));
  return params.toString();
}

function escapeForHtmlJson(data) {
  return JSON.stringify(data).replace(/</g, "\\u003c");
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function viewStateRepoScopeText(repoFilter) {
  return repoFilter ? repoFilter : "(all repos)";
}

function viewStateInspectScopeLabel(viewState) {
  if (viewState.repoFilter) {
    return "selected repo";
  }
  return viewState.inspectShowAllRepos ? "all repos" : "repos with changes";
}

function viewStateInspectCategoryLabel(viewState) {
  const out = [];
  if (viewState.inspectIncludeStaged) out.push("staged");
  if (viewState.inspectIncludeUnstaged) out.push("unstaged");
  if (viewState.inspectIncludeUntracked) out.push("untracked");
  return out.join(", ");
}

function documentTitleForViewState(viewState) {
  const parts = [
    "git-snapshot",
    viewState.mode,
    viewState.snapshotId || "?",
    viewStateRepoScopeText(viewState.repoFilter),
  ];
  if (viewState.mode === "compare") {
    parts.push(viewState.compareShowAll ? "all statuses" : "unresolved only");
  } else {
    parts.push(viewStateInspectCategoryLabel(viewState));
    parts.push(viewStateInspectScopeLabel(viewState));
  }
  return parts.filter(Boolean).join(" · ");
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function htmlPage(initialViewState) {
  const initialStateJson = escapeForHtmlJson(initialViewState);
  const initialTitle = escapeHtml(documentTitleForViewState(initialViewState));
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${initialTitle}</title>
  <style>
    :root {
      --bg: #f6f2ea;
      --panel: #fffdf7;
      --panel-strong: #f2ecdd;
      --ink: #232019;
      --muted: #6d6657;
      --line: #d6cfbf;
      --accent: #195f54;
      --accent-soft: #dcefea;
      --danger: #8a2b2b;
      --splitter: #e7decc;
      --splitter-strong: #c4baa6;
      --gh-border: #d0d7de;
      --gh-subtle: #f6f8fa;
      --gh-add-bg: #dafbe1;
      --gh-add-gutter: #aceebb;
      --gh-add-text: #116329;
      --gh-del-bg: #ffebe9;
      --gh-del-gutter: #ffcecb;
      --gh-del-text: #cf222e;
      --gh-hunk-bg: #ddf4ff;
      --gh-hunk-text: #0969da;
      --gh-note-bg: #fff8c5;
      --gh-note-text: #9a6700;
      --gh-gutter: #f6f8fa;
      --gh-gutter-text: #8c959f;
    }
    * { box-sizing: border-box; }
    html, body { height: 100%; overflow: hidden; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      overflow: hidden;
      background:
        radial-gradient(circle at top left, rgba(255,255,255,0.75), transparent 42%),
        linear-gradient(135deg, #f4efe3, #ece7da 52%, #e7ede9);
      color: var(--ink);
      font: 14px/1.4 Menlo, Monaco, Consolas, monospace;
    }
    .visually-hidden {
      position: absolute;
      width: 1px;
      height: 1px;
      padding: 0;
      margin: -1px;
      overflow: hidden;
      clip: rect(0, 0, 0, 0);
      white-space: nowrap;
      border: 0;
    }
    .top {
      padding: 8px 12px;
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,0.82);
      backdrop-filter: blur(10px);
    }
    .controls {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      align-items: center;
    }
    .control {
      display: flex;
      flex-direction: row;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .control-mode { flex: 0 0 auto; }
    .control-snapshot {
      flex: 1 1 320px;
      max-width: 560px;
    }
    .control-repo {
      flex: 0 1 240px;
      max-width: 300px;
    }
    .control label, .toggle-group-title {
      flex: 0 0 auto;
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    .toggle-group-title {
      display: none;
    }
    .control select,
    .control input[type="text"] {
      width: auto;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 7px 10px;
      background: rgba(255,255,255,0.92);
      color: var(--ink);
      font: inherit;
    }
    .control-mode select { min-width: 160px; }
    .control-snapshot select,
    .control-repo select {
      flex: 1 1 auto;
      width: 100%;
      min-width: 0;
    }
    .toggle-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      align-items: center;
      min-height: 0;
    }
    .toggle-row label {
      display: inline-flex;
      gap: 6px;
      align-items: center;
      color: var(--ink);
      text-transform: none;
      letter-spacing: 0;
      font-size: 13px;
    }
    .control.mode-compare,
    .control.mode-inspect {
      flex: 0 1 auto;
    }
    .actions-control {
      flex: 0 0 auto;
    }
    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: flex-start;
    }
    button {
      background: var(--accent);
      color: #fff;
      border: 0;
      border-radius: 8px;
      padding: 7px 12px;
      cursor: pointer;
      font: inherit;
    }
    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }
    .hidden { display: none !important; }
    .main {
      display: grid;
      grid-template-columns: minmax(300px, 39%) 12px minmax(0, 1fr);
      min-height: 0;
      overflow: hidden;
    }
    .left {
      overflow: auto;
      min-height: 0;
      background: var(--panel);
    }
    .list-header {
      position: sticky;
      top: 0;
      z-index: 2;
      padding: 10px 10px 8px;
      border-bottom: 1px solid var(--line);
      background:
        linear-gradient(180deg, rgba(255,255,255,0.96), rgba(255,253,247,0.92)),
        var(--panel);
      backdrop-filter: blur(8px);
    }
    .list-header-top {
      display: flex;
      align-items: baseline;
      justify-content: space-between;
      gap: 8px 12px;
      flex-wrap: wrap;
    }
    .list-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .list-context {
      color: var(--muted);
      font-size: 12px;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .list-stats {
      margin-top: 8px;
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .list-pill {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 8px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,0.92);
      color: var(--muted);
      font-size: 12px;
    }
    .list-pill.primary {
      background: var(--accent-soft);
      border-color: rgba(25, 95, 84, 0.18);
      color: var(--accent);
    }
    .list-pill strong {
      color: var(--ink);
      font-weight: 700;
    }
    .splitter {
      position: relative;
      cursor: col-resize;
      background:
        linear-gradient(180deg, rgba(255,255,255,0.72), rgba(255,255,255,0.14)),
        linear-gradient(90deg, rgba(255,255,255,0.12), rgba(0,0,0,0.04));
      border-left: 1px solid var(--line);
      border-right: 1px solid var(--line);
      touch-action: none;
      user-select: none;
    }
    .splitter::before {
      content: "";
      position: absolute;
      top: 50%;
      left: 50%;
      width: 4px;
      height: 56px;
      transform: translate(-50%, -50%);
      border-radius: 999px;
      background:
        radial-gradient(circle, var(--splitter-strong) 0 1px, transparent 1.2px) center top / 4px 8px repeat-y;
      opacity: 0.9;
    }
    .splitter:hover,
    .splitter.dragging,
    .splitter:focus-visible {
      background:
        linear-gradient(180deg, rgba(220,239,234,0.92), rgba(220,239,234,0.42)),
        linear-gradient(90deg, rgba(255,255,255,0.12), rgba(0,0,0,0.04));
    }
    .splitter:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    body.resizing,
    body.resizing * {
      cursor: col-resize !important;
      user-select: none !important;
    }
    .right {
      overflow: auto;
      min-height: 0;
      padding: 10px;
      display: grid;
      grid-template-rows: auto minmax(0, 1fr);
      gap: 10px;
    }
    .inspect-summary {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255,255,255,0.82);
      padding: 10px;
    }
    .inspect-summary.hidden {
      display: none !important;
    }
    .inspect-summary-title {
      font-weight: 700;
      margin-bottom: 6px;
    }
    .inspect-summary-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 4px 12px;
      color: var(--muted);
      font-size: 13px;
    }
    .preview-panel {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255,255,255,0.78);
      min-height: 0;
      overflow: auto;
      padding: 0;
    }
    .repo {
      padding: 9px 10px;
      font-weight: 700;
      border-top: 1px solid var(--line);
      background: var(--panel-strong);
    }
    .category {
      padding: 6px 10px;
      border-top: 1px dashed #e6dfce;
      color: var(--muted);
      background: #faf6ec;
    }
    .repo-empty {
      padding: 8px 10px;
      color: var(--muted);
      border-top: 1px dashed #e6dfce;
      font-style: italic;
    }
    .row {
      display: block;
      width: 100%;
      padding: 7px 10px;
      color: var(--ink);
      background: transparent;
      border: 0;
      border-top: 1px dashed #ece7d9;
      text-align: left;
      cursor: pointer;
      font: inherit;
    }
    .row:hover { background: #f2efe5; }
    .row.active {
      background: var(--accent-soft);
      border-left: 3px solid var(--accent);
      padding-left: 7px;
    }
    .row:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .row-content {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
    }
    .row-file {
      flex: 1 1 auto;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .status-pill {
      flex: 0 0 auto;
      font-size: 11px;
      line-height: 1.2;
      text-transform: none;
      letter-spacing: 0;
      white-space: nowrap;
    }
    .status-pill.resolved {
      background: #e8f4ec;
      border-color: #bfdcc8;
      color: #1d6f42;
    }
    .status-pill.unresolved {
      background: #fff1e7;
      border-color: #f1d2bc;
      color: #9a4c18;
    }
    .status-pill.status-resolved-committed {
      background: #eef6ef;
      border-color: #d4e2d2;
      color: #506450;
    }
    .status-pill.status-resolved-uncommitted {
      background: #e1f4e7;
      border-color: #b7dfc2;
      color: #1c6b45;
    }
    .status-pill.status-unresolved-missing {
      background: #ffebe9;
      border-color: #f0c9c6;
      color: #b42318;
    }
    .status-pill.status-unresolved-diverged {
      background: #fff4da;
      border-color: #ecd19a;
      color: #8a4a04;
    }
    .status { color: var(--muted); }
    .loading { color: var(--muted); font-style: italic; }
    .error { color: var(--danger); }
    pre { margin: 0; white-space: pre; }
    .preview-pre {
      margin: 0;
      padding: 14px 16px;
      min-height: 100%;
      white-space: pre;
    }
    .diff-view {
      min-height: 100%;
    }
    .diff-view.rendered-diff {
      background: #fff;
    }
    .diff-file + .diff-file {
      border-top: 1px solid var(--gh-border);
    }
    .diff-file-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 10px;
      padding: 10px 14px;
      background: var(--gh-subtle);
      border-bottom: 1px solid var(--gh-border);
      font-weight: 600;
    }
    .diff-file-title {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .diff-file-chip {
      padding: 2px 8px;
      border-radius: 999px;
      background: #fff;
      border: 1px solid var(--gh-border);
      color: var(--muted);
      font-size: 12px;
      font-weight: 600;
    }
    .diff-file-chip.diff-file-chip-add {
      background: var(--gh-add-bg);
      border-color: #b6e3bf;
      color: var(--gh-add-text);
    }
    .diff-file-chip.diff-file-chip-delete {
      background: var(--gh-del-bg);
      border-color: #ffcecb;
      color: var(--gh-del-text);
    }
    .diff-file-chip.diff-file-chip-note {
      background: var(--gh-note-bg);
      border-color: #e2c56d;
      color: var(--gh-note-text);
    }
    .diff-file-meta {
      padding: 8px 14px;
      background: #fbfcfd;
      border-bottom: 1px solid var(--gh-border);
      color: var(--muted);
      font-size: 12px;
    }
    .diff-file-meta-line + .diff-file-meta-line {
      margin-top: 2px;
    }
    .diff-table-wrap {
      overflow: auto;
    }
    .diff-table {
      width: 100%;
      min-width: max-content;
      border-collapse: collapse;
      border-spacing: 0;
      font-size: 12px;
      line-height: 1.45;
      font-variant-ligatures: none;
    }
    .diff-table td {
      vertical-align: top;
    }
    .diff-gutter {
      width: 54px;
      padding: 0 10px;
      text-align: right;
      user-select: none;
      color: var(--gh-gutter-text);
      background: var(--gh-gutter);
      border-right: 1px solid var(--gh-border);
    }
    .diff-code {
      padding: 0 12px;
      white-space: pre;
      color: #24292f;
    }
    .diff-code span {
      display: block;
    }
    .diff-line.context .diff-code {
      background: #fff;
    }
    .diff-line.add .diff-gutter {
      background: var(--gh-add-gutter);
    }
    .diff-line.add .diff-code {
      background: var(--gh-add-bg);
      color: var(--gh-add-text);
    }
    .diff-line.delete .diff-gutter {
      background: var(--gh-del-gutter);
    }
    .diff-line.delete .diff-code {
      background: var(--gh-del-bg);
      color: var(--gh-del-text);
    }
    .diff-line.hunk .diff-gutter,
    .diff-line.hunk .diff-code {
      background: var(--gh-hunk-bg);
      color: var(--gh-hunk-text);
    }
    .diff-line.note .diff-gutter,
    .diff-line.note .diff-code {
      background: var(--gh-note-bg);
      color: var(--gh-note-text);
    }
    .diff-line + .diff-line .diff-gutter,
    .diff-line + .diff-line .diff-code {
      border-top: 1px solid rgba(208, 215, 222, 0.6);
    }
    .submodule-summary {
      margin: 12px;
      border: 1px solid var(--gh-border);
      border-radius: 12px;
      background: #fff;
      overflow: hidden;
      box-shadow: 0 10px 24px rgba(31, 35, 40, 0.06);
    }
    .submodule-summary-header {
      padding: 12px 14px;
      border-bottom: 1px solid var(--gh-border);
      background: linear-gradient(180deg, #fbfcfd, #f6f8fa);
    }
    .submodule-summary-top {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 8px 10px;
      justify-content: space-between;
    }
    .submodule-summary-eyebrow {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.06em;
    }
    .submodule-summary-path {
      margin-top: 4px;
      font-size: 18px;
      font-weight: 700;
      word-break: break-word;
    }
    .submodule-summary-body {
      padding: 14px;
      display: grid;
      gap: 14px;
    }
    .submodule-summary-lead {
      color: #24292f;
      line-height: 1.5;
    }
    .submodule-summary-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
    }
    .submodule-summary-field {
      padding: 10px 12px;
      border: 1px solid var(--gh-border);
      border-radius: 10px;
      background: #fffdf8;
      min-width: 0;
    }
    .submodule-summary-field.submodule-summary-field-relation.relation-ahead {
      border-color: #8ddb9e;
      background: #f0fff4;
    }
    .submodule-summary-field.submodule-summary-field-relation.relation-behind {
      border-color: #ffb8b0;
      background: #fff5f3;
    }
    .submodule-summary-field-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .submodule-summary-field.submodule-summary-field-relation.relation-ahead .submodule-summary-field-label {
      color: #1a7f37;
    }
    .submodule-summary-field.submodule-summary-field-relation.relation-behind .submodule-summary-field-label {
      color: #cf222e;
    }
    .submodule-summary-field-value {
      margin-top: 4px;
      word-break: break-word;
    }
    .submodule-relation-keyword {
      font-weight: 700;
    }
    .submodule-relation-keyword.ahead {
      color: #1a7f37;
    }
    .submodule-relation-keyword.behind {
      color: #cf222e;
    }
    .submodule-summary-section + .submodule-summary-section {
      margin-top: 2px;
    }
    .submodule-summary-section-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .submodule-summary-commits {
      margin: 8px 0 0;
      padding-left: 18px;
    }
    .submodule-summary-commits li + li {
      margin-top: 4px;
    }
    .submodule-summary-more {
      margin-top: 6px;
      color: var(--muted);
      font-size: 12px;
    }
    .submodule-summary-notes {
      display: grid;
      gap: 8px;
    }
    .submodule-summary-note {
      padding: 9px 10px;
      border-radius: 10px;
      background: #fff8e1;
      border: 1px solid #ecd9a4;
      color: #7a5b00;
    }
    .empty { color: var(--muted); padding: 10px; }
    .empty.after-header,
    .list-header + .repo,
    .list-header + .repo-empty,
    .list-header + .category,
    .list-header + .empty,
    .repo:first-of-type,
    .repo-empty:first-of-type {
      border-top: 0;
    }
    @media (max-width: 900px) {
      .control-snapshot,
      .control-repo {
        flex-basis: 100%;
        max-width: none;
      }
    }
    @media (max-width: 700px) {
      .top { padding: 10px 12px; }
      .controls {
        gap: 8px;
      }
      .control,
      .control-snapshot,
      .control-repo,
      .control.mode-compare,
      .control.mode-inspect,
      .actions-control {
        flex-basis: 100%;
        max-width: none;
      }
      .control {
        flex-wrap: wrap;
      }
      .main {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(220px, 40vh) minmax(0, 1fr);
      }
      .splitter { display: none; }
      .left {
        border-bottom: 1px solid var(--line);
      }
      .right { padding: 8px; }
      .inspect-summary-grid { grid-template-columns: 1fr; }
      .list-header {
        padding: 9px 9px 8px;
      }
    }
  </style>
</head>
<body>
  <div class="top">
    <div class="controls">
      <div class="control control-mode">
        <label for="modeSelect">Mode</label>
        <select id="modeSelect">
          <option value="compare">compare</option>
          <option value="inspect">inspect</option>
        </select>
      </div>
      <div class="control control-snapshot">
        <label for="snapshotSelect">Snapshot</label>
        <select id="snapshotSelect"></select>
      </div>
      <div class="control control-repo">
        <label for="repoFilter">Repo</label>
        <select id="repoFilter"></select>
      </div>
      <div class="control mode-compare">
        <div class="toggle-group-title">Compare</div>
        <div class="toggle-row">
          <label><input id="compareShowAll" type="checkbox" /> show resolved rows</label>
        </div>
      </div>
      <div class="control mode-inspect">
        <div class="toggle-group-title">Inspect Categories</div>
        <div class="toggle-row">
          <label><input id="inspectStaged" type="checkbox" /> staged</label>
          <label><input id="inspectUnstaged" type="checkbox" /> unstaged</label>
          <label><input id="inspectUntracked" type="checkbox" /> untracked</label>
          <label><input id="inspectAllRepos" type="checkbox" /> all repos</label>
        </div>
      </div>
      <div class="control actions-control">
        <div class="actions">
          <button id="refresh" type="button">Refresh</button>
          <button id="openExternal" type="button" disabled>Open External Diff</button>
        </div>
      </div>
    </div>
    <div id="meta" class="visually-hidden"></div>
    <div id="summary" class="visually-hidden"></div>
  </div>
  <div id="main" class="main">
    <div id="list" class="left" role="group" aria-label="Snapshot rows"></div>
    <div
      id="splitter"
      class="splitter"
      role="separator"
      tabindex="0"
      aria-label="Resize file list and diff panes"
      aria-orientation="vertical"
      aria-valuemin="24"
      aria-valuemax="76"
    ></div>
    <div class="right">
      <div id="inspectSummaryPanel" class="inspect-summary hidden">
        <div class="inspect-summary-title">Inspect Summary</div>
        <div id="inspectSummaryBody" class="inspect-summary-grid"></div>
      </div>
      <div class="preview-panel"><div id="diff" class="diff-view loading">Loading…</div></div>
    </div>
  </div>
  <script>
    const initialViewState = ${initialStateJson};
    const mainEl = document.getElementById("main");
    const listEl = document.getElementById("list");
    const splitterEl = document.getElementById("splitter");
    const diffEl = document.getElementById("diff");
    const metaEl = document.getElementById("meta");
    const summaryEl = document.getElementById("summary");
    const refreshBtn = document.getElementById("refresh");
    const openBtn = document.getElementById("openExternal");
    const modeSelect = document.getElementById("modeSelect");
    const snapshotSelect = document.getElementById("snapshotSelect");
    const repoFilterSelect = document.getElementById("repoFilter");
    const compareShowAll = document.getElementById("compareShowAll");
    const inspectStaged = document.getElementById("inspectStaged");
    const inspectUnstaged = document.getElementById("inspectUnstaged");
    const inspectUntracked = document.getElementById("inspectUntracked");
    const inspectAllRepos = document.getElementById("inspectAllRepos");
    const inspectSummaryPanel = document.getElementById("inspectSummaryPanel");
    const inspectSummaryBody = document.getElementById("inspectSummaryBody");
    const previewPanelEl = document.querySelector(".preview-panel");
    const splitLayoutMedia = window.matchMedia("(max-width: 700px)");
    const SPLIT_STORAGE_KEY = "git-snapshot.gui.split.left-ratio.v1";
    const DEFAULT_SPLIT_RATIO = 0.39;
    const MIN_SPLIT_RATIO = 0.24;
    const MAX_SPLIT_RATIO = 0.76;
    const SPLITTER_WIDTH_PX = 12;
    const BACKSLASH = String.fromCharCode(92);
    const DOUBLE_QUOTE = String.fromCharCode(34);
    const CARRIAGE_RETURN_CHAR = String.fromCharCode(13);
    const TAB_CHAR = String.fromCharCode(9);
    const NEWLINE_CHAR = String.fromCharCode(10);

    let currentViewState = Object.assign({}, initialViewState);
    let snapshots = [];
    let currentData = null;
    let selectionKeyValue = "";
    let previewToken = 0;
    let refreshTimer = null;
    let emptyStateMessage = "No rows to display.";
    let loadToken = 0;
    let activeLoadController = null;
    let leftPaneRatio = loadStoredSplitRatio();
    let activeSplitDrag = null;
    let currentPreviewRow = null;
    let currentPreviewSupportsExternalDiff = false;

    function viewStateFromControls() {
      const nextMode = modeSelect.value;
      const preserveSelection = nextMode === currentViewState.mode;
      return {
        mode: nextMode,
        snapshotId: snapshotSelect.value,
        repoFilter: repoFilterSelect.value || "",
        compareShowAll: Boolean(compareShowAll.checked),
        inspectIncludeStaged: Boolean(inspectStaged.checked),
        inspectIncludeUnstaged: Boolean(inspectUnstaged.checked),
        inspectIncludeUntracked: Boolean(inspectUntracked.checked),
        inspectShowAllRepos: Boolean(inspectAllRepos.checked),
        selectedRepo: preserveSelection ? (currentViewState.selectedRepo || "") : "",
        selectedCategory: preserveSelection && nextMode === "inspect" ? (currentViewState.selectedCategory || "") : "",
        selectedFile: preserveSelection ? (currentViewState.selectedFile || "") : "",
      };
    }

    function queryForViewState(viewState) {
      const params = new URLSearchParams();
      params.set("mode", viewState.mode);
      params.set("snapshot_id", viewState.snapshotId || "");
      params.set("repo_filter", viewState.repoFilter || "");
      params.set("compare_show_all", viewState.compareShowAll ? "true" : "false");
      params.set("inspect_include_staged", viewState.inspectIncludeStaged ? "true" : "false");
      params.set("inspect_include_unstaged", viewState.inspectIncludeUnstaged ? "true" : "false");
      params.set("inspect_include_untracked", viewState.inspectIncludeUntracked ? "true" : "false");
      params.set("inspect_show_all_repos", viewState.inspectShowAllRepos ? "true" : "false");
      if (viewState.selectedFile) {
        params.set("selected_repo", viewState.selectedRepo || "");
        params.set("selected_file", viewState.selectedFile || "");
        if (viewState.mode === "inspect" && viewState.selectedCategory) {
          params.set("selected_category", viewState.selectedCategory);
        }
      }
      return params.toString();
    }

    function syncBrowserUrl(viewState) {
      try {
        const nextSearch = queryForViewState(viewState);
        const nextUrl = window.location.pathname + "?" + nextSearch + (window.location.hash || "");
        const currentUrl = window.location.pathname + window.location.search + window.location.hash;
        if (nextUrl === currentUrl) {
          return;
        }
        window.history.replaceState(null, "", nextUrl);
      } catch (_err) {
        // Ignore URL sync failures so the GUI itself stays usable.
      }
    }

    function rowButtons() {
      return Array.from(listEl.querySelectorAll(".row"));
    }

    function clamp(value, min, max) {
      return Math.min(Math.max(value, min), max);
    }

    function normalizePreviewText(text) {
      return String(text == null ? "" : text);
    }

    function loadStoredSplitRatio() {
      try {
        const raw = window.localStorage.getItem(SPLIT_STORAGE_KEY);
        if (!raw) return DEFAULT_SPLIT_RATIO;
        const parsed = Number(raw);
        if (!Number.isFinite(parsed)) return DEFAULT_SPLIT_RATIO;
        return clamp(parsed, MIN_SPLIT_RATIO, MAX_SPLIT_RATIO);
      } catch (_err) {
        return DEFAULT_SPLIT_RATIO;
      }
    }

    function saveSplitRatio(ratio) {
      try {
        window.localStorage.setItem(SPLIT_STORAGE_KEY, String(ratio));
      } catch (_err) {
        // Ignore localStorage failures; resizing should still work for this session.
      }
    }

    function splitRatioBounds() {
      const totalWidth = Math.max(0, (mainEl ? mainEl.clientWidth : 0) - SPLITTER_WIDTH_PX);
      if (totalWidth <= 0) {
        return { min: MIN_SPLIT_RATIO, max: MAX_SPLIT_RATIO };
      }

      const minRatioByWidth = 260 / totalWidth;
      const maxRatioByWidth = 1 - (320 / totalWidth);
      let min = Math.max(MIN_SPLIT_RATIO, minRatioByWidth);
      let max = Math.min(MAX_SPLIT_RATIO, maxRatioByWidth);

      if (!(min < max)) {
        min = 0.34;
        max = 0.66;
      }

      return { min, max };
    }

    function updateSplitterA11y(ratio, bounds) {
      const effectiveBounds = bounds || {
        min: MIN_SPLIT_RATIO,
        max: MAX_SPLIT_RATIO,
      };
      const boundedRatio = clamp(ratio, 0, 1);
      const percent = Math.round(boundedRatio * 100);
      const minPercent = Math.round(clamp(effectiveBounds.min, 0, 1) * 100);
      const maxPercent = Math.round(clamp(effectiveBounds.max, 0, 1) * 100);
      splitterEl.setAttribute("aria-valuemin", String(minPercent));
      splitterEl.setAttribute("aria-valuemax", String(maxPercent));
      splitterEl.setAttribute("aria-valuenow", String(percent));
      splitterEl.setAttribute("aria-valuetext", percent + "% file list width");
    }

    function canUseResizableSplit() {
      return Boolean(mainEl && splitterEl && !splitLayoutMedia.matches);
    }

    function applySplitRatio(nextRatio, persist) {
      leftPaneRatio = nextRatio;

      if (!canUseResizableSplit()) {
        mainEl.style.gridTemplateColumns = "";
        mainEl.style.gridTemplateRows = "";
        updateSplitterA11y(leftPaneRatio);
        if (persist) saveSplitRatio(leftPaneRatio);
        return;
      }

      const bounds = splitRatioBounds();
      const effectiveRatio = clamp(leftPaneRatio, bounds.min, bounds.max);
      leftPaneRatio = effectiveRatio;
      mainEl.style.gridTemplateColumns = (effectiveRatio * 100).toFixed(3) + "% " + SPLITTER_WIDTH_PX + "px minmax(0, 1fr)";
      mainEl.style.gridTemplateRows = "";
      updateSplitterA11y(effectiveRatio, bounds);
      if (persist) saveSplitRatio(effectiveRatio);
    }

    function nudgeSplit(delta) {
      if (!canUseResizableSplit()) return;
      applySplitRatio(leftPaneRatio + delta, true);
    }

    function applyResponsiveSplitLayout() {
      applySplitRatio(leftPaneRatio, false);
    }

    function resetSplitRatio() {
      applySplitRatio(DEFAULT_SPLIT_RATIO, true);
    }

    function beginSplitDrag(event) {
      if (!canUseResizableSplit()) return;
      if (event.button !== 0) return;

      event.preventDefault();
      activeSplitDrag = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: listEl.getBoundingClientRect().width,
      };
      splitterEl.classList.add("dragging");
      document.body.classList.add("resizing");
      if (typeof splitterEl.setPointerCapture === "function") {
        splitterEl.setPointerCapture(event.pointerId);
      }
    }

    function updateSplitDrag(event) {
      if (!activeSplitDrag || !canUseResizableSplit()) return;

      const totalWidth = Math.max(1, (mainEl.clientWidth || 0) - SPLITTER_WIDTH_PX);
      const nextWidth = activeSplitDrag.startWidth + (event.clientX - activeSplitDrag.startX);
      applySplitRatio(nextWidth / totalWidth, false);
    }

    function endSplitDrag(event) {
      if (!activeSplitDrag) return;

      if (event && typeof splitterEl.releasePointerCapture === "function") {
        try {
          splitterEl.releasePointerCapture(activeSplitDrag.pointerId);
        } catch (_err) {
          // Ignore if the pointer was already released.
        }
      }
      activeSplitDrag = null;
      splitterEl.classList.remove("dragging");
      document.body.classList.remove("resizing");
      applySplitRatio(leftPaneRatio, true);
    }

    function handleSplitterKeydown(event) {
      const smallStep = 0.02;
      const largeStep = 0.05;
      const step = event.shiftKey ? largeStep : smallStep;

      if (!canUseResizableSplit()) return;

      switch (event.key) {
        case "ArrowLeft":
          event.preventDefault();
          nudgeSplit(-step);
          return;
        case "ArrowRight":
          event.preventDefault();
          nudgeSplit(step);
          return;
        case "Home": {
          const bounds = splitRatioBounds();
          event.preventDefault();
          applySplitRatio(bounds.min, true);
          return;
        }
        case "End": {
          const bounds = splitRatioBounds();
          event.preventDefault();
          applySplitRatio(bounds.max, true);
          return;
        }
        case "0":
        case "Enter":
          event.preventDefault();
          resetSplitRatio();
          return;
        default:
          return;
      }
    }

    function normalizePreviewLines(text) {
      return normalizePreviewText(text)
        .split(CARRIAGE_RETURN_CHAR + NEWLINE_CHAR).join(NEWLINE_CHAR)
        .split(CARRIAGE_RETURN_CHAR).join(NEWLINE_CHAR)
        .split(NEWLINE_CHAR);
    }

    function looksLikeUnifiedDiff(text) {
      const lines = normalizePreviewLines(text);
      let hasDiffHeader = false;
      let hasOldHeader = false;
      let hasNewHeader = false;
      let hasHunkHeader = false;

      for (const line of lines) {
        if (!hasDiffHeader && line.startsWith("diff --git ")) hasDiffHeader = true;
        if (!hasOldHeader && line.startsWith("--- ")) hasOldHeader = true;
        if (!hasNewHeader && line.startsWith("+++ ")) hasNewHeader = true;
        if (!hasHunkHeader && line.startsWith("@@ ")) hasHunkHeader = true;
      }

      return hasDiffHeader || (hasOldHeader && hasNewHeader && hasHunkHeader);
    }

    function normalizeDiffPath(rawPath) {
      let out = String(rawPath || "").trim();
      if (!out) return "";
      if (out.startsWith(DOUBLE_QUOTE) && out.endsWith(DOUBLE_QUOTE)) {
        out = out.slice(1, -1);
      }
      out = out
        .split(BACKSLASH + BACKSLASH).join(BACKSLASH)
        .split(BACKSLASH + DOUBLE_QUOTE).join(DOUBLE_QUOTE)
        .split(BACKSLASH + "t").join(TAB_CHAR)
        .split(BACKSLASH + "n").join(NEWLINE_CHAR);
      if (out.startsWith("a/") || out.startsWith("b/")) {
        out = out.slice(2);
      }
      return out;
    }

    function displayPathFromMeta(oldLabel, newLabel) {
      const nextLabel = normalizeDiffPath(newLabel);
      if (nextLabel && nextLabel !== "/dev/null") return nextLabel;
      const previousLabel = normalizeDiffPath(oldLabel);
      if (previousLabel && previousLabel !== "/dev/null") return previousLabel;
      return "";
    }

    function parseUnifiedDiffFiles(text) {
      const lines = normalizePreviewLines(text);
      const files = [];
      let currentFile = null;
      let currentHunk = null;

      function ensureCurrentFile() {
        if (!currentFile) {
          currentFile = {
            displayPath: "",
            oldLabel: "",
            newLabel: "",
            metaLines: [],
            hunks: [],
          };
          files.push(currentFile);
        }
        return currentFile;
      }

      for (const line of lines) {
        if (line.startsWith("diff --git ")) {
          currentFile = {
            displayPath: "",
            oldLabel: "",
            newLabel: "",
            metaLines: [line],
            hunks: [],
          };
          files.push(currentFile);
          currentHunk = null;
          continue;
        }
        if (line.startsWith("--- ")) {
          const target = ensureCurrentFile();
          target.oldLabel = line.slice(4);
          target.metaLines.push(line);
          const displayPath = displayPathFromMeta(target.oldLabel, target.newLabel);
          if (displayPath) target.displayPath = displayPath;
          continue;
        }
        if (line.startsWith("+++ ")) {
          const target = ensureCurrentFile();
          target.newLabel = line.slice(4);
          target.metaLines.push(line);
          const displayPath = displayPathFromMeta(target.oldLabel, target.newLabel);
          if (displayPath) target.displayPath = displayPath;
          continue;
        }
        if (line.startsWith("@@ ")) {
          const target = ensureCurrentFile();
          currentHunk = {
            header: line,
            lines: [],
          };
          target.hunks.push(currentHunk);
          continue;
        }
        if (currentHunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-") || line.startsWith(BACKSLASH))) {
          currentHunk.lines.push(line);
          continue;
        }
        if (currentFile) {
          currentFile.metaLines.push(line);
        } else if (line.trim() !== "") {
          return [];
        }
      }

      return files.filter((file) => file.hunks.length > 0);
    }

    function parseHunkStart(header) {
      const parts = String(header || "").split(" ");
      if (parts.length < 3 || parts[0] !== "@@" || parts[3] !== "@@") {
        return { oldLine: null, newLine: null };
      }

      const oldToken = parts[1].startsWith("-") ? parts[1].slice(1) : "";
      const newToken = parts[2].startsWith("+") ? parts[2].slice(1) : "";
      const oldLine = Number(oldToken.split(",")[0]);
      const newLine = Number(newToken.split(",")[0]);

      if (!Number.isFinite(oldLine) || !Number.isFinite(newLine)) {
        return { oldLine: null, newLine: null };
      }

      return {
        oldLine,
        newLine,
      };
    }

    function renderPlainPreview(text, options) {
      const previewText = normalizePreviewText(text);
      diffEl.className = "diff-view";
      if (options && options.loading) {
        diffEl.classList.add("loading");
      }
      const pre = document.createElement("pre");
      pre.className = "preview-pre";
      if (options && options.className) {
        pre.classList.add(options.className);
      }
      pre.textContent = previewText;
      diffEl.replaceChildren(pre);
      if (previewPanelEl) {
        previewPanelEl.scrollTop = 0;
        previewPanelEl.scrollLeft = 0;
      }
    }

    function submoduleRelationDirection(text) {
      const value = String(text || "");
      if (/\\bahead\\b/.test(value)) return "ahead";
      if (/\\bbehind\\b/.test(value)) return "behind";
      return "";
    }

    function renderSubmoduleFieldValue(field) {
      const valueNode = document.createElement("div");
      valueNode.className = "submodule-summary-field-value";
      const valueText = String(field && field.value ? field.value : "");

      if (String(field && field.label ? field.label : "") === "Relation") {
        const direction = submoduleRelationDirection(valueText);
        if (direction) {
          const match = valueText.match(/\\b(ahead|behind)\\b/);
          if (match && Number.isFinite(match.index)) {
            const beforeText = valueText.slice(0, match.index);
            const keywordText = match[0];
            const afterText = valueText.slice(match.index + keywordText.length);

            if (beforeText) {
              valueNode.appendChild(document.createTextNode(beforeText));
            }

            const keywordNode = document.createElement("span");
            keywordNode.className = "submodule-relation-keyword " + direction;
            keywordNode.textContent = keywordText;
            valueNode.appendChild(keywordNode);

            if (afterText) {
              valueNode.appendChild(document.createTextNode(afterText));
            }

            return { node: valueNode, direction };
          }
        }
      }

      valueNode.textContent = valueText;
      return { node: valueNode, direction: "" };
    }

    function renderSubmoduleSummary(summary) {
      const data = summary && typeof summary === "object" ? summary : {};
      diffEl.className = "diff-view";

      const card = document.createElement("section");
      card.className = "submodule-summary";

      const header = document.createElement("div");
      header.className = "submodule-summary-header";

      const top = document.createElement("div");
      top.className = "submodule-summary-top";

      const titleGroup = document.createElement("div");
      const eyebrow = document.createElement("div");
      eyebrow.className = "submodule-summary-eyebrow";
      eyebrow.textContent = "Submodule summary";
      titleGroup.appendChild(eyebrow);

      const pathNode = document.createElement("div");
      pathNode.className = "submodule-summary-path";
      pathNode.textContent = String(data.path || "(unknown submodule path)");
      titleGroup.appendChild(pathNode);
      top.appendChild(titleGroup);

      if (data.status) {
        const statusNode = document.createElement("span");
        statusNode.className = "list-pill status-pill " + compareStatusTone(data.status) + " " + compareStatusClassName(data.status);
        statusNode.textContent = compareStatusLabel(data.status);
        top.appendChild(statusNode);
      }

      header.appendChild(top);
      card.appendChild(header);

      const body = document.createElement("div");
      body.className = "submodule-summary-body";

      if (data.summary) {
        const lead = document.createElement("div");
        lead.className = "submodule-summary-lead";
        lead.textContent = String(data.summary);
        body.appendChild(lead);
      }

      const fields = Array.isArray(data.fields) ? data.fields.filter((field) => field && field.label) : [];
      if (fields.length) {
        const grid = document.createElement("div");
        grid.className = "submodule-summary-grid";
        fields.forEach((field) => {
          const fieldNode = document.createElement("div");
          fieldNode.className = "submodule-summary-field";

          const labelNode = document.createElement("div");
          labelNode.className = "submodule-summary-field-label";
          labelNode.textContent = String(field.label);
          fieldNode.appendChild(labelNode);

          const renderedValue = renderSubmoduleFieldValue(field);
          if (renderedValue.direction) {
            fieldNode.classList.add("submodule-summary-field-relation", "relation-" + renderedValue.direction);
          }
          fieldNode.appendChild(renderedValue.node);

          grid.appendChild(fieldNode);
        });
        body.appendChild(grid);
      }

      const sections = Array.isArray(data.sections) ? data.sections.filter((section) => section && section.title) : [];
      sections.forEach((section) => {
        const sectionNode = document.createElement("div");
        sectionNode.className = "submodule-summary-section";

        const titleNode = document.createElement("div");
        titleNode.className = "submodule-summary-section-title";
        titleNode.textContent = String(section.title);
        sectionNode.appendChild(titleNode);

        const commits = Array.isArray(section.commits) ? section.commits.filter(Boolean) : [];
        if (commits.length) {
          const list = document.createElement("ul");
          list.className = "submodule-summary-commits";
          commits.forEach((commitLine) => {
            const item = document.createElement("li");
            item.textContent = String(commitLine);
            list.appendChild(item);
          });
          sectionNode.appendChild(list);
        }

        body.appendChild(sectionNode);
      });

      const notes = Array.isArray(data.notes) ? data.notes.filter(Boolean) : [];
      if (notes.length) {
        const notesWrap = document.createElement("div");
        notesWrap.className = "submodule-summary-notes";
        notes.forEach((note) => {
          const noteNode = document.createElement("div");
          noteNode.className = "submodule-summary-note";
          noteNode.textContent = String(note);
          notesWrap.appendChild(noteNode);
        });
        body.appendChild(notesWrap);
      }

      card.appendChild(body);
      diffEl.replaceChildren(card);
      if (previewPanelEl) {
        previewPanelEl.scrollTop = 0;
        previewPanelEl.scrollLeft = 0;
      }
    }

    function appendMetaLine(parent, text) {
      const line = String(text || "").trim();
      if (!line) return;
      const metaLine = document.createElement("div");
      metaLine.className = "diff-file-meta-line";
      metaLine.textContent = line;
      parent.appendChild(metaLine);
    }

    function createDiffChip(text, className, title) {
      const chip = document.createElement("span");
      chip.className = "diff-file-chip" + (className ? " " + className : "");
      chip.textContent = String(text || "");
      if (title) {
        chip.title = String(title);
      }
      return chip;
    }

    function compareDiffLegendSpecs(row) {
      const status = String(row && row.status ? row.status : "");
      if (status === "unresolved_missing") {
        return [
          {
            text: "+ restore missing snapshot content",
            className: "diff-file-chip-add",
            title: "Green + lines are content captured in the snapshot for a path that is currently missing from the working tree.",
          },
          {
            text: "current copy missing",
            className: "diff-file-chip-note",
            title: "This preview is snapshot-only because the current working-tree copy is missing.",
          },
        ];
      }
      if (status === "unresolved_diverged") {
        return [
          {
            text: "+ restore snapshot content",
            className: "diff-file-chip-add",
            title: "Green + lines are content the snapshot would add or restore to bring the working tree back to the snapshot target.",
          },
          {
            text: "- remove current-only content",
            className: "diff-file-chip-delete",
            title: "Red - lines are content that exists only in the current working tree and would be removed or replaced to match the snapshot.",
          },
        ];
      }
      return [
        {
          text: "+ snapshot adds",
          className: "diff-file-chip-add",
          title: "Green + lines exist in the snapshot target and would be added or restored from the snapshot.",
        },
        {
          text: "- snapshot removes",
          className: "diff-file-chip-delete",
          title: "Red - lines exist only in the current working tree and would be removed to match the snapshot.",
        },
      ];
    }

    function inspectDiffLegendSpecs(row) {
      const category = String(row && row.category ? row.category : "");
      if (category === "staged") {
        return [
          {
            text: "+ captured staged additions",
            className: "diff-file-chip-add",
            title: "Green + lines are additions captured in the snapshot's staged patch for this file.",
          },
          {
            text: "- captured staged removals",
            className: "diff-file-chip-delete",
            title: "Red - lines are removals or replaced lines captured in the snapshot's staged patch for this file.",
          },
        ];
      }
      if (category === "unstaged") {
        return [
          {
            text: "+ captured unstaged additions",
            className: "diff-file-chip-add",
            title: "Green + lines are additions captured in the snapshot's unstaged working-tree patch for this file.",
          },
          {
            text: "- captured unstaged removals",
            className: "diff-file-chip-delete",
            title: "Red - lines are removals or replaced lines captured in the snapshot's unstaged working-tree patch for this file.",
          },
        ];
      }
      return [];
    }

    function diffLegendSpecsForCurrentPreview() {
      if (!currentPreviewRow) return [];
      if (currentViewState.mode === "inspect") {
        return inspectDiffLegendSpecs(currentPreviewRow);
      }
      return compareDiffLegendSpecs(currentPreviewRow);
    }

    function buildDiffRow(type, oldLine, newLine, text) {
      const row = document.createElement("tr");
      row.className = "diff-line " + type;

      const oldCell = document.createElement("td");
      oldCell.className = "diff-gutter";
      oldCell.textContent = oldLine == null ? "" : String(oldLine);
      row.appendChild(oldCell);

      const newCell = document.createElement("td");
      newCell.className = "diff-gutter";
      newCell.textContent = newLine == null ? "" : String(newLine);
      row.appendChild(newCell);

      const codeCell = document.createElement("td");
      codeCell.className = "diff-code";
      const codeText = document.createElement("span");
      codeText.textContent = text;
      codeCell.appendChild(codeText);
      row.appendChild(codeCell);

      return row;
    }

    function renderStructuredDiff(text) {
      const files = parseUnifiedDiffFiles(text);
      if (!files.length) return false;

      diffEl.className = "diff-view rendered-diff";
      const fragments = [];
      const legendSpecs = diffLegendSpecsForCurrentPreview();

      files.forEach((file, index) => {
        const fileNode = document.createElement("section");
        fileNode.className = "diff-file";

        const header = document.createElement("div");
        header.className = "diff-file-header";

        const title = document.createElement("div");
        title.className = "diff-file-title";
        title.textContent = file.displayPath || "diff-preview-" + String(index + 1);
        header.appendChild(title);

        header.appendChild(createDiffChip(
          file.hunks.length + " hunk" + (file.hunks.length === 1 ? "" : "s")
        ));
        legendSpecs.forEach((spec) => {
          header.appendChild(createDiffChip(spec.text, spec.className, spec.title));
        });

        fileNode.appendChild(header);

        const meta = document.createElement("div");
        meta.className = "diff-file-meta";
        appendMetaLine(meta, "from " + (normalizeDiffPath(file.oldLabel) || "/dev/null"));
        appendMetaLine(meta, "to " + (normalizeDiffPath(file.newLabel) || "/dev/null"));
        file.metaLines
          .filter((line) => line && !line.startsWith("--- ") && !line.startsWith("+++ ") && !line.startsWith("diff --git "))
          .forEach((line) => appendMetaLine(meta, line));
        fileNode.appendChild(meta);

        const tableWrap = document.createElement("div");
        tableWrap.className = "diff-table-wrap";
        const table = document.createElement("table");
        table.className = "diff-table";
        const body = document.createElement("tbody");

        for (const hunk of file.hunks) {
          body.appendChild(buildDiffRow("hunk", null, null, hunk.header));
          const start = parseHunkStart(hunk.header);
          let oldLine = start.oldLine;
          let newLine = start.newLine;

          for (const line of hunk.lines) {
            if (line.startsWith("+")) {
              body.appendChild(buildDiffRow("add", null, newLine, line));
              newLine += 1;
              continue;
            }
            if (line.startsWith("-")) {
              body.appendChild(buildDiffRow("delete", oldLine, null, line));
              oldLine += 1;
              continue;
            }
            if (line.startsWith(BACKSLASH)) {
              body.appendChild(buildDiffRow("note", null, null, line));
              continue;
            }
            body.appendChild(buildDiffRow("context", oldLine, newLine, line));
            oldLine += 1;
            newLine += 1;
          }
        }

        table.appendChild(body);
        tableWrap.appendChild(table);
        fileNode.appendChild(tableWrap);
        fragments.push(fileNode);
      });

      diffEl.replaceChildren(...fragments);
      if (previewPanelEl) {
        previewPanelEl.scrollTop = 0;
        previewPanelEl.scrollLeft = 0;
      }
      return true;
    }

    function uniqueStrings(values) {
      const seen = new Set();
      const out = [];
      for (const value of values || []) {
        const text = String(value || "");
        if (!text || seen.has(text)) continue;
        seen.add(text);
        out.push(text);
      }
      return out;
    }

    function rowSelectionKey(row) {
      const mode = currentViewState.mode;
      return [mode, row.repo || "", row.category || "", row.file || ""].join("\\t");
    }

    function selectionKeyFromViewState(viewState) {
      if (!viewState || !viewState.selectedFile) return "";
      return [
        viewState.mode || "",
        viewState.selectedRepo || "",
        viewState.mode === "inspect" ? (viewState.selectedCategory || "") : "",
        viewState.selectedFile || "",
      ].join("\\t");
    }

    function clearSelectedRowInViewState() {
      currentViewState.selectedRepo = "";
      currentViewState.selectedCategory = "";
      currentViewState.selectedFile = "";
    }

    function setSelectedRowInViewState(row) {
      if (!row) {
        clearSelectedRowInViewState();
        return;
      }
      currentViewState.selectedRepo = String(row.repo || "");
      currentViewState.selectedFile = String(row.file || "");
      currentViewState.selectedCategory = currentViewState.mode === "inspect" ? String(row.category || "") : "";
    }

    function findCurrentRowBySelectionKey() {
      if (!currentData || !selectionKeyValue) return null;
      if (currentViewState.mode === "compare") {
        return (currentData.rows || []).find((row) => rowSelectionKey(row) === selectionKeyValue) || null;
      }
      return (currentData.fileRows || []).find((row) => rowSelectionKey(row) === selectionKeyValue) || null;
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
      const prefix = currentViewState.mode === "compare" ? "Loading diff for " : "Loading preview for ";
      renderPlainPreview(prefix + (row.repo || "") + "/" + (row.file || "") + "...", {
        className: "loading",
        loading: true,
      });
    }

    function setDiffText(text) {
      const previewText = normalizePreviewText(text);
      if (looksLikeUnifiedDiff(previewText) && renderStructuredDiff(previewText)) {
        return;
      }
      if (currentViewState.mode === "compare") {
        renderPlainPreview(previewText);
        return;
      }
      renderPlainPreview(previewText);
    }

    function appendListMessageNode(message, className, afterHeader) {
      const node = document.createElement("div");
      node.className = className || "empty";
      if (afterHeader) {
        node.classList.add("after-header");
      }
      node.textContent = String(message || "");
      listEl.appendChild(node);
    }

    function setListMessage(message, className) {
      listEl.innerHTML = "";
      appendListMessageNode(message, className, false);
    }

    function setListLoading(message) {
      setListMessage(message || "Loading...", "empty loading");
    }

    function setListError(message) {
      setListMessage(message, "empty error");
    }

    function repoScopeText(value) {
      return value ? value : "(all repos)";
    }

    function controlVisibleRowsLabel(viewState) {
      return viewState.compareShowAll ? "all statuses" : "unresolved only";
    }

    function inspectCategoryLabel(viewState) {
      const out = [];
      if (viewState.inspectIncludeStaged) out.push("staged");
      if (viewState.inspectIncludeUnstaged) out.push("unstaged");
      if (viewState.inspectIncludeUntracked) out.push("untracked");
      return out.join(", ");
    }

    function compareStatusLabel(status) {
      return String(status || "").split("_").join(" ");
    }

    function compareStatusReasonDetail(row) {
      const status = String(row && row.status ? row.status : "");
      const reason = String(row && row.reason ? row.reason : "").trim();
      if (!reason) return "";

      const genericReasons = {
        resolved_committed: "snapshot target content and mode match HEAD and working tree",
        resolved_uncommitted: "snapshot target content and mode match working tree but not HEAD",
        unresolved_missing: "snapshot target path is missing from working tree",
        unresolved_diverged: "current content or mode diverges from snapshot target",
      };
      if (reason === genericReasons[status]) {
        return "";
      }
      if (reason.startsWith("repo missing at ")) {
        return "The repository is missing at " + reason.slice("repo missing at ".length) + ".";
      }
      if (reason === "path still exists while snapshot target removes it") {
        return "The path still exists locally, but the snapshot expects it to be removed.";
      }
      return "Detail: " + reason + ".";
    }

    function compareStatusTooltip(row) {
      const status = String(row && row.status ? row.status : "");
      const descriptions = {
        resolved_committed: "Already resolved. The snapshot matches both HEAD and the working tree.",
        resolved_uncommitted: "Resolved in the working tree. HEAD still differs from the snapshot.",
        unresolved_missing: "Missing in the working tree. The snapshot still has content for this path.",
        unresolved_diverged: "Still diverged. The working tree does not match the snapshot content or mode.",
      };
      const description = descriptions[status] || compareStatusLabel(status);
      const detail = compareStatusReasonDetail(row);
      return detail ? description + " " + detail : description;
    }

    function compareStatusTone(status) {
      return String(status || "").startsWith("resolved_") ? "resolved" : "unresolved";
    }

    function compareStatusClassName(status) {
      return "status-" + String(status || "unknown").split("_").join("-");
    }

    function createCompareRowContent(row) {
      const content = document.createElement("span");
      content.className = "row-content";

      const fileNode = document.createElement("span");
      fileNode.className = "row-file";
      fileNode.textContent = row.file || "(unknown)";
      content.appendChild(fileNode);

      const statusNode = document.createElement("span");
      statusNode.className = "list-pill status-pill " + compareStatusTone(row.status) + " " + compareStatusClassName(row.status);
      statusNode.textContent = compareStatusLabel(row.status);
      statusNode.title = compareStatusTooltip(row);
      content.appendChild(statusNode);

      return content;
    }

    function titleSnapshotId(data) {
      if (currentViewState.mode === "compare") {
        return (data && data.targetFields && data.targetFields.selected_snapshot_id) || currentViewState.snapshotId || "?";
      }
      return (data && data.targetFields && data.targetFields.snapshot_id) || currentViewState.snapshotId || "?";
    }

    function currentDocumentTitle(data) {
      const parts = [
        "git-snapshot",
        currentViewState.mode,
        titleSnapshotId(data),
        repoScopeText(currentViewState.repoFilter),
      ];
      if (currentViewState.mode === "compare") {
        parts.push(controlVisibleRowsLabel(currentViewState));
      } else {
        parts.push(inspectCategoryLabel(currentViewState));
        parts.push(inspectRepoScopeLabel());
      }
      return parts.filter(Boolean).join(" · ");
    }

    function updateDocumentTitle(data) {
      document.title = currentDocumentTitle(data);
    }

    function syncOpenButtonState() {
      const selectedRow = findCurrentRowBySelectionKey();
      openBtn.disabled = currentViewState.mode !== "compare" || !selectedRow || !currentPreviewSupportsExternalDiff;
    }

    function applyModeVisibility() {
      document.querySelectorAll(".mode-compare").forEach((node) => {
        node.classList.toggle("hidden", currentViewState.mode !== "compare");
      });
      document.querySelectorAll(".mode-inspect").forEach((node) => {
        node.classList.toggle("hidden", currentViewState.mode !== "inspect");
      });
      openBtn.classList.toggle("hidden", currentViewState.mode !== "compare");
      syncOpenButtonState();
      inspectSummaryPanel.classList.toggle("hidden", currentViewState.mode !== "inspect");
    }

    function renderInspectSummary() {
      if (currentViewState.mode !== "inspect" || !currentData) {
        inspectSummaryPanel.classList.add("hidden");
        inspectSummaryBody.replaceChildren();
        return;
      }

      const repoRows = Array.isArray(currentData.visibleRepoRows) ? currentData.visibleRepoRows : [];
      const selectedRow = findCurrentRowBySelectionKey();
      let selectedRepo = selectedRow ? selectedRow.repo || "" : (currentViewState.repoFilter || "");
      if (!selectedRepo && repoRows.length > 0) {
        selectedRepo = repoRows[0].repo || "";
      }

      const repoSummary = repoRows.find((row) => (row.repo || "") === selectedRepo) || null;
      if (!repoSummary) {
        inspectSummaryPanel.classList.add("hidden");
        inspectSummaryBody.replaceChildren();
        return;
      }

      inspectSummaryPanel.classList.remove("hidden");
      const fields = [
        ["repo", repoSummary.repo || "?"],
        ["relation", repoSummary.relation || "?"],
        ["branch", repoSummary.current_branch || "?"],
        ["apply staged", repoSummary.apply_check_staged || "?"],
        ["apply unstaged", repoSummary.apply_check_unstaged || "?"],
        ["collisions", repoSummary.untracked_collision_count || "0"],
        ["snapshot head", repoSummary.snapshot_head || "?"],
        ["current head", repoSummary.current_head || "?"],
      ];
      const rows = fields.map(([label, value]) => {
        const row = document.createElement("div");
        const labelNode = document.createElement("strong");
        labelNode.textContent = label + ":";
        row.appendChild(labelNode);
        row.appendChild(document.createTextNode(" " + value));
        return row;
      });
      inspectSummaryBody.replaceChildren(...rows);
    }

    function buildRepoOptions(viewState, data) {
      const availableRepos = Array.isArray(data.availableRepos) ? data.availableRepos.slice() : [];
      if (viewState.mode === "inspect" && Array.isArray(data.visibleRepoRows)) {
        return uniqueStrings(data.visibleRepoRows.map((row) => row.repo || "").concat(availableRepos));
      }
      return uniqueStrings(availableRepos);
    }

    function updateRepoFilterOptions(viewState, data) {
      const repoOptions = buildRepoOptions(viewState, data);
      const currentValue = viewState.repoFilter || "";
      repoFilterSelect.innerHTML = "";
      const allOption = document.createElement("option");
      allOption.value = "";
      allOption.textContent = "(all repos)";
      repoFilterSelect.appendChild(allOption);
      for (const repo of repoOptions) {
        const option = document.createElement("option");
        option.value = repo;
        option.textContent = repo;
        repoFilterSelect.appendChild(option);
      }
      if (currentValue && !repoOptions.includes(currentValue)) {
        const option = document.createElement("option");
        option.value = currentValue;
        option.textContent = currentValue;
        repoFilterSelect.appendChild(option);
      }
      repoFilterSelect.value = currentValue;
    }

    function updateSnapshotOptions(currentSnapshotId) {
      const previous = currentSnapshotId || currentViewState.snapshotId;
      snapshotSelect.innerHTML = "";
      for (const snapshot of snapshots) {
        const option = document.createElement("option");
        option.value = snapshot.id || "";
        const origin = snapshot.origin === "auto" ? " [auto]" : "";
        option.textContent = (snapshot.id || "") + origin;
        snapshotSelect.appendChild(option);
      }
      if (previous && !snapshots.some((snapshot) => snapshot.id === previous)) {
        const option = document.createElement("option");
        option.value = previous;
        option.textContent = previous;
        snapshotSelect.appendChild(option);
      }
      snapshotSelect.value = previous || "";
    }

    function setControlsFromViewState(viewState, data) {
      currentViewState = Object.assign({}, viewState);
      selectionKeyValue = selectionKeyFromViewState(currentViewState);
      modeSelect.value = currentViewState.mode;
      compareShowAll.checked = Boolean(currentViewState.compareShowAll);
      inspectStaged.checked = Boolean(currentViewState.inspectIncludeStaged);
      inspectUnstaged.checked = Boolean(currentViewState.inspectIncludeUnstaged);
      inspectUntracked.checked = Boolean(currentViewState.inspectIncludeUntracked);
      inspectAllRepos.checked = Boolean(currentViewState.inspectShowAllRepos);
      updateSnapshotOptions(currentViewState.snapshotId);
      if (data) {
        updateRepoFilterOptions(currentViewState, data);
      } else {
        repoFilterSelect.innerHTML = "<option value=''>"+ "(all repos)" + "</option>";
        if (currentViewState.repoFilter) {
          const option = document.createElement("option");
          option.value = currentViewState.repoFilter;
          option.textContent = currentViewState.repoFilter;
          repoFilterSelect.appendChild(option);
        }
        repoFilterSelect.value = currentViewState.repoFilter || "";
      }
      applyModeVisibility();
    }

    function renderLoadFailure(error, mode) {
      const activeMode = mode || currentViewState.mode;
      const message = error && error.message ? error.message : String(error);
      currentData = null;
      selectionKeyValue = "";
      currentPreviewRow = null;
      currentPreviewSupportsExternalDiff = false;
      previewToken += 1;
      emptyStateMessage = "No rows to display.";
      syncOpenButtonState();
      if (activeMode === "compare") {
        metaEl.textContent = "Compare data unavailable.";
        summaryEl.textContent = message;
        setListError("Failed to load compare rows: " + message);
        setDiffText("Unable to load compare rows.");
      } else {
        metaEl.textContent = "Inspect data unavailable.";
        summaryEl.textContent = message;
        setListError("Failed to load inspect rows: " + message);
        setDiffText("Unable to load inspect rows.");
      }
      updateDocumentTitle(null);
      renderInspectSummary();
    }

    function renderBootstrapFailure(error) {
      const message = error && error.stack ? error.stack : (error && error.message ? error.message : String(error));
      currentData = null;
      selectionKeyValue = "";
      currentPreviewRow = null;
      currentPreviewSupportsExternalDiff = false;
      syncOpenButtonState();
      metaEl.textContent = "GUI bootstrap failed.";
      summaryEl.textContent = message;
      setListError("GUI bootstrap failed: " + message);
      renderPlainPreview("GUI bootstrap failed." + NEWLINE_CHAR + message, { className: "error" });
      inspectSummaryPanel.classList.add("hidden");
      inspectSummaryBody.replaceChildren();
      document.title = "git-snapshot GUI bootstrap failed";
      console.error(error);
    }

    function isAbortError(error) {
      return Boolean(error && (error.name === "AbortError" || error.message === "The operation was aborted."));
    }

    function renderMetaAndSummary(data) {
      if (currentViewState.mode === "compare") {
        const t = data.targetFields || {};
        const s = data.summaryFields || {};
        metaEl.textContent =
          "Snapshot: " + (t.selected_snapshot_id || currentViewState.snapshotId || "?") +
          " | Mode: compare" +
          " | Repo filter: " + repoScopeText(currentViewState.repoFilter) +
          " | Rows: " + controlVisibleRowsLabel(currentViewState);
        summaryEl.textContent =
          "repos_checked=" + (s.repos_checked || "?") +
          " files_total=" + (s.files_total || "?") +
          " unresolved_total=" + (s.unresolved_total || "?") +
          " shown_files=" + (s.shown_files || "?");
      } else {
        const t = data.targetFields || {};
        metaEl.textContent =
          "Snapshot: " + (t.snapshot_id || currentViewState.snapshotId || "?") +
          " | Mode: inspect" +
          " | Repo filter: " + repoScopeText(currentViewState.repoFilter) +
          " | Categories: " + inspectCategoryLabel(currentViewState);
        summaryEl.textContent =
          "repos_in_scope=" + (t.repos_in_scope || "?") +
          " repos_with_changes=" + (t.repos_with_changes || "?") +
          " total_staged=" + (t.total_staged || "?") +
          " total_unstaged=" + (t.total_unstaged || "?") +
          " total_untracked=" + (t.total_untracked || "?");
      }
      updateDocumentTitle(data);
    }

    function displaySummaryValue(value, fallback) {
      if (value === undefined || value === null || value === "") {
        if (fallback === undefined) {
          return "?";
        }
        return String(fallback);
      }
      return String(value);
    }

    function createListPill(label, value, primary) {
      const pill = document.createElement("div");
      pill.className = primary ? "list-pill primary" : "list-pill";
      const valueNode = document.createElement("strong");
      valueNode.textContent = displaySummaryValue(value);
      pill.appendChild(valueNode);
      pill.appendChild(document.createTextNode(" " + String(label || "")));
      return pill;
    }

    function createListHeader(title, contextText, pills) {
      const header = document.createElement("div");
      header.className = "list-header";

      const topRow = document.createElement("div");
      topRow.className = "list-header-top";

      const titleNode = document.createElement("div");
      titleNode.className = "list-title";
      titleNode.textContent = String(title || "");
      topRow.appendChild(titleNode);

      const contextNode = document.createElement("div");
      contextNode.className = "list-context";
      const safeContextText = String(contextText || "");
      contextNode.textContent = safeContextText;
      contextNode.title = safeContextText;
      topRow.appendChild(contextNode);
      header.appendChild(topRow);

      const pillSpecs = Array.isArray(pills) ? pills.filter((pill) => pill && pill.label) : [];
      if (!pillSpecs.length) {
        return header;
      }

      const stats = document.createElement("div");
      stats.className = "list-stats";
      for (const pill of pillSpecs) {
        stats.appendChild(createListPill(pill.label, pill.value, Boolean(pill.primary)));
      }
      header.appendChild(stats);
      return header;
    }

    function compareListContext(data) {
      const targetFields = data && data.targetFields ? data.targetFields : {};
      const snapshotId = targetFields.selected_snapshot_id || currentViewState.snapshotId || "?";
      return [
        snapshotId,
        "compare",
        repoScopeText(currentViewState.repoFilter),
        controlVisibleRowsLabel(currentViewState),
      ].join(" · ");
    }

    function inspectRepoScopeLabel() {
      if (currentViewState.repoFilter) {
        return "selected repo";
      }
      return currentViewState.inspectShowAllRepos ? "all repos" : "repos with changes";
    }

    function inspectListContext(data) {
      const targetFields = data && data.targetFields ? data.targetFields : {};
      const snapshotId = targetFields.snapshot_id || currentViewState.snapshotId || "?";
      return [
        snapshotId,
        "inspect",
        repoScopeText(currentViewState.repoFilter),
        inspectRepoScopeLabel(),
        inspectCategoryLabel(currentViewState),
      ].join(" · ");
    }

    function renderListHeader(data) {
      if (!data) return null;

      if (currentViewState.mode === "compare") {
        const summary = data.summaryFields || {};
        const rows = Array.isArray(data.rows) ? data.rows : [];
        return createListHeader("Snapshot rows", compareListContext(data), [
          { label: "shown", value: summary.shown_files, primary: true },
          { label: "unresolved", value: summary.unresolved_total, fallback: rows.length },
          { label: "files", value: summary.files_total, fallback: rows.length },
          { label: "repos", value: summary.repos_checked },
        ].map((pill) => {
          return {
            label: pill.label,
            value: displaySummaryValue(pill.value, pill.fallback),
            primary: pill.primary,
          };
        }));
      }

      const targetFields = data.targetFields || {};
      const visibleRepoRows = Array.isArray(data.visibleRepoRows) ? data.visibleRepoRows : [];
      const visibleFileRows = Array.isArray(data.fileRows) ? data.fileRows : [];
      return createListHeader("Snapshot contents", inspectListContext(data), [
        { label: "files", value: visibleFileRows.length, primary: true },
        { label: "repos", value: visibleRepoRows.length },
        { label: "staged", value: targetFields.total_staged || 0 },
        { label: "unstaged", value: targetFields.total_unstaged || 0 },
        { label: "untracked", value: targetFields.total_untracked || 0 },
      ]);
    }

    function renderCompareList(data) {
      const rows = Array.isArray(data.rows) ? data.rows : [];
      listEl.innerHTML = "";
      const header = renderListHeader(data);
      if (header) {
        listEl.appendChild(header);
      }
      if (!rows.length) {
        appendListMessageNode(emptyStateMessage, "empty", Boolean(header));
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
          rowNode.setAttribute("aria-label", (row.file || "(unknown)") + " [" + (row.status || "") + "]");
          rowNode.dataset.rowKey = rowSelectionKey(row);
          rowNode.appendChild(createCompareRowContent(row));
          rowNode.onclick = () => selectRow(row, rowNode);
          rowNode.onkeydown = (event) => handleRowKeydown(event, rowNode);
          if (rowSelectionKey(row) === selectionKeyValue) {
            rowNode.classList.add("active");
            rowNode.setAttribute("aria-selected", "true");
          }
          listEl.appendChild(rowNode);
        }
      }
    }

    function renderInspectList(data) {
      listEl.innerHTML = "";
      const header = renderListHeader(data);
      if (header) {
        listEl.appendChild(header);
      }
      const repoRows = Array.isArray(data.visibleRepoRows) ? data.visibleRepoRows : [];
      const fileRows = Array.isArray(data.fileRows) ? data.fileRows : [];
      const categoryCounts = data.categoryCounts || {};
      if (!repoRows.length) {
        appendListMessageNode(emptyStateMessage, "empty", Boolean(header));
        return;
      }

      for (const repoRow of repoRows) {
        const repo = repoRow.repo || "";
        const repoNode = document.createElement("div");
        repoNode.className = "repo";
        repoNode.textContent = repo;
        listEl.appendChild(repoNode);

        const repoFiles = fileRows.filter((row) => (row.repo || "") === repo);
        if (!repoFiles.length) {
          const emptyNode = document.createElement("div");
          emptyNode.className = "repo-empty";
          emptyNode.textContent = "No captured files for the selected categories.";
          listEl.appendChild(emptyNode);
          continue;
        }

        for (const category of ["staged", "unstaged", "untracked"]) {
          const categoryFiles = repoFiles.filter((row) => (row.category || "") === category);
          if (!categoryFiles.length) continue;
          const categoryNode = document.createElement("div");
          categoryNode.className = "category";
          categoryNode.textContent = category + " (" + String(categoryCounts[repo + "\\t" + category] || categoryFiles.length) + ")";
          listEl.appendChild(categoryNode);

          for (const row of categoryFiles) {
          const rowNode = document.createElement("button");
          rowNode.type = "button";
          rowNode.className = "row";
          rowNode.setAttribute("aria-selected", "false");
          rowNode.setAttribute("aria-label", row.file || "(unknown)");
          rowNode.dataset.rowKey = rowSelectionKey(row);
          rowNode.textContent = row.file || "(unknown)";
          rowNode.onclick = () => selectRow(row, rowNode);
          rowNode.onkeydown = (event) => handleRowKeydown(event, rowNode);
          if (rowSelectionKey(row) === selectionKeyValue) {
            rowNode.classList.add("active");
            rowNode.setAttribute("aria-selected", "true");
            }
            listEl.appendChild(rowNode);
          }
        }
      }
    }

    function renderList() {
      if (!currentData) {
        setListMessage(emptyStateMessage, "empty");
        return;
      }
      if (currentViewState.mode === "compare") {
        renderCompareList(currentData);
      } else {
        renderInspectList(currentData);
      }
      renderInspectSummary();
    }

    function noRowsPreviewMessage() {
      if (currentViewState.mode === "compare") {
        return "No rows to display for current visibility filter.";
      }
      return "No captured files to preview for current inspect filter.";
    }

    function selectionPromptMessage() {
      if (currentViewState.mode === "compare") {
        return "Select a file to preview diff.";
      }
      return "Select a file to preview captured patch or contents.";
    }

    async function restoreSelectionPreview() {
      const row = findCurrentRowBySelectionKey();
      if (!row) {
        clearSelectedRowInViewState();
        selectionKeyValue = "";
        syncBrowserUrl(currentViewState);
        currentPreviewRow = null;
        currentPreviewSupportsExternalDiff = false;
        syncOpenButtonState();
        setDiffText(currentHasRows() ? selectionPromptMessage() : noRowsPreviewMessage());
        renderInspectSummary();
        return;
      }
      const rowNode = rowButtons().find((node) => node.classList.contains("active"));
      if (rowNode) {
        await selectRow(row, rowNode, true);
      } else {
        const targetNode = rowButtons().find((node) => node.dataset.rowKey === rowSelectionKey(row));
        if (targetNode) {
          await selectRow(row, targetNode, true);
        } else {
          setDiffText(selectionPromptMessage());
        }
      }
    }

    function currentHasRows() {
      if (!currentData) return false;
      if (currentViewState.mode === "compare") {
        return Array.isArray(currentData.rows) && currentData.rows.length > 0;
      }
      return Array.isArray(currentData.fileRows) && currentData.fileRows.length > 0;
    }

    async function selectRow(row, rowNode, preserveButtonState) {
      setActiveRow(rowNode);
      setSelectedRowInViewState(row);
      selectionKeyValue = rowSelectionKey(row);
      syncBrowserUrl(currentViewState);
      currentPreviewRow = row || null;
      currentPreviewSupportsExternalDiff = false;
      syncOpenButtonState();
      renderInspectSummary();
      setDiffLoading(row);
      const token = previewToken + 1;
      previewToken = token;
      const params = new URLSearchParams(queryForViewState(currentViewState));
      params.set("repo", row.repo || "");
      params.set("file", row.file || "");
      if (row.category) {
        params.set("category", row.category);
      }
      const endpoint = "/api/preview?" + params.toString();
      const res = await fetch(endpoint);
      const previewSupportsExternalDiff =
        String(res.headers.get("x-git-snapshot-external-diff-supported") || "") !== "0";
      const contentType = String(res.headers.get("content-type") || "");
      if (contentType.includes("application/json")) {
        const payload = await res.json();
        if (token !== previewToken) return;
        if (!res.ok || !payload || payload.ok === false) {
          currentPreviewSupportsExternalDiff = false;
          syncOpenButtonState();
          setDiffText((payload && payload.error) || "Failed to load preview.");
          return;
        }
        if (payload.preview_kind === "submodule_summary") {
          currentPreviewSupportsExternalDiff = false;
          syncOpenButtonState();
          renderSubmoduleSummary(payload.data || {});
          return;
        }
        currentPreviewSupportsExternalDiff = currentViewState.mode === "compare" && previewSupportsExternalDiff;
        syncOpenButtonState();
        setDiffText(JSON.stringify(payload, null, 2));
        return;
      }

      const previewText = await res.text();
      if (token !== previewToken) return;
      if (!res.ok) {
        currentPreviewSupportsExternalDiff = false;
        syncOpenButtonState();
        setDiffText(previewText || "Failed to load preview.");
        return;
      }
      currentPreviewSupportsExternalDiff = currentViewState.mode === "compare" && previewSupportsExternalDiff;
      syncOpenButtonState();
      setDiffText(previewText);
    }

    async function openExternal() {
      const row = findCurrentRowBySelectionKey();
      if (!row || currentViewState.mode !== "compare") return;
      const params = new URLSearchParams(queryForViewState(currentViewState));
      params.set("repo", row.repo || "");
      params.set("file", row.file || "");
      const res = await fetch("/api/open?" + params.toString(), { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        alert(data.error || "Failed to open external diff.");
      }
    }

    async function loadSnapshots(forceRefresh) {
      const suffix = forceRefresh ? "?force=1&selected_snapshot_id=" : "?selected_snapshot_id=";
      const res = await fetch("/api/snapshots" + suffix + encodeURIComponent(currentViewState.snapshotId || ""));
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load snapshots.");
      }
      snapshots = data.snapshots || [];
      updateSnapshotOptions(currentViewState.snapshotId);
    }

    function ensureCompareEmptyState(data) {
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const summary = data.summaryFields || {};
      const unresolvedTotal = Number(summary.unresolved_total || 0);
      const filesTotal = Number(summary.files_total || 0);
      if (!rows.length && !currentViewState.compareShowAll && unresolvedTotal === 0 && filesTotal > 0) {
        emptyStateMessage = "No unresolved rows. Toggle show resolved rows to include resolved files.";
      } else {
        emptyStateMessage = "No rows to display.";
      }
    }

    function ensureInspectDerivedData(data) {
      const repoRows = Array.isArray(data.repoRows) ? data.repoRows : [];
      const fileRows = Array.isArray(data.fileRows) ? data.fileRows : [];
      const categoryRows = Array.isArray(data.categoryRows) ? data.categoryRows : [];
      const visibleRepoRows = repoRows.filter((row) => {
        if (currentViewState.repoFilter && (row.repo || "") !== currentViewState.repoFilter) {
          return false;
        }
        if (currentViewState.inspectShowAllRepos) return true;
        return (row.has_changes || "false") === "true";
      });

      const visibleRepoSet = new Set(visibleRepoRows.map((row) => row.repo || ""));
      data.visibleRepoRows = visibleRepoRows;
      data.fileRows = fileRows.filter((row) => visibleRepoSet.has(row.repo || ""));
      const categoryCounts = {};
      for (const row of categoryRows) {
        categoryCounts[(row.repo || "") + "\\t" + (row.category || "")] = Number(row.file_count || 0);
      }
      data.categoryCounts = categoryCounts;
      emptyStateMessage = visibleRepoRows.length ? "No captured files for the selected categories." : "No repos to display.";
    }

    async function loadData(forceRefresh) {
      const requestedViewState = viewStateFromControls();
      const requestedMode = requestedViewState.mode;
      const requestToken = loadToken + 1;
      loadToken = requestToken;
      if (activeLoadController) {
        activeLoadController.abort();
      }
      const controller = new AbortController();
      activeLoadController = controller;
      currentViewState = requestedViewState;
      applyModeVisibility();
      setListLoading(requestedMode === "compare" ? "Loading compare rows..." : "Loading inspect rows...");
      setDiffText(requestedMode === "compare" ? "Loading compare rows..." : "Loading inspect rows...");
      openBtn.disabled = true;

      const params = new URLSearchParams(queryForViewState(currentViewState));
      if (forceRefresh) params.set("force", "1");
      try {
        const res = await fetch("/api/data?" + params.toString(), { signal: controller.signal });
        const data = await res.json();
        if (requestToken !== loadToken) {
          return;
        }
        if (!res.ok) {
          throw new Error(data.error || "Failed to load GUI data.");
        }

        currentData = data;
        if (requestedMode === "compare") {
          ensureCompareEmptyState(currentData);
        } else {
          ensureInspectDerivedData(currentData);
        }
        setControlsFromViewState(data.viewState || requestedViewState, currentData);
        syncBrowserUrl(currentViewState);
        renderMetaAndSummary(currentData);
        renderList();
        await restoreSelectionPreview();
      } catch (err) {
        if (requestToken !== loadToken || isAbortError(err)) {
          return;
        }
        throw err;
      } finally {
        if (activeLoadController === controller) {
          activeLoadController = null;
        }
      }
    }

    function scheduleRefresh() {
      if (refreshTimer) window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => {
        const requestedMode = modeSelect.value;
        loadData(false).catch((err) => renderLoadFailure(err, requestedMode));
      }, 150);
    }

    function ensureInspectCategories(eventTarget) {
      if (inspectStaged.checked || inspectUnstaged.checked || inspectUntracked.checked) {
        return;
      }
      if (eventTarget) {
        eventTarget.checked = true;
      } else {
        inspectStaged.checked = true;
        inspectUnstaged.checked = true;
        inspectUntracked.checked = true;
      }
    }

    modeSelect.addEventListener("change", () => {
      currentViewState.mode = modeSelect.value;
      applyModeVisibility();
      scheduleRefresh();
    });
    splitterEl.addEventListener("pointerdown", beginSplitDrag);
    splitterEl.addEventListener("pointermove", updateSplitDrag);
    splitterEl.addEventListener("pointerup", endSplitDrag);
    splitterEl.addEventListener("pointercancel", endSplitDrag);
    splitterEl.addEventListener("keydown", handleSplitterKeydown);
    window.addEventListener("resize", applyResponsiveSplitLayout);
    if (typeof splitLayoutMedia.addEventListener === "function") {
      splitLayoutMedia.addEventListener("change", applyResponsiveSplitLayout);
    } else if (typeof splitLayoutMedia.addListener === "function") {
      splitLayoutMedia.addListener(applyResponsiveSplitLayout);
    }
    snapshotSelect.addEventListener("change", () => scheduleRefresh());
    repoFilterSelect.addEventListener("change", () => scheduleRefresh());
    compareShowAll.addEventListener("change", () => scheduleRefresh());
    inspectAllRepos.addEventListener("change", () => scheduleRefresh());
    [inspectStaged, inspectUnstaged, inspectUntracked].forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        ensureInspectCategories(checkbox);
        scheduleRefresh();
      });
    });

    refreshBtn.onclick = async () => {
      refreshBtn.disabled = true;
      openBtn.disabled = true;
      try {
        await loadSnapshots(true);
        await loadData(true);
      } catch (err) {
        renderLoadFailure(err, modeSelect.value);
      } finally {
        refreshBtn.disabled = false;
      }
    };

    openBtn.onclick = () => openExternal().catch((err) => alert(String(err)));

    try {
      applyResponsiveSplitLayout();
      setControlsFromViewState(currentViewState, null);
      Promise.resolve()
        .then(() => loadSnapshots(false))
        .then(() => loadData(false))
        .catch((err) => {
          renderLoadFailure(err, modeSelect.value);
        });
    } catch (err) {
      renderBootstrapFailure(err);
    }
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

function runGitSnapshot(args, commandArgs) {
  const proc = run(args.gitSnapshotBin, commandArgs, { encoding: "utf8", cwd: args.rootRepo });
  if (proc.status !== 0) {
    throw new SnapshotGuiError((proc.stderr || proc.stdout || "").trim() || `git-snapshot exited with ${proc.status}.`);
  }
  return proc.stdout || "";
}

function loadCompareData(args, viewState, resolver) {
  if (FORCE_COMPARE_DATA_FAILURE) {
    throw new SnapshotGuiError("Forced compare data load failure for test.");
  }

  const cmd = ["compare", viewState.snapshotId, "--porcelain"];
  if (viewState.repoFilter) cmd.push("--repo", viewState.repoFilter);
  if (viewState.compareShowAll) cmd.push("--all");

  const parsed = parseComparePorcelain(runGitSnapshot(args, cmd));
  parsed.availableRepos = resolver.repoList(viewState.snapshotId);
  parsed.viewState = viewState;
  parsed.mode = "compare";
  return parsed;
}

function inspectCategoryFlags(viewState) {
  if (viewState.inspectIncludeStaged && viewState.inspectIncludeUnstaged && viewState.inspectIncludeUntracked) {
    return ["--all"];
  }
  const flags = [];
  if (viewState.inspectIncludeStaged) flags.push("--staged");
  if (viewState.inspectIncludeUnstaged) flags.push("--unstaged");
  if (viewState.inspectIncludeUntracked) flags.push("--untracked");
  return flags;
}

function loadInspectData(args, viewState, resolver) {
  const cmd = ["inspect", viewState.snapshotId, "--porcelain"];
  if (viewState.repoFilter) cmd.push("--repo", viewState.repoFilter);
  if (viewState.inspectShowAllRepos) cmd.push("--all-repos");
  cmd.push(...inspectCategoryFlags(viewState));

  const parsed = parseInspectPorcelain(runGitSnapshot(args, cmd));
  parsed.availableRepos = resolver.repoList(viewState.snapshotId);
  parsed.viewState = viewState;
  parsed.mode = "inspect";
  return parsed;
}

function loadSnapshotOptions(args, selectedSnapshotId) {
  const userSnapshots = parseListPorcelain(runGitSnapshot(args, ["list", "--porcelain"]));
  if (userSnapshots.some((snapshot) => snapshot.id === selectedSnapshotId)) {
    return userSnapshots;
  }
  const allSnapshots = parseListPorcelain(runGitSnapshot(args, ["list", "--include-auto", "--porcelain"]));
  const selectedSnapshot = allSnapshots.find((snapshot) => snapshot.id === selectedSnapshotId);
  if (!selectedSnapshot) {
    return userSnapshots;
  }
  return userSnapshots.concat([selectedSnapshot]);
}

function testDataDelayMs(mode) {
  if (mode === "compare") return TEST_COMPARE_DATA_DELAY_MS;
  if (mode === "inspect") return TEST_INSPECT_DATA_DELAY_MS;
  return 0;
}

function resolveViewStateFromUrl(url, args) {
  const getParam = (name, fallback) => {
    if (!url.searchParams.has(name)) {
      return fallback;
    }
    return url.searchParams.get(name);
  };

  return normalizeViewState({
    mode: getParam("mode", args.initialViewState.mode),
    snapshotId: getParam("snapshot_id", args.initialViewState.snapshotId),
    repoFilter: getParam("repo_filter", args.initialViewState.repoFilter),
    compareShowAll: getParam("compare_show_all", args.initialViewState.compareShowAll),
    inspectIncludeStaged: getParam("inspect_include_staged", args.initialViewState.inspectIncludeStaged),
    inspectIncludeUnstaged: getParam("inspect_include_unstaged", args.initialViewState.inspectIncludeUnstaged),
    inspectIncludeUntracked: getParam("inspect_include_untracked", args.initialViewState.inspectIncludeUntracked),
    inspectShowAllRepos: getParam("inspect_show_all_repos", args.initialViewState.inspectShowAllRepos),
    selectedRepo: getParam("selected_repo", args.initialViewState.selectedRepo),
    selectedCategory: getParam("selected_category", args.initialViewState.selectedCategory),
    selectedFile: getParam("selected_file", args.initialViewState.selectedFile),
  }, args);
}

function runTestMode(args, resolver) {
  const viewState = args.initialViewState;
  const data = viewState.mode === "compare"
    ? loadCompareData(args, viewState, resolver)
    : loadInspectData(args, viewState, resolver);

  const previewRow = viewState.mode === "compare"
    ? (data.rows || [])[0]
    : (data.fileRows || [])[0];

  if (previewRow) {
    try {
      if (viewState.mode === "compare") {
        const snapshotFile = resolver.materializeCompareSnapshotFile(viewState.snapshotId, previewRow.repo || "", previewRow.file || "");
        const currentFile = resolver.currentFilePath(previewRow.repo || "", previewRow.file || "");
        buildUnifiedDiff(currentFile, snapshotFile, previewRow.file || "");
      } else if ((previewRow.category || "") === "untracked") {
        resolver.inspectUntrackedPreview(viewState.snapshotId, previewRow.repo || "", previewRow.file || "");
      } else {
        resolver.inspectPatchPreview(viewState.snapshotId, previewRow.repo || "", previewRow.category || "", previewRow.file || "");
      }
    } catch (_err) {
      // Ignore in test mode; parity with prior behavior.
    }
  }

  const rowsLength = viewState.mode === "compare" ? (data.rows || []).length : (data.fileRows || []).length;
  console.log(
    "GUI_TEST" +
      ` mode=${viewState.mode}` +
      ` snapshot_id=${viewState.snapshotId}` +
      ` rows=${rowsLength}` +
      ` show_all=${boolString(viewState.compareShowAll)}` +
      ` inspect_staged=${boolString(viewState.inspectIncludeStaged)}` +
      ` inspect_unstaged=${boolString(viewState.inspectIncludeUnstaged)}` +
      ` inspect_untracked=${boolString(viewState.inspectIncludeUntracked)}` +
      ` inspect_all_repos=${boolString(viewState.inspectShowAllRepos)}` +
      ` repo_filter=${viewState.repoFilter || "(all)"}`
  );
  return 0;
}

function startServer(args, resolver) {
  const sockets = new Set();
  const state = {
    dataCache: new Map(),
    previewCache: new Map(),
    snapshotsCache: null,
  };

  function getViewData(viewState, forceRefresh) {
    const key = viewStateKey(viewState);
    if (forceRefresh) {
      state.dataCache.delete(key);
      state.previewCache.clear();
    }
    if (!state.dataCache.has(key)) {
      const startedAt = Date.now();
      const loaded = viewState.mode === "compare"
        ? loadCompareData(args, viewState, resolver)
        : loadInspectData(args, viewState, resolver);
      const loadedAt = Date.now();
      state.dataCache.set(key, {
        payload: loaded,
        loadedAt,
      });
      const rowCount = viewState.mode === "compare"
        ? (loaded.rows || []).length
        : (loaded.fileRows || []).length;
      console.log(`${viewState.mode} data loaded in ${loadedAt - startedAt}ms (rows=${rowCount}).`);
    }
    return state.dataCache.get(key);
  }

  function getSnapshots(forceRefresh, selectedSnapshotId) {
    if (forceRefresh || !state.snapshotsCache || state.snapshotsCache.selectedSnapshotId !== selectedSnapshotId) {
      state.snapshotsCache = {
        selectedSnapshotId,
        snapshots: loadSnapshotOptions(args, selectedSnapshotId),
        loadedAt: Date.now(),
      };
    }
    return state.snapshotsCache;
  }

  function comparePreview(viewState, repoRel, filePath) {
    const dataEntry = getViewData(viewState, false);
    const knownRow = findCompareRow(dataEntry.payload, repoRel, filePath);
    if (!knownRow) {
      return { status: 404, error: UNKNOWN_COMPARE_ROW_ERROR };
    }

    const key = `${viewStateKey(viewState)}\0compare\0${repoRel}\0${filePath}`;
    if (state.previewCache.has(key)) {
      return Object.assign({ status: 200 }, state.previewCache.get(key));
    }

    const submoduleSummary = buildSubmoduleSummary(resolver, viewState.snapshotId, repoRel, filePath, knownRow);
    if (submoduleSummary) {
      const previewResult = {
        kind: "submodule_summary",
        data: submoduleSummary,
        externalDiffSupported: false,
        externalDiffError: "External diff is not available for submodule summary rows.",
      };
      state.previewCache.set(key, previewResult);
      return Object.assign({ status: 200 }, previewResult);
    }

    const currentFile = resolver.currentFilePath(repoRel, filePath);
    let snapshotFile = "";
    let previewText = "";

    try {
      snapshotFile = resolver.materializeCompareSnapshotFile(viewState.snapshotId, repoRel, filePath);
    } catch (err) {
      if ((knownRow.status || "") === "unresolved_missing") {
        const message = compareReasonDetailText(knownRow)
          || "Snapshot content preview is unavailable until the missing repo/path is restored.";
        previewText = "Working tree path is missing.\n" + message;
        const previewResult = {
          kind: "text",
          text: previewText,
          snapshotFile,
          currentFile,
          externalDiffSupported: false,
          externalDiffError: "External diff is not available until the missing repo/path is restored.",
        };
        state.previewCache.set(key, previewResult);
        return Object.assign({ status: 200 }, previewResult);
      }
      throw err;
    }

    if ((knownRow.status || "") === "unresolved_missing" && !fs.existsSync(currentFile)) {
      previewText = buildSnapshotOnlyDiff(snapshotFile, filePath);
    } else {
      previewText = buildUnifiedDiff(currentFile, snapshotFile, filePath);
    }
    const previewResult = {
      kind: "text",
      text: previewText,
      snapshotFile,
      currentFile,
      externalDiffSupported: true,
    };
    state.previewCache.set(key, previewResult);
    return Object.assign({ status: 200 }, previewResult);
  }

  function inspectPreview(viewState, repoRel, category, filePath) {
    const dataEntry = getViewData(viewState, false);
    const knownRow = findInspectRow(dataEntry.payload, repoRel, category, filePath);
    if (!knownRow) {
      return { status: 404, error: UNKNOWN_INSPECT_ROW_ERROR };
    }

    const key = `${viewStateKey(viewState)}\0inspect\0${repoRel}\0${category}\0${filePath}`;
    if (state.previewCache.has(key)) {
      return { status: 200, text: state.previewCache.get(key).previewText };
    }

    const previewText = category === "untracked"
      ? resolver.inspectUntrackedPreview(viewState.snapshotId, repoRel, filePath)
      : resolver.inspectPatchPreview(viewState.snapshotId, repoRel, category, filePath);
    state.previewCache.set(key, { previewText });
    return { status: 200, text: previewText };
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(htmlPage(resolveViewStateFromUrl(url, args)));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/snapshots") {
        const selectedSnapshotId = url.searchParams.get("selected_snapshot_id") || args.initialViewState.snapshotId;
        const forceRefresh = url.searchParams.get("force") === "1";
        const cache = getSnapshots(forceRefresh, selectedSnapshotId);
        json(res, 200, {
          snapshots: cache.snapshots,
          cacheLoadedAt: cache.loadedAt,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/data") {
        const forceRefresh = url.searchParams.get("force") === "1";
        const viewState = resolveViewStateFromUrl(url, args);
        const delayMs = testDataDelayMs(viewState.mode);
        if (delayMs > 0) {
          await delay(delayMs);
        }
        const cache = getViewData(viewState, forceRefresh);
        json(res, 200, Object.assign({}, cache.payload, {
          viewState,
          cacheLoadedAt: cache.loadedAt,
        }));
        return;
      }

      if (req.method === "GET" && (url.pathname === "/api/preview" || url.pathname === "/api/diff")) {
        const viewState = resolveViewStateFromUrl(url, args);
        const repoRel = url.searchParams.get("repo") || "";
        const filePath = url.searchParams.get("file") || "";
        const category = url.searchParams.get("category") || "";
        if (!repoRel || !filePath) {
          text(res, 400, "Missing repo/file query parameters.");
          return;
        }
        if (url.pathname === "/api/diff") {
          const compareResult = comparePreview(Object.assign({}, viewState, { mode: "compare" }), repoRel, filePath);
          if (compareResult.status !== 200) {
            text(res, compareResult.status, compareResult.error || "Preview unavailable.");
            return;
          }
          res.setHeader("X-Git-Snapshot-External-Diff-Supported", comparePreviewExternalDiffHeaderValue(compareResult));
          if (compareResult.kind === "submodule_summary") {
            text(res, 200, compareResult.data && compareResult.data.summary
              ? compareResult.data.summary
              : "Submodule summary preview is available in the shared browser.");
            return;
          }
          text(res, 200, compareResult.text);
          return;
        }
        const previewResult = viewState.mode === "compare"
          ? comparePreview(viewState, repoRel, filePath)
          : inspectPreview(viewState, repoRel, category, filePath);
        if (previewResult.status !== 200) {
          text(res, previewResult.status, previewResult.error || "Preview unavailable.");
          return;
        }
        if (viewState.mode === "compare") {
          res.setHeader("X-Git-Snapshot-External-Diff-Supported", comparePreviewExternalDiffHeaderValue(previewResult));
        }
        if (previewResult.kind === "submodule_summary") {
          json(res, 200, {
            ok: true,
            preview_kind: "submodule_summary",
            data: previewResult.data,
          });
          return;
        }
        text(res, 200, previewResult.text);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/open") {
        const viewState = resolveViewStateFromUrl(url, args);
        if (viewState.mode !== "compare") {
          json(res, 400, { ok: false, error: "External diff is only available in compare mode." });
          return;
        }
        const repoRel = url.searchParams.get("repo") || "";
        const filePath = url.searchParams.get("file") || "";
        if (!repoRel || !filePath) {
          json(res, 400, { ok: false, error: "Missing repo/file query parameters." });
          return;
        }

        const compareResult = comparePreview(viewState, repoRel, filePath);
        if (compareResult.status !== 200) {
          json(res, compareResult.status, { ok: false, error: compareResult.error || UNKNOWN_COMPARE_ROW_ERROR });
          return;
        }
        if (compareResult.externalDiffSupported === false) {
          json(res, 200, {
            ok: false,
            error: compareResult.externalDiffError || "External diff is not available for this preview.",
          });
          return;
        }

        let externalDiffSpec = null;
        try {
          externalDiffSpec = detectExternalDiffSpec();
        } catch (err) {
          json(res, 200, {
            ok: false,
            error: err && err.message ? err.message : String(err),
          });
          return;
        }
        if (!externalDiffSpec) {
          json(res, 200, { ok: false, error: externalDiffMissingMessage() });
          return;
        }

        const snapshotFile = compareResult.snapshotFile;
        const currentFile = compareResult.currentFile;
        ensureDir(path.dirname(currentFile));
        if (!fs.existsSync(currentFile)) {
          fs.writeFileSync(currentFile, "", "utf8");
        }
        try {
          launchExternalDiff(externalDiffSpec, snapshotFile, currentFile);
        } catch (err) {
          json(res, 200, {
            ok: false,
            error: err && err.message ? err.message : String(err),
          });
          return;
        }
        json(res, 200, { ok: true, tool: externalDiffSpec.label });
        return;
      }

      text(res, 404, "Not found");
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (req.url && (req.url.indexOf("/api/preview") === 0 || req.url.indexOf("/api/diff") === 0)) {
        text(res, 500, msg);
      } else if (req.url && req.url.indexOf("/api/") === 0) {
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
    const binding = guiPortBindingConfig();
    listenOnPreferredPortRange(server, "127.0.0.1", binding.start, binding.count).then((port) => {
      if (!port) {
        reject(new SnapshotGuiError("Failed to allocate GUI server port."));
        return;
      }
      const url = `http://127.0.0.1:${port}/`;
      console.log(`Snapshot GUI server (${args.initialViewState.mode}): ${url}`);
      if (process.env.GIT_SNAPSHOT_GUI_NO_BROWSER === "1") {
        console.log("Browser launch skipped by GIT_SNAPSHOT_GUI_NO_BROWSER=1.");
      } else {
        const opener = launchBrowser(url);
        if (opener) console.log(`Opened in browser via: ${opener}`);
        else console.log("Open URL manually in a browser.");
      }
      console.log("Press Ctrl-C to stop the GUI server.");
      resolve({ server, sockets });
    }, reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const resolver = new SnapshotBundleResolver(args.rootRepo);

  if (process.env.GIT_SNAPSHOT_GUI_FORCE_ABORT === "1") {
    process.abort();
  }
  if (process.env.GIT_SNAPSHOT_GUI_TEST_MODE === "1") {
    process.exit(runTestMode(args, resolver));
    return;
  }

  const runtime = await startServer(args, resolver);
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
