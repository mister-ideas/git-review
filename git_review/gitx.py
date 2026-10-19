"""Read-only git access. Every command runs with explicit repo context (-C) and bounded output."""

from __future__ import annotations

import os
import re
import subprocess
import queue
import threading
import time
from pathlib import Path

# Diffs larger than this are refused with a note instead of freezing the pane.
MAX_DIFF_BYTES = 2 * 1024 * 1024
MAX_FILES = 2000
MAX_COMMITS = 200
MAX_REFS = MAX_COMMITS
# New untracked files rendered per turn diff (each costs one git process).
MAX_TURN_UNTRACKED = 200
# Lines returned per /file-lines request (unchanged-line expansion).
MAX_FILE_LINES = 2000
# Bytes sniffed for NUL when deciding a file is binary (git uses the same size).
BINARY_SNIFF = 8000
# Enough unchanged lines for meaningful UI folds, still bounded by MAX_DIFF_BYTES.
DIFF_CONTEXT_LINES = 3
TIMEOUT = 15

_SHA = re.compile(r"^[0-9a-fA-F]{7,64}$")
_SAFE_REF = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_./-]*$")


class GitError(Exception):
    """A git command failed or the path is not a work tree."""


class OutputLimit(GitError):
    """Command output exceeded the read budget."""


class NotFound(GitError):
    """The requested file or blob does not exist at that revision."""


_WHICH: dict[tuple[str, str], str] = {}


def _which(name: str) -> str:
    """Absolute path of a tool on the current PATH, memoized per PATH value."""
    if os.path.isabs(name):
        return name
    key = (name, os.environ.get("PATH", ""))
    if key not in _WHICH:
        import shutil
        _WHICH[key] = shutil.which(name) or name
    return _WHICH[key]


def _capture(cmd: list[str], *, cwd=None, env=None, timeout=TIMEOUT, limit=MAX_DIFF_BYTES + 65536,
             ok=(0,), binary: bool = False):
    """Bound output and time on every platform without relying on pipe selectors."""
    # An absolute executable plus close_fds=False lets CPython use posix_spawn
    # (several times cheaper than fork/exec). Safe: Python-created descriptors
    # are non-inheritable by default (PEP 446), so nothing leaks to the child.
    exe = _which(cmd[0])
    try:
        proc = subprocess.Popen([exe, *cmd[1:]], cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                stdin=subprocess.DEVNULL, close_fds=False)
    except ValueError as exc:
        raise GitError("invalid command argument") from exc
    except FileNotFoundError as exc:
        raise GitError(f"{cmd[0]} is not installed") from exc
    except OSError as exc:
        raise GitError(f"cannot start {cmd[0]}: {exc.strerror or type(exc).__name__}") from exc

    chunks: queue.Queue[tuple[str, bytes | None]] = queue.Queue(maxsize=8)
    stopped = threading.Event()
    outputs = {"stdout": bytearray(), "stderr": bytearray()}

    def drain(name: str, stream) -> None:
        def emit(data: bytes | None) -> None:
            while not stopped.is_set():
                try:
                    chunks.put((name, data), timeout=0.05)
                    return
                except queue.Full:
                    continue
        try:
            while not stopped.is_set() and (data := stream.read(65536)):
                emit(data)
        finally:
            emit(None)
            stream.close()

    readers = [threading.Thread(target=drain, args=(name, stream), daemon=True)
               for name, stream in (("stdout", proc.stdout), ("stderr", proc.stderr))]
    for reader in readers:
        reader.start()
    deadline = time.monotonic() + timeout
    ended = 0
    try:
        while ended < 2:
            try:
                name, data = chunks.get(timeout=max(0.001, deadline - time.monotonic()))
            except queue.Empty as exc:
                raise GitError(f"{cmd[0]} timed out after {timeout}s") from exc
            if data is None:
                ended += 1
                continue
            outputs[name].extend(data)
            if sum(map(len, outputs.values())) > limit:
                raise OutputLimit(f"{cmd[0]} output exceeds the {limit} byte limit")
            if time.monotonic() >= deadline:
                raise GitError(f"{cmd[0]} timed out after {timeout}s")
        proc.wait(timeout=max(0.001, deadline - time.monotonic()))
    except subprocess.TimeoutExpired as exc:
        raise GitError(f"{cmd[0]} timed out after {timeout}s") from exc
    finally:
        stopped.set()
        if proc.poll() is None:
            proc.kill()
        proc.wait()
        for reader in readers:
            reader.join(timeout=1)
    if proc.returncode not in ok:
        stdout = outputs["stdout"].decode("utf-8", "replace")
        stderr = outputs["stderr"].decode("utf-8", "replace")
        raise GitError(((stderr or stdout).strip() or f"{cmd[0]} failed").splitlines()[0][:300])
    if binary:
        return bytes(outputs["stdout"])
    return outputs["stdout"].decode("utf-8", "replace")


# A checkout is untrusted input: its own .git/config and .gitattributes can name programs that
# git would run during the plain read-only commands this pane polls (core.fsmonitor on status,
# clean/process filter drivers on status and worktree diff, gpg.program via log.showSignature).
# Every call therefore overrides those settings on the command line, which beats repo config.
_NEUTRAL_CONFIG = ("core.fsmonitor=false", f"core.hooksPath={os.devnull}", "log.showSignature=false")
_FILTER_KEY = re.compile(r"^filter\.(.+)\.(clean|smudge|process)$", re.IGNORECASE | re.DOTALL)
# Commands that run clean filters over the worktree.
_FILTERING = frozenset({"status", "diff"})


def _repo_filter_drivers(repo: str | Path) -> set[str]:
    """Filter drivers defined by the repository's own config (local/worktree scope).

    Drivers only exist when config names them, so blanking the repo-defined ones covers whatever
    .gitattributes asks for, while the user's own global drivers (git-lfs) keep working.
    """
    try:
        raw = _capture(["git", "-C", str(repo), *(a for kv in _NEUTRAL_CONFIG for a in ("-c", kv)),
                        "config", "--show-scope", "--includes", "-z", "--get-regexp",
                        r"^filter\..*\.(clean|smudge|process)$"],
                       timeout=5, limit=256 * 1024, ok=(0, 1), env=_git_env())
    except (GitError, OSError):
        return set()
    parts = raw.split("\0")
    names: set[str] = set()
    for scope, item in zip(parts[0::2], parts[1::2]):
        if scope not in ("local", "worktree", "command"):
            continue
        match = _FILTER_KEY.match(item.split("\n", 1)[0])
        if match:
            names.add(match.group(1))
    return names


def _git_env() -> dict:
    return {**os.environ, "GIT_OPTIONAL_LOCKS": "0", "GIT_PAGER": "cat", "PAGER": "cat",
            "GIT_CONFIG_NOSYSTEM": "1", "GIT_TERMINAL_PROMPT": "0"}


def _run(repo: str | Path, *args: str, timeout: int = TIMEOUT, limit: int = MAX_DIFF_BYTES + 65536,
         ok=(0,), binary: bool = False):
    overrides = list(_NEUTRAL_CONFIG)
    if args and args[0] in _FILTERING:
        for name in sorted(_repo_filter_drivers(repo)):
            overrides += [f"filter.{name}.clean=", f"filter.{name}.smudge=", f"filter.{name}.process=",
                          f"filter.{name}.required=false"]
    flags = [a for kv in overrides for a in ("-c", kv)]
    return _capture(["git", "-C", str(repo), *flags, *args], timeout=timeout, limit=limit, ok=ok,
                    binary=binary, env=_git_env())


# Environment a repo CLI needs to find the user's own login. The POSIX names are
# prefixes (HOME/PATH/LANG…); the Windows ones are exact (APPDATA holds gh/glab
# config there, SYSTEMROOT is needed to start a console tool at all).
_TOOL_ENV_PREFIXES = ("LC_", "LANG", "HOME", "PATH", "GITLAB_", "GITHUB", "GH_", "GLAB_", "XDG_")
_TOOL_ENV_NAMES = frozenset({"APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "USERPROFILE", "SYSTEMROOT",
                            "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "TEMP", "TMP", "HOMEDRIVE", "HOMEPATH"})


def _run_tool(cmd: list[str], *, cwd: str | Path, timeout: int = 12) -> str:
    """Run a read-only repo tool (glab/gh) with a clean, bounded environment."""
    env = {k: v for k, v in os.environ.items()
           if k.startswith(_TOOL_ENV_PREFIXES) or k.upper() in _TOOL_ENV_NAMES}
    # Never wait for a person: unattended runs must fail fast, not hang on a prompt.
    env.update({"GH_PROMPT_DISABLED": "1", "GIT_TERMINAL_PROMPT": "0", "NO_PROMPT": "1"})
    return _capture(cmd, cwd=str(cwd), env=env, timeout=timeout, limit=256 * 1024)


def is_worktree(repo: str | Path) -> bool:
    try:
        return _run(repo, "rev-parse", "--is-inside-work-tree", timeout=5).strip() == "true"
    except (GitError, OSError):
        return False


def normalize(repo: str | Path) -> str:
    """Resolve to the worktree root so subpaths of a checkout still work."""
    out = _run(repo, "rev-parse", "--show-toplevel").strip()
    if not out:
        raise GitError("not a git work tree")
    return out


def _home() -> Path:
    return Path.home()


def is_broad_base(base: Path) -> bool:
    """A filesystem root is never a workspace; a home directory only counts as one
    when it is the declared workspace, not merely a historical chat directory."""
    base = Path(base)
    return base.parent == base or base == _home()


def discover(base: Path, depth: int = 2) -> list[str]:
    """Scan one workspace/configured root, at bounded depth and breadth."""
    base = Path(base).expanduser()
    found: list[str] = []
    if base.parent == base:
        return []
    if is_worktree(base):
        return [normalize(base)]
    skip = {".git", "node_modules", ".venv", "venv", "__pycache__", ".next", "dist", "build"}
    current = [base]
    visited = 0
    for _ in range(min(max(1, depth), 4)):
        nxt: list[Path] = []
        for d in current:
            try:
                entries = sorted(d.iterdir(), key=lambda p: p.name)
            except (PermissionError, FileNotFoundError, NotADirectoryError):
                continue
            for e in entries:
                if visited >= 256 or len(found) >= 128:
                    break
                if e.is_symlink() or not e.is_dir() or e.name in skip or e.name.startswith("."):
                    continue
                visited += 1
                # A stat per directory, not a git process: discovery runs on every
                # request and may start from a large directory such as $HOME.
                if (e / ".git").exists():
                    found.append(e)
                else:
                    nxt.append(e)
        current = nxt
        if visited >= 256 or len(found) >= 128:
            break
    # A directory holding .git is its own worktree root; ask git for the canonical
    # form (one spawn per repository, never per directory).
    return sorted({r for r in parallel(_canonical_or_none, found) if r})


def _canonical_or_none(path: Path) -> str | None:
    """git's --show-toplevel form: free when the path has no symlinks, else ask git."""
    try:
        if str(path) == os.path.realpath(path):
            return path.as_posix()
        return normalize(path)
    except (GitError, OSError):
        return None


def parallel(fn, items, workers: int = 8) -> list:
    """Map fn over items with a small thread pool; each git call costs a process spawn."""
    items = list(items)
    if len(items) < 2:
        return [fn(i) for i in items]
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(max_workers=min(workers, len(items))) as pool:
        return list(pool.map(fn, items))


def session_cwds(db_path: Path | None = None, limit: int = 15) -> list[str]:
    """Git-worktree cwds from Hermes' own session history (state.db, read-only).

    This is the workspace auto-detection source: the sessions table records the
    cwd every chat ran in, so the repos the user actually works in surface in
    the pane with zero configuration. Read-only connection; any failure → [].
    """
    def scan(cwd) -> list[str]:
        try:
            path = Path(str(cwd)).expanduser()
            if path.is_absolute() and path.is_dir() and not is_broad_base(path):
                return discover(path)
        except (GitError, OSError):
            pass
        return []
    return [repo for found in parallel(scan, session_cwd_rows(db_path, limit), workers=4) for repo in found]


def session_cwd_rows(db_path: Path | None = None, limit: int = 15) -> tuple[str, ...]:
    """The most-used session cwds (a cheap read-only query, no discovery)."""
    if db_path is None:
        home = Path(os.environ.get("HERMES_HOME", "") or Path.home() / ".hermes").expanduser()
        db_path = home / "state.db"
    if not db_path.exists():
        return ()
    try:
        import sqlite3

        conn = sqlite3.connect(db_path.resolve().as_uri() + "?mode=ro", uri=True, timeout=2)
        try:
            rows = conn.execute(
                "SELECT cwd FROM sessions WHERE cwd IS NOT NULL AND cwd != '' "
                "GROUP BY cwd ORDER BY COUNT(*) DESC LIMIT ?",
                (int(limit),),
            ).fetchall()
        finally:
            conn.close()
    except Exception:
        return ()
    return tuple(str(row[0]) for row in rows)


def extra_repos(config) -> list[str]:
    """Paths from the plugin's `repos` config (one per line), validated."""
    raw = ""
    try:
        raw = (config.get("repos") or "") if isinstance(config, dict) else ""
    except Exception:
        raw = ""
    out = []
    for line in str(raw).splitlines()[:128]:
        p = line.strip()
        if p and Path(p).expanduser().is_absolute():
            try:
                out.extend(discover(Path(p).expanduser()))
            except GitError:
                continue
    return out


def current_branch(repo: str | Path) -> str:
    """Checked-out branch read from HEAD without spawning git ("" when detached)."""
    dotgit = Path(repo) / ".git"
    try:
        if dotgit.is_file():
            pointer = dotgit.read_text(encoding="utf-8", errors="replace").strip()
            if not pointer.startswith("gitdir:"):
                raise GitError("not a git work tree")
            gitdir = Path(pointer[len("gitdir:"):].strip())
            dotgit = gitdir if gitdir.is_absolute() else (Path(repo) / gitdir)
        head = (dotgit / "HEAD").read_text(encoding="utf-8", errors="replace").strip()
    except OSError as exc:
        raise GitError("not a git work tree") from exc
    prefix = "ref: refs/heads/"
    return head[len(prefix):] if head.startswith(prefix) else ""


def branches(repo: str | Path) -> dict:
    local = [l.strip() for l in _run(repo, "for-each-ref", "refs/heads", "--format=%(refname:short)").splitlines() if l.strip()]
    remote = []
    for line in _run(repo, "for-each-ref", "refs/remotes", "--format=%(refname:short)").splitlines():
        name = line.strip()
        # hide the remote's HEAD mirror (origin/main duplicates)
        if name and not name.endswith("/HEAD"):
            remote.append(name)
    current = _run(repo, "branch", "--show-current").strip()
    detached = not current
    if detached:
        try:
            current = "HEAD@" + _run(repo, "rev-parse", "--short", "HEAD").strip()
        except GitError:
            current = "HEAD"
    return {"current": current, "detached": detached, "local": local[:200], "remote": remote[:400]}


def status(repo: str | Path) -> dict:
    out = _run(repo, "status", "--porcelain=v1", "-z")
    files: list[dict] = []
    ahead = behind = 0
    tokens = out.split("\0")
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if not tok:
            i += 1
            continue
        if len(tok) > 3 and tok[2] == " " and "ahead" in tok and "behind" in tok:
            # branch header token when -b is used; not emitted by -z without -b, skip defensively
            i += 1
            continue
        xy, path = tok[:2], tok[3:] if len(tok) > 2 else tok[2:]
        orig = None
        if xy and xy[0] in "RC" and i + 1 < len(tokens):
            orig = tokens[i + 1]
            i += 1
        i += 1
        if not path:
            continue
        staged, unstaged = xy[0], xy[1]
        entry = {"path": path, "orig": orig, "staged": 0, "unstaged": 0, "untracked": False}
        if unstaged == "?" or unstaged == "!":
            entry["untracked"] = True
            entry["status"] = "untracked"
        elif staged == "A":
            entry["status"] = "added"
        elif staged == "D" or unstaged == "D":
            entry["status"] = "deleted"
        elif staged in "RC":
            entry["status"] = "renamed"
        elif staged == "M" or unstaged == "M":
            entry["status"] = "modified"
        else:
            entry["status"] = "changed"
        files.append(entry)
        if len(files) >= MAX_FILES:
            break
    ab = _run(repo, "rev-list", "--left-right", "--count", "HEAD...@{upstream}").split() if _has_upstream(repo) else None
    if ab and len(ab) == 2:
        ahead, behind = int(ab[0]), int(ab[1])
    return {"files": files, "ahead": ahead, "behind": behind}


def _has_upstream(repo: str | Path) -> bool:
    try:
        _run(repo, "rev-parse", "--verify", "--quiet", "@{upstream}")
        return True
    except GitError:
        return False


def _commit_sha(repo: str | Path, ref: str) -> str:
    ref = ref.strip()
    if not _SAFE_REF.fullmatch(ref) or '..' in ref or ref.endswith(('.', '/', '.lock')):
        raise GitError(f"invalid commit ref: {ref[:40]}")
    try:
        return _run(repo, "rev-parse", "--verify", "--quiet", "--end-of-options", ref + "^{commit}").strip()
    except GitError as exc:
        raise GitError(f"unknown commit: {ref[:40]}") from exc


SCOPES = ("unstaged", "staged", "uncommitted", "commits")


def _validate_sha(repo: str | Path, ref: str) -> str:
    if not _SHA.fullmatch(ref.strip()):
        raise GitError(f"invalid commit ref: {ref[:40]}")
    try:
        return _run(repo, "rev-parse", "--verify", "--quiet", "--end-of-options", ref.strip() + "^{commit}").strip()
    except GitError as exc:
        raise GitError(f"unknown commit: {ref[:12]}") from exc


def _empty_tree(repo: str | Path) -> str:
    """Empty-tree id in the repo's hash format. hash-object without -w reads EOF
    from DEVNULL and writes no object."""
    return _run(repo, "hash-object", "-t", "tree", "--stdin").strip()


def _rel_path(raw) -> str:
    """A plain repo-relative path: no options, traversal, absolute, NUL or control chars."""
    if not isinstance(raw, str):
        raise GitError("invalid path")
    p = raw.strip()
    if (not p or p != raw or "\x00" in p or p.startswith(("-", "/", "\\")) or any(ord(c) < 32 for c in p)
            or Path(p).is_absolute() or re.match(r"^[A-Za-z]:", p)):
        raise GitError("invalid path")
    parts = re.split(r"[\\/]+", p)
    if any(part in ("..", ".") for part in parts) or not all(parts):
        raise GitError("invalid path")
    return p


def _untracked(repo: str | Path) -> tuple[list[str], bool, int]:
    """Untracked, non-ignored files (repo-relative). Returns (paths, truncated, skipped).

    Read-only listing; nested repositories (reported as `dir/`) and names that
    fail _rel_path (e.g. control characters) are skipped and counted.
    """
    out = _run(repo, "ls-files", "--others", "--exclude-standard", "-z", "--", ":/")
    paths: list[str] = []
    skipped = 0
    truncated = False
    for name in out.split("\0"):
        if not name:
            continue
        if name.endswith("/"):
            skipped += 1
            continue
        try:
            _rel_path(name)
        except GitError:
            skipped += 1
            continue
        if len(paths) >= MAX_FILES:
            truncated = True
            break
        paths.append(name)
    return paths, truncated, skipped


def turn_base(repo: str | Path) -> dict:
    """Snapshot taken at agent-turn start: HEAD sha (None if unborn) + untracked files."""
    try:
        base = _commit_sha(repo, "HEAD")
    except GitError:
        base = None
    untracked, truncated, _ = _untracked(repo)
    return {"base": base, "untracked": untracked, "untracked_truncated": truncated}


def turn_diff(repo: str | Path, base: str | None, preexisting_untracked: list[str] | None = None,
              ignore_ws: bool = False) -> dict:
    """Everything that changed since a turn_base() snapshot.

    Tracked: `git diff <base>` (working tree vs the turn-start commit, so new
    commits and uncommitted edits both appear). Untracked: every file not in the
    turn-start snapshot, rendered as an all-add patch via `diff --no-index`.
    """
    pre = preexisting_untracked or []
    if len(pre) > MAX_FILES:
        raise GitError(f"too many preexisting untracked paths (max {MAX_FILES})")
    pre_set = {_rel_path(p) for p in pre}
    if base is None or not str(base).strip():
        base_sha = _empty_tree(repo)
    else:
        base_sha = _validate_sha(repo, str(base))
    try:
        tracked = _run(repo, *_patch_args(ignore_ws), base_sha, "--")
    except OutputLimit:
        tracked = None
    if tracked is None or len(tracked.encode("utf-8", "replace")) > MAX_DIFF_BYTES:
        return {"patch": "", "added": 0, "removed": 0,
                "note": "Turn diff exceeds the display limit. Filter to one file or review uncommitted changes."}
    current, listing_truncated, skipped = _untracked(repo)
    new = [p for p in current if p not in pre_set]
    notes: list[str] = []
    if len(new) > MAX_TURN_UNTRACKED:
        notes.append(f"{len(new) - MAX_TURN_UNTRACKED} new untracked files omitted (showing {MAX_TURN_UNTRACKED}).")
        new = new[:MAX_TURN_UNTRACKED]
    parts = [tracked]
    total = len(tracked.encode("utf-8", "replace"))
    too_big = 0
    root = Path(repo)
    for rel in new:
        full = root / rel
        if full.is_dir() and not full.is_symlink():
            continue
        budget = MAX_DIFF_BYTES - total
        if budget <= 0:
            too_big += 1
            continue
        try:
            # rc 1 means "differences found" for --no-index; it is the normal case.
            patch = _run(repo, "diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color",
                         "--src-prefix=a/", "--dst-prefix=b/", "--", "/dev/null", rel,
                         ok=(0, 1), limit=budget + 4096)
        except OutputLimit:
            too_big += 1
            continue
        except GitError:
            # Vanished between listing and diff, or unreadable: skip, never fail the view.
            continue
        size = len(patch.encode("utf-8", "replace"))
        if total + size > MAX_DIFF_BYTES:
            too_big += 1
            continue
        if patch and not patch.endswith("\n"):
            patch += "\n"
        parts.append(patch)
        total += size
    if too_big:
        notes.append(f"{too_big} new untracked files omitted: diff exceeds the display limit.")
    if listing_truncated:
        notes.append(f"Untracked listing capped at {MAX_FILES} files; some new files may be missing.")
    if skipped:
        notes.append(f"{skipped} untracked entries with unsupported names or nested repositories skipped.")
    result = _summarize("".join(parts))
    result["note"] = " ".join(notes)
    return result


def file_lines(repo: str | Path, path: str, rev: str, start: int, end: int) -> dict:
    """1-based inclusive line range of a file at worktree, index, or a commit."""
    rel = _rel_path(path)
    if any(part.lower() == ".git" for part in re.split(r"[\\/]+", rel)):
        raise GitError("invalid path")
    if not isinstance(start, int) or not isinstance(end, int) or start < 1 or end < start:
        raise GitError("invalid line range")
    if end - start >= MAX_FILE_LINES:
        raise GitError(f"line range too large (max {MAX_FILE_LINES} lines)")
    rev = (rev or "").strip()
    if rev == "worktree":
        root = Path(repo).resolve()
        try:
            resolved = (root / rel).resolve(strict=True)
        except (FileNotFoundError, NotADirectoryError) as exc:
            raise NotFound("file not found") from exc
        except (OSError, RuntimeError) as exc:
            raise GitError("cannot resolve file") from exc
        try:
            inner = resolved.relative_to(root)
        except ValueError as exc:
            raise GitError("path resolves outside the repository") from exc
        if any(part.lower() == ".git" for part in inner.parts):
            raise GitError("invalid path")
        if not resolved.is_file():
            raise NotFound("not a regular file")
        try:
            if resolved.stat().st_size > MAX_DIFF_BYTES:
                raise GitError("file exceeds the display limit")
            with open(resolved, "rb") as fh:
                data = fh.read(MAX_DIFF_BYTES + 1)
        except OSError as exc:
            raise GitError("cannot read file") from exc
        if len(data) > MAX_DIFF_BYTES:
            raise GitError("file exceeds the display limit")
    else:
        if rev == "index":
            obj = ":0:" + rel
        else:
            obj = _validate_sha(repo, rev) + ":" + rel
        try:
            kind = _run(repo, "cat-file", "-t", obj, timeout=5).strip()
        except GitError as exc:
            raise NotFound("file not found at that revision") from exc
        if kind != "blob":
            raise NotFound("not a file at that revision")
        if int(_run(repo, "cat-file", "-s", obj, timeout=5).strip() or 0) > MAX_DIFF_BYTES:
            raise GitError("file exceeds the display limit")
        # cat-file blob prints raw content: no textconv, no filters.
        data = _run(repo, "cat-file", "blob", obj, binary=True)
    if b"\x00" in data[:BINARY_SNIFF]:
        raise GitError("binary file")
    lines = data.decode("utf-8", "replace").split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    total = len(lines)
    clamped = min(end, total)
    return {"lines": lines[start - 1:clamped], "start": start, "end": clamped, "total": total}


def _patch_args(ignore_ws: bool) -> list[str]:
    args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color",
            "--src-prefix=a/", "--dst-prefix=b/", "-M", f"-U{DIFF_CONTEXT_LINES}"]
    if ignore_ws:
        args.append("--ignore-all-space")
    return args


def diff(repo: str | Path, scope: str, base: str | None = None, ref: str | None = None,
         path: str | None = None, ignore_ws: bool = False) -> dict:
    """Return a unified patch for the requested scope.

    Scopes:
      unstaged     working tree vs index
      staged       index vs HEAD
      uncommitted  working tree vs HEAD (staged + unstaged)
      commits      comma-separated SHAs, each rendered as its own patch

    The agent-turn view is not a scope: see turn_base()/turn_diff().
    """
    scope = (scope or "uncommitted").strip()
    if scope not in SCOPES:
        raise GitError(f"unknown scope: {scope}")

    if path and (path.startswith(('-', '/')) or '\x00' in path or '..' in Path(path).parts):
        raise GitError("invalid path filter")
    literal_path = ["--", ":(literal)" + path] if path else ["--"]

    if scope == "commits":
        # Each selection has its own patch, never a fabricated net diff.
        # Empty ref selects the bounded history returned by commits().
        refs = (ref or "").split(",") if (ref or "").strip() else []
        if any(not r.strip() for r in refs):
            raise GitError("empty commit ref in selection")
        history_note = ""
        if not refs:
            history = commits(repo, base)
            refs = [item["sha"] for item in history["commits"]]
            history_note = history["note"]
        if len(refs) > MAX_REFS:
            raise GitError(f"too many commits selected (max {MAX_REFS})")
        shas = [_validate_sha(repo, r) for r in refs]
        # Preserve the user's selection order. Each commit is a separate patch: a
        # later patch must never masquerade as the net diff for all selections.
        patches = []
        total = 0
        for sha in dict.fromkeys(shas):
            try:
                parent = _run(repo, "rev-parse", "--verify", "--quiet", sha + "^").strip()
                revisions = [parent, sha]
            except GitError:
                revisions = None
            try:
                patch = (_run(repo, *_patch_args(ignore_ws), *revisions, *literal_path)
                         if revisions else _run(repo, "show", "--format=", "--root",
                                                *_patch_args(ignore_ws)[1:], sha, *literal_path))
            except OutputLimit:
                return {"commits": [], "note": "Selected diff exceeds the display limit."}
            total += len(patch.encode('utf-8'))
            if total > MAX_DIFF_BYTES:
                return {"commits": [], "note": "Selected diff exceeds the display limit."}
            patches.append({"sha": sha, **_summarize(patch)})
        return {"commits": patches, "note": history_note}

    args = _patch_args(ignore_ws)
    if scope == "unstaged":
        pass
    elif scope == "staged":
        args.append("--cached")
    elif scope == "uncommitted":
        try:
            head = _commit_sha(repo, "HEAD")
        except GitError:
            # An unborn checkout still has staged/working tracked changes.
            head = _empty_tree(repo)
        args.append(head)
    # Never pass a caller-controlled path as a revision or option.
    args.extend(literal_path)
    try:
        patch = _run(repo, *args)
    except OutputLimit:
        return {"patch": "", "note": "Diff exceeds the display limit. Narrow the scope or filter to one file.", "added": 0, "removed": 0}
    if len(patch.encode("utf-8", "replace")) > MAX_DIFF_BYTES:
        return {"patch": "", "note": f"Diff exceeds the {MAX_DIFF_BYTES // (1024 * 1024)} MB display limit. Narrow the scope or filter to one file.", "added": 0, "removed": 0}
    return _summarize(patch)


def _summarize(patch: str) -> dict:
    added = removed = 0
    in_hunk = False
    for line in patch.splitlines():
        if line.startswith("diff --git "):
            in_hunk = False
        elif line.startswith("@@ "):
            in_hunk = True
        elif in_hunk and line.startswith("+"):
            added += 1
        elif in_hunk and line.startswith("-"):
            removed += 1
    return {"patch": patch, "added": added, "removed": removed, "note": ""}


def _default_branch_fork_point(repo: str | Path):
    """Merge-base of HEAD with the default branch, or None when HEAD is on it (or none exists)."""
    candidates = []
    try:
        head = _run(repo, "symbolic-ref", "--quiet", "refs/remotes/origin/HEAD").strip()
        if head:
            candidates.append(head.removeprefix("refs/remotes/"))
    except GitError:
        pass
    candidates += ["origin/main", "origin/master", "main", "master"]
    for name in candidates:
        try:
            tip = _commit_sha(repo, name)
            head_sha = _commit_sha(repo, "HEAD")
            if tip == head_sha:
                return None
            fork = _run(repo, "merge-base", tip, head_sha).strip()
            return (fork, name) if re.fullmatch(r"[0-9a-f]{40,64}", fork) and fork != head_sha else None
        except GitError:
            continue
    return None


def commits(repo: str | Path, base: str | None = None, skip: int = 0, all_history: bool = False) -> dict:
    """Latest HEAD history by default; an explicit base restricts to base..HEAD."""
    start = _commit_sha(repo, base) if base and base.strip() else None
    try:
        _commit_sha(repo, "HEAD")
    except GitError:
        return {"commits": [], "base": start, "truncated": False, "note": "Repository has no commits yet."}
    auto = None
    skip = max(0, min(int(skip or 0), 100000))
    if start is None and not all_history:
        found = _default_branch_fork_point(repo)
        start, auto = (found[0], found[1]) if found else (None, None)
    revision = f"{start}..HEAD" if start else "HEAD"
    out = _run(repo, "log", revision, "--skip", str(skip), "--max-count", str(MAX_COMMITS + 1),
               "--format=%H%x1f%h%x1f%an%x1f%at%x1f%s", "--numstat", "--no-ext-diff", "--no-textconv", "--diff-merges=first-parent", "--")
    items: list[dict] = []
    current = None
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) >= 5 and re.fullmatch(r"[0-9a-f]{40,64}", parts[0]):
            current = {"sha": parts[0], "short": parts[1], "author": parts[2],
                       "at": int(parts[3] or 0), "subject": parts[4][:120],
                       "added": 0, "removed": 0, "files": 0}
            items.append(current)
            continue
        if current is None or not line.strip():
            continue
        cols = line.split("\t")
        if len(cols) >= 3 and (cols[0].isdigit() or cols[0] == "-") and (cols[1].isdigit() or cols[1] == "-"):
            if cols[0] != "-" and cols[1] != "-":
                current["added"] += int(cols[0])
                current["removed"] += int(cols[1])
            current["files"] += 1
    truncated = len(items) > MAX_COMMITS
    note = f"Showing {MAX_COMMITS} commits; use Load older for more." if truncated else ""
    if all_history:
        note = "Full history of this branch." + (" " + note if note else "")
    if auto and items:
        note = f"Commits on this branch since it left {auto}." + (" " + note if note else "")
    try:
        shallow = _run(repo, "rev-parse", "--is-shallow-repository", timeout=5).strip() == "true"
    except GitError:
        shallow = False
    if shallow:
        note = "Shallow clone: only the fetched history exists. Run `git fetch --unshallow` to see every commit." + (" " + note if note else "")
    return {"commits": items[:MAX_COMMITS], "base": None if auto else start, "base_label": auto, "truncated": truncated, "has_more": truncated, "skip": skip, "note": note}


def remote_url(repo: str | Path) -> str:
    try:
        return _run(repo, "remote", "get-url", "origin", timeout=5).strip()
    except GitError:
        return ""


def pr_for_branch(repo: str | Path, branch: str) -> dict:
    """Best-effort read-only PR lookup for a branch (GitLab via glab, GitHub via gh)."""
    branch = (branch or "").strip()
    if not branch:
        raise GitError("no current branch")
    if not _SAFE_REF.fullmatch(branch) or ".." in branch or branch.endswith((".", "/", ".lock")):
        raise GitError("invalid branch")
    url = remote_url(repo)
    from urllib.parse import urlsplit
    if "://" in url:
        host = (urlsplit(url).hostname or "").lower()
    else:
        match = re.fullmatch(r"(?:[^/@:]+@)?([^/:]+):.+", url)
        host = match.group(1).lower() if match else ""
    if "gitlab" in host:
        out = _run_tool(["glab", "mr", "list", "--source-branch", branch, "-F", "json", "-P", "5"], cwd=repo)
        return _first_pr(out, "glab")
    if "github" in host:
        out = _run_tool(["gh", "pr", "list", "--head", branch, "--limit", "1",
                         "--json", "url,number,title,state"], cwd=repo)
        return _first_pr(out, "gh")
    raise GitError("remote is not GitLab or GitHub — PR lookup unavailable")


def _first_pr(raw: str, tool: str) -> dict:
    import json as _json
    try:
        data = _json.loads(raw)
    except ValueError as exc:
        raise GitError(f"{tool} returned unreadable output") from exc
    items = data if isinstance(data, list) else []
    for m in items:
        if isinstance(m, dict) and m.get("state") in ("opened", "open", "OPEN"):
            url = m.get("web_url") or m.get("url", "")
            number = m.get("iid") if "iid" in m else m.get("number")
            title = m.get("title") or ""
            if (not isinstance(url, str) or not url.startswith(("https://", "http://"))
                    or not isinstance(number, int) or isinstance(number, bool)
                    or number <= 0 or not isinstance(title, str)):
                raise GitError(f"{tool} returned invalid PR metadata")
            return {"url": url, "iid": number, "title": title[:120], "state": m["state"]}
    raise GitError("no open MR/PR for this branch")
