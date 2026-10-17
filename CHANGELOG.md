# Changelog

## 0.1.4 — 2026-10-16

README pass, compared against the most-starred Hermes plugin READMEs. Adds a
"Why this exists" section, a "What happens on first install" section, and the
`hermes plugins adopt` path for a self-cloned directory. Fixes a wrong install
command: `hermes plugins install` takes a catalog name, a Git URL or
`owner/repo`, so the documented filesystem path never worked. Documentation only.

## Unreleased

- Detached HEAD now shows `HEAD@<sha>` as the branch label and skips the PR lookup.
- Added an end-to-end suite (`npm run test:e2e`) that drives the pane against the real backend and real git repositories; removed the screenshot/media scripts.
- Narrow docks (container ≤480px): the file tree moves below the diff and the toolbar wraps to two rows, so scope, repository and branch labels stay readable instead of truncating to icons.
- Selected lines keep a visible highlight on added/removed rows (it was hidden under the diff colour); checkmark columns in the scope, commit, display and filter menus now reserve their width so labels align whether or not a row is checked.
- Test harness: paints the pane on `--ui-surface-background` and scans the desktop sources for Tailwind utilities, so screenshots match the real app (no blue tint, correctly sized icons, styled menus). All README screenshots, clips and the banner were re-rendered from the real pane.

## 0.1.3 — 2026-10-16

Media and fixes. The repository gains the screenshots, motion clips and catalog
banner in `docs/`, all rendered from the real pane by `npm run media`, which
drives every feature and asserts what it shows.

Fixed while testing those features:

- Split layout never rendered the out-of-patch gap bars, so the lines above the
  first hunk and below the last could not be expanded in split view.
- Checking commits closed the scope menu on every toggle, so a multi-commit
  selection cost one reopen per commit.
- The empty commits state pointed at a "Pick commits" control that does not
  exist; it now names the scope menu.

## 0.1.2 — 2026-10-16

Documentation release: no plugin behavior changed. The README now opens with what the pane looks like and covers install, how to open it, a usage walkthrough, and where to report and read releases. `npm run shots` renders those images through the layout harness against a realistic dataset, so they stay in step with the pane.

## 0.1.1 — 2026-10-16

Open-source scaffolding release: no plugin behavior changed. The repository gains what a public project is expected to carry — a code of conduct, a security policy, issue and pull-request templates, Dependabot for the workflow actions and test-only npm packages, README badges — and CONTRIBUTING becomes the single source of truth for reporting, scope and releases.

## 0.1.0 — 2026-10-16

First release: a read-only Git review pane for Hermes Desktop.

### Pane

- Five scopes: Last agent turn, Uncommitted, Staged, Unstaged, and a multi-select Commits view (up to 200 loaded commits).
- Last agent turn snapshots `HEAD` and the untracked file list when the focused session goes busy, then diffs against that baseline.
- Unified and split layouts (split always wraps), whitespace filtering, and GitHub-style folding of unchanged lines with ↑20 / ↓20 / all expanders, including above the first hunk and below the last.
- A right-hand file tree with per-file churn, search, and Deleted / Test filters.
- Line citations into the composer (`@line:` references) by click-range or drag, and file drag into the composer. Never sends automatically.

### Agent tool

- `git_review_select` points the pane at a repository and scope after validating that the diff resolves.

### Reliability

- Repository discovery decides on a `.git` stat per directory and asks git only for the canonical root of an actual repository, and only when the path contains a symlink.
- Authorization is memoized for 30 s, keyed on the profile home, `config.yaml`, the session workspaces and the latest agent selection.
- The branch label is read from `HEAD` rather than spawning git, and subprocesses launch through `posix_spawn`.
- `/worktrees` over 69 repositories: from >180 s to 0.59 s cold and 0.01 s warm.
