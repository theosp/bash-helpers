function normalizeSelectedKindShared(mode, rawKind, selectedRepo, selectedCategory, selectedFile) {
  const normalizedMode = String(mode || "").trim();
  const kind = String(rawKind || "").trim();
  const requiresCategory = normalizedMode === "browse" || normalizedMode === "inspect";
  const hasRepo = Boolean(selectedRepo);
  const hasCategory = Boolean(selectedCategory);
  const hasFile = Boolean(selectedFile);
  const hasScopedFile = hasFile && (!requiresCategory || (hasRepo && hasCategory));

  if (kind === "file" && hasScopedFile) {
    return "file";
  }
  if (kind === "category" && requiresCategory && hasRepo && hasCategory) {
    return "category";
  }
  if (kind === "repo" && hasRepo) {
    return "repo";
  }
  if (hasScopedFile) {
    return "file";
  }
  if (requiresCategory && hasRepo && hasCategory) {
    return "category";
  }
  if (hasRepo) {
    return "repo";
  }
  return "";
}

function buildRowIdentityKeyShared(mode, repoRel, category, filePath) {
  return JSON.stringify([
    String(mode || ""),
    String(repoRel || ""),
    String(category || ""),
    String(filePath || ""),
  ]);
}

function buildSelectionIdentityKeyShared(mode, kind, repoRel, category, filePath) {
  return JSON.stringify([
    String(mode || ""),
    String(kind || ""),
    String(repoRel || ""),
    String(category || ""),
    String(filePath || ""),
  ]);
}

function buildSelectionFallbackSequenceShared(mode, rawKind, selectedRepo, selectedCategory, selectedFile) {
  const normalizedMode = String(mode || "").trim();
  const requiresCategory = normalizedMode === "browse" || normalizedMode === "inspect";
  const selectionKind = normalizeSelectedKindShared(
    normalizedMode,
    rawKind,
    selectedRepo,
    selectedCategory,
    selectedFile
  );
  const repo = String(selectedRepo || "");
  const category = String(selectedCategory || "");
  const file = String(selectedFile || "");
  const seen = new Set();
  const candidates = [];

  function pushCandidate(kind, nextRepo, nextCategory, nextFile) {
    const normalizedKind = normalizeSelectedKindShared(
      normalizedMode,
      kind,
      nextRepo,
      nextCategory,
      nextFile
    );
    if (!normalizedKind) {
      return;
    }
    const key = [
      normalizedKind,
      String(nextRepo || ""),
      requiresCategory ? String(nextCategory || "") : "",
      normalizedKind === "file" ? String(nextFile || "") : "",
    ].join("\0");
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push({
      selection_kind: normalizedKind,
      repo: String(nextRepo || ""),
      category: requiresCategory && (normalizedKind === "file" || normalizedKind === "category")
        ? String(nextCategory || "")
        : "",
      file: normalizedKind === "file" ? String(nextFile || "") : "",
    });
  }

  if (selectionKind === "file") {
    pushCandidate("file", repo, category, file);
    if (requiresCategory) {
      pushCandidate("category", repo, category, "");
    }
    pushCandidate("repo", repo, "", "");
    return candidates;
  }

  if (selectionKind === "category") {
    pushCandidate("category", repo, category, "");
    pushCandidate("repo", repo, "", "");
    return candidates;
  }

  if (selectionKind === "repo") {
    pushCandidate("repo", repo, "", "");
    return candidates;
  }

  if (requiresCategory && repo && category) {
    pushCandidate("category", repo, category, "");
  }
  if (repo) {
    pushCandidate("repo", repo, "", "");
  }
  if (file) {
    pushCandidate("file", repo, category, file);
  }
  return candidates;
}

function buildPreviewSelectionGroupsFromCollections(mode, rows, categoryRows) {
  const normalizedMode = String(mode || "");
  const fileRows = Array.isArray(rows) ? rows : [];
  const summaryRows = Array.isArray(categoryRows) ? categoryRows : [];
  const rowsByRepo = new Map();
  const rowsByRepoCategory = new Map();
  const categorySummaryByRepoCategory = new Map();
  const groupKey = (repoRel, category = "") => `${String(repoRel || "")}\0${String(category || "")}`;

  for (const row of fileRows) {
    const repoRel = String(row && row.repo ? row.repo : "");
    const category = String(row && row.category ? row.category : "");
    if (!rowsByRepo.has(repoRel)) {
      rowsByRepo.set(repoRel, []);
    }
    rowsByRepo.get(repoRel).push(row);
    if (normalizedMode === "browse" || normalizedMode === "inspect") {
      const repoCategoryKey = groupKey(repoRel, category);
      if (!rowsByRepoCategory.has(repoCategoryKey)) {
        rowsByRepoCategory.set(repoCategoryKey, []);
      }
      rowsByRepoCategory.get(repoCategoryKey).push(row);
    }
  }

  if (normalizedMode === "browse" || normalizedMode === "inspect") {
    for (const row of summaryRows) {
      categorySummaryByRepoCategory.set(
        groupKey(row && row.repo ? row.repo : "", row && row.category ? row.category : ""),
        row
      );
    }
  }

  return {
    rowsByRepo,
    rowsByRepoCategory,
    categorySummaryByRepoCategory,
  };
}

function normalizeLineBreaksShared(text, carriageReturnChar = "\r", newlineChar = "\n") {
  return String(text || "")
    .split(String(carriageReturnChar || "\r") + String(newlineChar || "\n")).join(String(newlineChar || "\n"))
    .split(String(carriageReturnChar || "\r")).join(String(newlineChar || "\n"));
}

function structuredDiffSelectionTextFromContainerShared(container, options) {
  if (!container || typeof container.querySelectorAll !== "function") {
    return "";
  }
  const selectionOptions = options && typeof options === "object" ? options : {};
  const newlineChar = String(selectionOptions.newlineChar || "\n");
  const normalizeLineBreaks = typeof selectionOptions.normalizeLineBreaks === "function"
    ? selectionOptions.normalizeLineBreaks
    : ((value) => normalizeLineBreaksShared(value, selectionOptions.carriageReturnChar, newlineChar));
  const rows = Array.from(container.querySelectorAll(".diff-line"));
  if (rows.length > 0) {
    return rows.map((row) => {
      const codeTexts = Array.from(row.querySelectorAll(".diff-code")).map((node) => {
        return normalizeLineBreaks(String(node.textContent || ""));
      });
      return codeTexts.join("");
    }).join(newlineChar);
  }
  const codeNodes = Array.from(container.querySelectorAll(".diff-code"));
  if (codeNodes.length > 0) {
    return codeNodes.map((node) => normalizeLineBreaks(String(node.textContent || ""))).join(newlineChar);
  }
  return "";
}

function maximumBacktickFenceLengthShared(text, backtickChar = "`") {
  const matches = String(text || "").match(new RegExp(String(backtickChar || "`") + "+", "g")) || [];
  return matches.reduce((maxLength, match) => Math.max(maxLength, String(match || "").length), 0);
}

function fencedCodeBlockForTextShared(text, options) {
  const fenceOptions = options && typeof options === "object" ? options : {};
  const sourceText = String(text || "");
  const backtickChar = String(fenceOptions.backtickChar || "`");
  const newlineChar = String(fenceOptions.newlineChar || "\n");
  const fence = backtickChar.repeat(Math.max(3, maximumBacktickFenceLengthShared(sourceText, backtickChar) + 1));
  return fence + newlineChar + sourceText + newlineChar + fence;
}

function buildAskPromptTextShared(instruction, selectedText, options) {
  const promptOptions = options && typeof options === "object" ? options : {};
  const normalizeInstruction = typeof promptOptions.normalizeInstruction === "function"
    ? promptOptions.normalizeInstruction
    : ((value) => String(value || "").trim());
  const newlineChar = String(promptOptions.newlineChar || "\n");
  const safeInstruction = normalizeInstruction(instruction) || String(promptOptions.defaultInstruction || "");
  return safeInstruction
    + newlineChar
    + newlineChar
    + fencedCodeBlockForTextShared(String(selectedText || ""), {
      backtickChar: promptOptions.backtickChar,
      newlineChar,
    });
}

const gitSnapshotCompareGuiShared = {
  buildAskPromptTextShared,
  buildRowIdentityKeyShared,
  buildSelectionIdentityKeyShared,
  normalizeSelectedKindShared,
  normalizeLineBreaksShared,
  buildSelectionFallbackSequenceShared,
  buildPreviewSelectionGroupsFromCollections,
  structuredDiffSelectionTextFromContainerShared,
};

if (typeof globalThis === "object" && globalThis) {
  globalThis.__gitSnapshotCompareGuiShared = gitSnapshotCompareGuiShared;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = gitSnapshotCompareGuiShared;
}
