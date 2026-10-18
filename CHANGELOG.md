# Changelog

## 0.1.4 — 2026-10-16

README pass, compared against the most-starred Hermes plugin READMEs. Adds a
"Why this exists" section, a "What happens on first install" section, and the
`hermes plugins adopt` path for a self-cloned directory. Fixes a wrong install
command: `hermes plugins install` takes a catalog name, a Git URL or
`owner/repo`, so the documented filesystem path never worked. Documentation only.

## Unreleased

- Show more lines: the bar now offers the real remaining count (`⌃ 7`, not always 20), the lines above the first change load nearest-first (they used to load from line 1 of the file), and no "below" bar appears when the file already ends inside the diff.
- Menus have one job each: the Commits dropdown chooses which commits (since the default branch / whole history) and picks them; the branch dropdown only lists branches to compare against.
- Detached HEAD now shows `HEAD@<sha>` as the branch label and skips the PR lookup.
- Narrow docks (container ≤480px): the file tree moves below the diff and the toolbar wraps to two rows, so labels stay readable.
- Selected lines keep a visible highlight on added/removed rows; checkmark columns in menus reserve their width so labels align.
- File rows without hunks now say why (renamed from X, binary changed, empty file added, mode change, whitespace-only); renamed files get the rename icon; a search with no match shows "No files match…"; the search box reports hidden-by-filter files and the filter button highlights when filters are on; the backend-down state no longer repeats its message; a first line click shows a "click another line to finish the range" hint.
- Commits scope now defaults to the commits on the current branch since it left the default branch (not the whole history); the branch menu no longer lists the bare `origin` ref and is labelled read-only; the toolbar button flips to "Expand all" once everything is collapsed.
- Performance: polled diffs keep the previous reference when unchanged (no re-render every 5 s), parsed diff rows are cached per file, a failed refresh keeps the last good diff instead of blanking the pane, and polling pauses while the window is hidden.
- All dropdowns (scope, commit actions, Refresh, repo, branch) reserve the same check column, so icons and labels align whether or not a row is checked.
- Branch menu now picks what Commits compares against (the first two rows are "Only since <default branch>" and "Whole history of this branch", then a separate "Or only since another branch" list); clicking "all" on any fold or gap bar opens the entire file (every gap of that file loads), and "Hide all" folds it back.
- Commits: new "Whole history of this branch" base, "Load older commits" paging past the 200 cap (`/commits?skip=&all=`), and "Browse commit by commit" with ◀ ▶ and a commit header (sha, subject, author, date, n/total).
- Repository now ships only user-facing media and the offline test suites run by CI; browser, E2E and screenshot tooling were removed.
