# Playwright UI Tests for git-snapshot

## Prerequisites

1. Node.js 22.22.0 available either on `PATH` or via `nvm`
   ```bash
   node -v
   nvm install 22.22.0
   ```
2. Playwright Chromium
   ```bash
   ./run-tests.sh general-ui 00
   ```
   The runner installs local dependencies and Chromium on first use.

## Running Tests

Use the root delegate runner:

```bash
# List categories and tests
./run-tests.sh --list

# Start manual mode with interactive category picker
./run-tests.sh --manual

# Start manual mode for a category
./run-tests.sh --manual general-ui

# Start manual mode for one test fixture
./run-tests.sh --manual general-ui 00

# Run all categories
./run-tests.sh --all

# Run the general UI suite
./run-tests.sh general-ui

# Run one test file
./run-tests.sh general-ui 00
./run-tests.sh general-ui 01
./run-tests.sh general-ui 02

# Run one test file with a Playwright grep
./run-tests.sh general-ui 00 "scroll"

# Run with a visible browser
./run-tests.sh --headed general-ui 00

# Run with Playwright UI
./run-tests.sh --ui general-ui
```

## Structure

```text
lib/git-snapshot/ui-tests/
├── run-tests.sh
├── playwright.config.cjs
└── tests/
    ├── README.md
    ├── category-descriptions.conf
    ├── helpers/
    └── general-ui/
        ├── 00-compare-gui-scroll.spec.cjs
        ├── 01-compare-gui-open-external.spec.cjs
        ├── 02-compare-gui-load-error.spec.cjs
        ├── 03-compare-gui-open-external-autodetect.spec.cjs
        ├── 04-shared-gui-controls.spec.cjs
        ├── 05-inspect-gui-preview.spec.cjs
        ├── 06-invalid-external-diff.spec.cjs
        ├── 07-shared-gui-path-shapes.spec.cjs
        └── prepare-env.bash
```

## Notes

- The runner mirrors the `txtd-server` category-based Playwright flow.
- The runner accepts a matching `node` already on `PATH`, and otherwise auto-selects the pinned runtime from the repo `.nvmrc` via `nvm`.
- Category setup happens in `prepare-env.bash`, which builds a real shared `git-snapshot` GUI fixture (launched via `compare --gui`) and exports the GUI URL for Playwright.
- When a category defines `prepare-env.bash`, category-level runs prepare an isolated fixture per spec so `./run-tests.sh general-ui` and `./run-tests.sh general-ui 02` use matching setup semantics.
- Automated `01` coverage exercises the explicit external diff command-template override with `$SOURCE` / `$TARGET` placeholders so unusual launch shapes stay supported without opening a real app.
- Automated `03` coverage exercises real tool auto-detection with fake `meld`, `kdiff3`, `opendiff`, `bcompare`, and `code` binaries on `PATH`, including the no-tool error path.
- Automated `04` coverage exercises the shared-shell controls: mode switching, snapshot picking, and compare visibility auto-refresh.
- `tests/git-snapshot/test-shared-gui-controls.sh` runs the `04` shared-controls coverage in grouped sub-runs so the largest GUI surface does not depend on one long-lived server process.
- The grouped shared-controls wrapper self-validates its grep shards against the real `04` test titles before it runs, so title drift cannot silently drop coverage.
- The grouped shared-controls wrapper also assigns each shard its own GUI port window by default. Override the base with `GIT_SNAPSHOT_UI_TEST_GROUP_PORT_START=<port>` if you need a different band while debugging.
- The no-arg shared-controls wrapper also runs a focused WebKit diff-selection smoke after the Chromium shards, so the selected-text path is covered in both browser engines by default.
- Automated `05` coverage exercises inspect-mode previews, category toggles, and clean-repo visibility via `all repos`.
- Automated `06` coverage exercises invalid forced external-diff overrides and verifies the GUI stays up with an in-band API error.
- Automated `07` coverage exercises compare/inspect API handling for trailing-space filenames.
- Touch-adjacent manual spot checks for diff-selection actions live in `tests/manual/diff-selection-touch-checklist.md`.
- A browser-console helper for Safari/trackpad manual verification lives in `tests/manual/diff-selection-safari-trackpad-helper.js`.
- Set `GIT_SNAPSHOT_UI_TEST_BROWSER=webkit` to run focused diff-selection smoke coverage against Playwright WebKit instead of Chromium.
- Set `PLAYWRIGHT_BROWSERS_PATH=/custom/cache/dir` if you want the runner to install and reuse Playwright browser bundles outside the default local `.ms-playwright` cache.
- Set `GIT_SNAPSHOT_UI_TEST_STRICT_FIXTURE_RECOVERY=1` if you want the `04` shared-controls suite to fail whenever fixture lock-recovery or rollback paths were needed during the run.
- Set `GIT_SNAPSHOT_UI_TEST_FIXTURE_RECOVERY_FAIL_THRESHOLD=<n>` if you want the grouped shared-controls wrapper to fail once the combined fixture-recovery total across shards exceeds a threshold, even when strict per-shard mode is off.
- Manual mode supports interactive category selection with arrow keys or number input, remembers the last selected category, opens the shared GUI in your browser, and keeps the session alive until `Ctrl+C`.
- Manual mode stubs external diff launching by default so test runs do not open real desktop diff tools.
- Opt in to real external diff launching during manual runs with `GIT_SNAPSHOT_UI_TESTS_ALLOW_REAL_EXTERNAL_DIFF=1`.
- `tests/git-snapshot/test-compare-gui-suite.sh`, `tests/git-snapshot/test-compare-gui-playwright.sh`, `tests/git-snapshot/test-compare-gui-open.sh`, and `tests/git-snapshot/test-compare-gui-open-autodetect.sh` remain compatibility delegates for the existing shell test suite.
