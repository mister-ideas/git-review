# git-review for Hermes Desktop

[![CI](https://github.com/mister-ideas/git-review/actions/workflows/ci.yml/badge.svg)](https://github.com/mister-ideas/git-review/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/mister-ideas/git-review)](https://github.com/mister-ideas/git-review/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A read-only Git review pane for Hermes Desktop. It shows what changed in the repository you are working in — the agent's last turn, uncommitted, staged or unstaged work, or any selection of commits — in unified or split layout, and lets you cite changed lines into the chat composer.

## Requirements

- Hermes Agent `>=0.21.5` with Desktop.
- `git` on `PATH`.
- Optional: an authenticated `gh` (GitHub) or `glab` (GitLab) CLI, for the pull/merge request badge.

## What it does

- **Scopes:** Last agent turn · Uncommitted · Staged · Unstaged · Commits (multi-select, all loaded commits checked by default, up to 200).
- **Last agent turn** shows everything since the agent's current turn began in this repo, committed and uncommitted, terminal edits and new files included. When the focused session goes busy, the pane snapshots `HEAD` and the untracked file list, then diffs against that baseline. Uncommitted edits that predate the turn still appear, because Git cannot attribute them.
- **Diffs:** unified or split layout (split always wraps), whitespace filtering, and GitHub-style folding of unchanged lines with ↑20 / ↓20 / all expanders, including above the first hunk and below the last.
- **Files:** a right-hand tree with per-file churn, file search, and Deleted / Test filters. Click a file to jump to it; drag a file into the composer to attach it.
- **Line citations:** click a line, then another, and choose **Cite in message** to insert an `@line:` reference into the focused composer draft, or drag lines into the composer. Only lines that exist in the current working tree can be cited (Last agent turn, Uncommitted and Unstaged scopes). Nothing is ever sent automatically.
- **Agent tool `git_review_select`:** lets the agent point the pane at a repository and scope (`repo`, `scope`, `ref`, `base`, `path`, `ignore_ws`). It validates the diff first, then queues the selection for the pane.

## Configuration

The pane follows the focused chat's workspace automatically. To offer other repositories, open Settings → Plugins → git-review:

| Setting | Meaning |
|---|---|
| `repos` | Newline-separated absolute repository paths. |
| `roots` | Newline-separated absolute directories to scan for worktrees (two levels deep, at most 256 directories). |

Settings are stored under `plugins.entries.git-review.settings`. None of them are secrets.

## Privacy and disclosure

- **Shell commands.** The backend runs `git` as a subprocess, read-only: `rev-parse`, `status`, `diff`, `log`, `show`, `cat-file`, `ls-files`, `for-each-ref`, `branch`, `remote`, `rev-list` and `hash-object` (without `-w`, to compute the empty tree). It never fetches, checks out, stages, commits or changes repository content. External diff and textconv drivers are disabled. Every call has a timeout and an output cap.
- **Network.** Only for the PR/MR badge. The backend runs your local `gh pr list` or `glab mr list` for the checked-out branch, so those CLIs contact GitHub or GitLab with your existing login. They get only your `GH_*`, `GITHUB*`, `GLAB_*` and `GITLAB_*` environment, with prompts disabled. The plugin itself makes no network requests.
- **Reads outside its own data.**
  - Files and history inside authorized repositories: the focused workspace, configured `repos`/`roots`, and the latest agent selection.
  - This profile's `config.yaml`, for the plugin settings and `terminal.cwd`.
  - The `cwd` column of the `sessions` table in this profile's `state.db`, opened read-only, so that recent chat workspaces appear without configuration.
  - A caller-supplied path never grants access to a repository.
- **Discovery scope.** Repositories are found by scanning, at most two levels deep, the focused workspace and the working directories of recent chats, plus any configured `repos`/`roots`. A scan visits at most 256 directories and returns at most 128 repositories, never follows symlinks, and skips hidden directories — so `~/.ssh`, `~/.aws`, `~/.config` and similar are never entered. A filesystem root is never scanned, and a home directory is scanned only when it is the declared workspace: a chat that merely ran in your home directory does not expose every repository beneath it.
- **Writes.** `$HERMES_HOME/plugin-data/git-review/select.sqlite3` holds agent selection requests. Desktop plugin storage holds display settings and turn baselines. Nothing is written to your repositories.
- **Background activity.** While the pane is open it polls the local backend: every 3 s for agent selections, and every 5 s for the diff on live scopes. There are no background processes.
- **Credentials and telemetry.** None. The plugin stores no credentials and reports no usage.
- **Sensitive code.** Diffs stay in the pane. The only way code reaches the chat is a citation or drag that you make yourself.

## Limits

- Diffs above 2 MiB are refused with a note rather than silently truncated.
- History is capped at 200 commits, and older history is reported as omitted.
- Each unchanged-line expansion reads at most 2000 lines.
- New untracked files in a turn diff are capped at 200.

## Development

```sh
npm ci
npm test                 # unit, smoke and import-allowlist checks
npm run test:layout      # browser layout suite
python -m unittest discover -s tests -v
hermes plugins validate . --install-deps
python scripts/package.py
```

The browser suite needs Chromium (`npx playwright install chromium`) and a Hermes Desktop source checkout. Set `HERMES_DESKTOP_SOURCE=/path/to/apps/desktop` if it is not in the default location. It renders the real SDK components and styles with mocked host services, at narrow, medium and wide pane widths. Python tests use temporary real repositories and the actual FastAPI router.

## Troubleshooting

| Symptom | Check |
|---|---|
| No worktrees found / HTTP 403 | Open a chat whose workspace is a Git repository, or configure `repos`/`roots`. |
| Backend unavailable | Make sure the plugin is enabled and the backend is running. Backend updates need a backend restart. |
| Diff exceeds display limit | Narrow the scope, the selected commits or the file filter. |
| PR button missing | Authenticate `gh`/`glab` and check that the branch has an open PR/MR. |
| Pane missing or stale | Enable the plugin, then run **Reload desktop plugins** from the command palette. |

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [MIT](LICENSE).
