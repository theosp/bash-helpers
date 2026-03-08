# Playwright UI Tests for git-snapshot

## Prerequisites

1. Node.js 20 via `nvm`
   ```bash
   nvm use 20
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
        └── prepare-env.bash
```

## Notes

- The runner mirrors the `txtd-server` category-based Playwright flow.
- Category setup happens in `prepare-env.bash`, which builds a real `git-snapshot compare --gui` fixture and exports the GUI URL for Playwright.
- When a category defines `prepare-env.bash`, category-level runs prepare an isolated fixture per spec so `./run-tests.sh general-ui` and `./run-tests.sh general-ui 02` use matching setup semantics.
- Automated `01` coverage stubs the external diff tool via test-only env vars so the suite can verify the selected file pair without opening a real app.
- Automated `03` coverage exercises real tool auto-detection with fake `meld`, `opendiff`, and `code` binaries on `PATH`, including the no-tool error path.
- Manual mode supports interactive category selection with arrow keys or number input, remembers the last selected category, opens the compare GUI in your browser, keeps the session alive until `Ctrl+C`, and uses the real external diff tool detection path.
- `tests/git-snapshot/test-compare-gui-suite.sh`, `tests/git-snapshot/test-compare-gui-playwright.sh`, `tests/git-snapshot/test-compare-gui-open.sh`, and `tests/git-snapshot/test-compare-gui-open-autodetect.sh` remain compatibility delegates for the existing shell test suite.
