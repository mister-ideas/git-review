# Security Policy

## Reporting

Report vulnerabilities privately via GitHub security advisories on this repository (Security → Report a vulnerability). Do not open public issues for security reports.

## Supported versions

Only the latest release receives fixes. The Hermes catalog pins an exact commit, so a fix reaches catalog users through a reviewed pin bump.

## What to expect

This is a single-maintainer project: an acknowledgement usually within a few days, and a fix or a written assessment as soon as one is ready. Reports are disclosed in the release notes once a fix ships, with credit if you want it.

## Scope and design stance

- **Read-only by construction.** The backend runs `git` as a bounded subprocess — `rev-parse`, `status`, `diff`, `log`, `show`, `cat-file`, `ls-files`, `for-each-ref`, `branch`, `remote`, `rev-list`, and `hash-object` without `-w`. It never fetches, checks out, stages, commits or writes to a repository. External diff and textconv drivers are disabled, and every call overrides `core.fsmonitor`, `core.hooksPath` and `log.showSignature` and blanks the clean, smudge and process filter drivers that the repository itself defines, so a checkout cannot make the pane run its programs. Your own global filters, such as git-lfs, are left alone. Every call has a timeout and an output cap.
- **Authorization is not caller-supplied.** A repository is reviewable only when it is the focused workspace, a configured `repos`/`roots` entry, or the latest validated agent selection. A caller-supplied `cwd` is a compatibility hint and never grants access.
- **Discovery is bounded.** At most two levels deep, 256 directories and 128 repositories per anchor, never following symlinks, skipping hidden directories. A filesystem root is never scanned, and a home directory only when it is the declared workspace.
- **No credentials.** The plugin reads, stores and refreshes nothing. The PR/MR badge runs the user's own `gh`/`glab` binary, which reads its own configuration; the plugin passes only the environment those CLIs already use, with prompts disabled.
- **No network of its own.** The plugin makes no outbound request and reports no telemetry.
- **Public surfaces only.** It extends Hermes through the Desktop plugin SDK, `ctx.register_tool` and the dashboard plugin router. It never patches, wraps or rebinds Hermes core.
- **Known limitations.** Files above 2 MiB are refused rather than truncated; binary files are not rendered; a repository relying on a textconv filter shows raw content for those files; the pane runs with the Desktop app's authority, not in a sandbox.

## Data handling

State lives in `$HERMES_HOME/plugin-data/git-review/select.sqlite3` (agent selection requests) and in Desktop plugin storage (display settings, turn baselines). Nothing is written into a reviewed repository.

Diffs can contain sensitive code. They stay in the pane; code reaches a model only when you cite or drag a line into the composer yourself, and the plugin never sends anything automatically.
