# Contributing

Thanks for looking. This is a single-maintainer project, so a little structure goes a long way — this file is the single source of truth for how contributions work.

## Before you open anything

| You want to | Go to |
|---|---|
| Report a bug | The [bug report form](https://github.com/mister-ideas/git-review/issues/new/choose) |
| Ask how something works, or float an idea | [Discussions](https://github.com/mister-ideas/git-review/discussions) |
| Report a vulnerability | [SECURITY.md](SECURITY.md) — privately, never a public issue |
| Report unacceptable behaviour | [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) |

A pane bug is much cheaper to fix when it reproduces in a test, so please say what you tried and what the pane showed. Without the pane's error text, your Hermes and plugin versions, and the relevant `git-review` log lines, a report usually cannot be reproduced, and it will be closed with a request for that evidence rather than left open.

## Scope: what this plugin will and will not do

**In scope:** the review pane itself — the six scopes, commit navigation (base branch, whole history, paging, commit by commit), diff rendering and syntax colours, folding and gap expanders, the file tree and filters, line citations into the composer, repository discovery, the file-level write actions (stage, unstage, discard, commit, push, open a pull request), and the backend routes behind all of it.

**Out of scope.** Requests for these are closed with a pointer rather than a debate:

- **Repository operations beyond reviewing and shipping a change.** No checkout, branch switching, fetch, pull, merge, rebase, stash or patch application. Writes stay file-level and start only from a button the reviewer presses.
- **Reviewing anything that is not a Git worktree.** No archive browsing, no remote review, no per-session file journaling.
- **Holding credentials.** No tokens, no provider sign-ins, no reading another tool's login. The PR/MR badge runs your own `gh`/`glab`, under its own rules.
- **Replacing Hermes's built-in surfaces.** The plugin adds a pane; it does not restyle or patch the app.
- **Guarantees about a model's review quality.** The pane shows diffs and cites lines; what the agent concludes is the agent's business.

## Ground rules

Keep it generic: no vendor-specific workspace paths, no credentials, no remote fetches, no repository writes outside `git_review/gitwrite.py`, and no import specifiers beyond Hermes' Desktop SDK/React allowlist. Every write goes through the same authorization as the reads, honours `read_only`, and keeps repository-defined programs off unless `run_repo_programs` is set; a destructive one is confirmed in the pane first. Use an isolated `HERMES_HOME` for tests and never inspect or log credentials. Keep every Git subprocess bounded by time and output, resolve user refs to SHAs, and place `--` before pathspecs. Update the README's **Privacy and disclosure** section whenever a change adds a command, a network call, a file read or write, or background activity.

## Development workflow

```sh
npm ci
npm test                 # unit, desktop smoke harness, import allowlist
python -m unittest discover -s tests -v
node --check desktop/plugin.js
hermes plugins doctor . --ci
hermes plugins validate .
python scripts/package.py
```

Python tests use temporary real repositories and the actual FastAPI router. The desktop tests render the real `desktop/plugin.js` against a Node test double of the Hermes SDK, so they prove behaviour and request shapes, not pixel layout: look at the pane in Hermes Desktop for anything visual.

## Tests to add for behavior changes

Add a failing regression test first, then implement. Cover the boundary you touched: scope and path validation, authorization (a caller-supplied `cwd` must never grant access), diff parsing (quoted filenames, renames, multi-commit selections), folding and gap math, discovery bounds, and the citation payload. Prefer asserting the real contract — the request the pane actually makes, or the exact reference text inserted — over a check that merely renders.

## Pull requests

- One change per pull request, with the reasoning in the description. Small pull requests get reviewed; large ones sit.
- CI must be green. It runs the Python suite on Linux, macOS and Windows for Python 3.10 and 3.12, the desktop smoke harness and import-allowlist checks, and the hygiene checks (whitespace, no personal or machine-specific paths).
- Behavior changes need tests and a `CHANGELOG.md` entry in the same pull request.
- Your branch is squashed on merge, so intermediate commits are fine.
- Reviews are best-effort by one person, usually within a few days. If a pull request has been quiet for a couple of weeks, a polite nudge is welcome.
- Describe what you verified and how. "Tests pass" without saying which ones is not evidence.

## Releases

- **Versioning:** SemVer. Pre-1.0, so the minor number carries features and the patch number fixes; a behavior change can land in either, which is what the CHANGELOG is for.
- **What a release is:** a tag (`vX.Y.Z`) plus a GitHub Release, with the CHANGELOG entry written before the tag, not after. Nothing is released from an uncommitted tree.
- **Cadence:** no fixed schedule. Fixes ship when they are ready. Quiet weeks are normal.
- **Catalog pin:** the Hermes plugin catalog pins an exact commit SHA. Moving that pin is a pull request against `NousResearch/hermes-agent` updating `plugin-catalog/git-review.yaml`, which a Hermes maintainer reviews — so catalog users only receive reviewed code.

## Governance

The maintainer decides what lands and aims to answer every issue at least once, even when the answer is no. Sustained contributors may be invited to review. Security reports are handled privately first, and disclosed in the release notes once a fix ships.

License for contributions: MIT (see [LICENSE](LICENSE)).
