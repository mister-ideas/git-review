# Changelog

All notable changes to this plugin. Versions follow [SemVer](https://semver.org); each release is a `vX.Y.Z` tag with a GitHub Release.

## 0.1.21 — 2026-10-22

### Fixed
- **The pane no longer resets to the first worktree and `main` on a session switch.**
  Root cause: the profile/connection atoms are briefly absent during a switch, so the
  identity sample became `[null,null]`. The reset effect read that as a different
  backend and wiped scope, comparison base and repository. A partial sample now keeps
  the last fully resolved identity; only a real profile/connection change resets.
- Test: `a partial identity is not a different backend` (red on the previous code).

## 0.1.20 — 2026-10-22

### Fixed
- **The pane no longer resets when you switch session.** Settings were keyed by
  profile + connection + focused workspace, but a window holds sessions on different
  worktrees, so every switch produced a different key - and `cwd` is not known at
  mount, so the first read missed the saved entry too. The key is now profile +
  connection only, which is as fine-grained as the host allows for state that must
  survive a switch. Scope, comparison base, repository, layout and the rest come back
  with it.
- Two tests pin the contract: the key carries no workspace segment, and a remount
  after changing scope restores scope and repository.

## 0.1.19 — 2026-10-22

Measured against a real Chromium render of the pane rather than inferred from the
source, which is how the last two rounds of layout reports were settled.

- **Each file's diff scrolls to the width of its longest line.** The scroll width was on the rows, so a row was only as wide as the view: past the first screen a change lost its background and unmodified-lines bars stopped short. The column is a grid sized `minmax(max-content, 1fr)`; rows carry no width of their own. Wrapped, the column stays the view.
- **No scrollbar band.** Hermes styles every scrollbar, which reserved a strip under each file that scrolls sideways; `.diff` and `.splitwrap` opt out, and horizontal scrolling stays available by trackpad and shift+wheel.
- **The unmodified-lines label is centred on the view** while its strip still reaches the end of the scroll, and follows the pane width live.
- **Line citation and text selection coexist.** The code keeps a text cursor and native selection; a click on a line still anchors a range and the gutter selects and drags with pointer capture, with a drag handle that has its own room in the gutter.
- **Cite inserts a real reference.** Citation went through `insertText`, which appends plain text; it now reads the draft and appends through `setDraft`, the contract that hydrates an `@line:` token into a composer chip, with `insertText` as the fallback.
- **Review next file reaches the next collapsed file**, and a file near the end of the list scrolls past the end by the missing distance so its header can reach the top.
- **The tree's churn counts sit next to their name** in files and folders, centred on the same line box.
- **Menu surfaces carry no padding**, so a pinned group label no longer shows a clipped row above it, and the branch label sits outside the scrolling list.

## 0.1.18 — 2026-10-20

Everything since 0.1.16, from reports against a running pane: the fold geometry,
the three pickers, and the menu surface.

- **One bar per untouched run, in the right place.** A gap bar was queued and flushed on the following row, so it landed one row late: the run it described stayed open (lines jumped with no expander) and the bar appeared between two consecutive lines. It is emitted at the hunk boundary now, and a run that computes to nothing produces no bar.
- **A run after the last change folds to the file end** instead of keeping a tail, which had put the expander in the middle of that final run.
- **One control per bar.** The bar already names the run, so the numeric buttons repeated it: `34 unmodified lines ⌃ 20 ⌄ 20 all (34)` is now `34 unmodified lines ⌃ ⌄ all`, and gap bars show a single chevron.
- **The chevrons are icons.** `⌃`/`⌄` were text glyphs whose line-box metrics sat off-centre in a padded button.
- **The end-of-file bar names its length** when the pane knows it: the backend counts the worktree file (`total_lines`), so a bounded run says `N unmodified lines` and one click reveals exactly that. Staged ranges and commits keep "Show more lines below" rather than a count that could be wrong.
- **Menu group headers are opaque.** `background: inherit` resolved to transparent inside the scroll wrapper — Radix paints the surface on the content element — so the first row showed through the header.
- **The three pickers say one thing each.** The branch menu listed `main` and `origin/main` as two rows; it lists each branch once, checked-out first. The base is a comparison target, named plainly (`main`), with "against X" only in sentences, as Cursor does. The commit list shows `Commits · 3/41 against main` and its Select all/Clear reflect the selection.
- **No silent fallback to whole history.** A branch with nothing since its base says so; a stale `origin/HEAD` can no longer define the fork point (main/master win).
- **Scope-named empty states** ("No staged changes", "No changes in the last agent turn") instead of one generic line.
- **Search covers the changed lines**, not only file paths.
- **Review next file** in the toolbar, stepping through the changed files.
- Fixes a change-signature that read a field sections do not have, so a collapsed file whose edits changed went unnoticed.

## 0.1.16 — 2026-10-20

The review survives a reload, and a file that changes opens itself.

- **Collapse state is saved with the pane settings** (per workspace) instead of resetting on every mount, so a review in progress comes back the way it was left.
- **A file whose changes change while it is collapsed opens itself**, and so does a file that appears for the first time. The first observation of a scope is not a change, so nothing pops open on load and an unchanged collapsed file stays collapsed.
- Fixes a first-observation bug the new test caught: the pane records the diff it is showing, and recording an empty list before the diff loads made the first real diff look like every file was new — which would have opened collapsed files on every load.

## 0.1.15 — 2026-10-20

Pane interactions, from reports against a running pane. Two pull requests.

- **One expander per hidden run.** A gap bar (lines outside the patch, fetched on demand) and an in-patch fold that touch with no change between them describe the same run; they stacked two "N unmodified lines" controls with nothing between them. They merge into one bar whose range covers both, in both layouts.
- **A gap bar reveals its whole run in one click.** The label already carried the true count, but a click fetched 20 lines and left a separate "all" control to ask for the rest. The step is gone for gap bars: one control shows exactly as many lines as the label promised, bounded by the next change or the file edge — which is what the run is. The bar surface no longer changes colour on hover, where it promised a click that only the small step button acted on.
- **No count when the selection is everything.** With all commits selected — the default — the navigator showed a position counter and the scope button a churn total, both describing the whole history rather than a reviewable selection.
- **Pane settings are restored per workspace** — the key is profile + connection + focused workspace — instead of one global set, with a fallback to the key older versions wrote. Scope and repository are deliberately not stored: they follow the workspace and the agent. Per chat session is not available: a desktop plugin is not given the focused session id (the loader's allowlist exposes no such atom), so several chats on one workspace share one set of pane settings.
- **Selection has a way out.** Clicking the selected line again, or any click that is not on a code line, leaves selection mode. A selection spanning a hidden run cites the exact range, covered by a test that reveals a file, hides its context, selects across the hidden run and asserts the ref.
- **The file list resizes.** It keeps its default share of the pane until the divider is dragged; double-click resets, the width is stored with the other pane settings, the diff column reflows rather than overflowing, and the divider hides once the narrow layout stacks the two.
- **Ceilings come from the hosts people compare against rather than invented numbers.** GitHub lists at most 250 commits between two revisions and refuses a diff past 3,000 lines; GitLab renders 5,000 diff lines before collapsing the rest. The commit list is 250 (was 200) and one expansion reads 5,000 lines (was 2,000). The 8 MiB whole-diff ceiling is ours.
- **Menu surfaces keep their styling.** A menu portals to `document.body`, outside the scope the stylesheet used, so the churn colours, group headers and scroll cap silently stopped applying; menu content now carries the menu surface class as a second scope. Menu rows share one label slot too — a row passing its children as a bare array rendered its label 8 px left of its neighbours.
- `$activeSessionId` is not importable by a plugin (the loader's allowlist rejects it, which the desktop smoke harness caught), so pane settings are scoped to state a plugin may read.

## 0.1.14 — 2026-10-19

Commit identity clean-up. No change to the plugin itself.

- Repository history was rewritten so every commit and tag uses the maintainer's GitHub noreply identity only; two stray addresses (an old agent identity and a personal mailbox) are gone from branches and tags. Release 0.1.11, 0.1.12 and 0.1.13 were withdrawn with it: their tags pointed at the old history and, being immutable, could only be removed with the release. Their contents are in 0.1.14.
- CI now fails a change that introduces one of those addresses, or that authors a commit as `mister-ideas` with any other address (new `Commit identities` step in the `Hygiene` job).

## 0.1.13 — 2026-10-19

Security hardening from the Hermes catalog review.

- A repository is now treated as untrusted input. Every `git` call overrides `core.fsmonitor`, `core.hooksPath` and `log.showSignature`, and `status` and worktree `diff` blank the clean, smudge and process filter drivers defined in the repository's own config. Before this, opening a checkout whose `.git/config` named a `core.fsmonitor` program or a clean filter ran that program on the 5-second poll. Two regression tests use marker-writing programs and fail on the previous code.
- Config is read through core's `hermes_yaml`, so a stock install no longer needs PyYAML for the dashboard routes to import. `requires_hermes` is now `>=0.21.6`, the release that introduced it.

## 0.1.12 — 2026-10-19

README title is now `git-review for Hermes Desktop`, matching usage-guard's `usage-guard for Hermes Agent`. No change to the plugin itself.

## 0.1.11 — 2026-10-19

Repository-settings pass with usage-guard. No change to the plugin itself.

- Workflows pin every action to a full commit SHA (with the tag in a comment); Dependabot keeps the pins current.
- Releases are immutable: assets and tags cannot change once published. The release workflow already creates the release and its zip in one step, so it is unaffected.
- `.github/CODEOWNERS`, `.gitattributes` (LF line endings, binary assets) and one shared `.gitignore` layout.
- Repository homepage, wiki and projects settings now match usage-guard.

## 0.1.10 — 2026-10-19

Consistency pass with usage-guard: same README skeleton, same asset names, same manifest layout.

- README: the title is the plugin name; the banner's alt text follows the same pattern as usage-guard's; install notes the CLI way to enable (`hermes plugins enable git-review`); removal uses `hermes plugins remove`; the Development section points at CONTRIBUTING, SECURITY and CHANGELOG.
- New `docs/social-preview.png` (1280×640), drawn from the same art as the banner. Upload it under the repository's Settings → Social preview.

## 0.1.9 — 2026-10-19

Catalog-readiness pass, compared against the most-starred Hermes plugins.

- README: new **Updating** section (`check-updates`, `update`, and the Desktop-on-another-machine case) and two troubleshooting rows (remote Desktop, shallow clones).
- SECURITY.md: supported versions and what to expect after a report. Private vulnerability reporting is now enabled on the repository, as the policy says.
- Issue and PR templates no longer point at the removed `npm run test:layout`; CONTRIBUTING describes commit navigation as in scope and what the desktop tests do and do not prove.
- CHANGELOG opens with its versioning policy.

## 0.1.8 — 2026-10-19

- README's Limits section no longer says older history is omitted: older commits page in on demand.

## 0.1.7 — 2026-10-19

- The banner now shows Hermes himself (winged helmet, caduceus, winged sandals) holding a diff tablet, at the catalog's 1200×600 (2:1) size.

## 0.1.6 — 2026-10-19

- New catalog banner (`docs/banner.jpg`, 2:1) and a landing image at the top of the README.
- README describes the current Commits model (since the default branch, whole history, commit-by-commit browsing, branch menu), the real fold behaviour, and what to answer to Hermes's Node-dependencies prompt.

## 0.1.5 — 2026-10-18

- The backend now sends exactly 3 lines of context around every change (`git diff -U3`, was 40). Show more lines therefore starts from the real gap: the bar above and between changes counts the lines actually hidden, and the bar below appears only when the file continues past the last change.
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

## 0.1.4 — 2026-10-16

README pass, compared against the most-starred Hermes plugin READMEs. Adds a
"Why this exists" section, a "What happens on first install" section, and the
`hermes plugins adopt` path for a self-cloned directory. Fixes a wrong install
command: `hermes plugins install` takes a catalog name, a Git URL or
`owner/repo`, so the documented filesystem path never worked. Documentation only.
