(() => {
  function diffSelectionText() {
    const selection = window.getSelection();
    return selection ? String(selection.toString() || "") : "";
  }

  function selectionActionState() {
    const contextMenu = document.getElementById("diffSelectionContextMenu");
    return {
      menuVisible: Boolean(contextMenu && !contextMenu.classList.contains("hidden")),
    };
  }

  function diffSelectionDebugState() {
    const debugState = window.__gitSnapshotDiffSelectionDebug && typeof window.__gitSnapshotDiffSelectionDebug === "object"
      ? window.__gitSnapshotDiffSelectionDebug
      : {};
    return {
      lastSelectionCapture: debugState.lastSelectionCapture || null,
      lastClipboardFailure: debugState.lastClipboardFailure || null,
      events: Array.isArray(debugState.events) ? debugState.events.slice() : [],
    };
  }

  function report() {
    const state = {
      selectionText: diffSelectionText(),
      selectionLength: diffSelectionText().length,
      action: selectionActionState(),
      debug: diffSelectionDebugState(),
    };
    console.log("[git-snapshot] diff-selection manual report", state);
    return state;
  }

  function printGuide() {
    console.log(
      [
        "[git-snapshot] Safari / trackpad diff-selection guide",
        "1. Drag-select multiple diff lines so the gutter is co-selected.",
        "2. Confirm the custom menu still opens, then run __gitSnapshotDiffSelectionManual.report().",
        "3. Reopen the custom menu with the keyboard context-menu shortcut and confirm the same menu opens.",
        "4. Open Ask, copy a prompt, remove a recent instruction, then run report() again.",
        "5. Resize to a narrow viewport and confirm selection still works even if the browser falls back to native text-selection UI.",
      ].join("\n")
    );
  }

  function highlightTargets() {
    const diff = document.getElementById("diff");
    [diff].forEach((node) => {
      if (!node) {
        return;
      }
      const previousOutline = node.style.outline;
      const previousOutlineOffset = node.style.outlineOffset;
      node.style.outline = "2px solid #0d8a5f";
      node.style.outlineOffset = "2px";
      window.setTimeout(() => {
        node.style.outline = previousOutline;
        node.style.outlineOffset = previousOutlineOffset;
      }, 1500);
    });
  }

  window.__gitSnapshotDiffSelectionManual = {
    diffSelectionText,
    diffSelectionDebugState,
    highlightTargets,
    printGuide,
    report,
    selectionActionState,
  };

  console.log(
    "[git-snapshot] Diff-selection Safari/trackpad helper loaded. Run __gitSnapshotDiffSelectionManual.printGuide() to start."
  );
})();
