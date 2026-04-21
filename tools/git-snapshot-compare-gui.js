#!/usr/bin/env node

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const {
  buildAskPromptTextShared,
  buildRowIdentityKeyShared,
  buildSelectionIdentityKeyShared,
  normalizeLineBreaksShared,
  normalizeSelectedKindShared,
  buildSelectionFallbackSequenceShared,
  buildPreviewSelectionGroupsFromCollections,
  structuredDiffSelectionTextFromContainerShared,
} = require("./git-snapshot-compare-gui-shared");

function buildSharedBrowserHelpersBundleSource() {
  const sharedHelpersPath = path.join(__dirname, "git-snapshot-compare-gui-shared.js");
  const sharedHelpersSource = fs.readFileSync(sharedHelpersPath, "utf8");
  return [
    "(() => {",
    sharedHelpersSource,
    "  if (!globalThis.__gitSnapshotCompareGuiShared) {",
    '    throw new Error("Shared browser helpers failed to initialize.");',
    "  }",
    "})();",
  ].join("\n");
}

const SHARED_BROWSER_HELPERS_BUNDLE_SOURCE = buildSharedBrowserHelpersBundleSource();

class SnapshotGuiError extends Error {}
class SnapshotGuiRequestAbortedError extends SnapshotGuiError {
  constructor(message = "Request aborted.") {
    super(message);
    this.code = "SNAPSHOT_GUI_REQUEST_ABORTED";
  }
}

const UNKNOWN_COMPARE_ROW_ERROR = "File is not part of the currently cached compare rows. Click Refresh.";
const UNKNOWN_BROWSE_ROW_ERROR = "File is not part of the currently cached browse rows. Click Refresh.";
const UNKNOWN_INSPECT_ROW_ERROR = "File is not part of the currently cached inspect rows. Click Refresh.";
const PRIMARY_ACTION_SUPPORT_HEADER = "X-Git-Snapshot-Primary-Action-Supported";
const BROWSE_SUBMODULE_EDIT_ERROR = "Edit File is not available for submodule summary rows.";
const BROWSE_MISSING_FILE_EDIT_ERROR = "Edit File is not available because the working tree file is missing.";
const FORCE_COMPARE_DATA_FAILURE = process.env.GIT_SNAPSHOT_GUI_TEST_FAIL_DATA === "1";
const MELD_ACTIVATE_RETRIES = 30;
const MELD_ACTIVATE_DELAY_SECONDS = 0.1;
const SERVER_SHUTDOWN_GRACE_MS = 400;
const INSPECT_CATEGORY_ORDER = ["staged", "unstaged", "untracked"];
const DEFAULT_COMPARE_BASE = "snapshot";
const DEFAULT_EXTERNAL_DIFF_CANDIDATES = ["meld", "kdiff3", "opendiff", "bcompare", "code"];
const EXTERNAL_DIFF_SOURCE_PATTERNS = [/\$\{SOURCE\}/g, /\$SOURCE/g];
const EXTERNAL_DIFF_TARGET_PATTERNS = [/\$\{TARGET\}/g, /\$TARGET/g];
const EXTERNAL_DIFF_BASE_PATTERNS = [/\$\{BASE\}/g, /\$BASE/g];
const EXTERNAL_DIFF_OTHER_PATTERNS = [/\$\{OTHER\}/g, /\$OTHER/g];
const EDITOR_FILE_PATTERNS = [/\$\{FILE\}/g, /\$FILE/g];
const DEFAULT_GUI_PORT_START = 34757;
const DEFAULT_GUI_PORT_COUNT = 32;
const COMPARE_BASE_STORAGE_KEY = "git-snapshot.gui.compare.base.v1";
const REVIEW_PRESETS_FILE_NAME = ".review-presets.json";
const VIEWED_STATE_FILE_NAME = ".viewed-state.json";
const VIEWED_PREVIEW_BLOBS_DIR_NAME = "viewed-preview-blobs";
const DEFAULT_VIEWED_PREVIEW_MAX_BYTES = 512 * 1024;
const DEFAULT_VIEWED_BULK_CONFIRM_ROWS = 75;
const VIEW_STATE_UNVIEWED = "unviewed";
const VIEW_STATE_VIEWED = "viewed";
const VIEW_STATE_CHANGED = "changed";
const PREVIEW_VARIANT_CURRENT = "current";
const PREVIEW_VARIANT_SINCE_VIEWED = "since_viewed";
const RUN_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const CHILD_ABORT_KILL_GRACE_MS = 200;
const AGGREGATE_PREVIEW_PAGE_SIZE = 25;
const AGGREGATE_PREVIEW_MAX_PAGE_SIZE = AGGREGATE_PREVIEW_PAGE_SIZE;
const AGGREGATE_PREVIEW_ROWS_HEADER = "X-Git-Snapshot-Aggregate-Preview-Rows";
const AGGREGATE_PREVIEW_TOTAL_HEADER = "X-Git-Snapshot-Aggregate-Preview-Total";
const AGGREGATE_PREVIEW_NEXT_OFFSET_HEADER = "X-Git-Snapshot-Aggregate-Preview-Next-Offset";
const AGGREGATE_PREVIEW_HAS_MORE_HEADER = "X-Git-Snapshot-Aggregate-Preview-Has-More";
const AGGREGATE_PREVIEW_ELAPSED_HEADER = "X-Git-Snapshot-Aggregate-Preview-Elapsed-Ms";
const AGGREGATE_PREVIEW_ERRORS_HEADER = "X-Git-Snapshot-Aggregate-Preview-Errors";
const ROW_STATS_TELEMETRY_ENV = "GIT_SNAPSHOT_ROW_STATS_TELEMETRY";
const VIEWED_TELEMETRY_ENV = "GIT_SNAPSHOT_GUI_VIEWED_TELEMETRY";
const ROW_STATS_TELEMETRY_THRESHOLD_MS = Number(process.env.GIT_SNAPSHOT_ROW_STATS_SLOW_MS || 250) || 250;
const VIEWED_PREVIEW_MAX_BYTES = Math.max(
  0,
  Number(process.env.GIT_SNAPSHOT_GUI_VIEWED_PREVIEW_MAX_BYTES || DEFAULT_VIEWED_PREVIEW_MAX_BYTES) || DEFAULT_VIEWED_PREVIEW_MAX_BYTES
);
const VIEWED_BULK_CONFIRM_ROWS = Math.max(
  0,
  Number(process.env.GIT_SNAPSHOT_GUI_VIEWED_BULK_CONFIRM_ROWS || DEFAULT_VIEWED_BULK_CONFIRM_ROWS) || DEFAULT_VIEWED_BULK_CONFIRM_ROWS
);

function padTwoDigits(value) {
  return String(value).padStart(2, "0");
}

function formatLocalSnapshotTimestamp(date) {
  return [
    date.getFullYear(),
    padTwoDigits(date.getMonth() + 1),
    padTwoDigits(date.getDate()),
  ].join("-") + "--" + [
    padTwoDigits(date.getHours()),
    padTwoDigits(date.getMinutes()),
    padTwoDigits(date.getSeconds()),
  ].join("-");
}

function snapshotStoreRootForRepo(rootRepo) {
  return path.join(os.homedir(), "git-snapshots", path.basename(rootRepo));
}

function snapshotStorePathForRepo(rootRepo, snapshotId) {
  return path.join(snapshotStoreRootForRepo(rootRepo), snapshotId);
}

function reviewPresetsPathForRepo(rootRepo) {
  return path.join(snapshotStoreRootForRepo(rootRepo), REVIEW_PRESETS_FILE_NAME);
}

function viewedStatePathForRepo(rootRepo) {
  return path.join(snapshotStoreRootForRepo(rootRepo), VIEWED_STATE_FILE_NAME);
}

function viewedPreviewBlobsDirForRepo(rootRepo) {
  return path.join(snapshotStoreRootForRepo(rootRepo), VIEWED_PREVIEW_BLOBS_DIR_NAME);
}

function suggestSnapshotId(rootRepo, label = "snapshot") {
  const timestamp = formatLocalSnapshotTimestamp(new Date());
  const stem = label && label !== "snapshot" ? `${label}-${timestamp}` : timestamp;
  let candidate = stem;
  let sequence = 1;
  while (fs.existsSync(snapshotStorePathForRepo(rootRepo, candidate))) {
    sequence += 1;
    candidate = `${stem}-${String(sequence).padStart(2, "0")}`;
  }
  return candidate;
}

function buildCreateSnapshotCommand(snapshotId, clearAfterCapture) {
  const argv = ["create"];
  if (snapshotId) {
    argv.push(snapshotId);
  }
  if (clearAfterCapture) {
    argv.push("--clear", "--yes");
  }
  return argv;
}

function lastNonEmptyLine(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[lines.length - 1] : "";
}

function parseDelayMs(rawValue) {
  const parsed = Number(rawValue || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.floor(parsed);
}

const TEST_BROWSE_DATA_DELAY_MS = parseDelayMs(process.env.GIT_SNAPSHOT_GUI_TEST_BROWSE_DATA_DELAY_MS);
const TEST_COMPARE_DATA_DELAY_MS = parseDelayMs(process.env.GIT_SNAPSHOT_GUI_TEST_COMPARE_DATA_DELAY_MS);
const TEST_REVIEW_DATA_DELAY_MS = parseDelayMs(process.env.GIT_SNAPSHOT_GUI_TEST_REVIEW_DATA_DELAY_MS);
const TEST_INSPECT_DATA_DELAY_MS = parseDelayMs(process.env.GIT_SNAPSHOT_GUI_TEST_INSPECT_DATA_DELAY_MS);
const TEST_DISABLE_FS_WATCH_EVENTS = process.env.GIT_SNAPSHOT_GUI_TEST_DISABLE_FS_WATCH_EVENTS === "1";
const LIVE_REFRESH_FALLBACK_POLL_MS = parsePositiveIntegerSetting(
  process.env.GIT_SNAPSHOT_GUI_LIVE_REFRESH_FALLBACK_POLL_MS,
  2000,
  "GIT_SNAPSHOT_GUI_LIVE_REFRESH_FALLBACK_POLL_MS"
);
const LIVE_REFRESH_REPO_PROBE_DEBOUNCE_MS = parsePositiveIntegerSetting(
  process.env.GIT_SNAPSHOT_GUI_LIVE_REFRESH_REPO_PROBE_DEBOUNCE_MS,
  750,
  "GIT_SNAPSHOT_GUI_LIVE_REFRESH_REPO_PROBE_DEBOUNCE_MS"
);
const LIVE_REFRESH_REPO_PROBE_THROTTLE_MS = parsePositiveIntegerSetting(
  process.env.GIT_SNAPSHOT_GUI_LIVE_REFRESH_REPO_PROBE_THROTTLE_MS,
  5000,
  "GIT_SNAPSHOT_GUI_LIVE_REFRESH_REPO_PROBE_THROTTLE_MS"
);
const LIVE_REFRESH_VERIFICATION_PROBE_THROTTLE_MS = Math.max(
  250,
  Math.min(LIVE_REFRESH_REPO_PROBE_THROTTLE_MS, LIVE_REFRESH_FALLBACK_POLL_MS)
);
const LIVE_REFRESH_MAX_INCREMENTAL_REPOS = 4;
const CLIENT_REFRESH_STATE_POLL_VISIBLE_MS = 500;
const CLIENT_REFRESH_STATE_POLL_HIDDEN_MS = 2000;
const LIVE_REFRESH_HINT_TEXT = "New live data is ready. Refresh to load it.";
const LIVE_REFRESH_PREPARING_TEXT = "Preparing updated live data...";
const REPO_GUI_CONFIG_FILE_NAME = ".git-snapshot.config";
const COMPARE_GENERIC_REASONS = Object.freeze({
  resolved_committed: "snapshot target content and mode match HEAD and working tree",
  resolved_uncommitted: "snapshot target content and mode match working tree but not HEAD",
  unresolved_missing: "snapshot target path is missing from working tree",
  unresolved_diverged: "current content or mode diverges from snapshot target",
});
let ACTIVE_REPO_GUI_CONFIG = null;

function parseBooleanArg(value, label) {
  if (value !== "true" && value !== "false") {
    throw new SnapshotGuiError(`${label} must be true or false`);
  }
  return value;
}

function normalizeCompareBase(value, fallback) {
  const candidate = String(value || fallback || DEFAULT_COMPARE_BASE).trim();
  if (candidate === "snapshot" || candidate === "working-tree") {
    return candidate;
  }
  return DEFAULT_COMPARE_BASE;
}

function parseCompareBaseArg(value, label) {
  const candidate = String(value || "").trim();
  if (candidate !== "working-tree" && candidate !== "snapshot") {
    throw new SnapshotGuiError(`${label} must be working-tree or snapshot`);
  }
  return candidate;
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

function repoGuiConfigPath(rootRepo) {
  return path.join(rootRepo, REPO_GUI_CONFIG_FILE_NAME);
}

function createEmptyRepoGuiConfig(configPath = "") {
  return {
    path: configPath,
    exists: false,
    browseJobs: null,
    compareJobs: null,
    editTool: "",
    editCommandTemplate: "",
    externalDiffTool: "",
    externalDiffCommandTemplate: "",
    externalDiffCandidates: [],
    compareBase: "",
    snapshotShowAuto: false,
    hasSnapshotShowAuto: false,
    portStart: null,
    portCount: null,
  };
}

function currentRepoGuiConfig() {
  return ACTIVE_REPO_GUI_CONFIG || createEmptyRepoGuiConfig("");
}

function formatRepoGuiConfigKey(section, subsection, key) {
  const normalizedSection = String(section || "").trim();
  const normalizedSubsection = String(subsection || "").trim();
  const normalizedKey = String(key || "").trim();
  if (normalizedSubsection) {
    return `[${normalizedSection} "${normalizedSubsection}"] ${normalizedKey}`;
  }
  return `[${normalizedSection}] ${normalizedKey}`;
}

function parseRepoGuiConfigBoolean(rawValue, label) {
  if (String(rawValue || "").trim() === "") {
    throw new SnapshotGuiError(`${label} cannot be empty.`);
  }
  return parseBooleanArg(String(rawValue || "").trim(), label) === "true";
}

function parseRepoGuiConfigPositiveInteger(rawValue, label) {
  if (String(rawValue || "").trim() === "") {
    throw new SnapshotGuiError(`${label} cannot be empty.`);
  }
  return parsePositiveIntegerSetting(String(rawValue || "").trim(), 0, label);
}

function parseRepoGuiConfigList(rawValue, label) {
  if (String(rawValue || "").trim() === "") {
    throw new SnapshotGuiError(`${label} cannot be empty.`);
  }
  const values = String(rawValue || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!values.length) {
    throw new SnapshotGuiError(`${label} cannot be empty.`);
  }
  return values;
}

function loadRepoGuiConfig(rootRepo) {
  const configPath = repoGuiConfigPath(rootRepo);
  const config = createEmptyRepoGuiConfig(configPath);
  if (!fs.existsSync(configPath)) {
    return config;
  }

  config.exists = true;
  const text = fs.readFileSync(configPath, "utf8");
  let currentSection = "";
  let currentSubsection = "";

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (!line || line.startsWith("#") || line.startsWith(";")) {
      continue;
    }

    const sectionMatch = line.match(/^\[\s*([A-Za-z0-9-]+)(?:\s+"([^"]+)")?\s*\]$/);
    if (sectionMatch) {
      currentSection = String(sectionMatch[1] || "").trim().toLowerCase();
      currentSubsection = String(sectionMatch[2] || "").trim().toLowerCase();
      continue;
    }

    const keyValueMatch = rawLine.match(/^\s*([A-Za-z0-9-]+)\s*=\s*(.*?)\s*$/);
    if (!keyValueMatch) {
      throw new SnapshotGuiError(`${configPath}:${lineNumber}: Invalid config line.`);
    }
    if (!currentSection) {
      throw new SnapshotGuiError(`${configPath}:${lineNumber}: Config entry must appear inside a section.`);
    }

    const key = String(keyValueMatch[1] || "").trim().toLowerCase();
    const value = String(keyValueMatch[2] || "").trim();
    const label = `${configPath}:${lineNumber}: ${formatRepoGuiConfigKey(currentSection, currentSubsection, key)}`;
    const scopedKey = currentSubsection
      ? `${currentSection}.${currentSubsection}.${key}`
      : `${currentSection}.${key}`;

    switch (scopedKey) {
      case "browse.jobs":
        config.browseJobs = parseRepoGuiConfigPositiveInteger(value, label);
        break;
      case "compare.jobs":
        config.compareJobs = parseRepoGuiConfigPositiveInteger(value, label);
        break;
      case "gui.edit.tool":
        if (!value) throw new SnapshotGuiError(`${label} cannot be empty.`);
        config.editTool = value;
        break;
      case "gui.edit.command-template":
        if (!value) throw new SnapshotGuiError(`${label} cannot be empty.`);
        config.editCommandTemplate = value;
        break;
      case "gui.external-diff.tool":
        if (!value) throw new SnapshotGuiError(`${label} cannot be empty.`);
        config.externalDiffTool = value;
        break;
      case "gui.external-diff.command-template":
        if (!value) throw new SnapshotGuiError(`${label} cannot be empty.`);
        config.externalDiffCommandTemplate = value;
        break;
      case "gui.external-diff.candidates":
        config.externalDiffCandidates = parseRepoGuiConfigList(value, label);
        break;
      case "gui.compare.base":
        config.compareBase = parseCompareBaseArg(value, label);
        break;
      case "gui.snapshots.show-auto":
        config.snapshotShowAuto = parseRepoGuiConfigBoolean(value, label);
        config.hasSnapshotShowAuto = true;
        break;
      case "gui.server.port-start":
        config.portStart = parseRepoGuiConfigPositiveInteger(value, label);
        break;
      case "gui.server.port-count":
        config.portCount = parseRepoGuiConfigPositiveInteger(value, label);
        break;
      default:
        throw new SnapshotGuiError(`${configPath}:${lineNumber}: Unsupported config key ${formatRepoGuiConfigKey(currentSection, currentSubsection, key)}.`);
    }
  }

  return config;
}

function guiPortBindingConfig() {
  const repoGuiConfig = currentRepoGuiConfig();
  const start = parsePositiveIntegerSetting(
    process.env.GIT_SNAPSHOT_GUI_PORT_START,
    repoGuiConfig.portStart || DEFAULT_GUI_PORT_START,
    "GIT_SNAPSHOT_GUI_PORT_START"
  );
  const count = parsePositiveIntegerSetting(
    process.env.GIT_SNAPSHOT_GUI_PORT_COUNT,
    repoGuiConfig.portCount || DEFAULT_GUI_PORT_COUNT,
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
    reviewSelectedRepos: [],
    reviewBaseRef: "master",
    reviewRepoBaseOverrides: {},
    compareIncludeNoEffect: "false",
    compareBase: DEFAULT_COMPARE_BASE,
    compareBaseExplicit: "false",
    inspectIncludeStaged: "true",
    inspectIncludeUnstaged: "true",
    inspectIncludeUntracked: "true",
    inspectShowAllRepos: "false",
    browseIncludeStaged: "true",
    browseIncludeUnstaged: "true",
    browseIncludeUntracked: "true",
    browseIncludeSubmodules: "true",
    browseShowAllRepos: "false",
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
    else if (key === "--review-repo") out.reviewSelectedRepos.push(value);
    else if (key === "--review-base") out.reviewBaseRef = normalizeReviewBaseRef(value, "master");
    else if (key === "--review-repo-bases-tsv") out.reviewRepoBaseOverrides = parseReviewRepoBasesTsv(value);
    else if (key === "--compare-include-no-effect") out.compareIncludeNoEffect = parseBooleanArg(value, "--compare-include-no-effect");
    else if (key === "--compare-show-all") out.compareIncludeNoEffect = parseBooleanArg(value, "--compare-show-all");
    else if (key === "--compare-base") out.compareBase = parseCompareBaseArg(value, "--compare-base");
    else if (key === "--compare-base-explicit") out.compareBaseExplicit = parseBooleanArg(value, "--compare-base-explicit");
    else if (key === "--inspect-include-staged") out.inspectIncludeStaged = parseBooleanArg(value, "--inspect-include-staged");
    else if (key === "--inspect-include-unstaged") out.inspectIncludeUnstaged = parseBooleanArg(value, "--inspect-include-unstaged");
    else if (key === "--inspect-include-untracked") out.inspectIncludeUntracked = parseBooleanArg(value, "--inspect-include-untracked");
    else if (key === "--inspect-show-all-repos") out.inspectShowAllRepos = parseBooleanArg(value, "--inspect-show-all-repos");
    else if (key === "--browse-include-staged") out.browseIncludeStaged = parseBooleanArg(value, "--browse-include-staged");
    else if (key === "--browse-include-unstaged") out.browseIncludeUnstaged = parseBooleanArg(value, "--browse-include-unstaged");
    else if (key === "--browse-include-untracked") out.browseIncludeUntracked = parseBooleanArg(value, "--browse-include-untracked");
    else if (key === "--browse-include-submodules") out.browseIncludeSubmodules = parseBooleanArg(value, "--browse-include-submodules");
    else if (key === "--browse-show-all-repos") out.browseShowAllRepos = parseBooleanArg(value, "--browse-show-all-repos");
    else if (key === "--git-snapshot-bin") out.gitSnapshotBin = value;
    else throw new SnapshotGuiError(`Unknown option: ${key}`);
  }

  if (out.mode !== "browse" && out.mode !== "compare" && out.mode !== "inspect" && out.mode !== "review") {
    throw new SnapshotGuiError("Missing or unsupported --mode");
  }
  if (!out.rootRepo) throw new SnapshotGuiError("Missing --root-repo");
  if (out.mode !== "browse" && out.mode !== "review" && !out.snapshotId) throw new SnapshotGuiError("Missing --snapshot-id");
  if (!out.gitSnapshotBin) throw new SnapshotGuiError("Missing --git-snapshot-bin");

  out.rootRepo = path.resolve(out.rootRepo);
  out.rootRepoPhysical = resolvePhysicalPath(out.rootRepo);
  out.initialViewState = normalizeViewState({
    mode: out.mode,
    snapshotId: out.snapshotId,
    repoFilter: out.repoFilter,
    reviewSelectedRepos: out.reviewSelectedRepos,
    reviewBaseRef: out.reviewBaseRef,
    reviewRepoBaseOverrides: out.reviewRepoBaseOverrides,
    compareIncludeNoEffect: out.compareIncludeNoEffect,
    compareBase: out.compareBase,
    inspectIncludeStaged: out.inspectIncludeStaged,
    inspectIncludeUnstaged: out.inspectIncludeUnstaged,
    inspectIncludeUntracked: out.inspectIncludeUntracked,
    inspectShowAllRepos: out.inspectShowAllRepos,
    browseIncludeStaged: out.browseIncludeStaged,
    browseIncludeUnstaged: out.browseIncludeUnstaged,
    browseIncludeUntracked: out.browseIncludeUntracked,
    browseIncludeSubmodules: out.browseIncludeSubmodules,
    browseShowAllRepos: out.browseShowAllRepos,
  }, out);
  return out;
}

function resolvePhysicalPath(targetPath) {
  try {
    if (fs.realpathSync && typeof fs.realpathSync.native === "function") {
      return fs.realpathSync.native(targetPath);
    }
    return fs.realpathSync(targetPath);
  } catch (_error) {
    return path.resolve(targetPath);
  }
}

function run(cmd, args, opts) {
  return spawnSync(cmd, args, Object.assign({
    encoding: "utf8",
    maxBuffer: RUN_MAX_BUFFER_BYTES,
  }, opts || {}));
}

function terminateChildProcess(proc) {
  if (!proc || proc.exitCode !== null || proc.signalCode || proc.killed) {
    return;
  }
  try {
    proc.kill("SIGTERM");
  } catch (_err) {
    return;
  }
  const killTimer = setTimeout(() => {
    if (!proc || proc.exitCode !== null || proc.signalCode || proc.killed) {
      return;
    }
    try {
      proc.kill("SIGKILL");
    } catch (_err) {
      // Ignore escalation failures while trying to stop an abandoned request.
    }
  }, CHILD_ABORT_KILL_GRACE_MS);
  timerUnref(killTimer);
  proc.once("close", () => clearTimeout(killTimer));
}

function runGitSnapshotAsync(args, commandArgs, options) {
  const signal = options && options.signal ? options.signal : null;
  return new Promise((resolve, reject) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const proc = spawn(args.gitSnapshotBin, commandArgs, {
      cwd: args.rootRepo,
      stdio: ["ignore", "pipe", "pipe"],
    });

    function cleanup() {
      if (signal && typeof signal.removeEventListener === "function" && onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    }

    function finishReject(err) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(err);
    }

    function finishResolve(value) {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    }

    function appendChunk(current, chunk, streamLabel) {
      const next = current + chunk.toString("utf8");
      if (Buffer.byteLength(next, "utf8") > RUN_MAX_BUFFER_BYTES) {
        terminateChildProcess(proc);
        finishReject(new SnapshotGuiError(`${streamLabel} exceeded ${RUN_MAX_BUFFER_BYTES} bytes.`));
        return current;
      }
      return next;
    }

    function onAbort() {
      terminateChildProcess(proc);
      finishReject(new SnapshotGuiRequestAbortedError());
    }

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      if (typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    proc.stdout.on("data", (chunk) => {
      stdout = appendChunk(stdout, chunk, "stdout");
    });
    proc.stderr.on("data", (chunk) => {
      stderr = appendChunk(stderr, chunk, "stderr");
    });
    proc.on("error", (err) => finishReject(err));
    proc.on("close", (code, signalCode) => {
      if (settled) {
        return;
      }
      if (signal && signal.aborted) {
        finishReject(new SnapshotGuiRequestAbortedError());
        return;
      }
      if (code !== 0) {
        const detail = (stderr || stdout || "").trim();
        finishReject(
          new SnapshotGuiError(
            detail || `git-snapshot exited with ${code}${signalCode ? ` (${signalCode})` : ""}.`
          )
        );
        return;
      }
      finishResolve(stdout || "");
    });
  });
}

function isRequestAbortedError(err) {
  return Boolean(err && err.code === "SNAPSHOT_GUI_REQUEST_ABORTED");
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
  const repoRows = [];
  const rows = [];
  const summary = {};

  for (const rawLine of stdoutText.split(/\r?\n/)) {
    const line = rawLine;
    if (!line) continue;
    const { kind, fields } = parsePorcelainFields(line);
    if (kind === "compare_target") target.selected = fields;
    else if (kind === "compare_repo") repoRows.push(fields);
    else if (kind === "compare_file") rows.push(fields);
    else if (kind === "compare_summary") summary.value = fields;
  }

  return {
    targetFields: target.selected || {},
    repoRows,
    rows,
    summaryFields: summary.value || {},
  };
}

function parseCompareMaterializedRepoPorcelain(stdoutText) {
  for (const rawLine of stdoutText.split(/\r?\n/)) {
    const line = rawLine;
    if (!line) continue;
    const { kind, fields } = parsePorcelainFields(line);
    if (kind === "compare_materialized_repo") {
      return fields;
    }
  }
  throw new SnapshotGuiError("Internal compare materialization returned no compare_materialized_repo record.");
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

function parseBrowsePorcelain(stdoutText) {
  const target = {};
  const repoRows = [];
  const categoryRows = [];
  const fileRows = [];

  for (const rawLine of stdoutText.split(/\r?\n/)) {
    const line = rawLine;
    if (!line) continue;
    const { kind, fields } = parsePorcelainFields(line);
    if (kind === "browse_target") target.selected = fields;
    else if (kind === "browse_repo") repoRows.push(fields);
    else if (kind === "browse") categoryRows.push(fields);
    else if (kind === "browse_file") fileRows.push(fields);
  }

  return {
    targetFields: target.selected || {},
    repoRows,
    categoryRows,
    fileRows,
  };
}

function parseReviewPorcelain(stdoutText) {
  const target = {};
  const summary = {};
  const repoRows = [];
  const rows = [];
  const refRows = [];

  for (const rawLine of stdoutText.split(/\r?\n/)) {
    const line = rawLine;
    if (!line) continue;
    const { kind, fields } = parsePorcelainFields(line);
    if (kind === "review_target") target.selected = fields;
    else if (kind === "review_summary") summary.value = fields;
    else if (kind === "review_repo") repoRows.push(fields);
    else if (kind === "review_ref") refRows.push(fields);
    else if (kind === "review_file") rows.push(fields);
  }

  return {
    targetFields: target.selected || {},
    summaryFields: summary.value || {},
    repoRows,
    refRows,
    rows,
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

function numericSnapshotSortValue(rawValue) {
  const parsed = Number(rawValue);
  return Number.isFinite(parsed) ? parsed : -1;
}

function snapshotCreatedAtEpochValue(snapshot) {
  return numericSnapshotSortValue(snapshot && snapshot.created_at_epoch);
}

function snapshotSortMtimeMsValue(snapshot) {
  const sortMtime = numericSnapshotSortValue(snapshot && snapshot.sort_mtime_ms);
  if (sortMtime >= 0) {
    return sortMtime;
  }
  const createdAtEpoch = snapshotCreatedAtEpochValue(snapshot);
  return createdAtEpoch >= 0 ? createdAtEpoch * 1000 : -1;
}

function compareSnapshotsNewestFirst(leftSnapshot, rightSnapshot) {
  const mtimeDiff = snapshotSortMtimeMsValue(rightSnapshot) - snapshotSortMtimeMsValue(leftSnapshot);
  if (mtimeDiff !== 0) {
    return mtimeDiff;
  }

  const createdAtDiff = snapshotCreatedAtEpochValue(rightSnapshot) - snapshotCreatedAtEpochValue(leftSnapshot);
  if (createdAtDiff !== 0) {
    return createdAtDiff;
  }

  const leftId = String((leftSnapshot && leftSnapshot.id) || "");
  const rightId = String((rightSnapshot && rightSnapshot.id) || "");
  if (leftId === rightId) {
    return 0;
  }
  return leftId < rightId ? 1 : -1;
}

function sortSnapshotsNewestFirst(snapshots) {
  return (Array.isArray(snapshots) ? snapshots.slice() : []).sort(compareSnapshotsNewestFirst);
}

function decorateSnapshotRecord(rootRepo, snapshot) {
  const record = Object.assign({}, snapshot || {});
  const snapshotId = String(record.id || "");
  if (!snapshotId) {
    record.sort_mtime_ms = String(snapshotSortMtimeMsValue(record));
    return record;
  }

  let sortMtimeMs = snapshotCreatedAtEpochValue(record) * 1000;
  try {
    const stats = fs.statSync(snapshotStorePathForRepo(rootRepo, snapshotId));
    if (stats && Number.isFinite(stats.mtimeMs)) {
      sortMtimeMs = stats.mtimeMs;
    }
  } catch (_err) {
    // Keep the metadata-based fallback if the snapshot path is not stat-able.
  }

  record.sort_mtime_ms = String(Number.isFinite(sortMtimeMs) ? sortMtimeMs : -1);
  return record;
}

function boolString(value) {
  return value ? "true" : "false";
}

function normalizeMode(value, fallback) {
  if (value === "browse" || value === "compare" || value === "inspect" || value === "review") return value;
  return fallback;
}

function normalizeBool(value, fallback) {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return fallback;
}

function normalizeStringList(values, fallback) {
  const source = Array.isArray(values) ? values : (Array.isArray(fallback) ? fallback : []);
  return uniqueStrings(source.map((value) => String(value || "")).filter(Boolean));
}

function normalizeReviewBaseRef(value, fallback = "master") {
  const normalized = String(value == null ? "" : value).trim();
  if (normalized) {
    return normalized;
  }
  return String(fallback || "master").trim() || "master";
}

function normalizeReviewRepoBaseOverrides(rawOverrides, fallback) {
  const base = fallback && typeof fallback === "object" ? fallback : {};
  const source = rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)
    ? rawOverrides
    : base;
  const overrides = {};
  for (const rawRepo of Object.keys(source).sort()) {
    const rawRef = source[rawRepo];
    const repo = String(rawRepo || "").trim();
    const ref = String(rawRef || "").trim();
    if (!repo || !ref) {
      continue;
    }
    overrides[repo] = ref;
  }
  return overrides;
}

function normalizeReviewPresetName(rawValue) {
  return String(rawValue || "").trim();
}

function normalizeReviewPresetRecord(rawPreset) {
  const name = normalizeReviewPresetName(rawPreset && rawPreset.name);
  const repos = normalizeStringList(rawPreset && rawPreset.repos, []);
  if (!name || !repos.length) {
    return null;
  }
  const defaultBaseRef = normalizeReviewBaseRef(rawPreset && rawPreset.default_base_ref, "master");
  const repoBaseOverrides = normalizeReviewRepoBaseOverrides(rawPreset && rawPreset.repo_base_overrides, {});
  const normalizedOverrides = {};
  for (const repo of repos) {
    const overrideRef = String(repoBaseOverrides[repo] || "").trim();
    if (overrideRef && overrideRef !== defaultBaseRef) {
      normalizedOverrides[repo] = overrideRef;
    }
  }
  return {
    name,
    repos,
    default_base_ref: defaultBaseRef,
    repo_base_overrides: normalizedOverrides,
    updated_at: String(rawPreset && rawPreset.updated_at ? rawPreset.updated_at : ""),
  };
}

function normalizeReviewPresets(rawPresets) {
  const normalized = [];
  const names = new Set();
  for (const rawPreset of Array.isArray(rawPresets) ? rawPresets : []) {
    const preset = normalizeReviewPresetRecord(rawPreset);
    if (!preset) continue;
    const nameKey = preset.name.toLowerCase();
    if (names.has(nameKey)) continue;
    names.add(nameKey);
    normalized.push(preset);
  }
  return normalized;
}

function loadReviewPresets(rootRepo) {
  const presetsPath = reviewPresetsPathForRepo(rootRepo);
  if (!fs.existsSync(presetsPath)) {
    return [];
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(presetsPath, "utf8"));
  } catch (err) {
    throw new SnapshotGuiError(`Failed to parse ${presetsPath}: ${err && err.message ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object") {
    throw new SnapshotGuiError(`${presetsPath} must contain a JSON object.`);
  }
  return normalizeReviewPresets(parsed.presets);
}

function writeReviewPresets(rootRepo, presets) {
  const normalizedPresets = normalizeReviewPresets(presets);
  const presetsPath = reviewPresetsPathForRepo(rootRepo);
  ensureDir(path.dirname(presetsPath));
  const payload = {
    version: 2,
    presets: normalizedPresets,
  };
  const tempPath = `${presetsPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.renameSync(tempPath, presetsPath);
  return normalizedPresets;
}

function createEmptyViewedStateDocument() {
  return {
    version: 1,
    roots: {},
  };
}

function normalizeViewedStateEntry(rawEntry) {
  if (!rawEntry || typeof rawEntry !== "object") {
    return null;
  }
  const mode = normalizeMode(rawEntry.mode, "");
  const repo = String(rawEntry.repo || "").trim();
  const file = String(rawEntry.file || "").trim();
  const category = String(rawEntry.category || "").trim();
  const viewToken = String(rawEntry.view_token || "").trim();
  const previewBlobId = String(rawEntry.preview_blob_id || "").trim();
  const previewKind = String(rawEntry.preview_kind || "").trim();
  const markedAt = String(rawEntry.marked_at || "").trim();
  const contextLabel = String(rawEntry.context_label || "").trim();
  if (!mode || !repo || !file || !viewToken) {
    return null;
  }
  return {
    mode,
    repo,
    category: (mode === "browse" || mode === "inspect") ? category : "",
    file,
    view_token: viewToken,
    preview_blob_id: previewBlobId,
    preview_kind: previewKind,
    marked_at: markedAt,
    context_label: contextLabel,
  };
}

function normalizeViewedStateDocument(rawDocument) {
  const doc = createEmptyViewedStateDocument();
  if (!rawDocument || typeof rawDocument !== "object") {
    return doc;
  }
  const rawRoots = rawDocument.roots && typeof rawDocument.roots === "object" ? rawDocument.roots : {};
  for (const [rootPath, rootRecord] of Object.entries(rawRoots)) {
    const normalizedRootPath = String(rootPath || "").trim();
    if (!normalizedRootPath) {
      continue;
    }
    const rawEntries = rootRecord && typeof rootRecord === "object" && rootRecord.entries && typeof rootRecord.entries === "object"
      ? rootRecord.entries
      : {};
    const entries = {};
    for (const rawEntry of Object.values(rawEntries)) {
      const normalizedEntry = normalizeViewedStateEntry(rawEntry);
      if (!normalizedEntry) {
        continue;
      }
      const entryKey = buildRowIdentityKeyShared(
        normalizedEntry.mode,
        normalizedEntry.repo,
        normalizedEntry.category,
        normalizedEntry.file
      );
      entries[entryKey] = normalizedEntry;
    }
    doc.roots[normalizedRootPath] = { entries };
  }
  return doc;
}

function readViewedStateDocumentWithMeta(rootRepo) {
  const statePath = viewedStatePathForRepo(rootRepo);
  if (!fs.existsSync(statePath)) {
    return {
      path: statePath,
      mtimeMs: null,
      doc: createEmptyViewedStateDocument(),
    };
  }
  let parsed = null;
  let stats = null;
  try {
    stats = fs.statSync(statePath);
    parsed = JSON.parse(fs.readFileSync(statePath, "utf8"));
  } catch (err) {
    throw new SnapshotGuiError(`Failed to parse ${statePath}: ${err && err.message ? err.message : String(err)}`);
  }
  return {
    path: statePath,
    mtimeMs: stats && Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : null,
    doc: normalizeViewedStateDocument(parsed),
  };
}

function ensureViewedStateRootRecord(doc, physicalRootRepo) {
  const normalizedRoot = String(physicalRootRepo || "").trim();
  if (!normalizedRoot) {
    throw new SnapshotGuiError("Viewed state root path cannot be empty.");
  }
  if (!doc.roots[normalizedRoot]) {
    doc.roots[normalizedRoot] = { entries: {} };
  } else if (!doc.roots[normalizedRoot].entries || typeof doc.roots[normalizedRoot].entries !== "object") {
    doc.roots[normalizedRoot].entries = {};
  }
  return doc.roots[normalizedRoot];
}

function writeViewedStateDocument(rootRepo, doc) {
  const statePath = viewedStatePathForRepo(rootRepo);
  ensureDir(path.dirname(statePath));
  const payload = normalizeViewedStateDocument(doc);
  const tempPath = `${statePath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
  fs.renameSync(tempPath, statePath);
  return payload;
}

function viewedPreviewBlobPath(rootRepo, blobId) {
  return path.join(viewedPreviewBlobsDirForRepo(rootRepo), `${String(blobId || "").trim()}.json`);
}

function writeViewedPreviewBlob(rootRepo, blobPayload) {
  const serializedPayload = JSON.stringify(blobPayload || {}, null, 2) + "\n";
  if (VIEWED_PREVIEW_MAX_BYTES > 0 && Buffer.byteLength(serializedPayload, "utf8") > VIEWED_PREVIEW_MAX_BYTES) {
    return "";
  }
  const blobId = sha1Text(`${Date.now()}\n${process.pid}\n${crypto.randomBytes(12).toString("hex")}\n${JSON.stringify(blobPayload || {})}`);
  const blobsDir = viewedPreviewBlobsDirForRepo(rootRepo);
  ensureDir(blobsDir);
  const targetPath = viewedPreviewBlobPath(rootRepo, blobId);
  const tempPath = `${targetPath}.tmp-${process.pid}`;
  fs.writeFileSync(tempPath, serializedPayload, "utf8");
  fs.renameSync(tempPath, targetPath);
  return blobId;
}

function removeViewedPreviewBlob(rootRepo, blobId) {
  const targetPath = viewedPreviewBlobPath(rootRepo, blobId);
  if (fs.existsSync(targetPath)) {
    fs.unlinkSync(targetPath);
  }
}

function loadViewedPreviewBlob(rootRepo, blobId) {
  const targetPath = viewedPreviewBlobPath(rootRepo, blobId);
  if (!blobId || !fs.existsSync(targetPath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(targetPath, "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    return parsed;
  } catch (_err) {
    return null;
  }
}

function viewedPreviewBlobIsUsable(rootRepo, blobId) {
  if (!blobId) {
    return false;
  }
  return Boolean(normalizeStoredPreviewSnapshot(loadViewedPreviewBlob(rootRepo, blobId)));
}

function pruneViewedPreviewBlobs(rootRepo, doc) {
  const blobsDir = viewedPreviewBlobsDirForRepo(rootRepo);
  if (!fs.existsSync(blobsDir)) {
    return;
  }
  const liveBlobIds = new Set();
  const roots = doc && doc.roots && typeof doc.roots === "object" ? Object.values(doc.roots) : [];
  for (const rootRecord of roots) {
    const entries = rootRecord && typeof rootRecord === "object" && rootRecord.entries && typeof rootRecord.entries === "object"
      ? Object.values(rootRecord.entries)
      : [];
    for (const entry of entries) {
      const blobId = String(entry && entry.preview_blob_id ? entry.preview_blob_id : "").trim();
      if (blobId) {
        liveBlobIds.add(blobId);
      }
    }
  }
  for (const entryName of fs.readdirSync(blobsDir)) {
    if (!entryName.endsWith(".json")) {
      continue;
    }
    const blobId = entryName.slice(0, -".json".length);
    if (!liveBlobIds.has(blobId)) {
      try {
        fs.unlinkSync(path.join(blobsDir, entryName));
      } catch (_err) {
        // Best effort pruning only.
      }
    }
  }
}

function viewedStateRootRecordForPhysicalPath(doc, physicalRootRepo) {
  const normalizedDoc = normalizeViewedStateDocument(doc);
  return normalizedDoc.roots && typeof normalizedDoc.roots === "object"
    ? (normalizedDoc.roots[String(physicalRootRepo || "").trim()] || { entries: {} })
    : { entries: {} };
}

function updateViewedStateDocument(rootRepo, physicalRootRepo, mutator) {
  const statePath = viewedStatePathForRepo(rootRepo);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const loaded = readViewedStateDocumentWithMeta(rootRepo);
    const nextDoc = normalizeViewedStateDocument(loaded.doc);
    const rootRecord = ensureViewedStateRootRecord(nextDoc, physicalRootRepo);
    const result = mutator(nextDoc, rootRecord);
    let currentMtimeMs = null;
    if (fs.existsSync(statePath)) {
      try {
        const currentStats = fs.statSync(statePath);
        currentMtimeMs = Number.isFinite(currentStats.mtimeMs) ? currentStats.mtimeMs : null;
      } catch (_err) {
        currentMtimeMs = null;
      }
    }
    if (attempt === 0 && loaded.mtimeMs !== currentMtimeMs) {
      continue;
    }
    const written = writeViewedStateDocument(rootRepo, nextDoc);
    pruneViewedPreviewBlobs(rootRepo, written);
    return {
      result,
      written,
      rootRecord: viewedStateRootRecordForPhysicalPath(written, physicalRootRepo),
    };
  }
  throw new SnapshotGuiError("Viewed state changed while updating. Please retry.");
}

function viewedStateCountsForRootRecord(rootRecord) {
  const counts = {
    all: 0,
    by_mode: {
      browse: 0,
      compare: 0,
      inspect: 0,
      review: 0,
    },
  };
  const entries = rootRecord && rootRecord.entries && typeof rootRecord.entries === "object"
    ? Object.values(rootRecord.entries)
    : [];
  for (const entry of entries) {
    const mode = normalizeMode(entry && entry.mode, "");
    if (!mode) {
      continue;
    }
    counts.all += 1;
    counts.by_mode[mode] = (counts.by_mode[mode] || 0) + 1;
  }
  return counts;
}

function upsertReviewPreset(rootRepo, name, repos, defaultBaseRef, repoBaseOverrides) {
  const normalizedName = normalizeReviewPresetName(name);
  const normalizedRepos = normalizeStringList(repos, []);
  const normalizedDefaultBaseRef = normalizeReviewBaseRef(defaultBaseRef, "master");
  const normalizedRepoBaseOverrides = normalizeReviewRepoBaseOverrides(repoBaseOverrides, {});
  if (!normalizedName) {
    throw new SnapshotGuiError("Preset name cannot be empty.");
  }
  if (!normalizedRepos.length) {
    throw new SnapshotGuiError("Review preset must include at least one repo.");
  }
  const presets = loadReviewPresets(rootRepo);
  const nowIso = new Date().toISOString();
  const nameKey = normalizedName.toLowerCase();
  const existingIndex = presets.findIndex((preset) => preset.name.toLowerCase() === nameKey);
  const filteredOverrides = {};
  for (const repo of normalizedRepos) {
    const overrideRef = String(normalizedRepoBaseOverrides[repo] || "").trim();
    if (overrideRef && overrideRef !== normalizedDefaultBaseRef) {
      filteredOverrides[repo] = overrideRef;
    }
  }
  const nextPreset = {
    name: normalizedName,
    repos: normalizedRepos,
    default_base_ref: normalizedDefaultBaseRef,
    repo_base_overrides: filteredOverrides,
    updated_at: nowIso,
  };
  if (existingIndex >= 0) {
    presets.splice(existingIndex, 1, nextPreset);
  } else {
    presets.push(nextPreset);
  }
  return writeReviewPresets(rootRepo, presets);
}

function encodeReviewRepoBasesForUrl(values, selectedRepos, defaultBaseRef) {
  const normalizedDefaultBaseRef = normalizeReviewBaseRef(defaultBaseRef, "master");
  const selectedRepoSet = new Set(normalizeStringList(selectedRepos, []));
  const normalized = normalizeReviewRepoBaseOverrides(values, {});
  const filtered = {};
  for (const repo of Object.keys(normalized).sort()) {
    if (!selectedRepoSet.has(repo)) {
      continue;
    }
    const ref = String(normalized[repo] || "").trim();
    if (!ref || ref === normalizedDefaultBaseRef) {
      continue;
    }
    filtered[repo] = ref;
  }
  return Object.keys(filtered).length ? JSON.stringify(filtered) : "";
}

function decodeReviewRepoBasesFromUrl(searchParams) {
  if (!(searchParams && searchParams.has("review_repo_bases"))) {
    return {};
  }
  const rawValue = String(searchParams.get("review_repo_bases") || "").trim();
  if (!rawValue) {
    return {};
  }
  try {
    return normalizeReviewRepoBaseOverrides(JSON.parse(rawValue), {});
  } catch (_err) {
    return {};
  }
}

function parseReviewRepoBasesTsv(rawValue) {
  const overrides = {};
  for (const line of String(rawValue || "").split(/\r?\n/)) {
    if (!line) continue;
    const tabIndex = line.indexOf("\t");
    if (tabIndex <= 0) {
      continue;
    }
    const repo = String(line.slice(0, tabIndex) || "").trim();
    const ref = String(line.slice(tabIndex + 1) || "").trim();
    if (!repo || !ref) {
      continue;
    }
    overrides[repo] = ref;
  }
  return overrides;
}

function reviewRefRowsForRepo(rootRepo, repoRel) {
  const normalizedRepoRel = String(repoRel || ".").trim() || ".";
  let repoAbs = rootRepo;
  try {
    repoAbs = normalizedRepoRel === "."
      ? rootRepo
      : resolveContainedPath(rootRepo, normalizedRepoRel, `Review ref options root [${normalizedRepoRel}]`);
  } catch (_err) {
    return [];
  }
  const repoCheck = run("git", ["-C", repoAbs, "rev-parse", "--is-inside-work-tree"]);
  if (repoCheck.status !== 0) {
    return [];
  }

  const sections = [
    { kind: "branch", namespace: "refs/heads" },
    { kind: "remote", namespace: "refs/remotes" },
    { kind: "tag", namespace: "refs/tags" },
  ];
  const seen = new Set();
  const rows = [];
  for (const section of sections) {
    const proc = run("git", ["-C", repoAbs, "for-each-ref", "--format=%(refname:short)", section.namespace]);
    if (proc.status !== 0) {
      continue;
    }
    for (const rawLine of String(proc.stdout || "").split(/\r?\n/)) {
      const ref = String(rawLine || "").trim();
      if (!ref || seen.has(ref)) {
        continue;
      }
      seen.add(ref);
      rows.push({
        repo: normalizedRepoRel,
        kind: section.kind,
        ref,
      });
    }
  }
  return rows;
}

function renameReviewPreset(rootRepo, oldName, newName) {
  const normalizedOldName = normalizeReviewPresetName(oldName);
  const normalizedNewName = normalizeReviewPresetName(newName);
  if (!normalizedOldName) {
    throw new SnapshotGuiError("Current preset name cannot be empty.");
  }
  if (!normalizedNewName) {
    throw new SnapshotGuiError("New preset name cannot be empty.");
  }
  const presets = loadReviewPresets(rootRepo);
  const existingIndex = presets.findIndex((preset) => preset.name.toLowerCase() === normalizedOldName.toLowerCase());
  if (existingIndex < 0) {
    throw new SnapshotGuiError(`Preset "${normalizedOldName}" was not found.`);
  }
  const collisionIndex = presets.findIndex((preset) => preset.name.toLowerCase() === normalizedNewName.toLowerCase());
  if (collisionIndex >= 0 && collisionIndex !== existingIndex) {
    throw new SnapshotGuiError(`Preset "${normalizedNewName}" already exists.`);
  }
  const currentPreset = presets[existingIndex];
  presets.splice(existingIndex, 1, Object.assign({}, currentPreset, {
    name: normalizedNewName,
    updated_at: new Date().toISOString(),
  }));
  return writeReviewPresets(rootRepo, presets);
}

function deleteReviewPreset(rootRepo, name) {
  const normalizedName = normalizeReviewPresetName(name);
  if (!normalizedName) {
    throw new SnapshotGuiError("Preset name cannot be empty.");
  }
  const presets = loadReviewPresets(rootRepo);
  const nextPresets = presets.filter((preset) => preset.name.toLowerCase() !== normalizedName.toLowerCase());
  if (nextPresets.length === presets.length) {
    throw new SnapshotGuiError(`Preset "${normalizedName}" was not found.`);
  }
  return writeReviewPresets(rootRepo, nextPresets);
}

function encodeReviewReposForUrl(values) {
  const repos = normalizeStringList(values, []);
  return repos.length ? JSON.stringify(repos) : "";
}

function decodeReviewReposFromUrl(searchParams) {
  if (searchParams && searchParams.has("review_repos")) {
    const rawValue = String(searchParams.get("review_repos") || "").trim();
    if (!rawValue) {
      return [];
    }
    try {
      const parsed = JSON.parse(rawValue);
      return normalizeStringList(Array.isArray(parsed) ? parsed : [], []);
    } catch (_err) {
      return [];
    }
  }
  return searchParams ? normalizeStringList(searchParams.getAll("review_repo"), []) : [];
}

function normalizeViewState(rawState, args) {
  const mode = normalizeMode(rawState.mode, args.initialViewState ? args.initialViewState.mode : args.mode);
  const snapshotId = String(rawState.snapshotId || args.initialViewState?.snapshotId || args.snapshotId || "");
  const repoFilter = String(rawState.repoFilter || "");
  const reviewSelectedRepos = normalizeStringList(
    rawState.reviewSelectedRepos,
    args.initialViewState ? args.initialViewState.reviewSelectedRepos : args.reviewSelectedRepos
  );
  const reviewBaseRef = normalizeReviewBaseRef(
    rawState.reviewBaseRef,
    args.initialViewState ? args.initialViewState.reviewBaseRef : args.reviewBaseRef
  );
  const reviewRepoBaseOverridesRaw = normalizeReviewRepoBaseOverrides(
    rawState.reviewRepoBaseOverrides,
    args.initialViewState ? args.initialViewState.reviewRepoBaseOverrides : args.reviewRepoBaseOverrides
  );
  const reviewRepoBaseOverrides = {};
  for (const repo of reviewSelectedRepos) {
    const ref = String(reviewRepoBaseOverridesRaw[repo] || "").trim();
    if (ref && ref !== reviewBaseRef) {
      reviewRepoBaseOverrides[repo] = ref;
    }
  }
  const compareIncludeNoEffect = normalizeBool(
    rawState.compareIncludeNoEffect,
    args.initialViewState
      ? args.initialViewState.compareIncludeNoEffect
      : (args.compareIncludeNoEffect === "true" || args.compareShowAll === "true")
  );
  const compareBase = normalizeCompareBase(
    rawState.compareBase,
    args.initialViewState ? args.initialViewState.compareBase : args.compareBase
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
  let browseIncludeStaged = normalizeBool(
    rawState.browseIncludeStaged,
    args.initialViewState ? args.initialViewState.browseIncludeStaged : args.browseIncludeStaged === "true"
  );
  let browseIncludeUnstaged = normalizeBool(
    rawState.browseIncludeUnstaged,
    args.initialViewState ? args.initialViewState.browseIncludeUnstaged : args.browseIncludeUnstaged === "true"
  );
  let browseIncludeUntracked = normalizeBool(
    rawState.browseIncludeUntracked,
    args.initialViewState ? args.initialViewState.browseIncludeUntracked : args.browseIncludeUntracked === "true"
  );
  let browseIncludeSubmodules = normalizeBool(
    rawState.browseIncludeSubmodules,
    args.initialViewState ? args.initialViewState.browseIncludeSubmodules : args.browseIncludeSubmodules === "true"
  );
  const browseShowAllRepos = normalizeBool(
    rawState.browseShowAllRepos,
    args.initialViewState ? args.initialViewState.browseShowAllRepos : args.browseShowAllRepos === "true"
  );

  if (!inspectIncludeStaged && !inspectIncludeUnstaged && !inspectIncludeUntracked) {
    inspectIncludeStaged = true;
    inspectIncludeUnstaged = true;
    inspectIncludeUntracked = true;
  }
  if (!browseIncludeStaged && !browseIncludeUnstaged && !browseIncludeUntracked && !browseIncludeSubmodules) {
    browseIncludeStaged = true;
    browseIncludeUnstaged = true;
    browseIncludeUntracked = true;
    browseIncludeSubmodules = true;
  }

  const rawSelectedRepo = String(rawState.selectedRepo || "");
  const rawSelectedCategory = String(rawState.selectedCategory || "");
  const rawSelectedFile = String(rawState.selectedFile || "");
  const selectedKind = normalizeSelectedKind(
    mode,
    rawState.selectedKind || rawState.selected_kind,
    rawSelectedRepo,
    rawSelectedCategory,
    rawSelectedFile
  );
  const selectedRepo = selectedKind ? rawSelectedRepo : "";
  const selectedCategory = (selectedKind === "file" || selectedKind === "category") && (mode === "inspect" || mode === "browse")
    ? rawSelectedCategory
    : "";
  const selectedFile = selectedKind === "file" ? rawSelectedFile : "";

  return {
    mode,
    snapshotId,
    repoFilter,
    reviewSelectedRepos,
    reviewBaseRef,
    reviewRepoBaseOverrides,
    compareIncludeNoEffect,
    compareBase,
    inspectIncludeStaged,
    inspectIncludeUnstaged,
    inspectIncludeUntracked,
    inspectShowAllRepos,
    browseIncludeStaged,
    browseIncludeUnstaged,
    browseIncludeUntracked,
    browseIncludeSubmodules,
    browseShowAllRepos,
    selectedKind,
    selectedRepo,
    selectedCategory,
    selectedFile,
  };
}

function dataViewStateKey(viewState) {
  return JSON.stringify({
    mode: viewState.mode,
    snapshotId: viewState.snapshotId,
    repoFilter: viewState.repoFilter,
    reviewSelectedRepos: Array.isArray(viewState.reviewSelectedRepos) ? viewState.reviewSelectedRepos.slice() : [],
    reviewBaseRef: normalizeReviewBaseRef(viewState.reviewBaseRef, "master"),
    reviewRepoBaseOverrides: normalizeReviewRepoBaseOverrides(viewState.reviewRepoBaseOverrides, {}),
    compare_include_no_effect: boolString(viewState.compareIncludeNoEffect),
    compareBase: normalizeCompareBase(viewState.compareBase),
    inspectIncludeStaged: boolString(viewState.inspectIncludeStaged),
    inspectIncludeUnstaged: boolString(viewState.inspectIncludeUnstaged),
    inspectIncludeUntracked: boolString(viewState.inspectIncludeUntracked),
    inspectShowAllRepos: boolString(viewState.inspectShowAllRepos),
    browseIncludeStaged: boolString(viewState.browseIncludeStaged),
    browseIncludeUnstaged: boolString(viewState.browseIncludeUnstaged),
    browseIncludeUntracked: boolString(viewState.browseIncludeUntracked),
    browseIncludeSubmodules: boolString(viewState.browseIncludeSubmodules),
    browseShowAllRepos: boolString(viewState.browseShowAllRepos),
  });
}

function viewStateKey(viewState) {
  return dataViewStateKey(viewState);
}

function rowKey(mode, repoRel, category, filePath) {
  return buildRowIdentityKeyShared(mode, repoRel, category, filePath);
}

function normalizeSelectedKind(mode, rawKind, selectedRepo, selectedCategory, selectedFile) {
  return normalizeSelectedKindShared(mode, rawKind, selectedRepo, selectedCategory, selectedFile);
}

function buildSelectionFallbackSequence(mode, rawKind, selectedRepo, selectedCategory, selectedFile) {
  return buildSelectionFallbackSequenceShared(
    mode,
    rawKind,
    selectedRepo,
    selectedCategory,
    selectedFile
  );
}

function selectionKey(mode, kind, repoRel, category, filePath) {
  return buildSelectionIdentityKeyShared(mode, kind, repoRel, category, filePath);
}

function selectionNodeFromFileRow(mode, row) {
  return Object.assign({ selection_kind: "file" }, row || {}, {
    repo: String(row && row.repo ? row.repo : ""),
    category: String(row && row.category ? row.category : ""),
    file: String(row && row.file ? row.file : ""),
  });
}

function selectionNodeFromRepoRow(repoRow) {
  return {
    selection_kind: "repo",
    repo: String(repoRow && repoRow.repo ? repoRow.repo : ""),
    category: "",
    file: "",
    repoRow: repoRow || null,
  };
}

function selectionNodeFromCategoryRow(categoryRow) {
  return {
    selection_kind: "category",
    repo: String(categoryRow && categoryRow.repo ? categoryRow.repo : ""),
    category: String(categoryRow && categoryRow.category ? categoryRow.category : ""),
    file: "",
    categoryRow: categoryRow || null,
  };
}

function selectionNodeKey(mode, node) {
  if (!node) return "";
  return selectionKey(
    mode,
    node.selection_kind || "file",
    node.repo || "",
    node.category || "",
    node.file || ""
  );
}

function findCompareRow(data, repoRel, filePath) {
  const rows = data && Array.isArray(data.rows) ? data.rows : [];
  const key = rowKey("compare", repoRel, "", filePath);
  return rows.find((row) => rowKey("compare", row.repo || "", "", row.file || "") === key) || null;
}

function compareNumericField(value, fallback = 0) {
  const parsed = Number(String(value == null ? "" : value).trim());
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compareRepoSummaryRows(data) {
  return data && Array.isArray(data.repoRows) ? data.repoRows : [];
}

function recomputeCompareSummaryFromRepoRows(baseSummaryFields, viewState, repoRows, availableRepos) {
  const counts = {
    files_total: 0,
    shown_files: 0,
    effect_files: 0,
    no_effect_files: 0,
    hidden_no_effect_files: 0,
    resolved_committed: 0,
    resolved_uncommitted: 0,
    unresolved_missing: 0,
    unresolved_diverged: 0,
    shown_lines_added: 0,
    shown_lines_removed: 0,
  };

  for (const row of Array.isArray(repoRows) ? repoRows : []) {
    const shown = compareNumericField(row && row.shown_files, 0);
    const effect = compareNumericField(row && row.effect_files, 0);
    const hiddenNoEffect = compareNumericField(row && row.hidden_no_effect_files, 0);
    counts.shown_files += shown;
    counts.effect_files += effect;
    counts.hidden_no_effect_files += hiddenNoEffect;
    counts.files_total += shown + hiddenNoEffect;
    counts.no_effect_files += Math.max(0, shown - effect) + hiddenNoEffect;
    counts.resolved_committed += compareNumericField(row && row.resolved_committed, 0);
    counts.resolved_uncommitted += compareNumericField(row && row.resolved_uncommitted, 0);
    counts.unresolved_missing += compareNumericField(row && row.unresolved_missing, 0);
    counts.unresolved_diverged += compareNumericField(row && row.unresolved_diverged, 0);
    counts.shown_lines_added += compareNumericField(row && row.shown_lines_added, 0);
    counts.shown_lines_removed += compareNumericField(row && row.shown_lines_removed, 0);
  }

  counts.unresolved_total = counts.unresolved_missing + counts.unresolved_diverged;
  const repoCountFromRows = uniqueStrings((Array.isArray(repoRows) ? repoRows : []).map((row) => row && row.repo ? row.repo : "")).length;
  const repoCountFromSummary = compareNumericField(baseSummaryFields && baseSummaryFields.repos_checked, 0);
  const repoCountFromAvailable = uniqueStrings(Array.isArray(availableRepos) ? availableRepos : []).length;
  const reposChecked = viewState && viewState.repoFilter
    ? 1
    : Math.max(repoCountFromRows, repoCountFromSummary, repoCountFromAvailable);

  return Object.assign({}, baseSummaryFields || {}, {
    repos_checked: String(reposChecked),
    files_total: String(counts.files_total),
    shown_files: String(counts.shown_files),
    effect_files: String(counts.effect_files),
    no_effect_files: String(counts.no_effect_files),
    hidden_no_effect_files: String(counts.hidden_no_effect_files),
    resolved_committed: String(counts.resolved_committed),
    resolved_uncommitted: String(counts.resolved_uncommitted),
    unresolved_missing: String(counts.unresolved_missing),
    unresolved_diverged: String(counts.unresolved_diverged),
    unresolved_total: String(counts.unresolved_total),
    shown_lines_added: String(counts.shown_lines_added),
    shown_lines_removed: String(counts.shown_lines_removed),
    include_no_effect: boolString(viewState && viewState.compareIncludeNoEffect),
    compare_base: normalizeCompareBase(viewState && viewState.compareBase),
    contract_version: String((baseSummaryFields && baseSummaryFields.contract_version) || "8"),
  });
}

function findInspectRow(data, repoRel, category, filePath) {
  const rows = data && Array.isArray(data.fileRows) ? data.fileRows : [];
  const key = rowKey("inspect", repoRel, category, filePath);
  return rows.find((row) => rowKey("inspect", row.repo || "", row.category || "", row.file || "") === key) || null;
}

function findBrowseRow(data, repoRel, category, filePath) {
  const rows = data && Array.isArray(data.fileRows) ? data.fileRows : [];
  const key = rowKey("browse", repoRel, category, filePath);
  return rows.find((row) => rowKey("browse", row.repo || "", row.category || "", row.file || "") === key) || null;
}

function findReviewRow(data, repoRel, filePath) {
  const rows = data && Array.isArray(data.rows) ? data.rows : [];
  const key = rowKey("review", repoRel, "", filePath);
  return rows.find((row) => rowKey("review", row.repo || "", "", row.file || "") === key) || null;
}

function repoCategoryGroupKey(repoRel, category = "") {
  return `${String(repoRel || "")}\0${String(category || "")}`;
}

function buildPreviewSelectionGroups(viewState, payload) {
  const mode = String(viewState && viewState.mode ? viewState.mode : "");
  const rows = (mode === "compare" || mode === "review")
    ? (Array.isArray(payload && payload.rows) ? payload.rows : [])
    : (Array.isArray(payload && payload.fileRows) ? payload.fileRows : []);
  const categoryRows = Array.isArray(payload && payload.categoryRows) ? payload.categoryRows : [];
  return buildPreviewSelectionGroupsFromCollections(mode, rows, categoryRows);
}

function previewSelectionGroups(viewState, payload) {
  if (!payload || typeof payload !== "object") {
    return buildPreviewSelectionGroups(viewState, payload);
  }
  const normalizedMode = String(viewState && viewState.mode ? viewState.mode : "");
  if (!payload.__previewSelectionGroups || payload.__previewSelectionGroupsMode !== normalizedMode) {
    const grouped = buildPreviewSelectionGroups(viewState, payload);
    Object.defineProperty(payload, "__previewSelectionGroups", {
      value: grouped,
      configurable: true,
      enumerable: false,
      writable: true,
    });
    Object.defineProperty(payload, "__previewSelectionGroupsMode", {
      value: normalizedMode,
      configurable: true,
      enumerable: false,
      writable: true,
    });
  }
  return payload.__previewSelectionGroups;
}

function previewSelectionRows(viewState, payload, selectionKind, repoRel, category) {
  const normalizedKind = String(selectionKind || "");
  const normalizedRepo = String(repoRel || "");
  const normalizedCategory = String(category || "");
  const groups = previewSelectionGroups(viewState, payload);
  if (normalizedKind === "repo") {
    return groups.rowsByRepo.get(normalizedRepo) || [];
  }
  if (normalizedKind === "category") {
    return groups.rowsByRepoCategory.get(repoCategoryGroupKey(normalizedRepo, normalizedCategory)) || [];
  }
  return [];
}

function previewSelectionRepoRow(payload, repoRel) {
  const repoRows = Array.isArray(payload && payload.repoRows) ? payload.repoRows : [];
  const normalizedRepo = String(repoRel || "");
  return repoRows.find((row) => String(row && row.repo ? row.repo : "") === normalizedRepo) || null;
}

function previewSelectionCategoryRow(payload, repoRel, category) {
  const normalizedRepo = String(repoRel || "");
  const normalizedCategory = String(category || "");
  const grouped = previewSelectionGroups(payload && payload.mode ? { mode: payload.mode } : { mode: "browse" }, payload);
  return grouped.categorySummaryByRepoCategory.get(repoCategoryGroupKey(normalizedRepo, normalizedCategory))
    || (Array.isArray(payload && payload.categoryRows) ? payload.categoryRows : []).find((row) => {
      return String(row && row.repo ? row.repo : "") === normalizedRepo
        && String(row && row.category ? row.category : "") === normalizedCategory;
    }) || null;
}

function normalizeAggregatePreviewOffset(rawValue) {
  const parsed = Number(rawValue || 0);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 0;
  }
  return Math.max(0, Math.floor(parsed));
}

function normalizeAggregatePreviewLimit(rawValue) {
  const parsed = Number(rawValue || AGGREGATE_PREVIEW_PAGE_SIZE);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return AGGREGATE_PREVIEW_PAGE_SIZE;
  }
  return Math.min(AGGREGATE_PREVIEW_MAX_PAGE_SIZE, Math.max(1, Math.floor(parsed)));
}

function parseAggregatePreviewLimit(rawValue) {
  const parsed = Number(rawValue || AGGREGATE_PREVIEW_PAGE_SIZE);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return {
      requested: AGGREGATE_PREVIEW_PAGE_SIZE,
      applied: AGGREGATE_PREVIEW_PAGE_SIZE,
      capped: false,
    };
  }
  const requested = Math.max(1, Math.floor(parsed));
  const applied = normalizeAggregatePreviewLimit(requested);
  return {
    requested,
    applied,
    capped: applied < requested,
  };
}

function logAggregatePreviewEvent(kind, fields) {
  if (process.env.GIT_SNAPSHOT_GUI_PREVIEW_TELEMETRY !== "1") {
    return;
  }
  const payload = fields && typeof fields === "object" ? fields : {};
  const parts = ["AGGREGATE_PREVIEW_" + String(kind || "EVENT").toUpperCase()];
  for (const [key, value] of Object.entries(payload)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    parts.push(`${key}=${String(value)}`);
  }
  console.error(parts.join(" "));
}

function logAggregatePreviewTelemetry(viewState, selectionKind, repoRel, category, payload) {
  if (process.env.GIT_SNAPSHOT_GUI_PREVIEW_TELEMETRY !== "1") {
    return;
  }
  const data = payload && typeof payload === "object" ? payload : {};
  const parts = [
    "AGGREGATE_PREVIEW",
    `mode=${String(viewState && viewState.mode ? viewState.mode : "")}`,
    `selection=${String(selectionKind || "")}`,
    `repo=${String(repoRel || "") || "."}`,
    `category=${String(category || "") || "(none)"}`,
    `rendered=${String(data.rendered_rows || 0)}`,
    `total=${String(data.total_rows || 0)}`,
    `offset=${String(data.rendered_offset || 0)}`,
    `next_offset=${String(data.next_offset || 0)}`,
    `elapsed_ms=${String(data.elapsed_ms || 0)}`,
    `errors=${String(data.error_block_count || 0)}`,
  ];
  console.error(parts.join(" "));
}

function logRowStatsTelemetry(mode, payload) {
  if (process.env[ROW_STATS_TELEMETRY_ENV] !== "1") {
    return;
  }
  const data = payload && typeof payload === "object" ? payload : {};
  const elapsedMs = Math.max(0, Number(data.elapsed_ms || 0) || 0);
  const parts = [
    "ROW_STATS_VIEW",
    `mode=${String(mode || "")}`,
    `elapsed_ms=${elapsedMs}`,
    `rows=${String(data.rows || 0)}`,
    `untracked=${String(data.untracked || 0)}`,
    `slow=${elapsedMs >= ROW_STATS_TELEMETRY_THRESHOLD_MS ? "1" : "0"}`,
  ];
  console.error(parts.join(" "));
}

function telemetryLogValue(value) {
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function logViewedStateTelemetry(action, payload) {
  if (process.env[VIEWED_TELEMETRY_ENV] !== "1") {
    return;
  }
  const data = payload && typeof payload === "object" ? payload : {};
  const parts = ["VIEWED_STATE", `action=${telemetryLogValue(String(action || ""))}`];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }
    parts.push(`${key}=${telemetryLogValue(value)}`);
  }
  console.error(parts.join(" "));
}

function reviewPreviewContext(previewRow) {
  const repoRel = String(previewRow && previewRow.repo ? previewRow.repo : "");
  const repoRow = repoRel ? previewSelectionRepoRow(currentData, repoRel) : null;
  const effectiveBaseRef = String(
    previewRow && previewRow.effective_base_ref
      ? previewRow.effective_base_ref
      : (repoRow && repoRow.effective_base_ref ? repoRow.effective_base_ref : "")
  ).trim() || normalizeReviewBaseRefClient(currentViewState.reviewBaseRef, "master");
  const mergeBase = String(
    previewRow && previewRow.merge_base
      ? previewRow.merge_base
      : (repoRow && repoRow.merge_base ? repoRow.merge_base : "")
  ).trim();
  return {
    effectiveBaseRef,
    mergeBase,
  };
}

function setAggregatePreviewTelemetryHeaders(res, previewResult) {
  if (!previewResult || previewResult.preview_kind !== "aggregate_preview") {
    return;
  }
  res.setHeader(AGGREGATE_PREVIEW_ROWS_HEADER, String(previewResult.page_rows || 0));
  res.setHeader(AGGREGATE_PREVIEW_TOTAL_HEADER, String(previewResult.total_rows || 0));
  res.setHeader(AGGREGATE_PREVIEW_NEXT_OFFSET_HEADER, String(previewResult.next_offset || 0));
  res.setHeader(AGGREGATE_PREVIEW_HAS_MORE_HEADER, previewResult.has_more ? "1" : "0");
  res.setHeader(AGGREGATE_PREVIEW_ELAPSED_HEADER, String(previewResult.elapsed_ms || 0));
  res.setHeader(AGGREGATE_PREVIEW_ERRORS_HEADER, String(previewResult.error_block_count || 0));
}

function previewSelectionTitle(viewState, selectionKind, repoRel, category) {
  if (selectionKind === "repo") {
    return `Repo ${repoRel || "."}`;
  }
  if (selectionKind === "category") {
    return `${repoRel || "."} · ${category || "category"}`;
  }
  return "Selection preview";
}

function previewSelectionEmptyMessage(viewState, payload, selectionKind, repoRel, category) {
  if (selectionKind === "repo") {
    const repoRow = previewSelectionRepoRow(payload, repoRel);
    if (viewState.mode === "review" && repoRow) {
      const repoStatus = String(repoRow.status || "");
      const effectiveBaseRef = String(repoRow.effective_base_ref || repoRow.effective_base_head || "master");
      if (repoStatus === "no_delta") {
        return String(repoRow.message || `No committed delta vs ${effectiveBaseRef}.`);
      }
      if (repoStatus === "baseline_missing" || repoStatus === "error") {
        return String(repoRow.message || "Review data unavailable for this repo.");
      }
    }
    if (viewState.mode === "browse") {
      return "No live changes to preview for this repo.";
    }
    if (viewState.mode === "compare") {
      return "No compare rows to preview for this repo.";
    }
    return "No captured files to preview for this repo.";
  }
  if (selectionKind === "category") {
    if (viewState.mode === "browse") {
      return `No live ${category || "category"} rows to preview in this repo.`;
    }
    return `No captured ${category || "category"} rows to preview in this repo.`;
  }
  return "No rows to preview.";
}

function findRepoSelectionNode(data, viewState, repoRel) {
  const repoRows = data && Array.isArray(data.repoRows) ? data.repoRows : [];
  const normalizedRepo = String(repoRel || "");
  const repoRow = repoRows.find((row) => String(row && row.repo ? row.repo : "") === normalizedRepo) || null;
  return repoRow ? selectionNodeFromRepoRow(repoRow) : null;
}

function findCategorySelectionNode(data, repoRel, category) {
  const categoryRows = data && Array.isArray(data.categoryRows) ? data.categoryRows : [];
  const normalizedRepo = String(repoRel || "");
  const normalizedCategory = String(category || "");
  const categoryRow = categoryRows.find((row) => {
    return String(row && row.repo ? row.repo : "") === normalizedRepo
      && String(row && row.category ? row.category : "") === normalizedCategory;
  }) || null;
  return categoryRow ? selectionNodeFromCategoryRow(categoryRow) : null;
}

function findSelectionNode(data, viewState) {
  if (!data || !viewState) return null;
  const selectionKind = normalizeSelectedKind(
    viewState.mode,
    viewState.selectedKind,
    viewState.selectedRepo,
    viewState.selectedCategory,
    viewState.selectedFile
  );
  if (selectionKind === "file") {
    if (viewState.mode === "compare") {
      const row = findCompareRow(data, viewState.selectedRepo, viewState.selectedFile);
      return row ? selectionNodeFromFileRow("compare", row) : null;
    }
    if (viewState.mode === "review") {
      const row = findReviewRow(data, viewState.selectedRepo, viewState.selectedFile);
      return row ? selectionNodeFromFileRow("review", row) : null;
    }
    if (viewState.mode === "browse") {
      const row = findBrowseRow(data, viewState.selectedRepo, viewState.selectedCategory, viewState.selectedFile);
      return row ? selectionNodeFromFileRow("browse", row) : null;
    }
    const row = findInspectRow(data, viewState.selectedRepo, viewState.selectedCategory, viewState.selectedFile);
    return row ? selectionNodeFromFileRow("inspect", row) : null;
  }
  if (selectionKind === "category") {
    return findCategorySelectionNode(data, viewState.selectedRepo, viewState.selectedCategory);
  }
  if (selectionKind === "repo") {
    return findRepoSelectionNode(data, viewState, viewState.selectedRepo);
  }
  return null;
}

function assertPreviewSignalNotAborted(signal) {
  if (signal && signal.aborted) {
    throw new SnapshotGuiRequestAbortedError();
  }
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

function liveRefreshAppliesToView(viewState) {
  if (!viewState) return false;
  if (viewState.mode === "browse") return true;
  return viewState.mode === "compare";
}

function runGitTextOrThrow(repoRoot, args, label) {
  const proc = run("git", ["-C", repoRoot].concat(args), { encoding: "utf8" });
  if (proc.status !== 0) {
    throw new SnapshotGuiError(
      (proc.stderr || proc.stdout || "").trim() || `${label} exited with ${proc.status}.`
    );
  }
  return String(proc.stdout || "");
}

function hashFileContent(filePath) {
  if (!fs.existsSync(filePath)) {
    return "missing";
  }
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) {
    return "directory";
  }
  const hash = crypto.createHash("sha1");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

function loadRepoLiveSignature(repoRoot, repoRel) {
  const repoLabel = repoRel || ".";
  const stagedDiff = runGitTextOrThrow(
    repoRoot,
    ["diff", "--no-ext-diff", "--binary", "--cached", "--submodule=diff", "--"],
    `git diff --cached for ${repoLabel}`
  );
  const unstagedDiff = runGitTextOrThrow(
    repoRoot,
    ["diff", "--no-ext-diff", "--binary", "--submodule=diff", "--"],
    `git diff for ${repoLabel}`
  );
  const untrackedList = runGitTextOrThrow(
    repoRoot,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    `git ls-files for ${repoLabel}`
  );
  const untrackedSignature = untrackedList
    .split("\0")
    .filter(Boolean)
    .sort()
    .map((relativePath) => {
      const absolutePath = resolveContainedPath(repoRoot, relativePath, `Live refresh untracked path for [${relativePath}]`);
      return `${relativePath}\t${hashFileContent(absolutePath)}`;
    })
    .join("\n");

  return [
    `repo=${repoLabel}`,
    "[staged]",
    stagedDiff,
    "[unstaged]",
    unstagedDiff,
    "[untracked]",
    untrackedSignature,
  ].join("\n");
}

function loadLiveRootSignature(rootRepo, resolver) {
  resolver.clearLiveRepoListCache();
  return resolver.liveRepoList().map((repoRel) => {
    const repoRoot = repoRel === "."
      ? rootRepo
      : resolveContainedPath(rootRepo, repoRel, `Live refresh repo root for [${repoRel}]`);
    return loadRepoLiveSignature(repoRoot, repoRel);
  }).join("\n\0\n");
}

function sha1Text(text) {
  const hash = crypto.createHash("sha1");
  hash.update(String(text || ""), "utf8");
  return hash.digest("hex");
}

function safePathFingerprint(absolutePath) {
  try {
    return hashFileContent(absolutePath);
  } catch (_err) {
    return "missing";
  }
}

function parseRepoVisibleStatus(stdoutText) {
  const entries = String(stdoutText || "").split("\0").filter((entry) => entry.length > 0);
  const trackedPaths = new Set();
  const untrackedPaths = new Set();

  for (const entry of entries) {
    const kind = entry[0];
    if (kind === "?") {
      untrackedPaths.add(entry.slice(2));
      continue;
    }
    if (kind !== "1" && kind !== "u") {
      continue;
    }

    const parts = entry.split(" ");
    if (kind === "1" && parts.length >= 9) {
      trackedPaths.add(parts.slice(8).join(" "));
      continue;
    }
    if (kind === "u" && parts.length >= 11) {
      trackedPaths.add(parts.slice(10).join(" "));
    }
  }

  return {
    normalizedStatus: entries.join("\0"),
    trackedPaths: Array.from(trackedPaths).sort(),
    untrackedPaths: Array.from(untrackedPaths).sort(),
  };
}

function loadRepoVisibleToken(repoRoot, repoRel) {
  const repoLabel = repoRel || ".";
  if (!repoWorktreeExists(repoRoot)) {
    return sha1Text(`repo=${repoLabel}\nstatus=missing`);
  }

  const proc = run("git", [
    "-C",
    repoRoot,
    "status",
    "--porcelain=v2",
    "-z",
    "--branch",
    "--untracked-files=all",
    "--ignore-submodules=none",
    "--no-renames",
  ], { encoding: "utf8" });
  if (proc.status !== 0) {
    const details = String(proc.stderr || proc.stdout || "").trim();
    throw new SnapshotGuiError(
      details
        ? `Failed to read visible repo state for ${repoLabel}: ${details}`
        : `Failed to read visible repo state for ${repoLabel}.`
    );
  }

  const parsed = parseRepoVisibleStatus(proc.stdout || "");
  const fingerprints = [];
  for (const relativePath of parsed.trackedPaths.concat(parsed.untrackedPaths)) {
    const absolutePath = resolveContainedPath(repoRoot, relativePath, `Visible repo token path for [${relativePath}]`);
    fingerprints.push(`${relativePath}\t${safePathFingerprint(absolutePath)}`);
  }

  return sha1Text([
    `repo=${repoLabel}`,
    "[status]",
    parsed.normalizedStatus,
    "[fingerprints]",
    fingerprints.join("\n"),
  ].join("\n"));
}

function fileSystemSignatureDescriptor(absolutePath) {
  try {
    const stat = fs.lstatSync(absolutePath);
    if (stat.isSymbolicLink()) {
      return {
        kind: "symlink",
        target: fs.readlinkSync(absolutePath),
      };
    }
    if (stat.isFile()) {
      return {
        kind: "file",
        executable: (stat.mode & 0o111) !== 0 ? "1" : "0",
        hash: hashFileContent(absolutePath),
      };
    }
    if (stat.isDirectory()) {
      return {
        kind: "directory",
      };
    }
    return {
      kind: "other",
    };
  } catch (_err) {
    return {
      kind: "missing",
    };
  }
}

function treeEntrySignatureDescriptor(entry) {
  if (!entry) {
    return {
      kind: "missing",
    };
  }
  return {
    kind: String(entry.type || "tree"),
    mode: String(entry.mode || ""),
    oid: String(entry.oid || ""),
  };
}

function indexEntrySignatureDescriptor(entry) {
  if (!entry) {
    return {
      kind: "missing",
    };
  }
  return {
    kind: "index",
    mode: String(entry.mode || ""),
    oid: String(entry.oid || ""),
    stage: String(entry.stage || ""),
  };
}

function submoduleCheckoutSignatureDescriptor(info) {
  const data = info && typeof info === "object" ? info : {};
  return {
    exists: data.exists ? "1" : "0",
    is_directory: data.isDirectory ? "1" : "0",
    is_repo: data.isRepo ? "1" : "0",
    head_oid: String(data.headOid || ""),
  };
}

class ViewTokenInspector {
  constructor(rootRepo, resolver) {
    this.rootRepo = rootRepo;
    this.resolver = resolver;
    this.actualIndexCache = new Map();
    this.headEntryCache = new Map();
    this.currentFileSignatureCache = new Map();
    this.submoduleInfoCache = new Map();
    this.comparePairSignatureCache = new Map();
    this.reviewTreeEntryCache = new Map();
  }

  cacheKey(repoRel, filePath, extra = "") {
    return JSON.stringify([String(repoRel || ""), String(filePath || ""), String(extra || "")]);
  }

  actualIndexEntry(repoRel, filePath) {
    const key = this.cacheKey(repoRel, filePath, "index");
    if (!this.actualIndexCache.has(key)) {
      this.actualIndexCache.set(key, this.resolver.actualIndexEntry(repoRel, filePath));
    }
    return this.actualIndexCache.get(key) || null;
  }

  headPathEntry(repoRel, filePath) {
    const key = this.cacheKey(repoRel, filePath, "head");
    if (!this.headEntryCache.has(key)) {
      this.headEntryCache.set(key, this.resolver.headPathEntry(repoRel, filePath));
    }
    return this.headEntryCache.get(key) || null;
  }

  currentFileSignature(repoRel, filePath) {
    const key = this.cacheKey(repoRel, filePath, "current_fs");
    if (!this.currentFileSignatureCache.has(key)) {
      const absolutePath = this.resolver.currentFilePath(repoRel, filePath);
      this.currentFileSignatureCache.set(key, fileSystemSignatureDescriptor(absolutePath));
    }
    return this.currentFileSignatureCache.get(key);
  }

  submoduleCheckoutInfo(repoRel, filePath) {
    const key = this.cacheKey(repoRel, filePath, "submodule_checkout");
    if (!this.submoduleInfoCache.has(key)) {
      this.submoduleInfoCache.set(key, this.resolver.submoduleCheckoutInfo(repoRel, filePath));
    }
    return this.submoduleInfoCache.get(key) || null;
  }

  comparePairSignatures(snapshotId, repoRel, filePath) {
    const key = JSON.stringify([String(snapshotId || ""), String(repoRel || ""), String(filePath || "")]);
    if (!this.comparePairSignatureCache.has(key)) {
      try {
        const pair = this.resolver.compareFilePair(snapshotId, repoRel, filePath);
        this.comparePairSignatureCache.set(key, {
          target: this.resolver.compareTargetSignature(snapshotId, repoRel, filePath) || null,
          snapshot: fileSystemSignatureDescriptor(pair.snapshotFile),
          current: fileSystemSignatureDescriptor(pair.currentFile),
        });
      } catch (_err) {
        this.comparePairSignatureCache.set(key, {
          target: this.resolver.compareTargetSignature(snapshotId, repoRel, filePath) || null,
          snapshot: { kind: "unavailable" },
          current: { kind: "unavailable" },
        });
      }
    }
    return this.comparePairSignatureCache.get(key);
  }

  reviewTreeEntry(repoRel, revision, filePath) {
    const key = JSON.stringify([String(repoRel || ""), String(revision || ""), String(filePath || "")]);
    if (!this.reviewTreeEntryCache.has(key)) {
      const repoAbs = this.resolver.repoAbs(repoRel);
      this.reviewTreeEntryCache.set(key, readGitTreeEntry(repoAbs, revision, filePath));
    }
    return this.reviewTreeEntryCache.get(key) || null;
  }
}

function buildBrowseRowViewToken(row, inspector) {
  const repoRel = String(row && row.repo ? row.repo : "");
  const filePath = String(row && row.file ? row.file : "");
  const category = String(row && row.category ? row.category : "");
  const tokenPayload = {
    mode: "browse",
    repo: repoRel,
    category,
    file: filePath,
    entry_kind: String(row && row.entry_kind ? row.entry_kind : ""),
  };
  if (category === "staged") {
    tokenPayload.head = treeEntrySignatureDescriptor(inspector.headPathEntry(repoRel, filePath));
    tokenPayload.index = indexEntrySignatureDescriptor(inspector.actualIndexEntry(repoRel, filePath));
  } else if (category === "unstaged") {
    tokenPayload.index = indexEntrySignatureDescriptor(inspector.actualIndexEntry(repoRel, filePath));
    tokenPayload.current = inspector.currentFileSignature(repoRel, filePath);
  } else if (category === "untracked") {
    tokenPayload.current = inspector.currentFileSignature(repoRel, filePath);
  } else if (category === "submodules") {
    tokenPayload.head = treeEntrySignatureDescriptor(inspector.headPathEntry(repoRel, filePath));
    tokenPayload.index = indexEntrySignatureDescriptor(inspector.actualIndexEntry(repoRel, filePath));
    tokenPayload.checkout = submoduleCheckoutSignatureDescriptor(inspector.submoduleCheckoutInfo(repoRel, filePath));
  }
  return sha1Text(JSON.stringify(tokenPayload));
}

function buildInspectRowViewToken(payload, row) {
  return sha1Text(JSON.stringify({
    mode: "inspect",
    snapshot_id: String(payload && payload.targetFields && payload.targetFields.snapshot_id ? payload.targetFields.snapshot_id : ""),
    repo: String(row && row.repo ? row.repo : ""),
    category: String(row && row.category ? row.category : ""),
    file: String(row && row.file ? row.file : ""),
  }));
}

function buildCompareRowViewToken(viewState, payload, row, inspector) {
  const snapshotId = String(payload && payload.targetFields && payload.targetFields.selected_snapshot_id
    ? payload.targetFields.selected_snapshot_id
    : (viewState && viewState.snapshotId ? viewState.snapshotId : ""));
  const repoRel = String(row && row.repo ? row.repo : "");
  const filePath = String(row && row.file ? row.file : "");
  const pairSignatures = inspector.comparePairSignatures(snapshotId, repoRel, filePath);
  return sha1Text(JSON.stringify({
    mode: "compare",
    snapshot_id: snapshotId,
    compare_base: normalizeCompareBase(viewState && viewState.compareBase),
    repo: repoRel,
    file: filePath,
    status: String(row && row.status ? row.status : ""),
    reason: String(row && row.reason ? row.reason : ""),
    path_scope: String(row && row.path_scope ? row.path_scope : ""),
    restore_effect: String(row && row.restore_effect ? row.restore_effect : ""),
    target_signature: pairSignatures && pairSignatures.target
      ? {
        mode: String(pairSignatures.target.mode || ""),
        oid: String(pairSignatures.target.oid || ""),
      }
      : { kind: "missing" },
    snapshot_signature: pairSignatures ? pairSignatures.snapshot : { kind: "missing" },
    current_signature: pairSignatures ? pairSignatures.current : { kind: "missing" },
  }));
}

function buildReviewRowViewToken(payload, row, inspector) {
  const repoRel = String(row && row.repo ? row.repo : "");
  const filePath = String(row && row.file ? row.file : "");
  const repoRows = Array.isArray(payload && payload.repoRows) ? payload.repoRows : [];
  const repoRow = repoRows.find((candidate) => String(candidate && candidate.repo ? candidate.repo : "") === repoRel) || {};
  const mergeBase = String(repoRow.merge_base || "");
  const currentHead = String(repoRow.current_head || "");
  return sha1Text(JSON.stringify({
    mode: "review",
    repo: repoRel,
    file: filePath,
    current_head: currentHead,
    merge_base: mergeBase,
    effective_base_ref: String(repoRow.effective_base_ref || ""),
    effective_base_head: String(repoRow.effective_base_head || ""),
    current_entry: currentHead ? treeEntrySignatureDescriptor(inspector.reviewTreeEntry(repoRel, currentHead, filePath)) : { kind: "missing" },
    merge_base_entry: mergeBase ? treeEntrySignatureDescriptor(inspector.reviewTreeEntry(repoRel, mergeBase, filePath)) : { kind: "missing" },
  }));
}

function buildViewTokenForResolvedRow(rootRepo, resolver, viewState, payload, row, inspector) {
  if (!row || !viewState || !viewState.mode) {
    return "";
  }
  const activeInspector = inspector || new ViewTokenInspector(rootRepo, resolver);
  if (viewState.mode === "compare") {
    return buildCompareRowViewToken(viewState, payload, row, activeInspector);
  }
  if (viewState.mode === "review") {
    return buildReviewRowViewToken(payload, row, activeInspector);
  }
  if (viewState.mode === "browse") {
    return buildBrowseRowViewToken(row, activeInspector);
  }
  return buildInspectRowViewToken(payload, row);
}

function assignViewTokensToPayload(rootRepo, resolver, viewState, payload) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const inspector = new ViewTokenInspector(rootRepo, resolver);
  if (viewState.mode === "compare") {
    for (const row of Array.isArray(payload.rows) ? payload.rows : []) {
      row.view_token = buildViewTokenForResolvedRow(rootRepo, resolver, viewState, payload, row, inspector);
    }
    return payload;
  }
  if (viewState.mode === "review") {
    for (const row of Array.isArray(payload.rows) ? payload.rows : []) {
      row.view_token = buildViewTokenForResolvedRow(rootRepo, resolver, viewState, payload, row, inspector);
    }
    return payload;
  }
  if (viewState.mode === "browse") {
    for (const row of Array.isArray(payload.fileRows) ? payload.fileRows : []) {
      row.view_token = buildViewTokenForResolvedRow(rootRepo, resolver, viewState, payload, row, inspector);
    }
    return payload;
  }
  for (const row of Array.isArray(payload.fileRows) ? payload.fileRows : []) {
    row.view_token = buildViewTokenForResolvedRow(rootRepo, resolver, viewState, payload, row, inspector);
  }
  return payload;
}

function viewedRowsForPayload(viewState, payload) {
  return (viewState.mode === "compare" || viewState.mode === "review")
    ? (Array.isArray(payload && payload.rows) ? payload.rows : [])
    : (Array.isArray(payload && payload.fileRows) ? payload.fileRows : []);
}

function viewedStateCountsPayloadForRootRecord(rootRecord, mode) {
  const counts = viewedStateCountsForRootRecord(rootRecord);
  return {
    all: counts.all,
    current_mode: counts.by_mode[String(mode || "")] || 0,
    by_mode: counts.by_mode,
  };
}

function viewedStateOverlayForRow(rootRepo, rootRecord, viewState, row, currentTokenOverride) {
  const entryKey = buildRowIdentityKeyShared(
    viewState.mode,
    String(row && row.repo ? row.repo : ""),
    String(row && row.category ? row.category : ""),
    String(row && row.file ? row.file : "")
  );
  const entry = rootRecord && rootRecord.entries ? rootRecord.entries[entryKey] : null;
  const currentToken = String(
    currentTokenOverride !== undefined
      ? currentTokenOverride
      : (row && row.view_token ? row.view_token : "")
  ).trim();
  const storedToken = String(entry && entry.view_token ? entry.view_token : "").trim();
  const blobId = String(entry && entry.preview_blob_id ? entry.preview_blob_id : "").trim();
  return {
    view_state: !entry
      ? VIEW_STATE_UNVIEWED
      : (storedToken === currentToken ? VIEW_STATE_VIEWED : VIEW_STATE_CHANGED),
    view_marked_at: String(entry && entry.marked_at ? entry.marked_at : ""),
    view_blob_available: viewedPreviewBlobIsUsable(rootRepo, blobId) ? "true" : "false",
    view_token: currentToken,
  };
}

function cloneViewPayloadRows(rows) {
  if (!Array.isArray(rows)) {
    return rows;
  }
  return rows.map((row) => {
    if (!row || typeof row !== "object") {
      return row;
    }
    return Object.assign({}, row);
  });
}

function cloneViewPayloadForClient(payload) {
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const cloned = Object.assign({}, payload);
  for (const fieldName of ["rows", "repoRows", "fileRows", "categoryRows", "visibleRepoRows", "visibleCategoryRows"]) {
    if (Array.isArray(payload[fieldName])) {
      cloned[fieldName] = cloneViewPayloadRows(payload[fieldName]);
    }
  }
  if (payload.targetFields && typeof payload.targetFields === "object") {
    cloned.targetFields = Object.assign({}, payload.targetFields);
  }
  if (payload.summaryFields && typeof payload.summaryFields === "object") {
    cloned.summaryFields = Object.assign({}, payload.summaryFields);
  }
  if (Array.isArray(payload.reviewPresets)) {
    cloned.reviewPresets = payload.reviewPresets.map((preset) => {
      if (!preset || typeof preset !== "object") {
        return preset;
      }
      const nextPreset = Object.assign({}, preset);
      if (nextPreset.repo_base_overrides && typeof nextPreset.repo_base_overrides === "object") {
        nextPreset.repo_base_overrides = Object.assign({}, nextPreset.repo_base_overrides);
      }
      return nextPreset;
    });
  }
  return cloned;
}

function annotateViewedStateForPayload(rootRepo, physicalRootRepo, viewState, payload, viewedDoc) {
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const doc = viewedDoc || readViewedStateDocumentWithMeta(rootRepo).doc;
  const rootRecord = viewedStateRootRecordForPhysicalPath(doc, physicalRootRepo);
  for (const row of viewedRowsForPayload(viewState, payload)) {
    const overlay = viewedStateOverlayForRow(rootRepo, rootRecord, viewState, row);
    row.view_state = overlay.view_state;
    row.view_marked_at = overlay.view_marked_at;
    row.view_blob_available = overlay.view_blob_available;
  }
  payload.viewedStateCounts = viewedStateCountsPayloadForRootRecord(rootRecord, viewState.mode);
  return payload;
}

function buildViewedStateOverlayPayload(rootRepo, physicalRootRepo, viewState, payload, viewedDoc, options) {
  const normalizedViewState = viewState && typeof viewState === "object" ? viewState : { mode: "" };
  const doc = viewedDoc || readViewedStateDocumentWithMeta(rootRepo).doc;
  const rootRecord = viewedStateRootRecordForPhysicalPath(doc, physicalRootRepo);
  const overlayOptions = options && typeof options === "object" ? options : {};
  const tokenOverrides = overlayOptions.token_overrides && typeof overlayOptions.token_overrides === "object"
    ? overlayOptions.token_overrides
    : {};
  const extraRows = Array.isArray(overlayOptions.extra_rows) ? overlayOptions.extra_rows : [];
  const rowOverlays = {};
  const seenKeys = new Set();
  const rows = viewedRowsForPayload(normalizedViewState, payload || {});
  const addRowOverlay = (row) => {
    if (!row || typeof row !== "object") {
      return;
    }
    const key = buildRowIdentityKeyShared(
      normalizedViewState.mode,
      String(row && row.repo ? row.repo : ""),
      String(row && row.category ? row.category : ""),
      String(row && row.file ? row.file : "")
    );
    if (seenKeys.has(key)) {
      return;
    }
    seenKeys.add(key);
    rowOverlays[key] = viewedStateOverlayForRow(
      rootRepo,
      rootRecord,
      normalizedViewState,
      row,
      Object.prototype.hasOwnProperty.call(tokenOverrides, key) ? tokenOverrides[key] : undefined
    );
  };
  for (const row of rows) {
    addRowOverlay(row);
  }
  for (const row of extraRows) {
    addRowOverlay(row);
  }
  return {
    mode: String(normalizedViewState.mode || ""),
    counts: viewedStateCountsPayloadForRootRecord(rootRecord, normalizedViewState.mode),
    row_overlays: rowOverlays,
  };
}

function normalizeWatchEventFileName(rawFileName) {
  if (!rawFileName) return "";
  if (Buffer.isBuffer(rawFileName)) {
    return rawFileName.toString("utf8");
  }
  return String(rawFileName || "");
}

function pathSegmentsForWatchEvent(eventPath) {
  return String(eventPath || "")
    .split(/[\\/]+/)
    .filter(Boolean);
}

function shouldIgnoreWatchEventPath(rootRepo, watchRoot, rawFileName) {
  const relativeName = normalizeWatchEventFileName(rawFileName);
  if (!relativeName) {
    return false;
  }

  let absolutePath = "";
  try {
    absolutePath = path.resolve(watchRoot, relativeName);
  } catch (_err) {
    return false;
  }
  if (!isPathInside(rootRepo, absolutePath)) {
    return false;
  }
  const repoRelativePath = path.relative(rootRepo, absolutePath);
  if (!repoRelativePath) {
    return false;
  }
  const segments = pathSegmentsForWatchEvent(repoRelativePath);
  return segments.includes(".git");
}

function timerUnref(timer) {
  if (timer && typeof timer.unref === "function") {
    timer.unref();
  }
}

class LiveRefreshTracker {
  constructor(rootRepo, resolver, onVisibleRepoChanges) {
    this.rootRepo = path.resolve(rootRepo);
    this.resolver = resolver;
    this.onVisibleRepoChanges = typeof onVisibleRepoChanges === "function"
      ? onVisibleRepoChanges
      : () => {};
    this.watchMode = "fs";
    this.watchers = [];
    this.pollTimer = null;
    this.closed = false;
    this.activeWatchRepoListKey = "";
    this.watchRootRefreshTimer = null;
    this.repoTokens = new Map();
    this.repoProbeStates = new Map();
  }

  start() {
    if (TEST_DISABLE_FS_WATCH_EVENTS) {
      this.watchMode = "poll";
    }
    this.rebuildWatchRoots();
  }

  stop() {
    this.closed = true;
    this.closeWatchers();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.watchRootRefreshTimer) {
      clearTimeout(this.watchRootRefreshTimer);
      this.watchRootRefreshTimer = null;
    }
    for (const probeState of this.repoProbeStates.values()) {
      if (probeState.timer) {
        clearTimeout(probeState.timer);
        probeState.timer = null;
      }
    }
    this.repoProbeStates.clear();
  }

  closeWatchers() {
    while (this.watchers.length > 0) {
      const watcher = this.watchers.pop();
      try {
        watcher.close();
      } catch (_err) {
        // Ignore watcher close failures during shutdown/reconfigure.
      }
    }
  }

  watchRepoListKey(repoRels) {
    return uniqueStrings(Array.isArray(repoRels) ? repoRels : []).join("\n");
  }

  watchRoots(repoRels = this.resolver.liveRepoList()) {
    return repoRels.map((repoRel) => {
      if (!repoRel || repoRel === ".") {
        return {
          repoRel: ".",
          watchRoot: this.rootRepo,
        };
      }
      return {
        repoRel,
        watchRoot: resolveContainedPath(this.rootRepo, repoRel, `Live refresh watch root for [${repoRel}]`),
      };
    });
  }

  repoRelForAbsolutePath(absolutePath, fallbackRepoRel = ".") {
    let bestMatch = fallbackRepoRel || ".";
    let relativePath = "";
    try {
      relativePath = path.relative(this.rootRepo, absolutePath);
    } catch (_err) {
      return bestMatch;
    }
    for (const repoRel of this.resolver.liveRepoList()) {
      if (!repoRel || repoRel === ".") {
        continue;
      }
      if (
        relativePath === repoRel
        || relativePath.startsWith(repoRel + path.sep)
        || relativePath.startsWith(repoRel + "/")
      ) {
        if (repoRel.length > bestMatch.length) {
          bestMatch = repoRel;
        }
      }
    }
    return bestMatch || ".";
  }

  markDirtyRepoForEvent(repoRel, watchRoot, rawFileName) {
    let matchedRepoRel = repoRel || ".";
    const relativeName = normalizeWatchEventFileName(rawFileName);
    if (relativeName) {
      try {
        const absolutePath = path.resolve(watchRoot, relativeName);
        if (isPathInside(this.rootRepo, absolutePath)) {
          matchedRepoRel = this.repoRelForAbsolutePath(absolutePath, matchedRepoRel);
        }
      } catch (_err) {
        matchedRepoRel = repoRel || ".";
      }
    }
    if (!matchedRepoRel) {
      matchedRepoRel = ".";
    }
    return matchedRepoRel;
  }

  startFallbackPolling() {
    if (this.pollTimer) {
      return;
    }
    this.pollTimer = setInterval(() => {
      this.queueAllLiveRepoProbes();
    }, LIVE_REFRESH_FALLBACK_POLL_MS);
    timerUnref(this.pollTimer);
    console.warn(
      `[live-refresh] Polling mode active for ${this.rootRepo} (interval ${LIVE_REFRESH_FALLBACK_POLL_MS}ms).`
    );
  }

  stopFallbackPolling() {
    if (!this.pollTimer) {
      return;
    }
    clearInterval(this.pollTimer);
    this.pollTimer = null;
  }

  rebuildWatchRoots() {
    if (this.closed) {
      return;
    }

    this.closeWatchers();
    if (this.watchMode === "poll") {
      this.startFallbackPolling();
      return;
    }

    const repoRels = this.resolver.liveRepoList();
    const nextWatchRepoListKey = this.watchRepoListKey(repoRels);
    const nextWatchers = [];
    try {
      for (const watchEntry of this.watchRoots(repoRels)) {
        const watcher = fs.watch(watchEntry.watchRoot, { recursive: true }, (_eventType, fileName) => {
          if (shouldIgnoreWatchEventPath(this.rootRepo, watchEntry.watchRoot, fileName)) {
            return;
          }
          if (TEST_DISABLE_FS_WATCH_EVENTS) {
            return;
          }
          const repoRel = this.markDirtyRepoForEvent(watchEntry.repoRel, watchEntry.watchRoot, fileName);
          this.scheduleRepoProbe(repoRel);
        });
        nextWatchers.push(watcher);
      }
    } catch (err) {
      for (const watcher of nextWatchers) {
        try {
          watcher.close();
        } catch (_err) {
          // Ignore cleanup failures while falling back to polling.
        }
      }
      const message = err && err.message ? err.message : String(err);
      console.warn(
        `[live-refresh] Failed to install filesystem watchers for ${this.rootRepo}; ` +
        `switching to polling every ${LIVE_REFRESH_FALLBACK_POLL_MS}ms: ${message}`
      );
      this.watchMode = "poll";
      this.startFallbackPolling();
      return;
    }

    this.stopFallbackPolling();
    this.watchers = nextWatchers;
    this.activeWatchRepoListKey = nextWatchRepoListKey;
  }

  queueAllLiveRepoProbes() {
    for (const repoRel of this.resolver.liveRepoList()) {
      this.scheduleRepoProbe(repoRel);
    }
  }

  scheduleWatchRootRefresh(repoRels) {
    if (this.closed || this.watchMode === "poll") {
      return;
    }
    const nextRepoRels = Array.isArray(repoRels) ? uniqueStrings(repoRels) : this.resolver.liveRepoList();
    const nextWatchRepoListKey = this.watchRepoListKey(nextRepoRels);
    if (nextWatchRepoListKey === this.activeWatchRepoListKey) {
      return;
    }
    if (this.watchRootRefreshTimer) {
      clearTimeout(this.watchRootRefreshTimer);
      this.watchRootRefreshTimer = null;
    }
    this.watchRootRefreshTimer = setTimeout(() => {
      this.watchRootRefreshTimer = null;
      if (this.closed || this.watchMode === "poll") {
        return;
      }
      this.resolver.setLiveRepoList(nextRepoRels);
      this.rebuildWatchRoots();
    }, 0);
    timerUnref(this.watchRootRefreshTimer);
  }

  readRepoTokenValue(repoRel, purpose) {
    const normalizedRepoRel = String(repoRel || ".");
    const repoRoot = normalizedRepoRel === "."
      ? this.rootRepo
      : resolveContainedPath(this.rootRepo, normalizedRepoRel, `${purpose} for [${normalizedRepoRel}]`);
    return loadRepoVisibleToken(repoRoot, normalizedRepoRel);
  }

  ensureRepoTokens(repoRels) {
    const normalizedRepoRels = uniqueStrings(Array.isArray(repoRels) ? repoRels : []);
    for (const repoRel of normalizedRepoRels) {
      if (this.repoTokens.has(repoRel)) {
        continue;
      }
      this.scheduleRepoProbe(repoRel, { immediate: true, baselineOnly: true });
    }
  }

  primeRepoTokens(repoRels) {
    for (const repoRel of uniqueStrings(Array.isArray(repoRels) ? repoRels : [])) {
      const normalizedRepoRel = String(repoRel || ".");
      if (this.repoTokens.has(normalizedRepoRel)) {
        continue;
      }
      try {
        const nextToken = this.readRepoTokenValue(normalizedRepoRel, "Visible repo prime root");
        if (typeof nextToken === "string") {
          this.repoTokens.set(normalizedRepoRel, nextToken);
        }
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        console.warn(`[live-refresh] failed to prime repo token for ${normalizedRepoRel}: ${message}`);
      }
    }
  }

  refreshRepoTokens(repoRels) {
    for (const repoRel of uniqueStrings(Array.isArray(repoRels) ? repoRels : [])) {
      const normalizedRepoRel = String(repoRel || ".");
      try {
        const nextToken = this.readRepoTokenValue(normalizedRepoRel, "Visible repo refresh root");
        if (typeof nextToken === "string") {
          this.repoTokens.set(normalizedRepoRel, nextToken);
        }
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        console.warn(`[live-refresh] failed to refresh repo token for ${normalizedRepoRel}: ${message}`);
      }
    }
  }

  repoToken(repoRel) {
    return String(this.repoTokens.get(repoRel || ".") || "");
  }

  repoProbeState(repoRel) {
    const normalizedRepoRel = String(repoRel || ".");
    if (!this.repoProbeStates.has(normalizedRepoRel)) {
      this.repoProbeStates.set(normalizedRepoRel, {
        timer: null,
        running: false,
        rerun: false,
        lastStartedAt: 0,
        baselineOnly: false,
      });
    }
    return this.repoProbeStates.get(normalizedRepoRel);
  }

  scheduleRepoProbe(repoRel, options) {
    if (this.closed) {
      return;
    }
    const normalizedRepoRel = String(repoRel || ".");
    const probeState = this.repoProbeState(normalizedRepoRel);
    const baselineOnly = Boolean(options && options.baselineOnly && !this.repoTokens.has(normalizedRepoRel));
    if (!baselineOnly) {
      probeState.baselineOnly = false;
    } else if (!probeState.running) {
      probeState.baselineOnly = true;
    }

    if (probeState.running) {
      probeState.rerun = true;
      return;
    }

    if (probeState.timer) {
      clearTimeout(probeState.timer);
      probeState.timer = null;
    }

    const now = Date.now();
    const immediate = Boolean(options && options.immediate);
    const throttleWindowMs = Boolean(options && options.verification)
      ? LIVE_REFRESH_VERIFICATION_PROBE_THROTTLE_MS
      : LIVE_REFRESH_REPO_PROBE_THROTTLE_MS;
    const debounceDelay = immediate ? 0 : LIVE_REFRESH_REPO_PROBE_DEBOUNCE_MS;
    const throttleDelay = probeState.lastStartedAt > 0
      ? Math.max(0, (probeState.lastStartedAt + throttleWindowMs) - now)
      : 0;
    const delayMs = Math.max(debounceDelay, throttleDelay);

    probeState.timer = setTimeout(() => {
      probeState.timer = null;
      this.runRepoProbe(normalizedRepoRel);
    }, delayMs);
    timerUnref(probeState.timer);
  }

  runRepoProbe(repoRel) {
    if (this.closed) {
      return;
    }
    const normalizedRepoRel = String(repoRel || ".");
    const probeState = this.repoProbeState(normalizedRepoRel);
    if (probeState.running) {
      probeState.rerun = true;
      return;
    }

    probeState.running = true;
    probeState.lastStartedAt = Date.now();
    let nextToken = null;
    try {
      nextToken = this.readRepoTokenValue(normalizedRepoRel, "Visible repo probe root");
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.warn(`[live-refresh] repo probe failed for ${normalizedRepoRel}: ${message}`);
    }

    const previousToken = this.repoTokens.get(normalizedRepoRel);
    const baselineOnly = probeState.baselineOnly;
    probeState.running = false;
    probeState.baselineOnly = false;

    if (typeof nextToken === "string") {
      this.repoTokens.set(normalizedRepoRel, nextToken);
      if (!baselineOnly && previousToken !== undefined && previousToken !== nextToken) {
        this.onVisibleRepoChanges([normalizedRepoRel]);
      }
    }

    if (probeState.rerun) {
      probeState.rerun = false;
      this.scheduleRepoProbe(normalizedRepoRel);
    }
  }

  verifyRepoNow(repoRel) {
    if (this.closed) {
      return false;
    }
    const normalizedRepoRel = String(repoRel || ".");
    const probeState = this.repoProbeState(normalizedRepoRel);
    if (probeState.timer) {
      clearTimeout(probeState.timer);
      probeState.timer = null;
    }
    if (probeState.running) {
      probeState.rerun = true;
      return false;
    }

    let nextToken = null;
    try {
      nextToken = this.readRepoTokenValue(normalizedRepoRel, "Visible repo verify root");
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.warn(`[live-refresh] repo verify failed for ${normalizedRepoRel}: ${message}`);
      return false;
    }

    const previousToken = this.repoTokens.get(normalizedRepoRel);
    if (typeof nextToken === "string") {
      this.repoTokens.set(normalizedRepoRel, nextToken);
      return previousToken !== undefined && previousToken !== nextToken;
    }
    return false;
  }
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
  constructor(rootRepo, gitSnapshotBin) {
    this.rootRepo = path.resolve(rootRepo);
    this.gitSnapshotBin = path.resolve(gitSnapshotBin);
    this.sessionDir = path.join(os.tmpdir(), `git-snapshot-gui.${process.pid}`);
    this.snapshotFilesDir = path.join(this.sessionDir, "snapshot-files");
    this.repoWorkDir = path.join(this.sessionDir, "repo-work");
    this.snapshotCache = new Map();
    this.compareTargetSignatureCache = new Map();
    this.compareRepoPairCache = new Map();
    this.liveRepoListCache = null;
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

  liveRepoList() {
    if (this.liveRepoListCache) {
      return this.liveRepoListCache.slice();
    }

    const repos = ["."];
    const proc = run("git", ["-C", this.rootRepo, "submodule", "status", "--recursive"], { encoding: "utf8" });
    if (proc.status === 0) {
      for (const rawLine of String(proc.stdout || "").split(/\r?\n/)) {
        if (!rawLine) continue;
        const line = String(rawLine);
        const body = line.slice(1).trim();
        const firstSpace = body.indexOf(" ");
        if (firstSpace <= 0) continue;

        let repoRel = body.slice(firstSpace + 1).trim();
        if (!repoRel) continue;
        repoRel = repoRel.replace(/\s+\([^)]*\)$/, "");
        if (!repoRel) continue;

        try {
          const repoAbs = resolveContainedPath(this.rootRepo, repoRel, `Live repo path for [${repoRel}]`);
          if (repoWorktreeExists(repoAbs)) {
            repos.push(repoRel);
          }
        } catch (_err) {
          continue;
        }
      }
    }

    this.liveRepoListCache = uniqueStrings(repos);
    return this.liveRepoListCache.slice();
  }

  clearLiveRepoListCache() {
    this.liveRepoListCache = null;
  }

  setLiveRepoList(repoRels) {
    const nextRepos = Array.isArray(repoRels) && repoRels.length ? repoRels : ["."];
    this.liveRepoListCache = uniqueStrings(nextRepos);
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

  clearCompareRepoPairCache() {
    this.compareRepoPairCache.clear();
  }

  compareRepoPair(snapshotId, repoRel) {
    const normalizedRepoRel = repoRel || ".";
    const cacheKey = `${snapshotId}\0${normalizedRepoRel}`;
    if (this.compareRepoPairCache.has(cacheKey)) {
      return this.compareRepoPairCache.get(cacheKey);
    }

    const repoPart = repoComponent(normalizedRepoRel);
    const cacheDir = resolveContainedPath(
      this.repoWorkDir,
      `compare-pairs/${snapshotId}/${repoPart}`,
      `Compare repo pair cache for repo [${normalizedRepoRel}]`
    );
    const proc = run(this.gitSnapshotBin, [
      "__compare-materialize-repo",
      snapshotId,
      "--repo",
      normalizedRepoRel,
      "--cache-dir",
      cacheDir,
      "--porcelain",
    ], {
      encoding: "utf8",
      cwd: this.rootRepo,
    });
    if (proc.status !== 0) {
      throw new SnapshotGuiError((proc.stderr || proc.stdout || "").trim() || "Failed to materialize compare repo pair.");
    }

    const parsed = parseCompareMaterializedRepoPorcelain(proc.stdout || "");
    if (!parsed.snapshot_repo || !parsed.current_repo) {
      throw new SnapshotGuiError("Internal compare materialization returned incomplete repo paths.");
    }

    const pair = {
      snapshotRepo: parsed.snapshot_repo,
      currentRepo: parsed.current_repo,
    };
    this.compareRepoPairCache.set(cacheKey, pair);
    return pair;
  }

  compareFilePair(snapshotId, repoRel, filePath) {
    const pair = this.compareRepoPair(snapshotId, repoRel);
    return {
      snapshotFile: resolveContainedPath(pair.snapshotRepo, filePath, `Snapshot compare file for repo [${repoRel || "."}]`),
      currentFile: resolveContainedPath(pair.currentRepo, filePath, `Current compare file for repo [${repoRel || "."}]`),
    };
  }

  currentFilePath(repoRel, filePath) {
    const repoAbs = resolveContainedPath(this.rootRepo, repoRel || ".", `Repo path for [${repoRel || "."}]`);
    return resolveContainedPath(repoAbs, filePath, `Current file path for repo [${repoRel}]`);
  }

  repoAbs(repoRel) {
    return resolveContainedPath(this.rootRepo, repoRel || ".", `Repo path for [${repoRel || "."}]`);
  }

  materializeEmptyFile(bucket, repoRel, filePath) {
    const repoPart = repoComponent(repoRel);
    const out = resolveContainedPath(
      this.snapshotFilesDir,
      `live-empty/${bucket}/${repoPart}/${filePath}`,
      `Empty preview path for repo [${repoRel}]`
    );
    ensureDir(path.dirname(out));
    fs.writeFileSync(out, "", "utf8");
    return out;
  }

  materializeRevisionFile(repoRel, filePath, revision, bucket) {
    const repoPart = repoComponent(repoRel);
    const out = resolveContainedPath(
      this.snapshotFilesDir,
      `live-files/${bucket}/${repoPart}/${filePath}`,
      `Live preview path for repo [${repoRel}]`
    );
    ensureDir(path.dirname(out));
    const repoAbs = this.repoAbs(repoRel);
    const proc = spawnSync("git", ["-C", repoAbs, "show", `${revision}:${filePath}`], { encoding: null });
    if (proc.status === 0 && proc.stdout) {
      fs.writeFileSync(out, proc.stdout);
    } else {
      fs.writeFileSync(out, "", "utf8");
    }
    return out;
  }

  materializeHeadFile(repoRel, filePath) {
    return this.materializeRevisionFile(repoRel, filePath, "HEAD", "head");
  }

  materializeIndexFile(repoRel, filePath) {
    const repoPart = repoComponent(repoRel);
    const out = resolveContainedPath(
      this.snapshotFilesDir,
      `live-files/index/${repoPart}/${filePath}`,
      `Index preview path for repo [${repoRel}]`
    );
    ensureDir(path.dirname(out));
    const repoAbs = this.repoAbs(repoRel);
    const proc = spawnSync("git", ["-C", repoAbs, "show", `:${filePath}`], { encoding: null });
    if (proc.status === 0 && proc.stdout) {
      fs.writeFileSync(out, proc.stdout);
    } else {
      fs.writeFileSync(out, "", "utf8");
    }
    return out;
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

  actualIndexEntry(repoRel, filePath) {
    const repoAbs = this.repoAbs(repoRel);
    const lsProc = run("git", ["-C", repoAbs, "ls-files", "-s", "-z", "--", filePath], { encoding: "utf8" });
    if (lsProc.status !== 0) return null;
    return parseIndexEntry(String(lsProc.stdout || ""));
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

function buildNamedCommitRelation(repoDir, referenceOid, currentOid, options) {
  if (!referenceOid) {
    return {
      label: options.missingReferenceLabel,
      sections: [],
    };
  }
  if (!currentOid) {
    return {
      label: options.missingCurrentLabel,
      sections: [],
    };
  }
  if (referenceOid === currentOid) {
    return {
      label: options.matchLabel,
      sections: [],
    };
  }
  if (!repoDir || !gitCommitExists(repoDir, referenceOid) || !gitCommitExists(repoDir, currentOid)) {
    return {
      label: options.unavailableLabel,
      sections: [],
    };
  }

  const referenceAncestor = run("git", ["-C", repoDir, "merge-base", "--is-ancestor", referenceOid, currentOid], { encoding: "utf8" }).status === 0;
  const currentAncestor = run("git", ["-C", repoDir, "merge-base", "--is-ancestor", currentOid, referenceOid], { encoding: "utf8" }).status === 0;

  if (referenceAncestor) {
    const range = `${referenceOid}..${currentOid}`;
    const total = gitRevListCount(repoDir, range);
    const commits = gitRangeSubjects(repoDir, range);
    return {
      label: options.aheadLabel(total),
      sections: [{
        title: options.currentOnlyTitle,
        commits,
      }],
    };
  }

  if (currentAncestor) {
    const range = `${currentOid}..${referenceOid}`;
    const total = gitRevListCount(repoDir, range);
    const commits = gitRangeSubjects(repoDir, range);
    return {
      label: options.behindLabel(total),
      sections: [{
        title: options.referenceOnlyTitle,
        commits,
      }],
    };
  }

  const currentRange = `${referenceOid}..${currentOid}`;
  const referenceRange = `${currentOid}..${referenceOid}`;
  return {
    label: options.divergedLabel,
    sections: [
      {
        title: options.currentOnlyTitle,
        commits: gitRangeSubjects(repoDir, currentRange),
      },
      {
        title: options.referenceOnlyTitle,
        commits: gitRangeSubjects(repoDir, referenceRange),
      },
    ],
  };
}

function buildBrowseSubmoduleRelation(repoDir, headOid, currentOid) {
  return buildNamedCommitRelation(repoDir, headOid, currentOid, {
    missingReferenceLabel: "HEAD does not track this submodule path.",
    missingCurrentLabel: "The current submodule checkout is missing.",
    matchLabel: "Current checkout matches the HEAD gitlink commit.",
    unavailableLabel: "Commit relation is unavailable locally for this submodule checkout.",
    aheadLabel: (total) => `Current checkout is ahead of the HEAD gitlink by ${total} commit${total === 1 ? "" : "s"}.`,
    behindLabel: (total) => `Current checkout is behind the HEAD gitlink by ${total} commit${total === 1 ? "" : "s"}.`,
    divergedLabel: "Current checkout and the HEAD gitlink have diverged.",
    currentOnlyTitle: "Current-only commits (not yet recorded in HEAD)",
    referenceOnlyTitle: "HEAD-only commits (not currently checked out)",
  });
}

function buildBrowseStagedGitlinkRelation(repoDir, headOid, indexOid) {
  return buildNamedCommitRelation(repoDir, headOid, indexOid, {
    missingReferenceLabel: "HEAD does not track this submodule path.",
    missingCurrentLabel: "The current index does not track this submodule path as a gitlink.",
    matchLabel: "Staged gitlink matches the HEAD gitlink commit.",
    unavailableLabel: "Commit relation is unavailable locally for the staged gitlink.",
    aheadLabel: (total) => `Staged gitlink is ahead of the HEAD gitlink by ${total} commit${total === 1 ? "" : "s"}.`,
    behindLabel: (total) => `Staged gitlink is behind the HEAD gitlink by ${total} commit${total === 1 ? "" : "s"}.`,
    divergedLabel: "Staged gitlink and the HEAD gitlink have diverged.",
    currentOnlyTitle: "Staged-only commits (not yet recorded in HEAD)",
    referenceOnlyTitle: "HEAD-only commits (not yet staged)",
  });
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

function buildBrowseSubmoduleSummary(resolver, repoRel, filePath) {
  const headEntry = resolver.headPathEntry(repoRel, filePath);
  const indexEntry = resolver.actualIndexEntry(repoRel, filePath);
  const checkoutInfo = resolver.submoduleCheckoutInfo(repoRel, filePath);

  const headGitlink = headEntry && headEntry.mode === "160000" ? headEntry : null;
  const indexGitlink = indexEntry && indexEntry.mode === "160000" ? indexEntry : null;
  const isSubmodule = Boolean(headGitlink || indexGitlink || checkoutInfo.isRepo);
  if (!isSubmodule) return null;

  const repoDir = checkoutInfo.isRepo ? checkoutInfo.path : "";
  const headOid = headGitlink ? headGitlink.oid : "";
  const indexOid = indexGitlink ? indexGitlink.oid : "";
  const checkoutOid = checkoutInfo.headOid || indexOid;
  const checkoutRelation = buildBrowseSubmoduleRelation(repoDir, headOid, checkoutOid);
  const stagedRelation = buildBrowseStagedGitlinkRelation(repoDir, headOid, indexOid);
  const notes = [];
  let summary = checkoutRelation.label;
  let relationLabel = checkoutRelation.label;
  let sections = checkoutRelation.sections;

  if (!indexOid && checkoutInfo.isRepo) {
    notes.push("A submodule checkout directory exists on disk, but the current index does not track it as a gitlink.");
  }
  if (headOid && indexOid && headOid !== indexOid) {
    notes.push("The staged gitlink commit differs from HEAD for this submodule path.");
  }
  if (indexOid && checkoutInfo.headOid && indexOid !== checkoutInfo.headOid) {
    notes.push("The checked-out submodule HEAD differs from the superproject index gitlink.");
  }
  if (!checkoutInfo.exists && (headOid || indexOid)) {
    notes.push("The superproject references this submodule path, but its checkout is missing or not initialized.");
  }

  if (headOid && indexOid && headOid !== indexOid) {
    relationLabel = stagedRelation.label;
    sections = stagedRelation.sections;
    if (!checkoutOid) {
      summary = `${stagedRelation.label} The current submodule checkout is missing.`;
    } else if (checkoutOid === headOid) {
      summary = `${stagedRelation.label} The checked-out submodule still matches HEAD.`;
    } else if (checkoutOid === indexOid) {
      summary = stagedRelation.label;
    } else {
      summary = `${stagedRelation.label} The checked-out submodule also differs from the current index gitlink.`;
    }
  } else if (!headOid && indexOid) {
    relationLabel = stagedRelation.label;
    sections = stagedRelation.sections;
    summary = checkoutInfo.exists
      ? "The current index adds this submodule path relative to HEAD."
      : "The current index adds this submodule path relative to HEAD, but the checkout is missing.";
  } else if (headOid && !indexOid) {
    relationLabel = stagedRelation.label;
    sections = stagedRelation.sections;
    summary = checkoutInfo.exists
      ? "The current index removes this submodule path relative to HEAD, but a submodule checkout still exists on disk."
      : "The current index removes this submodule path relative to HEAD.";
  }

  return {
    path: filePath,
    repo: repoRel || ".",
    status: "",
    summary,
    relation: relationLabel,
    fields: [
      { label: "Type", value: "submodule (gitlink)" },
      { label: "HEAD gitlink", value: headOid ? formatCommitDisplay(repoDir, headOid, shortOid(headOid)) : "not present in HEAD" },
      { label: "Index gitlink", value: indexOid ? formatCommitDisplay(repoDir, indexOid, shortOid(indexOid)) : "not tracked in index" },
      { label: "Current checkout", value: checkoutOid ? formatCommitDisplay(repoDir, checkoutOid, shortOid(checkoutOid)) : "missing checkout" },
      { label: "Relation", value: relationLabel },
    ],
    sections,
    notes,
  };
}

function sanitizePreviewDiffLabelPath(relFilePath) {
  return String(relFilePath || "")
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r");
}

function previewPathInfo(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return {
      exists: true,
      isRegularFile: stat.isFile(),
    };
  } catch (_err) {
    return {
      exists: false,
      isRegularFile: false,
    };
  }
}

function buildUnifiedDiff(currentFile, snapshotFile, relFilePath, labels, options) {
  const previewOptions = options && typeof options === "object" ? options : {};
  assertPreviewSignalNotAborted(previewOptions.signal);
  const currentInfo = previewPathInfo(currentFile);
  const snapshotInfo = previewPathInfo(snapshotFile);
  assertPreviewSignalNotAborted(previewOptions.signal);
  const currentBytes = currentInfo.exists && currentInfo.isRegularFile ? fs.readFileSync(currentFile) : Buffer.alloc(0);
  assertPreviewSignalNotAborted(previewOptions.signal);
  const snapshotBytes = snapshotInfo.exists && snapshotInfo.isRegularFile ? fs.readFileSync(snapshotFile) : Buffer.alloc(0);
  assertPreviewSignalNotAborted(previewOptions.signal);

  if ((currentInfo.exists && !currentInfo.isRegularFile) || (snapshotInfo.exists && !snapshotInfo.isRegularFile)) {
    return "textual diff unavailable for non-regular file types.";
  }

  if (isBinary(currentBytes) || isBinary(snapshotBytes)) {
    return "Binary/non-text diff preview unavailable; use external tool.";
  }

  const defaultPathLabel = sanitizePreviewDiffLabelPath(relFilePath);
  const oldLabel = labels && labels.oldLabel ? labels.oldLabel : `current:${defaultPathLabel}`;
  const newLabel = labels && labels.newLabel ? labels.newLabel : `snapshot:${defaultPathLabel}`;
  const oldSource = currentInfo.exists ? currentFile : "/dev/null";
  const newSource = snapshotInfo.exists ? snapshotFile : "/dev/null";

  assertPreviewSignalNotAborted(previewOptions.signal);
  const proc = run("diff", ["-u", "--label", oldLabel, "--label", newLabel, oldSource, newSource], {
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

function buildUnifiedDiffFromTexts(previousText, currentText, relFilePath, labels, options) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "git-snapshot-viewed-preview-"));
  const previousFile = path.join(tempDir, "previous.txt");
  const currentFile = path.join(tempDir, "current.txt");
  try {
    fs.writeFileSync(previousFile, String(previousText == null ? "" : previousText), "utf8");
    fs.writeFileSync(currentFile, String(currentText == null ? "" : currentText), "utf8");
    return buildUnifiedDiff(previousFile, currentFile, relFilePath, labels, options);
  } finally {
    rmRf(tempDir);
  }
}

function normalizeStoredPreviewSnapshot(blob) {
  if (!blob || typeof blob !== "object") {
    return null;
  }
  const previewKind = String(blob.preview_kind || "").trim();
  if (previewKind === "text") {
    return {
      preview_kind: "text",
      text: String(blob.text || ""),
    };
  }
  if (previewKind === "submodule_summary") {
    return {
      preview_kind: "submodule_summary",
      data: blob.data && typeof blob.data === "object" ? blob.data : {},
    };
  }
  return null;
}

function quoteUnifiedDiffPath(prefix, relFilePath) {
  const escaped = String(relFilePath || "")
    .replace(/\\/g, "\\\\")
    .replace(/"/g, "\\\"")
    .replace(/\t/g, "\\t")
    .replace(/\n/g, "\\n");
  return `"${prefix}${escaped}"`;
}

function buildSnapshotOnlyDiff(snapshotFile, relFilePath, options) {
  const previewOptions = options && typeof options === "object" ? options : {};
  assertPreviewSignalNotAborted(previewOptions.signal);
  if (!fs.existsSync(snapshotFile)) {
    return `Working tree file is missing. Snapshot preview unavailable. (${relFilePath})`;
  }

  const snapshotBytes = fs.readFileSync(snapshotFile);
  assertPreviewSignalNotAborted(previewOptions.signal);
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

function buildCurrentMissingDiff(snapshotFile, relFilePath, options) {
  const previewOptions = options && typeof options === "object" ? options : {};
  assertPreviewSignalNotAborted(previewOptions.signal);
  if (!fs.existsSync(snapshotFile)) {
    return `Current working tree path is missing and the snapshot target is unavailable. (${relFilePath})`;
  }

  const snapshotBytes = fs.readFileSync(snapshotFile);
  assertPreviewSignalNotAborted(previewOptions.signal);
  if (isBinary(snapshotBytes)) {
    return "Current working tree path is missing. Captured snapshot file is binary/non-text; use external tool.";
  }

  const snapshotText = snapshotBytes.toString("utf8");
  if (snapshotText.length === 0) {
    return `Current working tree path is missing. Captured snapshot file is empty. (${relFilePath})`;
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
    "current-working-tree preview: path missing",
    "--- " + quoteUnifiedDiffPath("a/", relFilePath),
    "+++ /dev/null",
    `@@ -1,${hunkLength} +0,0 @@`,
  ];

  for (const line of lines) {
    diffLines.push("-" + line);
  }
  if (!hasTrailingNewline) {
    diffLines.push("\\ No newline at end of file");
  }

  return diffLines.join("\n");
}

function previewPrimaryActionSupport(previewResult) {
  return !(previewResult && previewResult.primaryActionSupported === false);
}

function previewPrimaryActionHeaderValue(previewResult) {
  return previewPrimaryActionSupport(previewResult) ? "1" : "0";
}

function compareReasonDetailText(row) {
  const status = String(row && row.status ? row.status : "");
  const reason = String(row && row.reason ? row.reason : "").trim();
  if (!reason) return "";
  if (reason === COMPARE_GENERIC_REASONS[status]) {
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

function compareRowReason(row) {
  return String(row && row.reason ? row.reason : "").trim();
}

function compareRowRepoMissing(row) {
  return compareRowReason(row).startsWith("repo missing at ");
}

function compareRowSnapshotRemovesPath(row) {
  const reason = compareRowReason(row);
  return reason === "path still exists while snapshot target removes it"
    || reason === "current-only dirty path exists while restore baseline removes it"
    || reason === "current-only dirty path is absent and restore baseline removes it"
    || reason === "snapshot target removes this path and working tree matches"
    || reason === "snapshot target removes this path and HEAD matches";
}

function compareRowCurrentPathExpectedMissing(row) {
  const reason = compareRowReason(row);
  return String(row && row.status ? row.status : "") === "unresolved_missing"
    || reason === "current-only dirty path is absent and restore baseline removes it"
    || reason === "snapshot target removes this path and working tree matches"
    || reason === "snapshot target removes this path and HEAD matches";
}

function comparePreviewError(filePath, detail) {
  const base = `Compare preview is unavailable for ${filePath}.`;
  return detail ? `${base} ${detail}` : base;
}

function reviewPreviewError(filePath, detail) {
  const base = `Review preview is unavailable for ${filePath}.`;
  return detail ? `${base} ${detail}` : base;
}

function compareBaseDisplayLabel(compareBase) {
  return normalizeCompareBase(compareBase) === "snapshot" ? "snapshot" : "working tree";
}

function compareBaseContextLabel(compareBase) {
  return normalizeCompareBase(compareBase) === "snapshot" ? "base snapshot" : "base working tree";
}

function compareOrientationSpec(compareBase, filePath) {
  const normalizedBase = normalizeCompareBase(compareBase);
  const labelPath = sanitizePreviewDiffLabelPath(filePath);
  if (normalizedBase === "snapshot") {
    return {
      compareBase: normalizedBase,
      oldFileRole: "snapshot",
      newFileRole: "current",
      oldLabel: `snapshot:${labelPath}`,
      newLabel: `current:${labelPath}`,
    };
  }
  return {
    compareBase: normalizedBase,
    oldFileRole: "current",
    newFileRole: "snapshot",
    oldLabel: `current:${labelPath}`,
    newLabel: `snapshot:${labelPath}`,
  };
}

function compareFileForRole(role, snapshotFile, currentFile) {
  return role === "snapshot" ? snapshotFile : currentFile;
}

function configuredExternalDiffCandidates() {
  const envConfigured = String(process.env.GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_CANDIDATES || "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);

  if (envConfigured.length > 0) {
    return envConfigured;
  }

  const repoConfigured = currentRepoGuiConfig().externalDiffCandidates || [];
  return repoConfigured.length > 0 ? repoConfigured : DEFAULT_EXTERNAL_DIFF_CANDIDATES;
}

function tokenizeCommandTemplate(templateText, envVarName) {
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
    throw new SnapshotGuiError(`Unterminated quote in ${envVarName}.`);
  }
  if (current) {
    tokens.push(current);
  }

  return tokens;
}

function applyPlaceholderPatterns(token, patterns, replacement) {
  let out = String(token || "");
  for (const pattern of patterns) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

function hasPlaceholderPattern(token, patterns) {
  const value = String(token || "");
  return patterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  });
}

function applyExternalDiffPlaceholders(token, snapshotFile, currentFile, compareBase) {
  const baseFile = normalizeCompareBase(compareBase) === "snapshot" ? snapshotFile : currentFile;
  const otherFile = normalizeCompareBase(compareBase) === "snapshot" ? currentFile : snapshotFile;
  return applyPlaceholderPatterns(
    applyPlaceholderPatterns(
      applyPlaceholderPatterns(
        applyPlaceholderPatterns(token, EXTERNAL_DIFF_SOURCE_PATTERNS, snapshotFile),
        EXTERNAL_DIFF_TARGET_PATTERNS,
        currentFile
      ),
      EXTERNAL_DIFF_BASE_PATTERNS,
      baseFile
    ),
    EXTERNAL_DIFF_OTHER_PATTERNS,
    otherFile
  );
}

function hasExternalDiffPlaceholder(token, name) {
  if (name === "SOURCE") {
    return hasPlaceholderPattern(token, EXTERNAL_DIFF_SOURCE_PATTERNS);
  }
  if (name === "TARGET") {
    return hasPlaceholderPattern(token, EXTERNAL_DIFF_TARGET_PATTERNS);
  }
  if (name === "BASE") {
    return hasPlaceholderPattern(token, EXTERNAL_DIFF_BASE_PATTERNS);
  }
  return hasPlaceholderPattern(token, EXTERNAL_DIFF_OTHER_PATTERNS);
}

function defaultExternalDiffArgsTemplate(tool) {
  return tool === "code" ? ["--diff", "$BASE", "$OTHER"] : ["$BASE", "$OTHER"];
}

function resolveExternalDiffSelector(rawSelector, sourceLabel = "") {
  const selector = String(rawSelector || "").trim();
  if (!selector) return null;

  if (/\s/.test(selector)) {
    const sourceSuffix = sourceLabel ? ` in ${sourceLabel}` : "";
    throw new SnapshotGuiError(
      `Unsupported external diff selector "${selector}"${sourceSuffix}. Use a bare tool name or an external diff command template.`
    );
  }

  return {
    selector,
    label: selector,
    command: selector,
    argsTemplate: defaultExternalDiffArgsTemplate(selector),
  };
}

function resolveExternalDiffCommandTemplate(templateText, sourceLabel = "GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE") {
  const tokens = tokenizeCommandTemplate(String(templateText || "").trim(), sourceLabel);
  if (!tokens.length) {
    throw new SnapshotGuiError(`${sourceLabel} cannot be empty.`);
  }

  if (!tokens.some((token) => hasExternalDiffPlaceholder(token, "SOURCE") || hasExternalDiffPlaceholder(token, "BASE"))) {
    throw new SnapshotGuiError(`${sourceLabel} must include $SOURCE, \${SOURCE}, $BASE, or \${BASE}.`);
  }
  if (!tokens.some((token) => hasExternalDiffPlaceholder(token, "TARGET") || hasExternalDiffPlaceholder(token, "OTHER"))) {
    throw new SnapshotGuiError(`${sourceLabel} must include $TARGET, \${TARGET}, $OTHER, or \${OTHER}.`);
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
    return resolveExternalDiffCommandTemplate(templateText, "GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE");
  }

  const forcedTool = process.env.GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL
    || process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_TOOL
    || "";
  if (!forcedTool) return null;
  return resolveExternalDiffSelector(forcedTool, "GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL");
}

function commandExists(command) {
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

function configuredExternalDiffUnavailableMessage(spec) {
  const configPath = currentRepoGuiConfig().path || REPO_GUI_CONFIG_FILE_NAME;
  return `Configured external diff command "${spec.command}" is not available. Update ${configPath} or install the command.`;
}

function externalDiffMissingMessage() {
  const candidates = configuredExternalDiffCandidates().join(", ");
  return `No external diff tool found. Set GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_TOOL, GIT_SNAPSHOT_GUI_EXTERNAL_DIFF_COMMAND_TEMPLATE, configure ${REPO_GUI_CONFIG_FILE_NAME}, or install one of: ${candidates}.`;
}

function resolveConfiguredExternalDiffSpec() {
  const repoGuiConfig = currentRepoGuiConfig();
  if (repoGuiConfig.externalDiffCommandTemplate) {
    return resolveExternalDiffCommandTemplate(
      repoGuiConfig.externalDiffCommandTemplate,
      `${repoGuiConfig.path}: ${formatRepoGuiConfigKey("gui", "external-diff", "command-template")}`
    );
  }
  if (repoGuiConfig.externalDiffTool) {
    return resolveExternalDiffSelector(
      repoGuiConfig.externalDiffTool,
      `${repoGuiConfig.path}: ${formatRepoGuiConfigKey("gui", "external-diff", "tool")}`
    );
  }
  return null;
}

function detectExternalDiffSpec() {
  const forcedSpec = resolveForcedExternalDiffSpec();
  if (forcedSpec) {
    if (!commandExists(forcedSpec.command)) {
      throw new SnapshotGuiError(forcedExternalDiffUnavailableMessage(forcedSpec));
    }
    return forcedSpec;
  }

  const configuredSpec = resolveConfiguredExternalDiffSpec();
  if (configuredSpec) {
    if (!commandExists(configuredSpec.command)) {
      throw new SnapshotGuiError(configuredExternalDiffUnavailableMessage(configuredSpec));
    }
    return configuredSpec;
  }

  for (const candidate of configuredExternalDiffCandidates()) {
    const spec = resolveExternalDiffSelector(candidate);
    if (commandExists(spec.command)) return spec;
  }
  return null;
}

function applyEditorPlaceholders(token, filePath) {
  return applyPlaceholderPatterns(token, EDITOR_FILE_PATTERNS, filePath);
}

function resolveEditorCommandTemplate(templateText, sourceLabel = "GIT_SNAPSHOT_GUI_EDITOR_COMMAND_TEMPLATE") {
  const tokens = tokenizeCommandTemplate(String(templateText || "").trim(), sourceLabel);
  if (!tokens.length) {
    throw new SnapshotGuiError(`${sourceLabel} cannot be empty.`);
  }
  if (!tokens.some((token) => hasPlaceholderPattern(token, EDITOR_FILE_PATTERNS))) {
    throw new SnapshotGuiError(`${sourceLabel} must include $FILE or \${FILE}.`);
  }
  return {
    selector: "template",
    label: path.basename(tokens[0]) || tokens[0],
    command: tokens[0],
    argsTemplate: tokens.slice(1),
  };
}

function resolveForcedEditorSpec() {
  const templateText = String(process.env.GIT_SNAPSHOT_GUI_EDITOR_COMMAND_TEMPLATE || "").trim();
  if (!templateText) return null;
  return resolveEditorCommandTemplate(templateText, "GIT_SNAPSHOT_GUI_EDITOR_COMMAND_TEMPLATE");
}

function forcedEditorUnavailableMessage(spec) {
  return `Forced editor command "${spec.command}" is not available. Update GIT_SNAPSHOT_GUI_EDITOR_COMMAND_TEMPLATE or install the command.`;
}

function resolveEditorSelectorVariants(rawSelector, sourceLabel = "") {
  const selector = String(rawSelector || "").trim();
  if (!selector) return [];

  if (/\s/.test(selector)) {
    const sourceSuffix = sourceLabel ? ` in ${sourceLabel}` : "";
    throw new SnapshotGuiError(
      `Unsupported editor selector "${selector}"${sourceSuffix}. Use a bare tool name or an editor command template.`
    );
  }

  if (selector === "code") {
    const variants = [{
      selector,
      label: selector,
      command: "code",
      argsTemplate: ["-g", "$FILE"],
    }];
    if (process.platform === "darwin") {
      variants.push({
        selector,
        label: selector,
        command: "open",
        argsTemplate: ["-a", "Visual Studio Code", "$FILE"],
      });
    }
    return variants;
  }

  return [{
    selector,
    label: selector,
    command: selector,
    argsTemplate: ["$FILE"],
  }];
}

function resolveConfiguredEditorSpec() {
  const repoGuiConfig = currentRepoGuiConfig();
  if (repoGuiConfig.editCommandTemplate) {
    return resolveEditorCommandTemplate(
      repoGuiConfig.editCommandTemplate,
      `${repoGuiConfig.path}: ${formatRepoGuiConfigKey("gui", "edit", "command-template")}`
    );
  }
  if (!repoGuiConfig.editTool) {
    return null;
  }
  const variants = resolveEditorSelectorVariants(
    repoGuiConfig.editTool,
    `${repoGuiConfig.path}: ${formatRepoGuiConfigKey("gui", "edit", "tool")}`
  );
  for (const spec of variants) {
    if (commandExists(spec.command)) {
      return spec;
    }
  }
  throw new SnapshotGuiError(
    `Configured browse editor "${repoGuiConfig.editTool}" is not available. Update ${repoGuiConfig.path} or install the command/app.`
  );
}

function defaultBrowseEditorCommandCandidates() {
  if (process.platform === "darwin") return ["open"];
  if (process.platform === "linux") return ["xdg-open"];
  return [];
}

function detectFirstAvailableCommand(candidates) {
  for (const candidate of candidates) {
    if (commandExists(candidate)) return candidate;
  }
  return "";
}

function defaultBrowseEditorSpec() {
  const openerCommand = detectFirstAvailableCommand(defaultBrowseEditorCommandCandidates());
  if (!openerCommand) return null;
  const argsTemplate = process.platform === "darwin"
    ? ["-t", "$FILE"]
    : ["$FILE"];
  return {
    selector: "default",
    label: openerCommand,
    command: openerCommand,
    argsTemplate,
  };
}

function editorMissingMessage() {
  return `No default file opener is available for browse mode. Set GIT_SNAPSHOT_GUI_EDITOR_COMMAND_TEMPLATE or configure ${REPO_GUI_CONFIG_FILE_NAME}.`;
}

function detectEditorSpec() {
  const forcedSpec = resolveForcedEditorSpec();
  if (forcedSpec) {
    if (!commandExists(forcedSpec.command)) {
      throw new SnapshotGuiError(forcedEditorUnavailableMessage(forcedSpec));
    }
    return forcedSpec;
  }
  const configuredSpec = resolveConfiguredEditorSpec();
  if (configuredSpec) {
    return configuredSpec;
  }
  return defaultBrowseEditorSpec();
}

function recordExternalDiffLaunch(tool, snapshotFile, currentFile, compareBase) {
  const logFile = process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_LOG || "";
  if (!logFile) return false;
  const baseFile = normalizeCompareBase(compareBase) === "snapshot" ? snapshotFile : currentFile;
  const otherFile = normalizeCompareBase(compareBase) === "snapshot" ? currentFile : snapshotFile;

  ensureDir(path.dirname(logFile));
  fs.appendFileSync(
    logFile,
    `tool=${tool}\nsnapshot_file=${snapshotFile}\ncurrent_file=${currentFile}\nbase_file=${baseFile}\nother_file=${otherFile}\ncompare_base=${normalizeCompareBase(compareBase)}\nplatform=${process.platform}\n\n`,
    "utf8"
  );
  return true;
}

function recordDetachedSpawn(logFile, command, args, childPid) {
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

function spawnDetached(command, args, spawnLogFile) {
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.on("error", (error) => {
    const message = error && error.message ? error.message : String(error);
    console.error(`Detached launch failed for ${command}: ${message}`);
  });
  recordDetachedSpawn(spawnLogFile || "", command, args, child.pid);
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
  spawnDetached("osascript", ["-e", script], "");
}

function instantiateExternalDiffLaunch(spec, snapshotFile, currentFile, compareBase) {
  const command = applyExternalDiffPlaceholders(spec.command, snapshotFile, currentFile, compareBase);
  const args = Array.isArray(spec.argsTemplate)
    ? spec.argsTemplate.map((arg) => applyExternalDiffPlaceholders(arg, snapshotFile, currentFile, compareBase))
    : [];
  return { command, args };
}

function launchExternalDiff(spec, snapshotFile, currentFile, compareBase) {
  const launch = instantiateExternalDiffLaunch(spec, snapshotFile, currentFile, compareBase);

  if (recordExternalDiffLaunch(spec.label, snapshotFile, currentFile, compareBase)) {
    return;
  }

  // Launch the external tool in its own process group so stopping compare --gui
  // does not also terminate the opened diff application.
  spawnDetached(launch.command, launch.args, process.env.GIT_SNAPSHOT_GUI_TEST_EXTERNAL_DIFF_SPAWN_LOG || "");

  if (path.basename(launch.command) === "meld" && process.platform === "darwin") {
    activateMeldForegroundMac();
  }
}

function recordEditorLaunch(tool, filePath, command, args) {
  const logFile = process.env.GIT_SNAPSHOT_GUI_TEST_EDITOR_LOG || "";
  if (!logFile) return false;

  ensureDir(path.dirname(logFile));
  const argsText = Array.isArray(args)
    ? args.map((arg, index) => `arg_${index}=${arg}`).join("\n")
    : "";

  fs.appendFileSync(
    logFile,
    `tool=${tool}\nfile=${filePath}\ncommand=${command}\n${argsText}\nplatform=${process.platform}\n\n`,
    "utf8"
  );
  return true;
}

function instantiateEditorLaunch(spec, filePath) {
  const command = applyEditorPlaceholders(spec.command, filePath);
  const args = Array.isArray(spec.argsTemplate)
    ? spec.argsTemplate.map((arg) => applyEditorPlaceholders(arg, filePath))
    : [];
  return { command, args };
}

function launchEditor(spec, filePath) {
  const launch = instantiateEditorLaunch(spec, filePath);

  if (recordEditorLaunch(spec.label, filePath, launch.command, launch.args)) {
    return;
  }

  // Launch the editor/opener in its own process group so stopping browse --gui
  // does not also terminate the opened application.
  spawnDetached(launch.command, launch.args, process.env.GIT_SNAPSHOT_GUI_TEST_EDITOR_SPAWN_LOG || "");
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
  params.set("compare_include_no_effect", boolString(viewState.compareIncludeNoEffect));
  params.set("compare_base", normalizeCompareBase(viewState.compareBase));
  params.set("inspect_include_staged", boolString(viewState.inspectIncludeStaged));
  params.set("inspect_include_unstaged", boolString(viewState.inspectIncludeUnstaged));
  params.set("inspect_include_untracked", boolString(viewState.inspectIncludeUntracked));
  params.set("inspect_show_all_repos", boolString(viewState.inspectShowAllRepos));
  params.set("browse_include_staged", boolString(viewState.browseIncludeStaged));
  params.set("browse_include_unstaged", boolString(viewState.browseIncludeUnstaged));
  params.set("browse_include_untracked", boolString(viewState.browseIncludeUntracked));
  params.set("browse_include_submodules", boolString(viewState.browseIncludeSubmodules));
  params.set("browse_show_all_repos", boolString(viewState.browseShowAllRepos));
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

function viewStateBrowseScopeLabel(viewState) {
  if (viewState.repoFilter) {
    return "selected repo";
  }
  return viewState.browseShowAllRepos ? "all repos" : "repos with changes";
}

function viewStateBrowseCategoryLabel(viewState) {
  const out = [];
  if (viewState.browseIncludeStaged) out.push("staged");
  if (viewState.browseIncludeUnstaged) out.push("unstaged");
  if (viewState.browseIncludeUntracked) out.push("untracked");
  if (viewState.browseIncludeSubmodules) out.push("submodules");
  return out.join(", ");
}

function documentTitleForViewState(viewState) {
  const parts = ["git-snapshot", viewState.mode];
  if (viewState.mode === "browse") {
    parts.push("HEAD");
    parts.push(viewStateRepoScopeText(viewState.repoFilter));
    parts.push(viewStateBrowseCategoryLabel(viewState));
    parts.push(viewStateBrowseScopeLabel(viewState));
  } else if (viewState.mode === "compare") {
    parts.push(viewState.snapshotId || "?");
    parts.push(viewStateRepoScopeText(viewState.repoFilter));
    parts.push(viewState.compareIncludeNoEffect ? "including no-effect rows" : "effect rows only");
    parts.push(compareBaseContextLabel(viewState.compareBase));
  } else if (viewState.mode === "review") {
    parts.push(normalizeReviewBaseRef(viewState.reviewBaseRef, "master"));
    parts.push((Array.isArray(viewState.reviewSelectedRepos) && viewState.reviewSelectedRepos.length)
      ? `${viewState.reviewSelectedRepos.length} selected repos`
      : "no selected repos");
  } else {
    parts.push(viewState.snapshotId || "?");
    parts.push(viewStateRepoScopeText(viewState.repoFilter));
    parts.push(viewStateInspectCategoryLabel(viewState));
    parts.push(viewStateInspectScopeLabel(viewState));
  }
  return parts.filter(Boolean).join(" · ");
}

function documentFaviconSvgForRefreshStatus(status) {
  const normalizedStatus = status === "stale" ? "stale" : (status === "preparing" ? "preparing" : "current");
  const badge = normalizedStatus === "stale"
    ? '<circle cx="25" cy="8" r="5" fill="#0a84ff" stroke="#ffffff" stroke-width="2" />'
    : (normalizedStatus === "preparing"
      ? '<circle cx="25" cy="8" r="5" fill="#c97a00" stroke="#ffffff" stroke-width="2" />'
      : "");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
  <rect x="4" y="4" width="24" height="24" rx="7" fill="#f6f2ea" stroke="#195f54" stroke-width="2" />
  <path d="M10 12h12M10 16h8M10 20h12" stroke="#195f54" stroke-width="2" stroke-linecap="round" />
  ${badge}
</svg>`;
}

function documentFaviconHrefForRefreshStatus(status) {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(documentFaviconSvgForRefreshStatus(status))}`;
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function htmlPage(initialViewState, compareBaseExplicit, repoGuiConfig, rootRepoPhysical) {
  const initialStateJson = escapeForHtmlJson(initialViewState);
  const initialTitle = escapeHtml(documentTitleForViewState(initialViewState));
  const initialFaviconHref = escapeHtml(documentFaviconHrefForRefreshStatus("current"));
  const rootRepoPhysicalJson = escapeForHtmlJson(String(rootRepoPhysical || ""));
  const initialConfiguredCompareBase = escapeForHtmlJson(normalizeCompareBase(
    repoGuiConfig && repoGuiConfig.compareBase ? repoGuiConfig.compareBase : DEFAULT_COMPARE_BASE
  ));
  const initialConfiguredSnapshotShowAuto = repoGuiConfig && repoGuiConfig.hasSnapshotShowAuto
    ? repoGuiConfig.snapshotShowAuto
    : false;
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${initialTitle}</title>
  <link id="dynamicFavicon" rel="icon" type="image/svg+xml" href="${initialFaviconHref}" data-refresh-status="current" />
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
      grid-template-rows: auto minmax(0, 1fr) auto;
      grid-template-areas:
        "top"
        "main"
        "status";
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
      grid-area: top;
      position: relative;
      z-index: 5;
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
    .control-mode {
      flex: 0 1 340px;
      min-width: 260px;
    }
    .mode-picker {
      flex: 1 1 auto;
      min-width: 0;
      width: 100%;
    }
    .control-snapshot {
      flex: 1 1 320px;
      max-width: 560px;
    }
    .control-compare-base {
      flex: 0 0 auto;
    }
    .control-review-picker {
      flex: 1 1 240px;
      max-width: 460px;
    }
    .control-review-base {
      flex: 0 1 300px;
      min-width: 250px;
      max-width: 420px;
    }
    .control-review-presets {
      flex: 1 1 280px;
      max-width: 520px;
    }
    .control-review-selection {
      flex: 1 1 100%;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
    }
    .review-repo-picker {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      width: 100%;
    }
    .review-base-picker {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      width: 100%;
    }
    .review-preset-controls {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      width: 100%;
    }
    .review-preset-picker {
      flex: 1 1 220px;
      min-width: 0;
    }
    #reviewBasePicker .filterable-select-popover {
      min-width: 340px;
    }
    #reviewPresetPicker .filterable-select-trigger.review-preset-active {
      background: rgba(232, 247, 240, 0.98);
      border-color: rgba(25, 135, 84, 0.36);
      color: #176844;
    }
    #reviewPresetPicker .filterable-select-trigger.review-preset-active .filterable-select-trigger-chevron,
    #reviewPresetPicker .filterable-select-trigger.review-preset-active .filterable-select-trigger-text {
      color: inherit;
    }
    #reviewPresetPicker .filterable-select-trigger.review-preset-inactive {
      background: rgba(255, 246, 229, 0.98);
      border-color: rgba(176, 122, 0, 0.34);
      color: #966200;
    }
    #reviewPresetPicker .filterable-select-trigger.review-preset-inactive .filterable-select-trigger-chevron,
    #reviewPresetPicker .filterable-select-trigger.review-preset-inactive .filterable-select-trigger-text {
      color: inherit;
    }
    .review-preset-actions {
      position: relative;
      flex: 0 0 auto;
    }
    .review-preset-actions-button {
      min-width: 40px;
      padding-inline: 10px;
    }
    .review-preset-actions-menu {
      left: auto;
      right: 0;
      min-width: 220px;
      padding: 6px;
      gap: 4px;
    }
    .review-preset-actions-menu button {
      width: 100%;
      justify-content: flex-start;
    }
    .review-preset-actions-menu button[disabled] {
      opacity: 0.45;
      cursor: default;
    }
    .viewed-actions {
      position: relative;
      flex: 0 0 auto;
    }
    .viewed-actions-button {
      min-width: 72px;
    }
    .viewed-actions-menu {
      left: auto;
      right: 0;
      min-width: 240px;
      padding: 6px;
      gap: 4px;
    }
    .viewed-actions-menu button {
      width: 100%;
      justify-content: flex-start;
    }
    .viewed-actions-menu button[disabled] {
      opacity: 0.45;
      cursor: default;
    }
    .review-repo-picker select {
      flex: 1 1 auto;
      min-width: 0;
    }
    .filterable-select {
      position: relative;
      min-width: 0;
      width: 100%;
      max-width: 100%;
    }
    .mode-picker .filterable-select-trigger {
      min-width: 280px;
      min-height: 46px;
      padding: 10px 14px;
    }
    .mode-picker .filterable-select-trigger-text {
      font-size: 15px;
      font-weight: 700;
      letter-spacing: 0.01em;
    }
    .filterable-select-trigger {
      box-sizing: border-box;
      width: 100%;
      min-height: 34px;
      display: inline-flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 6px 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255,255,255,0.92);
      color: var(--ink);
      cursor: pointer;
      font: inherit;
      text-align: left;
    }
    .filterable-select-trigger:focus-visible {
      outline: 2px solid rgba(54, 118, 255, 0.35);
      outline-offset: 1px;
      border-color: rgba(54, 118, 255, 0.6);
    }
    .filterable-select-trigger.filterable-select-open {
      border-color: rgba(54, 118, 255, 0.6);
      box-shadow: 0 0 0 3px rgba(54, 118, 255, 0.12);
    }
    .filterable-select-trigger-text {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .filterable-select-trigger-text.filterable-select-placeholder {
      color: var(--muted);
    }
    .filterable-select-trigger-chevron {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 12px;
    }
    .filterable-select-popover {
      box-sizing: border-box;
      position: absolute;
      top: calc(100% + 6px);
      left: 0;
      right: 0;
      z-index: 25;
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: 10px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255,255,255,0.98);
      box-shadow: 0 12px 32px rgba(16,24,40,0.16);
      backdrop-filter: blur(10px);
    }
    .mode-picker .filterable-select-popover {
      min-width: 340px;
      max-width: 420px;
      padding: 8px;
    }
    .mode-picker .filterable-select-options {
      max-height: none;
      overflow: visible;
    }
    .filterable-select-search {
      box-sizing: border-box;
      width: 100%;
      min-width: 0;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255,255,255,0.96);
      color: var(--ink);
      font: inherit;
    }
    .filterable-select-search:focus-visible {
      outline: 2px solid rgba(54, 118, 255, 0.35);
      outline-offset: 1px;
      border-color: rgba(54, 118, 255, 0.6);
    }
    .filterable-select-options {
      max-height: 280px;
      overflow: auto;
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .filterable-select-option {
      width: 100%;
      border: 0;
      border-radius: 10px;
      background: transparent;
      color: var(--ink);
      cursor: pointer;
      font: inherit;
      padding: 7px 10px;
      text-align: left;
      word-break: break-word;
    }
    .filterable-select-option:hover,
    .filterable-select-option.filterable-select-option-active {
      background: rgba(54, 118, 255, 0.08);
    }
    .filterable-select-option-row {
      display: flex;
      align-items: stretch;
      gap: 6px;
    }
    .filterable-select-option-row .filterable-select-option {
      flex: 1 1 auto;
      min-width: 0;
    }
    .filterable-select-option-action {
      flex: 0 0 auto;
      min-width: 0;
      padding: 7px 10px;
      border-radius: 10px;
      white-space: nowrap;
    }
    .filterable-select-option-action:focus-visible {
      outline: 2px solid rgba(54, 118, 255, 0.35);
      outline-offset: 1px;
    }
    .ask-prompt-history-picker .filterable-select-trigger-text {
      font-size: 13px;
    }
    .mode-picker-option {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      padding: 12px 14px;
      text-align: left;
    }
    .mode-picker-option-main {
      display: flex;
      flex: 1 1 auto;
      min-width: 0;
      flex-direction: column;
      gap: 4px;
    }
    .mode-picker-option-title {
      color: var(--ink);
      font-size: 14px;
      font-weight: 700;
      line-height: 1.25;
    }
    .mode-picker-option-description {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.4;
      white-space: normal;
    }
    .mode-picker-help {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,0.9);
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      line-height: 1;
      cursor: help;
    }
    .mode-picker-option:hover .mode-picker-help,
    .mode-picker-option.filterable-select-option-active .mode-picker-help {
      border-color: rgba(72, 107, 84, 0.28);
      color: var(--ink);
    }
    .filterable-select-empty {
      color: var(--muted);
      font-size: 13px;
      padding: 4px 2px 0;
    }
    .filterable-select-panel {
      width: 100%;
    }
    .review-selected-repos {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      min-height: 0;
    }
    .review-selection-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px 12px;
      padding: 8px 10px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255,255,255,0.7);
    }
    .review-selection-bar-main {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1 1 auto;
      flex-wrap: wrap;
    }
    .review-selection-summary {
      font-weight: 700;
      color: var(--ink);
    }
    .review-selection-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      min-width: 0;
    }
    .review-selection-meta .list-pill {
      font-size: 11px;
      padding: 2px 7px;
    }
    .review-selection-toggle {
      flex: 0 0 auto;
    }
    .review-selected-tray {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(255,255,255,0.7);
      padding: 10px;
    }
    .review-selected-tray.hidden {
      display: none !important;
    }
    .review-selected-empty {
      color: var(--muted);
      font-size: 13px;
    }
    .review-repo-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: rgba(255,255,255,0.92);
      color: var(--ink);
      font-size: 13px;
    }
    .review-repo-chip.dragging {
      opacity: 0.55;
    }
    .review-repo-chip.drag-target {
      border-color: rgba(54, 118, 255, 0.6);
      box-shadow: 0 0 0 2px rgba(54, 118, 255, 0.12);
    }
    .review-repo-chip-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .review-repo-chip-handle,
    .review-repo-chip button {
      border: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
      padding: 0;
      font: inherit;
      line-height: 1;
    }
    .review-repo-chip-handle {
      cursor: grab;
      font-size: 14px;
    }
    .review-repo-chip button:hover,
    .review-repo-chip-handle:hover {
      color: var(--ink);
    }
    .review-repo-chip button[disabled] {
      opacity: 0.35;
      cursor: default;
    }
    .review-repo-chip-remove:hover {
      color: var(--danger);
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
    .snapshot-picker {
      flex: 1 1 auto;
      min-width: 0;
    }
    .snapshot-picker-button {
      width: 100%;
      min-height: 40px;
      padding: 7px 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      text-align: left;
    }
    .snapshot-picker-button:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .snapshot-picker-button:disabled {
      opacity: 0.55;
    }
    .snapshot-picker-text {
      display: block;
      min-width: 0;
      flex: 1 1 auto;
    }
    .snapshot-picker-primary {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .snapshot-picker-primary {
      font-weight: 700;
      color: var(--ink);
    }
    .snapshot-picker-chevron {
      color: var(--muted);
      font-size: 12px;
      flex: 0 0 auto;
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
    .compare-base-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0;
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: hidden;
      background: rgba(255,255,255,0.92);
    }
    .compare-base-prefix {
      padding: 7px 10px;
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: rgba(15, 23, 42, 0.04);
      border-right: 1px solid var(--line);
      white-space: nowrap;
    }
    .compare-base-option {
      position: relative;
      display: inline-flex;
      align-items: center;
      margin: 0;
      cursor: pointer;
    }
    .compare-base-option + .compare-base-option {
      border-left: 1px solid var(--line);
    }
    .compare-base-option input {
      position: absolute;
      inset: 0;
      opacity: 0;
      margin: 0;
      pointer-events: none;
    }
    .compare-base-option span {
      display: inline-flex;
      align-items: center;
      min-height: 34px;
      padding: 0 12px;
      font-size: 13px;
      color: var(--ink);
      background: transparent;
    }
    .compare-base-option input:checked + span {
      background: rgba(27, 99, 244, 0.12);
      color: var(--accent);
      font-weight: 600;
    }
    .actions-control {
      flex: 0 0 auto;
    }
    .root-repo-chip {
      width: auto;
      max-width: 100%;
      min-height: 34px;
      justify-content: flex-start;
      padding: 6px 10px;
      min-width: 0;
      border-radius: 999px;
      overflow: hidden;
      cursor: copy;
    }
    .root-repo-chip:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .root-repo-chip-text {
      display: block;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .status-strip {
      grid-area: status;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px 12px;
      min-width: 0;
      padding: 6px 12px;
      border-top: 1px solid var(--line);
      background: rgba(255,255,255,0.74);
      backdrop-filter: blur(8px);
      font-size: 12px;
      color: var(--muted);
    }
    .status-strip-main {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 0;
      flex: 1 1 auto;
    }
    .status-strip-label {
      flex: 0 0 auto;
      font-size: 11px;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    .status-strip .root-repo-chip {
      min-height: 28px;
      padding: 4px 10px;
      background: rgba(255,255,255,0.88);
    }
    .status-strip .root-repo-chip-text {
      max-width: min(48vw, 520px);
    }
    .status-strip-server {
      display: flex;
      align-items: center;
      gap: 8px;
      flex: 0 0 auto;
      min-width: 0;
    }
    .server-status-chip {
      cursor: default;
      user-select: none;
    }
    .server-status-chip.connected {
      background: #eef8f1;
      border-color: #bfdcc8;
      color: #1d6f42;
    }
    .server-status-chip.preparing {
      background: #fff6df;
      border-color: #ecd39a;
      color: #8c5c00;
    }
    .server-status-chip.stale {
      background: #eef4ff;
      border-color: #b7c9f2;
      color: #1e56a6;
    }
    .server-status-chip.disconnected {
      background: #fdeaea;
      border-color: #e39b9b;
      color: #9f1f1f;
    }
    .actions {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: flex-start;
    }
    .split-button {
      position: relative;
      display: inline-flex;
      align-items: stretch;
    }
    .split-button-main {
      border-top-right-radius: 0;
      border-bottom-right-radius: 0;
    }
    .split-button.menu-hidden .split-button-main {
      border-top-right-radius: 8px;
      border-bottom-right-radius: 8px;
    }
    .split-button-menu {
      min-width: 38px;
      padding: 7px 10px;
      border-top-left-radius: 0;
      border-bottom-left-radius: 0;
      border-left: 0;
    }
    .refresh-menu {
      position: absolute;
      top: calc(100% + 8px);
      left: 0;
      z-index: 40;
      width: min(320px, calc(100vw - 24px));
      border-radius: 14px;
      border: 1px solid #d8d1bf;
      background: #fffdf8;
      box-shadow: 0 20px 44px rgba(31, 35, 40, 0.18);
      padding: 12px;
    }
    .refresh-menu-copy {
      display: grid;
      gap: 6px;
      margin-bottom: 10px;
    }
    .refresh-menu-copy-line {
      margin: 0;
      font-size: 13px;
      line-height: 1.45;
      color: rgba(61, 43, 26, 0.85);
    }
    .refresh-menu-item {
      width: 100%;
      justify-content: center;
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
    .button-secondary {
      background: rgba(255,255,255,0.92);
      color: var(--ink);
      border: 1px solid var(--line);
    }
    .button-secondary.active {
      background: var(--accent-soft);
      color: var(--accent);
      border-color: rgba(25, 95, 84, 0.2);
      font-weight: 700;
    }
    .button-secondary.refresh-pending {
      position: relative;
      padding-right: 28px;
    }
    .button-secondary.refresh-pending::after {
      content: "";
      position: absolute;
      top: 10px;
      right: 10px;
      width: 8px;
      height: 8px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 2px rgba(25, 95, 84, 0.14);
    }
    .button-secondary.refresh-preparing {
      position: relative;
      padding-right: 30px;
    }
    .button-secondary.refresh-preparing::after {
      content: "";
      position: absolute;
      top: 8px;
      right: 9px;
      width: 12px;
      height: 12px;
      border-radius: 999px;
      border: 2px solid rgba(25, 95, 84, 0.2);
      border-top-color: var(--accent);
      animation: refresh-spin 0.9s linear infinite;
    }
    @keyframes refresh-spin {
      to {
        transform: rotate(360deg);
      }
    }
    .hidden { display: none !important; }
    body.modal-open {
      overflow: hidden;
    }
    .filters-overlay {
      position: fixed;
      inset: 0;
      z-index: 19;
      background: rgba(25, 20, 12, 0);
    }
    .snapshot-overlay {
      position: fixed;
      inset: 0;
      z-index: 18;
      background: rgba(25, 20, 12, 0);
    }
    .snapshot-panel {
      position: fixed;
      width: min(620px, calc(100vw - 24px));
      max-height: min(80vh, 700px);
      overflow: auto;
      border-radius: 16px;
      border: 1px solid #d8d1bf;
      background: #fffdf8;
      box-shadow: 0 24px 60px rgba(31, 35, 40, 0.22);
      padding: 16px 18px 18px;
    }
    .snapshot-panel-header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
    }
    .snapshot-panel-header-main {
      display: grid;
      gap: 4px;
      min-width: 0;
    }
    .snapshot-panel-title {
      margin: 0;
      font-size: 18px;
      line-height: 1.25;
    }
    .snapshot-panel-toggle {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      margin-left: auto;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    .snapshot-panel-toggle input {
      margin: 0;
    }
    .snapshot-list {
      margin-top: 14px;
      display: grid;
      gap: 10px;
    }
    .snapshot-entry {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      gap: 10px;
      padding: 10px;
      border: 1px solid #ddd5c6;
      border-radius: 14px;
      background: #fff;
    }
    .snapshot-entry.active {
      border-color: rgba(25, 95, 84, 0.28);
      box-shadow: 0 0 0 1px rgba(25, 95, 84, 0.16);
      background: #f8fffc;
    }
    .snapshot-entry-select {
      display: block;
      width: 100%;
      padding: 0;
      background: transparent;
      border: 0;
      color: inherit;
      text-align: left;
    }
    .snapshot-entry-select:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 3px;
      border-radius: 10px;
    }
    .snapshot-entry-main {
      display: grid;
      gap: 5px;
      min-width: 0;
    }
    .snapshot-entry-top {
      display: flex;
      align-items: center;
      gap: 8px;
      flex-wrap: wrap;
      min-width: 0;
    }
    .snapshot-entry-id {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-weight: 700;
      color: var(--ink);
    }
    .snapshot-origin-badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      background: #f0ece2;
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .snapshot-entry-meta {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
      word-break: break-word;
    }
    .snapshot-entry-actions {
      display: flex;
      flex-direction: column;
      align-items: stretch;
      gap: 8px;
      justify-content: center;
    }
    .snapshot-entry-action {
      padding: 6px 10px;
      border-radius: 10px;
      border: 1px solid var(--line);
      background: rgba(255,255,255,0.94);
      color: var(--ink);
      font-size: 12px;
      line-height: 1.2;
    }
    .snapshot-entry-action:hover:not(:disabled) {
      background: #f3eee3;
    }
    .snapshot-entry-action.delete {
      color: var(--danger);
      border-color: rgba(138, 43, 43, 0.18);
      background: #fff7f7;
    }
    .snapshot-empty {
      margin-top: 14px;
      padding: 14px 16px;
      border: 1px dashed #ddd5c6;
      border-radius: 14px;
      color: var(--muted);
      background: rgba(255,255,255,0.76);
    }
    .filters-panel {
      position: fixed;
      width: min(420px, calc(100vw - 24px));
      max-height: min(78vh, 620px);
      overflow-x: hidden;
      overflow-y: auto;
      border-radius: 16px;
      border: 1px solid #d8d1bf;
      background: #fffdf8;
      box-shadow: 0 24px 60px rgba(31, 35, 40, 0.22);
      padding: 16px 18px 18px;
    }
    .filters-header {
      display: grid;
      gap: 4px;
    }
    .filters-title {
      margin: 0;
      font-size: 18px;
      line-height: 1.25;
    }
    .filters-subtitle {
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .filters-body {
      margin-top: 14px;
      display: grid;
      gap: 14px;
      min-width: 0;
    }
    .filters-section {
      display: grid;
      gap: 10px;
      min-width: 0;
    }
    .filters-section + .filters-section {
      padding-top: 14px;
      border-top: 1px solid #ece5d6;
    }
    .filters-section-title {
      font-size: 11px;
      font-weight: 700;
      color: var(--muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .filters-footer {
      margin-top: 16px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 10px;
    }
    .filters-footer-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
      margin-left: auto;
    }
    .modal-backdrop {
      position: fixed;
      inset: 0;
      z-index: 20;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      background: rgba(25, 20, 12, 0.42);
      backdrop-filter: blur(6px);
    }
    .modal-card {
      width: min(100%, 460px);
      border-radius: 16px;
      border: 1px solid #d8d1bf;
      background: #fffdf8;
      box-shadow: 0 24px 60px rgba(31, 35, 40, 0.22);
      overflow: hidden;
    }
    .modal-header {
      padding: 16px 18px 12px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, #fffdf8, #f7f1e4);
    }
    .modal-title {
      margin: 0;
      font-size: 18px;
      line-height: 1.25;
    }
    .modal-subtitle {
      margin: 6px 0 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
    }
    .modal-form {
      display: grid;
      gap: 14px;
      padding: 16px 18px 18px;
    }
    .modal-field {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .modal-field label {
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.03em;
      text-transform: uppercase;
      color: var(--muted);
    }
    .modal-field select,
    .modal-field input[type="text"] {
      display: block;
      width: 100%;
      min-width: 0;
      max-width: 100%;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid #cfc6b3;
      background: #fff;
      color: var(--ink);
      font: inherit;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .modal-field select {
      appearance: auto;
    }
    .ask-prompt-history-picker-wrap {
      min-width: 0;
    }
    .modal-field select:focus-visible,
    .modal-field input[type="text"]:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .control select.visually-hidden,
    .modal-field select.visually-hidden {
      position: absolute !important;
      width: 1px !important;
      height: 1px !important;
      min-width: 1px !important;
      max-width: 1px !important;
      padding: 0 !important;
      margin: -1px !important;
      overflow: hidden !important;
      clip: rect(0, 0, 0, 0) !important;
      white-space: nowrap !important;
      border: 0 !important;
      appearance: none !important;
      pointer-events: none !important;
    }
    .modal-field-help {
      color: var(--muted);
      font-size: 12px;
      line-height: 1.5;
    }
    .modal-checkbox {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      color: var(--ink);
      line-height: 1.45;
    }
    .modal-checkbox input {
      margin-top: 2px;
    }
    .modal-status {
      min-height: 18px;
      color: var(--muted);
      font-size: 12px;
      line-height: 1.45;
    }
    .modal-status.error {
      color: var(--danger);
    }
    .modal-actions {
      display: flex;
      justify-content: flex-end;
      gap: 10px;
    }
    .modal-actions .secondary {
      background: #efe7d5;
      color: var(--ink);
    }
    .modal-actions .danger,
    .button-danger {
      background: #9d3434;
      color: #fff;
    }
    .main {
      grid-area: main;
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
    .list-pill.diff-stat {
      gap: 0;
      font-weight: 700;
    }
    .list-pill.diff-stat strong {
      color: inherit;
    }
    .list-pill.diff-stat-add {
      background: var(--gh-add-bg);
      border-color: var(--gh-add-gutter);
      color: var(--gh-add-text);
    }
    .list-pill.diff-stat-remove {
      background: var(--gh-del-bg);
      border-color: var(--gh-del-gutter);
      color: var(--gh-del-text);
    }
    .list-pill.danger {
      background: #fdeaea;
      border-color: #e39b9b;
      color: #9f1f1f;
    }
    .list-pill.warning {
      background: #fff6df;
      border-color: #ecd39a;
      color: #8c5c00;
    }
    .list-pill.viewed {
      background: #eef8f1;
      border-color: #bfdcc8;
      color: #1d6f42;
    }
    .row-context-menu {
      position: fixed;
      z-index: 60;
      min-width: 220px;
      max-width: min(320px, calc(100vw - 20px));
      border-radius: 14px;
      border: 1px solid #d8d1bf;
      background: #fffdf8;
      box-shadow: 0 20px 44px rgba(31, 35, 40, 0.18);
      padding: 8px;
      display: grid;
      gap: 8px;
    }
    .row-context-menu-section {
      display: grid;
      gap: 4px;
    }
    .row-context-menu-section + .row-context-menu-section {
      padding-top: 8px;
      border-top: 1px solid #ece3d1;
    }
    .row-context-menu-section-title {
      color: var(--muted);
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 0 6px;
    }
    .row-context-menu-item {
      width: 100%;
      justify-content: flex-start;
    }
    .row-context-menu-item.has-submenu {
      justify-content: space-between;
      gap: 12px;
    }
    .row-context-menu-item-label {
      min-width: 0;
      text-align: left;
    }
    .row-context-menu-item-caret {
      color: var(--muted);
      font-size: 12px;
      flex: 0 0 auto;
    }
    .row-context-menu-item[disabled] {
      opacity: 0.45;
      cursor: default;
    }
    .row-context-menu-submenu-wrap {
      position: relative;
    }
    .row-context-menu-submenu {
      position: absolute;
      top: 0;
      left: calc(100% + 8px);
      min-width: 200px;
      max-width: min(320px, calc(100vw - 20px));
      border-radius: 14px;
      border: 1px solid #d8d1bf;
      background: #fffdf8;
      box-shadow: 0 20px 44px rgba(31, 35, 40, 0.18);
      padding: 8px;
      display: none;
      gap: 8px;
      z-index: 61;
    }
    .row-context-menu-submenu-wrap:hover > .row-context-menu-submenu,
    .row-context-menu-submenu-wrap:focus-within > .row-context-menu-submenu {
      display: grid;
    }
    .modal-field textarea {
      display: block;
      width: 100%;
      min-width: 0;
      max-width: 100%;
      min-height: 112px;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid #cfc6b3;
      background: #fff;
      color: var(--ink);
      font: inherit;
      resize: vertical;
      line-height: 1.45;
    }
    .modal-field textarea:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 1px;
    }
    .ask-selection-preview {
      margin: 0;
      max-height: 220px;
      overflow: auto;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid #e6dcc9;
      background: #fbf7ee;
      color: var(--ink);
      font-family: "SFMono-Regular", ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 12px;
      line-height: 1.5;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .client-toast {
      position: fixed;
      left: 50%;
      bottom: 20px;
      z-index: 80;
      transform: translateX(-50%);
      padding: 10px 14px;
      border-radius: 999px;
      border: 1px solid #d8d1bf;
      background: rgba(33, 29, 24, 0.94);
      color: #fffdf8;
      box-shadow: 0 18px 44px rgba(31, 35, 40, 0.28);
      font-size: 12px;
      line-height: 1.4;
      pointer-events: none;
    }
    .client-toast.error {
      background: rgba(132, 35, 35, 0.96);
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
    .preview-controls {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255,255,255,0.82);
      padding: 8px 10px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px 10px;
      flex-wrap: wrap;
    }
    .preview-controls.hidden {
      display: none !important;
    }
    .preview-controls-meta {
      color: var(--muted);
      font-size: 13px;
      min-width: 0;
      flex: 1 1 auto;
    }
    .preview-mode-toggle {
      display: inline-flex;
      gap: 0;
      border: 1px solid var(--line);
      border-radius: 999px;
      overflow: hidden;
      background: #fff;
    }
    .preview-mode-button {
      border: 0;
      background: transparent;
      color: var(--muted);
      font: inherit;
      padding: 5px 10px;
      cursor: pointer;
    }
    .preview-mode-button + .preview-mode-button {
      border-left: 1px solid var(--line);
    }
    .preview-mode-button.active {
      background: var(--accent-soft);
      color: var(--accent);
      font-weight: 700;
    }
    .preview-mode-button:disabled {
      opacity: 0.55;
      cursor: not-allowed;
    }
    .file-row-shell,
    .selection-row-shell {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto;
      align-items: stretch;
      gap: 0;
      min-width: 0;
    }
    .repo-header > .selection-row-shell {
      flex: 1 1 260px;
    }
    .file-row-shell {
      border-top: 1px dashed #ece7d9;
    }
    .file-row-shell .row,
    .selection-row-shell .row {
      border-top: 0;
    }
    .file-row-shell.active .row,
    .file-row-shell.active .row-menu-trigger,
    .selection-row-shell.active .row,
    .selection-row-shell.active .row-menu-trigger {
      background: var(--accent-soft);
    }
    .row-menu-trigger {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 38px;
      padding: 7px 10px;
      border: 0;
      border-left: 1px dashed #ece7d9;
      background: transparent;
      color: var(--muted);
      font: inherit;
      cursor: pointer;
    }
    .file-row-shell:hover .row-menu-trigger,
    .selection-row-shell:hover .row-menu-trigger {
      background: #f2efe5;
    }
    .file-row-shell.active .row-menu-trigger,
    .selection-row-shell.active .row-menu-trigger {
      color: var(--accent);
      border-left-color: rgba(25, 95, 84, 0.16);
    }
    .row-menu-trigger:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: -2px;
    }
    .repo {
      padding: 9px 10px;
      border-top: 1px solid var(--line);
      background: var(--panel-strong);
    }
    .repo-select,
    .category-select {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px 12px;
      width: 100%;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      text-align: left;
      cursor: pointer;
    }
    .repo-select.row,
    .category-select.row {
      border-top: 0;
    }
    .repo-select:focus-visible,
    .category-select:focus-visible {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }
    .repo-select.active,
    .category-select.active {
      color: var(--accent-strong);
    }
    .repo-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px 12px;
      flex-wrap: wrap;
    }
    .repo-header-main {
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-width: 0;
      flex: 1 1 260px;
    }
    .repo-title {
      font-weight: 700;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .repo-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
      color: var(--muted);
    }
    .repo-stats {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .review-repo-base-control {
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 180px;
      max-width: 360px;
      width: 100%;
    }
    .review-repo-base-control-label {
      color: var(--muted);
      flex: 0 0 auto;
    }
    .review-repo-base-control .filterable-select {
      flex: 1 1 auto;
    }
    .category {
      padding: 6px 10px;
      border-top: 1px dashed #e6dfce;
      color: var(--muted);
      background: #faf6ec;
    }
    .category-label {
      font-weight: 700;
      text-transform: capitalize;
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
      flex-wrap: wrap;
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
    .status-pill.no-effect {
      background: #f4f1e8;
      border-color: #d8cfbd;
      color: #6b6455;
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
    .aggregate-preview {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 12px;
    }
    .aggregate-preview-summary {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 12px;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 8px;
      border-bottom: 1px solid var(--line);
    }
    .aggregate-preview-title {
      font-weight: 700;
    }
    .aggregate-preview-subtitle {
      color: var(--muted);
      flex: 1 1 100%;
    }
    .aggregate-preview-error {
      color: var(--danger);
      flex: 1 1 100%;
      font-weight: 600;
    }
    .aggregate-preview-show-all {
      border: 1px solid var(--line);
      background: #fff;
      border-radius: 999px;
      padding: 4px 10px;
      font: inherit;
      cursor: pointer;
    }
    .aggregate-preview-block {
      border: 1px solid var(--line);
      border-radius: 10px;
      background: rgba(255,255,255,0.85);
      overflow: hidden;
    }
    .aggregate-preview-block-header {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px 12px;
      padding: 10px 12px;
      border-bottom: 1px solid var(--line);
      background: #fbf7ef;
    }
    .aggregate-preview-block-path {
      font-weight: 700;
      overflow-wrap: anywhere;
    }
    .aggregate-preview-block-meta {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .aggregate-preview .preview-pre,
    .aggregate-preview .submodule-summary,
    .aggregate-preview .diff-table-wrap {
      margin: 0;
      border: 0;
      border-radius: 0;
      box-shadow: none;
    }
    .aggregate-preview .diff-file {
      border: 0;
      background: transparent;
    }
    .aggregate-preview .diff-file-header {
      padding-top: 8px;
      padding-bottom: 8px;
      background: rgba(255,255,255,0.72);
    }
    .aggregate-preview .diff-file-header-compact {
      padding-left: 12px;
      padding-right: 12px;
    }
    .aggregate-preview .diff-file-meta {
      padding-left: 12px;
      padding-right: 12px;
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
      .control-compare-base,
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
      .control-compare-base,
      .control-repo,
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
      .status-strip {
        flex-wrap: wrap;
        padding: 6px 10px 7px;
      }
      .status-strip-main,
      .status-strip-server {
        width: 100%;
      }
      .status-strip .root-repo-chip-text {
        max-width: none;
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
      .filters-overlay {
        background: rgba(25, 20, 12, 0.42);
        backdrop-filter: blur(6px);
      }
      .snapshot-overlay {
        background: rgba(25, 20, 12, 0.42);
        backdrop-filter: blur(6px);
      }
      .snapshot-panel {
        left: 12px !important;
        right: 12px !important;
        bottom: 12px !important;
        top: auto !important;
        width: auto;
        max-height: min(82vh, 720px);
      }
      .snapshot-panel-header {
        flex-direction: column;
        align-items: stretch;
      }
      .snapshot-panel-toggle {
        margin-left: 0;
        justify-content: flex-start;
      }
      .snapshot-entry {
        grid-template-columns: 1fr;
      }
      .snapshot-entry-actions {
        flex-direction: row;
        justify-content: flex-end;
      }
      .filters-panel {
        left: 12px !important;
        right: 12px !important;
        bottom: 12px !important;
        top: auto !important;
        width: auto;
        max-height: min(80vh, 680px);
      }
      .filters-footer {
        flex-direction: column;
        align-items: stretch;
      }
      .filters-footer-actions {
        width: 100%;
        justify-content: stretch;
        margin-left: 0;
      }
      .filters-footer-actions button,
      .filters-footer > button {
        flex: 1 1 auto;
      }
    }
  </style>
</head>
<body>
  <div class="top">
    <div class="controls">
      <div class="control control-mode">
        <label for="modeSelect">Mode</label>
        <div class="mode-picker">
          <select id="modeSelect" class="visually-hidden" tabindex="-1" aria-hidden="true">
            <option
              value="browse"
              data-description="Browse live working-tree changes across repos."
              data-help="Browse the live working tree across repos, including staged, unstaged, untracked, and submodule changes."
            >Browse</option>
            <option
              value="compare"
              data-description="Compare the current workspace against a saved snapshot’s restore effect."
              data-help="Shows what would change if you restored this snapshot now.&#10;It compares the current workspace to the snapshot’s captured restorable state: staged changes, unstaged changes, untracked files, and root-level submodule pointer changes.&#10;It does not recursively diff committed history inside every repo or submodule.&#10;Use Inspect to see what the snapshot captured in each repo. Use Review to compare committed changes against a base ref."
            >Snapshot compare</option>
            <option
              value="inspect"
              data-description="Inspect what a snapshot captured in each repo."
              data-help="Inspect the snapshot’s captured repo state, including snapshot HEAD metadata plus staged, unstaged, and untracked content that was recorded."
            >Inspect</option>
            <option
              value="review"
              data-description="Review committed changes against a chosen base ref."
              data-help="Review committed delta across selected repos against a chosen base ref. This focuses on committed changes, while dirty badges stay live metadata only."
            >Review</option>
          </select>
          <div id="modePicker" class="filterable-select" data-placeholder="Select mode" data-no-matches="No matching modes"></div>
        </div>
      </div>
      <div class="control control-snapshot">
        <label for="snapshotPickerButton">Snapshot</label>
        <div class="snapshot-picker">
          <select id="snapshotSelect" class="visually-hidden" tabindex="-1" aria-hidden="true"></select>
          <button
            id="snapshotPickerButton"
            type="button"
            class="snapshot-picker-button button-secondary"
            aria-expanded="false"
            aria-controls="snapshotOverlay"
            aria-haspopup="dialog"
          >
            <span class="snapshot-picker-text">
              <span id="snapshotPickerPrimary" class="snapshot-picker-primary">No snapshots available</span>
            </span>
            <span class="snapshot-picker-chevron" aria-hidden="true">▾</span>
          </button>
        </div>
      </div>
      <div class="control control-compare-base">
        <label>Base</label>
        <div class="compare-base-toggle" role="radiogroup" aria-label="Compare base">
          <label class="compare-base-option">
            <input id="compareBaseSnapshot" type="radio" name="compareBase" value="snapshot" />
            <span>snapshot</span>
          </label>
          <label class="compare-base-option">
            <input id="compareBaseWorkingTree" type="radio" name="compareBase" value="working-tree" />
            <span>working tree</span>
          </label>
        </div>
      </div>
      <div class="control control-review-picker hidden">
        <label for="reviewRepoSelect">Review Repo</label>
        <div class="review-repo-picker">
          <select id="reviewRepoSelect" class="visually-hidden" tabindex="-1" aria-hidden="true"></select>
          <div id="reviewRepoPicker" class="filterable-select" data-placeholder="Add repo…" data-no-matches="No matching repos"></div>
        </div>
      </div>
      <div class="control control-review-base hidden">
        <label for="reviewBaseSelect">Base</label>
        <div class="review-base-picker">
          <select id="reviewBaseSelect" class="visually-hidden" tabindex="-1" aria-hidden="true"></select>
          <div id="reviewBasePicker" class="filterable-select" data-placeholder="master" data-no-matches="Press Enter to use this ref"></div>
        </div>
      </div>
      <div class="control control-review-presets hidden">
        <label for="reviewPresetSelect">Preset</label>
        <div class="review-preset-controls">
          <div class="review-preset-picker">
            <select id="reviewPresetSelect" class="visually-hidden" tabindex="-1" aria-hidden="true"></select>
            <div id="reviewPresetPicker" class="filterable-select" data-placeholder="Load preset…" data-no-matches="No matching presets"></div>
          </div>
          <div id="reviewPresetActions" class="split-button review-preset-actions">
            <button
              id="reviewPresetActionsButton"
              type="button"
              class="button-secondary review-preset-actions-button"
              aria-haspopup="menu"
              aria-expanded="false"
              aria-controls="reviewPresetActionsMenu"
            >
              <span class="visually-hidden">Preset actions</span>
              <span aria-hidden="true">⋯</span>
            </button>
            <div id="reviewPresetActionsMenu" class="refresh-menu review-preset-actions-menu hidden" role="menu" aria-labelledby="reviewPresetActionsButton">
              <button id="reviewPresetSave" type="button" class="button-secondary refresh-menu-item" role="menuitem">Save current as preset</button>
              <button id="reviewPresetRename" type="button" class="button-secondary refresh-menu-item" role="menuitem" disabled>Rename preset</button>
              <button id="reviewPresetDelete" type="button" class="button-secondary refresh-menu-item" role="menuitem" disabled>Delete preset</button>
            </div>
          </div>
        </div>
      </div>
      <div class="control actions-control">
        <div class="actions">
          <button id="filtersButton" type="button" class="button-secondary" aria-expanded="false" aria-controls="filtersOverlay">Filters</button>
          <div id="refreshSplit" class="split-button">
            <button id="refresh" type="button" class="button-secondary split-button-main">Refresh</button>
            <button
              id="refreshMenuButton"
              type="button"
              class="button-secondary split-button-menu"
              aria-haspopup="menu"
              aria-expanded="false"
              aria-controls="refreshMenu"
            >
              <span class="visually-hidden">Refresh options</span>
              <span aria-hidden="true">▾</span>
            </button>
            <div id="refreshMenu" class="refresh-menu hidden" role="menu" aria-labelledby="refreshMenuButton">
              <div class="refresh-menu-copy">
                <p id="refreshMenuCopyPrimary" class="refresh-menu-copy-line"><strong>Refresh</strong> reloads the current view.</p>
                <p id="refreshMenuCopySecondary" class="refresh-menu-copy-line"><strong>Reload Snapshots</strong> also refreshes snapshot inventory.</p>
              </div>
              <button id="hardRefresh" type="button" class="button-secondary refresh-menu-item" role="menuitem">Reload Snapshots</button>
            </div>
          </div>
          <div id="viewedActions" class="split-button viewed-actions">
            <button
              id="viewedActionsButton"
              type="button"
              class="button-secondary viewed-actions-button"
              aria-haspopup="menu"
              aria-expanded="false"
              aria-controls="viewedActionsMenu"
            >
              Viewed
            </button>
            <div id="viewedActionsMenu" class="refresh-menu viewed-actions-menu hidden" role="menu" aria-labelledby="viewedActionsButton">
              <button id="clearViewedMode" type="button" class="button-secondary refresh-menu-item" role="menuitem" disabled>Clear viewed in current mode</button>
              <button id="clearViewedAll" type="button" class="button-secondary refresh-menu-item" role="menuitem" disabled>Clear all viewed</button>
            </div>
          </div>
          <button id="createSnapshot" type="button" class="hidden">Create Snapshot</button>
          <button id="resetAll" type="button" class="button-secondary hidden">Reset All</button>
          <button id="openExternal" type="button" disabled>Open External Diff</button>
        </div>
      </div>
      <div class="control control-review-selection hidden">
        <div class="review-selection-bar">
          <div class="review-selection-bar-main">
            <div id="reviewSelectionSummary" class="review-selection-summary">0 repos selected</div>
            <div id="reviewSelectionMeta" class="review-selection-meta"></div>
          </div>
          <button id="reviewSelectionToggle" type="button" class="button-secondary review-selection-toggle" aria-expanded="false" aria-controls="reviewSelectedTray">Manage ▾</button>
        </div>
        <div id="reviewSelectedTray" class="review-selected-tray hidden">
          <div id="reviewSelectedRepos" class="review-selected-repos"></div>
        </div>
      </div>
    </div>
    <div id="meta" class="visually-hidden"></div>
    <div id="summary" class="visually-hidden"></div>
  </div>
  <div id="snapshotOverlay" class="snapshot-overlay hidden" aria-hidden="true">
    <div id="snapshotPanel" class="snapshot-panel" role="dialog" aria-modal="true" aria-labelledby="snapshotPanelTitle">
      <div class="snapshot-panel-header">
        <div class="snapshot-panel-header-main">
          <h2 id="snapshotPanelTitle" class="snapshot-panel-title">Snapshots</h2>
        </div>
        <label class="snapshot-panel-toggle" for="snapshotShowAuto">
          <input id="snapshotShowAuto" type="checkbox" />
          <span>Show auto</span>
        </label>
      </div>
      <div id="snapshotList" class="snapshot-list"></div>
      <div id="snapshotEmpty" class="snapshot-empty hidden">No snapshots are available yet. Create one in browse mode first.</div>
    </div>
  </div>
  <div id="filtersOverlay" class="filters-overlay hidden" aria-hidden="true">
    <div id="filtersPanel" class="filters-panel" role="dialog" aria-modal="true" aria-labelledby="filtersTitle">
      <div class="filters-header">
        <h2 id="filtersTitle" class="filters-title">Filters</h2>
        <div id="filtersSubtitle" class="filters-subtitle">Adjust the current mode's advanced controls.</div>
      </div>
      <div class="filters-body">
        <div class="filters-section">
          <div class="modal-field">
            <label for="repoFilter">Repo</label>
            <select id="repoFilter" class="visually-hidden" tabindex="-1" aria-hidden="true"></select>
            <div id="repoFilterPicker" class="filterable-select filterable-select-panel" data-placeholder="(all repos)" data-no-matches="No matching repos"></div>
          </div>
        </div>
        <div class="filters-section filters-mode-compare">
          <div class="filters-section-title">Compare</div>
          <div class="toggle-row">
            <label><input id="compareIncludeNoEffect" type="checkbox" /> show no-effect rows</label>
          </div>
        </div>
        <div class="filters-section filters-mode-inspect">
          <div class="filters-section-title">Inspect</div>
          <div class="toggle-row">
            <label><input id="inspectStaged" type="checkbox" /> staged</label>
            <label><input id="inspectUnstaged" type="checkbox" /> unstaged</label>
            <label><input id="inspectUntracked" type="checkbox" /> untracked</label>
            <label><input id="inspectAllRepos" type="checkbox" /> all repos</label>
          </div>
        </div>
        <div class="filters-section filters-mode-browse">
          <div class="filters-section-title">Browse</div>
          <div class="toggle-row">
            <label><input id="browseStaged" type="checkbox" /> staged</label>
            <label><input id="browseUnstaged" type="checkbox" /> unstaged</label>
            <label><input id="browseUntracked" type="checkbox" /> untracked</label>
            <label><input id="browseSubmodules" type="checkbox" /> submodules</label>
            <label><input id="browseAllRepos" type="checkbox" /> all repos</label>
          </div>
        </div>
      </div>
      <div class="filters-footer">
        <button id="filtersReset" type="button" class="button-secondary">Reset to defaults</button>
        <div class="filters-footer-actions">
          <button id="filtersDone" type="button" class="button-secondary">Done</button>
        </div>
      </div>
    </div>
  </div>
  <div id="createSnapshotDialog" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="createSnapshotTitle">
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="createSnapshotTitle" class="modal-title">Create Snapshot</h2>
        <p class="modal-subtitle">Capture the current working tree into a new snapshot, with an optional clear step afterward.</p>
      </div>
      <form id="createSnapshotForm" class="modal-form">
        <div class="modal-field">
          <label for="createSnapshotIdInput">Snapshot ID</label>
          <input id="createSnapshotIdInput" type="text" spellcheck="false" autocomplete="off" />
          <div class="modal-field-help">Edit the suggested id, or leave it blank to let git-snapshot create auto-generate one.</div>
        </div>
        <label class="modal-checkbox">
          <input id="createSnapshotClear" type="checkbox" />
          <span>Clear the captured working tree after snapshot creation (--clear)</span>
        </label>
        <div id="createSnapshotStatus" class="modal-status" aria-live="polite"></div>
        <div class="modal-actions">
          <button id="createSnapshotCancel" type="button" class="secondary">Cancel</button>
          <button id="createSnapshotSubmit" type="submit">Create Snapshot</button>
        </div>
      </form>
    </div>
  </div>
  <div id="resetAllDialog" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="resetAllTitle">
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="resetAllTitle" class="modal-title">Reset All</h2>
        <p class="modal-subtitle">Choose how to run the reset before we ask for final confirmation.</p>
      </div>
      <form id="resetAllForm" class="modal-form">
        <label class="modal-checkbox">
          <input id="resetAllSnapshot" type="checkbox" checked />
          <span>Create an auto snapshot before reset (--snapshot)</span>
        </label>
        <div class="modal-field-help">Turn this off to run the reset without a pre-clear snapshot (--no-snapshot).</div>
        <div id="resetAllStatus" class="modal-status" aria-live="polite"></div>
        <div class="modal-actions">
          <button id="resetAllCancel" type="button" class="secondary">Cancel</button>
          <button id="resetAllContinue" type="submit">Continue</button>
        </div>
      </form>
    </div>
  </div>
  <div id="resetAllConfirmDialog" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="resetAllConfirmTitle">
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="resetAllConfirmTitle" class="modal-title">Confirm Reset All</h2>
        <p class="modal-subtitle">This will discard the current live working-tree changes for this root repo.</p>
      </div>
      <div class="modal-form">
        <div id="resetAllConfirmMessage" class="modal-field-help"></div>
        <div id="resetAllConfirmStatus" class="modal-status" aria-live="polite"></div>
        <div class="modal-actions">
          <button id="resetAllConfirmCancel" type="button" class="secondary">No</button>
          <button id="resetAllConfirmSubmit" type="button" class="danger">Yes, Reset All</button>
        </div>
      </div>
    </div>
  </div>
  <div id="renameSnapshotDialog" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="renameSnapshotTitle">
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="renameSnapshotTitle" class="modal-title">Rename Snapshot</h2>
        <p id="renameSnapshotSubtitle" class="modal-subtitle">Choose a new snapshot id. The snapshot contents stay the same.</p>
      </div>
      <form id="renameSnapshotForm" class="modal-form">
        <div class="modal-field">
          <label for="renameSnapshotInput">New Snapshot ID</label>
          <input id="renameSnapshotInput" type="text" spellcheck="false" autocomplete="off" />
          <div id="renameSnapshotMeta" class="modal-field-help"></div>
        </div>
        <div id="renameSnapshotStatus" class="modal-status" aria-live="polite"></div>
        <div class="modal-actions">
          <button id="renameSnapshotCancel" type="button" class="secondary">Cancel</button>
          <button id="renameSnapshotSubmit" type="submit">Rename Snapshot</button>
        </div>
      </form>
    </div>
  </div>
  <div id="deleteSnapshotDialog" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="deleteSnapshotTitle">
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="deleteSnapshotTitle" class="modal-title">Delete Snapshot</h2>
        <p id="deleteSnapshotSubtitle" class="modal-subtitle">This removes the snapshot and its cached compare materializations.</p>
      </div>
      <div class="modal-form">
        <div id="deleteSnapshotMessage" class="modal-field-help"></div>
        <div id="deleteSnapshotStatus" class="modal-status" aria-live="polite"></div>
        <div class="modal-actions">
          <button id="deleteSnapshotCancel" type="button" class="secondary">No</button>
          <button id="deleteSnapshotConfirm" type="button" class="danger">Yes, Delete Snapshot</button>
        </div>
      </div>
    </div>
  </div>
  <div id="saveReviewPresetDialog" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="saveReviewPresetTitle">
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="saveReviewPresetTitle" class="modal-title">Save Review Preset</h2>
        <p class="modal-subtitle">Save the current ordered review repo selection under a reusable name.</p>
      </div>
      <form id="saveReviewPresetForm" class="modal-form">
        <div class="modal-field">
          <label for="saveReviewPresetInput">Preset Name</label>
          <input id="saveReviewPresetInput" type="text" spellcheck="false" autocomplete="off" />
          <div id="saveReviewPresetMeta" class="modal-field-help">Saving to an existing preset name replaces that preset's repos and review-base settings in place.</div>
        </div>
        <div id="saveReviewPresetStatus" class="modal-status" aria-live="polite"></div>
        <div class="modal-actions">
          <button id="saveReviewPresetCancel" type="button" class="secondary">Cancel</button>
          <button id="saveReviewPresetSubmit" type="submit">Save Preset</button>
        </div>
      </form>
    </div>
  </div>
  <div id="renameReviewPresetDialog" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="renameReviewPresetTitle">
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="renameReviewPresetTitle" class="modal-title">Rename Review Preset</h2>
        <p class="modal-subtitle">Change the preset name without changing its repo order.</p>
      </div>
      <form id="renameReviewPresetForm" class="modal-form">
        <div class="modal-field">
          <label for="renameReviewPresetInput">New Preset Name</label>
          <input id="renameReviewPresetInput" type="text" spellcheck="false" autocomplete="off" />
          <div id="renameReviewPresetMeta" class="modal-field-help"></div>
        </div>
        <div id="renameReviewPresetStatus" class="modal-status" aria-live="polite"></div>
        <div class="modal-actions">
          <button id="renameReviewPresetCancel" type="button" class="secondary">Cancel</button>
          <button id="renameReviewPresetSubmit" type="submit">Rename Preset</button>
        </div>
      </form>
    </div>
  </div>
  <div id="deleteReviewPresetDialog" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="deleteReviewPresetTitle">
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="deleteReviewPresetTitle" class="modal-title">Delete Review Preset</h2>
        <p class="modal-subtitle">This removes the saved preset name, but leaves the current review selection untouched.</p>
      </div>
      <div class="modal-form">
        <div id="deleteReviewPresetMessage" class="modal-field-help"></div>
        <div id="deleteReviewPresetStatus" class="modal-status" aria-live="polite"></div>
        <div class="modal-actions">
          <button id="deleteReviewPresetCancel" type="button" class="secondary">Cancel</button>
          <button id="deleteReviewPresetConfirm" type="button" class="danger">Delete Preset</button>
        </div>
      </div>
    </div>
  </div>
  <div id="askPromptDialog" class="modal-backdrop hidden" role="dialog" aria-modal="true" aria-labelledby="askPromptTitle">
    <div class="modal-card">
      <div class="modal-header">
        <h2 id="askPromptTitle" class="modal-title">Ask</h2>
        <p class="modal-subtitle">Build a reusable prompt from the selected diff text.</p>
      </div>
      <form id="askPromptForm" class="modal-form">
        <div class="modal-field">
          <label for="askPromptHistory">Recent instructions</label>
          <div class="ask-prompt-history-picker-wrap">
            <select id="askPromptHistory" class="visually-hidden">
              <option value="">Choose a recent instruction…</option>
            </select>
            <div
              id="askPromptHistoryPicker"
              class="filterable-select filterable-select-panel ask-prompt-history-picker"
              data-placeholder="Choose a recent instruction…"
              data-no-matches="No saved instructions"
            ></div>
          </div>
          <div class="modal-field-help">Selecting a saved instruction copies the generated prompt immediately. Each saved instruction can be removed directly from the dropdown without confirmation.</div>
        </div>
        <div class="modal-field">
          <label for="askPromptInstruction">Instruction</label>
          <textarea id="askPromptInstruction" rows="4" spellcheck="false"></textarea>
        </div>
        <div class="modal-field">
          <label for="askPromptSelection">Selected text</label>
          <pre id="askPromptSelection" class="ask-selection-preview"></pre>
        </div>
        <div id="askPromptStatus" class="modal-status" aria-live="polite"></div>
        <div class="modal-actions">
          <button id="askPromptCancel" type="button" class="secondary">Cancel</button>
          <button id="askPromptCopy" type="submit">Copy Prompt</button>
        </div>
      </form>
    </div>
  </div>
  <div id="main" class="main">
    <div id="list" class="left" role="group" aria-label="Compare rows"></div>
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
      <div id="previewControls" class="preview-controls hidden">
        <div id="previewControlsMeta" class="preview-controls-meta"></div>
        <div class="preview-mode-toggle" role="tablist" aria-label="Preview mode">
          <button id="previewCurrentButton" type="button" class="preview-mode-button active" role="tab" aria-selected="true">Current</button>
          <button id="previewSinceViewedButton" type="button" class="preview-mode-button" role="tab" aria-selected="false">Since viewed</button>
        </div>
      </div>
      <div class="preview-panel"><div id="diff" class="diff-view loading">Loading…</div></div>
    </div>
  </div>
  <div id="statusStrip" class="status-strip" role="status" aria-live="polite">
    <div class="status-strip-main">
      <span class="status-strip-label">Root</span>
      <button
        id="rootRepoChip"
        type="button"
        class="button-secondary root-repo-chip"
        title=""
        aria-label=""
      >
        <span id="rootRepoChipText" class="root-repo-chip-text"></span>
      </button>
    </div>
    <div class="status-strip-server">
      <span class="status-strip-label">Server</span>
      <span id="serverStatusChip" class="list-pill server-status-chip connected" title="">server connected</span>
    </div>
  </div>
  <div id="rowContextMenu" class="row-context-menu hidden" role="menu" aria-label="Row actions"></div>
  <div id="diffSelectionContextMenu" class="row-context-menu hidden" role="menu" aria-label="Selected text actions"></div>
  <div id="clientToast" class="client-toast hidden" role="status" aria-live="polite"></div>
  <script>
    ${SHARED_BROWSER_HELPERS_BUNDLE_SOURCE}
    const sharedBrowserHelpers = globalThis.__gitSnapshotCompareGuiShared || {};
    const buildAskPromptTextShared = sharedBrowserHelpers.buildAskPromptTextShared;
    const buildRowIdentityKeyShared = sharedBrowserHelpers.buildRowIdentityKeyShared;
    const buildSelectionIdentityKeyShared = sharedBrowserHelpers.buildSelectionIdentityKeyShared;
    const normalizeSelectedKindShared = sharedBrowserHelpers.normalizeSelectedKindShared;
    const normalizeLineBreaksShared = sharedBrowserHelpers.normalizeLineBreaksShared;
    const buildSelectionFallbackSequenceShared = sharedBrowserHelpers.buildSelectionFallbackSequenceShared;
    const buildPreviewSelectionGroupsFromCollections = sharedBrowserHelpers.buildPreviewSelectionGroupsFromCollections;
    const structuredDiffSelectionTextFromContainerShared = sharedBrowserHelpers.structuredDiffSelectionTextFromContainerShared;
    const initialViewState = ${initialStateJson};
    const ROOT_REPO_PHYSICAL_PATH = ${rootRepoPhysicalJson};
    globalThis.__gitSnapshotRootRepoPhysicalPath = ROOT_REPO_PHYSICAL_PATH;
    const initialCompareBaseExplicit = ${compareBaseExplicit ? "true" : "false"};
    const initialConfiguredCompareBase = ${initialConfiguredCompareBase};
    const initialConfiguredSnapshotShowAuto = ${initialConfiguredSnapshotShowAuto ? "true" : "false"};
    const COMPARE_GENERIC_REASONS = ${JSON.stringify(COMPARE_GENERIC_REASONS)};
    const mainEl = document.getElementById("main");
    const listEl = document.getElementById("list");
    const splitterEl = document.getElementById("splitter");
    const diffEl = document.getElementById("diff");
    const metaEl = document.getElementById("meta");
    const summaryEl = document.getElementById("summary");
    const refreshSplit = document.getElementById("refreshSplit");
    const refreshBtn = document.getElementById("refresh");
    const refreshMenuButton = document.getElementById("refreshMenuButton");
    const refreshMenu = document.getElementById("refreshMenu");
    const refreshMenuCopyPrimary = document.getElementById("refreshMenuCopyPrimary");
    const refreshMenuCopySecondary = document.getElementById("refreshMenuCopySecondary");
    const hardRefreshBtn = document.getElementById("hardRefresh");
    const viewedActions = document.getElementById("viewedActions");
    const viewedActionsButton = document.getElementById("viewedActionsButton");
    const viewedActionsMenu = document.getElementById("viewedActionsMenu");
    const clearViewedModeBtn = document.getElementById("clearViewedMode");
    const clearViewedAllBtn = document.getElementById("clearViewedAll");
    const openBtn = document.getElementById("openExternal");
    const rootRepoChip = document.getElementById("rootRepoChip");
    const rootRepoChipText = document.getElementById("rootRepoChipText");
    const serverStatusChip = document.getElementById("serverStatusChip");
    const modeSelect = document.getElementById("modeSelect");
    const modePickerEl = document.getElementById("modePicker");
    const snapshotSelect = document.getElementById("snapshotSelect");
    const reviewRepoSelect = document.getElementById("reviewRepoSelect");
    const reviewRepoPickerEl = document.getElementById("reviewRepoPicker");
    const reviewBaseSelect = document.getElementById("reviewBaseSelect");
    const reviewBasePickerEl = document.getElementById("reviewBasePicker");
    const reviewPresetSelect = document.getElementById("reviewPresetSelect");
    const reviewPresetPickerEl = document.getElementById("reviewPresetPicker");
    const reviewPresetActions = document.getElementById("reviewPresetActions");
    const reviewPresetActionsButton = document.getElementById("reviewPresetActionsButton");
    const reviewPresetActionsMenu = document.getElementById("reviewPresetActionsMenu");
    const reviewPresetSaveBtn = document.getElementById("reviewPresetSave");
    const reviewPresetRenameBtn = document.getElementById("reviewPresetRename");
    const reviewPresetDeleteBtn = document.getElementById("reviewPresetDelete");
    const reviewSelectionSummaryEl = document.getElementById("reviewSelectionSummary");
    const reviewSelectionMetaEl = document.getElementById("reviewSelectionMeta");
    const reviewSelectionToggleBtn = document.getElementById("reviewSelectionToggle");
    const reviewSelectedTrayEl = document.getElementById("reviewSelectedTray");
    const reviewSelectedReposEl = document.getElementById("reviewSelectedRepos");
    const snapshotPickerButton = document.getElementById("snapshotPickerButton");
    const snapshotPickerPrimary = document.getElementById("snapshotPickerPrimary");
    const snapshotOverlay = document.getElementById("snapshotOverlay");
    const snapshotPanel = document.getElementById("snapshotPanel");
    const snapshotShowAutoCheckbox = document.getElementById("snapshotShowAuto");
    const snapshotListEl = document.getElementById("snapshotList");
    const snapshotEmptyEl = document.getElementById("snapshotEmpty");
    const filtersButton = document.getElementById("filtersButton");
    const filtersOverlay = document.getElementById("filtersOverlay");
    const filtersPanel = document.getElementById("filtersPanel");
    const filtersSubtitle = document.getElementById("filtersSubtitle");
    const repoFilterSelect = document.getElementById("repoFilter");
    const repoFilterPickerEl = document.getElementById("repoFilterPicker");
    const compareIncludeNoEffect = document.getElementById("compareIncludeNoEffect");
    const compareBaseWorkingTree = document.getElementById("compareBaseWorkingTree");
    const compareBaseSnapshot = document.getElementById("compareBaseSnapshot");
    const inspectStaged = document.getElementById("inspectStaged");
    const inspectUnstaged = document.getElementById("inspectUnstaged");
    const inspectUntracked = document.getElementById("inspectUntracked");
    const inspectAllRepos = document.getElementById("inspectAllRepos");
    const browseStaged = document.getElementById("browseStaged");
    const browseUnstaged = document.getElementById("browseUnstaged");
    const browseUntracked = document.getElementById("browseUntracked");
    const browseSubmodules = document.getElementById("browseSubmodules");
    const browseAllRepos = document.getElementById("browseAllRepos");
    const filtersResetBtn = document.getElementById("filtersReset");
    const filtersDoneBtn = document.getElementById("filtersDone");
    const createSnapshotBtn = document.getElementById("createSnapshot");
    const resetAllBtn = document.getElementById("resetAll");
    const createSnapshotDialog = document.getElementById("createSnapshotDialog");
    const createSnapshotForm = document.getElementById("createSnapshotForm");
    const createSnapshotIdInput = document.getElementById("createSnapshotIdInput");
    const createSnapshotClearCheckbox = document.getElementById("createSnapshotClear");
    const createSnapshotStatus = document.getElementById("createSnapshotStatus");
    const createSnapshotCancelBtn = document.getElementById("createSnapshotCancel");
    const createSnapshotSubmitBtn = document.getElementById("createSnapshotSubmit");
    const resetAllDialog = document.getElementById("resetAllDialog");
    const resetAllForm = document.getElementById("resetAllForm");
    const resetAllSnapshotCheckbox = document.getElementById("resetAllSnapshot");
    const resetAllStatus = document.getElementById("resetAllStatus");
    const resetAllCancelBtn = document.getElementById("resetAllCancel");
    const resetAllContinueBtn = document.getElementById("resetAllContinue");
    const resetAllConfirmDialog = document.getElementById("resetAllConfirmDialog");
    const resetAllConfirmMessage = document.getElementById("resetAllConfirmMessage");
    const resetAllConfirmStatus = document.getElementById("resetAllConfirmStatus");
    const resetAllConfirmCancelBtn = document.getElementById("resetAllConfirmCancel");
    const resetAllConfirmSubmitBtn = document.getElementById("resetAllConfirmSubmit");
    const renameSnapshotDialog = document.getElementById("renameSnapshotDialog");
    const renameSnapshotForm = document.getElementById("renameSnapshotForm");
    const renameSnapshotInput = document.getElementById("renameSnapshotInput");
    const renameSnapshotMeta = document.getElementById("renameSnapshotMeta");
    const renameSnapshotStatus = document.getElementById("renameSnapshotStatus");
    const renameSnapshotCancelBtn = document.getElementById("renameSnapshotCancel");
    const renameSnapshotSubmitBtn = document.getElementById("renameSnapshotSubmit");
    const deleteSnapshotDialog = document.getElementById("deleteSnapshotDialog");
    const deleteSnapshotMessage = document.getElementById("deleteSnapshotMessage");
    const deleteSnapshotStatus = document.getElementById("deleteSnapshotStatus");
    const deleteSnapshotCancelBtn = document.getElementById("deleteSnapshotCancel");
    const deleteSnapshotConfirmBtn = document.getElementById("deleteSnapshotConfirm");
    const saveReviewPresetDialog = document.getElementById("saveReviewPresetDialog");
    const saveReviewPresetForm = document.getElementById("saveReviewPresetForm");
    const saveReviewPresetInput = document.getElementById("saveReviewPresetInput");
    const saveReviewPresetMeta = document.getElementById("saveReviewPresetMeta");
    const saveReviewPresetStatus = document.getElementById("saveReviewPresetStatus");
    const saveReviewPresetCancelBtn = document.getElementById("saveReviewPresetCancel");
    const saveReviewPresetSubmitBtn = document.getElementById("saveReviewPresetSubmit");
    const renameReviewPresetDialog = document.getElementById("renameReviewPresetDialog");
    const renameReviewPresetForm = document.getElementById("renameReviewPresetForm");
    const renameReviewPresetInput = document.getElementById("renameReviewPresetInput");
    const renameReviewPresetMeta = document.getElementById("renameReviewPresetMeta");
    const renameReviewPresetStatus = document.getElementById("renameReviewPresetStatus");
    const renameReviewPresetCancelBtn = document.getElementById("renameReviewPresetCancel");
    const renameReviewPresetSubmitBtn = document.getElementById("renameReviewPresetSubmit");
    const deleteReviewPresetDialog = document.getElementById("deleteReviewPresetDialog");
    const deleteReviewPresetMessage = document.getElementById("deleteReviewPresetMessage");
    const deleteReviewPresetStatus = document.getElementById("deleteReviewPresetStatus");
    const deleteReviewPresetCancelBtn = document.getElementById("deleteReviewPresetCancel");
    const deleteReviewPresetConfirmBtn = document.getElementById("deleteReviewPresetConfirm");
    const inspectSummaryPanel = document.getElementById("inspectSummaryPanel");
    const inspectSummaryBody = document.getElementById("inspectSummaryBody");
    const previewControls = document.getElementById("previewControls");
    const previewControlsMeta = document.getElementById("previewControlsMeta");
    const previewCurrentButton = document.getElementById("previewCurrentButton");
    const previewSinceViewedButton = document.getElementById("previewSinceViewedButton");
    const previewPanelEl = document.querySelector(".preview-panel");
    const rowContextMenu = document.getElementById("rowContextMenu");
    const diffSelectionContextMenu = document.getElementById("diffSelectionContextMenu");
    const askPromptDialog = document.getElementById("askPromptDialog");
    const askPromptForm = document.getElementById("askPromptForm");
    const askPromptHistory = document.getElementById("askPromptHistory");
    const askPromptHistoryPickerEl = document.getElementById("askPromptHistoryPicker");
    const askPromptInstruction = document.getElementById("askPromptInstruction");
    const askPromptSelection = document.getElementById("askPromptSelection");
    const askPromptStatus = document.getElementById("askPromptStatus");
    const askPromptCancelBtn = document.getElementById("askPromptCancel");
    const askPromptCopyBtn = document.getElementById("askPromptCopy");
    const clientToast = document.getElementById("clientToast");
    const splitLayoutMedia = window.matchMedia("(max-width: 700px)");
    const SPLIT_STORAGE_KEY = "git-snapshot.gui.split.left-ratio.v1";
    const COMPARE_BASE_STORAGE_KEY = ${JSON.stringify(COMPARE_BASE_STORAGE_KEY)};
    const SNAPSHOT_SHOW_AUTO_STORAGE_KEY = "git-snapshot.gui.snapshots.show-auto.v1";
    const ASK_HISTORY_STORAGE_KEY = "git-snapshot.gui.ask.history.v1";
    const ASK_HISTORY_LIMIT = 8;
    const DEFAULT_SPLIT_RATIO = 0.39;
    const MIN_SPLIT_RATIO = 0.24;
    const MAX_SPLIT_RATIO = 0.76;
    const SPLITTER_WIDTH_PX = 12;
    const REFRESH_STATE_POLL_VISIBLE_MS = ${JSON.stringify(CLIENT_REFRESH_STATE_POLL_VISIBLE_MS)};
    const REFRESH_STATE_POLL_HIDDEN_MS = ${JSON.stringify(CLIENT_REFRESH_STATE_POLL_HIDDEN_MS)};
    const REFRESH_STATE_HINT_TEXT = ${JSON.stringify(LIVE_REFRESH_HINT_TEXT)};
    const REFRESH_STATE_PREPARING_TEXT = ${JSON.stringify(LIVE_REFRESH_PREPARING_TEXT)};
    const DIFF_SELECTION_DEBUG_EVENT_LIMIT = 24;
    const DIFF_SELECTION_SYNC_DELAY_MS = 40;
    const DIFF_SELECTION_SLOW_CAPTURE_MS = 24;
    const BACKSLASH = String.fromCharCode(92);
    const BACKTICK_CHAR = String.fromCharCode(96);
    const DOUBLE_QUOTE = String.fromCharCode(34);
    const CARRIAGE_RETURN_CHAR = String.fromCharCode(13);
    const TAB_CHAR = String.fromCharCode(9);
    const NEWLINE_CHAR = String.fromCharCode(10);
    const VIEW_STATE_UNVIEWED = ${JSON.stringify(VIEW_STATE_UNVIEWED)};
    const VIEW_STATE_VIEWED = ${JSON.stringify(VIEW_STATE_VIEWED)};
    const VIEW_STATE_CHANGED = ${JSON.stringify(VIEW_STATE_CHANGED)};
    const PREVIEW_VARIANT_CURRENT = ${JSON.stringify(PREVIEW_VARIANT_CURRENT)};
    const PREVIEW_VARIANT_SINCE_VIEWED = ${JSON.stringify(PREVIEW_VARIANT_SINCE_VIEWED)};
    const VIEWED_BULK_CONFIRM_ROWS = ${JSON.stringify(VIEWED_BULK_CONFIRM_ROWS)};
    const VIEWED_TELEMETRY_ENABLED = ${JSON.stringify(process.env[VIEWED_TELEMETRY_ENV] === "1")};
    const DEFAULT_ASK_TEMPLATE_ID = "explain";
    const ASK_TEMPLATE_REGISTRY = [{
      id: "explain",
      label: "Ask",
      defaultInstruction: "Explain this selected text.",
    }];
    let rootRepoCopiedResetTimer = null;
    let clientToastTimer = null;
    let activeFilterableSelect = null;
    let askPromptHistoryPicker = null;
    let modePicker = null;
    let reviewRepoPicker = null;
    let reviewBasePicker = null;
    let reviewPresetPicker = null;
    let repoFilterPicker = null;
    let draggedReviewRepo = "";
    let reviewSelectionTrayOpen = false;
    let askPromptDialogState = null;
    let currentDiffSelectionSnapshot = null;
    let diffSelectionSyncTimer = null;

    function normalizeStringListClient(values) {
      return uniqueStrings((Array.isArray(values) ? values : []).map((value) => String(value || "")).filter(Boolean));
    }

    function normalizeReviewBaseRefClient(value, fallback) {
      const normalized = String(value == null ? "" : value).trim();
      if (normalized) {
        return normalized;
      }
      return String(fallback || "master").trim() || "master";
    }

    function normalizeReviewRepoBaseOverridesClient(rawOverrides, selectedRepos, defaultBaseRef) {
      const hasSelectionConstraint = Array.isArray(selectedRepos);
      const normalizedSelectedRepos = new Set(normalizeStringListClient(selectedRepos));
      const normalizedDefaultBase = normalizeReviewBaseRefClient(defaultBaseRef, "master");
      const source = rawOverrides && typeof rawOverrides === "object" && !Array.isArray(rawOverrides)
        ? rawOverrides
        : {};
      const overrides = {};
      for (const rawRepo of Object.keys(source).sort()) {
        const rawRef = source[rawRepo];
        const repo = String(rawRepo || "").trim();
        const ref = String(rawRef || "").trim();
        if (!repo || !ref || (hasSelectionConstraint && !normalizedSelectedRepos.has(repo)) || ref === normalizedDefaultBase) {
          continue;
        }
        overrides[repo] = ref;
      }
      return overrides;
    }

    function encodeReviewReposForUrlClient(values) {
      const repos = normalizeStringListClient(values);
      return repos.length ? JSON.stringify(repos) : "";
    }

    function encodeReviewRepoBasesForUrlClient(values, selectedRepos, defaultBaseRef) {
      const overrides = normalizeReviewRepoBaseOverridesClient(values, selectedRepos, defaultBaseRef);
      const keys = Object.keys(overrides).sort();
      if (!keys.length) {
        return "";
      }
      const encoded = {};
      for (const key of keys) {
        encoded[key] = overrides[key];
      }
      return JSON.stringify(encoded);
    }

    function compactRootRepoPathClient(fullPath) {
      const text = String(fullPath || "");
      if (!text) return "(unknown)";
      const parts = text.split("/").filter(Boolean);
      if (!parts.length) {
        return text;
      }
      const tail = parts.slice(-2);
      if (tail.length > 1) {
        return tail.join("/");
      }
      const leaf = tail[0] || parts[parts.length - 1];
      if (leaf) {
        return leaf;
      }
      return text;
    }

    function rootRepoChipTitleClient(copied) {
      const fullPath = String(ROOT_REPO_PHYSICAL_PATH || "");
      if (!fullPath) {
        return "Root repository path unavailable.";
      }
      return "Root repository (physical path)" +
        NEWLINE_CHAR +
        fullPath +
        NEWLINE_CHAR +
        (copied ? "Copied." : "Click to copy.");
    }

    function documentTitleRootLabelClient() {
      return compactRootRepoPathClient(ROOT_REPO_PHYSICAL_PATH);
    }

    function syncRootRepoChipClient(copied) {
      if (!rootRepoChip || !rootRepoChipText) {
        return;
      }
      const fullPath = String(ROOT_REPO_PHYSICAL_PATH || "");
      rootRepoChip.dataset.fullPath = fullPath;
      rootRepoChipText.textContent = compactRootRepoPathClient(fullPath);
      const title = rootRepoChipTitleClient(Boolean(copied));
      rootRepoChip.title = title;
      rootRepoChip.setAttribute("aria-label", title);
    }

    function currentServerStatusClient() {
      if (serverConnectionState === "disconnected") {
        return {
          tone: "disconnected",
          text: "server disconnected",
          title: "The GUI cannot currently reach the local git-snapshot server.",
        };
      }
      if (softRefreshAppliesToViewClient(currentViewState) && refreshViewStatus === "preparing") {
        return {
          tone: "preparing",
          text: "server preparing",
          title: "The server is connected and preparing updated live data.",
        };
      }
      if (softRefreshAppliesToViewClient(currentViewState) && refreshViewStatus === "stale") {
        return {
          tone: "stale",
          text: "refresh available",
          title: refreshHintMessage || REFRESH_STATE_HINT_TEXT,
        };
      }
      if (serverConnectionState === "connecting") {
        return {
          tone: "preparing",
          text: "server connecting",
          title: "Connecting to the local git-snapshot server.",
        };
      }
      return {
        tone: "connected",
        text: "server connected",
        title: "The GUI is connected to the local git-snapshot server.",
      };
    }

    function syncServerStatusChipClient() {
      if (!serverStatusChip) {
        return;
      }
      const status = currentServerStatusClient();
      serverStatusChip.className = "list-pill server-status-chip " + status.tone;
      serverStatusChip.textContent = status.text;
      serverStatusChip.title = status.title;
      serverStatusChip.setAttribute("aria-label", status.title);
    }

    function markServerConnectionSuccess() {
      serverConnectionFailureCount = 0;
      serverConnectionState = "connected";
      syncServerStatusChipClient();
    }

    function recordServerConnectionFailure(threshold = 2) {
      serverConnectionFailureCount += 1;
      if (serverConnectionFailureCount >= threshold) {
        serverConnectionState = "disconnected";
      }
      syncServerStatusChipClient();
    }

    async function copyTextToClipboardClient(text, options) {
      const value = String(text || "");
      if (!value) return false;
      const copyOptions = options && typeof options === "object" ? options : {};
      const copyContext = String(copyOptions.context || "clipboard").trim() || "clipboard";
      let navigatorClipboardError = null;
      let execCommandError = null;
      try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
          await navigator.clipboard.writeText(value);
          return true;
        }
      } catch (error) {
        navigatorClipboardError = error;
        // Fall through to the DOM-based fallback below.
      }

      const probe = document.createElement("textarea");
      probe.value = value;
      probe.setAttribute("readonly", "readonly");
      probe.style.position = "fixed";
      probe.style.opacity = "0";
      probe.style.left = "-9999px";
      document.body.appendChild(probe);
      probe.focus();
      probe.select();
      let copied = false;
      try {
        copied = document.execCommand("copy");
      } catch (error) {
        execCommandError = error;
        copied = false;
      }
      document.body.removeChild(probe);
      if (!copied) {
        recordDiffSelectionDebugEvent("clipboard-failure", {
          context: copyContext,
          textLength: value.length,
          navigatorMessage: navigatorClipboardError ? String(navigatorClipboardError.message || navigatorClipboardError) : "",
          fallbackMessage: execCommandError ? String(execCommandError.message || execCommandError) : "",
        });
      }
      return copied;
    }

    async function handleRootRepoChipClickClient() {
      const fullPath = String(ROOT_REPO_PHYSICAL_PATH || "");
      if (!fullPath) {
        return;
      }
      const copied = await copyTextToClipboardClient(fullPath);
      syncRootRepoChipClient(copied);
      if (rootRepoCopiedResetTimer) {
        window.clearTimeout(rootRepoCopiedResetTimer);
        rootRepoCopiedResetTimer = null;
      }
      if (copied) {
        rootRepoCopiedResetTimer = window.setTimeout(() => {
          rootRepoCopiedResetTimer = null;
          syncRootRepoChipClient(false);
        }, 1600);
      }
    }

    function normalizeCompareBaseClient(value) {
      return String(value || "") === "snapshot" ? "snapshot" : "working-tree";
    }

    function compareBaseDisplayLabelClient(compareBase) {
      return normalizeCompareBaseClient(compareBase) === "snapshot" ? "snapshot" : "working tree";
    }

    function compareBaseContextLabelClient(compareBase) {
      return normalizeCompareBaseClient(compareBase) === "snapshot" ? "base snapshot" : "base working tree";
    }

    function softRefreshAppliesToViewClient(viewState) {
      const mode = String((viewState && viewState.mode) || "");
      return mode === "browse" || mode === "compare";
    }

    function hardRefreshAppliesToViewClient(viewState) {
      const mode = String((viewState && viewState.mode) || "");
      return mode === "compare" || mode === "inspect";
    }

    function modeDisplayLabelClient(mode) {
      const normalizedMode = String(mode || "");
      if (normalizedMode === "compare") {
        return "Snapshot compare";
      }
      if (normalizedMode === "browse") {
        return "Browse";
      }
      if (normalizedMode === "inspect") {
        return "Inspect";
      }
      if (normalizedMode === "review") {
        return "Review";
      }
      return normalizedMode || "Mode";
    }

    function renderModePickerOptionContent(node, option) {
      node.classList.add("mode-picker-option");
      node.innerHTML = "";
      const main = document.createElement("span");
      main.className = "mode-picker-option-main";
      const title = document.createElement("span");
      title.className = "mode-picker-option-title";
      title.textContent = option && option.label ? option.label : "";
      const description = document.createElement("span");
      description.className = "mode-picker-option-description";
      description.textContent = option && option.description ? option.description : "";
      main.append(title, description);
      node.appendChild(main);
      if (option && option.helpText) {
        const help = document.createElement("span");
        help.className = "mode-picker-help";
        help.textContent = "?";
        help.title = option.helpText;
        help.setAttribute("aria-label", option.helpText);
        node.appendChild(help);
      }
    }

    function syncModePickerState() {
      if (modePicker) {
        modePicker.syncFromSelect();
      }
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

    function padTwoDigitsClient(value) {
      return String(value).padStart(2, "0");
    }

    function numericSnapshotSortValueClient(rawValue) {
      const parsed = Number(rawValue);
      return Number.isFinite(parsed) ? parsed : -1;
    }

    function snapshotCreatedAtEpochValueClient(snapshot) {
      return numericSnapshotSortValueClient(snapshot && snapshot.created_at_epoch);
    }

    function snapshotSortMtimeMsValueClient(snapshot) {
      const sortMtime = numericSnapshotSortValueClient(snapshot && snapshot.sort_mtime_ms);
      if (sortMtime >= 0) {
        return sortMtime;
      }
      const createdAtEpoch = snapshotCreatedAtEpochValueClient(snapshot);
      return createdAtEpoch >= 0 ? createdAtEpoch * 1000 : -1;
    }

    function compareSnapshotsNewestFirstClient(leftSnapshot, rightSnapshot) {
      const mtimeDiff = snapshotSortMtimeMsValueClient(rightSnapshot) - snapshotSortMtimeMsValueClient(leftSnapshot);
      if (mtimeDiff !== 0) {
        return mtimeDiff;
      }

      const createdAtDiff = snapshotCreatedAtEpochValueClient(rightSnapshot) - snapshotCreatedAtEpochValueClient(leftSnapshot);
      if (createdAtDiff !== 0) {
        return createdAtDiff;
      }

      const leftId = String((leftSnapshot && leftSnapshot.id) || "");
      const rightId = String((rightSnapshot && rightSnapshot.id) || "");
      if (leftId === rightId) {
        return 0;
      }
      return leftId < rightId ? 1 : -1;
    }

    if (rootRepoChip) {
      rootRepoChip.addEventListener("click", () => {
        void handleRootRepoChipClickClient();
      });
    }

    function normalizeSnapshotsClient(rawSnapshots) {
      return (Array.isArray(rawSnapshots) ? rawSnapshots : [])
        .map((snapshot) => Object.assign({}, snapshot || {}, {
          id: String((snapshot && snapshot.id) || ""),
          created_at_epoch: String((snapshot && snapshot.created_at_epoch) || ""),
          repo_count: String((snapshot && snapshot.repo_count) || ""),
          root_repo: String((snapshot && snapshot.root_repo) || ""),
          origin: String((snapshot && snapshot.origin) || ""),
          sort_mtime_ms: String((snapshot && snapshot.sort_mtime_ms) || ""),
        }))
        .filter((snapshot) => snapshot.id)
        .sort(compareSnapshotsNewestFirstClient);
    }

    function formatSnapshotCreatedAtClient(snapshot) {
      const createdAtEpoch = snapshotCreatedAtEpochValueClient(snapshot);
      if (createdAtEpoch < 0) {
        return "creation time unavailable";
      }

      const date = new Date(createdAtEpoch * 1000);
      if (Number.isNaN(date.getTime())) {
        return "creation time unavailable";
      }

      return [
        date.getFullYear(),
        padTwoDigitsClient(date.getMonth() + 1),
        padTwoDigitsClient(date.getDate()),
      ].join("-") + " " + [
        padTwoDigitsClient(date.getHours()),
        padTwoDigitsClient(date.getMinutes()),
        padTwoDigitsClient(date.getSeconds()),
      ].join(":") + " local";
    }

    function snapshotRepoCountLabelClient(snapshot) {
      const repoCount = Math.max(0, Number(snapshot && snapshot.repo_count) || 0);
      return repoCount === 1 ? "1 repo" : String(repoCount) + " repos";
    }

    function snapshotMetaTextClient(snapshot) {
      if (!snapshot) {
        return "Create a snapshot in browse mode to start comparing or inspecting.";
      }
      const parts = ["Created " + formatSnapshotCreatedAtClient(snapshot), snapshotRepoCountLabelClient(snapshot)];
      if (snapshot.origin === "auto") {
        parts.push("auto");
      }
      return parts.join(" · ");
    }

    function findSnapshotById(snapshotId) {
      const targetId = String(snapshotId || "");
      return snapshots.find((snapshot) => snapshot.id === targetId) || null;
    }

    function selectedSnapshotIdValue() {
      return String(snapshotSelect.value || currentViewState.snapshotId || "");
    }

    function isAutoSnapshotClient(snapshot) {
      return Boolean(snapshot && snapshot.origin === "auto");
    }

    function selectedSnapshotIsAuto(snapshotId) {
      return isAutoSnapshotClient(findSnapshotById(snapshotId || selectedSnapshotIdValue()));
    }

    function selectAvailableSnapshotId(preferredSnapshotId) {
      const preferredId = String(preferredSnapshotId || "");
      if (preferredId && snapshots.some((snapshot) => snapshot.id === preferredId)) {
        return preferredId;
      }
      const currentId = String(currentViewState.snapshotId || "");
      if (currentId && snapshots.some((snapshot) => snapshot.id === currentId)) {
        return currentId;
      }
      return snapshots[0] && snapshots[0].id ? snapshots[0].id : "";
    }

    function loadStoredCompareBase(fallbackCompareBase) {
      try {
        const storedValue = window.localStorage.getItem(COMPARE_BASE_STORAGE_KEY);
        if (storedValue === null || storedValue === "") {
          return normalizeCompareBaseClient(fallbackCompareBase);
        }
        return normalizeCompareBaseClient(storedValue);
      } catch (_err) {
        return normalizeCompareBaseClient(fallbackCompareBase);
      }
    }

    function saveStoredCompareBase(compareBase) {
      try {
        window.localStorage.setItem(COMPARE_BASE_STORAGE_KEY, normalizeCompareBaseClient(compareBase));
      } catch (_err) {
        // Ignore localStorage failures; compare base should still work for this page load.
      }
    }

    function loadStoredSnapshotShowAuto(fallbackShowAuto) {
      try {
        const storedValue = window.localStorage.getItem(SNAPSHOT_SHOW_AUTO_STORAGE_KEY);
        if (storedValue === null) {
          return Boolean(fallbackShowAuto);
        }
        return storedValue === "true";
      } catch (_err) {
        return Boolean(fallbackShowAuto);
      }
    }

    function saveStoredSnapshotShowAuto(showAuto) {
      try {
        window.localStorage.setItem(SNAPSHOT_SHOW_AUTO_STORAGE_KEY, showAuto ? "true" : "false");
      } catch (_err) {
        // Ignore localStorage failures; the picker should still function for this page load.
      }
    }

    function showClientToast(message, kind) {
      if (!clientToast) {
        return;
      }
      clientToast.textContent = String(message || "");
      clientToast.classList.remove("hidden", "error");
      if (kind === "error") {
        clientToast.classList.add("error");
      }
      if (clientToastTimer) {
        window.clearTimeout(clientToastTimer);
        clientToastTimer = null;
      }
      clientToastTimer = window.setTimeout(() => {
        clientToastTimer = null;
        clientToast.classList.add("hidden");
        clientToast.classList.remove("error");
        clientToast.textContent = "";
      }, 1800);
    }

    function recordDiffSelectionDebugEvent(eventType, details) {
      const normalizedType = String(eventType || "").trim() || "event";
      const payload = details && typeof details === "object" ? details : {};
      const entry = Object.assign({
        event: normalizedType,
        at: new Date().toISOString(),
      }, payload);
      const debugState = globalThis.__gitSnapshotDiffSelectionDebug && typeof globalThis.__gitSnapshotDiffSelectionDebug === "object"
        ? globalThis.__gitSnapshotDiffSelectionDebug
        : { events: [] };
      const nextEvents = Array.isArray(debugState.events) ? debugState.events.slice(-(DIFF_SELECTION_DEBUG_EVENT_LIMIT - 1)) : [];
      nextEvents.push(entry);
      const nextState = Object.assign({}, debugState, {
        lastEvent: entry,
        events: nextEvents,
      });
      if (normalizedType === "clipboard-failure") {
        nextState.lastClipboardFailure = entry;
      }
      if (normalizedType === "selection-capture") {
        nextState.lastSelectionCapture = entry;
      }
      globalThis.__gitSnapshotDiffSelectionDebug = nextState;
      if (normalizedType === "clipboard-failure") {
        console.warn("[diff-selection] clipboard failure", entry);
      }
      if (normalizedType === "selection-capture" && entry.slow) {
        console.warn("[diff-selection] slow selection capture", entry);
      }
      return entry;
    }

    function runGuardedUiAction(actionFn, options) {
      const actionOptions = options && typeof options === "object" ? options : {};
      return Promise.resolve()
        .then(() => typeof actionFn === "function" ? actionFn() : null)
        .catch((err) => {
          const message = String(
            (err && err.message)
            || err
            || actionOptions.fallbackMessage
            || "Action failed."
          );
          if (actionOptions.errorDisplay === "toast") {
            showClientToast(message, "error");
          } else {
            alert(message);
          }
          return null;
        });
    }

    function normalizeAskHistoryInstruction(value) {
      return String(value || "")
        .split(CARRIAGE_RETURN_CHAR + NEWLINE_CHAR).join(NEWLINE_CHAR)
        .split(CARRIAGE_RETURN_CHAR).join(NEWLINE_CHAR)
        .trim();
    }

    function loadStoredAskHistoryDocument() {
      try {
        const raw = window.localStorage.getItem(ASK_HISTORY_STORAGE_KEY);
        if (!raw) {
          return { roots: {} };
        }
        const parsed = JSON.parse(raw);
        const roots = parsed && parsed.roots && typeof parsed.roots === "object" ? parsed.roots : {};
        const normalizedRoots = {};
        for (const [rootPath, entries] of Object.entries(roots)) {
          const normalizedRoot = String(rootPath || "").trim();
          if (!normalizedRoot) {
            continue;
          }
          normalizedRoots[normalizedRoot] = uniqueStrings(
            (Array.isArray(entries) ? entries : [])
              .map((entry) => normalizeAskHistoryInstruction(entry))
              .filter(Boolean)
          ).slice(0, ASK_HISTORY_LIMIT);
        }
        return { roots: normalizedRoots };
      } catch (_err) {
        return { roots: {} };
      }
    }

    function saveStoredAskHistoryDocument(doc) {
      try {
        const normalized = doc && doc.roots && typeof doc.roots === "object" ? doc : { roots: {} };
        window.localStorage.setItem(ASK_HISTORY_STORAGE_KEY, JSON.stringify(normalized));
      } catch (_err) {
        // Ignore localStorage failures; Ask still works for the current modal session.
      }
    }

    function askHistoryForCurrentRoot() {
      const doc = loadStoredAskHistoryDocument();
      const rootKey = String(ROOT_REPO_PHYSICAL_PATH || "").trim();
      if (!rootKey) {
        return [];
      }
      return Array.isArray(doc.roots[rootKey]) ? doc.roots[rootKey].slice() : [];
    }

    function saveAskInstructionHistoryEntry(instruction) {
      const normalizedInstruction = normalizeAskHistoryInstruction(instruction);
      const rootKey = String(ROOT_REPO_PHYSICAL_PATH || "").trim();
      if (!rootKey || !normalizedInstruction) {
        return;
      }
      const doc = loadStoredAskHistoryDocument();
      const existing = Array.isArray(doc.roots[rootKey]) ? doc.roots[rootKey] : [];
      doc.roots[rootKey] = [normalizedInstruction].concat(existing.filter((entry) => entry !== normalizedInstruction)).slice(0, ASK_HISTORY_LIMIT);
      saveStoredAskHistoryDocument(doc);
    }

    function findAskTemplateDefinition(templateId) {
      const normalizedTemplateId = String(templateId || "").trim();
      if (normalizedTemplateId) {
        const matched = ASK_TEMPLATE_REGISTRY.find((entry) => String(entry && entry.id ? entry.id : "") === normalizedTemplateId);
        if (matched) {
          return matched;
        }
      }
      return ASK_TEMPLATE_REGISTRY.find((entry) => String(entry && entry.id ? entry.id : "") === DEFAULT_ASK_TEMPLATE_ID)
        || ASK_TEMPLATE_REGISTRY[0]
        || {
          id: DEFAULT_ASK_TEMPLATE_ID,
          label: "Ask",
          defaultInstruction: "Explain this selected text.",
        };
    }

    function resolveAskTemplateDefinition(templateDefinition) {
      if (templateDefinition && typeof templateDefinition === "object" && templateDefinition.id) {
        return findAskTemplateDefinition(templateDefinition.id);
      }
      return findAskTemplateDefinition(templateDefinition);
    }

    function removeAskInstructionHistoryEntry(instruction) {
      const normalizedInstruction = normalizeAskHistoryInstruction(instruction);
      const rootKey = String(ROOT_REPO_PHYSICAL_PATH || "").trim();
      if (!rootKey || !normalizedInstruction) {
        return false;
      }
      const doc = loadStoredAskHistoryDocument();
      const existing = Array.isArray(doc.roots[rootKey]) ? doc.roots[rootKey] : [];
      const nextEntries = existing.filter((entry) => entry !== normalizedInstruction);
      if (nextEntries.length === existing.length) {
        return false;
      }
      if (nextEntries.length) {
        doc.roots[rootKey] = nextEntries;
      } else {
        delete doc.roots[rootKey];
      }
      saveStoredAskHistoryDocument(doc);
      return true;
    }

    function buildAskPromptText(instruction, selectedText) {
      const defaultTemplate = findAskTemplateDefinition(DEFAULT_ASK_TEMPLATE_ID);
      return buildAskPromptTextShared(instruction, selectedText, {
        normalizeInstruction: normalizeAskHistoryInstruction,
        defaultInstruction: String(defaultTemplate.defaultInstruction || ""),
        backtickChar: BACKTICK_CHAR,
        newlineChar: NEWLINE_CHAR,
      });
    }

    function setAskPromptStatus(message, kind) {
      if (!askPromptStatus) {
        return;
      }
      askPromptStatus.textContent = String(message || "");
      askPromptStatus.classList.toggle("error", kind === "error");
    }

    function isAskPromptDialogOpen() {
      return askPromptDialog && !askPromptDialog.classList.contains("hidden");
    }

    function applyAskHistoryInstructionSelection(selectedInstruction) {
      const normalizedInstruction = normalizeAskHistoryInstruction(selectedInstruction);
      if (!normalizedInstruction || !askPromptDialogState) {
        return;
      }
      askPromptHistory.value = normalizedInstruction;
      askPromptInstruction.value = normalizedInstruction;
      syncAskPromptHistoryOptions(normalizedInstruction);
      copyAskPromptForInstruction(normalizedInstruction, {
        saveHistory: false,
        copyContext: "ask-history-selection",
      })
        .then((copied) => {
          if (!copied || !askPromptDialogState) {
            return;
          }
          askPromptDialogState.baselineInstruction = normalizedInstruction;
          syncAskPromptHistoryOptions(normalizedInstruction);
        })
        .catch(() => {});
    }

    function removeAskHistoryInstructionFromPromptHistory(instruction) {
      const normalizedInstruction = normalizeAskHistoryInstruction(instruction);
      if (!normalizedInstruction) {
        return;
      }
      const removed = removeAskInstructionHistoryEntry(normalizedInstruction);
      if (removed
        && askPromptDialogState
        && normalizeAskHistoryInstruction(askPromptDialogState.baselineInstruction) === normalizedInstruction) {
        askPromptDialogState.baselineInstruction = "";
      }
      askPromptHistory.value = "";
      syncAskPromptHistoryOptions("");
      setAskPromptStatus(removed ? "Removed from recent instructions." : "That recent instruction was already gone.", "");
      if (askPromptHistoryPicker && askPromptHistoryPicker.isOpen()) {
        window.setTimeout(() => {
          if (askPromptHistoryPicker && askPromptHistoryPicker.isOpen()) {
            askPromptHistoryPicker.focusActiveOptionOrTrigger();
          }
        }, 0);
      }
    }

    function syncAskPromptHistoryOptions(selectedInstruction) {
      if (!askPromptHistory) {
        return;
      }
      const currentValue = normalizeAskHistoryInstruction(selectedInstruction);
      askPromptHistory.replaceChildren();
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Choose a recent instruction…";
      askPromptHistory.appendChild(placeholder);
      const history = askHistoryForCurrentRoot();
      for (const entry of history) {
        const option = document.createElement("option");
        option.value = entry;
        option.textContent = entry;
        askPromptHistory.appendChild(option);
      }
      askPromptHistory.value = history.includes(currentValue) ? currentValue : "";
      if (askPromptHistoryPicker) {
        askPromptHistoryPicker.syncFromSelect();
      }
    }

    let currentViewState = Object.assign({}, initialViewState);
    const initialUrlHasCompareBase = (() => {
      try {
        return new URL(window.location.href).searchParams.has("compare_base");
      } catch (_err) {
        return false;
      }
    })();
    currentViewState.compareBase = normalizeCompareBaseClient(currentViewState.compareBase);
    currentViewState.reviewBaseRef = normalizeReviewBaseRefClient(currentViewState.reviewBaseRef, "master");
    currentViewState.reviewRepoBaseOverrides = normalizeReviewRepoBaseOverridesClient(
      currentViewState.reviewRepoBaseOverrides,
      currentViewState.reviewSelectedRepos,
      currentViewState.reviewBaseRef
    );
    if (!initialUrlHasCompareBase && !initialCompareBaseExplicit) {
      currentViewState.compareBase = loadStoredCompareBase(initialConfiguredCompareBase);
    }
    let storedShowAutoSnapshots = loadStoredSnapshotShowAuto(initialConfiguredSnapshotShowAuto);
    let snapshots = [];
    let currentData = null;
    let currentReviewPresets = [];
    let selectionKeyValue = "";
    let previewToken = 0;
    let refreshTimer = null;
    let emptyStateMessage = "No rows to display.";
    let loadToken = 0;
    let activeLoadController = null;
    let activePreviewController = null;
    let createSnapshotDialogToken = 0;
    let leftPaneRatio = loadStoredSplitRatio();
    let activeSplitDrag = null;
    let currentPreviewRow = null;
    let currentPreviewSupportsPrimaryAction = false;
    let currentAggregatePreviewState = null;
    let currentPreviewVariant = PREVIEW_VARIANT_CURRENT;
    let snapshotPanelRestoreFocusTarget = null;
    let filtersRestoreFocusTarget = null;
    let renameSnapshotTargetId = "";
    let deleteSnapshotTargetId = "";
    let renameReviewPresetTargetName = "";
    let deleteReviewPresetTargetName = "";
    let resetAllSnapshotChoice = true;
    let reviewPresetActionsRestoreFocusTarget = null;
    askPromptHistoryPicker = createFilterableSelect(askPromptHistoryPickerEl, {
      selectNode: askPromptHistory,
      allowEmptyOption: true,
      hideSearch: true,
      ariaLabel: "Recent instructions",
      placeholderText: "Choose a recent instruction…",
      noMatchesText: "No saved instructions",
      buildOptionActions(option) {
        if (!option || !option.value) {
          return [];
        }
        return [{
          label: "Remove",
          title: "Remove this saved instruction without confirmation.",
          ariaLabel: "Remove recent instruction: " + String(option.label || option.value || ""),
          className: "button-secondary filterable-select-option-action",
          keepOpen: true,
          onSelect() {
            removeAskHistoryInstructionFromPromptHistory(option.value);
          },
        }];
      },
      onSelect(value) {
        applyAskHistoryInstructionSelection(value);
      },
    });
    modePicker = createFilterableSelect(modePickerEl, {
      selectNode: modeSelect,
      allowEmptyOption: false,
      hideSearch: true,
      ariaLabel: "Mode",
      placeholderText: "Select mode",
      noMatchesText: "No matching modes",
      renderOptionContent: renderModePickerOptionContent,
      onSelect(value) {
        modeSelect.value = value;
        modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
      },
    });
    reviewRepoPicker = createFilterableSelect(reviewRepoPickerEl, {
      selectNode: reviewRepoSelect,
      allowEmptyOption: false,
      ariaLabel: "Review Repo",
      placeholderText: "Add repo…",
      searchPlaceholder: "Filter repos…",
      noMatchesText: "No matching repos",
      onSelect(value) {
        addReviewRepoSelection(value);
      },
    });
    reviewBasePicker = createFilterableSelect(reviewBasePickerEl, {
      selectNode: reviewBaseSelect,
      allowEmptyOption: false,
      allowCustomValue: true,
      ariaLabel: "Review default base",
      placeholderText: "master",
      searchPlaceholder: "Filter refs or type a commit…",
      noMatchesText: "Press Enter to use this ref",
      onSelect(value) {
        updateReviewBaseState(value);
      },
    });
    reviewPresetPicker = createFilterableSelect(reviewPresetPickerEl, {
      selectNode: reviewPresetSelect,
      allowEmptyOption: true,
      ariaLabel: "Review preset",
      placeholderText: "Load preset…",
      searchPlaceholder: "Filter presets…",
      noMatchesText: "No matching presets",
      onSelect(value) {
        applyReviewPresetSelection(value);
      },
    });
    setReviewSelectionTrayOpen(false);
    repoFilterPicker = createFilterableSelect(repoFilterPickerEl, {
      selectNode: repoFilterSelect,
      allowEmptyOption: true,
      ariaLabel: "Repo filter",
      placeholderText: "(all repos)",
      searchPlaceholder: "Filter repos…",
      noMatchesText: "No matching repos",
      onSelect(value) {
        repoFilterSelect.value = value;
        repoFilterSelect.dispatchEvent(new Event("change", { bubbles: true }));
      },
    });
    let refreshStateTimer = null;
    let refreshStateRequestToken = 0;
    let refreshHintMessage = REFRESH_STATE_HINT_TEXT;
    let refreshViewStatus = "current";
    let serverConnectionState = "connecting";
    let serverConnectionFailureCount = 0;
    let currentViewDataToken = "";
    let currentServerInstanceId = "";
    let currentViewPrepareState = "current";
    let refreshActionBusy = false;
    let refreshMenuRestoreFocusTarget = null;
    let viewedActionsRestoreFocusTarget = null;
    let rowContextMenuEngine = null;
    let diffSelectionContextMenuEngine = null;

    syncRootRepoChipClient(false);
    syncServerStatusChipClient();

    function modeDefaults(mode) {
      if (mode === "browse") {
        return {
          repoFilter: "",
          browseIncludeStaged: true,
          browseIncludeUnstaged: true,
          browseIncludeUntracked: true,
          browseIncludeSubmodules: true,
          browseShowAllRepos: false,
        };
      }
      if (mode === "compare") {
        return {
          repoFilter: "",
          compareIncludeNoEffect: false,
        };
      }
      if (mode === "review") {
        return {
          repoFilter: "",
          reviewSelectedRepos: [],
          reviewBaseRef: "master",
          reviewRepoBaseOverrides: {},
        };
      }
      return {
        repoFilter: "",
        inspectIncludeStaged: true,
        inspectIncludeUnstaged: true,
        inspectIncludeUntracked: true,
        inspectShowAllRepos: false,
      };
    }

    function advancedSettingDiffCount(viewState) {
      const mode = String((viewState && viewState.mode) || currentViewState.mode || "compare");
      const defaults = modeDefaults(mode);
      let count = 0;
      if (String((viewState && viewState.repoFilter) || "") !== String(defaults.repoFilter || "")) {
        count += 1;
      }
      if (mode === "browse") {
        if (Boolean(viewState && viewState.browseIncludeStaged) !== defaults.browseIncludeStaged) count += 1;
        if (Boolean(viewState && viewState.browseIncludeUnstaged) !== defaults.browseIncludeUnstaged) count += 1;
        if (Boolean(viewState && viewState.browseIncludeUntracked) !== defaults.browseIncludeUntracked) count += 1;
        if (Boolean(viewState && viewState.browseIncludeSubmodules) !== defaults.browseIncludeSubmodules) count += 1;
        if (Boolean(viewState && viewState.browseShowAllRepos) !== defaults.browseShowAllRepos) count += 1;
        return count;
      }
      if (mode === "compare") {
        if (Boolean(viewState && viewState.compareIncludeNoEffect) !== defaults.compareIncludeNoEffect) count += 1;
        return count;
      }
      if (mode === "review") {
        const selectedRepos = uniqueStrings(Array.isArray(viewState && viewState.reviewSelectedRepos) ? viewState.reviewSelectedRepos : []);
        const defaultRepos = uniqueStrings(Array.isArray(defaults.reviewSelectedRepos) ? defaults.reviewSelectedRepos : []);
        if (selectedRepos.join("\\n") !== defaultRepos.join("\\n")) count += 1;
        return count;
      }
      if (Boolean(viewState && viewState.inspectIncludeStaged) !== defaults.inspectIncludeStaged) count += 1;
      if (Boolean(viewState && viewState.inspectIncludeUnstaged) !== defaults.inspectIncludeUnstaged) count += 1;
      if (Boolean(viewState && viewState.inspectIncludeUntracked) !== defaults.inspectIncludeUntracked) count += 1;
      if (Boolean(viewState && viewState.inspectShowAllRepos) !== defaults.inspectShowAllRepos) count += 1;
      return count;
    }

    function isSnapshotPanelOpen() {
      return !snapshotOverlay.classList.contains("hidden");
    }

    function isFiltersPanelOpen() {
      return !filtersOverlay.classList.contains("hidden");
    }

    function isRefreshMenuOpen() {
      return !refreshMenu.classList.contains("hidden");
    }

    function isReviewPresetActionsMenuOpen() {
      return !reviewPresetActionsMenu.classList.contains("hidden");
    }

    function isRenameSnapshotDialogOpen() {
      return !renameSnapshotDialog.classList.contains("hidden");
    }

    function isDeleteSnapshotDialogOpen() {
      return !deleteSnapshotDialog.classList.contains("hidden");
    }

    function isSaveReviewPresetDialogOpen() {
      return !saveReviewPresetDialog.classList.contains("hidden");
    }

    function isRenameReviewPresetDialogOpen() {
      return !renameReviewPresetDialog.classList.contains("hidden");
    }

    function isDeleteReviewPresetDialogOpen() {
      return !deleteReviewPresetDialog.classList.contains("hidden");
    }

    function isResetAllDialogOpen() {
      return !resetAllDialog.classList.contains("hidden");
    }

    function isResetAllConfirmDialogOpen() {
      return !resetAllConfirmDialog.classList.contains("hidden");
    }

    function effectiveSnapshotShowAutoValue(snapshotId) {
      return storedShowAutoSnapshots || selectedSnapshotIsAuto(snapshotId);
    }

    function syncSnapshotShowAutoControl() {
      snapshotShowAutoCheckbox.checked = effectiveSnapshotShowAutoValue();
    }

    function syncBodyModalState() {
      document.body.classList.toggle(
        "modal-open",
        isSnapshotPanelOpen()
          || isFiltersPanelOpen()
          || isCreateSnapshotDialogOpen()
          || isResetAllDialogOpen()
          || isResetAllConfirmDialogOpen()
          || isRenameSnapshotDialogOpen()
          || isDeleteSnapshotDialogOpen()
          || isSaveReviewPresetDialogOpen()
          || isRenameReviewPresetDialogOpen()
          || isDeleteReviewPresetDialogOpen()
          || isAskPromptDialogOpen()
      );
    }

    function closeRefreshMenu(restoreFocus) {
      refreshMenu.classList.add("hidden");
      refreshMenuButton.setAttribute("aria-expanded", "false");
      refreshMenuButton.classList.remove("active");
      syncRefreshButtonHintState();
      if (restoreFocus) {
        const target = refreshMenuRestoreFocusTarget || refreshMenuButton;
        refreshMenuRestoreFocusTarget = null;
        if (target && typeof target.focus === "function") {
          target.focus();
        }
      }
    }

    function closeReviewPresetActionsMenu(restoreFocus) {
      reviewPresetActionsMenu.classList.add("hidden");
      reviewPresetActionsButton.setAttribute("aria-expanded", "false");
      reviewPresetActionsButton.classList.remove("active");
      if (restoreFocus) {
        const target = reviewPresetActionsRestoreFocusTarget || reviewPresetActionsButton;
        reviewPresetActionsRestoreFocusTarget = null;
        if (target && typeof target.focus === "function") {
          target.focus();
        }
      }
    }

    function openRefreshMenu() {
      if (refreshMenuButton.disabled) {
        return;
      }
      if (isRefreshMenuOpen()) {
        return;
      }
      if (isDiffSelectionContextMenuOpen()) {
        closeDiffSelectionContextMenu(false);
      }
      refreshMenuRestoreFocusTarget = document.activeElement;
      refreshMenu.classList.remove("hidden");
      refreshMenuButton.setAttribute("aria-expanded", "true");
      refreshMenuButton.classList.add("active");
      syncRefreshButtonHintState();
      window.setTimeout(() => {
        if (isRefreshMenuOpen() && !hardRefreshBtn.disabled) {
          hardRefreshBtn.focus();
        }
      }, 0);
    }

    function openReviewPresetActionsMenu() {
      if (reviewPresetActionsButton.disabled) {
        return;
      }
      if (isReviewPresetActionsMenuOpen()) {
        return;
      }
      closeAllFilterableSelects(false);
      if (isRefreshMenuOpen()) {
        closeRefreshMenu(false);
      }
      if (isDiffSelectionContextMenuOpen()) {
        closeDiffSelectionContextMenu(false);
      }
      reviewPresetActionsRestoreFocusTarget = document.activeElement;
      reviewPresetActionsMenu.classList.remove("hidden");
      reviewPresetActionsButton.setAttribute("aria-expanded", "true");
      reviewPresetActionsButton.classList.add("active");
      window.setTimeout(() => {
        if (!isReviewPresetActionsMenuOpen()) {
          return;
        }
        const firstEnabled = [reviewPresetSaveBtn, reviewPresetRenameBtn, reviewPresetDeleteBtn].find((button) => button && !button.disabled);
        if (firstEnabled) {
          firstEnabled.focus();
        }
      }, 0);
    }

    function isViewedActionsMenuOpen() {
      return !viewedActionsMenu.classList.contains("hidden");
    }

    function isRowContextMenuOpen() {
      return Boolean(rowContextMenuEngine && rowContextMenuEngine.isOpen());
    }

    function isDiffSelectionContextMenuOpen() {
      return Boolean(diffSelectionContextMenuEngine && diffSelectionContextMenuEngine.isOpen());
    }

    function createContextMenuEngine(menuEl, defaultAriaLabel) {
      const categories = [];
      const items = [];
      let currentState = null;

      function registerCategory(definition) {
        if (!definition || !definition.id) {
          return;
        }
        categories.push({
          id: String(definition.id),
          label: String(definition.label || definition.id),
          priority: Number(definition.priority || 0) || 0,
        });
        categories.sort((left, right) => {
          const priorityDelta = left.priority - right.priority;
          if (priorityDelta !== 0) {
            return priorityDelta;
          }
          return String(left.label || "").localeCompare(String(right.label || ""));
        });
      }

      function registerItem(definition) {
        if (!definition || !definition.id || !definition.category) {
          return;
        }
        items.push({
          id: String(definition.id),
          category: String(definition.category),
          priority: Number(definition.priority || 0) || 0,
          appliesTo: typeof definition.appliesTo === "function" ? definition.appliesTo : (() => true),
          buildAction: typeof definition.buildAction === "function" ? definition.buildAction : (() => null),
        });
        items.sort((left, right) => {
          const categoryDelta = String(left.category).localeCompare(String(right.category));
          if (categoryDelta !== 0) {
            return categoryDelta;
          }
          const priorityDelta = left.priority - right.priority;
          if (priorityDelta !== 0) {
            return priorityDelta;
          }
          return String(left.id).localeCompare(String(right.id));
        });
      }

      function buildSections(context) {
        const sectionsByCategory = new Map();
        for (const category of categories) {
          sectionsByCategory.set(category.id, {
            id: category.id,
            label: category.label,
            priority: category.priority,
            items: [],
          });
        }
        for (const item of items) {
          if (!item.appliesTo(context, currentViewState)) {
            continue;
          }
          const action = item.buildAction(context, currentViewState);
          if (!action || !action.label) {
            continue;
          }
          if (!sectionsByCategory.has(item.category)) {
            sectionsByCategory.set(item.category, {
              id: item.category,
              label: item.category,
              priority: 0,
              items: [],
            });
          }
          sectionsByCategory.get(item.category).items.push(Object.assign({}, action, {
            itemId: item.id,
            priority: item.priority,
          }));
        }
        return Array.from(sectionsByCategory.values())
          .filter((section) => Array.isArray(section.items) && section.items.length > 0)
          .sort((left, right) => {
            const priorityDelta = left.priority - right.priority;
            if (priorityDelta !== 0) {
              return priorityDelta;
            }
            return String(left.label || "").localeCompare(String(right.label || ""));
          })
          .map((section) => Object.assign({}, section, {
            items: section.items.slice().sort((left, right) => {
              const priorityDelta = left.priority - right.priority;
              if (priorityDelta !== 0) {
                return priorityDelta;
              }
              return String(left.label || "").localeCompare(String(right.label || ""));
            }),
          }));
      }

      function close(restoreFocus) {
        menuEl.classList.add("hidden");
        menuEl.replaceChildren();
        if (restoreFocus && currentState) {
          const target = currentState.restoreFocusTarget || currentState.triggerNode;
          if (target && typeof target.focus === "function") {
            target.focus();
          }
        }
        currentState = null;
      }

      function position(x, y) {
        const margin = 10;
        const rect = menuEl.getBoundingClientRect();
        const maxLeft = Math.max(margin, window.innerWidth - rect.width - margin);
        const maxTop = Math.max(margin, window.innerHeight - rect.height - margin);
        menuEl.style.left = Math.min(Math.max(margin, Math.round(x)), maxLeft) + "px";
        menuEl.style.top = Math.min(Math.max(margin, Math.round(y)), maxTop) + "px";
      }

      function buildSubmenuNode(actions, closeParentMenu) {
        const submenu = document.createElement("div");
        submenu.className = "row-context-menu-submenu";
        submenu.setAttribute("role", "menu");
        const sortedActions = (Array.isArray(actions) ? actions : []).slice().sort((left, right) => {
          const priorityDelta = (Number(left && left.priority || 0) || 0) - (Number(right && right.priority || 0) || 0);
          if (priorityDelta !== 0) {
            return priorityDelta;
          }
          return String(left && left.label || "").localeCompare(String(right && right.label || ""));
        });
        for (const action of sortedActions) {
          const button = createActionNode(action, closeParentMenu);
          if (button) {
            submenu.appendChild(button);
          }
        }
        return submenu;
      }

      function createActionNode(action, closeParentMenu) {
        const children = Array.isArray(action && action.children) ? action.children.filter(Boolean) : [];
        if (children.length > 0) {
          const wrapper = document.createElement("div");
          wrapper.className = "row-context-menu-submenu-wrap";
          const button = document.createElement("button");
          button.type = "button";
          button.className = "button-secondary row-context-menu-item has-submenu";
          button.setAttribute("role", "menuitem");
          button.setAttribute("aria-haspopup", "menu");
          const label = document.createElement("span");
          label.className = "row-context-menu-item-label";
          label.textContent = String(action.label || "");
          button.appendChild(label);
          const caret = document.createElement("span");
          caret.className = "row-context-menu-item-caret";
          caret.textContent = "›";
          button.appendChild(caret);
          if (action.title) {
            button.title = String(action.title);
          }
          if (action.disabled) {
            button.disabled = true;
          }
          wrapper.appendChild(button);
          wrapper.appendChild(buildSubmenuNode(children, closeParentMenu));
          return wrapper;
        }

        const button = document.createElement("button");
        button.type = "button";
        button.className = "button-secondary row-context-menu-item";
        button.setAttribute("role", "menuitem");
        button.textContent = String(action && action.label ? action.label : "");
        if (action && action.title) {
          button.title = String(action.title);
        }
        if (action && action.disabled) {
          button.disabled = true;
        } else {
          button.onclick = () => {
            closeParentMenu(false);
            void runGuardedUiAction(
              () => action && action.onSelect ? action.onSelect() : null,
              { fallbackMessage: "Menu action failed." }
            );
          };
        }
        return button;
      }

      function render(context) {
        const sections = buildSections(context);
        if (!sections.length) {
          return false;
        }
        menuEl.innerHTML = "";
        const fragment = document.createDocumentFragment();
        for (const section of sections) {
          const sectionNode = document.createElement("div");
          sectionNode.className = "row-context-menu-section";
          const title = document.createElement("div");
          title.className = "row-context-menu-section-title";
          title.textContent = String(section.label || "");
          sectionNode.appendChild(title);
          for (const item of section.items) {
            const node = createActionNode(item, close);
            if (node) {
              sectionNode.appendChild(node);
            }
          }
          fragment.appendChild(sectionNode);
        }
        menuEl.appendChild(fragment);
        return true;
      }

      function open(context, options) {
        const openOptions = options && typeof options === "object" ? options : {};
        if (!render(context)) {
          return false;
        }
        currentState = {
          context,
          triggerNode: openOptions.triggerNode || null,
          restoreFocusTarget: openOptions.restoreFocusTarget || document.activeElement,
          extra: openOptions.extra || null,
        };
        menuEl.classList.remove("hidden");
        menuEl.setAttribute("aria-label", String(openOptions.ariaLabel || defaultAriaLabel || "Actions"));
        const anchorX = Number.isFinite(openOptions.clientX) ? openOptions.clientX : 16;
        const anchorY = Number.isFinite(openOptions.clientY) ? openOptions.clientY : 16;
        position(anchorX, anchorY);
        window.setTimeout(() => {
          const firstItem = menuEl.querySelector("button[role='menuitem']:not([disabled])");
          if (firstItem) {
            firstItem.focus();
          }
        }, 0);
        return true;
      }

      return {
        registerCategory,
        registerItem,
        buildSections,
        open,
        close,
        isOpen() {
          return !menuEl.classList.contains("hidden");
        },
        containsTarget(target) {
          return Boolean(target && menuEl.contains(target));
        },
        getState() {
          return currentState;
        },
      };
    }

    rowContextMenuEngine = createContextMenuEngine(rowContextMenu, "Row actions");
    diffSelectionContextMenuEngine = createContextMenuEngine(diffSelectionContextMenu, "Selected text actions");

    function closeRowContextMenu(restoreFocus) {
      if (rowContextMenuEngine) {
        rowContextMenuEngine.close(restoreFocus);
      }
    }

    function closeDiffSelectionContextMenu(restoreFocus) {
      if (diffSelectionContextMenuEngine) {
        diffSelectionContextMenuEngine.close(restoreFocus);
      }
    }

    function diffSelectionAllowedRoot(node) {
      if (!node || !(node instanceof Node)) {
        return null;
      }
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!element || !diffEl || !diffEl.contains(element)) {
        return null;
      }
      const disallowed = element.closest(".preview-controls, .aggregate-preview-summary, .aggregate-preview-block-header, .diff-file-header, .diff-file-meta, .diff-gutter");
      if (disallowed) {
        return null;
      }
      return element.closest(".preview-pre, .aggregate-preview-pre, .submodule-summary-body, .diff-code");
    }

    function diffSelectionNodeDisposition(node) {
      if (!node || !(node instanceof Node)) {
        return "reject";
      }
      const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
      if (!element || !diffEl || !diffEl.contains(element)) {
        return "reject";
      }
      if (element.closest(".preview-controls, .aggregate-preview-summary, .aggregate-preview-block-header, .diff-file-header, .diff-file-meta")) {
        return "reject";
      }
      if (element.closest(".diff-gutter")) {
        return "ignore";
      }
      if (diffSelectionAllowedRoot(node)) {
        return "allow";
      }
      if (node.nodeType === Node.TEXT_NODE && !String(node.textContent || "").trim()) {
        return "ignore";
      }
      return "reject";
    }

    function normalizeCapturedSelectionText(text) {
      return normalizeLineBreaksShared(text, CARRIAGE_RETURN_CHAR, NEWLINE_CHAR);
    }

    function setCurrentDiffSelectionSnapshot(snapshot) {
      currentDiffSelectionSnapshot = snapshot && typeof snapshot === "object" && String(snapshot.text || "")
        ? {
          text: String(snapshot.text || ""),
          anchorX: Number.isFinite(snapshot.anchorX) ? snapshot.anchorX : 16,
          anchorY: Number.isFinite(snapshot.anchorY) ? snapshot.anchorY : 16,
        }
        : null;
    }

    function clearDiffSelectionActionSnapshot() {
      setCurrentDiffSelectionSnapshot(null);
    }

    function sanitizedDiffSelectionText(range) {
      if (!range) {
        return "";
      }
      const fragment = range.cloneContents();
      const container = document.createElement("div");
      container.className = "selection-extract-scratch";
      container.style.position = "fixed";
      container.style.left = "-99999px";
      container.style.top = "0";
      container.style.visibility = "hidden";
      container.style.pointerEvents = "none";
      container.style.whiteSpace = "normal";
      container.appendChild(fragment);
      container.querySelectorAll(".diff-gutter, .preview-controls, .aggregate-preview-summary, .aggregate-preview-block-header, .diff-file-header, .diff-file-meta").forEach((node) => node.remove());
      document.body.appendChild(container);
      try {
        const structuredText = structuredDiffSelectionTextFromContainerShared(container, {
          newlineChar: NEWLINE_CHAR,
          normalizeLineBreaks: normalizeCapturedSelectionText,
        });
        if (structuredText) {
          return structuredText;
        }
        const rawText = container.children.length > 0
          ? String(container.innerText || container.textContent || "")
          : String(container.textContent || "");
        return normalizeCapturedSelectionText(rawText);
      } finally {
        container.remove();
      }
    }

    function captureDiffSelectionSnapshot() {
      const startedAt = window.performance && typeof window.performance.now === "function"
        ? window.performance.now()
        : Date.now();
      const selection = window.getSelection();
      if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
        return null;
      }
      const range = selection.getRangeAt(0);
      const anchorNode = selection.anchorNode;
      const focusNode = selection.focusNode;
      if (!anchorNode || !focusNode || !diffEl.contains(anchorNode) || !diffEl.contains(focusNode)) {
        return null;
      }
      const commonNode = range.commonAncestorContainer;
      const commonElement = commonNode && commonNode.nodeType === Node.ELEMENT_NODE ? commonNode : (commonNode ? commonNode.parentElement : null);
      if (!commonElement || (!diffEl.contains(commonElement) && commonElement !== diffEl)) {
        return null;
      }
      const walker = document.createTreeWalker(diffEl, NodeFilter.SHOW_TEXT, null);
      const allowedRoots = new Set();
      let sawIntersectingText = false;
      let currentNode = walker.nextNode();
      while (currentNode) {
        if (range.intersectsNode(currentNode)) {
          const disposition = diffSelectionNodeDisposition(currentNode);
          if (disposition === "reject") {
            return null;
          }
          if (disposition === "ignore") {
            sawIntersectingText = true;
            currentNode = walker.nextNode();
            continue;
          }
          const selectedRoot = diffSelectionAllowedRoot(currentNode);
          if (!selectedRoot) {
            return null;
          }
          allowedRoots.add(selectedRoot);
          sawIntersectingText = true;
        }
        currentNode = walker.nextNode();
      }
      if (!sawIntersectingText || !allowedRoots.size) {
        return null;
      }
      const text = sanitizedDiffSelectionText(range);
      if (!text) {
        return null;
      }
      const clientRect = range.getBoundingClientRect();
      const snapshot = {
        text,
        anchorX: Number.isFinite(clientRect.left) ? clientRect.left : 16,
        anchorY: Number.isFinite(clientRect.bottom) ? (clientRect.bottom + 6) : 16,
      };
      const finishedAt = window.performance && typeof window.performance.now === "function"
        ? window.performance.now()
        : Date.now();
      const elapsedMs = Math.max(0, Math.round((finishedAt - startedAt) * 100) / 100);
      recordDiffSelectionDebugEvent("selection-capture", {
        textLength: snapshot.text.length,
        lineCount: snapshot.text ? snapshot.text.split(NEWLINE_CHAR).length : 0,
        allowedRootCount: allowedRoots.size,
        elapsedMs,
        slowCaptureThresholdMs: DIFF_SELECTION_SLOW_CAPTURE_MS,
        slow: elapsedMs >= DIFF_SELECTION_SLOW_CAPTURE_MS,
      });
      return snapshot;
    }

    function syncDiffSelectionActionState(snapshot) {
      if (snapshot === null) {
        clearDiffSelectionActionSnapshot();
        return;
      }
      setCurrentDiffSelectionSnapshot(snapshot === undefined ? captureDiffSelectionSnapshot() : snapshot);
    }

    function scheduleDiffSelectionActionSync(immediate) {
      if (diffSelectionSyncTimer) {
        window.clearTimeout(diffSelectionSyncTimer);
      }
      diffSelectionSyncTimer = window.setTimeout(() => {
        diffSelectionSyncTimer = null;
        syncDiffSelectionActionState();
      }, immediate ? 0 : DIFF_SELECTION_SYNC_DELAY_MS);
    }

    function closeAskPromptDialog(restoreFocus) {
      askPromptDialog.classList.add("hidden");
      setAskPromptStatus("", "");
      askPromptInstruction.value = "";
      askPromptSelection.textContent = "";
      askPromptHistory.value = "";
      if (askPromptHistoryPicker) {
        askPromptHistoryPicker.close(false);
        askPromptHistoryPicker.syncFromSelect();
      }
      if (restoreFocus && askPromptDialogState) {
        const target = askPromptDialogState.restoreFocusTarget;
        if (target && typeof target.focus === "function") {
          target.focus();
        }
      }
      askPromptDialogState = null;
      syncBodyModalState();
    }

    function openAskPromptDialog(templateDefinition, selectionSnapshot, restoreFocusTarget) {
      const template = resolveAskTemplateDefinition(templateDefinition);
      const frozenSelection = selectionSnapshot && typeof selectionSnapshot === "object"
        ? selectionSnapshot
        : null;
      if (!frozenSelection || !String(frozenSelection.text || "")) {
        return;
      }
      askPromptDialogState = {
        templateId: String(template.id || ""),
        selectionText: String(frozenSelection.text || ""),
        baselineInstruction: String(template.defaultInstruction || ""),
        restoreFocusTarget: restoreFocusTarget || document.activeElement,
      };
      askPromptInstruction.value = askPromptDialogState.baselineInstruction;
      askPromptSelection.textContent = askPromptDialogState.selectionText;
      syncAskPromptHistoryOptions("");
      setAskPromptStatus("", "");
      askPromptDialog.classList.remove("hidden");
      syncBodyModalState();
      window.setTimeout(() => {
        if (isAskPromptDialogOpen()) {
          askPromptInstruction.focus();
          askPromptInstruction.setSelectionRange(askPromptInstruction.value.length, askPromptInstruction.value.length);
        }
      }, 0);
    }

    async function copyAskPromptForInstruction(instruction, options) {
      const copyOptions = options && typeof options === "object" ? options : {};
      const state = askPromptDialogState;
      if (!state) {
        return false;
      }
      const template = resolveAskTemplateDefinition(String(state.templateId || ""));
      const normalizedInstruction = normalizeAskHistoryInstruction(instruction)
        || String(state.baselineInstruction || template.defaultInstruction || "");
      const promptText = buildAskPromptText(normalizedInstruction, state.selectionText);
      const copied = await copyTextToClipboardClient(promptText, {
        context: String(copyOptions.copyContext || "ask-prompt-copy"),
      });
      if (!copied) {
        setAskPromptStatus("Failed to copy the generated prompt.", "error");
        showClientToast("Failed to copy the generated prompt.", "error");
        return false;
      }
      if (copyOptions.saveHistory !== false && normalizedInstruction && normalizedInstruction !== String(state.baselineInstruction || "")) {
        saveAskInstructionHistoryEntry(normalizedInstruction);
        state.baselineInstruction = normalizedInstruction;
        syncAskPromptHistoryOptions(normalizedInstruction);
      }
      setAskPromptStatus("Prompt copied to the clipboard.", "");
      showClientToast("Prompt copied.", "");
      return true;
    }

    function registerAskTemplate(definition) {
      const template = definition && typeof definition === "object" ? definition : null;
      if (!template || !template.id || !template.label || !template.defaultInstruction) {
        return;
      }
      const existingIndex = ASK_TEMPLATE_REGISTRY.findIndex((entry) => entry.id === template.id);
      const normalizedTemplate = {
        id: String(template.id),
        label: String(template.label),
        defaultInstruction: String(template.defaultInstruction),
      };
      if (existingIndex === -1) {
        ASK_TEMPLATE_REGISTRY.push(normalizedTemplate);
      } else {
        ASK_TEMPLATE_REGISTRY.splice(existingIndex, 1, normalizedTemplate);
      }
    }

    function currentViewedStateCounts() {
      const counts = currentData && currentData.viewedStateCounts && typeof currentData.viewedStateCounts === "object"
        ? currentData.viewedStateCounts
        : {};
      const byMode = counts && counts.by_mode && typeof counts.by_mode === "object" ? counts.by_mode : {};
      return {
        all: Math.max(0, Number(counts.all || 0) || 0),
        currentMode: Math.max(0, Number(byMode[currentViewState.mode] || 0) || 0),
      };
    }

    function rowHasViewedPreviewHistory(row) {
      return String(row && row.view_blob_available ? row.view_blob_available : "").trim() === "true";
    }

    function normalizeViewedStateCountsSnapshot(counts) {
      const rawCounts = counts && typeof counts === "object" ? counts : {};
      const rawByMode = rawCounts.by_mode && typeof rawCounts.by_mode === "object"
        ? rawCounts.by_mode
        : (rawCounts.byMode && typeof rawCounts.byMode === "object" ? rawCounts.byMode : {});
      const byMode = {
        browse: 0,
        compare: 0,
        inspect: 0,
        review: 0,
      };
      for (const [mode, value] of Object.entries(rawByMode)) {
        byMode[String(mode || "")] = Math.max(0, Number(value || 0) || 0);
      }
      return {
        all: Math.max(0, Number(rawCounts.all || 0) || 0),
        byMode,
      };
    }

    function snapshotViewedStateCounts() {
      return normalizeViewedStateCountsSnapshot(currentData && currentData.viewedStateCounts);
    }

    function applyViewedStateCountsSnapshot(snapshot) {
      if (!currentData) {
        return;
      }
      const normalized = normalizeViewedStateCountsSnapshot(snapshot);
      currentData.viewedStateCounts = {
        all: normalized.all,
        current_mode: normalized.byMode[currentViewState.mode] || 0,
        by_mode: Object.assign({}, normalized.byMode),
      };
    }

    function viewedStateEntryCount(state) {
      const normalizedState = String(state || VIEW_STATE_UNVIEWED);
      return (normalizedState === VIEW_STATE_VIEWED || normalizedState === VIEW_STATE_CHANGED) ? 1 : 0;
    }

    function viewedStateCountsWithDelta(beforeCounts, delta) {
      const baseline = normalizeViewedStateCountsSnapshot(beforeCounts);
      const next = {
        all: Math.max(0, baseline.all + (Number(delta || 0) || 0)),
        byMode: Object.assign({}, baseline.byMode),
      };
      const activeMode = String(currentViewState.mode || "");
      next.byMode[activeMode] = Math.max(0, (next.byMode[activeMode] || 0) + (Number(delta || 0) || 0));
      return next;
    }

    function reconcileViewedStateCountsAfterMutation(beforeCounts, mutationPlan, serverCounts) {
      const plan = mutationPlan && typeof mutationPlan === "object" ? mutationPlan : {};
      const expectedCounts = plan.snapshot
        ? normalizeViewedStateCountsSnapshot(plan.snapshot)
        : viewedStateCountsWithDelta(beforeCounts, plan.delta);
      const normalizedServerCounts = normalizeViewedStateCountsSnapshot(serverCounts);
      const activeMode = String(currentViewState.mode || "");
      const serverMatchesExpected = normalizedServerCounts.all === expectedCounts.all
        && (normalizedServerCounts.byMode[activeMode] || 0) === (expectedCounts.byMode[activeMode] || 0);
      if (!serverMatchesExpected) {
        const debugEntry = {
          event: "count-mismatch",
          action: String(plan.label || ""),
          mode: activeMode,
          expected: expectedCounts,
          server: normalizedServerCounts,
          at: new Date().toISOString(),
        };
        const debugState = globalThis.__gitSnapshotViewedDebug && typeof globalThis.__gitSnapshotViewedDebug === "object"
          ? globalThis.__gitSnapshotViewedDebug
          : { events: [] };
        const nextEvents = Array.isArray(debugState.events) ? debugState.events.slice(-19) : [];
        nextEvents.push(debugEntry);
        globalThis.__gitSnapshotViewedDebug = Object.assign({}, debugState, {
          lastMismatch: debugEntry,
          events: nextEvents,
        });
        if (VIEWED_TELEMETRY_ENABLED || nextEvents.length <= 5) {
          console.warn("[viewed] count mismatch after mutation", debugEntry);
        }
      }
      applyViewedStateCountsSnapshot(serverMatchesExpected ? normalizedServerCounts : expectedCounts);
    }

    function closeViewedActionsMenu(restoreFocus) {
      viewedActionsMenu.classList.add("hidden");
      viewedActionsButton.setAttribute("aria-expanded", "false");
      viewedActionsButton.classList.remove("active");
      if (restoreFocus) {
        const target = viewedActionsRestoreFocusTarget || viewedActionsButton;
        viewedActionsRestoreFocusTarget = null;
        if (target && typeof target.focus === "function") {
          target.focus();
        }
      }
    }

    function openViewedActionsMenu() {
      if (viewedActionsButton.disabled) {
        return;
      }
      if (isViewedActionsMenuOpen()) {
        return;
      }
      closeAllFilterableSelects(false);
      if (isRefreshMenuOpen()) {
        closeRefreshMenu(false);
      }
      if (isReviewPresetActionsMenuOpen()) {
        closeReviewPresetActionsMenu(false);
      }
      if (isRowContextMenuOpen()) {
        closeRowContextMenu(false);
      }
      if (isDiffSelectionContextMenuOpen()) {
        closeDiffSelectionContextMenu(false);
      }
      viewedActionsRestoreFocusTarget = document.activeElement;
      viewedActionsMenu.classList.remove("hidden");
      viewedActionsButton.setAttribute("aria-expanded", "true");
      viewedActionsButton.classList.add("active");
      window.setTimeout(() => {
        if (!isViewedActionsMenuOpen()) {
          return;
        }
        const firstEnabled = [clearViewedModeBtn, clearViewedAllBtn].find((button) => button && !button.disabled);
        if (firstEnabled) {
          firstEnabled.focus();
        }
      }, 0);
    }

    function syncViewedActionsState() {
      const counts = currentViewedStateCounts();
      const currentModeLabel = modeDisplayLabelClient(currentViewState.mode);
      const totalCount = counts.all;
      const currentModeCount = counts.currentMode;
      viewedActionsButton.disabled = totalCount <= 0;
      viewedActionsButton.textContent = totalCount > 0 ? ("Viewed (" + totalCount + ")") : "Viewed";
      viewedActionsButton.title = totalCount > 0
        ? (String(totalCount) + " viewed rows recorded for this root repo.")
        : "No viewed rows recorded for this root repo.";
      viewedActionsButton.setAttribute(
        "aria-label",
        totalCount > 0
          ? ("Viewed actions. " + String(totalCount) + " viewed rows recorded for this root repo.")
          : "Viewed actions unavailable because no rows are marked as viewed."
      );
      clearViewedModeBtn.textContent = "Clear viewed in " + currentModeLabel + (currentModeCount > 0 ? (" (" + currentModeCount + ")") : "");
      clearViewedAllBtn.textContent = "Clear all viewed" + (totalCount > 0 ? (" (" + totalCount + ")") : "");
      clearViewedModeBtn.disabled = currentModeCount <= 0;
      clearViewedAllBtn.disabled = totalCount <= 0;
      if (viewedActionsButton.disabled && isViewedActionsMenuOpen()) {
        closeViewedActionsMenu(false);
      }
    }

    function formatViewedTimestamp(value) {
      const text = String(value || "").trim();
      if (!text) {
        return "";
      }
      const date = new Date(text);
      if (!Number.isFinite(date.getTime())) {
        return text;
      }
      try {
        return date.toLocaleString();
      } catch (_err) {
        return date.toISOString();
      }
    }

    function currentSelectedFileRow() {
      const row = findCurrentRowBySelectionKey();
      if (!row || String(row.selection_kind || "file") !== "file") {
        return null;
      }
      return row;
    }

    function fileRowSupportsSinceViewed(row) {
      return Boolean(
        row
        && String(row.selection_kind || "file") === "file"
        && String(row.view_state || "") === VIEW_STATE_CHANGED
        && rowHasViewedPreviewHistory(row)
      );
    }

    function syncPreviewControlsState() {
      const row = currentSelectedFileRow();
      const supportsSinceViewed = fileRowSupportsSinceViewed(row);
      if (!supportsSinceViewed) {
        currentPreviewVariant = PREVIEW_VARIANT_CURRENT;
        previewControls.classList.add("hidden");
        previewControlsMeta.textContent = "";
        previewCurrentButton.classList.add("active");
        previewCurrentButton.setAttribute("aria-selected", "true");
        previewSinceViewedButton.classList.remove("active");
        previewSinceViewedButton.setAttribute("aria-selected", "false");
        previewSinceViewedButton.disabled = true;
        return;
      }

      previewControls.classList.remove("hidden");
      const markedAt = formatViewedTimestamp(row && row.view_marked_at);
      previewControlsMeta.textContent = markedAt
        ? ("Viewed on " + markedAt + ". Compare the stored viewed version with the current preview.")
        : "Compare the stored viewed version with the current preview.";
      const showingCurrent = currentPreviewVariant !== PREVIEW_VARIANT_SINCE_VIEWED;
      previewCurrentButton.classList.toggle("active", showingCurrent);
      previewCurrentButton.setAttribute("aria-selected", showingCurrent ? "true" : "false");
      previewSinceViewedButton.classList.toggle("active", !showingCurrent);
      previewSinceViewedButton.setAttribute("aria-selected", showingCurrent ? "false" : "true");
      previewSinceViewedButton.disabled = false;
    }

    function registerRowContextMenuCategory(definition) {
      if (rowContextMenuEngine) {
        rowContextMenuEngine.registerCategory(definition);
      }
    }

    function registerRowContextMenuItem(definition) {
      if (rowContextMenuEngine) {
        rowContextMenuEngine.registerItem(definition);
      }
    }

    function buildRowContextMenuSections(node) {
      return rowContextMenuEngine ? rowContextMenuEngine.buildSections(node) : [];
    }

    function renderRowContextMenu(node) {
      return Boolean(rowContextMenuEngine && buildRowContextMenuSections(node).length);
    }

    function openRowContextMenu(node, rowButton, triggerNode, options) {
      const menuOptions = options && typeof options === "object" ? options : {};
      if (!node) {
        return;
      }
      if (!rowContextMenuEngine || !buildRowContextMenuSections(node).length) {
        return;
      }
      if (isRefreshMenuOpen()) {
        closeRefreshMenu(false);
      }
      if (isReviewPresetActionsMenuOpen()) {
        closeReviewPresetActionsMenu(false);
      }
      if (isViewedActionsMenuOpen()) {
        closeViewedActionsMenu(false);
      }
      if (isDiffSelectionContextMenuOpen()) {
        closeDiffSelectionContextMenu(false);
      }
      closeAllFilterableSelects(false);
      const triggerRect = triggerNode && typeof triggerNode.getBoundingClientRect === "function"
        ? triggerNode.getBoundingClientRect()
        : null;
      const defaultX = triggerRect ? triggerRect.left : 16;
      const defaultY = triggerRect ? (triggerRect.bottom + 6) : 16;
      rowContextMenuEngine.open(node, {
        clientX: Number.isFinite(menuOptions.clientX) ? menuOptions.clientX : defaultX,
        clientY: Number.isFinite(menuOptions.clientY) ? menuOptions.clientY : defaultY,
        triggerNode: triggerNode || rowButton,
        restoreFocusTarget: document.activeElement,
      });
      setActiveRow(rowButton);
      setSelectedRowInViewState(node);
      selectionKeyValue = rowSelectionKey(node);
      syncBrowserUrl(currentViewState);
      syncPreviewControlsState();
      const shouldLoadPreview = menuOptions.loadPreviewOnOpen === true;
      if (rowButton && shouldLoadPreview) {
        selectRow(node, rowButton, true).catch((err) => {
          if (!isAbortError(err)) {
            setDiffText((err && err.message) ? err.message : "Failed to load preview.");
          }
        });
      } else {
        syncOpenButtonState();
      }
    }

    function registerDiffSelectionContextMenuCategory(definition) {
      if (diffSelectionContextMenuEngine) {
        diffSelectionContextMenuEngine.registerCategory(definition);
      }
    }

    function registerDiffSelectionContextMenuItem(definition) {
      if (diffSelectionContextMenuEngine) {
        diffSelectionContextMenuEngine.registerItem(definition);
      }
    }

    function openDiffSelectionContextMenu(selectionSnapshot, triggerNode, options) {
      const snapshot = selectionSnapshot && typeof selectionSnapshot === "object" ? selectionSnapshot : null;
      const menuOptions = options && typeof options === "object" ? options : {};
      if (!snapshot || !String(snapshot.text || "")) {
        return;
      }
      setCurrentDiffSelectionSnapshot(snapshot);
      if (isRefreshMenuOpen()) {
        closeRefreshMenu(false);
      }
      if (isReviewPresetActionsMenuOpen()) {
        closeReviewPresetActionsMenu(false);
      }
      if (isViewedActionsMenuOpen()) {
        closeViewedActionsMenu(false);
      }
      if (isRowContextMenuOpen()) {
        closeRowContextMenu(false);
      }
      closeAllFilterableSelects(false);
      diffSelectionContextMenuEngine.open(snapshot, {
        clientX: Number.isFinite(menuOptions.clientX) ? menuOptions.clientX : (Number.isFinite(snapshot.anchorX) ? snapshot.anchorX : 16),
        clientY: Number.isFinite(menuOptions.clientY) ? menuOptions.clientY : (Number.isFinite(snapshot.anchorY) ? snapshot.anchorY : 16),
        triggerNode: triggerNode || diffEl,
        restoreFocusTarget: menuOptions.restoreFocusTarget || document.activeElement,
      });
    }

    async function postViewedMutation(path, payload) {
      const params = new URLSearchParams(queryForViewState(currentViewState));
      const res = await fetch(path + "?" + params.toString(), {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify(payload || {}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || "Viewed-state update failed.");
      }
      return data;
    }

    function currentModeFileRows() {
      if (!currentData) {
        return [];
      }
      if (currentViewState.mode === "compare" || currentViewState.mode === "review") {
        return Array.isArray(currentData.rows) ? currentData.rows : [];
      }
      return Array.isArray(currentData.fileRows) ? currentData.fileRows : [];
    }

    function currentSelectionChildFileRows(node) {
      if (!currentData || !node || typeof node !== "object") {
        return [];
      }
      const selectionKind = String(node.selection_kind || "file");
      if (selectionKind !== "repo" && selectionKind !== "category") {
        return [];
      }
      const grouped = previewSelectionGroups(currentViewState, currentData);
      if (selectionKind === "repo") {
        return grouped.rowsByRepo.get(String(node.repo || "")) || [];
      }
      return grouped.rowsByRepoCategory.get(
        repoCategoryClientKey(String(node.repo || ""), String(node.category || ""))
      ) || [];
    }

    function viewedSelectionScopeStats(node) {
      const rows = currentSelectionChildFileRows(node);
      let markableCount = 0;
      let unmarkableCount = 0;
      for (const row of rows) {
        const state = String(row && row.view_state ? row.view_state : VIEW_STATE_UNVIEWED);
        if (state === VIEW_STATE_UNVIEWED || state === VIEW_STATE_CHANGED) {
          markableCount += 1;
        }
        if (state === VIEW_STATE_VIEWED || state === VIEW_STATE_CHANGED) {
          unmarkableCount += 1;
        }
      }
      return {
        rows,
        rowCount: rows.length,
        markableCount,
        unmarkableCount,
      };
    }

    function confirmLargeViewedSelection(node, stats) {
      const selectionStats = stats && typeof stats === "object" ? stats : viewedSelectionScopeStats(node);
      if (VIEWED_BULK_CONFIRM_ROWS <= 0 || selectionStats.rowCount <= VIEWED_BULK_CONFIRM_ROWS) {
        return true;
      }
      const selectionKind = String(node && node.selection_kind ? node.selection_kind : "");
      const scopeLabel = selectionKind === "category"
        ? "this category"
        : "this repo";
      return window.confirm(
        "Mark " + String(selectionStats.rowCount) + " visible file rows as viewed for " + scopeLabel + "?\\n\\n" +
        "This captures a stored preview snapshot for each visible row and can take time on large selections."
      );
    }

    function rowIdentityKeyValue(rowOrNode) {
      if (!rowOrNode) {
        return "";
      }
      return buildRowIdentityKeyShared(
        currentViewState.mode,
        rowOrNode.repo || "",
        (currentViewState.mode === "browse" || currentViewState.mode === "inspect") ? (rowOrNode.category || "") : "",
        rowOrNode.file || ""
      );
    }

    function applyViewedStateCountsToCurrentData(counts) {
      if (!currentData) {
        return;
      }
      const rawCounts = counts && typeof counts === "object" ? counts : {};
      const rawByMode = rawCounts.by_mode && typeof rawCounts.by_mode === "object" ? rawCounts.by_mode : {};
      const byMode = {};
      for (const [mode, value] of Object.entries(rawByMode)) {
        byMode[String(mode || "")] = Math.max(0, Number(value || 0) || 0);
      }
      currentData.viewedStateCounts = {
        all: Math.max(0, Number(rawCounts.all || 0) || 0),
        by_mode: byMode,
      };
    }

    function updateViewedStateForCurrentModeRows(mutateRow) {
      const mutate = typeof mutateRow === "function" ? mutateRow : null;
      if (!mutate) {
        return 0;
      }
      let changedCount = 0;
      for (const row of currentModeFileRows()) {
        if (!row || typeof row !== "object") {
          continue;
        }
        if (mutate(row) === true) {
          changedCount += 1;
        }
      }
      return changedCount;
    }

    function snapshotCurrentModeViewedState() {
      const snapshot = {
        counts: snapshotViewedStateCounts(),
        rows: {},
      };
      for (const row of currentModeFileRows()) {
        if (!row || typeof row !== "object") {
          continue;
        }
        snapshot.rows[rowIdentityKeyValue(row)] = {
          view_state: String(row.view_state || VIEW_STATE_UNVIEWED),
          view_marked_at: String(row.view_marked_at || ""),
          view_blob_available: String(row.view_blob_available || "false"),
          view_token: Object.prototype.hasOwnProperty.call(row, "view_token")
            ? String(row.view_token || "")
            : "",
        };
      }
      return snapshot;
    }

    function restoreCurrentModeViewedState(snapshot) {
      const stateSnapshot = snapshot && typeof snapshot === "object" ? snapshot : null;
      if (!stateSnapshot) {
        return;
      }
      applyViewedStateCountsSnapshot(stateSnapshot.counts);
      const rowsByKey = stateSnapshot.rows && typeof stateSnapshot.rows === "object"
        ? stateSnapshot.rows
        : {};
      for (const row of currentModeFileRows()) {
        if (!row || typeof row !== "object") {
          continue;
        }
        const saved = rowsByKey[rowIdentityKeyValue(row)];
        if (!saved || typeof saved !== "object") {
          row.view_state = VIEW_STATE_UNVIEWED;
          row.view_marked_at = "";
          row.view_blob_available = "false";
          continue;
        }
        row.view_state = String(saved.view_state || VIEW_STATE_UNVIEWED);
        row.view_marked_at = String(saved.view_marked_at || "");
        row.view_blob_available = String(saved.view_blob_available || "false");
        if (Object.prototype.hasOwnProperty.call(saved, "view_token")) {
          row.view_token = String(saved.view_token || "");
        }
      }
    }

    function applyViewedStateOverlayToCurrentData(overlay) {
      if (!currentData || !overlay || typeof overlay !== "object") {
        return 0;
      }
      if (String(overlay.mode || "") !== String(currentViewState.mode || "")) {
        return 0;
      }
      applyViewedStateCountsToCurrentData(overlay.counts);
      const rowOverlays = overlay.row_overlays && typeof overlay.row_overlays === "object"
        ? overlay.row_overlays
        : {};
      let changedCount = 0;
      for (const row of currentModeFileRows()) {
        if (!row || typeof row !== "object") {
          continue;
        }
        const rowOverlay = rowOverlays[rowIdentityKeyValue(row)];
        if (!rowOverlay || typeof rowOverlay !== "object") {
          continue;
        }
        row.view_state = String(rowOverlay.view_state || VIEW_STATE_UNVIEWED);
        row.view_marked_at = String(rowOverlay.view_marked_at || "");
        row.view_blob_available = String(rowOverlay.view_blob_available || "false");
        if (Object.prototype.hasOwnProperty.call(rowOverlay, "view_token")) {
          row.view_token = String(rowOverlay.view_token || "");
        }
        changedCount += 1;
      }
      return changedCount;
    }

    function refreshViewedUiAfterLocalMutation(options) {
      const refreshOptions = options && typeof options === "object" ? options : {};
      renderList();
      syncViewedActionsState();
      const selectedRow = findCurrentRowBySelectionKey();
      currentPreviewRow = selectedRow || null;
      if (refreshOptions.reloadSelectedPreview === true && selectedRow) {
        const selectedKey = rowSelectionKey(selectedRow);
        const rowNode = rowButtons().find((node) => node.dataset.rowKey === selectedKey) || null;
        if (rowNode) {
          selectRow(selectedRow, rowNode, true, {
            previewVariant: PREVIEW_VARIANT_CURRENT,
          }).catch((err) => {
            if (!isAbortError(err)) {
              setDiffText((err && err.message) ? err.message : "Failed to load preview.");
            }
          });
          return;
        }
      }
      syncOpenButtonState();
      syncPreviewControlsState();
    }

    function updateViewedStateForSelectionRows(node, mutateRow) {
      const mutate = typeof mutateRow === "function" ? mutateRow : null;
      if (!mutate) {
        return 0;
      }
      let changedCount = 0;
      for (const row of currentSelectionChildFileRows(node)) {
        if (!row || typeof row !== "object") {
          continue;
        }
        if (mutate(row) === true) {
          changedCount += 1;
        }
      }
      return changedCount;
    }

    async function markViewedForNode(node) {
      if (!node || String(node.selection_kind || "file") !== "file") {
        return;
      }
      const selectedKey = selectionKeyValue;
      const targetKey = rowSelectionKey(node);
      const targetRowBefore = currentModeFileRows().find((row) => rowSelectionKey(row) === targetKey) || node;
      const stateSnapshot = snapshotCurrentModeViewedState();
      const countsBefore = snapshotViewedStateCounts();
      const countDelta = viewedStateEntryCount(VIEW_STATE_VIEWED) - viewedStateEntryCount(targetRowBefore && targetRowBefore.view_state);
      const previousPreviewVariant = currentPreviewVariant;
      const requestViewMode = String(currentViewState.mode || "");
      currentPreviewVariant = PREVIEW_VARIANT_CURRENT;
      const optimisticMarkedAt = new Date().toISOString();
      updateViewedStateForCurrentModeRows((row) => {
        if (rowSelectionKey(row) !== targetKey) {
          return false;
        }
        row.view_state = VIEW_STATE_VIEWED;
        row.view_marked_at = optimisticMarkedAt;
        row.view_blob_available = "true";
        return true;
      });
      applyViewedStateCountsSnapshot(viewedStateCountsWithDelta(countsBefore, countDelta));
      refreshViewedUiAfterLocalMutation();
      let result = null;
      try {
        result = await postViewedMutation("/api/viewed/mark", {
          repo: String(node.repo || ""),
          category: String(node.category || ""),
          file: String(node.file || ""),
        });
      } catch (err) {
        currentPreviewVariant = previousPreviewVariant;
        restoreCurrentModeViewedState(stateSnapshot);
        refreshViewedUiAfterLocalMutation();
        throw err;
      }
      if (String(currentViewState.mode || "") !== requestViewMode) {
        return;
      }
      applyViewedStateOverlayToCurrentData(result && result.overlay);
      const markedAt = String(result && result.marked_at ? result.marked_at : new Date().toISOString());
      updateViewedStateForCurrentModeRows((row) => {
        if (rowSelectionKey(row) !== targetKey) {
          return false;
        }
        row.view_state = VIEW_STATE_VIEWED;
        row.view_marked_at = markedAt;
        row.view_blob_available = String(result && result.view_blob_available ? result.view_blob_available : "true");
        if (Object.prototype.hasOwnProperty.call(result || {}, "view_token")) {
          row.view_token = String(result && result.view_token ? result.view_token : "");
        }
        return true;
      });
      reconcileViewedStateCountsAfterMutation(countsBefore, { delta: countDelta, label: "mark-file" }, result && result.counts);
      refreshViewedUiAfterLocalMutation({
        reloadSelectedPreview: previousPreviewVariant === PREVIEW_VARIANT_SINCE_VIEWED && selectedKey === targetKey,
      });
    }

    async function markViewedForSelectionScope(node) {
      const selectionKind = String(node && node.selection_kind ? node.selection_kind : "");
      if (selectionKind !== "repo" && selectionKind !== "category") {
        return;
      }
      const scopeStats = viewedSelectionScopeStats(node);
      const rowsBefore = scopeStats.rows;
      if (!rowsBefore.length) {
        return;
      }
      if (!confirmLargeViewedSelection(node, scopeStats)) {
        return;
      }
      const stateSnapshot = snapshotCurrentModeViewedState();
      const countsBefore = snapshotViewedStateCounts();
      const countDelta = rowsBefore.reduce((sum, row) => {
        return sum + (viewedStateEntryCount(row && row.view_state) === 0 ? 1 : 0);
      }, 0);
      const requestViewMode = String(currentViewState.mode || "");
      const optimisticMarkedAt = new Date().toISOString();
      updateViewedStateForSelectionRows(node, (row) => {
        const state = String(row && row.view_state ? row.view_state : VIEW_STATE_UNVIEWED);
        if (state === VIEW_STATE_VIEWED && row.view_marked_at === optimisticMarkedAt) {
          return false;
        }
        row.view_state = VIEW_STATE_VIEWED;
        row.view_marked_at = optimisticMarkedAt;
        row.view_blob_available = "true";
        return true;
      });
      applyViewedStateCountsSnapshot(viewedStateCountsWithDelta(countsBefore, countDelta));
      refreshViewedUiAfterLocalMutation();
      let result = null;
      try {
        result = await postViewedMutation("/api/viewed/mark-bulk", {
          selection_kind: selectionKind,
          repo: String(node && node.repo ? node.repo : ""),
          category: String(node && node.category ? node.category : ""),
          confirm_large: scopeStats.rowCount > VIEWED_BULK_CONFIRM_ROWS,
        });
      } catch (err) {
        restoreCurrentModeViewedState(stateSnapshot);
        refreshViewedUiAfterLocalMutation();
        throw err;
      }
      if (String(currentViewState.mode || "") !== requestViewMode) {
        return;
      }
      applyViewedStateOverlayToCurrentData(result && result.overlay);
      const markedAt = String(result && result.marked_at ? result.marked_at : new Date().toISOString());
      updateViewedStateForSelectionRows(node, (row) => {
        const state = String(row && row.view_state ? row.view_state : VIEW_STATE_UNVIEWED);
        if (state === VIEW_STATE_VIEWED && row.view_marked_at === markedAt) {
          return false;
        }
        row.view_state = VIEW_STATE_VIEWED;
        row.view_marked_at = markedAt;
        if (!Object.prototype.hasOwnProperty.call(row, "view_blob_available")) {
          row.view_blob_available = "false";
        }
        return true;
      });
      reconcileViewedStateCountsAfterMutation(countsBefore, { delta: countDelta, label: "mark-bulk" }, result && result.counts);
      refreshViewedUiAfterLocalMutation();
    }

    async function unmarkViewedForNode(node) {
      if (!node || String(node.selection_kind || "file") !== "file") {
        return;
      }
      const selectedKey = selectionKeyValue;
      const targetKey = rowSelectionKey(node);
      const targetRowBefore = currentModeFileRows().find((row) => rowSelectionKey(row) === targetKey) || node;
      const stateSnapshot = snapshotCurrentModeViewedState();
      const countsBefore = snapshotViewedStateCounts();
      const countDelta = -viewedStateEntryCount(targetRowBefore && targetRowBefore.view_state);
      const previousPreviewVariant = currentPreviewVariant;
      const requestViewMode = String(currentViewState.mode || "");
      currentPreviewVariant = PREVIEW_VARIANT_CURRENT;
      updateViewedStateForCurrentModeRows((row) => {
        if (rowSelectionKey(row) !== targetKey) {
          return false;
        }
        row.view_state = VIEW_STATE_UNVIEWED;
        row.view_marked_at = "";
        row.view_blob_available = "false";
        return true;
      });
      applyViewedStateCountsSnapshot(viewedStateCountsWithDelta(countsBefore, countDelta));
      refreshViewedUiAfterLocalMutation();
      let result = null;
      try {
        result = await postViewedMutation("/api/viewed/unmark", {
          repo: String(node.repo || ""),
          category: String(node.category || ""),
          file: String(node.file || ""),
        });
      } catch (err) {
        currentPreviewVariant = previousPreviewVariant;
        restoreCurrentModeViewedState(stateSnapshot);
        refreshViewedUiAfterLocalMutation();
        throw err;
      }
      if (String(currentViewState.mode || "") !== requestViewMode) {
        return;
      }
      applyViewedStateOverlayToCurrentData(result && result.overlay);
      updateViewedStateForCurrentModeRows((row) => {
        if (rowSelectionKey(row) !== targetKey) {
          return false;
        }
        row.view_state = VIEW_STATE_UNVIEWED;
        row.view_marked_at = "";
        row.view_blob_available = "false";
        return true;
      });
      reconcileViewedStateCountsAfterMutation(countsBefore, { delta: countDelta, label: "unmark-file" }, result && result.counts);
      refreshViewedUiAfterLocalMutation({
        reloadSelectedPreview: previousPreviewVariant === PREVIEW_VARIANT_SINCE_VIEWED && selectedKey === targetKey,
      });
    }

    async function unmarkViewedForSelectionScope(node) {
      const selectionKind = String(node && node.selection_kind ? node.selection_kind : "");
      if (selectionKind !== "repo" && selectionKind !== "category") {
        return;
      }
      const rowsBefore = currentSelectionChildFileRows(node);
      const stateSnapshot = snapshotCurrentModeViewedState();
      const countsBefore = snapshotViewedStateCounts();
      const countDelta = -rowsBefore.reduce((sum, row) => {
        return sum + viewedStateEntryCount(row && row.view_state);
      }, 0);
      const requestViewMode = String(currentViewState.mode || "");
      updateViewedStateForSelectionRows(node, (row) => {
        const state = String(row && row.view_state ? row.view_state : VIEW_STATE_UNVIEWED);
        if (state !== VIEW_STATE_VIEWED && state !== VIEW_STATE_CHANGED) {
          return false;
        }
        row.view_state = VIEW_STATE_UNVIEWED;
        row.view_marked_at = "";
        row.view_blob_available = "false";
        return true;
      });
      applyViewedStateCountsSnapshot(viewedStateCountsWithDelta(countsBefore, countDelta));
      refreshViewedUiAfterLocalMutation();
      let result = null;
      try {
        result = await postViewedMutation("/api/viewed/unmark-bulk", {
          selection_kind: selectionKind,
          repo: String(node && node.repo ? node.repo : ""),
          category: String(node && node.category ? node.category : ""),
        });
      } catch (err) {
        restoreCurrentModeViewedState(stateSnapshot);
        refreshViewedUiAfterLocalMutation();
        throw err;
      }
      if (String(currentViewState.mode || "") !== requestViewMode) {
        return;
      }
      applyViewedStateOverlayToCurrentData(result && result.overlay);
      updateViewedStateForSelectionRows(node, (row) => {
        const state = String(row && row.view_state ? row.view_state : VIEW_STATE_UNVIEWED);
        if (state !== VIEW_STATE_VIEWED && state !== VIEW_STATE_CHANGED) {
          return false;
        }
        row.view_state = VIEW_STATE_UNVIEWED;
        row.view_marked_at = "";
        row.view_blob_available = "false";
        return true;
      });
      reconcileViewedStateCountsAfterMutation(countsBefore, { delta: countDelta, label: "unmark-bulk" }, result && result.counts);
      refreshViewedUiAfterLocalMutation();
    }

    async function clearViewed(scope) {
      const counts = currentViewedStateCounts();
      const stateSnapshot = snapshotCurrentModeViewedState();
      const countsBefore = snapshotViewedStateCounts();
      const normalizedScope = scope === "all" ? "all" : "mode";
      const clearCount = normalizedScope === "all" ? counts.all : counts.currentMode;
      if (clearCount <= 0) {
        return;
      }
      const message = normalizedScope === "all"
        ? ("Clear all " + clearCount + " viewed entries for this root repo?")
        : ("Clear " + clearCount + " viewed entr" + (clearCount === 1 ? "y" : "ies") + " in " + modeDisplayLabelClient(currentViewState.mode) + "?");
      if (!window.confirm(message)) {
        return;
      }
      const selectedKey = selectionKeyValue;
      const previousPreviewVariant = currentPreviewVariant;
      const requestViewMode = String(currentViewState.mode || "");
      currentPreviewVariant = PREVIEW_VARIANT_CURRENT;
      updateViewedStateForCurrentModeRows((row) => {
        const state = String(row && row.view_state ? row.view_state : "");
        if (state !== VIEW_STATE_VIEWED && state !== VIEW_STATE_CHANGED) {
          return false;
        }
        row.view_state = VIEW_STATE_UNVIEWED;
        row.view_marked_at = "";
        row.view_blob_available = "false";
        return true;
      });
      const optimisticCounts = normalizedScope === "all"
        ? { all: 0, byMode: { browse: 0, compare: 0, inspect: 0, review: 0 } }
        : (() => {
            const nextCounts = normalizeViewedStateCountsSnapshot(countsBefore);
            const currentModeCount = nextCounts.byMode[currentViewState.mode] || 0;
            nextCounts.all = Math.max(0, nextCounts.all - currentModeCount);
            nextCounts.byMode[currentViewState.mode] = 0;
            return nextCounts;
          })();
      applyViewedStateCountsSnapshot(optimisticCounts);
      refreshViewedUiAfterLocalMutation();
      let result = null;
      try {
        result = await postViewedMutation("/api/viewed/clear", {
          scope: normalizedScope,
          mode: currentViewState.mode,
        });
      } catch (err) {
        currentPreviewVariant = previousPreviewVariant;
        restoreCurrentModeViewedState(stateSnapshot);
        refreshViewedUiAfterLocalMutation();
        throw err;
      }
      if (String(currentViewState.mode || "") !== requestViewMode) {
        return;
      }
      const selectedRowBeforeClear = selectedKey ? findCurrentRowBySelectionKey() : null;
      const shouldReloadSelectedPreview = previousPreviewVariant === PREVIEW_VARIANT_SINCE_VIEWED
        && Boolean(selectedKey)
        && String(selectedRowBeforeClear && selectedRowBeforeClear.selection_kind ? selectedRowBeforeClear.selection_kind : "") === "file";
      applyViewedStateOverlayToCurrentData(result && result.overlay);
      const expectedCounts = normalizedScope === "all"
        ? { all: 0, byMode: { browse: 0, compare: 0, inspect: 0, review: 0 } }
        : (() => {
            const nextCounts = normalizeViewedStateCountsSnapshot(countsBefore);
            const currentModeCount = nextCounts.byMode[currentViewState.mode] || 0;
            nextCounts.all = Math.max(0, nextCounts.all - currentModeCount);
            nextCounts.byMode[currentViewState.mode] = 0;
            return nextCounts;
          })();
      reconcileViewedStateCountsAfterMutation(countsBefore, { snapshot: expectedCounts, label: "clear-viewed" }, result && result.counts);
      refreshViewedUiAfterLocalMutation({
        reloadSelectedPreview: shouldReloadSelectedPreview,
      });
    }

    function renderViewedStatePill(row) {
      const state = String(row && row.view_state ? row.view_state : "");
      if (state === VIEW_STATE_VIEWED) {
        const hasHistory = rowHasViewedPreviewHistory(row);
        return createTextPill(
          hasHistory ? "Viewed" : "Viewed (current only)",
          row && row.view_marked_at
            ? (
              "Viewed on " + formatViewedTimestamp(row.view_marked_at) + "." +
              (hasHistory ? "" : " Stored viewed history is unavailable for this row.")
            )
            : (hasHistory ? "Marked as viewed." : "Marked as viewed. Stored viewed history is unavailable for this row."),
          "viewed"
        );
      }
      if (state === VIEW_STATE_CHANGED) {
        const hasHistory = rowHasViewedPreviewHistory(row);
        return createTextPill(
          "Changed since viewed",
          row && row.view_marked_at
            ? (
              "Changed since viewed on " + formatViewedTimestamp(row.view_marked_at) + "." +
              (hasHistory ? "" : " Stored viewed history is unavailable, so only the current preview is available.")
            )
            : (
              hasHistory
                ? "This file changed after it was marked as viewed."
                : "This file changed after it was marked as viewed. Stored viewed history is unavailable, so only the current preview is available."
            ),
          "warning"
        );
      }
      return null;
    }

    function createRowContextMenuTrigger(node, rowButton, menuLabel) {
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "row-menu-trigger";
      trigger.textContent = "⋯";
      trigger.setAttribute("aria-haspopup", "menu");
      trigger.setAttribute("aria-label", menuLabel || ("Row actions for " + (node && node.file ? node.file : "selected row")));
      trigger.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = trigger.getBoundingClientRect();
        openRowContextMenu(node, rowButton, trigger, {
          clientX: rect.left,
          clientY: rect.bottom + 6,
        });
      });
      return trigger;
    }

    function createContextMenuSelectionShell(node, rowButton, shellClassName, menuLabel) {
      const shell = document.createElement("div");
      shell.className = shellClassName;
      const menuTrigger = createRowContextMenuTrigger(node, rowButton, menuLabel);
      shell.addEventListener("contextmenu", (event) => {
        if (event.target === menuTrigger) {
          return;
        }
        event.preventDefault();
        openRowContextMenu(node, rowButton, menuTrigger, {
          clientX: event.clientX,
          clientY: event.clientY,
          loadPreviewOnOpen: String(node && node.selection_kind ? node.selection_kind : "file") === "file",
        });
      });
      if (rowSelectionKey(node) === selectionKeyValue) {
        shell.classList.add("active");
      }
      shell.append(rowButton, menuTrigger);
      return shell;
    }

    function createFileRowShell(node, ariaLabel, contentNode) {
      const rowButton = document.createElement("button");
      bindSelectionButton(rowButton, node, ariaLabel);
      rowButton.appendChild(contentNode);
      return createContextMenuSelectionShell(node, rowButton, "file-row-shell", "Row actions for " + (node && node.file ? node.file : "selected file"));
    }

    function createSelectionRowShell(node, rowButton, menuLabel) {
      return createContextMenuSelectionShell(node, rowButton, "selection-row-shell", menuLabel);
    }

    function renderSinceViewedSummary(data) {
      closeDiffSelectionContextMenu(false);
      clearDiffSelectionActionSnapshot();
      const payload = data && typeof data === "object" ? data : {};
      diffEl.className = "diff-view aggregate-preview";
      const fragments = [];
      const summary = document.createElement("div");
      summary.className = "aggregate-preview-summary";
      const title = document.createElement("div");
      title.className = "aggregate-preview-title";
      title.textContent = "Since viewed";
      summary.appendChild(title);
      const subtitle = document.createElement("div");
      subtitle.className = "aggregate-preview-subtitle";
      const subtitleParts = [];
      if (payload.file) {
        subtitleParts.push(String(payload.file));
      }
      if (payload.marked_at) {
        subtitleParts.push("viewed on " + formatViewedTimestamp(payload.marked_at));
      }
      subtitle.textContent = subtitleParts.join(" · ");
      summary.appendChild(subtitle);
      fragments.push(summary);

      const sections = [
        { label: "Viewed", snapshot: payload.previous || null },
        { label: "Current", snapshot: payload.current || null },
      ];
      for (const section of sections) {
        const block = document.createElement("section");
        block.className = "aggregate-preview-block";
        const header = document.createElement("div");
        header.className = "aggregate-preview-block-header";
        const pathNode = document.createElement("div");
        pathNode.className = "aggregate-preview-block-path";
        pathNode.textContent = section.label;
        header.appendChild(pathNode);
        const meta = document.createElement("div");
        meta.className = "aggregate-preview-block-meta";
        meta.appendChild(createTextPill(String(section.snapshot && section.snapshot.preview_kind ? section.snapshot.preview_kind : "unavailable").split("_").join(" ")));
        header.appendChild(meta);
        block.appendChild(header);
        if (section.snapshot && section.snapshot.preview_kind === "submodule_summary") {
          block.appendChild(buildSubmoduleSummaryCard(section.snapshot.data || {}));
        } else if (section.snapshot && section.snapshot.preview_kind === "text") {
          block.appendChild(buildPlainPreviewNode(section.snapshot.text || "", { className: "aggregate-preview-pre" }));
        } else {
          block.appendChild(buildPlainPreviewNode("Preview unavailable.", { className: "aggregate-preview-pre" }));
        }
        fragments.push(block);
      }

      diffEl.replaceChildren(...fragments);
      if (previewPanelEl) {
        previewPanelEl.scrollTop = 0;
        previewPanelEl.scrollLeft = 0;
      }
    }

    registerRowContextMenuCategory({
      id: "view-state",
      label: "View state",
      priority: 10,
    });
    registerRowContextMenuItem({
      id: "mark-viewed",
      category: "view-state",
      priority: 10,
      appliesTo(node) {
        return Boolean(node && String(node.selection_kind || "") === "file" && String(node.view_state || VIEW_STATE_UNVIEWED) === VIEW_STATE_UNVIEWED);
      },
      buildAction(node) {
        return {
          label: "Mark as viewed",
          title: "Remember the current version of this file row as viewed.",
          onSelect() {
            return markViewedForNode(node);
          },
        };
      },
    });
    registerRowContextMenuItem({
      id: "remark-viewed",
      category: "view-state",
      priority: 20,
      appliesTo(node) {
        return Boolean(node && String(node.selection_kind || "") === "file" && String(node.view_state || "") === VIEW_STATE_CHANGED);
      },
      buildAction(node) {
        return {
          label: "Mark current version as viewed",
          title: "Replace the stored viewed snapshot with the current version of this file row.",
          onSelect() {
            return markViewedForNode(node);
          },
        };
      },
    });
    registerRowContextMenuItem({
      id: "unmark-viewed",
      category: "view-state",
      priority: 30,
      appliesTo(node) {
        const state = String(node && node.view_state ? node.view_state : "");
        return Boolean(node && String(node.selection_kind || "") === "file" && (state === VIEW_STATE_VIEWED || state === VIEW_STATE_CHANGED));
      },
      buildAction(node) {
        return {
          label: "Unmark as viewed",
          title: "Remove the stored viewed state for this file row.",
          onSelect() {
            return unmarkViewedForNode(node);
          },
        };
      },
    });
    registerRowContextMenuItem({
      id: "mark-viewed-selection",
      category: "view-state",
      priority: 40,
      appliesTo(node) {
        const selectionKind = String(node && node.selection_kind ? node.selection_kind : "");
        if (selectionKind !== "repo" && selectionKind !== "category") {
          return false;
        }
        return viewedSelectionScopeStats(node).markableCount > 0;
      },
      buildAction(node) {
        const stats = viewedSelectionScopeStats(node);
        const selectionKind = String(node && node.selection_kind ? node.selection_kind : "");
        const scopeText = selectionKind === "category"
          ? "visible file rows in this category"
          : "visible file rows in this repo";
        return {
          label: "Mark all as viewed (" + String(stats.markableCount) + ")",
          title: "Mark all " + String(stats.markableCount) + " " + scopeText + " as viewed.",
          onSelect() {
            return markViewedForSelectionScope(node);
          },
        };
      },
    });
    registerRowContextMenuItem({
      id: "unmark-viewed-selection",
      category: "view-state",
      priority: 50,
      appliesTo(node) {
        const selectionKind = String(node && node.selection_kind ? node.selection_kind : "");
        if (selectionKind !== "repo" && selectionKind !== "category") {
          return false;
        }
        return viewedSelectionScopeStats(node).unmarkableCount > 0;
      },
      buildAction(node) {
        const stats = viewedSelectionScopeStats(node);
        const selectionKind = String(node && node.selection_kind ? node.selection_kind : "");
        const scopeText = selectionKind === "category"
          ? "visible file rows in this category"
          : "visible file rows in this repo";
        return {
          label: "Unmark all as viewed (" + String(stats.unmarkableCount) + ")",
          title: "Remove viewed state for all " + String(stats.unmarkableCount) + " " + scopeText + ".",
          onSelect() {
            return unmarkViewedForSelectionScope(node);
          },
        };
      },
    });

    registerDiffSelectionContextMenuCategory({
      id: "clipboard",
      label: "Clipboard",
      priority: 10,
    });
    registerDiffSelectionContextMenuCategory({
      id: "ask",
      label: "Ask",
      priority: 20,
    });
    registerDiffSelectionContextMenuItem({
      id: "copy-selection",
      category: "clipboard",
      priority: 10,
      appliesTo(selectionSnapshot) {
        return Boolean(selectionSnapshot && String(selectionSnapshot.text || ""));
      },
      buildAction(selectionSnapshot) {
        return {
          label: "Copy",
          title: "Copy the exact selected diff text.",
          async onSelect() {
            const copied = await copyTextToClipboardClient(String(selectionSnapshot && selectionSnapshot.text ? selectionSnapshot.text : ""), {
              context: "diff-selection-copy",
            });
            if (!copied) {
              showClientToast("Failed to copy the selected text.", "error");
              return;
            }
            showClientToast("Selection copied.", "");
          },
        };
      },
    });
    registerDiffSelectionContextMenuItem({
      id: "ask-selection",
      category: "ask",
      priority: 10,
      appliesTo(selectionSnapshot) {
        return Boolean(selectionSnapshot && String(selectionSnapshot.text || ""));
      },
      buildAction(selectionSnapshot) {
        const template = findAskTemplateDefinition(DEFAULT_ASK_TEMPLATE_ID);
        return {
          label: String(template && template.label ? template.label : "Ask"),
          title: "Build a reusable prompt from the selected text.",
          onSelect() {
            openAskPromptDialog(template, selectionSnapshot, document.activeElement);
          },
        };
      },
    });

    function renderSnapshotPickerPanel() {
      snapshotListEl.innerHTML = "";
      const selectedSnapshotId = selectedSnapshotIdValue();
      const hasSnapshots = snapshots.length > 0;
      snapshotEmptyEl.classList.toggle("hidden", hasSnapshots);
      if (!hasSnapshots) {
        return;
      }

      const nodes = snapshots.map((snapshot) => {
        const snapshotId = String(snapshot.id || "");
        const entry = document.createElement("div");
        entry.className = "snapshot-entry";
        entry.dataset.snapshotId = snapshotId;
        if (snapshotId === selectedSnapshotId) {
          entry.classList.add("active");
        }

        const selectBtn = document.createElement("button");
        selectBtn.type = "button";
        selectBtn.className = "snapshot-entry-select";
        selectBtn.setAttribute("aria-pressed", snapshotId === selectedSnapshotId ? "true" : "false");
        selectBtn.setAttribute("aria-label", "Select snapshot " + snapshotId);
        selectBtn.onclick = () => {
          applySnapshotSelection(snapshotId).catch((err) => alert(String(err)));
        };

        const main = document.createElement("div");
        main.className = "snapshot-entry-main";

        const top = document.createElement("div");
        top.className = "snapshot-entry-top";

        const idNode = document.createElement("div");
        idNode.className = "snapshot-entry-id";
        idNode.textContent = snapshotId;
        top.appendChild(idNode);

        if (snapshot.origin === "auto") {
          const originBadge = document.createElement("span");
          originBadge.className = "snapshot-origin-badge";
          originBadge.textContent = "auto";
          top.appendChild(originBadge);
        }

        const metaNode = document.createElement("div");
        metaNode.className = "snapshot-entry-meta";
        metaNode.textContent = snapshotMetaTextClient(snapshot);

        main.appendChild(top);
        main.appendChild(metaNode);
        selectBtn.appendChild(main);
        entry.appendChild(selectBtn);

        const actions = document.createElement("div");
        actions.className = "snapshot-entry-actions";

        const renameBtn = document.createElement("button");
        renameBtn.type = "button";
        renameBtn.className = "snapshot-entry-action rename";
        renameBtn.textContent = "Rename";
        renameBtn.setAttribute("aria-label", "Rename snapshot " + snapshotId);
        renameBtn.onclick = (event) => {
          event.stopPropagation();
          openRenameSnapshotDialog(snapshot);
        };
        actions.appendChild(renameBtn);

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "snapshot-entry-action delete";
        deleteBtn.textContent = "Delete";
        deleteBtn.setAttribute("aria-label", "Delete snapshot " + snapshotId);
        deleteBtn.onclick = (event) => {
          event.stopPropagation();
          openDeleteSnapshotDialog(snapshot);
        };
        actions.appendChild(deleteBtn);

        entry.appendChild(actions);
        return entry;
      });

      snapshotListEl.replaceChildren(...nodes);
    }

    function findSnapshotEntryNode(snapshotId) {
      const targetId = String(snapshotId || "");
      return Array.from(snapshotListEl.querySelectorAll(".snapshot-entry")).find((entry) => {
        return String(entry.dataset.snapshotId || "") === targetId;
      }) || null;
    }

    function focusSnapshotEntryControl(snapshotId, selector) {
      const entry = findSnapshotEntryNode(snapshotId);
      if (!entry) {
        return false;
      }
      const target = selector ? entry.querySelector(selector) : entry.querySelector(".snapshot-entry-select");
      if (!target || typeof target.focus !== "function") {
        return false;
      }
      target.focus();
      return true;
    }

    function syncSnapshotPickerState() {
      const selectedSnapshotId = selectedSnapshotIdValue();
      const selectedSnapshot = findSnapshotById(selectedSnapshotId);
      if (selectedSnapshot) {
        snapshotPickerPrimary.textContent = selectedSnapshot.id;
        snapshotPickerButton.title = selectedSnapshot.id;
      } else if (selectedSnapshotId) {
        snapshotPickerPrimary.textContent = selectedSnapshotId;
        snapshotPickerButton.title = selectedSnapshotId;
      } else {
        snapshotPickerPrimary.textContent = "No snapshots available";
        snapshotPickerButton.title = "No snapshots available";
      }
      snapshotPickerButton.disabled = snapshots.length === 0;
      snapshotPickerButton.setAttribute("aria-expanded", isSnapshotPanelOpen() ? "true" : "false");
      syncSnapshotShowAutoControl();
      renderSnapshotPickerPanel();
    }

    function firstVisibleSnapshotEntry() {
      const selectedEntry = snapshotListEl.querySelector(".snapshot-entry.active .snapshot-entry-select");
      if (selectedEntry) {
        return selectedEntry;
      }
      return snapshotListEl.querySelector(".snapshot-entry-select");
    }

    function positionSnapshotPanel() {
      if (!isSnapshotPanelOpen()) {
        return;
      }
      if (window.matchMedia("(max-width: 700px)").matches) {
        snapshotPanel.style.top = "";
        snapshotPanel.style.left = "";
        snapshotPanel.style.right = "";
        return;
      }

      const buttonRect = snapshotPickerButton.getBoundingClientRect();
      const panelRect = snapshotPanel.getBoundingClientRect();
      const margin = 12;
      const maxLeft = Math.max(margin, window.innerWidth - panelRect.width - margin);
      const left = Math.min(Math.max(buttonRect.left, margin), maxLeft);
      const top = Math.min(buttonRect.bottom + 10, Math.max(margin, window.innerHeight - panelRect.height - margin));
      snapshotPanel.style.left = Math.round(left) + "px";
      snapshotPanel.style.top = Math.round(top) + "px";
      snapshotPanel.style.right = "auto";
    }

    function closeSnapshotPanel(restoreFocus) {
      snapshotOverlay.classList.add("hidden");
      snapshotOverlay.setAttribute("aria-hidden", "true");
      snapshotPickerButton.setAttribute("aria-expanded", "false");
      snapshotPanel.style.top = "";
      snapshotPanel.style.left = "";
      snapshotPanel.style.right = "";
      syncBodyModalState();
      syncSnapshotPickerState();
      if (restoreFocus) {
        const target = snapshotPanelRestoreFocusTarget || snapshotPickerButton;
        snapshotPanelRestoreFocusTarget = null;
        if (target && typeof target.focus === "function") {
          target.focus();
        }
      }
    }

    function openSnapshotPanel() {
      if (isSnapshotPanelOpen()) {
        return;
      }
      closeAllFilterableSelects(false);
      if (isRefreshMenuOpen()) {
        closeRefreshMenu(false);
      }
      if (isFiltersPanelOpen()) {
        closeFiltersPanel(false);
      }
      if (isCreateSnapshotDialogOpen()) {
        closeCreateSnapshotDialog();
      }
      if (isResetAllDialogOpen()) {
        closeResetAllDialog(false);
      }
      if (isResetAllConfirmDialogOpen()) {
        closeResetAllConfirmDialog(false);
      }
      if (isRenameSnapshotDialogOpen()) {
        closeRenameSnapshotDialog(false);
      }
      if (isDeleteSnapshotDialogOpen()) {
        closeDeleteSnapshotDialog(false);
      }
      if (isDiffSelectionContextMenuOpen()) {
        closeDiffSelectionContextMenu(false);
      }
      snapshotPanelRestoreFocusTarget = document.activeElement;
      renderSnapshotPickerPanel();
      snapshotOverlay.classList.remove("hidden");
      snapshotOverlay.setAttribute("aria-hidden", "false");
      snapshotPickerButton.setAttribute("aria-expanded", "true");
      syncBodyModalState();
      positionSnapshotPanel();
      const focusTarget = firstVisibleSnapshotEntry();
      if (focusTarget) {
        window.setTimeout(() => {
          if (isSnapshotPanelOpen()) {
            focusTarget.focus();
          }
        }, 0);
      }
    }

    function setRenameSnapshotStatus(message, kind) {
      renameSnapshotStatus.textContent = message || "";
      renameSnapshotStatus.classList.toggle("error", kind === "error");
    }

    function setRenameSnapshotDialogBusy(busy) {
      renameSnapshotInput.disabled = busy;
      renameSnapshotCancelBtn.disabled = busy;
      renameSnapshotSubmitBtn.disabled = busy;
    }

    function closeRenameSnapshotDialog(restoreFocus) {
      const targetSnapshotId = renameSnapshotTargetId;
      renameSnapshotTargetId = "";
      renameSnapshotDialog.classList.add("hidden");
      setRenameSnapshotDialogBusy(false);
      setRenameSnapshotStatus("", "");
      renameSnapshotInput.value = "";
      renameSnapshotMeta.textContent = "";
      syncBodyModalState();
      if (restoreFocus) {
        if (isSnapshotPanelOpen() && focusSnapshotEntryControl(targetSnapshotId, ".snapshot-entry-action.rename")) {
          return;
        }
        snapshotPickerButton.focus();
      }
    }

    function openRenameSnapshotDialog(snapshot) {
      const targetSnapshot = snapshot && snapshot.id ? snapshot : findSnapshotById(renameSnapshotTargetId || "");
      if (!targetSnapshot) {
        return;
      }
      if (isDeleteSnapshotDialogOpen()) {
        closeDeleteSnapshotDialog(false);
      }
      renameSnapshotTargetId = String(targetSnapshot.id || "");
      renameSnapshotDialog.classList.remove("hidden");
      renameSnapshotInput.value = renameSnapshotTargetId;
      renameSnapshotMeta.textContent = snapshotMetaTextClient(targetSnapshot);
      setRenameSnapshotStatus("", "");
      setRenameSnapshotDialogBusy(false);
      syncBodyModalState();
      window.setTimeout(() => {
        if (isRenameSnapshotDialogOpen()) {
          renameSnapshotInput.focus();
          renameSnapshotInput.select();
        }
      }, 0);
    }

    function setDeleteSnapshotStatus(message, kind) {
      deleteSnapshotStatus.textContent = message || "";
      deleteSnapshotStatus.classList.toggle("error", kind === "error");
    }

    function setDeleteSnapshotDialogBusy(busy) {
      deleteSnapshotCancelBtn.disabled = busy;
      deleteSnapshotConfirmBtn.disabled = busy;
    }

    function closeDeleteSnapshotDialog(restoreFocus) {
      const targetSnapshotId = deleteSnapshotTargetId;
      deleteSnapshotTargetId = "";
      deleteSnapshotDialog.classList.add("hidden");
      deleteSnapshotMessage.textContent = "";
      setDeleteSnapshotStatus("", "");
      setDeleteSnapshotDialogBusy(false);
      syncBodyModalState();
      if (restoreFocus) {
        if (isSnapshotPanelOpen() && focusSnapshotEntryControl(targetSnapshotId, ".snapshot-entry-action.delete")) {
          return;
        }
        snapshotPickerButton.focus();
      }
    }

    function openDeleteSnapshotDialog(snapshot) {
      const targetSnapshot = snapshot && snapshot.id ? snapshot : findSnapshotById(deleteSnapshotTargetId || "");
      if (!targetSnapshot) {
        return;
      }
      if (isRenameSnapshotDialogOpen()) {
        closeRenameSnapshotDialog(false);
      }
      deleteSnapshotTargetId = String(targetSnapshot.id || "");
      deleteSnapshotMessage.textContent = "Delete snapshot " + deleteSnapshotTargetId + "? " + snapshotMetaTextClient(targetSnapshot);
      setDeleteSnapshotStatus("", "");
      setDeleteSnapshotDialogBusy(false);
      deleteSnapshotDialog.classList.remove("hidden");
      syncBodyModalState();
      window.setTimeout(() => {
        if (isDeleteSnapshotDialogOpen()) {
          deleteSnapshotConfirmBtn.focus();
        }
      }, 0);
    }

    function optionRecordsFromSelect(selectNode, allowEmptyOption) {
      const records = [];
      for (const option of Array.from(selectNode ? selectNode.options : [])) {
        const value = String(option && option.value ? option.value : "");
        if (!allowEmptyOption && !value) {
          continue;
        }
        const label = String(option && option.textContent ? option.textContent : value);
        const description = String(option && option.dataset && option.dataset.description ? option.dataset.description : "");
        const helpText = String(option && option.dataset && option.dataset.help ? option.dataset.help : "");
        const extraSearchText = String(option && option.dataset && option.dataset.searchText ? option.dataset.searchText : "");
        records.push({
          value,
          label,
          description,
          helpText,
          searchText: [label, description, extraSearchText].filter(Boolean).join(" ").toLowerCase(),
        });
      }
      return records;
    }

    function createFilterableSelect(root, config) {
      if (!root) {
        return null;
      }

      root.classList.add("filterable-select");
      if (config.rootClassName) {
        root.classList.add(config.rootClassName);
      }
      root.innerHTML = "";
      const trigger = document.createElement("button");
      trigger.type = "button";
      trigger.className = "filterable-select-trigger";
      if (config.triggerClassName) {
        trigger.classList.add(...String(config.triggerClassName).split(/\s+/).filter(Boolean));
      }
      trigger.setAttribute("aria-expanded", "false");
      trigger.setAttribute("aria-label", config.ariaLabel || config.placeholderText || "Select");
      const triggerText = document.createElement("span");
      triggerText.className = "filterable-select-trigger-text filterable-select-placeholder";
      const triggerChevron = document.createElement("span");
      triggerChevron.className = "filterable-select-trigger-chevron";
      triggerChevron.setAttribute("aria-hidden", "true");
      triggerChevron.textContent = "▾";
      trigger.append(triggerText, triggerChevron);

      const popover = document.createElement("div");
      popover.className = "filterable-select-popover hidden";
      if (config.popoverClassName) {
        popover.classList.add(...String(config.popoverClassName).split(/\s+/).filter(Boolean));
      }
      popover.setAttribute("aria-hidden", "true");

      const searchInput = document.createElement("input");
      searchInput.type = "text";
      searchInput.className = "filterable-select-search";
      searchInput.autocomplete = "off";
      searchInput.spellcheck = false;
      searchInput.placeholder = config.searchPlaceholder || "Filter options…";

      const optionsEl = document.createElement("div");
      optionsEl.className = "filterable-select-options";

      const emptyEl = document.createElement("div");
      emptyEl.className = "filterable-select-empty hidden";
      emptyEl.textContent = config.noMatchesText || "No matching options";

      if (config.hideSearch === true) {
        popover.append(optionsEl, emptyEl);
      } else {
        popover.append(searchInput, optionsEl, emptyEl);
      }
      root.append(trigger, popover);

      const state = {
        options: [],
        filteredOptions: [],
        selectedValue: "",
        query: "",
        highlightedIndex: -1,
      };

      function findSelectedRecord() {
        return state.options.find((option) => option.value === state.selectedValue) || null;
      }

      function renderTrigger() {
        const selectedRecord = findSelectedRecord();
        const text = selectedRecord
          ? selectedRecord.label
          : (config.placeholderText || root.dataset.placeholder || "Select…");
        triggerText.textContent = text;
        triggerText.classList.toggle("filterable-select-placeholder", !selectedRecord);
        if (typeof config.renderTrigger === "function") {
          config.renderTrigger(trigger, triggerText, selectedRecord);
        }
      }

      function updateFilteredOptions() {
        const needle = state.query.trim().toLowerCase();
        state.filteredOptions = needle
          ? state.options.filter((option) => option.searchText.includes(needle))
          : state.options.slice();
        if (config.allowCustomValue === true) {
          const customValue = state.query.trim();
          const hasExactMatch = customValue
            ? state.options.some((option) => String(option.value || "").trim() === customValue)
            : false;
          if (customValue && !hasExactMatch) {
            state.filteredOptions.unshift({
              value: customValue,
              label: 'Use "' + customValue + '"',
              searchText: customValue.toLowerCase(),
              customValue: true,
            });
          }
        }
        if (!state.filteredOptions.length) {
          state.highlightedIndex = -1;
        } else if (state.highlightedIndex < 0 || state.highlightedIndex >= state.filteredOptions.length) {
          state.highlightedIndex = 0;
        }
      }

      function renderOptions() {
        updateFilteredOptions();
        optionsEl.innerHTML = "";
        emptyEl.classList.toggle("hidden", state.filteredOptions.length > 0);
        if (!state.filteredOptions.length) {
          return;
        }
        const nodes = state.filteredOptions.map((option, index) => {
          const optionState = {
            selected: option.value === state.selectedValue,
            highlighted: index === state.highlightedIndex,
          };
          const node = document.createElement("button");
          node.type = "button";
          node.className = "filterable-select-option";
          if (optionState.highlighted) {
            node.classList.add("filterable-select-option-active");
          }
          if (typeof config.renderOptionContent === "function") {
            config.renderOptionContent(node, option, optionState);
          } else {
            node.textContent = option.label;
          }
          node.dataset.value = option.value;
          const commitSelection = (event) => {
            if (event) {
              event.preventDefault();
            }
            closeFilterableSelect(false);
            void runGuardedUiAction(
              () => config.onSelect(option.value),
              { fallbackMessage: "Selection failed." }
            );
          };
          node.onmousedown = commitSelection;
          if (config.hideSearch === true) {
            node.addEventListener("keydown", (event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                moveHighlight(1);
                window.setTimeout(() => {
                  const activeNode = optionsEl.querySelector(".filterable-select-option-active");
                  if (activeNode) {
                    activeNode.focus();
                  }
                }, 0);
                return;
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                moveHighlight(-1);
                window.setTimeout(() => {
                  const activeNode = optionsEl.querySelector(".filterable-select-option-active");
                  if (activeNode) {
                    activeNode.focus();
                  }
                }, 0);
                return;
              }
              if (event.key === "Enter" || event.key === " ") {
                commitSelection(event);
                return;
              }
              if (event.key === "Escape") {
                event.preventDefault();
                closeFilterableSelect(true);
              }
            });
          }
          const actions = typeof config.buildOptionActions === "function"
            ? (Array.isArray(config.buildOptionActions(option, optionState)) ? config.buildOptionActions(option, optionState) : [])
            : [];
          if (!actions.length) {
            return node;
          }
          const row = document.createElement("div");
          row.className = "filterable-select-option-row";
          row.appendChild(node);
          for (const action of actions) {
            if (!action || typeof action !== "object" || typeof action.onSelect !== "function") {
              continue;
            }
            const actionButton = document.createElement("button");
            actionButton.type = "button";
            actionButton.className = String(action.className || "button-secondary filterable-select-option-action");
            actionButton.textContent = String(action.label || "");
            if (action.title) {
              actionButton.title = String(action.title);
            }
            if (action.ariaLabel) {
              actionButton.setAttribute("aria-label", String(action.ariaLabel));
            }
            actionButton.addEventListener("click", (event) => {
              event.preventDefault();
              event.stopPropagation();
              if (action.keepOpen !== true) {
                closeFilterableSelect(false);
              }
              void runGuardedUiAction(
                () => action.onSelect(option, optionState),
                {
                  fallbackMessage: String(action.errorMessage || "Option action failed."),
                  errorDisplay: action.errorDisplay || "alert",
                }
              );
            });
            row.appendChild(actionButton);
          }
          return row;
        });
        optionsEl.replaceChildren(...nodes);
      }

      function focusActiveOptionOrTrigger() {
        const activeNode = optionsEl.querySelector(".filterable-select-option-active");
        if (activeNode && typeof activeNode.focus === "function") {
          activeNode.focus();
          return;
        }
        const firstNode = optionsEl.querySelector(".filterable-select-option");
        if (firstNode && typeof firstNode.focus === "function") {
          firstNode.focus();
          return;
        }
        trigger.focus();
      }

      function closeFilterableSelect(restoreFocus) {
        state.query = "";
        searchInput.value = "";
        popover.classList.add("hidden");
        popover.setAttribute("aria-hidden", "true");
        trigger.classList.remove("filterable-select-open");
        trigger.setAttribute("aria-expanded", "false");
        if (activeFilterableSelect === controller) {
          activeFilterableSelect = null;
        }
        if (restoreFocus) {
          trigger.focus();
        }
      }

      function openFilterableSelect() {
        if (activeFilterableSelect && activeFilterableSelect !== controller) {
          activeFilterableSelect.close(false);
        }
        activeFilterableSelect = controller;
        state.query = "";
        searchInput.value = "";
        popover.classList.remove("hidden");
        popover.setAttribute("aria-hidden", "false");
        trigger.classList.add("filterable-select-open");
        trigger.setAttribute("aria-expanded", "true");
        renderOptions();
        window.setTimeout(() => {
          if (activeFilterableSelect === controller) {
            if (config.hideSearch === true) {
              const activeNode = optionsEl.querySelector(".filterable-select-option-active");
              if (activeNode) {
                activeNode.focus();
              } else {
                trigger.focus();
              }
            } else {
              searchInput.focus();
            }
          }
        }, 0);
      }

      function toggleFilterableSelect() {
        if (popover.classList.contains("hidden")) {
          openFilterableSelect();
        } else {
          closeFilterableSelect(true);
        }
      }

      function moveHighlight(direction) {
        if (!state.filteredOptions.length) {
          return;
        }
        const maxIndex = state.filteredOptions.length - 1;
        if (state.highlightedIndex < 0) {
          state.highlightedIndex = direction > 0 ? 0 : maxIndex;
        } else {
          state.highlightedIndex = Math.max(0, Math.min(maxIndex, state.highlightedIndex + direction));
        }
        renderOptions();
      }

      function syncFromSelect() {
        state.options = optionRecordsFromSelect(config.selectNode, config.allowEmptyOption === true);
        state.selectedValue = String(config.selectNode && config.selectNode.value ? config.selectNode.value : "");
        renderTrigger();
        if (!popover.classList.contains("hidden")) {
          renderOptions();
        }
      }

      trigger.onclick = () => toggleFilterableSelect();
      trigger.onkeydown = (event) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp" || event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openFilterableSelect();
        }
      };
      searchInput.addEventListener("input", () => {
        state.query = searchInput.value || "";
        renderOptions();
      });
      searchInput.addEventListener("keydown", (event) => {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          moveHighlight(1);
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          moveHighlight(-1);
          return;
        }
        if (event.key === "Enter") {
          event.preventDefault();
          if (state.highlightedIndex >= 0 && state.highlightedIndex < state.filteredOptions.length) {
            const target = state.filteredOptions[state.highlightedIndex];
            closeFilterableSelect(false);
            void runGuardedUiAction(
              () => config.onSelect(target.value),
              { fallbackMessage: "Selection failed." }
            );
          } else if (config.allowCustomValue === true) {
            const customValue = state.query.trim();
            if (customValue) {
              closeFilterableSelect(false);
              void runGuardedUiAction(
                () => config.onSelect(customValue),
                { fallbackMessage: "Selection failed." }
              );
            }
          }
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          closeFilterableSelect(true);
        }
      });

      const controller = {
        root,
        trigger,
        close: closeFilterableSelect,
        open: openFilterableSelect,
        focusTrigger: () => trigger.focus(),
        focusActiveOptionOrTrigger,
        isOpen: () => !popover.classList.contains("hidden"),
        syncFromSelect,
      };

      syncFromSelect();
      return controller;
    }

    function closeAllFilterableSelects(restoreFocus) {
      if (activeFilterableSelect) {
        activeFilterableSelect.close(Boolean(restoreFocus));
      }
      if (modePicker) {
        modePicker.close(Boolean(restoreFocus && activeFilterableSelect === modePicker));
      }
      if (reviewRepoPicker) {
        reviewRepoPicker.close(Boolean(restoreFocus && activeFilterableSelect === reviewRepoPicker));
      }
      if (reviewBasePicker) {
        reviewBasePicker.close(Boolean(restoreFocus && activeFilterableSelect === reviewBasePicker));
      }
      if (reviewPresetPicker) {
        reviewPresetPicker.close(Boolean(restoreFocus && activeFilterableSelect === reviewPresetPicker));
      }
      if (repoFilterPicker) {
        repoFilterPicker.close(Boolean(restoreFocus && activeFilterableSelect === repoFilterPicker));
      }
    }

    function firstVisibleFilterControl() {
      const candidates = [
        repoFilterPicker && repoFilterPicker.trigger,
        compareIncludeNoEffect,
        inspectStaged,
        inspectUnstaged,
        inspectUntracked,
        inspectAllRepos,
        browseStaged,
        browseUnstaged,
        browseUntracked,
        browseSubmodules,
        browseAllRepos,
        filtersResetBtn,
        filtersDoneBtn,
      ];
      for (const node of candidates) {
        if (!node) continue;
        const section = node.closest(".filters-section");
        if (section && section.classList.contains("hidden")) continue;
        if (node.offsetParent === null) continue;
        return node;
      }
      return filtersDoneBtn;
    }

    function syncFiltersButtonState(viewState) {
      const state = viewState || currentViewState || viewStateFromControls();
      const diffCount = advancedSettingDiffCount(state);
      filtersButton.textContent = diffCount > 0 ? "Filters (" + String(diffCount) + ")" : "Filters";
      filtersButton.classList.toggle("active", diffCount > 0);
      filtersButton.setAttribute("aria-expanded", isFiltersPanelOpen() ? "true" : "false");
    }

    function syncFiltersPanelMode() {
      const mode = String(currentViewState.mode || "compare");
      const subtitles = {
        browse: "Advanced live-change filters for browse mode.",
        compare: "Advanced compare filters.",
        inspect: "Advanced captured-content filters for inspect mode.",
      };
      filtersSubtitle.textContent = subtitles[mode] || "Adjust the current mode's advanced controls.";
      ["browse", "compare", "inspect"].forEach((candidate) => {
        document.querySelectorAll(".filters-mode-" + candidate).forEach((node) => {
          node.classList.toggle("hidden", candidate !== mode);
        });
      });
    }

    function positionFiltersPanel() {
      if (!isFiltersPanelOpen()) {
        return;
      }
      if (window.matchMedia("(max-width: 700px)").matches) {
        filtersPanel.style.top = "";
        filtersPanel.style.left = "";
        filtersPanel.style.right = "";
        return;
      }

      const buttonRect = filtersButton.getBoundingClientRect();
      const panelRect = filtersPanel.getBoundingClientRect();
      const margin = 12;
      const maxLeft = Math.max(margin, window.innerWidth - panelRect.width - margin);
      const left = Math.min(Math.max(buttonRect.right - panelRect.width, margin), maxLeft);
      const top = Math.min(buttonRect.bottom + 10, Math.max(margin, window.innerHeight - panelRect.height - margin));
      filtersPanel.style.left = Math.round(left) + "px";
      filtersPanel.style.top = Math.round(top) + "px";
      filtersPanel.style.right = "auto";
    }

    function closeFiltersPanel(restoreFocus) {
      closeAllFilterableSelects(false);
      filtersOverlay.classList.add("hidden");
      filtersOverlay.setAttribute("aria-hidden", "true");
      filtersButton.setAttribute("aria-expanded", "false");
      filtersPanel.style.top = "";
      filtersPanel.style.left = "";
      filtersPanel.style.right = "";
      syncBodyModalState();
      syncFiltersButtonState();
      if (restoreFocus) {
        const target = filtersRestoreFocusTarget || filtersButton;
        filtersRestoreFocusTarget = null;
        if (target && typeof target.focus === "function") {
          target.focus();
        }
      }
    }

    function openFiltersPanel() {
      if (isFiltersPanelOpen()) {
        return;
      }
      closeAllFilterableSelects(false);
      if (isRefreshMenuOpen()) {
        closeRefreshMenu(false);
      }
      if (isSnapshotPanelOpen()) {
        closeSnapshotPanel(false);
      }
      if (isCreateSnapshotDialogOpen()) {
        closeCreateSnapshotDialog();
      }
      if (isResetAllDialogOpen()) {
        closeResetAllDialog(false);
      }
      if (isResetAllConfirmDialogOpen()) {
        closeResetAllConfirmDialog(false);
      }
      if (isRenameSnapshotDialogOpen()) {
        closeRenameSnapshotDialog(false);
      }
      if (isDeleteSnapshotDialogOpen()) {
        closeDeleteSnapshotDialog(false);
      }
      if (isDiffSelectionContextMenuOpen()) {
        closeDiffSelectionContextMenu(false);
      }
      filtersRestoreFocusTarget = document.activeElement;
      syncFiltersPanelMode();
      filtersOverlay.classList.remove("hidden");
      filtersOverlay.setAttribute("aria-hidden", "false");
      filtersButton.setAttribute("aria-expanded", "true");
      syncBodyModalState();
      positionFiltersPanel();
      const initialFocusTarget = firstVisibleFilterControl();
      if (initialFocusTarget) {
        window.setTimeout(() => {
          if (isFiltersPanelOpen()) {
            initialFocusTarget.focus();
          }
        }, 0);
      }
    }

    function resetFiltersToDefaults() {
      const defaults = modeDefaults(currentViewState.mode);
      repoFilterSelect.value = defaults.repoFilter || "";
      if (repoFilterPicker) {
        repoFilterPicker.syncFromSelect();
      }
      if (currentViewState.mode === "browse") {
        browseStaged.checked = defaults.browseIncludeStaged;
        browseUnstaged.checked = defaults.browseIncludeUnstaged;
        browseUntracked.checked = defaults.browseIncludeUntracked;
        browseSubmodules.checked = defaults.browseIncludeSubmodules;
        browseAllRepos.checked = defaults.browseShowAllRepos;
        ensureBrowseCategories();
      } else if (currentViewState.mode === "compare") {
        compareIncludeNoEffect.checked = defaults.compareIncludeNoEffect;
      } else if (currentViewState.mode === "review") {
        currentViewState.reviewSelectedRepos = [];
        currentViewState.reviewBaseRef = "master";
        currentViewState.reviewRepoBaseOverrides = {};
        syncReviewBasePickerState();
        renderReviewSelectedRepos();
      } else {
        inspectStaged.checked = defaults.inspectIncludeStaged;
        inspectUnstaged.checked = defaults.inspectIncludeUnstaged;
        inspectUntracked.checked = defaults.inspectIncludeUntracked;
        inspectAllRepos.checked = defaults.inspectShowAllRepos;
        ensureInspectCategories();
      }
      syncFiltersButtonState(viewStateFromControls());
      scheduleRefresh();
    }

    function viewStateFromControls() {
      const nextMode = modeSelect.value;
      const preserveSelection = nextMode === currentViewState.mode;
      return {
        mode: nextMode,
        snapshotId: snapshotSelect.value,
        repoFilter: repoFilterSelect.value || "",
        reviewSelectedRepos: Array.isArray(currentViewState.reviewSelectedRepos) ? currentViewState.reviewSelectedRepos.slice() : [],
        reviewBaseRef: normalizeReviewBaseRefClient(currentViewState.reviewBaseRef, "master"),
        reviewRepoBaseOverrides: normalizeReviewRepoBaseOverridesClient(
          currentViewState.reviewRepoBaseOverrides,
          currentViewState.reviewSelectedRepos,
          currentViewState.reviewBaseRef
        ),
        compareIncludeNoEffect: Boolean(compareIncludeNoEffect.checked),
        compareBase: compareBaseSnapshot.checked ? "snapshot" : "working-tree",
        inspectIncludeStaged: Boolean(inspectStaged.checked),
        inspectIncludeUnstaged: Boolean(inspectUnstaged.checked),
        inspectIncludeUntracked: Boolean(inspectUntracked.checked),
        inspectShowAllRepos: Boolean(inspectAllRepos.checked),
        browseIncludeStaged: Boolean(browseStaged.checked),
        browseIncludeUnstaged: Boolean(browseUnstaged.checked),
        browseIncludeUntracked: Boolean(browseUntracked.checked),
        browseIncludeSubmodules: Boolean(browseSubmodules.checked),
        browseShowAllRepos: Boolean(browseAllRepos.checked),
        selectedKind: preserveSelection ? normalizeSelectedKind(
          nextMode,
          currentViewState.selectedKind,
          currentViewState.selectedRepo,
          currentViewState.selectedCategory,
          currentViewState.selectedFile
        ) : "",
        selectedRepo: preserveSelection ? (currentViewState.selectedRepo || "") : "",
        selectedCategory: preserveSelection && (nextMode === "inspect" || nextMode === "browse") ? (currentViewState.selectedCategory || "") : "",
        selectedFile: preserveSelection ? (currentViewState.selectedFile || "") : "",
      };
    }

    function queryForViewState(viewState) {
      const params = new URLSearchParams();
      params.set("mode", viewState.mode);
      params.set("snapshot_id", viewState.snapshotId || "");
      params.set("repo_filter", viewState.repoFilter || "");
      const encodedReviewRepos = encodeReviewReposForUrlClient(viewState.reviewSelectedRepos);
      if (encodedReviewRepos) {
        params.set("review_repos", encodedReviewRepos);
      }
      params.set("review_base", normalizeReviewBaseRefClient(viewState.reviewBaseRef, "master"));
      const encodedReviewRepoBases = encodeReviewRepoBasesForUrlClient(
        viewState.reviewRepoBaseOverrides,
        viewState.reviewSelectedRepos,
        viewState.reviewBaseRef
      );
      if (encodedReviewRepoBases) {
        params.set("review_repo_bases", encodedReviewRepoBases);
      }
      params.set("compare_include_no_effect", viewState.compareIncludeNoEffect ? "true" : "false");
      params.set("compare_base", normalizeCompareBaseClient(viewState.compareBase));
      params.set("inspect_include_staged", viewState.inspectIncludeStaged ? "true" : "false");
      params.set("inspect_include_unstaged", viewState.inspectIncludeUnstaged ? "true" : "false");
      params.set("inspect_include_untracked", viewState.inspectIncludeUntracked ? "true" : "false");
      params.set("inspect_show_all_repos", viewState.inspectShowAllRepos ? "true" : "false");
      params.set("browse_include_staged", viewState.browseIncludeStaged ? "true" : "false");
      params.set("browse_include_unstaged", viewState.browseIncludeUnstaged ? "true" : "false");
      params.set("browse_include_untracked", viewState.browseIncludeUntracked ? "true" : "false");
      params.set("browse_include_submodules", viewState.browseIncludeSubmodules ? "true" : "false");
      params.set("browse_show_all_repos", viewState.browseShowAllRepos ? "true" : "false");
      const selectedKind = normalizeSelectedKind(
        viewState.mode,
        viewState.selectedKind,
        viewState.selectedRepo,
        viewState.selectedCategory,
        viewState.selectedFile
      );
      if (selectedKind) {
        params.set("selected_kind", selectedKind);
        params.set("selected_repo", viewState.selectedRepo || "");
        if ((viewState.mode === "inspect" || viewState.mode === "browse") && (selectedKind === "file" || selectedKind === "category") && viewState.selectedCategory) {
          params.set("selected_category", viewState.selectedCategory);
        }
        if (selectedKind === "file") {
          params.set("selected_file", viewState.selectedFile || "");
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

    function cancelPendingDataLoad() {
      loadToken += 1;
      if (activeLoadController) {
        activeLoadController.abort();
        activeLoadController = null;
      }
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

    function buildPlainPreviewNode(text, options) {
      const previewText = normalizePreviewText(text);
      const pre = document.createElement("pre");
      pre.className = "preview-pre";
      if (options && options.className) {
        pre.classList.add(options.className);
      }
      pre.textContent = previewText;
      return pre;
    }

    function renderPlainPreview(text, options) {
      closeDiffSelectionContextMenu(false);
      clearDiffSelectionActionSnapshot();
      diffEl.className = "diff-view";
      if (options && options.loading) {
        diffEl.classList.add("loading");
      }
      const pre = buildPlainPreviewNode(text, options);
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

    function buildSubmoduleSummaryCard(summary) {
      const data = summary && typeof summary === "object" ? summary : {};
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
      return card;
    }

    function renderSubmoduleSummary(summary) {
      closeDiffSelectionContextMenu(false);
      clearDiffSelectionActionSnapshot();
      diffEl.className = "diff-view";
      const card = buildSubmoduleSummaryCard(summary);
      diffEl.replaceChildren(card);
      if (previewPanelEl) {
        previewPanelEl.scrollTop = 0;
        previewPanelEl.scrollLeft = 0;
      }
    }

    function createPreviewBlockMeta(block) {
      const meta = document.createElement("div");
      meta.className = "aggregate-preview-block-meta";
      const displayLabel = String(block && block.display_label ? block.display_label : "").trim();
      if (displayLabel) {
        meta.appendChild(createTextPill(displayLabel));
      }
      if (String(block && block.preview_error ? block.preview_error : "") === "true") {
        meta.appendChild(createTextPill("preview error", "This preview block could not be rendered cleanly.", "warning"));
      }
      const linesAdded = compareParseLineStatValue(block && block.lines_added);
      const linesRemoved = compareParseLineStatValue(block && block.lines_removed);
      if (linesAdded != null && linesRemoved != null && !(linesAdded === 0 && linesRemoved === 0)) {
        meta.appendChild(createDeltaPill("+", linesAdded, "add", "Added lines in this preview block."));
        meta.appendChild(createDeltaPill("-", linesRemoved, "remove", "Removed lines in this preview block."));
      }
      return meta.childNodes.length ? meta : null;
    }

    function renderAggregatePreview(payload, onShowMore, options) {
      closeDiffSelectionContextMenu(false);
      clearDiffSelectionActionSnapshot();
      const data = payload && typeof payload === "object" ? payload : {};
      const renderOptions = options && typeof options === "object" ? options : {};
      const blocks = Array.isArray(data.blocks) ? data.blocks : [];
      diffEl.className = "diff-view aggregate-preview";
      const previousScrollTop = previewPanelEl ? previewPanelEl.scrollTop : 0;
      const previousScrollLeft = previewPanelEl ? previewPanelEl.scrollLeft : 0;

      const fragments = [];
      const summary = document.createElement("div");
      summary.className = "aggregate-preview-summary";
      const title = document.createElement("div");
      title.className = "aggregate-preview-title";
      title.textContent = String(data.title || "Selection preview");
      summary.appendChild(title);
      const subtitleParts = [];
      const totalRows = Number(data.total_rows || 0) || 0;
      const renderedRows = Number(data.rendered_rows || blocks.length || 0) || 0;
      if (totalRows > 0) {
        subtitleParts.push(totalRows + " row" + (totalRows === 1 ? "" : "s"));
      }
      if (renderedRows && renderedRows !== totalRows) {
        subtitleParts.push("showing " + renderedRows + " of " + totalRows);
      }
      if (data.summary_text) {
        subtitleParts.push(String(data.summary_text));
      }
      if (subtitleParts.length > 0) {
        const subtitle = document.createElement("div");
        subtitle.className = "aggregate-preview-subtitle";
        subtitle.textContent = subtitleParts.join(" · ");
        summary.appendChild(subtitle);
      }
      if (data.error_message) {
        const error = document.createElement("div");
        error.className = "aggregate-preview-error";
        error.textContent = String(data.error_message);
        summary.appendChild(error);
      }
      if (data.warning_message) {
        const warning = document.createElement("div");
        warning.className = "aggregate-preview-error";
        warning.textContent = String(data.warning_message);
        summary.appendChild(warning);
      }
      if (data.has_more) {
        const showMoreButton = document.createElement("button");
        showMoreButton.type = "button";
        showMoreButton.className = "aggregate-preview-show-all";
        showMoreButton.textContent = "Show more";
        showMoreButton.onclick = () => {
          if (typeof onShowMore === "function") {
            onShowMore();
          }
        };
        summary.appendChild(showMoreButton);
      }
      fragments.push(summary);

      if (!blocks.length) {
        const empty = document.createElement("pre");
        empty.className = "preview-pre empty";
        empty.textContent = String(data.empty_message || data.summary_text || "No rows to preview.");
        fragments.push(empty);
      } else {
        for (const block of blocks) {
          const blockNode = document.createElement("section");
          blockNode.className = "aggregate-preview-block";

          const header = document.createElement("div");
          header.className = "aggregate-preview-block-header";

          const pathNode = document.createElement("div");
          pathNode.className = "aggregate-preview-block-path";
          pathNode.textContent = String(block && block.file ? block.file : "(unknown)");
          header.appendChild(pathNode);

          const meta = createPreviewBlockMeta(block);
          if (meta) {
            header.appendChild(meta);
          }

          blockNode.appendChild(header);

          if (block && block.preview_kind === "submodule_summary") {
            blockNode.appendChild(buildSubmoduleSummaryCard(block.data || {}));
          } else {
            const structured = (block && block.text && looksLikeUnifiedDiff(block.text))
              ? buildStructuredDiffContent(block.text, {
                mode: currentViewState.mode,
                previewRow: Object.assign({ selection_kind: "file" }, block || {}),
                compareBase: currentViewState.compareBase,
                showFileHeader: false,
                containerClassName: "aggregate-preview-diff",
              })
              : null;
            blockNode.appendChild(structured || buildPlainPreviewNode(block && block.text ? block.text : "", { className: "aggregate-preview-pre" }));
          }

          fragments.push(blockNode);
        }
      }

      diffEl.replaceChildren(...fragments);
      if (previewPanelEl) {
        if (renderOptions.preserveScroll) {
          previewPanelEl.scrollTop = previousScrollTop;
          previewPanelEl.scrollLeft = previousScrollLeft;
        } else {
          previewPanelEl.scrollTop = 0;
          previewPanelEl.scrollLeft = 0;
        }
      }
    }

    function createAggregateShowMoreHandler(node, rowNode) {
      return () => {
        selectRow(node, rowNode, true, {
          aggregateOffset: currentAggregatePreviewState ? currentAggregatePreviewState.nextOffset : 0,
          aggregateLimit: ${AGGREGATE_PREVIEW_PAGE_SIZE},
          appendAggregate: true,
        }).catch((err) => {
          if (!isAbortError(err)) {
            handleAggregatePreviewAppendFailure(
              node,
              rowNode,
              "Failed to load more preview rows."
            );
          }
        });
      };
    }

    function renderStoredAggregatePreview(node, rowNode, options) {
      const state = currentAggregatePreviewState;
      if (!state || state.selectionKey !== rowSelectionKey(node)) {
        return false;
      }
      const renderOptions = options && typeof options === "object" ? options : {};
      renderAggregatePreview({
        preview_kind: "aggregate_preview",
        title: state.title,
        summary_text: state.summaryText,
        empty_message: state.emptyMessage,
        total_rows: state.totalRows,
        rendered_rows: state.renderedRows,
        next_offset: state.nextOffset,
        has_more: state.hasMore,
        blocks: state.blocks.slice(),
        error_message: renderOptions.errorMessage || "",
      }, state.hasMore ? createAggregateShowMoreHandler(node, rowNode) : null, {
        preserveScroll: Boolean(renderOptions.preserveScroll),
      });
      return true;
    }

    function handleAggregatePreviewAppendFailure(node, rowNode, message) {
      currentPreviewSupportsPrimaryAction = false;
      syncOpenButtonState();
      if (renderStoredAggregatePreview(node, rowNode, {
        preserveScroll: true,
        errorMessage: message || "Failed to load more preview rows.",
      })) {
        return;
      }
      currentAggregatePreviewState = null;
      setDiffText(message || "Failed to load preview.");
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
      const compareBase = normalizeCompareBaseClient(currentViewState.compareBase);
      if (status === "unresolved_missing") {
        if (compareBase === "snapshot") {
          return [
            {
              text: "- current path removes snapshot content",
              className: "diff-file-chip-delete",
              title: "Red - lines are content captured in the snapshot that is currently absent from the working tree.",
            },
            {
              text: "current copy missing",
              className: "diff-file-chip-note",
              title: "This preview is deletion-only because the current working-tree copy is missing.",
            },
          ];
        }
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
        if (compareBase === "snapshot") {
          return [
            {
              text: "+ working-tree changes since snapshot",
              className: "diff-file-chip-add",
              title: "Green + lines are content that exists now in the working tree but was not present in the snapshot target.",
            },
            {
              text: "- snapshot-only content replaced or removed",
              className: "diff-file-chip-delete",
              title: "Red - lines are content that existed in the snapshot target but has since been removed or replaced in the working tree.",
            },
          ];
        }
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
      if (compareBase === "snapshot") {
        return [
          {
            text: "+ current adds",
            className: "diff-file-chip-add",
            title: "Green + lines exist in the current working tree relative to the snapshot base.",
          },
          {
            text: "- snapshot removes",
            className: "diff-file-chip-delete",
            title: "Red - lines exist only in the snapshot base and are absent from the current working tree.",
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

    function browseDiffLegendSpecs(row) {
      const category = String(row && row.category ? row.category : "");
      if (category === "staged") {
        return [
          {
            text: "+ staged in index",
            className: "diff-file-chip-add",
            title: "Green + lines are currently staged in the index relative to HEAD.",
          },
          {
            text: "- from HEAD baseline",
            className: "diff-file-chip-delete",
            title: "Red - lines are content from HEAD that would be replaced or removed by the staged version.",
          },
        ];
      }
      if (category === "unstaged") {
        return [
          {
            text: "+ working tree only",
            className: "diff-file-chip-add",
            title: "Green + lines exist in the current working tree but not in the index.",
          },
          {
            text: "- currently in index",
            className: "diff-file-chip-delete",
            title: "Red - lines exist in the index and would be removed or replaced by the unstaged working-tree version.",
          },
        ];
      }
      if (category === "untracked") {
        return [
          {
            text: "+ untracked working tree content",
            className: "diff-file-chip-add",
            title: "Green + lines are new untracked content that does not exist in HEAD or the index.",
          },
          {
            text: "baseline empty",
            className: "diff-file-chip-note",
            title: "This preview compares an empty baseline to the current untracked file.",
          },
        ];
      }
      return [];
    }

    function reviewDiffLegendSpecs(previewRow) {
      const previewContext = reviewPreviewContext(previewRow);
      const mergeBaseLabel = previewContext.effectiveBaseRef
        ? ("merge-base(" + previewContext.effectiveBaseRef + ", HEAD)")
        : "merge-base(review-base, HEAD)";
      return [
        {
          text: "+ branch adds",
          className: "diff-file-chip-add",
          title: "Green + lines are committed on the current branch relative to " + mergeBaseLabel + ".",
        },
        {
          text: "- baseline removes",
          className: "diff-file-chip-delete",
          title: "Red - lines exist on " + mergeBaseLabel + " and were removed or replaced by the current branch.",
        },
      ];
    }

    function diffLegendSpecsForPreviewRow(previewRow, mode) {
      if (!previewRow || String(previewRow.selection_kind || "file") !== "file") return [];
      if (mode === "since_viewed") {
        return [];
      }
      if (mode === "browse") {
        return browseDiffLegendSpecs(previewRow);
      }
      if (mode === "review") {
        return reviewDiffLegendSpecs(previewRow);
      }
      if (mode === "inspect") {
        return inspectDiffLegendSpecs(previewRow);
      }
      return compareDiffLegendSpecs(previewRow);
    }

    function diffLegendSpecsForCurrentPreview() {
      return diffLegendSpecsForPreviewRow(currentPreviewRow, currentViewState.mode);
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

    function buildStructuredDiffContent(text, options) {
      const files = parseUnifiedDiffFiles(text);
      if (!files.length) return null;

      const previewMode = String(options && options.mode ? options.mode : currentViewState.mode);
      const previewRow = options && options.previewRow ? options.previewRow : currentPreviewRow;
      const compareBase = options && options.compareBase ? options.compareBase : currentViewState.compareBase;
      const showFileHeader = !(options && options.showFileHeader === false);
      const legendSpecs = diffLegendSpecsForPreviewRow(previewRow, previewMode);
      const container = document.createElement("div");
      container.className = String(options && options.containerClassName ? options.containerClassName : "").trim() || "structured-diff-content";

      files.forEach((file, index) => {
        const fileNode = document.createElement("section");
        fileNode.className = "diff-file";

        const header = document.createElement("div");
        header.className = "diff-file-header";
        if (!showFileHeader) {
          header.classList.add("diff-file-header-compact");
        }

        if (showFileHeader) {
          const title = document.createElement("div");
          title.className = "diff-file-title";
          title.textContent = file.displayPath || "diff-preview-" + String(index + 1);
          header.appendChild(title);
        }

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
        if (previewMode === "compare") {
          appendMetaLine(meta, "compare base: " + compareBaseDisplayLabelClient(compareBase));
        } else if (previewMode === "review") {
          const previewContext = reviewPreviewContext(previewRow);
          appendMetaLine(meta, "review base: " + previewContext.effectiveBaseRef);
          if (previewContext.mergeBase) {
            appendMetaLine(meta, "merge-base: " + previewContext.mergeBase);
          }
        }
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
        container.appendChild(fileNode);
      });

      return container;
    }

    function renderStructuredDiff(text) {
      const content = buildStructuredDiffContent(text, {
        mode: currentViewState.mode,
        previewRow: currentPreviewRow,
        compareBase: currentViewState.compareBase,
      });
      if (!content) return false;

      diffEl.className = "diff-view rendered-diff";
      const fragments = Array.from(content.childNodes);
      diffEl.replaceChildren(...fragments);
      if (previewPanelEl) {
        previewPanelEl.scrollTop = 0;
        previewPanelEl.scrollLeft = 0;
      }
      return true;
    }

    function renderSinceViewedDiffText(text) {
      closeDiffSelectionContextMenu(false);
      const content = buildStructuredDiffContent(text, {
        mode: "since_viewed",
        previewRow: currentPreviewRow,
        compareBase: currentViewState.compareBase,
      });
      if (content) {
        diffEl.className = "diff-view rendered-diff";
        diffEl.replaceChildren(...Array.from(content.childNodes));
        if (previewPanelEl) {
          previewPanelEl.scrollTop = 0;
          previewPanelEl.scrollLeft = 0;
        }
        return;
      }
      renderPlainPreview(text);
    }

    function normalizeSelectedKind(mode, rawKind, selectedRepo, selectedCategory, selectedFile) {
      return normalizeSelectedKindShared(mode, rawKind, selectedRepo, selectedCategory, selectedFile);
    }

    function buildSelectionFallbackSequence(mode, rawKind, selectedRepo, selectedCategory, selectedFile) {
      return buildSelectionFallbackSequenceShared(
        mode,
        rawKind,
        selectedRepo,
        selectedCategory,
        selectedFile
      );
    }

    function shouldForceInitialLiveViewLoad(previousViewState, nextViewState, hasCurrentData, previousViewDataToken) {
      const nextMode = String(nextViewState && nextViewState.mode ? nextViewState.mode : "");
      const previousMode = String(previousViewState && previousViewState.mode ? previousViewState.mode : "");
      const liveMode = nextMode === "browse" || nextMode === "compare";
      if (!liveMode) {
        return false;
      }
      if (!hasCurrentData || !String(previousViewDataToken || "")) {
        return true;
      }
      return previousMode !== nextMode;
    }

    function selectionKey(kind, repo, category, file) {
      return buildSelectionIdentityKeyShared(
        currentViewState.mode || "",
        kind || "",
        repo || "",
        category || "",
        file || ""
      );
    }

    function selectionNodeFromRow(row) {
      return Object.assign({ selection_kind: "file" }, row || {}, {
        repo: String(row && row.repo ? row.repo : ""),
        category: String(row && row.category ? row.category : ""),
        file: String(row && row.file ? row.file : ""),
      });
    }

    function selectionNodeFromRepoRow(repoRow) {
      return {
        selection_kind: "repo",
        repo: String(repoRow && repoRow.repo ? repoRow.repo : ""),
        category: "",
        file: "",
        repoRow: repoRow || null,
      };
    }

    function selectionNodeFromCategoryRow(categoryRow) {
      return {
        selection_kind: "category",
        repo: String(categoryRow && categoryRow.repo ? categoryRow.repo : ""),
        category: String(categoryRow && categoryRow.category ? categoryRow.category : ""),
        file: "",
        categoryRow: categoryRow || null,
      };
    }

    function rowSelectionKey(rowOrNode) {
      if (!rowOrNode) return "";
      return selectionKey(
        rowOrNode.selection_kind || "file",
        rowOrNode.repo || "",
        rowOrNode.category || "",
        rowOrNode.file || ""
      );
    }

    function selectionKeyFromViewState(viewState) {
      if (!viewState) return "";
      const selectedKind = normalizeSelectedKind(
        viewState.mode,
        viewState.selectedKind,
        viewState.selectedRepo,
        viewState.selectedCategory,
        viewState.selectedFile
      );
      if (!selectedKind) return "";
      return buildSelectionIdentityKeyShared(
        viewState.mode || "",
        selectedKind,
        viewState.selectedRepo || "",
        (viewState.mode === "inspect" || viewState.mode === "browse") ? (viewState.selectedCategory || "") : "",
        selectedKind === "file" ? (viewState.selectedFile || "") : ""
      );
    }

    function clearSelectedRowInViewState() {
      currentViewState.selectedKind = "";
      currentViewState.selectedRepo = "";
      currentViewState.selectedCategory = "";
      currentViewState.selectedFile = "";
    }

    function setSelectedRowInViewState(node) {
      if (!node) {
        clearSelectedRowInViewState();
        return;
      }
      const selectedKind = normalizeSelectedKind(
        currentViewState.mode,
        node.selection_kind || "file",
        node.repo || "",
        node.category || "",
        node.file || ""
      );
      currentViewState.selectedKind = selectedKind;
      currentViewState.selectedRepo = String(node.repo || "");
      currentViewState.selectedFile = selectedKind === "file" ? String(node.file || "") : "";
      currentViewState.selectedCategory =
        (selectedKind === "file" || selectedKind === "category") && (currentViewState.mode === "inspect" || currentViewState.mode === "browse")
          ? String(node.category || "")
          : "";
    }

    function findSelectionNodeForDescriptor(descriptor, requireExactKey) {
      if (!currentData || !descriptor) return null;
      const selectedKind = normalizeSelectedKind(
        currentViewState.mode,
        descriptor.selection_kind,
        descriptor.repo,
        descriptor.category,
        descriptor.file
      );
      const expectedKey = rowSelectionKey(descriptor);
      const exactMatchRequired = requireExactKey === true;
      const matchesCandidate = (candidateNode) => {
        if (!candidateNode) return false;
        if (exactMatchRequired) {
          return rowSelectionKey(candidateNode) === expectedKey;
        }
        if (selectedKind === "repo") {
          return String(candidateNode.selection_kind || "") === "repo"
            && String(candidateNode.repo || "") === String(descriptor.repo || "");
        }
        if (selectedKind === "category") {
          return String(candidateNode.selection_kind || "") === "category"
            && String(candidateNode.repo || "") === String(descriptor.repo || "")
            && String(candidateNode.category || "") === String(descriptor.category || "");
        }
        if (selectedKind === "file") {
          return String(candidateNode.selection_kind || "file") === "file"
            && String(candidateNode.repo || "") === String(descriptor.repo || "")
            && String(candidateNode.file || "") === String(descriptor.file || "");
        }
        return false;
      };
      if (selectedKind === "repo") {
        const repoRows = currentViewState.mode === "browse" || currentViewState.mode === "inspect"
          ? (currentData.visibleRepoRows || [])
          : (currentData.repoRows || []);
        const repoRow = repoRows.find((row) => matchesCandidate(selectionNodeFromRepoRow(row))) || null;
        return repoRow ? selectionNodeFromRepoRow(repoRow) : null;
      }
      if (selectedKind === "category") {
        const categoryRow = (currentData.visibleCategoryRows || []).find((row) => matchesCandidate(selectionNodeFromCategoryRow(row))) || null;
        return categoryRow ? selectionNodeFromCategoryRow(categoryRow) : null;
      }
      if (currentViewState.mode === "compare" || currentViewState.mode === "review") {
        const row = (currentData.rows || []).find((candidate) => matchesCandidate(selectionNodeFromRow(candidate))) || null;
        return row ? selectionNodeFromRow(row) : null;
      }
      const row = (currentData.fileRows || []).find((candidate) => matchesCandidate(selectionNodeFromRow(candidate))) || null;
      return row ? selectionNodeFromRow(row) : null;
    }

    function findCurrentRowBySelectionKey() {
      if (!currentData || !selectionKeyValue) return null;
      return findSelectionNodeForDescriptor({
        selection_kind: currentViewState.selectedKind || "",
        repo: currentViewState.selectedRepo || "",
        category: currentViewState.selectedCategory || "",
        file: currentViewState.selectedFile || "",
      }, true);
    }

    function findBestSelectionFallbackNode() {
      if (!currentData) return null;
      const fallbackSequence = buildSelectionFallbackSequence(
        currentViewState.mode,
        currentViewState.selectedKind,
        currentViewState.selectedRepo,
        currentViewState.selectedCategory,
        currentViewState.selectedFile
      );
      for (const candidate of fallbackSequence) {
        const node = findSelectionNodeForDescriptor(candidate, false);
        if (node) {
          return node;
        }
      }
      return null;
    }

    function setActiveRow(rowNode) {
      for (const node of rowButtons()) {
        const isActive = node === rowNode;
        node.classList.toggle("active", isActive);
        node.setAttribute("aria-selected", isActive ? "true" : "false");
        const shell = node.closest(".file-row-shell, .selection-row-shell");
        if (shell) {
          shell.classList.toggle("active", isActive);
        }
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
        case "ContextMenu":
          if (rowNode && rowNode.__selectionNode) {
            event.preventDefault();
            openRowContextMenu(rowNode.__selectionNode, rowNode, rowNode, {
              clientX: rowNode.getBoundingClientRect().left,
              clientY: rowNode.getBoundingClientRect().bottom + 6,
            });
          }
          break;
        case "F10":
          if (event.shiftKey && rowNode && rowNode.__selectionNode) {
            event.preventDefault();
            openRowContextMenu(rowNode.__selectionNode, rowNode, rowNode, {
              clientX: rowNode.getBoundingClientRect().left,
              clientY: rowNode.getBoundingClientRect().bottom + 6,
            });
          }
          break;
        default:
          break;
      }
    }

    function selectionNodeLabel(node) {
      if (!node) return "";
      if (node.selection_kind === "repo") {
        return String(node.repo || "(repo)");
      }
      if (node.selection_kind === "category") {
        return String(node.repo || "(repo)") + " / " + String(node.category || "(category)");
      }
      return String(node.repo || "") + "/" + String(node.file || "");
    }

    function setDiffLoading(node) {
      closeDiffSelectionContextMenu(false);
      clearDiffSelectionActionSnapshot();
      const prefix = (currentViewState.mode === "compare" || currentViewState.mode === "review") ? "Loading diff for " : "Loading preview for ";
      renderPlainPreview(prefix + selectionNodeLabel(node) + "...", {
        className: "loading",
        loading: true,
      });
    }

    function setAggregatePreviewLoadingState(isLoading) {
      const button = diffEl.querySelector(".aggregate-preview-show-all");
      if (!button) {
        return;
      }
      if (!button.dataset.defaultLabel) {
        button.dataset.defaultLabel = button.textContent || "Show more";
      }
      button.disabled = Boolean(isLoading);
      button.textContent = isLoading ? "Loading more..." : button.dataset.defaultLabel;
    }

    function setDiffText(text) {
      closeDiffSelectionContextMenu(false);
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
      return viewState.compareIncludeNoEffect ? "including no-effect rows" : "effect rows only";
    }

    function browseCategoryLabel(viewState) {
      const out = [];
      if (viewState.browseIncludeStaged) out.push("staged");
      if (viewState.browseIncludeUnstaged) out.push("unstaged");
      if (viewState.browseIncludeUntracked) out.push("untracked");
      if (viewState.browseIncludeSubmodules) out.push("submodules");
      return out.join(", ");
    }

    function browseRepoScopeLabel() {
      if (currentViewState.repoFilter) {
        return "selected repo";
      }
      return currentViewState.browseShowAllRepos ? "all repos" : "repos with changes";
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

    function compareNoEffectExplanation(row) {
      const status = String(row && row.status ? row.status : "");
      if (status === "resolved_uncommitted") {
        return "matches snapshot, differs from HEAD";
      }
      if (status === "resolved_committed") {
        return "matches snapshot and HEAD";
      }
      return "";
    }

    function compareStatusReasonDetail(row) {
      const status = String(row && row.status ? row.status : "");
      const reason = String(row && row.reason ? row.reason : "").trim();
      if (!reason) return "";
      if (reason === COMPARE_GENERIC_REASONS[status]) {
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
      if (compareRowRestoreEffectClient(row) === "none") {
        const detail = compareNoEffectExplanation(row);
        return detail ? ("Restore would not change this path. " + detail + ".") : "Restore would not change this path.";
      }
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

    function compareRowRestoreEffectClient(row) {
      const explicit = String(row && row.restore_effect ? row.restore_effect : "").trim();
      if (explicit === "changes" || explicit === "none") {
        return explicit;
      }
      if (String(row && row.display_kind ? row.display_kind : "") === "no_effect") {
        return "none";
      }
      if (String(row && row.display_kind ? row.display_kind : "").trim()) {
        return "changes";
      }
      const status = String(row && row.status ? row.status : "");
      return status.startsWith("unresolved_") ? "changes" : "none";
    }

    function compareNumericField(value, fallback = 0) {
      const parsed = Number(String(value == null ? "" : value).trim());
      return Number.isFinite(parsed) ? parsed : fallback;
    }

    function compareParseLineStatValue(value) {
      const text = String(value == null ? "" : value).trim();
      if (!/^\\d+$/.test(text)) {
        return null;
      }
      return Number(text);
    }

    function compareDisplayLineStatsClient(row, compareBase) {
      const added = compareParseLineStatValue(row && row.lines_added);
      const removed = compareParseLineStatValue(row && row.lines_removed);
      if (added == null || removed == null) {
        return {
          lines_added: null,
          lines_removed: null,
        };
      }
      return {
        lines_added: added,
        lines_removed: removed,
      };
    }

    function appendRowDisplayLabel(content, row, titleText) {
      const displayLabel = String(row && row.display_label ? row.display_label : "").trim();
      if (!displayLabel) {
        return;
      }
      const labelNode = document.createElement("span");
      labelNode.className = "list-pill status-pill compare-display-pill compare-display-" + String(row && row.display_kind ? row.display_kind : "detail").split("_").join("-");
      labelNode.textContent = displayLabel;
      labelNode.title = titleText || displayLabel;
      content.appendChild(labelNode);
    }

    function appendRowLineStats(content, row, addedTitle, removedTitle) {
      const stats = compareDisplayLineStatsClient(row, currentViewState.compareBase);
      const linesAdded = stats.lines_added;
      const linesRemoved = stats.lines_removed;
      if (linesAdded == null || linesRemoved == null) {
        return;
      }
      const displayKind = String(row && row.display_kind ? row.display_kind : "");
      if (displayKind && displayKind !== "text_change" && linesAdded === 0 && linesRemoved === 0) {
        return;
      }
      content.appendChild(createDeltaPill("+", linesAdded, "add", addedTitle));
      content.appendChild(createDeltaPill("-", linesRemoved, "remove", removedTitle));
    }

    function createCompareRowContent(row) {
      const content = document.createElement("span");
      content.className = "row-content";
      const restoreEffect = compareRowRestoreEffectClient(row);

      const fileNode = document.createElement("span");
      fileNode.className = "row-file";
      fileNode.textContent = row.file || "(unknown)";
      content.appendChild(fileNode);

      appendRowDisplayLabel(content, row, row && row.status ? compareStatusTooltip(row) : "");
      if (restoreEffect !== "none") {
        appendRowLineStats(content, row, "Visible added lines for this compare row.", "Visible removed lines for this compare row.");
      }
      const viewedPill = renderViewedStatePill(row);
      if (viewedPill) {
        content.appendChild(viewedPill);
      }

      return content;
    }

    function createBrowseRowContent(row) {
      const content = document.createElement("span");
      content.className = "row-content";

      const fileNode = document.createElement("span");
      fileNode.className = "row-file";
      fileNode.textContent = row.file || "(unknown)";
      content.appendChild(fileNode);
      appendRowDisplayLabel(content, row, "Live browse change details.");
      appendRowLineStats(content, row, "Added lines in this live browse row.", "Removed lines in this live browse row.");
      const viewedPill = renderViewedStatePill(row);
      if (viewedPill) {
        content.appendChild(viewedPill);
      }

      return content;
    }

    function createInspectRowContent(row) {
      const content = document.createElement("span");
      content.className = "row-content";

      const fileNode = document.createElement("span");
      fileNode.className = "row-file";
      fileNode.textContent = row.file || "(unknown)";
      content.appendChild(fileNode);
      appendRowDisplayLabel(content, row, "Captured snapshot change details.");
      appendRowLineStats(content, row, "Added lines in this captured row.", "Removed lines in this captured row.");
      const viewedPill = renderViewedStatePill(row);
      if (viewedPill) {
        content.appendChild(viewedPill);
      }

      return content;
    }

    function titleSnapshotId(data) {
      if (currentViewState.mode === "browse") {
        return "HEAD";
      }
      if (currentViewState.mode === "compare") {
        return (data && data.targetFields && data.targetFields.selected_snapshot_id) || currentViewState.snapshotId || "?";
      }
      if (currentViewState.mode === "review") {
        return normalizeReviewBaseRefClient(
          data && data.targetFields ? data.targetFields.default_base_ref : currentViewState.reviewBaseRef,
          "master"
        );
      }
      return (data && data.targetFields && data.targetFields.snapshot_id) || currentViewState.snapshotId || "?";
    }

    function documentChromeRefreshStatus() {
      if (!softRefreshAppliesToViewClient(currentViewState)) {
        return "current";
      }
      return refreshViewStatus === "stale" ? "stale" : (refreshViewStatus === "preparing" ? "preparing" : "current");
    }

    function currentDocumentTitlePrefix() {
      const status = documentChromeRefreshStatus();
      if (status === "stale") {
        return "[Refresh Available]";
      }
      if (status === "preparing") {
        return "[Preparing]";
      }
      return "";
    }

    function faviconHrefForRefreshStatusClient(status) {
      const normalizedStatus = status === "stale" ? "stale" : (status === "preparing" ? "preparing" : "current");
      const badge = normalizedStatus === "stale"
        ? '<circle cx="25" cy="8" r="5" fill="#0a84ff" stroke="#ffffff" stroke-width="2" />'
        : (normalizedStatus === "preparing"
          ? '<circle cx="25" cy="8" r="5" fill="#c97a00" stroke="#ffffff" stroke-width="2" />'
          : "");
      const svg = [
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">',
        '  <rect x="4" y="4" width="24" height="24" rx="7" fill="#f6f2ea" stroke="#195f54" stroke-width="2" />',
        '  <path d="M10 12h12M10 16h8M10 20h12" stroke="#195f54" stroke-width="2" stroke-linecap="round" />',
        "  " + badge,
        "</svg>",
      ].join("\\n");
      return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    }

    function ensureDocumentFaviconLink() {
      let link = document.getElementById("dynamicFavicon");
      if (link) {
        return link;
      }
      link = document.createElement("link");
      link.id = "dynamicFavicon";
      link.rel = "icon";
      link.type = "image/svg+xml";
      document.head.appendChild(link);
      return link;
    }

    function updateDocumentFavicon() {
      const status = documentChromeRefreshStatus();
      const link = ensureDocumentFaviconLink();
      const href = faviconHrefForRefreshStatusClient(status);
      if (link.getAttribute("href") !== href) {
        link.setAttribute("href", href);
      }
      link.setAttribute("data-refresh-status", status);
    }

    function currentDocumentTitle(data) {
      const parts = [
        documentTitleRootLabelClient(),
        modeDisplayLabelClient(currentViewState.mode),
        titleSnapshotId(data),
        repoScopeText(currentViewState.repoFilter),
      ];
    if (currentViewState.mode === "browse") {
      parts.push(browseCategoryLabel(currentViewState));
      parts.push(browseRepoScopeLabel());
    } else if (currentViewState.mode === "compare") {
      parts.push(controlVisibleRowsLabel(currentViewState));
      parts.push(compareBaseContextLabelClient(currentViewState.compareBase));
    } else if (currentViewState.mode === "review") {
      parts.push("default base " + normalizeReviewBaseRefClient(currentViewState.reviewBaseRef, "master"));
      parts.push((Array.isArray(currentViewState.reviewSelectedRepos) && currentViewState.reviewSelectedRepos.length)
        ? String(currentViewState.reviewSelectedRepos.length) + " selected repos"
        : "no selected repos");
    } else {
      parts.push(inspectCategoryLabel(currentViewState));
        parts.push(inspectRepoScopeLabel());
      }
      const title = parts.filter(Boolean).join(" · ");
      const prefix = currentDocumentTitlePrefix();
      return prefix ? (prefix + " " + title) : title;
    }

    function updateDocumentTitle(data) {
      document.title = currentDocumentTitle(data);
      updateDocumentFavicon();
    }

    function primaryActionLabel() {
      return currentViewState.mode === "browse" ? "Edit File" : "Open External Diff";
    }

    function primaryActionFailureMessage() {
      return currentViewState.mode === "browse" ? "Failed to edit file." : "Failed to open external diff.";
    }

    function syncOpenButtonState() {
      const selectedRow = findCurrentRowBySelectionKey();
      const modeSupportsOpen = currentViewState.mode === "compare" || currentViewState.mode === "browse";
      openBtn.textContent = primaryActionLabel();
      openBtn.disabled = !modeSupportsOpen || !selectedRow || !currentPreviewSupportsPrimaryAction;
    }

    function syncRefreshButtonHintState() {
      const liveRefreshEnabled = softRefreshAppliesToViewClient(currentViewState);
      const snapshotReloadEnabled = hardRefreshAppliesToViewClient(currentViewState);
      const showPreparing = liveRefreshEnabled && refreshViewStatus === "preparing";
      const showHint = liveRefreshEnabled && refreshViewStatus === "stale";
      const showMenu = currentViewState.mode === "compare";
      const primaryLabel = currentViewState.mode === "inspect" ? "Reload Snapshots" : "Refresh";
      const primaryTitle = currentViewState.mode === "inspect"
        ? "Reload snapshots and inspect data."
        : (showPreparing ? REFRESH_STATE_PREPARING_TEXT : (showHint ? refreshHintMessage : "Refresh"));
      const menuLabel = showMenu ? "Refresh options" : "";
      if (!showMenu && isRefreshMenuOpen()) {
        closeRefreshMenu(false);
      }
      refreshSplit.classList.toggle("menu-hidden", !showMenu);
      refreshBtn.textContent = primaryLabel;
      refreshBtn.disabled = refreshActionBusy;
      refreshBtn.classList.toggle("active", showHint || showPreparing);
      refreshBtn.classList.toggle("refresh-pending", showHint);
      refreshBtn.classList.toggle("refresh-preparing", showPreparing);
      refreshBtn.title = primaryTitle;
      refreshBtn.setAttribute("aria-label", primaryTitle);
      refreshMenuButton.disabled = refreshActionBusy || !showMenu;
      refreshMenuButton.classList.toggle("hidden", !showMenu);
      refreshMenuButton.title = menuLabel;
      refreshMenuButton.setAttribute("aria-label", menuLabel || "Refresh options");
      refreshMenuButton.setAttribute("aria-expanded", isRefreshMenuOpen() ? "true" : "false");
      refreshMenuButton.classList.toggle("active", isRefreshMenuOpen());
      hardRefreshBtn.disabled = refreshActionBusy || !snapshotReloadEnabled;
      hardRefreshBtn.textContent = "Reload Snapshots";
      refreshMenuCopyPrimary.innerHTML = "<strong>Refresh</strong> reloads the current view.";
      refreshMenuCopySecondary.innerHTML = "<strong>Reload Snapshots</strong> also refreshes snapshot inventory.";
      syncServerStatusChipClient();
    }

    function clearRefreshStateTimer() {
      if (!refreshStateTimer) {
        return;
      }
      window.clearTimeout(refreshStateTimer);
      refreshStateTimer = null;
    }

    function scheduleRefreshStatePoll(immediate) {
      clearRefreshStateTimer();
      const delay = immediate
        ? 0
        : (document.hidden ? REFRESH_STATE_POLL_HIDDEN_MS : REFRESH_STATE_POLL_VISIBLE_MS);
      refreshStateTimer = window.setTimeout(() => {
        pollRefreshState().catch(() => {});
      }, delay);
    }

    async function requestRefreshState(options) {
      const refreshOptions = options && typeof options === "object" ? options : {};
      const forceVerify = refreshOptions.forceVerify === true;
      if (forceVerify) {
        clearRefreshStateTimer();
      }
      const requestToken = refreshStateRequestToken + 1;
      refreshStateRequestToken = requestToken;
      try {
        const params = new URLSearchParams(queryForViewState(currentViewState));
        params.set("view_data_token", currentViewDataToken || "");
        params.set("server_instance_id", currentServerInstanceId || "");
        if (forceVerify) {
          params.set("verify", "1");
        }
        const res = await fetch("/api/refresh-state?" + params.toString(), {
          cache: "no-store",
        });
        const data = await res.json();
        if (!forceVerify && requestToken !== refreshStateRequestToken) {
          return;
        }
        if (!res.ok || !data || data.ok === false) {
          throw new Error((data && data.error) || "Failed to load refresh state.");
        }
        markServerConnectionSuccess();
        refreshViewStatus = String((data && data.view_status) || "current");
        refreshHintMessage = refreshViewStatus === "stale"
          ? String((data && data.hint) || REFRESH_STATE_HINT_TEXT)
          : REFRESH_STATE_HINT_TEXT;
        syncRefreshButtonHintState();
        updateDocumentTitle(currentData);
      } catch (err) {
        if (forceVerify || requestToken === refreshStateRequestToken) {
          if (!isAbortError(err)) {
            recordServerConnectionFailure(2);
          }
          syncRefreshButtonHintState();
          updateDocumentTitle(currentData);
        }
      } finally {
        if (forceVerify || requestToken === refreshStateRequestToken) {
          scheduleRefreshStatePoll(false);
        }
      }
    }

    function readRefreshStateForTest() {
      const refresh = document.getElementById("refresh");
      if (!refresh) {
        return null;
      }
      const status = refresh.classList.contains("refresh-preparing")
        ? "preparing"
        : (refresh.classList.contains("refresh-pending") ? "stale" : "current");
      return {
        status,
        title: refresh.getAttribute("aria-label") || refresh.getAttribute("title") || "",
      };
    }

    async function pollRefreshState() {
      await requestRefreshState();
    }

    globalThis.__gitSnapshotTestForceRefreshStatePoll = async () => {
      await requestRefreshState({ forceVerify: true });
      return readRefreshStateForTest();
    };
    globalThis.__gitSnapshotTestReadViewLoadState = () => {
      return {
        mode: String((currentViewState && currentViewState.mode) || ""),
        viewDataToken: String(currentViewDataToken || ""),
        selectionKey: String(selectionKeyValue || ""),
        refresh: readRefreshStateForTest(),
      };
    };

    function applyModeVisibility() {
      if (currentViewState.mode !== "browse") {
        closeCreateSnapshotDialog();
        closeResetAllDialog(false);
        closeResetAllConfirmDialog(false);
      }
      if (currentViewState.mode === "browse" || currentViewState.mode === "review") {
        if (isSnapshotPanelOpen()) {
          closeSnapshotPanel(false);
        }
        if (isRenameSnapshotDialogOpen()) {
          closeRenameSnapshotDialog(false);
        }
        if (isDeleteSnapshotDialogOpen()) {
          closeDeleteSnapshotDialog(false);
        }
      }
      if (currentViewState.mode !== "review") {
        if (isSaveReviewPresetDialogOpen()) {
          closeSaveReviewPresetDialog(false);
        }
        if (isRenameReviewPresetDialogOpen()) {
          closeRenameReviewPresetDialog(false);
        }
        if (isDeleteReviewPresetDialogOpen()) {
          closeDeleteReviewPresetDialog(false);
        }
      }
      syncFiltersPanelMode();
      closeAllFilterableSelects(false);
      if (isRefreshMenuOpen()) {
        closeRefreshMenu(false);
      }
      if (isReviewPresetActionsMenuOpen()) {
        closeReviewPresetActionsMenu(false);
      }
      document.querySelectorAll(".control-snapshot").forEach((node) => {
        node.classList.toggle("hidden", currentViewState.mode === "browse" || currentViewState.mode === "review");
      });
      document.querySelectorAll(".control-compare-base").forEach((node) => {
        node.classList.toggle("hidden", currentViewState.mode !== "compare");
      });
      document.querySelectorAll(".control-review-picker, .control-review-base, .control-review-presets, .control-review-selection").forEach((node) => {
        node.classList.toggle("hidden", currentViewState.mode !== "review");
      });
      if (currentViewState.mode !== "review") {
        setReviewSelectionTrayOpen(false);
      }
      openBtn.classList.toggle("hidden", currentViewState.mode === "inspect" || currentViewState.mode === "review");
      filtersButton.classList.toggle("hidden", currentViewState.mode === "review");
      createSnapshotBtn.classList.toggle("hidden", currentViewState.mode !== "browse");
      resetAllBtn.classList.toggle("hidden", currentViewState.mode !== "browse");
      syncOpenButtonState();
      syncFiltersButtonState();
      syncRefreshButtonHintState();
      syncSnapshotPickerState();
      if (isFiltersPanelOpen()) {
        positionFiltersPanel();
      }
      if (isSnapshotPanelOpen()) {
        positionSnapshotPanel();
      }
      inspectSummaryPanel.classList.toggle("hidden", currentViewState.mode !== "inspect");
    }

    function setCreateSnapshotStatus(message, kind) {
      createSnapshotStatus.textContent = message || "";
      createSnapshotStatus.classList.toggle("error", kind === "error");
    }

    function setCreateSnapshotDialogBusy(busy) {
      createSnapshotIdInput.disabled = busy;
      createSnapshotClearCheckbox.disabled = busy;
      createSnapshotCancelBtn.disabled = busy;
      createSnapshotSubmitBtn.disabled = busy;
    }

    function isCreateSnapshotDialogOpen() {
      return !createSnapshotDialog.classList.contains("hidden");
    }

    function closeCreateSnapshotDialog() {
      createSnapshotDialogToken += 1;
      createSnapshotDialog.classList.add("hidden");
      syncBodyModalState();
      setCreateSnapshotDialogBusy(false);
      setCreateSnapshotStatus("", "");
      createSnapshotIdInput.value = "";
      createSnapshotClearCheckbox.checked = false;
    }

    function setSaveReviewPresetStatus(message, kind) {
      saveReviewPresetStatus.textContent = message || "";
      saveReviewPresetStatus.classList.toggle("error", kind === "error");
    }

    function setSaveReviewPresetDialogBusy(busy) {
      saveReviewPresetInput.disabled = busy;
      saveReviewPresetCancelBtn.disabled = busy;
      saveReviewPresetSubmitBtn.disabled = busy;
    }

    function closeSaveReviewPresetDialog(restoreFocus) {
      saveReviewPresetDialog.classList.add("hidden");
      syncBodyModalState();
      setSaveReviewPresetDialogBusy(false);
      setSaveReviewPresetStatus("", "");
      saveReviewPresetInput.value = "";
      saveReviewPresetMeta.textContent = "Saving to an existing preset name replaces that preset's repos and review-base settings in place.";
      if (restoreFocus && !reviewPresetActionsButton.disabled) {
        reviewPresetActionsButton.focus();
      }
    }

    function openSaveReviewPresetDialog() {
      const activePreset = currentReviewPreset();
      const selectedRepos = normalizeStringListClient(currentViewState.reviewSelectedRepos);
      if (!selectedRepos.length) {
        return;
      }
      saveReviewPresetInput.value = activePreset ? activePreset.name : "";
      const repoCountText = selectedRepos.length === 1
        ? "This preset will save 1 repo in the current order."
        : ("This preset will save " + String(selectedRepos.length) + " repos in the current order.");
      saveReviewPresetMeta.textContent = repoCountText + " It also saves the default base and any per-repo base overrides.";
      setSaveReviewPresetStatus("", "");
      setSaveReviewPresetDialogBusy(false);
      saveReviewPresetDialog.classList.remove("hidden");
      syncBodyModalState();
      window.setTimeout(() => {
        if (isSaveReviewPresetDialogOpen()) {
          saveReviewPresetInput.focus();
          saveReviewPresetInput.select();
        }
      }, 0);
    }

    function setRenameReviewPresetStatus(message, kind) {
      renameReviewPresetStatus.textContent = message || "";
      renameReviewPresetStatus.classList.toggle("error", kind === "error");
    }

    function setRenameReviewPresetDialogBusy(busy) {
      renameReviewPresetInput.disabled = busy;
      renameReviewPresetCancelBtn.disabled = busy;
      renameReviewPresetSubmitBtn.disabled = busy;
    }

    function closeRenameReviewPresetDialog(restoreFocus) {
      renameReviewPresetDialog.classList.add("hidden");
      syncBodyModalState();
      setRenameReviewPresetDialogBusy(false);
      setRenameReviewPresetStatus("", "");
      renameReviewPresetInput.value = "";
      renameReviewPresetMeta.textContent = "";
      renameReviewPresetTargetName = "";
      if (restoreFocus && !reviewPresetActionsButton.disabled) {
        reviewPresetActionsButton.focus();
      }
    }

    function openRenameReviewPresetDialog() {
      const activePreset = currentReviewPreset();
      if (!activePreset) {
        return;
      }
      renameReviewPresetTargetName = activePreset.name;
      renameReviewPresetInput.value = activePreset.name;
      renameReviewPresetMeta.textContent = activePreset.repos.length === 1
        ? "This preset currently includes 1 repo and its saved review-base settings."
        : ("This preset currently includes " + String(activePreset.repos.length) + " repos and their saved review-base settings.");
      setRenameReviewPresetStatus("", "");
      setRenameReviewPresetDialogBusy(false);
      renameReviewPresetDialog.classList.remove("hidden");
      syncBodyModalState();
      window.setTimeout(() => {
        if (isRenameReviewPresetDialogOpen()) {
          renameReviewPresetInput.focus();
          renameReviewPresetInput.select();
        }
      }, 0);
    }

    function setDeleteReviewPresetStatus(message, kind) {
      deleteReviewPresetStatus.textContent = message || "";
      deleteReviewPresetStatus.classList.toggle("error", kind === "error");
    }

    function setDeleteReviewPresetDialogBusy(busy) {
      deleteReviewPresetCancelBtn.disabled = busy;
      deleteReviewPresetConfirmBtn.disabled = busy;
    }

    function closeDeleteReviewPresetDialog(restoreFocus) {
      deleteReviewPresetDialog.classList.add("hidden");
      syncBodyModalState();
      setDeleteReviewPresetDialogBusy(false);
      setDeleteReviewPresetStatus("", "");
      deleteReviewPresetMessage.textContent = "";
      deleteReviewPresetTargetName = "";
      if (restoreFocus && !reviewPresetActionsButton.disabled) {
        reviewPresetActionsButton.focus();
      }
    }

    function openDeleteReviewPresetDialog() {
      const activePreset = currentReviewPreset();
      if (!activePreset) {
        return;
      }
      deleteReviewPresetTargetName = activePreset.name;
      deleteReviewPresetMessage.textContent =
        "Delete preset " + DOUBLE_QUOTE + activePreset.name + DOUBLE_QUOTE + "?";
      setDeleteReviewPresetStatus("", "");
      setDeleteReviewPresetDialogBusy(false);
      deleteReviewPresetDialog.classList.remove("hidden");
      syncBodyModalState();
      window.setTimeout(() => {
        if (isDeleteReviewPresetDialogOpen()) {
          deleteReviewPresetConfirmBtn.focus();
        }
      }, 0);
    }

    function applyReviewPresetMutationResult(presets) {
      const normalizedPresets = normalizeReviewPresetsClient(presets);
      currentReviewPresets = normalizedPresets;
      if (currentData) {
        currentData.reviewPresets = normalizedPresets;
      }
      syncReviewPresetControls();
    }

    async function saveCurrentReviewPreset() {
      const name = normalizeReviewPresetNameClient(saveReviewPresetInput.value);
      const repos = normalizeStringListClient(currentViewState.reviewSelectedRepos);
      const defaultBaseRef = normalizeReviewBaseRefClient(currentViewState.reviewBaseRef, "master");
      const repoBaseOverrides = normalizeReviewRepoBaseOverridesClient(
        currentViewState.reviewRepoBaseOverrides,
        repos,
        defaultBaseRef
      );
      if (!name) {
        setSaveReviewPresetStatus("Preset name cannot be empty.", "error");
        return;
      }
      if (!repos.length) {
        setSaveReviewPresetStatus("Select one or more repos before saving a preset.", "error");
        return;
      }
      setSaveReviewPresetDialogBusy(true);
      setSaveReviewPresetStatus("Saving preset…", "");
      try {
        const res = await fetch("/api/review-presets/save", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, repos, default_base_ref: defaultBaseRef, repo_base_overrides: repoBaseOverrides }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data && data.error ? data.error : "Failed to save preset.");
        }
        applyReviewPresetMutationResult(data.presets || []);
        closeSaveReviewPresetDialog(true);
      } catch (err) {
        setSaveReviewPresetStatus(err && err.message ? err.message : String(err), "error");
        setSaveReviewPresetDialogBusy(false);
      }
    }

    async function renameCurrentReviewPreset() {
      const oldName = normalizeReviewPresetNameClient(renameReviewPresetTargetName);
      const newName = normalizeReviewPresetNameClient(renameReviewPresetInput.value);
      if (!oldName) {
        setRenameReviewPresetStatus("Select a preset to rename.", "error");
        return;
      }
      if (!newName) {
        setRenameReviewPresetStatus("New preset name cannot be empty.", "error");
        return;
      }
      setRenameReviewPresetDialogBusy(true);
      setRenameReviewPresetStatus("Renaming preset…", "");
      try {
        const res = await fetch("/api/review-presets/rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ old_name: oldName, new_name: newName }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data && data.error ? data.error : "Failed to rename preset.");
        }
        applyReviewPresetMutationResult(data.presets || []);
        closeRenameReviewPresetDialog(true);
      } catch (err) {
        setRenameReviewPresetStatus(err && err.message ? err.message : String(err), "error");
        setRenameReviewPresetDialogBusy(false);
      }
    }

    async function confirmDeleteReviewPreset() {
      const name = normalizeReviewPresetNameClient(deleteReviewPresetTargetName);
      if (!name) {
        setDeleteReviewPresetStatus("Select a preset to delete.", "error");
        return;
      }
      setDeleteReviewPresetDialogBusy(true);
      setDeleteReviewPresetStatus("Deleting preset…", "");
      try {
        const res = await fetch("/api/review-presets/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) {
          throw new Error(data && data.error ? data.error : "Failed to delete preset.");
        }
        applyReviewPresetMutationResult(data.presets || []);
        closeDeleteReviewPresetDialog(true);
      } catch (err) {
        setDeleteReviewPresetStatus(err && err.message ? err.message : String(err), "error");
        setDeleteReviewPresetDialogBusy(false);
      }
    }

    function setResetAllStatus(message, kind) {
      resetAllStatus.textContent = message || "";
      resetAllStatus.classList.toggle("error", kind === "error");
    }

    function setResetAllDialogBusy(busy) {
      resetAllSnapshotCheckbox.disabled = busy;
      resetAllCancelBtn.disabled = busy;
      resetAllContinueBtn.disabled = busy;
    }

    function resetResetAllChoice() {
      resetAllSnapshotChoice = true;
      resetAllSnapshotCheckbox.checked = true;
    }

    function closeResetAllDialog(restoreFocus) {
      resetAllDialog.classList.add("hidden");
      setResetAllDialogBusy(false);
      setResetAllStatus("", "");
      resetResetAllChoice();
      syncBodyModalState();
      if (restoreFocus && !resetAllBtn.classList.contains("hidden")) {
        resetAllBtn.focus();
      }
    }

    function openResetAllDialog() {
      if (currentViewState.mode !== "browse") {
        return;
      }
      if (isSnapshotPanelOpen()) {
        closeSnapshotPanel(false);
      }
      if (isFiltersPanelOpen()) {
        closeFiltersPanel(false);
      }
      if (isCreateSnapshotDialogOpen()) {
        closeCreateSnapshotDialog();
      }
      if (isResetAllConfirmDialogOpen()) {
        closeResetAllConfirmDialog(false);
      }
      if (isRenameSnapshotDialogOpen()) {
        closeRenameSnapshotDialog(false);
      }
      if (isDeleteSnapshotDialogOpen()) {
        closeDeleteSnapshotDialog(false);
      }
      resetAllDialog.classList.remove("hidden");
      setResetAllDialogBusy(false);
      setResetAllStatus("", "");
      resetResetAllChoice();
      syncBodyModalState();
      window.setTimeout(() => {
        if (isResetAllDialogOpen()) {
          resetAllSnapshotCheckbox.focus();
        }
      }, 0);
    }

    function resetAllConfirmMessageText() {
      if (resetAllSnapshotChoice) {
        return "Reset all live changes for this root repo and create a pre-clear auto snapshot first?";
      }
      return "Reset all live changes for this root repo without creating an auto snapshot first?";
    }

    function setResetAllConfirmStatus(message, kind) {
      resetAllConfirmStatus.textContent = message || "";
      resetAllConfirmStatus.classList.toggle("error", kind === "error");
    }

    function setResetAllConfirmDialogBusy(busy) {
      resetAllConfirmCancelBtn.disabled = busy;
      resetAllConfirmSubmitBtn.disabled = busy;
    }

    function closeResetAllConfirmDialog(restoreFocus) {
      resetAllConfirmDialog.classList.add("hidden");
      resetAllConfirmMessage.textContent = "";
      setResetAllConfirmDialogBusy(false);
      setResetAllConfirmStatus("", "");
      resetResetAllChoice();
      syncBodyModalState();
      if (restoreFocus && !resetAllBtn.classList.contains("hidden")) {
        resetAllBtn.focus();
      }
    }

    function openResetAllConfirmDialog() {
      const snapshotChoice = resetAllSnapshotCheckbox.checked;
      closeResetAllDialog(false);
      resetAllSnapshotChoice = snapshotChoice;
      resetAllConfirmMessage.textContent = resetAllConfirmMessageText();
      setResetAllConfirmStatus("", "");
      setResetAllConfirmDialogBusy(false);
      resetAllConfirmDialog.classList.remove("hidden");
      syncBodyModalState();
      window.setTimeout(() => {
        if (isResetAllConfirmDialogOpen()) {
          resetAllConfirmSubmitBtn.focus();
        }
      }, 0);
    }

    async function requestSuggestedSnapshotId() {
      const res = await fetch("/api/create-snapshot-default-id");
      const data = await res.json();
      if (!res.ok || !data || !data.ok) {
        throw new Error((data && data.error) || "Failed to load suggested snapshot id.");
      }
      return String(data.suggested_snapshot_id || "");
    }

    async function openCreateSnapshotDialog() {
      const token = createSnapshotDialogToken + 1;
      createSnapshotDialogToken = token;
      if (isSnapshotPanelOpen()) {
        closeSnapshotPanel(false);
      }
      if (isFiltersPanelOpen()) {
        closeFiltersPanel(false);
      }
      if (isResetAllDialogOpen()) {
        closeResetAllDialog(false);
      }
      if (isResetAllConfirmDialogOpen()) {
        closeResetAllConfirmDialog(false);
      }
      if (isRenameSnapshotDialogOpen()) {
        closeRenameSnapshotDialog(false);
      }
      if (isDeleteSnapshotDialogOpen()) {
        closeDeleteSnapshotDialog(false);
      }
      createSnapshotDialog.classList.remove("hidden");
      syncBodyModalState();
      createSnapshotClearCheckbox.checked = false;
      createSnapshotIdInput.value = "";
      setCreateSnapshotDialogBusy(true);
      setCreateSnapshotStatus("Loading suggested snapshot id…", "");

      try {
        const suggestedId = await requestSuggestedSnapshotId();
        if (!isCreateSnapshotDialogOpen() || token !== createSnapshotDialogToken) {
          return;
        }
        createSnapshotIdInput.value = suggestedId;
        setCreateSnapshotStatus("Edit the suggested id if you want, or keep it as-is.", "");
      } catch (err) {
        if (!isCreateSnapshotDialogOpen() || token !== createSnapshotDialogToken) {
          return;
        }
        setCreateSnapshotStatus(String(err && err.message ? err.message : err), "error");
      } finally {
        if (isCreateSnapshotDialogOpen() && token === createSnapshotDialogToken) {
          setCreateSnapshotDialogBusy(false);
          createSnapshotIdInput.focus();
          createSnapshotIdInput.select();
        }
      }
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
      if (viewState.mode === "review") {
        return uniqueStrings((Array.isArray(viewState.reviewSelectedRepos) ? viewState.reviewSelectedRepos : []).concat(availableRepos));
      }
      if ((viewState.mode === "inspect" || viewState.mode === "browse") && Array.isArray(data.visibleRepoRows)) {
        return uniqueStrings(data.visibleRepoRows.map((row) => row.repo || "").concat(availableRepos));
      }
      return uniqueStrings(availableRepos);
    }

    function normalizeReviewPresetNameClient(rawValue) {
      return String(rawValue || "").trim();
    }

    function normalizeReviewPresetRecordClient(rawPreset) {
      const name = normalizeReviewPresetNameClient(rawPreset && rawPreset.name);
      const repos = normalizeStringListClient(rawPreset && rawPreset.repos);
      if (!name || !repos.length) {
        return null;
      }
      const defaultBaseRef = normalizeReviewBaseRefClient(rawPreset && rawPreset.default_base_ref, "master");
      const repoBaseOverrides = normalizeReviewRepoBaseOverridesClient(
        rawPreset && rawPreset.repo_base_overrides,
        repos,
        defaultBaseRef
      );
      return {
        name,
        repos,
        default_base_ref: defaultBaseRef,
        repo_base_overrides: repoBaseOverrides,
        updated_at: String(rawPreset && rawPreset.updated_at ? rawPreset.updated_at : ""),
      };
    }

    function normalizeReviewPresetsClient(rawPresets) {
      const presets = [];
      const names = new Set();
      for (const rawPreset of Array.isArray(rawPresets) ? rawPresets : []) {
        const preset = normalizeReviewPresetRecordClient(rawPreset);
        if (!preset) continue;
        const nameKey = preset.name.toLowerCase();
        if (names.has(nameKey)) continue;
        names.add(nameKey);
        presets.push(preset);
      }
      return presets;
    }

    function reviewStateSignatureClient(repos, defaultBaseRef, repoBaseOverrides) {
      return JSON.stringify({
        repos: normalizeStringListClient(repos),
        default_base_ref: normalizeReviewBaseRefClient(defaultBaseRef, "master"),
        repo_base_overrides: normalizeReviewRepoBaseOverridesClient(repoBaseOverrides, repos, defaultBaseRef),
      });
    }

    function currentReviewPreset() {
      const signature = reviewStateSignatureClient(
        currentViewState.reviewSelectedRepos,
        currentViewState.reviewBaseRef,
        currentViewState.reviewRepoBaseOverrides
      );
      return currentReviewPresets.find((preset) => {
        return reviewStateSignatureClient(preset.repos, preset.default_base_ref, preset.repo_base_overrides) === signature;
      }) || null;
    }

    function setReviewSelectionTrayOpen(open, options) {
      reviewSelectionTrayOpen = Boolean(open);
      reviewSelectedTrayEl.classList.toggle("hidden", !reviewSelectionTrayOpen);
      reviewSelectionToggleBtn.setAttribute("aria-expanded", reviewSelectionTrayOpen ? "true" : "false");
      reviewSelectionToggleBtn.textContent = reviewSelectionTrayOpen ? "Manage ▴" : "Manage ▾";
      if (options && options.restoreFocus) {
        reviewSelectionToggleBtn.focus();
      }
    }

    function syncReviewSelectionSummary() {
      const selectedRepos = normalizeStringListClient(currentViewState.reviewSelectedRepos);
      const repoCount = selectedRepos.length;
      reviewSelectionSummaryEl.textContent = repoCount === 1 ? "1 repo selected" : (String(repoCount) + " repos selected");

      const activePreset = currentReviewPreset();
      const overrideCount = Object.keys(normalizeReviewRepoBaseOverridesClient(
        currentViewState.reviewRepoBaseOverrides,
        currentViewState.reviewSelectedRepos,
        currentViewState.reviewBaseRef
      )).length;
      const metaNodes = [];
      if (activePreset) {
        metaNodes.push(createTextPill("Preset: " + activePreset.name, "Current review selection matches this preset."));
      }
      if (overrideCount > 0) {
        metaNodes.push(createTextPill(
          "Custom bases: " + String(overrideCount),
          overrideCount === 1 ? "1 selected repo uses a custom review base." : (String(overrideCount) + " selected repos use custom review bases.")
        ));
      }
      reviewSelectionMetaEl.replaceChildren(...metaNodes);
    }

    function reviewRefRowsForData(data) {
      return data && Array.isArray(data.refRows) ? data.refRows : [];
    }

    function reviewRefOptionsForRepo(data, repo) {
      const normalizedRepo = String(repo || ".").trim() || ".";
      const options = [];
      const seen = new Set();
      for (const row of reviewRefRowsForData(data)) {
        if (String(row && row.repo ? row.repo : ".") !== normalizedRepo) {
          continue;
        }
        const ref = String(row && row.ref ? row.ref : "").trim();
        if (!ref || seen.has(ref)) {
          continue;
        }
        seen.add(ref);
        options.push(ref);
      }
      return options;
    }

    function reviewBaseRequestDescriptorClient(requestedBaseSource, requestedBaseRef) {
      const source = String(requestedBaseSource || "default").trim() === "override" ? "override" : "default";
      const ref = normalizeReviewBaseRefClient(requestedBaseRef, "master");
      return source + " " + ref;
    }

    function reviewRepoBaseStateClient(repoSummary, repo, defaultBaseRef) {
      const normalizedDefaultBase = normalizeReviewBaseRefClient(defaultBaseRef, "master");
      const currentOverrideRef = String(currentViewState.reviewRepoBaseOverrides[repo] || "").trim();
      const requestedBaseSource = String(
        repoSummary && repoSummary.requested_base_source
          ? repoSummary.requested_base_source
          : (currentOverrideRef ? "override" : "default")
      ).trim() || (currentOverrideRef ? "override" : "default");
      const requestedBaseRef = String(
        repoSummary && repoSummary.requested_base_ref
          ? repoSummary.requested_base_ref
          : (currentOverrideRef || normalizedDefaultBase)
      ).trim() || normalizedDefaultBase;
      const effectiveBaseRef = String(repoSummary && repoSummary.effective_base_ref ? repoSummary.effective_base_ref : "").trim();
      const repoStatus = String(repoSummary && repoSummary.status ? repoSummary.status : "").trim();
      const baseSource = String(repoSummary && repoSummary.base_source ? repoSummary.base_source : requestedBaseSource).trim() || requestedBaseSource;
      const baseResolution = String(
        repoSummary && repoSummary.base_resolution
          ? repoSummary.base_resolution
          : (baseSource === "fallback_master"
            ? "fallback_master"
            : (repoStatus === "baseline_missing" ? "unavailable" : "resolved"))
      ).trim() || "resolved";
      const repoMessage = String(repoSummary && repoSummary.message ? repoSummary.message : "").trim();
      const baseNote = String(repoSummary && repoSummary.base_note ? repoSummary.base_note : "").trim() || repoMessage;
      const requestedDescriptor = reviewBaseRequestDescriptorClient(requestedBaseSource, requestedBaseRef);

      return {
        currentOverrideRef,
        requestedBaseSource,
        requestedBaseRef,
        requestedDescriptor,
        effectiveBaseRef,
        effectiveBaseDisplay: effectiveBaseRef || "unavailable",
        repoStatus,
        repoMessage,
        baseSource,
        baseResolution,
        baseNote,
        hasFallback: baseResolution === "fallback_master",
        isUnavailable: baseResolution === "unavailable" || repoStatus === "baseline_missing",
      };
    }

    function reviewUseDefaultLabelClient(baseState, defaultBaseRef) {
      const normalizedDefaultBase = normalizeReviewBaseRefClient(defaultBaseRef, "master");
      if (!baseState || baseState.currentOverrideRef) {
        return "Use default (" + normalizedDefaultBase + ")";
      }
      if (baseState.hasFallback) {
        return "Use default (" + normalizedDefaultBase + "; fell back to master here)";
      }
      if (baseState.isUnavailable) {
        return "Use default (" + normalizedDefaultBase + "; unavailable here)";
      }
      return "Use default (" + normalizedDefaultBase + ")";
    }

    function reviewCurrentOverrideOptionLabelClient(baseState) {
      if (!baseState || !baseState.currentOverrideRef) {
        return "";
      }
      if (baseState.hasFallback) {
        return baseState.currentOverrideRef + " (missing here; using master)";
      }
      if (baseState.isUnavailable) {
        return baseState.currentOverrideRef + " (missing here)";
      }
      return baseState.currentOverrideRef;
    }

    function syncReviewBasePickerState() {
      const currentBase = normalizeReviewBaseRefClient(currentViewState.reviewBaseRef, "master");
      const options = ["master"].concat(reviewRefOptionsForRepo(currentData, "."));
      const uniqueOptions = uniqueStrings(options);
      reviewBaseSelect.innerHTML = "";
      for (const ref of uniqueOptions) {
        const option = document.createElement("option");
        option.value = ref;
        option.textContent = ref;
        reviewBaseSelect.appendChild(option);
      }
      if (!uniqueOptions.includes(currentBase)) {
        const option = document.createElement("option");
        option.value = currentBase;
        option.textContent = currentBase;
        reviewBaseSelect.appendChild(option);
      }
      reviewBaseSelect.value = currentBase;
      if (reviewBasePicker) {
        reviewBasePicker.syncFromSelect();
      }
    }

    function syncReviewPresetOptions() {
      reviewPresetSelect.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Load preset…";
      reviewPresetSelect.appendChild(placeholder);
      for (const preset of currentReviewPresets) {
        const option = document.createElement("option");
        option.value = preset.name;
        option.textContent = preset.name;
        reviewPresetSelect.appendChild(option);
      }
      const activePreset = currentReviewPreset();
      reviewPresetSelect.value = activePreset ? activePreset.name : "";
      if (reviewPresetPicker) {
        reviewPresetPicker.syncFromSelect();
      }
    }

    function syncReviewPresetPickerTone(activePreset) {
      if (!reviewPresetPicker || !reviewPresetPicker.trigger) {
        return;
      }
      reviewPresetPicker.trigger.classList.toggle("review-preset-active", Boolean(activePreset));
      reviewPresetPicker.trigger.classList.toggle("review-preset-inactive", !activePreset);
    }

    function syncReviewPresetControls() {
      syncReviewPresetOptions();
      const activePreset = currentReviewPreset();
      const hasSelection = normalizeStringListClient(currentViewState.reviewSelectedRepos).length > 0;
      reviewPresetSaveBtn.disabled = !hasSelection;
      reviewPresetRenameBtn.disabled = !activePreset;
      reviewPresetDeleteBtn.disabled = !activePreset;
      reviewPresetActionsButton.disabled = reviewPresetSaveBtn.disabled && reviewPresetRenameBtn.disabled && reviewPresetDeleteBtn.disabled;
      if (reviewPresetActionsButton.disabled && isReviewPresetActionsMenuOpen()) {
        closeReviewPresetActionsMenu(false);
      }
      syncReviewPresetPickerTone(activePreset);
      syncReviewSelectionSummary();
    }

    function applyReviewPresetSelection(name) {
      const normalizedName = normalizeReviewPresetNameClient(name);
      if (!normalizedName) {
        return;
      }
      const preset = currentReviewPresets.find((candidate) => candidate.name === normalizedName);
      if (!preset) {
        return;
      }
      setReviewSelectionTrayOpen(false);
      updateReviewConfigurationState(
        preset.repos,
        preset.default_base_ref,
        preset.repo_base_overrides
      );
    }

    function setCurrentReviewPresets(rawPresets) {
      currentReviewPresets = normalizeReviewPresetsClient(rawPresets);
      syncReviewPresetControls();
    }

    function updateReviewRepoOptions(viewState, data) {
      const repoOptions = buildRepoOptions(viewState, data);
      const selectedRepos = new Set(uniqueStrings(Array.isArray(viewState.reviewSelectedRepos) ? viewState.reviewSelectedRepos : []));
      reviewRepoSelect.innerHTML = "";
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = "Add repo…";
      reviewRepoSelect.appendChild(placeholder);
      for (const repo of repoOptions) {
        if (selectedRepos.has(repo)) continue;
        const option = document.createElement("option");
        option.value = repo;
        option.textContent = repo;
        reviewRepoSelect.appendChild(option);
      }
      reviewRepoSelect.value = "";
      if (reviewRepoPicker) {
        reviewRepoPicker.syncFromSelect();
      }
    }

    function updateReviewConfigurationState(nextRepos, nextBaseRef, nextRepoBaseOverrides, options) {
      const next = normalizeStringListClient(nextRepos);
      const normalizedBaseRef = normalizeReviewBaseRefClient(nextBaseRef, "master");
      const normalizedOverrides = normalizeReviewRepoBaseOverridesClient(nextRepoBaseOverrides, next, normalizedBaseRef);
      const currentSignature = reviewStateSignatureClient(
        currentViewState.reviewSelectedRepos,
        currentViewState.reviewBaseRef,
        currentViewState.reviewRepoBaseOverrides
      );
      const nextSignature = reviewStateSignatureClient(next, normalizedBaseRef, normalizedOverrides);
      if (nextSignature === currentSignature) {
        return;
      }
      cancelPendingDataLoad();
      currentViewState.reviewSelectedRepos = next;
      currentViewState.reviewBaseRef = normalizedBaseRef;
      currentViewState.reviewRepoBaseOverrides = normalizedOverrides;
      updateReviewRepoOptions(currentViewState, currentData || { availableRepos: next });
      syncReviewBasePickerState();
      renderReviewSelectedRepos();
      syncReviewPresetControls();
      syncBrowserUrl(currentViewState);
      if (!options || options.refresh !== false) {
        scheduleRefresh();
      }
    }

    function updateReviewSelectionState(nextRepos, options) {
      updateReviewConfigurationState(
        nextRepos,
        currentViewState.reviewBaseRef,
        currentViewState.reviewRepoBaseOverrides,
        options
      );
    }

    function updateReviewBaseState(nextBaseRef) {
      updateReviewConfigurationState(
        currentViewState.reviewSelectedRepos,
        nextBaseRef,
        currentViewState.reviewRepoBaseOverrides
      );
    }

    function updateReviewRepoBaseOverride(repo, value) {
      const normalizedRepo = String(repo || "").trim();
      if (!normalizedRepo) {
        return;
      }
      const normalizedOverrides = Object.assign({}, normalizeReviewRepoBaseOverridesClient(
        currentViewState.reviewRepoBaseOverrides,
        currentViewState.reviewSelectedRepos,
        currentViewState.reviewBaseRef
      ));
      const normalizedValue = String(value || "").trim();
      if (!normalizedValue || normalizedValue === normalizeReviewBaseRefClient(currentViewState.reviewBaseRef, "master")) {
        delete normalizedOverrides[normalizedRepo];
      } else {
        normalizedOverrides[normalizedRepo] = normalizedValue;
      }
      updateReviewConfigurationState(
        currentViewState.reviewSelectedRepos,
        currentViewState.reviewBaseRef,
        normalizedOverrides
      );
    }

    function moveReviewSelection(repo, delta) {
      const repos = normalizeStringListClient(currentViewState.reviewSelectedRepos);
      const index = repos.indexOf(repo);
      if (index < 0) {
        return;
      }
      const targetIndex = index + delta;
      if (targetIndex < 0 || targetIndex >= repos.length) {
        return;
      }
      const next = repos.slice();
      const [moved] = next.splice(index, 1);
      next.splice(targetIndex, 0, moved);
      updateReviewSelectionState(next);
    }

    function reorderReviewSelection(sourceRepo, targetRepo) {
      const repos = normalizeStringListClient(currentViewState.reviewSelectedRepos);
      const fromIndex = repos.indexOf(sourceRepo);
      const toIndex = repos.indexOf(targetRepo);
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
        return;
      }
      const next = repos.slice();
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      updateReviewSelectionState(next);
    }

    function renderReviewSelectedRepos() {
      reviewSelectedReposEl.innerHTML = "";
      const repos = uniqueStrings(Array.isArray(currentViewState.reviewSelectedRepos) ? currentViewState.reviewSelectedRepos : []);
      if (!repos.length) {
        const emptyNode = document.createElement("div");
        emptyNode.className = "review-selected-empty";
        emptyNode.textContent = "Add one or more repos to start review.";
        reviewSelectedReposEl.appendChild(emptyNode);
        return;
      }

      const nodes = repos.map((repo) => {
        const chip = document.createElement("span");
        chip.className = "review-repo-chip";
        chip.dataset.repo = repo;

        const handle = document.createElement("span");
        handle.className = "review-repo-chip-handle";
        handle.textContent = "≡";
        handle.draggable = repos.length > 1;
        handle.setAttribute("aria-label", "Drag to reorder review repo " + repo);
        handle.addEventListener("dragstart", (event) => {
          draggedReviewRepo = repo;
          chip.classList.add("dragging");
          if (event.dataTransfer) {
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", repo);
          }
        });
        handle.addEventListener("dragend", () => {
          draggedReviewRepo = "";
          document.querySelectorAll(".review-repo-chip.dragging, .review-repo-chip.drag-target").forEach((node) => {
            node.classList.remove("dragging", "drag-target");
          });
        });
        chip.appendChild(handle);

        const label = document.createElement("span");
        label.className = "review-repo-chip-label";
        label.textContent = repo;
        chip.appendChild(label);

        const moveLeftBtn = document.createElement("button");
        moveLeftBtn.type = "button";
        moveLeftBtn.textContent = "←";
        moveLeftBtn.disabled = repos.indexOf(repo) === 0;
        moveLeftBtn.setAttribute("aria-label", "Move review repo left " + repo);
        moveLeftBtn.onclick = () => moveReviewSelection(repo, -1);
        chip.appendChild(moveLeftBtn);

        const moveRightBtn = document.createElement("button");
        moveRightBtn.type = "button";
        moveRightBtn.textContent = "→";
        moveRightBtn.disabled = repos.indexOf(repo) === repos.length - 1;
        moveRightBtn.setAttribute("aria-label", "Move review repo right " + repo);
        moveRightBtn.onclick = () => moveReviewSelection(repo, 1);
        chip.appendChild(moveRightBtn);

        const removeBtn = document.createElement("button");
        removeBtn.type = "button";
        removeBtn.className = "review-repo-chip-remove";
        removeBtn.textContent = "x";
        removeBtn.setAttribute("aria-label", "Remove review repo " + repo);
        removeBtn.onclick = () => {
          updateReviewSelectionState(repos.filter((candidate) => candidate !== repo));
        };
        chip.appendChild(removeBtn);
        chip.addEventListener("dragover", (event) => {
          if (!draggedReviewRepo || draggedReviewRepo === repo) {
            return;
          }
          event.preventDefault();
          chip.classList.add("drag-target");
        });
        chip.addEventListener("dragleave", () => chip.classList.remove("drag-target"));
        chip.addEventListener("drop", (event) => {
          event.preventDefault();
          chip.classList.remove("drag-target");
          reorderReviewSelection(draggedReviewRepo, repo);
        });
        return chip;
      });
      reviewSelectedReposEl.replaceChildren(...nodes);
    }

    function addReviewRepoSelection(repo) {
      const normalizedRepo = String(repo || "").trim();
      if (!normalizedRepo) {
        return;
      }
      updateReviewSelectionState(
        (Array.isArray(currentViewState.reviewSelectedRepos) ? currentViewState.reviewSelectedRepos : []).concat([normalizedRepo])
      );
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
      if (repoFilterPicker) {
        repoFilterPicker.syncFromSelect();
      }
    }

    function updateSnapshotOptions(currentSnapshotId) {
      const previous = String(currentSnapshotId || currentViewState.snapshotId || "");
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
      const hasPreviousOption = Array.from(snapshotSelect.options).some((option) => option.value === previous);
      const selectedSnapshotId = previous && hasPreviousOption ? previous : selectAvailableSnapshotId(previous);
      snapshotSelect.value = selectedSnapshotId || previous || "";
      currentViewState.snapshotId = snapshotSelect.value || "";
      syncSnapshotPickerState();
    }

    function setControlsFromViewState(viewState, data) {
      currentViewState = Object.assign({}, viewState);
      if (currentViewState.mode === "review") {
        setCurrentReviewPresets(data && data.reviewPresets);
      } else if (!data || !Array.isArray(data.reviewPresets)) {
        setCurrentReviewPresets([]);
      }
      selectionKeyValue = selectionKeyFromViewState(currentViewState);
      modeSelect.value = currentViewState.mode;
      syncModePickerState();
      compareIncludeNoEffect.checked = Boolean(currentViewState.compareIncludeNoEffect);
      compareBaseWorkingTree.checked = normalizeCompareBaseClient(currentViewState.compareBase) === "working-tree";
      compareBaseSnapshot.checked = normalizeCompareBaseClient(currentViewState.compareBase) === "snapshot";
      inspectStaged.checked = Boolean(currentViewState.inspectIncludeStaged);
      inspectUnstaged.checked = Boolean(currentViewState.inspectIncludeUnstaged);
      inspectUntracked.checked = Boolean(currentViewState.inspectIncludeUntracked);
      inspectAllRepos.checked = Boolean(currentViewState.inspectShowAllRepos);
      browseStaged.checked = Boolean(currentViewState.browseIncludeStaged);
      browseUnstaged.checked = Boolean(currentViewState.browseIncludeUnstaged);
      browseUntracked.checked = Boolean(currentViewState.browseIncludeUntracked);
      browseSubmodules.checked = Boolean(currentViewState.browseIncludeSubmodules);
      browseAllRepos.checked = Boolean(currentViewState.browseShowAllRepos);
      currentViewState.reviewSelectedRepos = uniqueStrings(Array.isArray(currentViewState.reviewSelectedRepos) ? currentViewState.reviewSelectedRepos : []);
      currentViewState.reviewBaseRef = normalizeReviewBaseRefClient(currentViewState.reviewBaseRef, "master");
      currentViewState.reviewRepoBaseOverrides = normalizeReviewRepoBaseOverridesClient(
        currentViewState.reviewRepoBaseOverrides,
        currentViewState.reviewSelectedRepos,
        currentViewState.reviewBaseRef
      );
      currentViewState.selectedKind = normalizeSelectedKind(
        currentViewState.mode,
        currentViewState.selectedKind,
        currentViewState.selectedRepo,
        currentViewState.selectedCategory,
        currentViewState.selectedFile
      );
      updateSnapshotOptions(currentViewState.snapshotId);
      currentViewState.snapshotId = snapshotSelect.value || currentViewState.snapshotId || "";
      if (data) {
        updateRepoFilterOptions(currentViewState, data);
        updateReviewRepoOptions(currentViewState, data);
      } else {
        repoFilterSelect.innerHTML = "<option value=''>"+ "(all repos)" + "</option>";
        if (currentViewState.repoFilter) {
          const option = document.createElement("option");
          option.value = currentViewState.repoFilter;
          option.textContent = currentViewState.repoFilter;
          repoFilterSelect.appendChild(option);
        }
        repoFilterSelect.value = currentViewState.repoFilter || "";
        if (repoFilterPicker) {
          repoFilterPicker.syncFromSelect();
        }
        updateReviewRepoOptions(currentViewState, { availableRepos: currentViewState.reviewSelectedRepos });
      }
      syncReviewBasePickerState();
      renderReviewSelectedRepos();
      syncReviewPresetControls();
      syncViewedActionsState();
      syncPreviewControlsState();
      applyModeVisibility();
      syncFiltersButtonState(currentViewState);
      if (isFiltersPanelOpen()) {
        syncFiltersPanelMode();
        positionFiltersPanel();
      }
    }

    function renderLoadFailure(error, mode) {
      const activeMode = mode || currentViewState.mode;
      const message = error && error.message ? error.message : String(error);
      currentData = null;
      clearDiffSelectionActionSnapshot();
      selectionKeyValue = "";
      currentPreviewRow = null;
      currentPreviewSupportsPrimaryAction = false;
      currentPreviewVariant = PREVIEW_VARIANT_CURRENT;
      previewToken += 1;
      cancelActivePreviewRequest();
      closeRowContextMenu(false);
      emptyStateMessage = "No rows to display.";
      if (activeMode === "review") {
        setCurrentReviewPresets([]);
      }
      const activeModeLabel = modeDisplayLabelClient(activeMode);
      syncOpenButtonState();
      syncViewedActionsState();
      syncPreviewControlsState();
      if (activeMode === "browse") {
        metaEl.textContent = activeModeLabel + " data unavailable.";
        summaryEl.textContent = message;
        setListError("Failed to load browse rows: " + message);
        setDiffText("Unable to load browse rows.");
      } else if (activeMode === "compare") {
        metaEl.textContent = activeModeLabel + " data unavailable.";
        summaryEl.textContent = message;
        setListError("Failed to load compare rows: " + message);
        setDiffText("Unable to load compare rows.");
      } else if (activeMode === "review") {
        metaEl.textContent = activeModeLabel + " data unavailable.";
        summaryEl.textContent = message;
        setListError("Failed to load review rows: " + message);
        setDiffText("Unable to load review rows.");
      } else {
        metaEl.textContent = activeModeLabel + " data unavailable.";
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
      clearDiffSelectionActionSnapshot();
      selectionKeyValue = "";
      currentPreviewRow = null;
      currentPreviewSupportsPrimaryAction = false;
      cancelActivePreviewRequest();
      setCurrentReviewPresets([]);
      syncOpenButtonState();
      metaEl.textContent = "GUI bootstrap failed.";
      summaryEl.textContent = message;
      setListError("GUI bootstrap failed: " + message);
      renderPlainPreview("GUI bootstrap failed." + NEWLINE_CHAR + message, { className: "error" });
      inspectSummaryPanel.classList.add("hidden");
      inspectSummaryBody.replaceChildren();
      document.title = documentTitleRootLabelClient() + " GUI bootstrap failed";
      console.error(error);
    }

    function isAbortError(error) {
      return Boolean(error && (error.name === "AbortError" || error.message === "The operation was aborted."));
    }

    function isConnectionFailureError(error) {
      if (isAbortError(error)) {
        return false;
      }
      const name = String(error && error.name ? error.name : "");
      const message = String(error && error.message ? error.message : "");
      return name === "TypeError" || /Failed to fetch|NetworkError|Load failed/i.test(message);
    }

    function renderMetaAndSummary(data) {
      if (currentViewState.mode === "browse") {
        const t = data.targetFields || {};
        metaEl.textContent =
          "Baseline: HEAD" +
          " | Mode: " + modeDisplayLabelClient("browse") +
          " | Repo filter: " + repoScopeText(currentViewState.repoFilter) +
          " | Categories: " + browseCategoryLabel(currentViewState);
        summaryEl.textContent =
          "repos_in_scope=" + (t.repos_in_scope || "?") +
          " repos_with_changes=" + (t.repos_with_changes || "?") +
          " total_staged=" + (t.total_staged || "?") +
          " total_unstaged=" + (t.total_unstaged || "?") +
          " total_untracked=" + (t.total_untracked || "?") +
          " total_submodules=" + (t.total_submodules || "?");
      } else if (currentViewState.mode === "compare") {
        const t = data.targetFields || {};
        const s = data.summaryFields || {};
        const effectFiles = s.effect_files || "?";
        const shownFiles = s.shown_files || effectFiles || "?";
        const hiddenNoEffectFiles = s.hidden_no_effect_files || "0";
        metaEl.textContent =
          "Snapshot: " + (t.selected_snapshot_id || currentViewState.snapshotId || "?") +
          " | Mode: " + modeDisplayLabelClient("compare") +
          " | Repo filter: " + repoScopeText(currentViewState.repoFilter) +
          " | Rows: " + controlVisibleRowsLabel(currentViewState) +
          " | effect rows = restore would change the working tree" +
          " | shown rows = current filter result" +
          " | Base: " + compareBaseDisplayLabelClient(currentViewState.compareBase);
        summaryEl.textContent =
          "repos_checked=" + (s.repos_checked || "?") +
          " effect_rows=" + effectFiles +
          (String(shownFiles) === String(effectFiles) ? "" : (" shown_rows=" + shownFiles)) +
          " shown_lines=+" + (s.shown_lines_added || "0") + "/-" + (s.shown_lines_removed || "0") +
          (!currentViewState.compareIncludeNoEffect && String(hiddenNoEffectFiles) !== "0" ? " hidden_no_effect=" + hiddenNoEffectFiles : "");
      } else if (currentViewState.mode === "review") {
        const t = data.targetFields || {};
        const s = data.summaryFields || {};
        metaEl.textContent =
          "Default base: " + normalizeReviewBaseRefClient(t.default_base_ref, currentViewState.reviewBaseRef || "master") +
          " | Mode: " + modeDisplayLabelClient("review") +
          " | Selected repos: " + String(t.selected_repos || (currentViewState.reviewSelectedRepos || []).length || 0) +
          " | Scope: committed delta only" +
          " | Dirty badge = live working-tree metadata only" +
          (String(s.repos_fallback_to_master || t.repos_fallback_to_master || "0") !== "0"
            ? (" | fallback-to-master repos: " + String(s.repos_fallback_to_master || t.repos_fallback_to_master || "0"))
            : "");
        summaryEl.textContent =
          "repos_checked=" + (s.repos_checked || t.selected_repos || "0") +
          " repos_with_delta=" + (s.repos_with_delta || "0") +
          " shown_files=" + (s.shown_files || "0") +
          " shown_lines=+" + (s.shown_lines_added || "0") + "/-" + (s.shown_lines_removed || "0");
      } else {
        const t = data.targetFields || {};
        metaEl.textContent =
          "Snapshot: " + (t.snapshot_id || currentViewState.snapshotId || "?") +
          " | Mode: " + modeDisplayLabelClient("inspect") +
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

    function createDeltaPill(sign, value, tone, title) {
      const pill = document.createElement("div");
      pill.className = "list-pill diff-stat " + (tone === "remove" ? "diff-stat-remove" : "diff-stat-add");
      const valueNode = document.createElement("strong");
      valueNode.textContent = String(sign || "") + String(value == null ? "0" : value);
      pill.appendChild(valueNode);
      if (title) {
        pill.title = String(title);
      }
      return pill;
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

    function createTextPill(text, title, extraClassName) {
      const pill = document.createElement("div");
      pill.className = "list-pill" + (extraClassName ? (" " + extraClassName) : "");
      pill.textContent = String(text || "");
      if (title) {
        pill.title = String(title);
      }
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

      const pillSpecs = Array.isArray(pills) ? pills.filter((pill) => pill && (pill.label || pill.delta)) : [];
      if (!pillSpecs.length) {
        return header;
      }

      const stats = document.createElement("div");
      stats.className = "list-stats";
      for (const pill of pillSpecs) {
        if (pill && pill.delta) {
          stats.appendChild(createDeltaPill(pill.sign, pill.value, pill.tone, pill.title));
          continue;
        }
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
        compareBaseContextLabelClient(currentViewState.compareBase),
      ].join(" · ");
    }

    function browseListContext() {
      return [
        "HEAD",
        "browse",
        repoScopeText(currentViewState.repoFilter),
        browseRepoScopeLabel(),
        browseCategoryLabel(currentViewState),
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

    function reviewListContext(data) {
      const targetFields = data && data.targetFields ? data.targetFields : {};
      return [
        normalizeReviewBaseRefClient(targetFields.default_base_ref, currentViewState.reviewBaseRef || "master"),
        "review",
        (Array.isArray(currentViewState.reviewSelectedRepos) && currentViewState.reviewSelectedRepos.length)
          ? String(currentViewState.reviewSelectedRepos.length) + " selected repos"
          : "no selected repos",
      ].join(" · ");
    }

    function renderListHeader(data) {
      if (!data) return null;

      if (currentViewState.mode === "browse") {
        const visibleRepoRows = Array.isArray(data.visibleRepoRows) ? data.visibleRepoRows : [];
        const visibleFileRows = Array.isArray(data.fileRows) ? data.fileRows : [];
        const linesAdded = visibleRepoRows.reduce((sum, row) => sum + compareNumericField(row && row.lines_added, 0), 0);
        const linesRemoved = visibleRepoRows.reduce((sum, row) => sum + compareNumericField(row && row.lines_removed, 0), 0);
        return createListHeader("Live changes", browseListContext(), [
          { label: "files", value: visibleFileRows.length, primary: true },
          {
            delta: true,
            sign: "+",
            value: linesAdded,
            tone: "add",
            title: "Visible added lines across the live browse result.",
          },
          {
            delta: true,
            sign: "-",
            value: linesRemoved,
            tone: "remove",
            title: "Visible removed lines across the live browse result.",
          },
          { label: "repos", value: visibleRepoRows.length },
        ]);
      }

      if (currentViewState.mode === "compare") {
        const summary = data.summaryFields || {};
        const shownValue = displaySummaryValue(summary.shown_files, Array.isArray(data.rows) ? data.rows.length : 0);
        const effectValue = displaySummaryValue(summary.effect_files, shownValue);
        const pills = [
          { label: "effect", value: effectValue, primary: true },
        ];
        if (String(shownValue) !== String(effectValue)) {
          pills.push({ label: "shown", value: shownValue });
        }
        pills.push(
          {
            delta: true,
            sign: "+",
            value: displaySummaryValue(summary.shown_lines_added, 0),
            tone: "add",
            title: "Visible added lines for the current filter result.",
          },
          {
            delta: true,
            sign: "-",
            value: displaySummaryValue(summary.shown_lines_removed, 0),
            tone: "remove",
            title: "Visible removed lines for the current filter result.",
          },
          { label: "repos", value: summary.repos_checked }
        );
        return createListHeader("Compare rows", compareListContext(data), pills.map((pill) => {
          return Object.assign({}, pill, {
            label: pill.label,
            value: displaySummaryValue(pill.value, pill.fallback),
            primary: pill.primary,
          });
        }));
      }

      if (currentViewState.mode === "review") {
        const summary = data.summaryFields || {};
        return createListHeader("Review rows", reviewListContext(data), [
          { label: "files", value: displaySummaryValue(summary.shown_files, Array.isArray(data.rows) ? data.rows.length : 0), primary: true },
          {
            delta: true,
            sign: "+",
            value: displaySummaryValue(summary.shown_lines_added, 0),
            tone: "add",
            title: "Committed added lines across the selected repos.",
          },
          {
            delta: true,
            sign: "-",
            value: displaySummaryValue(summary.shown_lines_removed, 0),
            tone: "remove",
            title: "Committed removed lines across the selected repos.",
          },
          { label: "repos", value: displaySummaryValue(summary.repos_checked, Array.isArray(currentViewState.reviewSelectedRepos) ? currentViewState.reviewSelectedRepos.length : 0) },
        ]);
      }

      const visibleRepoRows = Array.isArray(data.visibleRepoRows) ? data.visibleRepoRows : [];
      const visibleFileRows = Array.isArray(data.fileRows) ? data.fileRows : [];
      const linesAdded = visibleRepoRows.reduce((sum, row) => sum + compareNumericField(row && row.lines_added, 0), 0);
      const linesRemoved = visibleRepoRows.reduce((sum, row) => sum + compareNumericField(row && row.lines_removed, 0), 0);
      return createListHeader("Snapshot contents", inspectListContext(data), [
        { label: "files", value: visibleFileRows.length, primary: true },
        {
          delta: true,
          sign: "+",
          value: linesAdded,
          tone: "add",
          title: "Captured added lines across the visible inspect result.",
        },
        {
          delta: true,
          sign: "-",
          value: linesRemoved,
          tone: "remove",
          title: "Captured removed lines across the visible inspect result.",
        },
        { label: "repos", value: visibleRepoRows.length },
      ]);
    }

    function bindSelectionButton(button, node, ariaLabel) {
      button.type = "button";
      button.classList.add("row");
      button.setAttribute("aria-selected", "false");
      button.setAttribute("aria-label", ariaLabel || selectionNodeLabel(node));
      button.dataset.rowKey = rowSelectionKey(node);
      button.__selectionNode = node;
      button.onclick = () => {
        selectRow(node, button).catch((err) => {
          if (!isAbortError(err)) {
            setDiffText((err && err.message) ? err.message : "Failed to load preview.");
          }
        });
      };
      button.onkeydown = (event) => handleRowKeydown(event, button);
      if (rowSelectionKey(node) === selectionKeyValue) {
        button.classList.add("active");
        button.setAttribute("aria-selected", "true");
      }
      return button;
    }

    function renderCompareList(data) {
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const repoSummaryRows = Array.isArray(data.repoRows) ? data.repoRows : [];
      listEl.innerHTML = "";
      const header = renderListHeader(data);
      if (header) {
        listEl.appendChild(header);
      }
      if (!rows.length) {
        appendListMessageNode(emptyStateMessage, "empty", Boolean(header));
        return;
      }
      const grouped = previewSelectionGroups({ mode: "compare" }, data);
      const rowsByRepo = grouped.rowsByRepo;
      const repoSummaryByRepo = new Map();
      for (const repoSummary of repoSummaryRows) {
        repoSummaryByRepo.set(String(repoSummary.repo || ""), repoSummary);
      }
      for (const repo of rowsByRepo.keys()) {
        const repoNode = document.createElement("div");
        repoNode.className = "repo";
        const repoHeader = document.createElement("div");
        repoHeader.className = "repo-header";
        const repoSelectionNode = selectionNodeFromRepoRow(repoSummaryByRepo.get(repo) || { repo });
        const repoButton = document.createElement("button");
        repoButton.className = "repo-select";
        bindSelectionButton(repoButton, repoSelectionNode, "Repo " + repo + " compare rows");

        const repoTitle = document.createElement("div");
        repoTitle.className = "repo-title";
        repoTitle.textContent = repo;
        repoButton.appendChild(repoTitle);

        const repoStats = document.createElement("div");
        repoStats.className = "repo-stats";
        const repoSummary = repoSummaryByRepo.get(repo) || {};
        const repoRows = rowsByRepo.get(repo) || [];
        const repoShown = compareNumericField(repoSummary.shown_files, repoRows.length);
        const repoEffect = compareNumericField(repoSummary.effect_files, repoShown);
        repoStats.appendChild(createListPill("effect", repoEffect, true));
        if (repoShown !== repoEffect) {
          repoStats.appendChild(createListPill("shown", repoShown, false));
        }
        repoStats.appendChild(createDeltaPill("+", compareNumericField(repoSummary.shown_lines_added, 0), "add", "Visible added lines in this repo section."));
       repoStats.appendChild(createDeltaPill("-", compareNumericField(repoSummary.shown_lines_removed, 0), "remove", "Visible removed lines in this repo section."));
        repoButton.appendChild(repoStats);

        repoHeader.appendChild(createSelectionRowShell(
          repoSelectionNode,
          repoButton,
          "Row actions for repo " + repo
        ));
        repoNode.appendChild(repoHeader);
        listEl.appendChild(repoNode);
        for (const row of repoRows) {
          const rowAccessibleLabel = String(row && row.display_label ? row.display_label : "").trim() || (compareRowRestoreEffectClient(row) === "none" ? "no restore effect" : (row.status || ""));
          listEl.appendChild(createFileRowShell(
            selectionNodeFromRow(row),
            (row.file || "(unknown)") + " [" + rowAccessibleLabel + "]",
            createCompareRowContent(row)
          ));
        }
      }
    }

    function renderReviewList(data) {
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const repoSummaryRows = Array.isArray(data.repoRows) ? data.repoRows : [];
      if (activeFilterableSelect && listEl.contains(activeFilterableSelect.root)) {
        activeFilterableSelect.close(false);
      }
      listEl.innerHTML = "";
      const header = renderListHeader(data);
      if (header) {
        listEl.appendChild(header);
      }

      if (!Array.isArray(currentViewState.reviewSelectedRepos) || currentViewState.reviewSelectedRepos.length === 0) {
        appendListMessageNode("Add one or more repos to start review.", "empty", Boolean(header));
        return;
      }

      const grouped = previewSelectionGroups({ mode: "review" }, data);
      const rowsByRepo = grouped.rowsByRepo;
      const repoSummaryByRepo = new Map();
      for (const repoSummary of repoSummaryRows) {
        repoSummaryByRepo.set(String(repoSummary.repo || ""), repoSummary);
      }

      for (const repo of currentViewState.reviewSelectedRepos) {
        const repoNode = document.createElement("div");
        repoNode.className = "repo";
        const repoHeader = document.createElement("div");
        repoHeader.className = "repo-header";

        const repoSummary = repoSummaryByRepo.get(repo) || {};
        const repoSelectionNode = selectionNodeFromRepoRow(repoSummary || { repo });
        const defaultBaseRef = normalizeReviewBaseRefClient(currentViewState.reviewBaseRef, "master");
        const baseState = reviewRepoBaseStateClient(repoSummary, repo, defaultBaseRef);
        const requestedBaseRef = baseState.requestedBaseRef;
        const effectiveBaseDisplay = baseState.effectiveBaseDisplay;
        const repoStatus = baseState.repoStatus;
        const repoMessage = baseState.repoMessage;
        const repoHeaderMain = document.createElement("button");
        repoHeaderMain.className = "repo-header-main repo-select";
        bindSelectionButton(repoHeaderMain, repoSelectionNode, "Repo " + repo + " review rows");
        const repoTitle = document.createElement("div");
        repoTitle.className = "repo-title";
        const branch = String(repoSummary.current_branch || "").trim();
        repoTitle.textContent = branch ? (String(repo) + " (" + branch + ")") : repo;
        repoHeaderMain.appendChild(repoTitle);

        const repoMeta = document.createElement("div");
        repoMeta.className = "repo-meta";
        repoMeta.appendChild(createTextPill(
          "base " + effectiveBaseDisplay,
          baseState.baseNote || "Effective review base for this repo."
        ));
        if (baseState.hasFallback) {
          repoMeta.appendChild(createTextPill(
            "fell back from " + baseState.requestedDescriptor,
            baseState.baseNote || repoMessage || ("Requested " + baseState.requestedDescriptor + " is unavailable here; fell back to local master."),
            "danger"
          ));
        } else if (baseState.isUnavailable) {
          repoMeta.appendChild(createTextPill(
            "missing " + baseState.requestedDescriptor,
            baseState.baseNote || repoMessage || ("Requested " + baseState.requestedDescriptor + " is unavailable here."),
            "danger"
          ));
        } else if (baseState.baseSource === "override") {
          repoMeta.appendChild(createTextPill("override " + requestedBaseRef, "This repo overrides the default review base."));
        }
        if (repoMeta.childNodes.length > 0) {
          repoHeaderMain.appendChild(repoMeta);
        }
        repoHeader.appendChild(createSelectionRowShell(
          repoSelectionNode,
          repoHeaderMain,
          "Row actions for repo " + repo
        ));

        const repoStats = document.createElement("div");
        repoStats.className = "repo-stats";
        repoStats.appendChild(createListPill("files", compareNumericField(repoSummary.files_changed, (rowsByRepo.get(repo) || []).length), true));
        repoStats.appendChild(createDeltaPill("+", compareNumericField(repoSummary.lines_added, 0), "add", "Committed added lines in this repo."));
        repoStats.appendChild(createDeltaPill("-", compareNumericField(repoSummary.lines_removed, 0), "remove", "Committed removed lines in this repo."));
        if (String(repoSummary.dirty || "") === "true") {
          repoStats.appendChild(createListPill("dirty", "yes", false));
        }
        repoHeader.appendChild(repoStats);

        const repoBaseControl = document.createElement("div");
        repoBaseControl.className = "review-repo-base-control";
        repoBaseControl.dataset.repo = repo;
        const repoBaseLabel = document.createElement("span");
        repoBaseLabel.className = "review-repo-base-control-label";
        repoBaseLabel.textContent = "Base";
        if (baseState.hasFallback || baseState.isUnavailable) {
          repoBaseLabel.title = baseState.baseNote || "";
        }
        repoBaseControl.appendChild(repoBaseLabel);
        const repoBaseSelect = document.createElement("select");
        const useDefaultOption = document.createElement("option");
        useDefaultOption.value = "";
        useDefaultOption.textContent = reviewUseDefaultLabelClient(baseState, defaultBaseRef);
        repoBaseSelect.appendChild(useDefaultOption);
        for (const ref of uniqueStrings(reviewRefOptionsForRepo(data, repo))) {
          const option = document.createElement("option");
          option.value = ref;
          option.textContent = ref;
          repoBaseSelect.appendChild(option);
        }
        const currentOverrideRef = String(currentViewState.reviewRepoBaseOverrides[repo] || "").trim();
        if (currentOverrideRef && !Array.from(repoBaseSelect.options).some((option) => option.value === currentOverrideRef)) {
          const option = document.createElement("option");
          option.value = currentOverrideRef;
          option.textContent = reviewCurrentOverrideOptionLabelClient(baseState);
          repoBaseSelect.appendChild(option);
        }
        repoBaseSelect.value = currentOverrideRef;
        const repoBasePickerRoot = document.createElement("div");
        repoBaseControl.appendChild(repoBasePickerRoot);
        createFilterableSelect(repoBasePickerRoot, {
          selectNode: repoBaseSelect,
          allowEmptyOption: true,
          allowCustomValue: true,
          ariaLabel: "Review base for " + repo,
          placeholderText: reviewUseDefaultLabelClient(baseState, defaultBaseRef),
          searchPlaceholder: "Filter refs or type a commit…",
          noMatchesText: "Press Enter to use this ref",
          onSelect(value) {
            updateReviewRepoBaseOverride(repo, value);
          },
        });
        repoHeader.appendChild(repoBaseControl);
        repoNode.appendChild(repoHeader);
        listEl.appendChild(repoNode);

        if (repoStatus === "baseline_missing" || repoStatus === "error" || repoStatus === "no_delta") {
          const emptyNode = document.createElement("div");
          emptyNode.className = "repo-empty";
          emptyNode.textContent = repoMessage || (repoStatus === "no_delta" ? ("No committed delta vs " + effectiveBaseDisplay + ".") : "Review data unavailable for this repo.");
          listEl.appendChild(emptyNode);
          continue;
        }

        const repoRows = rowsByRepo.get(repo) || [];
        if (!repoRows.length) {
          const emptyNode = document.createElement("div");
          emptyNode.className = "repo-empty";
          emptyNode.textContent = "No committed delta vs " + effectiveBaseDisplay + ".";
          listEl.appendChild(emptyNode);
          continue;
        }

        for (const row of repoRows) {
          listEl.appendChild(createFileRowShell(
            selectionNodeFromRow(row),
            row.file || "(unknown)",
            createCompareRowContent(row)
          ));
        }
      }
    }

    function renderBrowseList(data) {
      listEl.innerHTML = "";
      const header = renderListHeader(data);
      if (header) {
        listEl.appendChild(header);
      }
      const repoRows = Array.isArray(data.visibleRepoRows) ? data.visibleRepoRows : [];
      const fileRows = Array.isArray(data.fileRows) ? data.fileRows : [];
      const filesByRepo = data.fileRowsByRepo instanceof Map ? data.fileRowsByRepo : new Map();
      const filesByRepoCategory = data.fileRowsByRepoCategory instanceof Map ? data.fileRowsByRepoCategory : new Map();
      const categorySummaryByRepoCategory = data.categorySummaryByRepoCategory instanceof Map ? data.categorySummaryByRepoCategory : new Map();
      if (!repoRows.length) {
        appendListMessageNode(emptyStateMessage, "empty", Boolean(header));
        return;
      }

      for (const repoRow of repoRows) {
        const repo = repoRow.repo || "";
        const repoNode = document.createElement("div");
        repoNode.className = "repo";
        const repoButton = document.createElement("button");
        repoButton.className = "repo-select";
        const repoSelectionNode = selectionNodeFromRepoRow(repoRow);
        bindSelectionButton(repoButton, repoSelectionNode, "Repo " + repo + " live rows");
        const repoTitle = document.createElement("div");
        repoTitle.className = "repo-title";
        repoTitle.textContent = repo;
        repoButton.appendChild(repoTitle);
        const repoStats = document.createElement("div");
        repoStats.className = "repo-stats";
        repoStats.appendChild(createListPill("files", compareNumericField(repoRow.file_count, 0), true));
        repoStats.appendChild(createDeltaPill("+", compareNumericField(repoRow.lines_added, 0), "add", "Visible added lines in this repo."));
        repoStats.appendChild(createDeltaPill("-", compareNumericField(repoRow.lines_removed, 0), "remove", "Visible removed lines in this repo."));
        repoButton.appendChild(repoStats);
        repoNode.appendChild(createSelectionRowShell(
          repoSelectionNode,
          repoButton,
          "Row actions for repo " + repo
        ));
        listEl.appendChild(repoNode);

        const repoFiles = filesByRepo.get(repo) || [];
        if (!repoFiles.length) {
          const emptyNode = document.createElement("div");
          emptyNode.className = "repo-empty";
          emptyNode.textContent = "No live rows for the selected categories.";
          listEl.appendChild(emptyNode);
          continue;
        }

        for (const category of ["staged", "unstaged", "untracked", "submodules"]) {
          const categoryFiles = filesByRepoCategory.get(repoCategoryClientKey(repo, category)) || [];
          if (!categoryFiles.length) continue;
          const categorySummary = categorySummaryByRepoCategory.get(repoCategoryClientKey(repo, category)) || {};
          const categoryNode = document.createElement("button");
          categoryNode.className = "category category-select";
          const categorySelectionNode = selectionNodeFromCategoryRow(Object.assign({ repo, category }, categorySummary));
          bindSelectionButton(categoryNode, categorySelectionNode, category + " rows in " + repo);
          const categoryTitle = document.createElement("span");
          categoryTitle.className = "category-label";
          categoryTitle.textContent = category;
          categoryNode.appendChild(categoryTitle);
          const categoryStats = document.createElement("span");
          categoryStats.className = "repo-stats";
          categoryStats.appendChild(createListPill("files", compareNumericField(categorySummary.file_count, categoryFiles.length), true));
          categoryStats.appendChild(createDeltaPill("+", compareNumericField(categorySummary.lines_added, 0), "add", "Added lines in this category."));
          categoryStats.appendChild(createDeltaPill("-", compareNumericField(categorySummary.lines_removed, 0), "remove", "Removed lines in this category."));
          categoryNode.appendChild(categoryStats);
          listEl.appendChild(createSelectionRowShell(
            categorySelectionNode,
            categoryNode,
            "Row actions for " + category + " rows in " + repo
          ));

          for (const row of categoryFiles) {
            listEl.appendChild(createFileRowShell(
              selectionNodeFromRow(row),
              (row.file || "(unknown)") + " [" + (row.category || "") + "]",
              createBrowseRowContent(row)
            ));
          }
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
      const filesByRepo = data.fileRowsByRepo instanceof Map ? data.fileRowsByRepo : new Map();
      const filesByRepoCategory = data.fileRowsByRepoCategory instanceof Map ? data.fileRowsByRepoCategory : new Map();
      const categorySummaryByRepoCategory = data.categorySummaryByRepoCategory instanceof Map ? data.categorySummaryByRepoCategory : new Map();
      if (!repoRows.length) {
        appendListMessageNode(emptyStateMessage, "empty", Boolean(header));
        return;
      }

      for (const repoRow of repoRows) {
        const repo = repoRow.repo || "";
        const repoNode = document.createElement("div");
        repoNode.className = "repo";
        const repoButton = document.createElement("button");
        repoButton.className = "repo-select";
        const repoSelectionNode = selectionNodeFromRepoRow(repoRow);
        bindSelectionButton(repoButton, repoSelectionNode, "Repo " + repo + " snapshot rows");
        const repoTitle = document.createElement("div");
        repoTitle.className = "repo-title";
        repoTitle.textContent = repo;
        repoButton.appendChild(repoTitle);
        const repoStats = document.createElement("div");
        repoStats.className = "repo-stats";
        repoStats.appendChild(createListPill("files", compareNumericField(repoRow.file_count, 0), true));
        repoStats.appendChild(createDeltaPill("+", compareNumericField(repoRow.lines_added, 0), "add", "Captured added lines in this repo."));
        repoStats.appendChild(createDeltaPill("-", compareNumericField(repoRow.lines_removed, 0), "remove", "Captured removed lines in this repo."));
        repoButton.appendChild(repoStats);
        repoNode.appendChild(createSelectionRowShell(
          repoSelectionNode,
          repoButton,
          "Row actions for repo " + repo
        ));
        listEl.appendChild(repoNode);

        const repoFiles = filesByRepo.get(repo) || [];
        if (!repoFiles.length) {
          const emptyNode = document.createElement("div");
          emptyNode.className = "repo-empty";
          emptyNode.textContent = "No captured files for the selected categories.";
          listEl.appendChild(emptyNode);
          continue;
        }

        for (const category of ["staged", "unstaged", "untracked"]) {
          const categoryFiles = filesByRepoCategory.get(repoCategoryClientKey(repo, category)) || [];
          if (!categoryFiles.length) continue;
          const categorySummary = categorySummaryByRepoCategory.get(repoCategoryClientKey(repo, category)) || {};
          const categoryNode = document.createElement("button");
          categoryNode.className = "category category-select";
          const categorySelectionNode = selectionNodeFromCategoryRow(Object.assign({ repo, category }, categorySummary));
          bindSelectionButton(categoryNode, categorySelectionNode, category + " rows in " + repo);
          const categoryTitle = document.createElement("span");
          categoryTitle.className = "category-label";
          categoryTitle.textContent = category;
          categoryNode.appendChild(categoryTitle);
          const categoryStats = document.createElement("span");
          categoryStats.className = "repo-stats";
          categoryStats.appendChild(createListPill("files", compareNumericField(categorySummary.file_count, categoryFiles.length), true));
          categoryStats.appendChild(createDeltaPill("+", compareNumericField(categorySummary.lines_added, 0), "add", "Captured added lines in this category."));
          categoryStats.appendChild(createDeltaPill("-", compareNumericField(categorySummary.lines_removed, 0), "remove", "Captured removed lines in this category."));
          categoryNode.appendChild(categoryStats);
          listEl.appendChild(createSelectionRowShell(
            categorySelectionNode,
            categoryNode,
            "Row actions for " + category + " rows in " + repo
          ));

          for (const row of categoryFiles) {
            listEl.appendChild(createFileRowShell(
              selectionNodeFromRow(row),
              row.file || "(unknown)",
              createInspectRowContent(row)
            ));
          }
        }
      }
    }

    function renderList() {
      if (!currentData) {
        setListMessage(emptyStateMessage, "empty");
        return;
      }
      if (currentViewState.mode === "browse") {
        renderBrowseList(currentData);
      } else if (currentViewState.mode === "compare") {
        renderCompareList(currentData);
      } else if (currentViewState.mode === "review") {
        renderReviewList(currentData);
      } else {
        renderInspectList(currentData);
      }
      renderInspectSummary();
    }

    function noRowsPreviewMessage() {
      if (currentViewState.mode === "browse") {
        return "No live changes to preview for the current browse filter.";
      }
      if (currentViewState.mode === "compare") {
        return "No rows to display for current visibility filter.";
      }
      if (currentViewState.mode === "review") {
        return "No review rows to preview.";
      }
      return "No captured files to preview for current inspect filter.";
    }

    function selectionPromptMessage() {
      if (currentViewState.mode === "browse") {
        return "Select a repo, category, file, or submodule to preview live changes.";
      }
      if (currentViewState.mode === "compare") {
        return "Select a repo or file to preview diff.";
      }
      if (currentViewState.mode === "review") {
        return "Select a repo or file to preview committed diff.";
      }
      return "Select a repo, category, or file to preview captured patch or contents.";
    }

    async function restoreSelectionPreview() {
      const row = findCurrentRowBySelectionKey() || findBestSelectionFallbackNode();
      if (!row) {
        clearSelectedRowInViewState();
        selectionKeyValue = "";
        syncBrowserUrl(currentViewState);
        currentPreviewRow = null;
        currentPreviewSupportsPrimaryAction = false;
        currentAggregatePreviewState = null;
        currentPreviewVariant = PREVIEW_VARIANT_CURRENT;
        cancelActivePreviewRequest();
        closeRowContextMenu(false);
        syncOpenButtonState();
        syncPreviewControlsState();
        setDiffText(currentHasRows() ? selectionPromptMessage() : noRowsPreviewMessage());
        renderInspectSummary();
        return;
      }
      setSelectedRowInViewState(row);
      selectionKeyValue = rowSelectionKey(row);
      syncBrowserUrl(currentViewState);
      const rowKey = rowSelectionKey(row);
      const rowNode = rowButtons().find((node) => node.classList.contains("active") && node.dataset.rowKey === rowKey);
      if (rowNode) {
        await selectRow(row, rowNode, true);
      } else {
        const targetNode = rowButtons().find((node) => node.dataset.rowKey === rowKey);
        if (targetNode) {
          await selectRow(row, targetNode, true);
        } else {
          setDiffText(selectionPromptMessage());
        }
      }
    }

    function currentHasRows() {
      if (!currentData) return false;
      if (currentViewState.mode === "browse") {
        return Array.isArray(currentData.fileRows) && currentData.fileRows.length > 0;
      }
      if (currentViewState.mode === "compare" || currentViewState.mode === "review") {
        return Array.isArray(currentData.rows) && currentData.rows.length > 0;
      }
      return Array.isArray(currentData.fileRows) && currentData.fileRows.length > 0;
    }

    function buildPreviewRequestParams(node, previewOptions) {
      const params = new URLSearchParams(queryForViewState(currentViewState));
      const selectionKind = String(node && node.selection_kind ? node.selection_kind : "file");
      params.set("selection_kind", selectionKind);
      params.set("repo", node && node.repo ? node.repo : "");
      if (node && node.category) {
        params.set("category", node.category);
      }
      if (node && node.file) {
        params.set("file", node.file);
      }
      const options = previewOptions && typeof previewOptions === "object" ? previewOptions : {};
      if (selectionKind === "file" && String(options.previewVariant || PREVIEW_VARIANT_CURRENT) === PREVIEW_VARIANT_SINCE_VIEWED) {
        params.set("preview_variant", PREVIEW_VARIANT_SINCE_VIEWED);
      }
      if (selectionKind !== "file") {
        params.set("preview_offset", String(Math.max(0, Number(options.aggregateOffset || 0) || 0)));
        params.set(
          "preview_limit",
          String(Math.min(
            ${AGGREGATE_PREVIEW_MAX_PAGE_SIZE},
            Math.max(1, Number(options.aggregateLimit || ${AGGREGATE_PREVIEW_PAGE_SIZE}) || ${AGGREGATE_PREVIEW_PAGE_SIZE})
          ))
        );
      }
      return params;
    }

    function cancelActivePreviewRequest() {
      if (activePreviewController) {
        activePreviewController.abort();
        activePreviewController = null;
      }
    }

    async function selectRow(row, rowNode, preserveButtonState, previewOptions) {
      const node = row && row.selection_kind ? row : selectionNodeFromRow(row);
      const options = previewOptions && typeof previewOptions === "object" ? previewOptions : {};
      const appendingAggregate = options.appendAggregate === true && String(node && node.selection_kind ? node.selection_kind : "file") !== "file";
      const requestedSinceViewed = !appendingAggregate
        && String(node && node.selection_kind ? node.selection_kind : "file") === "file"
        && String(options.previewVariant || PREVIEW_VARIANT_CURRENT) === PREVIEW_VARIANT_SINCE_VIEWED;
      currentPreviewVariant = !appendingAggregate
        ? (
          String(node && node.selection_kind ? node.selection_kind : "file") === "file"
            && requestedSinceViewed
            ? PREVIEW_VARIANT_SINCE_VIEWED
            : PREVIEW_VARIANT_CURRENT
        )
        : currentPreviewVariant;
      setActiveRow(rowNode);
      setSelectedRowInViewState(node);
      selectionKeyValue = rowSelectionKey(node);
      syncBrowserUrl(currentViewState);
      currentPreviewRow = node || null;
      currentPreviewSupportsPrimaryAction = false;
      if (!(options.appendAggregate === true)) {
        currentAggregatePreviewState = null;
      }
      syncOpenButtonState();
      syncPreviewControlsState();
      renderInspectSummary();
      if (appendingAggregate) {
        setAggregatePreviewLoadingState(true);
      } else {
        setDiffLoading(node);
      }
      const token = previewToken + 1;
      previewToken = token;
      cancelActivePreviewRequest();
      const controller = new AbortController();
      activePreviewController = controller;
      const params = buildPreviewRequestParams(node, options);
      const endpoint = "/api/preview?" + params.toString();
      try {
      const res = await fetch(endpoint, {
        signal: controller.signal,
        cache: "no-store",
      });
        const previewSupportsPrimaryAction =
          String(res.headers.get("${PRIMARY_ACTION_SUPPORT_HEADER.toLowerCase()}") || "") !== "0";
        const contentType = String(res.headers.get("content-type") || "");
        if (contentType.includes("application/json")) {
          const payload = await res.json();
          if (token !== previewToken) return;
          if (!res.ok || !payload || payload.ok === false) {
            if (requestedSinceViewed) {
              currentPreviewVariant = PREVIEW_VARIANT_CURRENT;
              syncPreviewControlsState();
              await selectRow(node, rowNode, true, {
                previewVariant: PREVIEW_VARIANT_CURRENT,
              });
              return;
            }
            if (appendingAggregate) {
              handleAggregatePreviewAppendFailure(
                node,
                rowNode,
                (payload && payload.error) || "Failed to load more preview rows."
              );
              return;
            }
            currentPreviewSupportsPrimaryAction = false;
            currentAggregatePreviewState = null;
            syncOpenButtonState();
            setDiffText((payload && payload.error) || "Failed to load preview.");
            return;
          }
          if (payload.preview_kind === "aggregate_preview") {
            currentPreviewSupportsPrimaryAction = false;
            currentPreviewVariant = PREVIEW_VARIANT_CURRENT;
            syncOpenButtonState();
            const aggregateState = options.appendAggregate === true
              && currentAggregatePreviewState
              && currentAggregatePreviewState.selectionKey === rowSelectionKey(node)
              ? Object.assign({}, payload, {
                blocks: currentAggregatePreviewState.blocks.concat(Array.isArray(payload.blocks) ? payload.blocks : []),
              })
              : Object.assign({}, payload, {
                blocks: Array.isArray(payload.blocks) ? payload.blocks.slice() : [],
              });
            currentAggregatePreviewState = {
              selectionKey: rowSelectionKey(node),
              title: String(aggregateState.title || ""),
              summaryText: String(aggregateState.summary_text || ""),
              emptyMessage: String(aggregateState.empty_message || ""),
              totalRows: Number(aggregateState.total_rows || aggregateState.blocks.length || 0) || 0,
              blocks: aggregateState.blocks.slice(),
              renderedRows: Number(aggregateState.rendered_rows || aggregateState.blocks.length || 0) || 0,
              nextOffset: Number(aggregateState.next_offset || aggregateState.blocks.length || 0) || 0,
              hasMore: Boolean(aggregateState.has_more),
            };
            renderStoredAggregatePreview(node, rowNode, { preserveScroll: appendingAggregate });
            syncPreviewControlsState();
            return;
          }
          if (payload.preview_kind === "submodule_summary") {
            currentPreviewSupportsPrimaryAction = false;
            currentAggregatePreviewState = null;
            currentPreviewVariant = PREVIEW_VARIANT_CURRENT;
            syncOpenButtonState();
            renderSubmoduleSummary(payload.data || {});
            syncPreviewControlsState();
            return;
          }
          if (payload.preview_kind === "since_viewed_summary") {
            currentPreviewSupportsPrimaryAction = false;
            currentAggregatePreviewState = null;
            syncOpenButtonState();
            renderSinceViewedSummary(payload.data || {});
            syncPreviewControlsState();
            return;
          }
          currentPreviewSupportsPrimaryAction =
            (currentViewState.mode === "compare" || currentViewState.mode === "browse") && previewSupportsPrimaryAction;
          currentAggregatePreviewState = null;
          syncOpenButtonState();
          setDiffText(JSON.stringify(payload, null, 2));
          syncPreviewControlsState();
          return;
        }

        const previewText = await res.text();
        if (token !== previewToken) return;
        if (!res.ok) {
          if (requestedSinceViewed) {
            currentPreviewVariant = PREVIEW_VARIANT_CURRENT;
            syncPreviewControlsState();
            await selectRow(node, rowNode, true, {
              previewVariant: PREVIEW_VARIANT_CURRENT,
            });
            return;
          }
          if (appendingAggregate) {
            handleAggregatePreviewAppendFailure(
              node,
              rowNode,
              previewText || "Failed to load more preview rows."
            );
            return;
          }
          currentPreviewSupportsPrimaryAction = false;
          currentAggregatePreviewState = null;
          syncOpenButtonState();
          setDiffText(previewText || "Failed to load preview.");
          return;
        }
        currentPreviewSupportsPrimaryAction =
          (currentViewState.mode === "compare" || currentViewState.mode === "browse") && previewSupportsPrimaryAction;
        currentAggregatePreviewState = null;
        syncOpenButtonState();
        if (requestedSinceViewed) {
          renderSinceViewedDiffText(previewText);
        } else {
          setDiffText(previewText);
        }
        syncPreviewControlsState();
      } catch (err) {
        if (isAbortError(err)) {
          return;
        }
        if (appendingAggregate) {
          handleAggregatePreviewAppendFailure(
            node,
            rowNode,
            "Failed to load more preview rows."
          );
          return;
        }
        throw err;
      } finally {
        if (activePreviewController === controller) {
          activePreviewController = null;
        }
      }
    }

    async function triggerPrimaryAction() {
      const row = findCurrentRowBySelectionKey();
      if (!row || String(row.selection_kind || "file") !== "file" || (currentViewState.mode !== "compare" && currentViewState.mode !== "browse")) return;
      const params = new URLSearchParams(queryForViewState(currentViewState));
      params.set("repo", row.repo || "");
      params.set("file", row.file || "");
      if (row.category) {
        params.set("category", row.category);
      }
      const res = await fetch("/api/open?" + params.toString(), { method: "POST" });
      const data = await res.json();
      if (!data.ok) {
        alert(data.error || primaryActionFailureMessage());
      }
    }

    async function reloadCurrentPreviewVariant(variant) {
      const row = currentSelectedFileRow();
      if (!row) {
        return;
      }
      const rowKey = rowSelectionKey(row);
      const rowNode = rowButtons().find((node) => String(node.dataset.rowKey || "") === rowKey);
      if (!rowNode) {
        return;
      }
      await selectRow(row, rowNode, true, {
        previewVariant: String(variant || PREVIEW_VARIANT_CURRENT) === PREVIEW_VARIANT_SINCE_VIEWED
          ? PREVIEW_VARIANT_SINCE_VIEWED
          : PREVIEW_VARIANT_CURRENT,
      });
    }

    async function loadSnapshots(forceRefresh, selectedSnapshotId) {
      const requestedSnapshotId = String(selectedSnapshotId || currentViewState.snapshotId || "");
      const params = new URLSearchParams();
      params.set("selected_snapshot_id", requestedSnapshotId);
      if (forceRefresh) {
        params.set("force", "1");
      }
      if (storedShowAutoSnapshots) {
        params.set("include_auto", "1");
      }
      const res = await fetch("/api/snapshots?" + params.toString(), {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || "Failed to load snapshots.");
      }
      snapshots = normalizeSnapshotsClient(data.snapshots || []);
      updateSnapshotOptions(requestedSnapshotId);
      return snapshots;
    }

    function resolveHardRefreshMode(preferredMode, resolvedSnapshotId) {
      const normalizedMode = String(preferredMode || currentViewState.mode || "compare");
      return (normalizedMode === "compare" || normalizedMode === "inspect") && !resolvedSnapshotId
        ? "browse"
        : normalizedMode;
    }

    async function reloadSnapshotsAndData(options) {
      const preferredSnapshotId = String((options && options.preferredSnapshotId) || "");
      const preferredMode = String((options && options.preferredMode) || modeSelect.value || currentViewState.mode || "compare");
      await loadSnapshots(true, preferredSnapshotId);

      const resolvedSnapshotId = selectedSnapshotIdValue();
      const nextMode = (preferredMode === "compare" || preferredMode === "inspect") && !resolvedSnapshotId
        ? "browse"
        : preferredMode;

      currentViewState.snapshotId = resolvedSnapshotId;
      currentViewState.mode = nextMode;
      modeSelect.value = nextMode;
      syncModePickerState();
      applyModeVisibility();
      syncBrowserUrl(currentViewState);
      await loadData(true);
      return {
        snapshotId: selectedSnapshotIdValue(),
        mode: modeSelect.value,
      };
    }

    async function applySnapshotSelection(snapshotId) {
      const nextSnapshotId = String(snapshotId || "");
      if (!nextSnapshotId || nextSnapshotId === selectedSnapshotIdValue()) {
        closeSnapshotPanel(true);
        return;
      }

      snapshotSelect.value = nextSnapshotId;
      currentViewState.snapshotId = nextSnapshotId;
      closeSnapshotPanel(true);

      try {
        await loadSnapshots(false, nextSnapshotId);
        await loadData(false);
      } catch (err) {
        renderLoadFailure(err, modeSelect.value);
      }
    }

    async function submitRenameSnapshot() {
      const oldSnapshotId = String(renameSnapshotTargetId || "");
      const newSnapshotId = String(renameSnapshotInput.value || "").trim();
      if (!oldSnapshotId) {
        setRenameSnapshotStatus("Choose a snapshot to rename first.", "error");
        return;
      }

      setRenameSnapshotDialogBusy(true);
      setRenameSnapshotStatus("Renaming snapshot…", "");
      try {
        const res = await fetch("/api/snapshot-rename", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            old_snapshot_id: oldSnapshotId,
            new_snapshot_id: newSnapshotId,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data || !data.ok) {
          setRenameSnapshotStatus((data && data.error) || "Failed to rename snapshot.", "error");
          return;
        }

        const preferredSnapshotId = selectedSnapshotIdValue() === oldSnapshotId
          ? String(data.new_snapshot_id || newSnapshotId)
          : selectedSnapshotIdValue();

        closeRenameSnapshotDialog(false);
        await reloadSnapshotsAndData({
          preferredSnapshotId,
          preferredMode: modeSelect.value,
        });
        if (isSnapshotPanelOpen()) {
          window.setTimeout(() => {
            if (!focusSnapshotEntryControl(preferredSnapshotId, ".snapshot-entry-action.rename")) {
              if (!focusSnapshotEntryControl(preferredSnapshotId, "")) {
                snapshotPickerButton.focus();
              }
            }
          }, 0);
        } else {
          snapshotPickerButton.focus();
        }
      } finally {
        if (isRenameSnapshotDialogOpen()) {
          setRenameSnapshotDialogBusy(false);
        }
      }
    }

    async function confirmDeleteSnapshot() {
      const snapshotId = String(deleteSnapshotTargetId || "");
      if (!snapshotId) {
        setDeleteSnapshotStatus("Choose a snapshot to delete first.", "error");
        return;
      }

      setDeleteSnapshotDialogBusy(true);
      setDeleteSnapshotStatus("Deleting snapshot…", "");
      try {
        const res = await fetch("/api/snapshot-delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            snapshot_id: snapshotId,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data || !data.ok) {
          setDeleteSnapshotStatus((data && data.error) || "Failed to delete snapshot.", "error");
          return;
        }

        const deletedSelectedSnapshot = selectedSnapshotIdValue() === snapshotId;
        if (deletedSelectedSnapshot) {
          currentViewState.snapshotId = "";
          snapshotSelect.value = "";
        }
        const preferredSnapshotId = deletedSelectedSnapshot ? "" : selectedSnapshotIdValue();
        closeDeleteSnapshotDialog(false);
        await reloadSnapshotsAndData({
          preferredSnapshotId,
          preferredMode: modeSelect.value,
        });
        if (isSnapshotPanelOpen()) {
          const focusSnapshotId = selectedSnapshotIdValue() || (snapshots[0] && snapshots[0].id) || "";
          window.setTimeout(() => {
            if (!focusSnapshotEntryControl(focusSnapshotId, ".snapshot-entry-action.delete")) {
              if (!focusSnapshotEntryControl(focusSnapshotId, "")) {
                snapshotPickerButton.focus();
              }
            }
          }, 0);
        } else if (!snapshotPickerButton.classList.contains("hidden")) {
          snapshotPickerButton.focus();
        }
      } finally {
        if (isDeleteSnapshotDialogOpen()) {
          setDeleteSnapshotDialogBusy(false);
        }
      }
    }

    async function applySnapshotShowAutoPreference(nextValue) {
      storedShowAutoSnapshots = Boolean(nextValue);
      saveStoredSnapshotShowAuto(storedShowAutoSnapshots);
      await loadSnapshots(true, selectedSnapshotIdValue());
      if (isSnapshotPanelOpen()) {
        snapshotShowAutoCheckbox.focus();
      }
    }

    function ensureCompareEmptyState(data) {
      const rows = Array.isArray(data.rows) ? data.rows : [];
      const summary = data.summaryFields || {};
      const hiddenNoEffect = Number(summary.hidden_no_effect_files || 0);
      if (!rows.length && !currentViewState.compareIncludeNoEffect && hiddenNoEffect > 0) {
        emptyStateMessage = "No restore-effect rows. Toggle show no-effect rows to include snapshot-aligned files.";
      } else {
        emptyStateMessage = "No rows to display.";
      }
    }

    function ensureCompareDerivedData(data) {
      data.rows = Array.isArray(data.rows) ? data.rows : [];
      data.repoRows = Array.isArray(data.repoRows) ? data.repoRows : [];
      ensureCompareEmptyState(data);
    }

    function repoCategoryClientKey(repoRel, category) {
      return String(repoRel || "") + "\\0" + String(category || "");
    }

    function buildClientPreviewSelectionGroups(data, mode) {
      const normalizedMode = String(mode || "");
      const rows = (normalizedMode === "compare" || normalizedMode === "review")
        ? (Array.isArray(data && data.rows) ? data.rows : [])
        : (Array.isArray(data && data.fileRows) ? data.fileRows : []);
      return buildPreviewSelectionGroupsFromCollections(
        normalizedMode,
        rows,
        Array.isArray(data && data.categoryRows) ? data.categoryRows : []
      );
    }

    function previewSelectionGroups(viewState, data) {
      const normalizedMode = String(viewState && viewState.mode ? viewState.mode : "");
      if (!data || typeof data !== "object") {
        return buildClientPreviewSelectionGroups(data, normalizedMode);
      }
      if (!data.__previewSelectionGroups || data.__previewSelectionGroupsMode !== normalizedMode) {
        Object.defineProperty(data, "__previewSelectionGroups", {
          value: buildClientPreviewSelectionGroups(data, normalizedMode),
          configurable: true,
          enumerable: false,
          writable: true,
        });
        Object.defineProperty(data, "__previewSelectionGroupsMode", {
          value: normalizedMode,
          configurable: true,
          enumerable: false,
          writable: true,
        });
      }
      return data.__previewSelectionGroups;
    }

    function previewSelectionRepoRow(data, repoRel) {
      const repoRows = Array.isArray(data && data.repoRows) ? data.repoRows : [];
      const normalizedRepo = String(repoRel || "");
      return repoRows.find((row) => String(row && row.repo ? row.repo : "") === normalizedRepo) || null;
    }

    function reviewPreviewContext(previewRow) {
      const repoRel = String(previewRow && previewRow.repo ? previewRow.repo : "");
      const repoRow = repoRel ? previewSelectionRepoRow(currentData, repoRel) : null;
      const effectiveBaseRef = String(
        previewRow && previewRow.effective_base_ref
          ? previewRow.effective_base_ref
          : (repoRow && repoRow.effective_base_ref ? repoRow.effective_base_ref : "")
      ).trim() || normalizeReviewBaseRefClient(currentViewState.reviewBaseRef, "master");
      const mergeBase = String(
        previewRow && previewRow.merge_base
          ? previewRow.merge_base
          : (repoRow && repoRow.merge_base ? repoRow.merge_base : "")
      ).trim();
      return {
        effectiveBaseRef,
        mergeBase,
      };
    }

    function ensureBrowseDerivedData(data) {
      const repoRows = Array.isArray(data.repoRows) ? data.repoRows : [];
      const fileRows = Array.isArray(data.fileRows) ? data.fileRows : [];
      const categoryRows = Array.isArray(data.categoryRows) ? data.categoryRows : [];
      const visibleRepoRows = repoRows.filter((row) => {
        if (currentViewState.repoFilter && (row.repo || "") !== currentViewState.repoFilter) {
          return false;
        }
        if (currentViewState.browseShowAllRepos) return true;
        return (row.has_changes || "false") === "true";
      });

      const visibleRepoSet = new Set(visibleRepoRows.map((row) => row.repo || ""));
      data.visibleRepoRows = visibleRepoRows;
      data.fileRows = fileRows.filter((row) => visibleRepoSet.has(row.repo || ""));
      data.visibleCategoryRows = categoryRows.filter((row) => {
        return visibleRepoSet.has(row.repo || "")
          && Number(row.file_count || 0) > 0;
      });
      const grouped = buildClientPreviewSelectionGroups(data, "browse");
      data.fileRowsByRepo = grouped.rowsByRepo;
      data.fileRowsByRepoCategory = grouped.rowsByRepoCategory;
      data.categorySummaryByRepoCategory = grouped.categorySummaryByRepoCategory;
      emptyStateMessage = visibleRepoRows.length ? "No live rows for the selected categories." : "No repos to display.";
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
      data.visibleCategoryRows = categoryRows.filter((row) => {
        return visibleRepoSet.has(row.repo || "")
          && Number(row.file_count || 0) > 0;
      });
      const grouped = buildClientPreviewSelectionGroups(data, "inspect");
      data.fileRowsByRepo = grouped.rowsByRepo;
      data.fileRowsByRepoCategory = grouped.rowsByRepoCategory;
      data.categorySummaryByRepoCategory = grouped.categorySummaryByRepoCategory;
      emptyStateMessage = visibleRepoRows.length ? "No captured files for the selected categories." : "No repos to display.";
    }

    async function loadData(forceRefresh, options) {
      const loadOptions = options && typeof options === "object" ? options : {};
      const requestedViewState = viewStateFromControls();
      const requestedMode = requestedViewState.mode;
      const previousViewState = currentViewState ? Object.assign({}, currentViewState) : null;
      const previousViewDataToken = String(currentViewDataToken || "");
      const hadCurrentData = Boolean(currentData);
      const requestToken = loadToken + 1;
      loadToken = requestToken;
      cancelActivePreviewRequest();
      if (activeLoadController) {
        activeLoadController.abort();
      }
      const controller = new AbortController();
      activeLoadController = controller;
      currentViewState = requestedViewState;
      refreshViewStatus = "current";
      refreshHintMessage = REFRESH_STATE_HINT_TEXT;
      currentViewPrepareState = "current";
      currentViewDataToken = "";
      currentServerInstanceId = "";
      applyModeVisibility();
      closeRowContextMenu(false);
      syncViewedActionsState();
      syncPreviewControlsState();
      if (requestedMode === "browse") {
        setListLoading("Loading browse rows...");
        setDiffText("Loading browse rows...");
      } else if (requestedMode === "compare") {
        setListLoading("Loading compare rows...");
        setDiffText("Loading compare rows...");
      } else if (requestedMode === "review") {
        setListLoading("Loading review rows...");
        setDiffText("Loading review rows...");
      } else {
        setListLoading("Loading inspect rows...");
        setDiffText("Loading inspect rows...");
      }
      openBtn.disabled = true;

      const params = new URLSearchParams(queryForViewState(currentViewState));
      const forceLiveReload = shouldForceInitialLiveViewLoad(
        previousViewState,
        requestedViewState,
        hadCurrentData,
        previousViewDataToken
      );
      if (forceRefresh || requestedMode === "review" || forceLiveReload) params.set("force", "1");
      if (loadOptions.explicitRefresh === true && !forceRefresh) params.set("explicit_refresh", "1");
      try {
        const res = await fetch("/api/data?" + params.toString(), {
          signal: controller.signal,
          cache: "no-store",
        });
        const data = await res.json();
        if (requestToken !== loadToken) {
          return;
        }
        if (!res.ok) {
          throw new Error(data.error || "Failed to load GUI data.");
        }

        markServerConnectionSuccess();
        currentData = data;
        currentServerInstanceId = String(data.server_instance_id || "");
        currentViewDataToken = String(data.view_data_token || "");
        currentViewPrepareState = String(data.view_prepare_state || "current");
        refreshViewStatus = currentViewPrepareState === "preparing" ? "preparing" : "current";
        if (requestedMode === "browse") {
          ensureBrowseDerivedData(currentData);
        } else if (requestedMode === "compare") {
          ensureCompareDerivedData(currentData);
        } else if (requestedMode === "review") {
          emptyStateMessage = "Add one or more repos to start review.";
        } else {
          ensureInspectDerivedData(currentData);
        }
        setControlsFromViewState(data.viewState || requestedViewState, currentData);
        syncBrowserUrl(currentViewState);
        renderMetaAndSummary(currentData);
        renderList();
        Promise.resolve()
          .then(() => restoreSelectionPreview())
          .catch((err) => {
            if (requestToken !== loadToken || isAbortError(err)) {
              return;
            }
            currentPreviewSupportsPrimaryAction = false;
            syncOpenButtonState();
            setDiffText((err && err.message) ? err.message : "Failed to load preview.");
          });
        scheduleRefreshStatePoll(true);
      } catch (err) {
        if (requestToken !== loadToken || isAbortError(err)) {
          return;
        }
        if (isConnectionFailureError(err)) {
          recordServerConnectionFailure(1);
        }
        throw err;
      } finally {
        if (activeLoadController === controller) {
          activeLoadController = null;
        }
      }
    }

    async function performViewRefresh() {
      await loadData(false, {
        explicitRefresh: true,
      });
    }

    async function reloadSnapshotsAction() {
      const preferredSnapshotId = selectedSnapshotIdValue();
      const preferredMode = modeSelect.value || currentViewState.mode || "compare";
      await loadSnapshots(true, preferredSnapshotId);
      const resolvedSnapshotId = snapshots.some((snapshot) => snapshot.id === preferredSnapshotId)
        ? preferredSnapshotId
        : selectAvailableSnapshotId(preferredSnapshotId);
      const nextMode = resolveHardRefreshMode(preferredMode, resolvedSnapshotId);
      snapshotSelect.value = resolvedSnapshotId || "";
      currentViewState.snapshotId = resolvedSnapshotId || "";
      currentViewState.mode = nextMode;
      modeSelect.value = nextMode;
      syncModePickerState();
      applyModeVisibility();
      syncBrowserUrl(currentViewState);
      await loadData(false);
    }

    async function triggerRefreshAction(kind) {
      const refreshKind = kind === "reload-snapshots" ? "reload-snapshots" : "refresh";
      refreshActionBusy = true;
      syncRefreshButtonHintState();
      openBtn.disabled = true;
      try {
        if (refreshKind === "reload-snapshots") {
          await reloadSnapshotsAction();
        } else {
          if (currentViewState.mode === "inspect") {
            await reloadSnapshotsAction();
          } else {
            await performViewRefresh();
          }
        }
      } catch (err) {
        renderLoadFailure(err, modeSelect.value);
      } finally {
        refreshActionBusy = false;
        syncRefreshButtonHintState();
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

    function ensureBrowseCategories(eventTarget) {
      if (browseStaged.checked || browseUnstaged.checked || browseUntracked.checked || browseSubmodules.checked) {
        return;
      }
      if (eventTarget) {
        eventTarget.checked = true;
      } else {
        browseStaged.checked = true;
        browseUnstaged.checked = true;
        browseUntracked.checked = true;
        browseSubmodules.checked = true;
      }
    }

    async function applyCompareBaseSelection(compareBase) {
      const normalizedBase = normalizeCompareBaseClient(compareBase);
      currentViewState.compareBase = normalizedBase;
      compareBaseWorkingTree.checked = normalizedBase === "working-tree";
      compareBaseSnapshot.checked = normalizedBase === "snapshot";
      saveStoredCompareBase(normalizedBase);
      syncBrowserUrl(currentViewState);
      syncFiltersButtonState(currentViewState);
      if (currentData && currentViewState.mode === "compare") {
        await loadData(false);
      } else if (currentData) {
        renderMetaAndSummary(currentData);
        renderList();
        await restoreSelectionPreview();
      } else {
        updateDocumentTitle(null);
      }
    }

    async function createSnapshotFromBrowse() {
      const snapshotId = String(createSnapshotIdInput.value || "").trim();
      const clearAfterCapture = createSnapshotClearCheckbox.checked;

      createSnapshotBtn.disabled = true;
      setCreateSnapshotDialogBusy(true);
      setCreateSnapshotStatus(
        clearAfterCapture ? "Creating snapshot and clearing the working tree…" : "Creating snapshot…",
        ""
      );
      try {
        const res = await fetch("/api/create-snapshot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            snapshot_id: snapshotId,
            clear: clearAfterCapture,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data || !data.ok) {
          setCreateSnapshotStatus((data && data.error) || "Failed to create snapshot.", "error");
          return;
        }

        closeCreateSnapshotDialog();
        await reloadSnapshotsAndData({
          preferredSnapshotId: String(data.snapshot_id || snapshotId),
          preferredMode: "compare",
        });
      } finally {
        createSnapshotBtn.disabled = false;
        if (isCreateSnapshotDialogOpen()) {
          setCreateSnapshotDialogBusy(false);
        }
      }
    }

    async function submitResetAll() {
      const createSnapshotFirst = Boolean(resetAllSnapshotChoice);

      resetAllBtn.disabled = true;
      setResetAllConfirmDialogBusy(true);
      setResetAllConfirmStatus(
        createSnapshotFirst ? "Creating an auto snapshot and resetting live changes…" : "Resetting live changes…",
        ""
      );
      try {
        const res = await fetch("/api/reset-all", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            mode: currentViewState.mode,
            snapshot: createSnapshotFirst,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data || !data.ok) {
          setResetAllConfirmStatus((data && data.error) || "Failed to reset live changes.", "error");
          return;
        }

        closeResetAllConfirmDialog(false);
        if (createSnapshotFirst) {
          currentViewState.snapshotId = "";
          snapshotSelect.value = "";
        }
        await reloadSnapshotsAndData({
          preferredSnapshotId: createSnapshotFirst ? "" : selectedSnapshotIdValue(),
          preferredMode: "browse",
        });
        if (!resetAllBtn.classList.contains("hidden")) {
          resetAllBtn.focus();
        }
      } finally {
        resetAllBtn.disabled = false;
        if (isResetAllConfirmDialogOpen()) {
          setResetAllConfirmDialogBusy(false);
        }
      }
    }

    modeSelect.addEventListener("change", () => {
      currentViewState.mode = modeSelect.value;
      syncModePickerState();
      applyModeVisibility();
      syncFiltersButtonState(viewStateFromControls());
      scheduleRefreshStatePoll(true);
      scheduleRefresh();
    });
    splitterEl.addEventListener("pointerdown", beginSplitDrag);
    splitterEl.addEventListener("pointermove", updateSplitDrag);
    splitterEl.addEventListener("pointerup", endSplitDrag);
    splitterEl.addEventListener("pointercancel", endSplitDrag);
    splitterEl.addEventListener("keydown", handleSplitterKeydown);
    window.addEventListener("resize", () => {
      applyResponsiveSplitLayout();
      positionSnapshotPanel();
      positionFiltersPanel();
    });
    if (typeof splitLayoutMedia.addEventListener === "function") {
      splitLayoutMedia.addEventListener("change", () => {
        applyResponsiveSplitLayout();
        positionSnapshotPanel();
        positionFiltersPanel();
      });
    } else if (typeof splitLayoutMedia.addListener === "function") {
      splitLayoutMedia.addListener(() => {
        applyResponsiveSplitLayout();
        positionSnapshotPanel();
        positionFiltersPanel();
      });
    }
    snapshotSelect.addEventListener("change", () => scheduleRefresh());
    repoFilterSelect.addEventListener("change", () => {
      if (repoFilterPicker) {
        repoFilterPicker.syncFromSelect();
      }
      syncFiltersButtonState(viewStateFromControls());
      scheduleRefresh();
    });
    compareIncludeNoEffect.addEventListener("change", () => {
      syncFiltersButtonState(viewStateFromControls());
      scheduleRefresh();
    });
    [compareBaseWorkingTree, compareBaseSnapshot].forEach((radio) => {
      radio.addEventListener("change", () => {
        if (!radio.checked) return;
        applyCompareBaseSelection(radio.value).catch((err) => alert(String(err)));
        scheduleRefreshStatePoll(true);
      });
    });
    inspectAllRepos.addEventListener("change", () => {
      syncFiltersButtonState(viewStateFromControls());
      scheduleRefresh();
    });
    browseAllRepos.addEventListener("change", () => {
      syncFiltersButtonState(viewStateFromControls());
      scheduleRefresh();
    });
    [inspectStaged, inspectUnstaged, inspectUntracked].forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        ensureInspectCategories(checkbox);
        syncFiltersButtonState(viewStateFromControls());
        scheduleRefresh();
      });
    });
    [browseStaged, browseUnstaged, browseUntracked, browseSubmodules].forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        ensureBrowseCategories(checkbox);
        syncFiltersButtonState(viewStateFromControls());
        scheduleRefresh();
      });
    });
    snapshotPickerButton.onclick = () => {
      if (isSnapshotPanelOpen()) {
        closeSnapshotPanel(true);
        return;
      }
      openSnapshotPanel();
    };
    snapshotOverlay.addEventListener("click", (event) => {
      if (event.target === snapshotOverlay) {
        closeSnapshotPanel(true);
      }
    });
    snapshotShowAutoCheckbox.addEventListener("change", () => {
      applySnapshotShowAutoPreference(snapshotShowAutoCheckbox.checked).catch((err) => alert(String(err)));
    });
    filtersButton.onclick = () => {
      if (isFiltersPanelOpen()) {
        closeFiltersPanel(true);
        return;
      }
      openFiltersPanel();
    };
    filtersDoneBtn.onclick = () => closeFiltersPanel(true);
    filtersResetBtn.onclick = () => resetFiltersToDefaults();
    filtersOverlay.addEventListener("click", (event) => {
      if (event.target === filtersOverlay) {
        closeFiltersPanel(true);
      }
    });
    document.addEventListener("mousedown", (event) => {
      if (!activeFilterableSelect) {
        if (isReviewPresetActionsMenuOpen()) {
          if (reviewPresetActions && reviewPresetActions.contains(event.target)) {
            return;
          }
          closeReviewPresetActionsMenu(false);
        }
        if (isViewedActionsMenuOpen()) {
          if (viewedActions && viewedActions.contains(event.target)) {
            return;
          }
          closeViewedActionsMenu(false);
        }
        if (isRowContextMenuOpen()) {
          if (rowContextMenu && rowContextMenu.contains(event.target)) {
            return;
          }
          closeRowContextMenu(false);
        }
      if (isDiffSelectionContextMenuOpen()) {
        if (diffSelectionContextMenu && diffSelectionContextMenu.contains(event.target)) {
          return;
        }
        closeDiffSelectionContextMenu(false);
        }
        return;
      }
      const root = activeFilterableSelect.root;
      if (root && root.contains(event.target)) {
        return;
      }
      activeFilterableSelect.close(false);
      if (isReviewPresetActionsMenuOpen()) {
        if (reviewPresetActions && reviewPresetActions.contains(event.target)) {
          return;
        }
        closeReviewPresetActionsMenu(false);
      }
      if (isViewedActionsMenuOpen()) {
        if (viewedActions && viewedActions.contains(event.target)) {
          return;
        }
        closeViewedActionsMenu(false);
      }
      if (isRowContextMenuOpen()) {
        if (rowContextMenu && rowContextMenu.contains(event.target)) {
          return;
        }
        closeRowContextMenu(false);
      }
      if (isDiffSelectionContextMenuOpen()) {
        if (diffSelectionContextMenu && diffSelectionContextMenu.contains(event.target)) {
          return;
        }
        closeDiffSelectionContextMenu(false);
      }
    });

    refreshBtn.onclick = () => {
      if (refreshBtn.disabled) {
        return;
      }
      triggerRefreshAction("refresh");
    };
    refreshMenuButton.onclick = () => {
      if (isRefreshMenuOpen()) {
        closeRefreshMenu(true);
        return;
      }
      openRefreshMenu();
    };
    refreshMenuButton.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openRefreshMenu();
      }
    });
    refreshSplit.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (isRefreshMenuOpen() && !refreshSplit.contains(document.activeElement)) {
          closeRefreshMenu(false);
        }
      }, 0);
    });
    hardRefreshBtn.onclick = () => {
      closeRefreshMenu(false);
      triggerRefreshAction("reload-snapshots");
    };

    viewedActionsButton.onclick = () => {
      if (isViewedActionsMenuOpen()) {
        closeViewedActionsMenu(true);
        return;
      }
      openViewedActionsMenu();
    };
    viewedActionsButton.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openViewedActionsMenu();
      }
    });
    viewedActions.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (isViewedActionsMenuOpen() && !viewedActions.contains(document.activeElement)) {
          closeViewedActionsMenu(false);
        }
      }, 0);
    });
    clearViewedModeBtn.onclick = () => {
      closeViewedActionsMenu(false);
      clearViewed("mode").catch((err) => alert(String(err)));
    };
    clearViewedAllBtn.onclick = () => {
      closeViewedActionsMenu(false);
      clearViewed("all").catch((err) => alert(String(err)));
    };

    previewCurrentButton.onclick = () => {
      if (currentPreviewVariant === PREVIEW_VARIANT_CURRENT) {
        return;
      }
      reloadCurrentPreviewVariant(PREVIEW_VARIANT_CURRENT).catch((err) => {
        if (!isAbortError(err)) {
          alert(String(err));
        }
      });
    };
    previewSinceViewedButton.onclick = () => {
      if (currentPreviewVariant === PREVIEW_VARIANT_SINCE_VIEWED) {
        return;
      }
      reloadCurrentPreviewVariant(PREVIEW_VARIANT_SINCE_VIEWED).catch((err) => {
        if (!isAbortError(err)) {
          alert(String(err));
        }
      });
    };

    reviewPresetActionsButton.onclick = () => {
      if (isReviewPresetActionsMenuOpen()) {
        closeReviewPresetActionsMenu(true);
        return;
      }
      openReviewPresetActionsMenu();
    };
    reviewPresetActionsButton.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openReviewPresetActionsMenu();
      }
    });
    reviewPresetActions.addEventListener("focusout", () => {
      window.setTimeout(() => {
        if (isReviewPresetActionsMenuOpen() && !reviewPresetActions.contains(document.activeElement)) {
          closeReviewPresetActionsMenu(false);
        }
      }, 0);
    });

    createSnapshotBtn.onclick = () => openCreateSnapshotDialog().catch((err) => alert(String(err)));
    resetAllBtn.onclick = () => openResetAllDialog();
    reviewPresetSaveBtn.onclick = () => {
      closeReviewPresetActionsMenu(false);
      openSaveReviewPresetDialog();
    };
    reviewPresetRenameBtn.onclick = () => {
      closeReviewPresetActionsMenu(false);
      openRenameReviewPresetDialog();
    };
    reviewPresetDeleteBtn.onclick = () => {
      closeReviewPresetActionsMenu(false);
      openDeleteReviewPresetDialog();
    };
    reviewSelectionToggleBtn.onclick = () => {
      setReviewSelectionTrayOpen(!reviewSelectionTrayOpen, { restoreFocus: false });
    };
    createSnapshotCancelBtn.onclick = () => closeCreateSnapshotDialog();
    createSnapshotDialog.addEventListener("click", (event) => {
      if (event.target === createSnapshotDialog && !createSnapshotCancelBtn.disabled) {
        closeCreateSnapshotDialog();
      }
    });
    createSnapshotForm.addEventListener("submit", (event) => {
      event.preventDefault();
      createSnapshotFromBrowse().catch((err) => setCreateSnapshotStatus(String(err), "error"));
    });
    resetAllCancelBtn.onclick = () => closeResetAllDialog(true);
    resetAllDialog.addEventListener("click", (event) => {
      if (event.target === resetAllDialog && !resetAllCancelBtn.disabled) {
        closeResetAllDialog(true);
      }
    });
    resetAllForm.addEventListener("submit", (event) => {
      event.preventDefault();
      openResetAllConfirmDialog();
    });
    resetAllConfirmCancelBtn.onclick = () => closeResetAllConfirmDialog(true);
    resetAllConfirmDialog.addEventListener("click", (event) => {
      if (event.target === resetAllConfirmDialog && !resetAllConfirmCancelBtn.disabled) {
        closeResetAllConfirmDialog(true);
      }
    });
    resetAllConfirmSubmitBtn.onclick = () => {
      submitResetAll().catch((err) => setResetAllConfirmStatus(String(err), "error"));
    };
    renameSnapshotCancelBtn.onclick = () => closeRenameSnapshotDialog(true);
    renameSnapshotDialog.addEventListener("click", (event) => {
      if (event.target === renameSnapshotDialog && !renameSnapshotCancelBtn.disabled) {
        closeRenameSnapshotDialog(true);
      }
    });
    renameSnapshotForm.addEventListener("submit", (event) => {
      event.preventDefault();
      submitRenameSnapshot().catch((err) => setRenameSnapshotStatus(String(err), "error"));
    });
    deleteSnapshotCancelBtn.onclick = () => closeDeleteSnapshotDialog(true);
    deleteSnapshotDialog.addEventListener("click", (event) => {
      if (event.target === deleteSnapshotDialog && !deleteSnapshotCancelBtn.disabled) {
        closeDeleteSnapshotDialog(true);
      }
    });
    deleteSnapshotConfirmBtn.onclick = () => {
      confirmDeleteSnapshot().catch((err) => setDeleteSnapshotStatus(String(err), "error"));
    };
    saveReviewPresetCancelBtn.onclick = () => closeSaveReviewPresetDialog(true);
    saveReviewPresetDialog.addEventListener("click", (event) => {
      if (event.target === saveReviewPresetDialog && !saveReviewPresetCancelBtn.disabled) {
        closeSaveReviewPresetDialog(true);
      }
    });
    saveReviewPresetForm.addEventListener("submit", (event) => {
      event.preventDefault();
      saveCurrentReviewPreset().catch((err) => setSaveReviewPresetStatus(String(err), "error"));
    });
    renameReviewPresetCancelBtn.onclick = () => closeRenameReviewPresetDialog(true);
    renameReviewPresetDialog.addEventListener("click", (event) => {
      if (event.target === renameReviewPresetDialog && !renameReviewPresetCancelBtn.disabled) {
        closeRenameReviewPresetDialog(true);
      }
    });
    renameReviewPresetForm.addEventListener("submit", (event) => {
      event.preventDefault();
      renameCurrentReviewPreset().catch((err) => setRenameReviewPresetStatus(String(err), "error"));
    });
    deleteReviewPresetCancelBtn.onclick = () => closeDeleteReviewPresetDialog(true);
    deleteReviewPresetDialog.addEventListener("click", (event) => {
      if (event.target === deleteReviewPresetDialog && !deleteReviewPresetCancelBtn.disabled) {
        closeDeleteReviewPresetDialog(true);
      }
    });
    deleteReviewPresetConfirmBtn.onclick = () => {
      confirmDeleteReviewPreset().catch((err) => setDeleteReviewPresetStatus(String(err), "error"));
    };
    askPromptCancelBtn.onclick = () => closeAskPromptDialog(true);
    askPromptDialog.addEventListener("click", (event) => {
      if (event.target === askPromptDialog) {
        closeAskPromptDialog(true);
      }
    });
    askPromptForm.addEventListener("submit", (event) => {
      event.preventDefault();
      copyAskPromptForInstruction(askPromptInstruction.value, {
        copyContext: "ask-prompt-copy",
      }).catch(() => {});
    });
    diffEl.addEventListener("contextmenu", (event) => {
      const snapshot = captureDiffSelectionSnapshot();
      if (!snapshot) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      openDiffSelectionContextMenu(snapshot, diffEl, {
        clientX: event.clientX,
        clientY: event.clientY,
        restoreFocusTarget: diffEl,
      });
    });
    document.addEventListener("selectionchange", () => {
      scheduleDiffSelectionActionSync(false);
    });
    openBtn.onclick = () => triggerPrimaryAction().catch((err) => alert(String(err)));
    document.addEventListener("keydown", (event) => {
      if ((event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) && !isAskPromptDialogOpen()) {
        const snapshot = captureDiffSelectionSnapshot();
        if (snapshot) {
          event.preventDefault();
          openDiffSelectionContextMenu(snapshot, diffEl, {
            clientX: snapshot.anchorX,
            clientY: snapshot.anchorY,
            restoreFocusTarget: document.activeElement,
          });
          return;
        }
      }
      if (event.key !== "Escape") {
        return;
      }
      if (isAskPromptDialogOpen()) {
        event.preventDefault();
        closeAskPromptDialog(true);
        return;
      }
      if (isRefreshMenuOpen()) {
        event.preventDefault();
        closeRefreshMenu(true);
        return;
      }
      if (isReviewPresetActionsMenuOpen()) {
        event.preventDefault();
        closeReviewPresetActionsMenu(true);
        return;
      }
      if (isViewedActionsMenuOpen()) {
        event.preventDefault();
        closeViewedActionsMenu(true);
        return;
      }
      if (isRowContextMenuOpen()) {
        event.preventDefault();
        closeRowContextMenu(true);
        return;
      }
      if (isDiffSelectionContextMenuOpen()) {
        event.preventDefault();
        closeDiffSelectionContextMenu(true);
        return;
      }
      if (isResetAllConfirmDialogOpen() && !resetAllConfirmCancelBtn.disabled) {
        event.preventDefault();
        closeResetAllConfirmDialog(true);
        return;
      }
      if (isResetAllDialogOpen() && !resetAllCancelBtn.disabled) {
        event.preventDefault();
        closeResetAllDialog(true);
        return;
      }
      if (isDeleteSnapshotDialogOpen() && !deleteSnapshotCancelBtn.disabled) {
        event.preventDefault();
        closeDeleteSnapshotDialog(true);
        return;
      }
      if (isDeleteReviewPresetDialogOpen() && !deleteReviewPresetCancelBtn.disabled) {
        event.preventDefault();
        closeDeleteReviewPresetDialog(true);
        return;
      }
      if (isRenameSnapshotDialogOpen() && !renameSnapshotCancelBtn.disabled) {
        event.preventDefault();
        closeRenameSnapshotDialog(true);
        return;
      }
      if (isRenameReviewPresetDialogOpen() && !renameReviewPresetCancelBtn.disabled) {
        event.preventDefault();
        closeRenameReviewPresetDialog(true);
        return;
      }
      if (isSaveReviewPresetDialogOpen() && !saveReviewPresetCancelBtn.disabled) {
        event.preventDefault();
        closeSaveReviewPresetDialog(true);
        return;
      }
      if (isCreateSnapshotDialogOpen() && !createSnapshotCancelBtn.disabled) {
        event.preventDefault();
        closeCreateSnapshotDialog();
        return;
      }
      if (isSnapshotPanelOpen()) {
        event.preventDefault();
        closeSnapshotPanel(true);
        return;
      }
      if (isFiltersPanelOpen()) {
        event.preventDefault();
        closeFiltersPanel(true);
      }
    });
    document.addEventListener("click", (event) => {
      if (isRefreshMenuOpen() && !refreshSplit.contains(event.target)) {
        closeRefreshMenu(false);
      }
      if (isReviewPresetActionsMenuOpen() && !reviewPresetActions.contains(event.target)) {
        closeReviewPresetActionsMenu(false);
      }
      if (isViewedActionsMenuOpen() && !viewedActions.contains(event.target)) {
        closeViewedActionsMenu(false);
      }
      if (isRowContextMenuOpen() && !rowContextMenu.contains(event.target)) {
        closeRowContextMenu(false);
      }
      if (isDiffSelectionContextMenuOpen() && !diffSelectionContextMenu.contains(event.target)) {
        closeDiffSelectionContextMenu(false);
      }
    });
    document.addEventListener("visibilitychange", () => {
      scheduleRefreshStatePoll(true);
    });
    window.addEventListener("focus", () => {
      scheduleRefreshStatePoll(true);
    });

    try {
      applyResponsiveSplitLayout();
      setControlsFromViewState(currentViewState, null);
      syncRefreshButtonHintState();
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
  for (const command of ["open", "xdg-open"]) {
    if (!commandExists(command)) continue;
    const openProc = run(command, [url], { encoding: "utf8" });
    if (openProc.status === 0) return command;
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

function browseCategoryFlags(viewState) {
  if (
    viewState.browseIncludeStaged &&
    viewState.browseIncludeUnstaged &&
    viewState.browseIncludeUntracked &&
    viewState.browseIncludeSubmodules
  ) {
    return ["--all"];
  }
  const flags = [];
  if (viewState.browseIncludeStaged) flags.push("--staged");
  if (viewState.browseIncludeUnstaged) flags.push("--unstaged");
  if (viewState.browseIncludeUntracked) flags.push("--untracked");
  if (viewState.browseIncludeSubmodules) flags.push("--submodules");
  return flags;
}

function loadBrowseData(args, viewState, resolver) {
  const cmd = ["browse", "--porcelain"];
  if (viewState.repoFilter) cmd.push("--repo", viewState.repoFilter);
  if (viewState.browseShowAllRepos) cmd.push("--all-repos");
  cmd.push(...browseCategoryFlags(viewState));

  const parsed = parseBrowsePorcelain(runGitSnapshot(args, cmd));
  parsed.availableRepos = resolver.liveRepoList();
  parsed.viewState = viewState;
  parsed.mode = "browse";
  return assignViewTokensToPayload(args.rootRepo, resolver, viewState, parsed);
}

function recomputeBrowseTargetFields(baseTargetFields, viewState, repoRows) {
  const rows = Array.isArray(repoRows) ? repoRows : [];
  const totalStaged = rows.reduce((sum, row) => sum + (Number(row.staged_count || 0) || 0), 0);
  const totalUnstaged = rows.reduce((sum, row) => sum + (Number(row.unstaged_count || 0) || 0), 0);
  const totalUntracked = rows.reduce((sum, row) => sum + (Number(row.untracked_count || 0) || 0), 0);
  const totalSubmodules = rows.reduce((sum, row) => sum + (Number(row.submodule_count || 0) || 0), 0);
  const reposWithChanges = rows.reduce((sum, row) => {
    return sum + ((row.has_changes || "") === "true" ? 1 : 0);
  }, 0);

  return Object.assign({}, baseTargetFields || {}, {
    baseline_kind: "head",
    baseline_ref: "HEAD",
    repo_filter: String(viewState.repoFilter || ""),
    show_all_repos: boolString(viewState.browseShowAllRepos),
    include_staged: boolString(viewState.browseIncludeStaged),
    include_unstaged: boolString(viewState.browseIncludeUnstaged),
    include_untracked: boolString(viewState.browseIncludeUntracked),
    include_submodules: boolString(viewState.browseIncludeSubmodules),
    repos_in_scope: String(rows.length),
    repos_with_changes: String(reposWithChanges),
    total_staged: String(totalStaged),
    total_unstaged: String(totalUnstaged),
    total_untracked: String(totalUntracked),
    total_submodules: String(totalSubmodules),
    contract_version: String((baseTargetFields && baseTargetFields.contract_version) || "1"),
  });
}

function loadBrowseDataIncremental(args, viewState, resolver, cachedPayload, dirtyRepoRels) {
  const basePayload = Object.assign({}, cachedPayload || {});
  const baseAvailableRepos = Array.isArray(basePayload.availableRepos) ? basePayload.availableRepos.slice() : resolver.liveRepoList();
  const orderedAvailableRepos = uniqueStrings(baseAvailableRepos.concat(dirtyRepoRels || []));
  const dirtyRepoSet = new Set(Array.isArray(dirtyRepoRels) ? dirtyRepoRels : []);
  const updatedByRepo = new Map();

  for (const repoRel of dirtyRepoSet) {
    const repoViewState = Object.assign({}, viewState, {
      repoFilter: repoRel,
    });
    const repoPayload = loadBrowseData(args, repoViewState, resolver);
    updatedByRepo.set(repoRel, repoPayload);
  }

  const repoRowByRepo = new Map();
  for (const row of Array.isArray(basePayload.repoRows) ? basePayload.repoRows : []) {
    repoRowByRepo.set(String(row.repo || ""), row);
  }
  for (const [repoRel, repoPayload] of updatedByRepo.entries()) {
    const nextRow = (repoPayload.repoRows || []).find((row) => String(row.repo || "") === repoRel);
    if (nextRow) {
      repoRowByRepo.set(repoRel, nextRow);
    }
  }

  const fileRowsByRepo = new Map();
  for (const row of Array.isArray(basePayload.fileRows) ? basePayload.fileRows : []) {
    const repoRel = String(row.repo || "");
    if (!fileRowsByRepo.has(repoRel)) {
      fileRowsByRepo.set(repoRel, []);
    }
    fileRowsByRepo.get(repoRel).push(row);
  }
  for (const [repoRel, repoPayload] of updatedByRepo.entries()) {
    fileRowsByRepo.set(repoRel, Array.isArray(repoPayload.fileRows) ? repoPayload.fileRows.slice() : []);
  }

  const categoryRowsByRepo = new Map();
  for (const row of Array.isArray(basePayload.categoryRows) ? basePayload.categoryRows : []) {
    const repoRel = String(row.repo || "");
    if (!categoryRowsByRepo.has(repoRel)) {
      categoryRowsByRepo.set(repoRel, []);
    }
    categoryRowsByRepo.get(repoRel).push(row);
  }
  for (const [repoRel, repoPayload] of updatedByRepo.entries()) {
    categoryRowsByRepo.set(repoRel, Array.isArray(repoPayload.categoryRows) ? repoPayload.categoryRows.slice() : []);
  }

  const orderedRepoRows = [];
  const orderedFileRows = [];
  const orderedCategoryRows = [];
  const seenRepos = new Set();
  for (const repoRel of orderedAvailableRepos) {
    const normalizedRepoRel = String(repoRel || "");
    const repoRow = repoRowByRepo.get(normalizedRepoRel);
    if (repoRow) {
      orderedRepoRows.push(repoRow);
    }
    const repoFileRows = fileRowsByRepo.get(normalizedRepoRel) || [];
    orderedFileRows.push(...repoFileRows);
    orderedCategoryRows.push(...(categoryRowsByRepo.get(normalizedRepoRel) || []));
    seenRepos.add(normalizedRepoRel);
  }
  for (const [repoRel, repoRow] of repoRowByRepo.entries()) {
    if (seenRepos.has(repoRel)) {
      continue;
    }
    orderedRepoRows.push(repoRow);
    orderedFileRows.push(...(fileRowsByRepo.get(repoRel) || []));
    orderedCategoryRows.push(...(categoryRowsByRepo.get(repoRel) || []));
  }

  return assignViewTokensToPayload(args.rootRepo, resolver, viewState, Object.assign({}, basePayload, {
    targetFields: recomputeBrowseTargetFields(basePayload.targetFields, viewState, orderedRepoRows),
    repoRows: orderedRepoRows,
    fileRows: orderedFileRows,
    categoryRows: orderedCategoryRows,
    availableRepos: orderedAvailableRepos,
    viewState,
    mode: "browse",
  }));
}

function loadCompareDataIncremental(args, viewState, resolver, cachedPayload, dirtyRepoRels) {
  const basePayload = Object.assign({}, cachedPayload || {});
  const baseAvailableRepos = Array.isArray(basePayload.availableRepos)
    ? basePayload.availableRepos.slice()
    : resolver.repoList(viewState.snapshotId);
  const orderedAvailableRepos = uniqueStrings(baseAvailableRepos.concat(dirtyRepoRels || []));
  const dirtyRepoSet = new Set(Array.isArray(dirtyRepoRels) ? dirtyRepoRels : []);
  const updatedByRepo = new Map();

  for (const repoRel of dirtyRepoSet) {
    const repoViewState = Object.assign({}, viewState, {
      repoFilter: repoRel,
    });
    updatedByRepo.set(repoRel, loadCompareData(args, repoViewState, resolver));
  }

  const rowsByRepo = new Map();
  for (const row of Array.isArray(basePayload.rows) ? basePayload.rows : []) {
    const repoRel = String(row.repo || "");
    if (!rowsByRepo.has(repoRel)) {
      rowsByRepo.set(repoRel, []);
    }
    rowsByRepo.get(repoRel).push(row);
  }

  const repoSummaryByRepo = new Map();
  for (const repoRow of compareRepoSummaryRows(basePayload)) {
    repoSummaryByRepo.set(String(repoRow.repo || ""), repoRow);
  }

  for (const [repoRel, repoPayload] of updatedByRepo.entries()) {
    rowsByRepo.set(repoRel, Array.isArray(repoPayload.rows) ? repoPayload.rows.slice() : []);
    const nextRepoSummary = compareRepoSummaryRows(repoPayload).find((row) => String(row.repo || "") === repoRel) || null;
    if (nextRepoSummary) {
      repoSummaryByRepo.set(repoRel, nextRepoSummary);
    } else {
      repoSummaryByRepo.delete(repoRel);
    }
  }

  const orderedRows = [];
  const orderedRepoRows = [];
  const seenRepos = new Set();
  for (const repoRel of orderedAvailableRepos) {
    const normalizedRepoRel = String(repoRel || "");
    if (repoSummaryByRepo.has(normalizedRepoRel)) {
      orderedRepoRows.push(repoSummaryByRepo.get(normalizedRepoRel));
    }
    orderedRows.push(...(rowsByRepo.get(normalizedRepoRel) || []));
    seenRepos.add(normalizedRepoRel);
  }
  for (const [repoRel, repoRows] of rowsByRepo.entries()) {
    if (seenRepos.has(repoRel)) {
      continue;
    }
    if (repoSummaryByRepo.has(repoRel)) {
      orderedRepoRows.push(repoSummaryByRepo.get(repoRel));
    }
    orderedRows.push(...repoRows);
    seenRepos.add(repoRel);
  }
  for (const [repoRel, repoRow] of repoSummaryByRepo.entries()) {
    if (seenRepos.has(repoRel)) {
      continue;
    }
    orderedRepoRows.push(repoRow);
  }

  return assignViewTokensToPayload(args.rootRepo, resolver, viewState, Object.assign({}, basePayload, {
    targetFields: Object.assign({}, basePayload.targetFields || {}, {
      include_no_effect: boolString(viewState.compareIncludeNoEffect),
      compare_base: normalizeCompareBase(viewState.compareBase),
    }),
    rows: orderedRows,
    repoRows: orderedRepoRows,
    summaryFields: recomputeCompareSummaryFromRepoRows(
      basePayload.summaryFields,
      viewState,
      orderedRepoRows,
      orderedAvailableRepos
    ),
    availableRepos: orderedAvailableRepos,
    viewState,
    mode: "compare",
  }));
}

function loadCompareData(args, viewState, resolver) {
  if (FORCE_COMPARE_DATA_FAILURE) {
    throw new SnapshotGuiError("Forced compare data load failure for test.");
  }

  const cmd = ["compare", viewState.snapshotId, "--porcelain"];
  if (viewState.repoFilter) cmd.push("--repo", viewState.repoFilter);
  if (viewState.compareIncludeNoEffect) cmd.push("--include-no-effect");
  cmd.push("--base", normalizeCompareBase(viewState.compareBase));

  const parsed = parseComparePorcelain(runGitSnapshot(args, cmd));
  parsed.availableRepos = resolver.repoList(viewState.snapshotId);
  parsed.viewState = viewState;
  parsed.mode = "compare";
  return assignViewTokensToPayload(args.rootRepo, resolver, viewState, parsed);
}

function loadReviewData(args, viewState, resolver) {
  const selectedRepos = uniqueStrings(Array.isArray(viewState.reviewSelectedRepos) ? viewState.reviewSelectedRepos : []);
  const reviewBaseRef = normalizeReviewBaseRef(viewState.reviewBaseRef, "master");
  const reviewRepoBaseOverrides = normalizeReviewRepoBaseOverrides(viewState.reviewRepoBaseOverrides, {});
  const reviewPresets = loadReviewPresets(args.rootRepo);
  const reviewRefRows = [];
  const seenReviewRefRepos = new Set();
  for (const repoRel of uniqueStrings(["."].concat(selectedRepos))) {
    if (seenReviewRefRepos.has(repoRel)) {
      continue;
    }
    seenReviewRefRepos.add(repoRel);
    reviewRefRows.push(...reviewRefRowsForRepo(args.rootRepo, repoRel));
  }
  if (!selectedRepos.length) {
    return {
      targetFields: {
        default_base_ref: reviewBaseRef,
        selected_repos: "0",
        repos_resolved: "0",
        repos_failed: "0",
        repos_fallback_to_master: "0",
        contract_version: "1",
      },
      summaryFields: {
        default_base_ref: reviewBaseRef,
        repos_checked: "0",
        repos_with_delta: "0",
        repos_fallback_to_master: "0",
        shown_files: "0",
        shown_lines_added: "0",
        shown_lines_removed: "0",
        contract_version: "1",
      },
      repoRows: [],
      refRows: reviewRefRows,
      rows: [],
      reviewPresets,
      availableRepos: resolver.liveRepoList(),
      viewState,
      mode: "review",
    };
  }

  const cmd = ["review", "--porcelain"];
  if (reviewBaseRef) {
    cmd.push("--base", reviewBaseRef);
  }
  for (const repo of selectedRepos) {
    cmd.push("--repo", repo);
  }
  for (const repo of selectedRepos) {
    const overrideRef = String(reviewRepoBaseOverrides[repo] || "").trim();
    if (!overrideRef || overrideRef === reviewBaseRef) {
      continue;
    }
    cmd.push("--repo-base", repo, overrideRef);
  }

  const parsed = parseReviewPorcelain(runGitSnapshot(args, cmd));
  parsed.availableRepos = resolver.liveRepoList();
  parsed.reviewPresets = reviewPresets;
  parsed.viewState = viewState;
  parsed.mode = "review";
  return assignViewTokensToPayload(args.rootRepo, resolver, viewState, parsed);
}

async function loadReviewDataAsync(args, viewState, resolver, options) {
  const selectedRepos = uniqueStrings(Array.isArray(viewState.reviewSelectedRepos) ? viewState.reviewSelectedRepos : []);
  const reviewBaseRef = normalizeReviewBaseRef(viewState.reviewBaseRef, "master");
  const reviewRepoBaseOverrides = normalizeReviewRepoBaseOverrides(viewState.reviewRepoBaseOverrides, {});
  const reviewPresets = loadReviewPresets(args.rootRepo);
  const reviewRefRows = [];
  const seenReviewRefRepos = new Set();
  for (const repoRel of uniqueStrings(["."].concat(selectedRepos))) {
    if (seenReviewRefRepos.has(repoRel)) {
      continue;
    }
    seenReviewRefRepos.add(repoRel);
    reviewRefRows.push(...reviewRefRowsForRepo(args.rootRepo, repoRel));
  }
  if (!selectedRepos.length) {
    return {
      targetFields: {
        default_base_ref: reviewBaseRef,
        selected_repos: "0",
        repos_resolved: "0",
        repos_failed: "0",
        repos_fallback_to_master: "0",
        contract_version: "1",
      },
      summaryFields: {
        default_base_ref: reviewBaseRef,
        repos_checked: "0",
        repos_with_delta: "0",
        repos_fallback_to_master: "0",
        shown_files: "0",
        shown_lines_added: "0",
        shown_lines_removed: "0",
        contract_version: "1",
      },
      repoRows: [],
      refRows: reviewRefRows,
      rows: [],
      reviewPresets,
      availableRepos: resolver.liveRepoList(),
      viewState,
      mode: "review",
    };
  }

  const cmd = ["review", "--porcelain"];
  if (reviewBaseRef) {
    cmd.push("--base", reviewBaseRef);
  }
  for (const repo of selectedRepos) {
    cmd.push("--repo", repo);
  }
  for (const repo of selectedRepos) {
    const overrideRef = String(reviewRepoBaseOverrides[repo] || "").trim();
    if (!overrideRef || overrideRef === reviewBaseRef) {
      continue;
    }
    cmd.push("--repo-base", repo, overrideRef);
  }

  const parsed = parseReviewPorcelain(await runGitSnapshotAsync(args, cmd, options));
  parsed.availableRepos = resolver.liveRepoList();
  parsed.reviewPresets = reviewPresets;
  parsed.viewState = viewState;
  parsed.mode = "review";
  return assignViewTokensToPayload(args.rootRepo, resolver, viewState, parsed);
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
  return assignViewTokensToPayload(args.rootRepo, resolver, viewState, parsed);
}

function loadSnapshotOptions(args, selectedSnapshotId, includeAuto) {
  const normalizeSnapshotList = (entries) => {
    return sortSnapshotsNewestFirst(
      (Array.isArray(entries) ? entries : []).map((snapshot) => decorateSnapshotRecord(args.rootRepo, snapshot))
    );
  };

  const userSnapshots = normalizeSnapshotList(parseListPorcelain(runGitSnapshot(args, ["list", "--porcelain"])));
  if (includeAuto !== true && userSnapshots.some((snapshot) => snapshot.id === selectedSnapshotId)) {
    return userSnapshots;
  }
  const allSnapshots = normalizeSnapshotList(parseListPorcelain(runGitSnapshot(args, ["list", "--include-auto", "--porcelain"])));
  if (includeAuto === true) {
    return allSnapshots;
  }
  const selectedSnapshot = allSnapshots.find((snapshot) => snapshot.id === selectedSnapshotId);
  if (!selectedSnapshot) {
    return userSnapshots;
  }
  if (selectedSnapshot.origin === "auto") {
    return allSnapshots;
  }
  return sortSnapshotsNewestFirst(userSnapshots.concat([selectedSnapshot]));
}

function testDataDelayMs(mode) {
  if (mode === "browse") return TEST_BROWSE_DATA_DELAY_MS;
  if (mode === "compare") return TEST_COMPARE_DATA_DELAY_MS;
  if (mode === "review") return TEST_REVIEW_DATA_DELAY_MS;
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
    reviewSelectedRepos: decodeReviewReposFromUrl(url.searchParams),
    reviewBaseRef: getParam("review_base", args.initialViewState.reviewBaseRef),
    reviewRepoBaseOverrides: decodeReviewRepoBasesFromUrl(url.searchParams),
    compareIncludeNoEffect: url.searchParams.has("compare_include_no_effect")
      ? url.searchParams.get("compare_include_no_effect")
      : getParam("compare_show_all", args.initialViewState.compareIncludeNoEffect || args.initialViewState.compareShowAll),
    compareBase: getParam("compare_base", args.initialViewState.compareBase),
    inspectIncludeStaged: getParam("inspect_include_staged", args.initialViewState.inspectIncludeStaged),
    inspectIncludeUnstaged: getParam("inspect_include_unstaged", args.initialViewState.inspectIncludeUnstaged),
    inspectIncludeUntracked: getParam("inspect_include_untracked", args.initialViewState.inspectIncludeUntracked),
    inspectShowAllRepos: getParam("inspect_show_all_repos", args.initialViewState.inspectShowAllRepos),
    browseIncludeStaged: getParam("browse_include_staged", args.initialViewState.browseIncludeStaged),
    browseIncludeUnstaged: getParam("browse_include_unstaged", args.initialViewState.browseIncludeUnstaged),
    browseIncludeUntracked: getParam("browse_include_untracked", args.initialViewState.browseIncludeUntracked),
    browseIncludeSubmodules: getParam("browse_include_submodules", args.initialViewState.browseIncludeSubmodules),
    browseShowAllRepos: getParam("browse_show_all_repos", args.initialViewState.browseShowAllRepos),
    selectedKind: getParam("selected_kind", args.initialViewState.selectedKind),
    selectedRepo: getParam("selected_repo", args.initialViewState.selectedRepo),
    selectedCategory: getParam("selected_category", args.initialViewState.selectedCategory),
    selectedFile: getParam("selected_file", args.initialViewState.selectedFile),
  }, args);
}

function runTestMode(args, resolver) {
  const viewState = args.initialViewState;
  const data = viewState.mode === "browse"
    ? loadBrowseData(args, viewState, resolver)
    : (viewState.mode === "compare"
      ? loadCompareData(args, viewState, resolver)
      : (viewState.mode === "review"
        ? loadReviewData(args, viewState, resolver)
        : loadInspectData(args, viewState, resolver)));

  const previewRow = (viewState.mode === "compare" || viewState.mode === "review")
    ? (data.rows || [])[0]
    : (data.fileRows || [])[0];

  if (previewRow) {
    try {
      if (viewState.mode === "browse") {
        // Trigger parity checks for the live preview paths without failing test mode.
      } else if (viewState.mode === "compare") {
        const pair = resolver.compareFilePair(viewState.snapshotId, previewRow.repo || "", previewRow.file || "");
        const orientation = compareOrientationSpec(viewState.compareBase, previewRow.file || "");
        buildUnifiedDiff(
          compareFileForRole(orientation.oldFileRole, pair.snapshotFile, pair.currentFile),
          compareFileForRole(orientation.newFileRole, pair.snapshotFile, pair.currentFile),
          previewRow.file || "",
          {
            oldLabel: orientation.oldLabel,
            newLabel: orientation.newLabel,
          }
        );
      } else if (viewState.mode === "review") {
        const repoRow = Array.isArray(data.repoRows)
          ? data.repoRows.find((row) => String(row.repo || "") === String(previewRow.repo || ""))
          : null;
        const mergeBase = String(repoRow && repoRow.merge_base ? repoRow.merge_base : "");
        const baseFile = mergeBase
          ? resolver.materializeRevisionFile(previewRow.repo || "", previewRow.file || "", mergeBase, "review-base")
          : resolver.materializeEmptyFile("review-base", previewRow.repo || "", previewRow.file || "");
        const headFile = resolver.materializeRevisionFile(previewRow.repo || "", previewRow.file || "", "HEAD", "review-head");
        buildUnifiedDiff(baseFile, headFile, previewRow.file || "", {
          oldLabel: `merge-base:${sanitizePreviewDiffLabelPath(previewRow.file || "")}`,
          newLabel: `head:${sanitizePreviewDiffLabelPath(previewRow.file || "")}`,
        });
      } else if ((previewRow.category || "") === "untracked") {
        resolver.inspectUntrackedPreview(viewState.snapshotId, previewRow.repo || "", previewRow.file || "");
      } else {
        resolver.inspectPatchPreview(viewState.snapshotId, previewRow.repo || "", previewRow.category || "", previewRow.file || "");
      }
    } catch (_err) {
      // Ignore in test mode; parity with prior behavior.
    }
  }

  const rowsLength = (viewState.mode === "compare" || viewState.mode === "review") ? (data.rows || []).length : (data.fileRows || []).length;
  console.log(
    "GUI_TEST" +
      ` mode=${viewState.mode}` +
      ` snapshot_id=${viewState.snapshotId}` +
      ` rows=${rowsLength}` +
      ` review_selected_repos=${uniqueStrings(Array.isArray(viewState.reviewSelectedRepos) ? viewState.reviewSelectedRepos : []).join(",") || "(none)"}` +
      ` review_base=${normalizeReviewBaseRef(viewState.reviewBaseRef, "master")}` +
      ` review_repo_bases=${encodeReviewRepoBasesForUrl(viewState.reviewRepoBaseOverrides, viewState.reviewSelectedRepos, viewState.reviewBaseRef) || "(none)"}` +
      ` include_no_effect=${boolString(viewState.compareIncludeNoEffect)}` +
      ` payload_include_no_effect=${boolString(normalizeBool(data && data.targetFields && data.targetFields.include_no_effect, false))}` +
      ` compare_base=${normalizeCompareBase(viewState.compareBase)}` +
      ` inspect_staged=${boolString(viewState.inspectIncludeStaged)}` +
      ` inspect_unstaged=${boolString(viewState.inspectIncludeUnstaged)}` +
      ` inspect_untracked=${boolString(viewState.inspectIncludeUntracked)}` +
      ` inspect_all_repos=${boolString(viewState.inspectShowAllRepos)}` +
      ` browse_staged=${boolString(viewState.browseIncludeStaged)}` +
      ` browse_unstaged=${boolString(viewState.browseIncludeUnstaged)}` +
      ` browse_untracked=${boolString(viewState.browseIncludeUntracked)}` +
      ` browse_submodules=${boolString(viewState.browseIncludeSubmodules)}` +
      ` browse_all_repos=${boolString(viewState.browseShowAllRepos)}` +
      ` repo_filter=${viewState.repoFilter || "(all)"}`
  );
  return 0;
}

function readJsonRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      if (!chunks.length) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (err) {
        reject(new SnapshotGuiError("Invalid JSON request body."));
      }
    });
    req.on("error", reject);
  });
}

  function createRequestAbortController(req, res) {
    const controller = new AbortController();
    const abort = () => {
      if (!controller.signal.aborted) {
        controller.abort();
    }
  };
  req.on("aborted", abort);
  req.on("close", abort);
  res.on("close", abort);
  return {
    signal: controller.signal,
    cleanup() {
      req.off("aborted", abort);
      req.off("close", abort);
      res.off("close", abort);
    },
  };
}

function startServer(args, resolver) {
  const sockets = new Set();
  const state = {
    dataCache: new Map(),
    previewCache: new Map(),
    snapshotsCache: null,
    serverInstanceId: crypto.randomBytes(10).toString("hex"),
    nextViewDataToken: 1,
    visibleRepoChangeQueue: new Set(),
    visibleRepoChangeTimer: null,
    refreshStateVerificationAt: new Map(),
  };

  function nextPreparedViewToken() {
    const token = `${state.serverInstanceId}:${state.nextViewDataToken}`;
    state.nextViewDataToken += 1;
    return token;
  }

  function clearLivePreviewCaches() {
    state.previewCache.clear();
    resolver.clearCompareRepoPairCache();
  }

  function invalidateLiveDataCaches() {
    if (state.visibleRepoChangeTimer) {
      clearTimeout(state.visibleRepoChangeTimer);
      state.visibleRepoChangeTimer = null;
    }
    state.visibleRepoChangeQueue.clear();
    state.refreshStateVerificationAt.clear();
    state.dataCache.clear();
    clearLivePreviewCaches();
    resolver.clearLiveRepoListCache();
  }

  function dataRowCount(viewState, payload) {
    if (!payload) {
      return 0;
    }
    return (viewState.mode === "compare" || viewState.mode === "review")
      ? ((payload.rows || []).length)
      : ((payload.fileRows || []).length);
  }

  function touchLiveRefreshTracker(viewState) {
    const watchRepoRels = resolver.liveRepoList();
    const trackedRepoRels = uniqueStrings(
      liveRefreshAppliesToView(viewState)
        ? repoRelsForLiveViewVerification(viewState)
        : watchRepoRels
    );
    liveRefreshTracker.refreshRepoTokens(trackedRepoRels);
    liveRefreshTracker.ensureRepoTokens(watchRepoRels);
    liveRefreshTracker.scheduleWatchRootRefresh(watchRepoRels);
  }

  function loadPreparedViewPayload(viewState) {
    const payload = viewState.mode === "browse"
      ? loadBrowseData(args, viewState, resolver)
      : (viewState.mode === "compare"
        ? loadCompareData(args, viewState, resolver)
        : (viewState.mode === "review"
          ? loadReviewData(args, viewState, resolver)
          : loadInspectData(args, viewState, resolver)));
    if (liveRefreshAppliesToView(viewState)) {
      touchLiveRefreshTracker(viewState);
    }
    return payload;
  }

  async function loadPreparedViewPayloadAsync(viewState, options) {
    const payload = viewState.mode === "review"
      ? await loadReviewDataAsync(args, viewState, resolver, options)
      : loadPreparedViewPayload(viewState);
    if (liveRefreshAppliesToView(viewState)) {
      touchLiveRefreshTracker(viewState);
    }
    return payload;
  }

  function updateCacheEntry(entry, payload, viewState) {
    const cacheEntry = entry || {
      pendingRepoRels: new Set(),
      pendingFullRebuild: false,
      prepareRunning: false,
      preparePromise: null,
      refreshNeeded: false,
      viewPrepareState: "current",
    };
    cacheEntry.payload = payload;
    cacheEntry.viewState = Object.assign({}, viewState);
    cacheEntry.loadedAt = Date.now();
    cacheEntry.viewDataToken = nextPreparedViewToken();
    cacheEntry.pendingRepoRels = new Set();
    cacheEntry.pendingFullRebuild = false;
    cacheEntry.refreshNeeded = false;
    cacheEntry.viewPrepareState = "current";
    if (liveRefreshAppliesToView(viewState)) {
      touchLiveRefreshTracker(viewState);
    }
    return cacheEntry;
  }

  function cacheEntryForView(viewState) {
    return state.dataCache.get(dataViewStateKey(viewState)) || null;
  }

  function buildViewDataResponsePayload(cacheEntry, viewState) {
    const payload = cloneViewPayloadForClient(cacheEntry.payload || {});
    payload.targetFields = Object.assign({}, payload.targetFields || {});
    if (viewState.mode === "compare") {
      payload.targetFields.compare_base = normalizeCompareBase(viewState.compareBase);
    } else if (viewState.mode === "review") {
      payload.reviewPresets = loadReviewPresets(args.rootRepo);
    }
    annotateViewedStateForPayload(args.rootRepo, args.rootRepoPhysical, viewState, payload);
    payload.viewState = viewState;
    payload.cacheLoadedAt = cacheEntry.loadedAt;
    payload.server_instance_id = state.serverInstanceId;
    payload.view_data_token = cacheEntry.viewDataToken;
    payload.view_prepare_state = cacheEntry.viewPrepareState === "preparing" ? "preparing" : "current";
    return payload;
  }

  function repoRelsForLiveViewVerification(viewState) {
    if (!liveRefreshAppliesToView(viewState)) {
      return [];
    }
    if (viewState && viewState.repoFilter) {
      return [String(viewState.repoFilter || ".")];
    }
    return resolver.liveRepoList();
  }

  function scheduleRefreshStateVerification(viewState) {
    if (!liveRefreshAppliesToView(viewState)) {
      return;
    }
    const key = dataViewStateKey(viewState);
    const now = Date.now();
    const lastAt = Number(state.refreshStateVerificationAt.get(key) || 0);
    if (lastAt > 0 && (now - lastAt) < LIVE_REFRESH_FALLBACK_POLL_MS) {
      return;
    }
    state.refreshStateVerificationAt.set(key, now);
    const repoRels = uniqueStrings(repoRelsForLiveViewVerification(viewState));
    if (!repoRels.length) {
      return;
    }
    liveRefreshTracker.ensureRepoTokens(repoRels);
    for (const repoRel of repoRels) {
      liveRefreshTracker.scheduleRepoProbe(repoRel, {
        immediate: true,
        verification: true,
      });
    }
  }

  function verifyViewStateNow(viewState) {
    if (!liveRefreshAppliesToView(viewState)) {
      return false;
    }
    const key = dataViewStateKey(viewState);
    const cacheEntry = state.dataCache.get(key);
    if (!cacheEntry) {
      return false;
    }
    const repoRels = uniqueStrings(repoRelsForLiveViewVerification(viewState));
    if (!repoRels.length) {
      return false;
    }
    liveRefreshTracker.primeRepoTokens(repoRels);
    const changedRepoRels = [];
    for (const repoRel of repoRels) {
      if (liveRefreshTracker.verifyRepoNow(repoRel)) {
        changedRepoRels.push(repoRel);
      }
    }
    if (!changedRepoRels.length) {
      return false;
    }
    queuePreparedViewRefresh(key, changedRepoRels, {
      forceFull: changedRepoRels.length > LIVE_REFRESH_MAX_INCREMENTAL_REPOS,
    });
    return true;
  }

  function viewStatusForClient(viewState, clientToken, clientServerInstanceId, options) {
    const statusOptions = options && typeof options === "object" ? options : {};
    const normalizedClientToken = String(clientToken || "");
    const normalizedClientServerInstanceId = String(clientServerInstanceId || "");
    if (!liveRefreshAppliesToView(viewState)) {
      return {
        view_status: "current",
        refresh_needed: false,
        server_instance_id: state.serverInstanceId,
        view_data_token: "",
        view_prepare_state: "current",
      };
    }

    let cacheEntry = cacheEntryForView(viewState);
    if (
      statusOptions.forceVerify === true
      && cacheEntry
      && !cacheEntry.refreshNeeded
      && cacheEntry.viewPrepareState !== "preparing"
    ) {
      verifyViewStateNow(viewState);
      cacheEntry = cacheEntryForView(viewState);
    }
    if (cacheEntry && cacheEntry.refreshNeeded) {
      return {
        view_status: "stale",
        refresh_needed: true,
        hint: LIVE_REFRESH_HINT_TEXT,
        server_instance_id: state.serverInstanceId,
        view_data_token: cacheEntry.viewDataToken,
        view_prepare_state: cacheEntry.viewPrepareState === "preparing" ? "preparing" : "current",
      };
    }
    if (cacheEntry && cacheEntry.viewPrepareState === "preparing") {
      return {
        view_status: "preparing",
        refresh_needed: false,
        server_instance_id: state.serverInstanceId,
        view_data_token: cacheEntry.viewDataToken,
        view_prepare_state: "preparing",
      };
    }

    const serverRestarted = Boolean(
      normalizedClientServerInstanceId
      && normalizedClientServerInstanceId !== state.serverInstanceId
    );
    const tokenMismatch = Boolean(
      normalizedClientToken
      && cacheEntry
      && normalizedClientToken !== cacheEntry.viewDataToken
    );
    const missingPreparedEntry = Boolean(normalizedClientToken && !cacheEntry);
    const isStale = serverRestarted || tokenMismatch || missingPreparedEntry;
    if (!isStale) {
      scheduleRefreshStateVerification(viewState);
    }

    return {
      view_status: isStale ? "stale" : "current",
      refresh_needed: isStale,
      hint: isStale ? LIVE_REFRESH_HINT_TEXT : "",
      server_instance_id: state.serverInstanceId,
      view_data_token: cacheEntry ? cacheEntry.viewDataToken : "",
      view_prepare_state: cacheEntry && cacheEntry.viewPrepareState === "preparing" ? "preparing" : "current",
    };
  }

  function viewCacheMatchesRepo(viewState, repoRel) {
    if (!liveRefreshAppliesToView(viewState)) {
      return false;
    }
    if (!viewState.repoFilter) {
      return true;
    }
    return String(viewState.repoFilter || "") === String(repoRel || ".");
  }

  async function runPreparedViewRefresh(key) {
    const cacheEntry = state.dataCache.get(key);
    if (!cacheEntry || cacheEntry.prepareRunning) {
      return;
    }
    cacheEntry.prepareRunning = true;
    try {
      while (true) {
        const activeEntry = state.dataCache.get(key);
        if (!activeEntry) {
          return;
        }
        const pendingRepoRels = uniqueStrings(Array.from(activeEntry.pendingRepoRels || []));
        const shouldForceFullRebuild = Boolean(activeEntry.pendingFullRebuild)
          || pendingRepoRels.length > LIVE_REFRESH_MAX_INCREMENTAL_REPOS;
        activeEntry.pendingRepoRels = new Set();
        activeEntry.pendingFullRebuild = false;

        if (!pendingRepoRels.length && !shouldForceFullRebuild) {
          activeEntry.viewPrepareState = "current";
          return;
        }

        let nextPayload = null;
        const startedAt = Date.now();
        try {
          const prepareDelayMs = testDataDelayMs(activeEntry.viewState.mode);
          if (prepareDelayMs > 0) {
            await delay(prepareDelayMs);
          }
          if (!shouldForceFullRebuild && activeEntry.payload) {
            if (activeEntry.viewState.mode === "browse") {
              nextPayload = loadBrowseDataIncremental(
                args,
                activeEntry.viewState,
                resolver,
                activeEntry.payload,
                pendingRepoRels
              );
            } else if (activeEntry.viewState.mode === "compare") {
              nextPayload = loadCompareDataIncremental(
                args,
                activeEntry.viewState,
                resolver,
                activeEntry.payload,
                pendingRepoRels
              );
            }
          }
        } catch (err) {
          const message = err && err.message ? err.message : String(err);
          console.warn(`[live-refresh] incremental prepare failed for ${activeEntry.viewState.mode}; falling back to full rebuild: ${message}`);
          nextPayload = null;
        }

        if (!nextPayload) {
          if (activeEntry.viewState.mode === "browse") {
            resolver.clearLiveRepoListCache();
          }
          nextPayload = loadPreparedViewPayload(activeEntry.viewState);
        }

        clearLivePreviewCaches();
        updateCacheEntry(activeEntry, nextPayload, activeEntry.viewState);
        console.log(
          `[live-refresh] prepared ${activeEntry.viewState.mode} view in ${activeEntry.loadedAt - startedAt}ms ` +
          `(rows=${dataRowCount(activeEntry.viewState, nextPayload)}).`
        );

        if (!activeEntry.pendingRepoRels.size && !activeEntry.pendingFullRebuild) {
          activeEntry.viewPrepareState = "current";
          return;
        }
        activeEntry.viewPrepareState = "preparing";
      }
    } finally {
      const activeEntry = state.dataCache.get(key);
      if (activeEntry) {
        activeEntry.prepareRunning = false;
        activeEntry.preparePromise = null;
        if (activeEntry.pendingRepoRels.size || activeEntry.pendingFullRebuild) {
          activeEntry.viewPrepareState = "preparing";
          queuePreparedViewRefresh(key, Array.from(activeEntry.pendingRepoRels), {
            forceFull: activeEntry.pendingFullRebuild,
          });
        }
      }
    }
  }

  function queuePreparedViewRefresh(key, repoRels, options) {
    const cacheEntry = state.dataCache.get(key);
    if (!cacheEntry || !liveRefreshAppliesToView(cacheEntry.viewState)) {
      return;
    }
    const normalizedRepoRels = uniqueStrings(Array.isArray(repoRels) ? repoRels : []);
    if (!cacheEntry.pendingRepoRels) {
      cacheEntry.pendingRepoRels = new Set();
    }
    for (const repoRel of normalizedRepoRels) {
      cacheEntry.pendingRepoRels.add(repoRel);
    }
    if (Boolean(options && options.forceFull) || cacheEntry.pendingRepoRels.size > LIVE_REFRESH_MAX_INCREMENTAL_REPOS) {
      cacheEntry.pendingFullRebuild = true;
    }
    cacheEntry.refreshNeeded = true;
    cacheEntry.viewPrepareState = "preparing";
    if (!cacheEntry.preparePromise) {
      cacheEntry.preparePromise = Promise.resolve()
        .then(() => runPreparedViewRefresh(key))
        .catch((err) => {
          const message = err && err.message ? err.message : String(err);
          console.warn(`[live-refresh] prepare failed for ${cacheEntry.viewState.mode}: ${message}`);
          const activeEntry = state.dataCache.get(key);
          if (activeEntry) {
            activeEntry.prepareRunning = false;
            activeEntry.preparePromise = null;
            activeEntry.viewPrepareState = "current";
          }
        });
    }
  }

  function flushVisibleRepoChangeQueue() {
    if (state.visibleRepoChangeTimer) {
      clearTimeout(state.visibleRepoChangeTimer);
      state.visibleRepoChangeTimer = null;
    }
    const changedRepoRels = uniqueStrings(Array.from(state.visibleRepoChangeQueue));
    state.visibleRepoChangeQueue.clear();
    if (!changedRepoRels.length) {
      return;
    }

    for (const [key, cacheEntry] of state.dataCache.entries()) {
      if (!liveRefreshAppliesToView(cacheEntry.viewState)) {
        continue;
      }
      const affectedRepoRels = changedRepoRels.filter((repoRel) => {
        return viewCacheMatchesRepo(cacheEntry.viewState, repoRel);
      });
      if (!affectedRepoRels.length) {
        continue;
      }
      queuePreparedViewRefresh(key, affectedRepoRels, {
        forceFull: affectedRepoRels.length > LIVE_REFRESH_MAX_INCREMENTAL_REPOS,
      });
    }
  }

  function queueVisibleRepoChanges(repoRels) {
    for (const repoRel of uniqueStrings(Array.isArray(repoRels) ? repoRels : [])) {
      state.visibleRepoChangeQueue.add(repoRel || ".");
    }
    if (state.visibleRepoChangeTimer) {
      return;
    }
    state.visibleRepoChangeTimer = setTimeout(() => {
      state.visibleRepoChangeTimer = null;
      flushVisibleRepoChangeQueue();
    }, 0);
    timerUnref(state.visibleRepoChangeTimer);
  }

  const liveRefreshTracker = new LiveRefreshTracker(args.rootRepo, resolver, queueVisibleRepoChanges);
  liveRefreshTracker.start();

  function getViewData(viewState, forceRefresh) {
    const key = dataViewStateKey(viewState);
    let cacheEntry = state.dataCache.get(key) || null;
    if (forceRefresh) {
      clearLivePreviewCaches();
      if (viewState.mode === "browse") {
        resolver.clearLiveRepoListCache();
      }
      const startedAt = Date.now();
      const payload = loadPreparedViewPayload(viewState);
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      if (viewState.mode === "browse" || viewState.mode === "inspect") {
        logRowStatsTelemetry(viewState.mode, {
          elapsed_ms: elapsedMs,
          rows: dataRowCount(viewState, payload),
          untracked: Number(payload && payload.targetFields ? payload.targetFields.total_untracked || 0 : 0) || 0,
        });
      }
      cacheEntry = updateCacheEntry(cacheEntry, payload, viewState);
      state.dataCache.set(key, cacheEntry);
      console.log(`${viewState.mode} data loaded in ${elapsedMs}ms (rows=${dataRowCount(viewState, payload)}).`);
      return Object.assign({ fromCache: false }, cacheEntry);
    }

    if (!cacheEntry) {
      const startedAt = Date.now();
      const payload = loadPreparedViewPayload(viewState);
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      if (viewState.mode === "browse" || viewState.mode === "inspect") {
        logRowStatsTelemetry(viewState.mode, {
          elapsed_ms: elapsedMs,
          rows: dataRowCount(viewState, payload),
          untracked: Number(payload && payload.targetFields ? payload.targetFields.total_untracked || 0 : 0) || 0,
        });
      }
      cacheEntry = updateCacheEntry(cacheEntry, payload, viewState);
      state.dataCache.set(key, cacheEntry);
      console.log(`${viewState.mode} data loaded in ${elapsedMs}ms (rows=${dataRowCount(viewState, payload)}).`);
      return Object.assign({ fromCache: false }, cacheEntry);
    }

    cacheEntry.viewState = Object.assign({}, viewState);
    return Object.assign({ fromCache: true }, cacheEntry);
  }

  async function getViewDataAsync(viewState, forceRefresh, options) {
    if (viewState.mode !== "review") {
      return getViewData(viewState, forceRefresh);
    }
    const key = dataViewStateKey(viewState);
    let cacheEntry = state.dataCache.get(key) || null;
    if (forceRefresh) {
      clearLivePreviewCaches();
      const startedAt = Date.now();
      const payload = await loadPreparedViewPayloadAsync(viewState, options);
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      if (viewState.mode === "browse" || viewState.mode === "inspect") {
        logRowStatsTelemetry(viewState.mode, {
          elapsed_ms: elapsedMs,
          rows: dataRowCount(viewState, payload),
          untracked: Number(payload && payload.targetFields ? payload.targetFields.total_untracked || 0 : 0) || 0,
        });
      }
      cacheEntry = updateCacheEntry(cacheEntry, payload, viewState);
      state.dataCache.set(key, cacheEntry);
      console.log(`${viewState.mode} data loaded in ${elapsedMs}ms (rows=${dataRowCount(viewState, payload)}).`);
      return Object.assign({ fromCache: false }, cacheEntry);
    }

    if (!cacheEntry) {
      const startedAt = Date.now();
      const payload = await loadPreparedViewPayloadAsync(viewState, options);
      const elapsedMs = Math.max(0, Date.now() - startedAt);
      if (viewState.mode === "browse" || viewState.mode === "inspect") {
        logRowStatsTelemetry(viewState.mode, {
          elapsed_ms: elapsedMs,
          rows: dataRowCount(viewState, payload),
          untracked: Number(payload && payload.targetFields ? payload.targetFields.total_untracked || 0 : 0) || 0,
        });
      }
      cacheEntry = updateCacheEntry(cacheEntry, payload, viewState);
      state.dataCache.set(key, cacheEntry);
      console.log(`${viewState.mode} data loaded in ${elapsedMs}ms (rows=${dataRowCount(viewState, payload)}).`);
      return Object.assign({ fromCache: false }, cacheEntry);
    }

    cacheEntry.viewState = Object.assign({}, viewState);
    return Object.assign({ fromCache: true }, cacheEntry);
  }

  function getSnapshots(forceRefresh, selectedSnapshotId, includeAuto) {
    if (
      forceRefresh
      || !state.snapshotsCache
      || state.snapshotsCache.selectedSnapshotId !== selectedSnapshotId
      || state.snapshotsCache.includeAuto !== includeAuto
    ) {
      state.snapshotsCache = {
        selectedSnapshotId,
        includeAuto,
        snapshots: loadSnapshotOptions(args, selectedSnapshotId, includeAuto),
        loadedAt: Date.now(),
      };
    }
    return state.snapshotsCache;
  }

  function invalidateGuiCaches() {
    invalidateLiveDataCaches();
    state.snapshotsCache = null;
  }

  function viewedEntryKeyForSelection(mode, repoRel, category, filePath) {
    const normalizedMode = String(mode || "");
    return buildRowIdentityKeyShared(
      normalizedMode,
      String(repoRel || ""),
      normalizedMode === "browse" || normalizedMode === "inspect" ? String(category || "") : "",
      String(filePath || "")
    );
  }

  function resolveKnownFileRow(viewState, payload, repoRel, category, filePath) {
    if (viewState.mode === "compare") {
      return findCompareRow(payload, repoRel, filePath);
    }
    if (viewState.mode === "review") {
      return findReviewRow(payload, repoRel, filePath);
    }
    if (viewState.mode === "browse") {
      return findBrowseRow(payload, repoRel, category, filePath);
    }
    return findInspectRow(payload, repoRel, category, filePath);
  }

  function currentFilePreviewResult(viewState, repoRel, category, filePath, options) {
    if (viewState.mode === "compare") {
      return comparePreview(viewState, repoRel, filePath, options);
    }
    if (viewState.mode === "review") {
      return reviewPreview(viewState, repoRel, filePath, options);
    }
    if (viewState.mode === "browse") {
      return browsePreview(viewState, repoRel, category, filePath, options);
    }
    return inspectPreview(viewState, repoRel, category, filePath, options);
  }

  function previewSnapshotFromResult(previewResult) {
    if (!previewResult || previewResult.status !== 200) {
      return null;
    }
    if (previewResult.kind === "submodule_summary") {
      return {
        preview_kind: "submodule_summary",
        data: previewResult.data || {},
      };
    }
    return {
      preview_kind: "text",
      text: String(previewResult.text || previewResult.previewText || ""),
    };
  }

  function viewedContextLabelForRow(viewState, row) {
    if (!row) {
      return "";
    }
    if (viewState.mode === "browse" || viewState.mode === "inspect") {
      return `${String(row.repo || "")}:${String(row.category || "")}:${String(row.file || "")}`;
    }
    return `${String(row.repo || "")}:${String(row.file || "")}`;
  }

  function viewedStateCountsResponse(viewedDoc) {
    const rootRecord = viewedStateRootRecordForPhysicalPath(viewedDoc || readViewedStateDocumentWithMeta(args.rootRepo).doc, args.rootRepoPhysical);
    const counts = viewedStateCountsForRootRecord(rootRecord);
    return {
      all: counts.all,
      by_mode: counts.by_mode,
    };
  }

  function viewedStateOverlayResponse(viewState, viewedDoc) {
    const cacheEntry = cacheEntryForView(viewState) || getViewData(viewState, false);
    const payload = cacheEntry && cacheEntry.payload ? cacheEntry.payload : {};
    return buildViewedStateOverlayPayload(args.rootRepo, args.rootRepoPhysical, viewState, payload, viewedDoc);
  }

  function viewedStateRootRecordForCurrentPhysicalRoot() {
    const loaded = readViewedStateDocumentWithMeta(args.rootRepo);
    return loaded.doc && loaded.doc.roots && typeof loaded.doc.roots === "object"
      ? (loaded.doc.roots[String(args.rootRepoPhysical || "").trim()] || { entries: {} })
      : { entries: {} };
  }

  function viewedStateDetailsForResolvedRow(rootRecord, viewState, payload, row, options) {
    const detailOptions = options && typeof options === "object" ? options : {};
    const mode = String(viewState && viewState.mode ? viewState.mode : "");
    const repoRel = String(row && row.repo ? row.repo : "");
    const category = String(row && row.category ? row.category : "");
    const filePath = String(row && row.file ? row.file : "");
    const entryKey = viewedEntryKeyForSelection(mode, repoRel, category, filePath);
    const entry = rootRecord && rootRecord.entries ? rootRecord.entries[entryKey] : null;
    const currentToken = String(
      !detailOptions.forceRecomputeToken && row && row.view_token
        ? row.view_token
        : buildViewTokenForResolvedRow(args.rootRepo, resolver, viewState, payload, row)
    ).trim();
    const storedToken = String(entry && entry.view_token ? entry.view_token : "").trim();
    const viewStateName = !entry
      ? VIEW_STATE_UNVIEWED
      : (storedToken === currentToken ? VIEW_STATE_VIEWED : VIEW_STATE_CHANGED);
    return {
      entryKey,
      entry,
      currentToken,
      viewState: viewStateName,
    };
  }

  function resolveViewedMutationFileRow(viewState, repoRel, category, filePath) {
    let dataEntry = getViewData(viewState, false);
    let payload = dataEntry && dataEntry.payload ? dataEntry.payload : {};
    let row = resolveKnownFileRow(viewState, payload, repoRel, category, filePath);
    let refreshed = false;
    if (!row && liveRefreshAppliesToView(viewState)) {
      dataEntry = getViewData(viewState, true);
      payload = dataEntry && dataEntry.payload ? dataEntry.payload : {};
      row = resolveKnownFileRow(viewState, payload, repoRel, category, filePath);
      refreshed = true;
    }
    return {
      dataEntry,
      payload,
      row,
      refreshed,
    };
  }

  function queueViewedMutationRefresh(viewState, repoRels) {
    if (!liveRefreshAppliesToView(viewState)) {
      return;
    }
    const key = dataViewStateKey(viewState);
    if (!state.dataCache.has(key)) {
      return;
    }
    const normalizedRepoRels = uniqueStrings(Array.isArray(repoRels) ? repoRels : []);
    if (!normalizedRepoRels.length) {
      return;
    }
    queuePreparedViewRefresh(key, normalizedRepoRels, { forceFull: false });
  }

  function viewedSelectionRowsForMutation(viewState, selectionKind, repoRel, category) {
    let dataEntry = getViewData(viewState, false);
    let payload = dataEntry && dataEntry.payload ? dataEntry.payload : {};
    let rows = previewSelectionRows(viewState, payload, selectionKind, repoRel, category);
    let refreshed = false;
    if (!rows.length && liveRefreshAppliesToView(viewState)) {
      dataEntry = getViewData(viewState, true);
      payload = dataEntry && dataEntry.payload ? dataEntry.payload : {};
      rows = previewSelectionRows(viewState, payload, selectionKind, repoRel, category);
      refreshed = true;
    }
    return {
      dataEntry,
      payload,
      rows,
      refreshed,
    };
  }

  function markViewedSelection(viewState, repoRel, category, filePath, options) {
    const previewOptions = options && typeof options === "object" ? options : {};
    const startedAt = Date.now();
    const resolvedRow = resolveViewedMutationFileRow(viewState, repoRel, category, filePath);
    const dataEntry = resolvedRow.dataEntry;
    const payload = resolvedRow.payload;
    const knownRow = resolvedRow.row;
    if (!knownRow) {
      logViewedStateTelemetry("mark", {
        mode: String(viewState && viewState.mode ? viewState.mode : ""),
        selection_kind: "file",
        repo: String(repoRel || ""),
        category: String(category || ""),
        file: String(filePath || ""),
        status: 404,
        error: "missing-row",
      });
      return { status: 404, error: "Selected file row is no longer available. Refresh the view and try again." };
    }
    const previewResult = currentFilePreviewResult(viewState, repoRel, category, filePath, previewOptions);
    if (!previewResult || previewResult.status !== 200) {
      logViewedStateTelemetry("mark", {
        mode: String(viewState && viewState.mode ? viewState.mode : ""),
        selection_kind: "file",
        repo: String(repoRel || ""),
        category: String(category || ""),
        file: String(filePath || ""),
        status: previewResult && previewResult.status ? previewResult.status : 500,
        error: previewResult && previewResult.error ? previewResult.error : "preview-capture-failed",
      });
      return {
        status: previewResult && previewResult.status ? previewResult.status : 500,
        error: previewResult && previewResult.error ? previewResult.error : "Failed to capture preview for viewed state.",
      };
    }
    const previewSnapshot = previewSnapshotFromResult(previewResult);
    if (!previewSnapshot) {
      logViewedStateTelemetry("mark", {
        mode: String(viewState && viewState.mode ? viewState.mode : ""),
        selection_kind: "file",
        repo: String(repoRel || ""),
        category: String(category || ""),
        file: String(filePath || ""),
        status: 500,
        error: "preview-normalize-failed",
      });
      return {
        status: 500,
        error: "Failed to normalize the current preview for viewed state.",
      };
    }
    const viewToken = buildViewTokenForResolvedRow(args.rootRepo, resolver, viewState, payload, knownRow);
    const rowKey = viewedEntryKeyForSelection(viewState.mode, repoRel, category, filePath);
    const cachedRowToken = String(knownRow && knownRow.view_token ? knownRow.view_token : "").trim();
    const nextEntry = {
      mode: String(viewState.mode || ""),
      repo: String(repoRel || ""),
      category: String(category || ""),
      file: String(filePath || ""),
      view_token: String(viewToken || "").trim(),
      marked_at: new Date().toISOString(),
      context_label: viewedContextLabelForRow(viewState, knownRow),
      preview_kind: String(previewSnapshot.preview_kind || ""),
      preview_blob_id: "",
    };
    const blobId = writeViewedPreviewBlob(args.rootRepo, previewSnapshot);
    nextEntry.preview_blob_id = blobId;
    let replacedBlobId = "";
    const writeResult = updateViewedStateDocument(args.rootRepo, args.rootRepoPhysical, (_doc, rootRecord) => {
      const entryKey = viewedEntryKeyForSelection(viewState.mode, repoRel, category, filePath);
      const previousEntry = rootRecord.entries[entryKey];
      replacedBlobId = String(previousEntry && previousEntry.preview_blob_id ? previousEntry.preview_blob_id : "");
      rootRecord.entries[entryKey] = nextEntry;
    });
    if (replacedBlobId && replacedBlobId !== blobId) {
      removeViewedPreviewBlob(args.rootRepo, replacedBlobId);
    }
    if (
      liveRefreshAppliesToView(viewState)
      && !resolvedRow.refreshed
      && cachedRowToken !== String(viewToken || "").trim()
    ) {
      queueViewedMutationRefresh(viewState, [repoRel]);
    }
    logViewedStateTelemetry("mark", {
      mode: String(viewState && viewState.mode ? viewState.mode : ""),
      selection_kind: "file",
      repo: String(repoRel || ""),
      category: String(category || ""),
      file: String(filePath || ""),
      blob_skipped: blobId ? 0 : 1,
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      status: 200,
    });
    return {
      status: 200,
      ok: true,
      viewed_state: VIEW_STATE_VIEWED,
      view_token: nextEntry.view_token,
      marked_at: nextEntry.marked_at,
      view_blob_available: blobId ? "true" : "false",
      counts: viewedStateCountsResponse(writeResult && writeResult.written),
      overlay: buildViewedStateOverlayPayload(
        args.rootRepo,
        args.rootRepoPhysical,
        viewState,
        payload,
        writeResult && writeResult.written,
        {
          token_overrides: {
            [rowKey]: nextEntry.view_token,
          },
          extra_rows: [knownRow],
        }
      ),
    };
  }

  function unmarkViewedSelection(viewState, repoRel, category, filePath) {
    const startedAt = Date.now();
    let removedBlobId = "";
    let removed = false;
    const writeResult = updateViewedStateDocument(args.rootRepo, args.rootRepoPhysical, (_doc, rootRecord) => {
      const entryKey = viewedEntryKeyForSelection(viewState.mode, repoRel, category, filePath);
      const previousEntry = rootRecord.entries[entryKey];
      if (!previousEntry) {
        return;
      }
      removed = true;
      removedBlobId = String(previousEntry.preview_blob_id || "");
      delete rootRecord.entries[entryKey];
    });
    if (removedBlobId) {
      removeViewedPreviewBlob(args.rootRepo, removedBlobId);
    }
    logViewedStateTelemetry("unmark", {
      mode: String(viewState && viewState.mode ? viewState.mode : ""),
      selection_kind: "file",
      repo: String(repoRel || ""),
      category: String(category || ""),
      file: String(filePath || ""),
      removed: removed ? 1 : 0,
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      status: 200,
    });
    return {
      status: 200,
      ok: true,
      removed,
      viewed_state: VIEW_STATE_UNVIEWED,
      marked_at: "",
      view_blob_available: "false",
      counts: viewedStateCountsResponse(writeResult && writeResult.written),
      overlay: viewedStateOverlayResponse(viewState, writeResult && writeResult.written),
    };
  }

  function cleanupViewedPreviewBlobIds(blobIds) {
    for (const blobId of uniqueStrings(Array.isArray(blobIds) ? blobIds : [])) {
      if (blobId) {
        removeViewedPreviewBlob(args.rootRepo, blobId);
      }
    }
  }

  function markViewedSelectionGroup(viewState, selectionKind, repoRel, category, options) {
    const normalizedSelectionKind = String(selectionKind || "");
    const { payload, rows, refreshed } = viewedSelectionRowsForMutation(viewState, normalizedSelectionKind, repoRel, category);
    const previewOptions = options && typeof options === "object" ? options : {};
    const startedAt = Date.now();
    if (!rows.length) {
      logViewedStateTelemetry("mark-bulk", {
        mode: String(viewState && viewState.mode ? viewState.mode : ""),
        selection_kind: normalizedSelectionKind,
        repo: String(repoRel || ""),
        category: String(category || ""),
        visible_rows: 0,
        status: 404,
        error: "no-visible-rows",
      });
      return { status: 404, error: "No visible file rows are available for this selection." };
    }
    const rootRecord = viewedStateRootRecordForCurrentPhysicalRoot();
    const nextEntries = [];
    const createdBlobIds = [];
    const tokenOverrides = {};
    const staleRepoRels = new Set();
    let blobSkippedCount = 0;
    for (const row of rows) {
      const details = viewedStateDetailsForResolvedRow(rootRecord, viewState, payload, row, {
        forceRecomputeToken: true,
      });
      tokenOverrides[details.entryKey] = String(details.currentToken || "");
      if (
        liveRefreshAppliesToView(viewState)
        && !refreshed
        && String(row && row.view_token ? row.view_token : "").trim() !== String(details.currentToken || "").trim()
      ) {
        staleRepoRels.add(String(row && row.repo ? row.repo : repoRel || "."));
      }
      if (details.viewState === VIEW_STATE_VIEWED) {
        continue;
      }
      const previewResult = currentFilePreviewResult(
        viewState,
        String(row && row.repo ? row.repo : ""),
        String(row && row.category ? row.category : ""),
        String(row && row.file ? row.file : ""),
        previewOptions
      );
      if (!previewResult || previewResult.status !== 200) {
        cleanupViewedPreviewBlobIds(createdBlobIds);
        logViewedStateTelemetry("mark-bulk", {
          mode: String(viewState && viewState.mode ? viewState.mode : ""),
          selection_kind: normalizedSelectionKind,
          repo: String(repoRel || ""),
          category: String(category || ""),
          visible_rows: rows.length,
          prepared_rows: nextEntries.length,
          confirm_large: previewOptions.confirm_large === true ? 1 : 0,
          status: previewResult && previewResult.status ? previewResult.status : 500,
          error: previewResult && previewResult.error ? previewResult.error : "preview-capture-failed",
        });
        return {
          status: previewResult && previewResult.status ? previewResult.status : 500,
          error: previewResult && previewResult.error ? previewResult.error : "Failed to capture preview for viewed state.",
        };
      }
      const previewSnapshot = previewSnapshotFromResult(previewResult);
      if (!previewSnapshot) {
        cleanupViewedPreviewBlobIds(createdBlobIds);
        return {
          status: 500,
          error: "Failed to normalize the current preview for viewed state.",
        };
      }
      const blobId = writeViewedPreviewBlob(args.rootRepo, previewSnapshot);
      if (blobId) {
        createdBlobIds.push(blobId);
      } else {
        blobSkippedCount += 1;
      }
      nextEntries.push({
        entryKey: details.entryKey,
        previousBlobId: String(details.entry && details.entry.preview_blob_id ? details.entry.preview_blob_id : ""),
        nextEntry: {
          mode: String(viewState.mode || ""),
          repo: String(row && row.repo ? row.repo : ""),
          category: String(row && row.category ? row.category : ""),
          file: String(row && row.file ? row.file : ""),
          view_token: String(details.currentToken || ""),
          marked_at: new Date().toISOString(),
          context_label: viewedContextLabelForRow(viewState, row),
          preview_kind: String(previewSnapshot.preview_kind || ""),
          preview_blob_id: blobId,
        },
      });
    }
    if (!nextEntries.length) {
      logViewedStateTelemetry("mark-bulk", {
        mode: String(viewState && viewState.mode ? viewState.mode : ""),
        selection_kind: normalizedSelectionKind,
        repo: String(repoRel || ""),
        category: String(category || ""),
        visible_rows: rows.length,
        marked: 0,
        confirm_large: previewOptions.confirm_large === true ? 1 : 0,
        elapsed_ms: Math.max(0, Date.now() - startedAt),
        status: 200,
      });
      return {
        status: 200,
        ok: true,
        marked: 0,
        counts: viewedStateCountsResponse(),
        overlay: viewedStateOverlayResponse(viewState),
      };
    }
    let writeResult = null;
    try {
      writeResult = updateViewedStateDocument(args.rootRepo, args.rootRepoPhysical, (_doc, rootRecordForWrite) => {
        for (const entry of nextEntries) {
          rootRecordForWrite.entries[entry.entryKey] = entry.nextEntry;
        }
      });
    } catch (err) {
      cleanupViewedPreviewBlobIds(createdBlobIds);
      throw err;
    }
    cleanupViewedPreviewBlobIds(nextEntries
      .map((entry) => entry.previousBlobId)
      .filter((blobId, index, values) => blobId && !createdBlobIds.includes(blobId) && values.indexOf(blobId) === index)
    );
    if (staleRepoRels.size) {
      queueViewedMutationRefresh(viewState, Array.from(staleRepoRels));
    }
    logViewedStateTelemetry("mark-bulk", {
      mode: String(viewState && viewState.mode ? viewState.mode : ""),
      selection_kind: normalizedSelectionKind,
      repo: String(repoRel || ""),
      category: String(category || ""),
      visible_rows: rows.length,
      marked: nextEntries.length,
      confirm_large: previewOptions.confirm_large === true ? 1 : 0,
      blob_skipped: blobSkippedCount,
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      status: 200,
    });
    return {
      status: 200,
      ok: true,
      marked: nextEntries.length,
      counts: viewedStateCountsResponse(writeResult && writeResult.written),
      overlay: buildViewedStateOverlayPayload(
        args.rootRepo,
        args.rootRepoPhysical,
        viewState,
        payload,
        writeResult && writeResult.written,
        {
          token_overrides: tokenOverrides,
        }
      ),
    };
  }

  function unmarkViewedSelectionGroup(viewState, selectionKind, repoRel, category) {
    const normalizedSelectionKind = String(selectionKind || "");
    const { payload, rows } = viewedSelectionRowsForMutation(viewState, normalizedSelectionKind, repoRel, category);
    const startedAt = Date.now();
    if (!rows.length) {
      logViewedStateTelemetry("unmark-bulk", {
        mode: String(viewState && viewState.mode ? viewState.mode : ""),
        selection_kind: normalizedSelectionKind,
        repo: String(repoRel || ""),
        category: String(category || ""),
        visible_rows: 0,
        status: 404,
        error: "no-visible-rows",
      });
      return { status: 404, error: "No visible file rows are available for this selection." };
    }
    const rootRecord = viewedStateRootRecordForCurrentPhysicalRoot();
    const removedEntries = [];
    for (const row of rows) {
      const details = viewedStateDetailsForResolvedRow(rootRecord, viewState, payload, row);
      if (!details.entry) {
        continue;
      }
      removedEntries.push({
        entryKey: details.entryKey,
        blobId: String(details.entry.preview_blob_id || ""),
      });
    }
    if (!removedEntries.length) {
      return {
        status: 200,
        ok: true,
        removed: 0,
        counts: viewedStateCountsResponse(),
        overlay: viewedStateOverlayResponse(viewState),
      };
    }
    const writeResult = updateViewedStateDocument(args.rootRepo, args.rootRepoPhysical, (_doc, rootRecordForWrite) => {
      for (const entry of removedEntries) {
        delete rootRecordForWrite.entries[entry.entryKey];
      }
    });
    cleanupViewedPreviewBlobIds(removedEntries.map((entry) => entry.blobId));
    logViewedStateTelemetry("unmark-bulk", {
      mode: String(viewState && viewState.mode ? viewState.mode : ""),
      selection_kind: normalizedSelectionKind,
      repo: String(repoRel || ""),
      category: String(category || ""),
      visible_rows: rows.length,
      removed: removedEntries.length,
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      status: 200,
    });
    return {
      status: 200,
      ok: true,
      removed: removedEntries.length,
      counts: viewedStateCountsResponse(writeResult && writeResult.written),
      overlay: viewedStateOverlayResponse(viewState, writeResult && writeResult.written),
    };
  }

  function clearViewedSelections(scope, viewStateOrMode) {
    const normalizedScope = scope === "all" ? "all" : "mode";
    const normalizedViewState = viewStateOrMode && typeof viewStateOrMode === "object"
      ? viewStateOrMode
      : { mode: viewStateOrMode };
    const normalizedMode = normalizeMode(normalizedViewState && normalizedViewState.mode, "");
    const removedBlobIds = [];
    let clearedCount = 0;
    const startedAt = Date.now();
    const writeResult = updateViewedStateDocument(args.rootRepo, args.rootRepoPhysical, (_doc, rootRecord) => {
      const nextEntries = {};
      for (const [entryKey, entry] of Object.entries(rootRecord.entries || {})) {
        const entryMode = normalizeMode(entry && entry.mode, "");
        const shouldRemove = normalizedScope === "all"
          ? true
          : (Boolean(normalizedMode) && entryMode === normalizedMode);
        if (shouldRemove) {
          const blobId = String(entry && entry.preview_blob_id ? entry.preview_blob_id : "").trim();
          if (blobId) {
            removedBlobIds.push(blobId);
          }
          clearedCount += 1;
          continue;
        }
        nextEntries[entryKey] = entry;
      }
      rootRecord.entries = nextEntries;
    });
    for (const blobId of removedBlobIds) {
      removeViewedPreviewBlob(args.rootRepo, blobId);
    }
    logViewedStateTelemetry("clear", {
      scope: normalizedScope,
      mode: normalizedMode,
      cleared: clearedCount,
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      status: 200,
    });
    return {
      status: 200,
      ok: true,
      cleared: clearedCount,
      counts: viewedStateCountsResponse(writeResult && writeResult.written),
      overlay: viewedStateOverlayResponse(normalizedViewState, writeResult && writeResult.written),
    };
  }

  function sinceViewedPreview(viewState, repoRel, category, filePath, options) {
    const previewOptions = options && typeof options === "object" ? options : {};
    const dataEntry = getViewData(viewState, false);
    const knownRow = resolveKnownFileRow(viewState, dataEntry.payload, repoRel, category, filePath);
    if (!knownRow) {
      return { status: 404, error: "Selected file row is no longer available. Refresh the view and try again." };
    }
    const viewedEntryKey = viewedEntryKeyForSelection(viewState.mode, repoRel, category, filePath);
    const loaded = readViewedStateDocumentWithMeta(args.rootRepo);
    const rootRecord = loaded.doc && loaded.doc.roots && typeof loaded.doc.roots === "object"
      ? (loaded.doc.roots[String(args.rootRepoPhysical || "").trim()] || { entries: {} })
      : { entries: {} };
    const viewedEntry = rootRecord.entries && rootRecord.entries[viewedEntryKey]
      ? rootRecord.entries[viewedEntryKey]
      : null;
    if (!viewedEntry || !viewedEntry.preview_blob_id) {
      return { status: 404, error: "Viewed snapshot is unavailable for this row." };
    }
    const storedPreview = normalizeStoredPreviewSnapshot(loadViewedPreviewBlob(args.rootRepo, viewedEntry.preview_blob_id));
    if (!storedPreview) {
      return { status: 404, error: "Viewed snapshot is unavailable for this row." };
    }
    const currentPreview = currentFilePreviewResult(viewState, repoRel, category, filePath, previewOptions);
    if (!currentPreview || currentPreview.status !== 200) {
      return {
        status: currentPreview && currentPreview.status ? currentPreview.status : 500,
        error: currentPreview && currentPreview.error ? currentPreview.error : "Failed to load current preview.",
      };
    }
    const currentSnapshot = previewSnapshotFromResult(currentPreview);
    if (!currentSnapshot) {
      return { status: 500, error: "Current preview could not be normalized." };
    }
    if (storedPreview.preview_kind === "text" && currentSnapshot.preview_kind === "text") {
      return {
        status: 200,
        kind: "text",
        text: buildUnifiedDiffFromTexts(
          storedPreview.text,
          currentSnapshot.text,
          filePath,
          {
            oldLabel: `viewed:${sanitizePreviewDiffLabelPath(filePath)}`,
            newLabel: `current:${sanitizePreviewDiffLabelPath(filePath)}`,
          },
          previewOptions
        ),
        primaryActionSupported: false,
        primaryActionError: "Primary action is only available for the current preview.",
      };
    }
    return {
      status: 200,
      kind: "since_viewed_summary",
      data: {
        file: String(filePath || ""),
        marked_at: String(viewedEntry.marked_at || ""),
        previous: storedPreview,
        current: currentSnapshot,
      },
      primaryActionSupported: false,
      primaryActionError: "Primary action is only available for the current preview.",
    };
  }

  function resolveBrowsePrimaryAction(viewState, repoRel, category, filePath) {
    const dataEntry = getViewData(viewState, false);
    const knownRow = findBrowseRow(dataEntry.payload, repoRel, category, filePath);
    if (!knownRow) {
      return { status: 404, error: UNKNOWN_BROWSE_ROW_ERROR };
    }

    if (category === "submodules") {
      return {
        status: 200,
        primaryActionSupported: false,
        primaryActionError: BROWSE_SUBMODULE_EDIT_ERROR,
      };
    }

    const primaryActionFile = resolver.currentFilePath(repoRel, filePath);
    if (!fs.existsSync(primaryActionFile)) {
      return {
        status: 200,
        primaryActionSupported: false,
        primaryActionError: BROWSE_MISSING_FILE_EDIT_ERROR,
        primaryActionFile,
      };
    }

    return {
      status: 200,
      primaryActionSupported: true,
      primaryActionFile,
    };
  }

  function browsePreview(viewState, repoRel, category, filePath, options) {
    const previewOptions = options && typeof options === "object" ? options : {};
    assertPreviewSignalNotAborted(previewOptions.signal);
    const browseActionResult = resolveBrowsePrimaryAction(viewState, repoRel, category, filePath);
    if (browseActionResult.status !== 200) {
      return { status: browseActionResult.status, error: browseActionResult.error || "Preview unavailable." };
    }

    const key = `${viewStateKey(viewState)}\0browse\0${repoRel}\0${category}\0${filePath}`;
    if (state.previewCache.has(key)) {
      return Object.assign({ status: 200 }, state.previewCache.get(key));
    }

    if (category === "submodules") {
      const summary = buildBrowseSubmoduleSummary(resolver, repoRel, filePath);
      const previewResult = {
        kind: "submodule_summary",
        data: summary || {
          path: filePath,
          repo: repoRel || ".",
          summary: "Submodule summary is unavailable for this path.",
          fields: [],
          sections: [],
          notes: [],
        },
        primaryActionSupported: false,
        primaryActionError: BROWSE_SUBMODULE_EDIT_ERROR,
      };
      state.previewCache.set(key, previewResult);
      return Object.assign({ status: 200 }, previewResult);
    }

    let leftFile = "";
    let rightFile = "";
    let diffLabels = null;
    assertPreviewSignalNotAborted(previewOptions.signal);
    if (category === "staged") {
      leftFile = resolver.headPathEntry(repoRel, filePath)
        ? resolver.materializeHeadFile(repoRel, filePath)
        : resolver.materializeEmptyFile("head", repoRel, filePath);
      assertPreviewSignalNotAborted(previewOptions.signal);
      rightFile = resolver.actualIndexEntry(repoRel, filePath)
        ? resolver.materializeIndexFile(repoRel, filePath)
        : resolver.materializeEmptyFile("index", repoRel, filePath);
      diffLabels = {
        oldLabel: `head:${sanitizePreviewDiffLabelPath(filePath)}`,
        newLabel: `index:${sanitizePreviewDiffLabelPath(filePath)}`,
      };
    } else if (category === "unstaged") {
      leftFile = resolver.actualIndexEntry(repoRel, filePath)
        ? resolver.materializeIndexFile(repoRel, filePath)
        : resolver.materializeEmptyFile("index", repoRel, filePath);
      assertPreviewSignalNotAborted(previewOptions.signal);
      const currentFile = resolver.currentFilePath(repoRel, filePath);
      rightFile = fs.existsSync(currentFile)
        ? currentFile
        : resolver.materializeEmptyFile("working-tree", repoRel, filePath);
      diffLabels = {
        oldLabel: `index:${sanitizePreviewDiffLabelPath(filePath)}`,
        newLabel: `working-tree:${sanitizePreviewDiffLabelPath(filePath)}`,
      };
    } else if (category === "untracked") {
      leftFile = resolver.materializeEmptyFile("untracked-base", repoRel, filePath);
      assertPreviewSignalNotAborted(previewOptions.signal);
      const currentFile = resolver.currentFilePath(repoRel, filePath);
      rightFile = fs.existsSync(currentFile)
        ? currentFile
        : resolver.materializeEmptyFile("working-tree", repoRel, filePath);
      diffLabels = {
        oldLabel: `empty:${sanitizePreviewDiffLabelPath(filePath)}`,
        newLabel: `working-tree:${sanitizePreviewDiffLabelPath(filePath)}`,
      };
    } else {
      return { status: 400, error: `Unsupported browse preview category: ${category}` };
    }

    const previewResult = {
      kind: "text",
      text: buildUnifiedDiff(leftFile, rightFile, filePath, diffLabels, previewOptions),
      snapshotFile: leftFile,
      currentFile: rightFile,
      primaryActionSupported: Boolean(browseActionResult.primaryActionSupported),
      primaryActionError: browseActionResult.primaryActionError || "",
      primaryActionFile: browseActionResult.primaryActionFile || "",
    };
    state.previewCache.set(key, previewResult);
    return Object.assign({ status: 200 }, previewResult);
  }

  function comparePreview(viewState, repoRel, filePath, options) {
    const previewOptions = options && typeof options === "object" ? options : {};
    assertPreviewSignalNotAborted(previewOptions.signal);
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
        primaryActionSupported: false,
        primaryActionError: "External diff is not available for submodule summary rows.",
      };
      state.previewCache.set(key, previewResult);
      return Object.assign({ status: 200 }, previewResult);
    }

    let snapshotFile = "";
    let currentFile = "";
    let previewText = "";
    const orientation = compareOrientationSpec(viewState.compareBase, filePath);
    const rowRemovesPath = compareRowSnapshotRemovesPath(knownRow);
    const snapshotPathExpectedMissing = compareRowSnapshotRemovesPath(knownRow);
    const currentPathExpectedMissing = compareRowCurrentPathExpectedMissing(knownRow);

    if (compareRowRepoMissing(knownRow)) {
      const message = compareReasonDetailText(knownRow)
        || "Snapshot content preview is unavailable until the missing repo/path is restored.";
      previewText = "Working tree path is missing.\\n" + message;
      const previewResult = {
        kind: "text",
        text: previewText,
        snapshotFile,
        currentFile,
        primaryActionSupported: false,
        primaryActionError: "External diff is not available until the missing repo/path is restored.",
      };
      state.previewCache.set(key, previewResult);
      return Object.assign({ status: 200 }, previewResult);
    }

    try {
      const pair = resolver.compareFilePair(viewState.snapshotId, repoRel, filePath);
      snapshotFile = pair.snapshotFile;
      currentFile = pair.currentFile;
    } catch (err) {
      return {
        status: 500,
        error: comparePreviewError(filePath, err && err.message ? err.message : String(err)),
      };
    }

    const snapshotFileExistsBeforeFallback = fs.existsSync(snapshotFile);
    const currentFileExistsBeforeFallback = fs.existsSync(currentFile);
    assertPreviewSignalNotAborted(previewOptions.signal);

    if (snapshotPathExpectedMissing && !snapshotFileExistsBeforeFallback) {
      snapshotFile = resolver.materializeEmptyFile("compare-snapshot-empty", repoRel, filePath);
    }
    if (currentPathExpectedMissing && !currentFileExistsBeforeFallback) {
      currentFile = resolver.materializeEmptyFile("compare-current-empty", repoRel, filePath);
    }

    if (!rowRemovesPath && !snapshotFileExistsBeforeFallback) {
      return {
        status: 500,
        error: comparePreviewError(filePath, "The snapshot target could not be materialized from the captured bundle."),
      };
    }
    if (!currentPathExpectedMissing && !currentFileExistsBeforeFallback) {
      return {
        status: 500,
        error: comparePreviewError(filePath, "The current working-tree compare view could not be materialized."),
      };
    }

    if (currentPathExpectedMissing && !currentFileExistsBeforeFallback && rowRemovesPath && !snapshotFileExistsBeforeFallback) {
      previewText = `Snapshot target removes this path and the working tree already matches. (${filePath})`;
    } else if ((knownRow.status || "") === "unresolved_missing" && !currentFileExistsBeforeFallback) {
      previewText = orientation.compareBase === "snapshot"
        ? buildCurrentMissingDiff(snapshotFile, filePath, previewOptions)
        : buildSnapshotOnlyDiff(snapshotFile, filePath, previewOptions);
    } else {
      previewText = buildUnifiedDiff(
        compareFileForRole(orientation.oldFileRole, snapshotFile, currentFile),
        compareFileForRole(orientation.newFileRole, snapshotFile, currentFile),
        filePath,
        {
          oldLabel: orientation.oldLabel,
          newLabel: orientation.newLabel,
        },
        previewOptions
      );
    }
    const previewResult = {
      kind: "text",
      text: previewText,
      snapshotFile,
      currentFile,
      primaryActionSupported: true,
    };
    state.previewCache.set(key, previewResult);
    return Object.assign({ status: 200 }, previewResult);
  }

  function reviewPreview(viewState, repoRel, filePath, options) {
    const previewOptions = options && typeof options === "object" ? options : {};
    assertPreviewSignalNotAborted(previewOptions.signal);
    const dataEntry = getViewData(viewState, false);
    const knownRow = findReviewRow(dataEntry.payload, repoRel, filePath);
    if (!knownRow) {
      return { status: 404, error: "Unknown review row." };
    }

    const key = `${viewStateKey(viewState)}\0review\0${repoRel}\0${filePath}`;
    if (state.previewCache.has(key)) {
      return Object.assign({ status: 200 }, state.previewCache.get(key));
    }

    const repoRow = Array.isArray(dataEntry.payload.repoRows)
      ? dataEntry.payload.repoRows.find((row) => String(row.repo || "") === String(repoRel || ""))
      : null;
      const mergeBase = String(repoRow && repoRow.merge_base ? repoRow.merge_base : "");
      const effectiveBaseRef = String(repoRow && repoRow.effective_base_ref ? repoRow.effective_base_ref : "").trim()
        || normalizeReviewBaseRef(viewState.reviewBaseRef, "master");
      if (!mergeBase) {
        return {
          status: 500,
          error: reviewPreviewError(filePath, `The selected repo does not have a resolved merge-base against ${effectiveBaseRef}.`),
        };
      }

    let baselineFile = "";
    let headFile = "";
    let previewText = "";
    try {
      baselineFile = resolver.materializeRevisionFile(repoRel, filePath, mergeBase, "review-base");
      assertPreviewSignalNotAborted(previewOptions.signal);
      headFile = resolver.materializeRevisionFile(repoRel, filePath, "HEAD", "review-head");
      previewText = buildUnifiedDiff(baselineFile, headFile, filePath, {
        oldLabel: `merge-base:${sanitizePreviewDiffLabelPath(filePath)}`,
        newLabel: `head:${sanitizePreviewDiffLabelPath(filePath)}`,
      }, previewOptions);
    } catch (err) {
      return {
        status: 500,
        error: reviewPreviewError(filePath, err && err.message ? err.message : String(err)),
      };
    }

    const previewResult = {
      kind: "text",
      text: previewText,
      primaryActionSupported: false,
      primaryActionError: "External diff is not available in review mode.",
    };
    state.previewCache.set(key, previewResult);
    return Object.assign({ status: 200 }, previewResult);
  }

  function inspectPreview(viewState, repoRel, category, filePath, options) {
    const previewOptions = options && typeof options === "object" ? options : {};
    assertPreviewSignalNotAborted(previewOptions.signal);
    const dataEntry = getViewData(viewState, false);
    const knownRow = findInspectRow(dataEntry.payload, repoRel, category, filePath);
    if (!knownRow) {
      return { status: 404, error: UNKNOWN_INSPECT_ROW_ERROR };
    }

    const key = `${viewStateKey(viewState)}\0inspect\0${repoRel}\0${category}\0${filePath}`;
    if (state.previewCache.has(key)) {
      return { status: 200, text: state.previewCache.get(key).previewText };
    }

    assertPreviewSignalNotAborted(previewOptions.signal);
    const previewText = category === "untracked"
      ? resolver.inspectUntrackedPreview(viewState.snapshotId, repoRel, filePath)
      : resolver.inspectPatchPreview(viewState.snapshotId, repoRel, category, filePath);
    state.previewCache.set(key, { previewText });
    return { status: 200, text: previewText };
  }

  function previewResultToAggregateBlock(row, previewResult) {
    const block = {
      repo: String(row && row.repo ? row.repo : ""),
      category: String(row && row.category ? row.category : ""),
      file: String(row && row.file ? row.file : ""),
      lines_added: String(row && row.lines_added ? row.lines_added : ""),
      lines_removed: String(row && row.lines_removed ? row.lines_removed : ""),
      display_kind: String(row && row.display_kind ? row.display_kind : ""),
      display_label: String(row && row.display_label ? row.display_label : ""),
    };
    if (previewResult && previewResult.kind === "submodule_summary") {
      block.preview_kind = "submodule_summary";
      block.data = previewResult.data || {};
      return block;
    }
    const previewError = String(previewResult && previewResult.error ? previewResult.error : "").trim();
    block.preview_kind = "text";
    block.text = String(previewResult && (previewResult.text || previewResult.previewText) ? (previewResult.text || previewResult.previewText) : "");
    block.preview_error = previewError ? "true" : "false";
    if (previewError) {
      block.error_message = previewError;
    }
    return block;
  }

  async function aggregatePreview(viewState, selectionKind, repoRel, category, options) {
    const previewOptions = options && typeof options === "object" ? options : {};
    const signal = previewOptions.signal || null;
    const dataEntry = getViewData(viewState, false);
    const payload = dataEntry && dataEntry.payload ? dataEntry.payload : {};
    const rows = previewSelectionRows(viewState, payload, selectionKind, repoRel, category);
    const totalRows = rows.length;
    const offset = normalizeAggregatePreviewOffset(previewOptions.offset);
    const limit = normalizeAggregatePreviewLimit(previewOptions.limit);
    const safeOffset = Math.min(offset, totalRows);
    const rowSlice = rows.slice(safeOffset, safeOffset + limit);
    const startedAt = Date.now();
    const blocks = [];
    let errorBlockCount = 0;

    assertPreviewSignalNotAborted(signal);
    for (const row of rowSlice) {
      assertPreviewSignalNotAborted(signal);
      let previewResult = null;
      if (viewState.mode === "compare") {
        previewResult = comparePreview(viewState, row.repo || "", row.file || "", previewOptions);
      } else if (viewState.mode === "review") {
        previewResult = reviewPreview(viewState, row.repo || "", row.file || "", previewOptions);
      } else if (viewState.mode === "browse") {
        previewResult = browsePreview(viewState, row.repo || "", row.category || "", row.file || "", previewOptions);
      } else {
        previewResult = inspectPreview(viewState, row.repo || "", row.category || "", row.file || "", previewOptions);
      }
      assertPreviewSignalNotAborted(signal);

      if (!previewResult || previewResult.status !== 200) {
        errorBlockCount += 1;
        blocks.push(previewResultToAggregateBlock(row, {
          kind: "text",
          text: (previewResult && previewResult.error) || "Preview unavailable.",
          error: (previewResult && previewResult.error) || "Preview unavailable.",
        }));
        continue;
      }

      blocks.push(previewResultToAggregateBlock(row, previewResult));
    }

    const nextOffset = Math.min(totalRows, safeOffset + blocks.length);
    const result = {
      status: 200,
      ok: true,
      preview_kind: "aggregate_preview",
      selection_kind: selectionKind,
      title: previewSelectionTitle(viewState, selectionKind, repoRel, category),
      summary_text: totalRows
        ? ""
        : previewSelectionEmptyMessage(viewState, payload, selectionKind, repoRel, category),
      empty_message: previewSelectionEmptyMessage(viewState, payload, selectionKind, repoRel, category),
      total_rows: totalRows,
      rendered_rows: nextOffset,
      rendered_offset: safeOffset,
      next_offset: nextOffset,
      page_rows: blocks.length,
      page_size: limit,
      has_more: nextOffset < totalRows,
      elapsed_ms: Math.max(0, Date.now() - startedAt),
      error_block_count: errorBlockCount,
      partial_failure: errorBlockCount > 0,
      warning_message: errorBlockCount > 0
        ? `${errorBlockCount} preview block${errorBlockCount === 1 ? "" : "s"} could not be rendered and are shown as inline errors.`
        : "",
      blocks,
      primaryActionSupported: false,
      primaryActionError: "Primary action is only available for individual file selections.",
    };
    logAggregatePreviewTelemetry(viewState, selectionKind, repoRel, category, result);
    return result;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(htmlPage(
          resolveViewStateFromUrl(url, args),
          args.compareBaseExplicit === "true",
          args.repoGuiConfig || currentRepoGuiConfig(),
          args.rootRepoPhysical
        ));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/snapshots") {
        const selectedSnapshotId = url.searchParams.get("selected_snapshot_id") || args.initialViewState.snapshotId;
        const forceRefresh = url.searchParams.get("force") === "1";
        const includeAuto = url.searchParams.get("include_auto") === "1";
        const cache = getSnapshots(forceRefresh, selectedSnapshotId, includeAuto);
        json(res, 200, {
          snapshots: cache.snapshots,
          cacheLoadedAt: cache.loadedAt,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/refresh-state") {
        const viewState = resolveViewStateFromUrl(url, args);
        const forceVerify = url.searchParams.get("verify") === "1";
        json(res, 200, Object.assign({
          ok: true,
        }, viewStatusForClient(
          viewState,
          url.searchParams.get("view_data_token") || "",
          url.searchParams.get("server_instance_id") || "",
          { forceVerify }
        )));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/data") {
        const forceRefresh = url.searchParams.get("force") === "1";
        const explicitRefresh = url.searchParams.get("explicit_refresh") === "1";
        const viewState = resolveViewStateFromUrl(url, args);
        const delayMs = testDataDelayMs(viewState.mode);
        const requestAbort = createRequestAbortController(req, res);
        if (delayMs > 0) {
          try {
            await Promise.race([
              delay(delayMs),
              new Promise((_, reject) => {
                if (requestAbort.signal.aborted) {
                  reject(new SnapshotGuiRequestAbortedError());
                  return;
                }
                requestAbort.signal.addEventListener("abort", () => {
                  reject(new SnapshotGuiRequestAbortedError());
                }, { once: true });
              }),
            ]);
          } catch (err) {
            requestAbort.cleanup();
            throw err;
          }
        }
        try {
          const cache = await getViewDataAsync(viewState, forceRefresh || explicitRefresh, { signal: requestAbort.signal });
          requestAbort.cleanup();
          json(res, 200, buildViewDataResponsePayload(cache, viewState));
        } catch (err) {
          requestAbort.cleanup();
          throw err;
        }
        return;
      }

      if (req.method === "GET" && (url.pathname === "/api/preview" || url.pathname === "/api/diff")) {
        const viewState = resolveViewStateFromUrl(url, args);
        const requestAbort = createRequestAbortController(req, res);
        const previewVariant = String(url.searchParams.get("preview_variant") || PREVIEW_VARIANT_CURRENT).trim() || PREVIEW_VARIANT_CURRENT;
        const selectionKind = normalizeSelectedKind(
          viewState.mode,
          url.searchParams.get("selection_kind") || "file",
          url.searchParams.get("repo") || "",
          url.searchParams.get("category") || "",
          url.searchParams.get("file") || ""
        );
        const repoRel = url.searchParams.get("repo") || "";
        const filePath = url.searchParams.get("file") || "";
        const category = url.searchParams.get("category") || "";
        if (!repoRel || (selectionKind === "file" && !filePath)) {
          requestAbort.cleanup();
          text(res, 400, "Missing repo/file query parameters.");
          return;
        }
        if (url.pathname === "/api/diff") {
          const compareResult = comparePreview(
            Object.assign({}, viewState, { mode: "compare" }),
            repoRel,
            filePath,
            { signal: requestAbort.signal }
          );
          requestAbort.cleanup();
          if (compareResult.status !== 200) {
            text(res, compareResult.status, compareResult.error || "Preview unavailable.");
            return;
          }
          res.setHeader(PRIMARY_ACTION_SUPPORT_HEADER, previewPrimaryActionHeaderValue(compareResult));
          if (compareResult.kind === "submodule_summary") {
            text(res, 200, compareResult.data && compareResult.data.summary
              ? compareResult.data.summary
              : "Submodule summary preview is available in the shared browser.");
            return;
          }
          text(res, 200, compareResult.text);
          return;
        }
        const previewOffset = normalizeAggregatePreviewOffset(url.searchParams.get("preview_offset"));
        const previewLimitInfo = parseAggregatePreviewLimit(url.searchParams.get("preview_limit"));
        const previewLimit = previewLimitInfo.applied;
        if (selectionKind !== "file" && previewLimitInfo.capped) {
          logAggregatePreviewEvent("capped", {
            mode: viewState.mode,
            selection: selectionKind,
            repo: repoRel || ".",
            category: category || "(none)",
            requested: previewLimitInfo.requested,
            applied: previewLimit,
          });
        }
        let previewResult = null;
        try {
          if (selectionKind === "file") {
            if (previewVariant === PREVIEW_VARIANT_SINCE_VIEWED) {
              previewResult = sinceViewedPreview(viewState, repoRel, category, filePath, { signal: requestAbort.signal });
            } else {
              previewResult = currentFilePreviewResult(viewState, repoRel, category, filePath, { signal: requestAbort.signal });
            }
          } else {
            previewResult = await aggregatePreview(viewState, selectionKind, repoRel, category, {
              offset: previewOffset,
              limit: previewLimit,
              signal: requestAbort.signal,
            });
          }
          requestAbort.cleanup();
        } catch (err) {
          requestAbort.cleanup();
          throw err;
        }
        if (previewResult.status !== 200) {
          text(res, previewResult.status, previewResult.error || "Preview unavailable.");
          return;
        }
        if (viewState.mode === "compare" || viewState.mode === "browse") {
          res.setHeader(PRIMARY_ACTION_SUPPORT_HEADER, previewPrimaryActionHeaderValue(previewResult));
        }
        setAggregatePreviewTelemetryHeaders(res, previewResult);
        if (previewResult.kind === "submodule_summary") {
          json(res, 200, {
            ok: true,
            preview_kind: "submodule_summary",
            data: previewResult.data,
          });
          return;
        }
        if (previewResult.kind === "since_viewed_summary") {
          json(res, 200, {
            ok: true,
            preview_kind: "since_viewed_summary",
            data: previewResult.data,
          });
          return;
        }
        if (previewResult.preview_kind === "aggregate_preview") {
          json(res, 200, previewResult);
          return;
        }
        text(res, 200, previewResult.text);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/viewed/mark") {
        const viewState = resolveViewStateFromUrl(url, args);
        const payload = await readJsonRequestBody(req);
        const repoRel = String(payload && payload.repo ? payload.repo : "").trim();
        const category = String(payload && payload.category ? payload.category : "").trim();
        const filePath = String(payload && payload.file ? payload.file : "").trim();
        if (!repoRel || !filePath) {
          json(res, 400, { ok: false, error: "Missing repo/file for viewed state." });
          return;
        }
        const result = markViewedSelection(viewState, repoRel, category, filePath);
        if (result.status !== 200) {
          json(res, result.status, { ok: false, error: result.error || "Failed to mark viewed state." });
          return;
        }
        json(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/viewed/unmark") {
        const viewState = resolveViewStateFromUrl(url, args);
        const payload = await readJsonRequestBody(req);
        const repoRel = String(payload && payload.repo ? payload.repo : "").trim();
        const category = String(payload && payload.category ? payload.category : "").trim();
        const filePath = String(payload && payload.file ? payload.file : "").trim();
        if (!repoRel || !filePath) {
          json(res, 400, { ok: false, error: "Missing repo/file for viewed state." });
          return;
        }
        const result = unmarkViewedSelection(viewState, repoRel, category, filePath);
        json(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/viewed/mark-bulk") {
        const viewState = resolveViewStateFromUrl(url, args);
        const payload = await readJsonRequestBody(req);
        const selectionKind = String(payload && payload.selection_kind ? payload.selection_kind : "").trim();
        const repoRel = String(payload && payload.repo ? payload.repo : "").trim();
        const category = String(payload && payload.category ? payload.category : "").trim();
        const confirmLarge = Boolean(payload && payload.confirm_large);
        if ((selectionKind !== "repo" && selectionKind !== "category") || !repoRel || (selectionKind === "category" && !category)) {
          json(res, 400, { ok: false, error: "Missing repo/category selection for bulk viewed state." });
          return;
        }
        const result = markViewedSelectionGroup(viewState, selectionKind, repoRel, category, {
          confirm_large: confirmLarge,
        });
        if (result.status !== 200) {
          json(res, result.status, { ok: false, error: result.error || "Failed to mark viewed state." });
          return;
        }
        json(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/viewed/unmark-bulk") {
        const viewState = resolveViewStateFromUrl(url, args);
        const payload = await readJsonRequestBody(req);
        const selectionKind = String(payload && payload.selection_kind ? payload.selection_kind : "").trim();
        const repoRel = String(payload && payload.repo ? payload.repo : "").trim();
        const category = String(payload && payload.category ? payload.category : "").trim();
        if ((selectionKind !== "repo" && selectionKind !== "category") || !repoRel || (selectionKind === "category" && !category)) {
          json(res, 400, { ok: false, error: "Missing repo/category selection for bulk viewed state." });
          return;
        }
        const result = unmarkViewedSelectionGroup(viewState, selectionKind, repoRel, category);
        if (result.status !== 200) {
          json(res, result.status, { ok: false, error: result.error || "Failed to unmark viewed state." });
          return;
        }
        json(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/viewed/clear") {
        const viewState = resolveViewStateFromUrl(url, args);
        const payload = await readJsonRequestBody(req);
        const scope = String(payload && payload.scope ? payload.scope : "mode").trim();
        const result = clearViewedSelections(scope, viewState);
        json(res, 200, result);
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/create-snapshot") {
        const payload = await readJsonRequestBody(req);
        const snapshotId = String(payload && payload.snapshot_id ? payload.snapshot_id : "").trim();
        const clearAfterCapture = Boolean(payload && payload.clear);
        const proc = run(args.gitSnapshotBin, buildCreateSnapshotCommand(snapshotId, clearAfterCapture), {
          encoding: "utf8",
          cwd: args.rootRepo,
        });
        if (proc.status !== 0) {
          json(res, 400, {
            ok: false,
            error: (proc.stderr || proc.stdout || "").trim() || `git-snapshot create exited with ${proc.status}.`,
          });
          return;
        }
        const createdSnapshotId = lastNonEmptyLine(proc.stdout) || snapshotId;
        if (!createdSnapshotId) {
          json(res, 500, { ok: false, error: "Create snapshot succeeded but returned no snapshot id." });
          return;
        }
        invalidateGuiCaches();
        json(res, 200, { ok: true, snapshot_id: createdSnapshotId });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/create-snapshot-default-id") {
        json(res, 200, {
          ok: true,
          suggested_snapshot_id: suggestSnapshotId(args.rootRepo, "snapshot"),
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/snapshot-rename") {
        const payload = await readJsonRequestBody(req);
        const oldSnapshotId = String(payload && payload.old_snapshot_id ? payload.old_snapshot_id : "").trim();
        const newSnapshotId = String(payload && payload.new_snapshot_id ? payload.new_snapshot_id : "").trim();
        const proc = run(args.gitSnapshotBin, ["rename", oldSnapshotId, newSnapshotId, "--porcelain"], {
          encoding: "utf8",
          cwd: args.rootRepo,
        });
        if (proc.status !== 0) {
          json(res, 400, {
            ok: false,
            error: (proc.stderr || proc.stdout || "").trim() || `git-snapshot rename exited with ${proc.status}.`,
          });
          return;
        }

        invalidateGuiCaches();
        json(res, 200, {
          ok: true,
          old_snapshot_id: oldSnapshotId,
          new_snapshot_id: newSnapshotId,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/snapshot-delete") {
        const payload = await readJsonRequestBody(req);
        const snapshotId = String(payload && payload.snapshot_id ? payload.snapshot_id : "").trim();
        const proc = run(args.gitSnapshotBin, ["delete", snapshotId], {
          encoding: "utf8",
          cwd: args.rootRepo,
        });
        if (proc.status !== 0) {
          json(res, 400, {
            ok: false,
            error: (proc.stderr || proc.stdout || "").trim() || `git-snapshot delete exited with ${proc.status}.`,
          });
          return;
        }

        invalidateGuiCaches();
        json(res, 200, {
          ok: true,
          snapshot_id: snapshotId,
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/reset-all") {
        const payload = await readJsonRequestBody(req);
        const mode = String(payload && payload.mode ? payload.mode : "").trim();
        const createSnapshotFirst = !(payload && payload.snapshot === false);
        if (mode !== "browse") {
          json(res, 400, { ok: false, error: "Reset All is only available in browse mode." });
          return;
        }

        const proc = run(args.gitSnapshotBin, ["reset-all", createSnapshotFirst ? "--snapshot" : "--no-snapshot"], {
          encoding: "utf8",
          cwd: args.rootRepo,
        });
        if (proc.status !== 0) {
          json(res, 400, {
            ok: false,
            error: (proc.stderr || proc.stdout || "").trim() || `git-snapshot reset-all exited with ${proc.status}.`,
          });
          return;
        }

        const resetOutput = String(proc.stdout || "");
        const snapshotIdMatch = createSnapshotFirst
          ? resetOutput.match(/Created auto snapshot ([^\s]+) before reset-all\./)
          : null;
        invalidateGuiCaches();
        json(res, 200, {
          ok: true,
          snapshot: createSnapshotFirst,
          snapshot_id: snapshotIdMatch ? snapshotIdMatch[1] : "",
        });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/review-presets/save") {
        const payload = await readJsonRequestBody(req);
        try {
          const presets = upsertReviewPreset(
            args.rootRepo,
            payload && payload.name,
            payload && payload.repos,
            payload && payload.default_base_ref,
            payload && payload.repo_base_overrides
          );
          json(res, 200, { ok: true, presets });
        } catch (err) {
          json(res, 400, { ok: false, error: err && err.message ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/review-presets/rename") {
        const payload = await readJsonRequestBody(req);
        try {
          const presets = renameReviewPreset(
            args.rootRepo,
            payload && payload.old_name,
            payload && payload.new_name
          );
          json(res, 200, { ok: true, presets });
        } catch (err) {
          json(res, 400, { ok: false, error: err && err.message ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/review-presets/delete") {
        const payload = await readJsonRequestBody(req);
        try {
          const presets = deleteReviewPreset(args.rootRepo, payload && payload.name);
          json(res, 200, { ok: true, presets });
        } catch (err) {
          json(res, 400, { ok: false, error: err && err.message ? err.message : String(err) });
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/open") {
        const viewState = resolveViewStateFromUrl(url, args);
        if (viewState.mode !== "compare" && viewState.mode !== "browse") {
          json(res, 400, { ok: false, error: "Primary action is only available in compare or browse mode." });
          return;
        }
        const repoRel = url.searchParams.get("repo") || "";
        const filePath = url.searchParams.get("file") || "";
        const category = url.searchParams.get("category") || "";
        if (!repoRel || !filePath) {
          json(res, 400, { ok: false, error: "Missing repo/file query parameters." });
          return;
        }

        if (viewState.mode === "compare") {
          const previewResult = comparePreview(viewState, repoRel, filePath);
          if (previewResult.status !== 200) {
            json(res, previewResult.status, { ok: false, error: previewResult.error || "Preview unavailable." });
            return;
          }
          if (previewResult.primaryActionSupported === false) {
            json(res, 200, {
              ok: false,
              error: previewResult.primaryActionError || "External diff is not available for this preview.",
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

          const snapshotFile = previewResult.snapshotFile;
          const currentFile = previewResult.currentFile;
          ensureDir(path.dirname(currentFile));
          if (!fs.existsSync(currentFile)) {
            fs.writeFileSync(currentFile, "", "utf8");
          }
          try {
            launchExternalDiff(externalDiffSpec, snapshotFile, currentFile, viewState.compareBase);
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

        const browseActionResult = resolveBrowsePrimaryAction(viewState, repoRel, category, filePath);
        if (browseActionResult.status !== 200) {
          json(res, browseActionResult.status, { ok: false, error: browseActionResult.error || "Preview unavailable." });
          return;
        }
        if (browseActionResult.primaryActionSupported === false) {
          json(res, 200, {
            ok: false,
            error: browseActionResult.primaryActionError || "Edit File is not available for this preview.",
          });
          return;
        }

        let editorSpec = null;
        try {
          editorSpec = detectEditorSpec();
        } catch (err) {
          json(res, 200, {
            ok: false,
            error: err && err.message ? err.message : String(err),
          });
          return;
        }
        if (!editorSpec) {
          json(res, 200, { ok: false, error: editorMissingMessage() });
          return;
        }

        try {
          launchEditor(editorSpec, browseActionResult.primaryActionFile);
        } catch (err) {
          json(res, 200, {
            ok: false,
            error: err && err.message ? err.message : String(err),
          });
          return;
        }
        json(res, 200, { ok: true, tool: editorSpec.label });
        return;
      }

      text(res, 404, "Not found");
    } catch (err) {
      if (isRequestAbortedError(err)) {
        if (req.url && req.url.indexOf("/api/preview") === 0) {
          try {
            const abortedUrl = new URL(req.url, "http://127.0.0.1");
            const abortedSelectionKind = normalizeSelectedKind(
              abortedUrl.searchParams.get("mode") || "",
              abortedUrl.searchParams.get("selection_kind") || "file",
              abortedUrl.searchParams.get("repo") || "",
              abortedUrl.searchParams.get("category") || "",
              abortedUrl.searchParams.get("file") || ""
            );
            if (abortedSelectionKind !== "file") {
              const abortedLimitInfo = parseAggregatePreviewLimit(abortedUrl.searchParams.get("preview_limit"));
              logAggregatePreviewEvent("aborted", {
                mode: abortedUrl.searchParams.get("mode") || "",
                selection: abortedSelectionKind,
                repo: abortedUrl.searchParams.get("repo") || ".",
                category: abortedUrl.searchParams.get("category") || "(none)",
                offset: normalizeAggregatePreviewOffset(abortedUrl.searchParams.get("preview_offset")),
                requested: abortedLimitInfo.requested,
                applied: abortedLimitInfo.applied,
              });
            }
          } catch (_parseErr) {
            // Ignore logging parse failures for abandoned preview requests.
          }
        }
        if (!res.writableEnded) {
          try {
            res.end();
          } catch (_closeErr) {
            // Ignore close failures for abandoned requests.
          }
        }
        return;
      }
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
      resolve({ server, sockets, liveRefreshTracker });
    }, reject);
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  ACTIVE_REPO_GUI_CONFIG = loadRepoGuiConfig(args.rootRepo);
  args.repoGuiConfig = ACTIVE_REPO_GUI_CONFIG;
  if (args.compareBaseExplicit !== "true" && ACTIVE_REPO_GUI_CONFIG.compareBase) {
    args.compareBase = ACTIVE_REPO_GUI_CONFIG.compareBase;
    args.initialViewState = normalizeViewState(Object.assign({}, args.initialViewState, {
      compareBase: ACTIVE_REPO_GUI_CONFIG.compareBase,
    }), args);
  }
  const resolver = new SnapshotBundleResolver(args.rootRepo, args.gitSnapshotBin);

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
    runtime.liveRefreshTracker.stop();

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
