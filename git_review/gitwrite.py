"""Repository writes started from the pane: stage, unstage, discard, commit, push, open a PR.

Every function takes a repository that api._authorized() has already normalized and
admitted. Paths are repo-relative and validated by gitx._rel_path, then passed to git
as literal pathspecs after `--`, so a file name is never read as an option or a glob.

A checkout's own .git/config can name programs that git runs during these commands
(filter drivers on add/restore, credential helpers and ssh commands on push, a gpg
program on commit). Unless the reviewer opted in with the `run_repo_programs` setting,
those repository-defined programs are refused before git starts, and hooks are
switched off. With the setting on, git runs exactly as it would in a terminal.
"""

from __future__ import annotations

import os
import re
import threading
from pathlib import Path
from typing import cast

from . import gitx

PUSH_TIMEOUT = 120
WRITE_TIMEOUT = 60
COMMIT_CONTEXT_MAX_CHARS = 120_000
COMMIT_CONTEXT_UNTRACKED_MAX = 80
MAX_MESSAGE_CHARS = 20_000

# Repository-scope config keys naming a program git would run during a write,
# grouped by the commands that run it.
_PROGRAM_KEYS = {
    "filters": re.compile(r"^filter\..+\.(clean|smudge|process)$", re.IGNORECASE | re.DOTALL),
    "signing": re.compile(r"^gpg\.(.+\.)?program$", re.IGNORECASE),
    "transport": re.compile(
        r"^(core\.(sshcommand|gitproxy|askpass)|credential\.(.+\.)?helper|"
        r"remote\..+\.(receivepack|uploadpack|vcs)|protocol\.(.+\.)?allow|ssh\.variant)$",
        re.IGNORECASE | re.DOTALL),
}
_NEEDS = {
    "stage": ("filters",),
    "unstage": ("filters",),
    "discard": ("filters",),
    "commit": ("filters", "signing"),
    "push": ("transport",),
}


class WriteRefused(gitx.GitError):
    """The write would run a program the repository's own config names."""


_locks: dict[str, threading.Lock] = {}
_locks_guard = threading.Lock()


def _read(repo: str, *args: str, timeout: int = gitx.TIMEOUT) -> str:
    """A read through gitx's neutralized runner (text output)."""
    return cast(str, gitx._run(repo, *args, timeout=timeout))


def _lock(repo: str) -> threading.Lock:
    with _locks_guard:
        return _locks.setdefault(str(repo), threading.Lock())


def repo_programs(repo: str | Path) -> dict[str, list[str]]:
    """Program-naming keys set by the repository itself (local/worktree scope), by group."""
    try:
        raw = cast(str, gitx._capture(["git", "-C", str(repo), "-c", "core.fsmonitor=false", "config", "--show-scope",
                             "--includes", "-z", "--get-regexp", r"^(filter|gpg|core|credential|remote|protocol|ssh)\."],
                            timeout=5, limit=256 * 1024, ok=(0, 1), env=gitx._git_env()))
    except gitx.GitError:
        return {}
    parts = raw.split("\0")
    found: dict[str, list[str]] = {}
    for scope, item in zip(parts[0::2], parts[1::2]):
        if scope not in ("local", "worktree"):
            continue
        key = item.split("\n", 1)[0]
        for group, pattern in _PROGRAM_KEYS.items():
            if pattern.match(key):
                found.setdefault(group, []).append(key)
    return found


def _check(repo: str, action: str, trusted: bool) -> None:
    if trusted:
        return
    defined = repo_programs(repo)
    keys = sorted({k for group in _NEEDS.get(action, ()) for k in defined.get(group, [])})
    if keys:
        raise WriteRefused(
            f"This repository's own config names programs git would run ({', '.join(keys[:4])}). "
            "Turn on run_repo_programs in the git-review settings to allow it, or use a terminal.")


def _env() -> dict:
    # Writes keep the system config: on macOS and Windows that is where the credential
    # helper lives, and a push without it cannot authenticate.
    env = gitx._git_env()
    env.pop("GIT_CONFIG_NOSYSTEM", None)
    env.pop("GIT_OPTIONAL_LOCKS", None)
    return env


def _git(repo: str, *args: str, trusted: bool, timeout: int = WRITE_TIMEOUT, ok=(0,)) -> str:
    flags: list[str] = []
    if not trusted:
        for kv in ("core.fsmonitor=false", f"core.hooksPath={os.devnull}", "protocol.ext.allow=never",
                   "log.showSignature=false"):
            flags += ["-c", kv]
    return cast(str, gitx._capture(["git", "-C", str(repo), *flags, *args], timeout=timeout, env=_env(), ok=ok,
                                   limit=4 * 1024 * 1024))


def _literal(paths: list[str]) -> list[str]:
    return [":(literal)" + p for p in paths]


def _paths(paths) -> list[str] | None:
    if paths is None:
        return None
    if not isinstance(paths, list) or not paths or len(paths) > gitx.MAX_FILES:
        raise gitx.GitError("invalid path list")
    return list(dict.fromkeys(gitx._rel_path(p) for p in paths))


def _has_head(repo: str) -> bool:
    try:
        gitx._commit_sha(repo, "HEAD")
        return True
    except gitx.GitError:
        return False


def stage(repo: str, paths=None, *, trusted: bool = False) -> dict:
    """`git add --all` for the given files (deletions included), or for the whole worktree."""
    paths = _paths(paths)
    _check(repo, "stage", trusted)
    with _lock(repo):
        _git(repo, "add", "--all", "--", *(_literal(paths) if paths else ["."]), trusted=trusted)
    return {"ok": True}


def unstage(repo: str, paths=None, *, trusted: bool = False) -> dict:
    """Move staged changes back to the worktree; the worktree itself is untouched."""
    paths = _paths(paths)
    _check(repo, "unstage", trusted)
    spec = _literal(paths) if paths else ["."]
    with _lock(repo):
        if _has_head(repo):
            _git(repo, "reset", "-q", "HEAD", "--", *spec, trusted=trusted, ok=(0, 1))
        else:
            _git(repo, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", *spec, trusted=trusted)
    return {"ok": True}


def _in_head(repo: str, path: str) -> bool:
    try:
        _read(repo, "cat-file", "-e", f"HEAD:{path}", timeout=5)
        return True
    except gitx.GitError:
        return False


def _remove_file(root: Path, rel: str) -> bool:
    """Delete one worktree file (or symlink) inside the repository; never a directory."""
    target = root / rel
    try:
        parent = target.parent.resolve(strict=True)
    except OSError:
        return False
    if parent != root and root not in parent.parents:
        raise gitx.GitError(f"refusing to delete outside the repository: {rel}")
    target = parent / target.name
    try:
        if target.is_symlink() or target.is_file():
            target.unlink()
        else:
            return False
    except FileNotFoundError:
        return False
    # Drop directories the deletion emptied, never the repository root.
    current = parent
    while current != root and root in current.parents:
        try:
            current.rmdir()
        except OSError:
            break
        current = current.parent
    return True


def _untracked_files(repo: str) -> list[str]:
    out = _read(repo, "ls-files", "--others", "--exclude-standard", "-z")
    return [p for p in out.split("\0") if p][: gitx.MAX_FILES]


def discard(repo: str, paths=None, *, trusted: bool = False) -> dict:
    """Restore files to HEAD (staged and unstaged changes) and delete new files.

    Only the named files are deleted: an untracked directory is never removed
    wholesale, and ignored files are never touched.
    """
    paths = _paths(paths)
    _check(repo, "discard", trusted)
    root = Path(repo).resolve()
    head = _has_head(repo)
    deleted = 0
    with _lock(repo):
        if paths is None:
            if head:
                _git(repo, "restore", "--source=HEAD", "--staged", "--worktree", "--", ".", trusted=trusted)
            else:
                _git(repo, "rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", ".", trusted=trusted)
            new = _untracked_files(repo)
        else:
            known = [p for p in paths if head and _in_head(repo, p)]
            new = [p for p in paths if p not in known]
            if known:
                _git(repo, "restore", "--source=HEAD", "--staged", "--worktree", "--", *_literal(known),
                     trusted=trusted)
            if new:
                _git(repo, "rm", "-q", "--cached", "--ignore-unmatch", "--", *_literal(new), trusted=trusted)
        for rel in new:
            deleted += _remove_file(root, rel)
    return {"ok": True, "deleted": deleted}


def _staged_any(repo: str) -> bool:
    args = ["diff", "--cached", "--quiet"]
    if not _has_head(repo):
        args.append(gitx._empty_tree(repo))
    try:
        _read(repo, *args, timeout=15)
        return False
    except gitx.GitError:
        return True


def commit(repo: str, message: str, *, push: bool = False, trusted: bool = False) -> dict:
    """Commit what is staged; with nothing staged, stage everything first (VS Code's rule)."""
    text = (message or "").strip()
    if not text:
        raise gitx.GitError("commit message is empty")
    if len(text) > MAX_MESSAGE_CHARS or "\x00" in text:
        raise gitx.GitError("commit message is too long")
    _check(repo, "commit", trusted)
    with _lock(repo):
        if not _staged_any(repo):
            _check(repo, "stage", trusted)
            _git(repo, "add", "--all", "--", ".", trusted=trusted)
            if not _staged_any(repo):
                raise gitx.GitError("nothing to commit")
        _git(repo, "commit", "-q", "-m", text, trusted=trusted)
    sha = gitx._commit_sha(repo, "HEAD")
    result = {"ok": True, "sha": sha, "short": sha[:8], "subject": text.splitlines()[0][:120]}
    if push:
        result["push"] = push_branch(repo, trusted=trusted)
    return result


def _upstream(repo: str) -> str:
    try:
        return _read(repo, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}", timeout=5).strip()
    except gitx.GitError:
        return ""


def _current(repo: str) -> str:
    branch = _read(repo, "branch", "--show-current", timeout=5).strip()
    if not branch:
        raise gitx.GitError("HEAD is detached: check out a branch to push")
    return branch


def push_branch(repo: str, *, trusted: bool = False) -> dict:
    """Push the current branch; the first push sets origin as its upstream."""
    branch = _current(repo)
    _check(repo, "push", trusted)
    upstream = _upstream(repo)
    with _lock(repo):
        if upstream:
            _git(repo, "push", "--quiet", trusted=trusted, timeout=PUSH_TIMEOUT)
        else:
            remotes = _read(repo, "remote", timeout=5).split()
            if "origin" not in remotes:
                raise gitx.GitError("no upstream and no origin remote to push to")
            _git(repo, "push", "--quiet", "-u", "origin", f"refs/heads/{branch}:refs/heads/{branch}",
                 trusted=trusted, timeout=PUSH_TIMEOUT)
    return {"ok": True, "branch": branch, "upstream": _upstream(repo)}


def commit_context(repo: str) -> dict:
    """What a commit would contain, for drafting its message (read-only).

    Same material Hermes Desktop hands its `commit_message` template: the staged diff
    when anything is staged, else every change against HEAD; new files by name; and
    recent subjects so the draft matches the repository's style.
    """
    head = _has_head(repo)
    staged = _staged_any(repo)
    base = "HEAD" if head else gitx._empty_tree(repo)
    args = ["diff", "--no-color", "--no-ext-diff", "--no-textconv"]
    args += ["--cached", base] if staged else [base]
    try:
        diff = _read(repo, *args, "--")
    except gitx.OutputLimit:
        diff = ""
    if len(diff) > COMMIT_CONTEXT_MAX_CHARS:
        diff = diff[:COMMIT_CONTEXT_MAX_CHARS] + "\n# diff truncated for commit-message generation\n"
    if not staged:
        untracked = _untracked_files(repo)
        if untracked:
            shown = untracked[:COMMIT_CONTEXT_UNTRACKED_MAX]
            more = len(untracked) - len(shown)
            diff += "\n# New (untracked) files:\n" + "".join(f"#   {p}\n" for p in shown)
            if more > 0:
                diff += f"#   ... {more} more omitted\n"
    recent = ""
    if head:
        recent = _read(repo, "log", "-n", "10", "--pretty=format:%s", "--no-show-signature", timeout=10)
    return {"diff": diff, "recent": recent.strip(), "staged": staged}


def ship_info(repo: str) -> dict:
    """Branch, upstream and how far it is ahead or behind (read-only)."""
    try:
        branch = _read(repo, "branch", "--show-current", timeout=5).strip()
    except gitx.GitError:
        branch = ""
    upstream = _upstream(repo) if branch else ""
    ahead = behind = 0
    if upstream:
        try:
            counts = _read(repo, "rev-list", "--left-right", "--count", f"{upstream}...HEAD", timeout=10).split()
            behind, ahead = int(counts[0]), int(counts[1])
        except (gitx.GitError, ValueError, IndexError):
            pass
    remotes = _read(repo, "remote", timeout=5).split()
    return {"branch": branch, "upstream": upstream, "ahead": ahead, "behind": behind,
            "has_origin": "origin" in remotes, "host": _host(repo)}


def _host(repo: str) -> str:
    url = gitx.remote_url(repo)
    if not url:
        return ""
    from urllib.parse import urlsplit
    if "://" in url:
        host = (urlsplit(url).hostname or "").lower()
    else:
        match = re.fullmatch(r"(?:[^/@:]+@)?([^/:]+):.+", url)
        host = match.group(1).lower() if match else ""
    return "gitlab" if "gitlab" in host else "github" if "github" in host else ""


def _tool_env(trusted: bool) -> dict:
    # gh and glab run git themselves; the same overrides reach those runs.
    pairs = [] if trusted else [("core.fsmonitor", "false"), ("core.hooksPath", os.devnull),
                                ("protocol.ext.allow", "never")]
    env = {f"GIT_CONFIG_KEY_{i}": k for i, (k, _) in enumerate(pairs)}
    env.update({f"GIT_CONFIG_VALUE_{i}": v for i, (_, v) in enumerate(pairs)})
    if pairs:
        env["GIT_CONFIG_COUNT"] = str(len(pairs))
    return env


def create_pr(repo: str, *, trusted: bool = False) -> dict:
    """Push, then open a pull/merge request filled from the branch's commits."""
    host = _host(repo)
    if host not in ("github", "gitlab"):
        raise gitx.GitError("the origin remote is not on GitHub or GitLab")
    branch = _current(repo)
    info = ship_info(repo)
    if not info["upstream"] or info["ahead"]:
        push_branch(repo, trusted=trusted)
    cmd = (["gh", "pr", "create", "--fill", "--head", branch] if host == "github"
           else ["glab", "mr", "create", "--fill", "--yes", "--source-branch", branch])
    out = gitx._run_tool(cmd, cwd=repo, timeout=60, extra_env=_tool_env(trusted))
    urls = re.findall(r"https?://\S+", out)
    if not urls:
        raise gitx.GitError("the request was created but no link came back")
    return {"ok": True, "url": urls[-1]}
