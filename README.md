# git-review for Hermes Desktop

Read-only Git review pane for trusted Hermes workspaces and configured repositories. Supports unstaged, staged, uncommitted, branch versus base, single commit, selected commits, and two-/three-dot ranges. Includes grouped repository discovery, branch inspection without checkout, file search, Deleted/Test filters, whitespace filtering, local PR/MR lookup, and unified/split layouts.

**Unpublished development draft.** Unit/integration checks and an isolated Chromium harness exercise the actual installed Hermes UI components and stylesheet. Browser host services and API fixtures are mocked; this is not certification of every live Electron installation.

## Requirements

Hermes Agent >=0.21.3 with Desktop and the plugin dashboard router; Git on PATH. Optional locally authenticated `gh`/`glab` enables PR/MR lookup. No credentials are supplied by this plugin. It never fetches remotes, checks out branches, stages files, or changes repository content.

## Configuration and discovery

Discovery uses trusted profile/session workspace records, explicitly configured `repos`/`roots`, and the latest validated agent selection. HTTP callers cannot authorize a repository by providing its own `cwd`.

In Settings → Plugins → git-review, configure newline-separated absolute repository paths in `repos` or parent directories in `roots`. Discovery is recursively bounded; do not configure a whole home directory unnecessarily. Settings are non-secret and belong in `plugins.entries.git-review.settings`, not environment credentials. No setup-specific paths are embedded in this plugin.

The agent tool `git_review_select` accepts `repo`, `scope`, `ref`, `base`, `path`, and `ignore_ws`. It validates the diff before sending a profile-scoped SQLite selection request. The pane skips a preexisting request on mount, then applies new requests; its cursor resets when profile/backend identity changes.

## Pane behavior

- All changed files and architecture folders start expanded. Per-file collapse survives live diff polling; the file list is on the right and its visibility persists.
- Word wrap responds to the diff area's width. Split layout pairs changed lines and pads unequal replacement groups, keeping wrapped rows aligned; split always wraps (the switch is disabled there).
- Git metadata rows (diff --git, index, ---/+++, mode/rename lines) are never rendered; +/- markers are stripped (colors carry the change type).
- Unchanged lines: exactly three kept beside each change; every gap gets an expander bar (expand ↑20 / ↓20 / all), including above the first hunk and below the last, backed by a bounded read-only line reader.
- File search and the Deleted/Test filter button share one row. Repository/branch labels share all toolbar width (no reserved spacer). Right-side toolbar order: PR badge · ⋯ display options · Collapse all · Show/Hide file list.
- Click a line, then another, to highlight the range; **Cite in message** inserts the native `@line:` reference into the focused chat composer draft (draft only, never auto-sends). Any code line can also be dragged into the composer (native in-app drag payload) to land as the same citation.
- Commits scope selects all loaded history by default, up to the explicit 200-commit display limit, with multiselect. Omitted older history is disclosed. Selected commits retain separate patches rather than a fabricated net diff.
- **Last agent turn** shows everything since the agent's current turn began in this repo (committed + uncommitted, terminal edits included): the pane snapshots HEAD + untracked files when the focused session goes busy, then diffs against that baseline — the same semantics as the core review pane. Uncommitted edits that predate the turn still appear (Git cannot attribute them).
- PR/MR lookup refers to the checked-out branch and requires CLI authentication. Clipboard Copy path is local. There are no Find issues or Send to chat actions.

## Development checks

```sh
npm ci
npm test
npm run test:layout
python -m unittest discover -s tests -v
node --check desktop/plugin.js
hermes plugins doctor /path/to/git-review --ci
hermes plugins validate /path/to/git-review
python scripts/package.py
```

The browser suite requires Chromium (`npx playwright install chromium`) and an installed Hermes Desktop source checkout with dependencies. Set `HERMES_DESKTOP_SOURCE=/path/to/apps/desktop` when it is not in the default local checkout. It uses actual SDK component sources/styles with mocked host services, at narrow/medium/wide pane widths. It does not attach to or restart the user's app. Node interaction tests use explicitly identified SDK doubles.

Python tests use temporary real repositories and the actual FastAPI router. They cover authorization, ref/path boundaries, commit limits, whitespace behavior, read-only branch inspection, discovery, and profile-scoped selection transport. CI also runs smoke/import-allowlist checks and builds the runtime package; source-dependent browser checks require the desktop checkout.

## Security and limitations

Git commands have explicit repository paths, timeouts, bounded output, resolved revisions and literal pathspecs. External diff/textconv commands are disabled. Repository HTTP routes reject targets outside trusted discovery sources. The desktop plugin runs with Hermes app authority, not in a sandbox.

Diff output above 2 MiB is refused rather than silently truncated. Untracked files are not included in Git patches. History display is capped at 200 commits. Context expansion reveals only supplied patch context. Diffs can contain sensitive code; they remain in the pane, with no chat-submission action. PR lookup uses network access through the user's locally authenticated CLI.

## Troubleshooting

| Symptom | Check |
|---|---|
| No worktrees found / HTTP 403 | Verify the trusted profile/session workspace, or configure `repos`/`roots`. A caller-provided `cwd` is not sufficient authorization. |
| Backend unavailable | Ensure the backend is running and the plugin is enabled. Backend source updates require its process to reload. |
| Could not compute this diff | Verify base/ref and range syntax (`a..b` or `a...b`); single-commit selections require a valid SHA. |
| Diff exceeds display limit | Narrow the scope, selected commits, or path filter. |
| PR button missing | Authenticate `gh`/`glab` and verify the checked-out branch has an open PR/MR on the configured remote. |
| Pane missing / stale UI | Enable the plugin, then use the palette command Reload desktop plugins. |

No release, commit, push, or catalog publication is performed by these checks. See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
