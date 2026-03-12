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

  return {
    mode,
    snapshotId,
    repoFilter,
    compareShowAll,
    inspectIncludeStaged,
    inspectIncludeUnstaged,
    inspectIncludeUntracked,
    inspectShowAllRepos,
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

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function htmlPage(initialViewState) {
  const initialStateJson = escapeForHtmlJson(initialViewState);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>git-snapshot shared --gui</title>
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
    .top {
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      background: rgba(255,255,255,0.74);
      backdrop-filter: blur(6px);
    }
    .title { font-weight: 700; }
    .meta, .summary {
      color: var(--muted);
      margin-top: 4px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .controls {
      margin-top: 10px;
      display: grid;
      grid-template-columns: repeat(4, minmax(140px, 1fr));
      gap: 10px 12px;
      align-items: end;
    }
    .control {
      display: flex;
      flex-direction: column;
      gap: 4px;
      min-width: 0;
    }
    .control label, .toggle-group-title {
      font-size: 12px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .control select,
    .control input[type="text"] {
      width: 100%;
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      background: rgba(255,255,255,0.92);
      color: var(--ink);
      font: inherit;
    }
    .toggle-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 14px;
      align-items: center;
      min-height: 40px;
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
    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: flex-end;
    }
    button {
      background: var(--accent);
      color: #fff;
      border: 0;
      border-radius: 8px;
      padding: 8px 12px;
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
      grid-template-columns: minmax(300px, 39%) minmax(0, 1fr);
      min-height: 0;
      overflow: hidden;
    }
    .left {
      border-right: 1px solid var(--line);
      overflow: auto;
      min-height: 0;
      background: var(--panel);
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
      padding: 10px;
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
    .status { color: var(--muted); }
    .loading { color: var(--muted); font-style: italic; }
    .error { color: var(--danger); }
    pre { margin: 0; white-space: pre; }
    .empty { color: var(--muted); padding: 10px; }
    @media (max-width: 900px) {
      .controls { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
      .actions { justify-content: flex-start; }
    }
    @media (max-width: 700px) {
      .top { padding: 10px 12px; }
      .meta, .summary { white-space: normal; }
      .controls { grid-template-columns: 1fr; }
      .main {
        grid-template-columns: 1fr;
        grid-template-rows: minmax(220px, 40vh) minmax(0, 1fr);
      }
      .left {
        border-right: 0;
        border-bottom: 1px solid var(--line);
      }
      .right { padding: 8px; }
      .inspect-summary-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <div class="top">
    <div class="title">git-snapshot shared browser</div>
    <div id="meta" class="meta"></div>
    <div id="summary" class="summary"></div>
    <div class="controls">
      <div class="control">
        <label for="modeSelect">Mode</label>
        <select id="modeSelect">
          <option value="compare">compare</option>
          <option value="inspect">inspect</option>
        </select>
      </div>
      <div class="control">
        <label for="snapshotSelect">Snapshot</label>
        <select id="snapshotSelect"></select>
      </div>
      <div class="control">
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
      <div class="control">
        <div class="toggle-group-title">Actions</div>
        <div class="actions">
          <button id="refresh" type="button">Refresh</button>
          <button id="openExternal" type="button" disabled>Open External Diff</button>
        </div>
      </div>
    </div>
  </div>
  <div class="main">
    <div id="list" class="left" role="group" aria-label="Snapshot rows"></div>
    <div class="right">
      <div id="inspectSummaryPanel" class="inspect-summary hidden">
        <div class="inspect-summary-title">Inspect Summary</div>
        <div id="inspectSummaryBody" class="inspect-summary-grid"></div>
      </div>
      <div class="preview-panel"><pre id="diff">Loading…</pre></div>
    </div>
  </div>
  <script>
    const initialViewState = ${initialStateJson};
    const listEl = document.getElementById("list");
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

    let currentViewState = Object.assign({}, initialViewState);
    let snapshots = [];
    let currentData = null;
    let selectionKeyValue = "";
    let previewToken = 0;
    let refreshTimer = null;
    let emptyStateMessage = "No rows to display.";
    let loadToken = 0;
    let activeLoadController = null;

    function viewStateFromControls() {
      return {
        mode: modeSelect.value,
        snapshotId: snapshotSelect.value,
        repoFilter: repoFilterSelect.value || "",
        compareShowAll: Boolean(compareShowAll.checked),
        inspectIncludeStaged: Boolean(inspectStaged.checked),
        inspectIncludeUnstaged: Boolean(inspectUnstaged.checked),
        inspectIncludeUntracked: Boolean(inspectUntracked.checked),
        inspectShowAllRepos: Boolean(inspectAllRepos.checked),
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
      return params.toString();
    }

    function rowButtons() {
      return Array.from(listEl.querySelectorAll(".row"));
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
      diffEl.classList.add("loading");
      if (currentViewState.mode === "compare") {
        diffEl.textContent = "Loading diff for " + (row.repo || "") + "/" + (row.file || "") + "...";
      } else {
        diffEl.textContent = "Loading preview for " + (row.repo || "") + "/" + (row.file || "") + "...";
      }
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

    function applyModeVisibility() {
      document.querySelectorAll(".mode-compare").forEach((node) => {
        node.classList.toggle("hidden", currentViewState.mode !== "compare");
      });
      document.querySelectorAll(".mode-inspect").forEach((node) => {
        node.classList.toggle("hidden", currentViewState.mode !== "inspect");
      });
      openBtn.classList.toggle("hidden", currentViewState.mode !== "compare");
      openBtn.disabled = currentViewState.mode !== "compare" || !findCurrentRowBySelectionKey();
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
      previewToken += 1;
      emptyStateMessage = "No rows to display.";
      openBtn.disabled = true;
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
      renderInspectSummary();
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
    }

    function renderCompareList(data) {
      const rows = Array.isArray(data.rows) ? data.rows : [];
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
      const repoRows = Array.isArray(data.visibleRepoRows) ? data.visibleRepoRows : [];
      const fileRows = Array.isArray(data.fileRows) ? data.fileRows : [];
      const categoryCounts = data.categoryCounts || {};
      if (!repoRows.length) {
        listEl.innerHTML = "<div class='empty'>" + emptyStateMessage + "</div>";
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
        listEl.innerHTML = "<div class='empty'>" + emptyStateMessage + "</div>";
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
        openBtn.disabled = true;
        setDiffText(currentHasRows() ? selectionPromptMessage() : noRowsPreviewMessage());
        renderInspectSummary();
        return;
      }
      const rowNode = rowButtons().find((node) => node.classList.contains("active"));
      if (rowNode) {
        await selectRow(row, rowNode, true);
      } else {
        const targetNode = rowButtons().find((node) => {
          const text = (node.textContent || "").trim();
          if (currentViewState.mode === "compare") {
            return text === ((row.file || "(unknown)") + " [" + (row.status || "") + "]");
          }
          return text === (row.file || "(unknown)");
        });
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
      selectionKeyValue = rowSelectionKey(row);
      if (currentViewState.mode === "compare") {
        openBtn.disabled = false;
      } else {
        openBtn.disabled = true;
      }
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
      const previewText = await res.text();
      if (token !== previewToken) return;
      if (!res.ok) {
        setDiffText(previewText || "Failed to load preview.");
        if (!preserveButtonState) openBtn.disabled = currentViewState.mode !== "compare";
        return;
      }
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

    setControlsFromViewState(currentViewState, null);
    Promise.resolve()
      .then(() => loadSnapshots(false))
      .then(() => loadData(false))
      .catch((err) => {
        renderLoadFailure(err, modeSelect.value);
      });
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
  return normalizeViewState({
    mode: url.searchParams.get("mode") || args.initialViewState.mode,
    snapshotId: url.searchParams.get("snapshot_id") || args.initialViewState.snapshotId,
    repoFilter: url.searchParams.get("repo_filter") || "",
    compareShowAll: url.searchParams.get("compare_show_all"),
    inspectIncludeStaged: url.searchParams.get("inspect_include_staged"),
    inspectIncludeUnstaged: url.searchParams.get("inspect_include_unstaged"),
    inspectIncludeUntracked: url.searchParams.get("inspect_include_untracked"),
    inspectShowAllRepos: url.searchParams.get("inspect_show_all_repos"),
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
      const cached = state.previewCache.get(key);
      return {
        status: 200,
        text: cached.previewText,
        snapshotFile: cached.snapshotFile,
        currentFile: cached.currentFile,
      };
    }

    const snapshotFile = resolver.materializeCompareSnapshotFile(viewState.snapshotId, repoRel, filePath);
    const currentFile = resolver.currentFilePath(repoRel, filePath);
    const previewText = buildUnifiedDiff(currentFile, snapshotFile, filePath);
    state.previewCache.set(key, {
      previewText,
      snapshotFile,
      currentFile,
    });
    return { status: 200, text: previewText, snapshotFile, currentFile };
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
        res.end(htmlPage(args.initialViewState));
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
    });
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
