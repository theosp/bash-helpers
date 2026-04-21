# Diff Selection Touch-Adjacent Checklist

Use this checklist when verifying the diff-selection `Copy` / `Ask` workflow on trackpads, tablets, or browsers where text selection is likely to co-select gutters or rely on long-press interactions.

## Setup

1. Start the GUI in manual mode:
   ```bash
   ./lib/git-snapshot/ui-tests/run-tests.sh --manual general-ui 04
   ```
   Optional WebKit smoke:
   ```bash
   GIT_SNAPSHOT_UI_TEST_BROWSER=webkit ./tests/git-snapshot/test-shared-gui-controls.sh "shared browser helpers bootstrap into the embedded page script|diff selection real mouse drag across structured diff lines preserves newlines|diff selection works against real inspect and review previews"
   ```
2. Open the shared GUI and switch to a preview that shows a structured diff.
3. Keep the browser devtools console open so you can spot clipboard or selection warnings.
4. Optional console helper:
   - paste the contents of `tests/manual/diff-selection-safari-trackpad-helper.js` into the browser console
   - run `__gitSnapshotDiffSelectionManual.printGuide()` once
   - run `__gitSnapshotDiffSelectionManual.report()` after each step if you want a structured snapshot of selection state and debug timing

## Checks

1. Drag-select multiple diff lines with a trackpad so the browser also highlights the gutter.
   Expected:
   - the custom selection menu is still available
   - `Copy` preserves line breaks
   - copied text excludes line-number gutter text

2. Select text only inside preview-body content, then open the custom selection menu with right-click or the keyboard context-menu shortcut.
   Expected:
   - the same custom menu opens
   - `Ask` captures the exact selected text

3. Drag the selection so it starts in the diff body and extends into preview headers or outside `#diff`.
   Expected:
   - the browser's native context menu wins
   - the custom selection menu stays hidden

4. Open `Ask`, edit the instruction, copy the prompt, then remove the saved instruction from the dropdown.
   Expected:
   - the instruction is removed immediately with no confirmation
   - the current textarea value stays intact

5. On a narrow viewport or touch emulator, create a selection and verify the browser still offers a workable text-selection path.
   Expected:
   - desktop browsers can still open the custom menu from right-click or `Shift+F10`
   - touch-first environments that do not expose a context-menu gesture fall back to the browser/native text-selection UI without breaking selection
   - `Copy Prompt` still preserves newline-separated selected text
