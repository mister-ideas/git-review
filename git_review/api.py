"""Read-only HTTP routes. Clients address worktrees by path, never arbitrary commands.

Repository paths are accepted only from trusted profile/session workspaces,
explicitly configured repos/roots, or validated local agent selections. HTTP
`cwd` is a compatibility hint, never an authorization source.
"""

from __future__ import annotations

import os
import threading
import time
from pathlib import Path
try:  # core ships hermes_yaml (v0.21.6+); stock installs have no PyYAML
    from hermes_yaml import safe_load as _yaml_load
except ImportError:  # outside a Hermes checkout (CI, standalone tests)
    from yaml import safe_load as _yaml_load

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from . import gitx, select_store

router = APIRouter()

def _clean(repo: str) -> tuple[str, Path]:
    if "\x00" in repo:
        raise HTTPException(status_code=400, detail="invalid repo path")
    path = Path(os.path.expanduser(repo.strip()))
    # Only real directories, no shell metacharacters survive Path anyway; git -C quotes for us.
    if not path.is_absolute():
        raise HTTPException(status_code=400, detail="repo path must be absolute")
    return str(path), path


def _guard(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except gitx.GitError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


def settings() -> dict:
    """Only this plugin's explicit non-secret settings; never scan home implicitly."""
    home = Path(os.environ.get('HERMES_HOME') or Path.home() / '.hermes').expanduser()
    try:
        config = _yaml_load((home / 'config.yaml').read_text(encoding='utf-8')) or {}
        entry = config.get('plugins', {}).get('entries', {}).get('git-review', {})
        value = entry.get('settings', entry.get('config', {})) or {}
        return value if isinstance(value, dict) else {}
    except Exception:  # unreadable or malformed config.yaml: fall back to defaults
        return {}


def profile_workspace() -> str:
    """The current profile's workspace: `terminal.cwd` from the profile's config.

    The desktop app's backend runs with the profile's HERMES_HOME, so reading
    that config.yaml resolves the workspace of the profile the pane lives in —
    not a fixed path. Empty when unset.
    """
    home = Path(os.environ.get('HERMES_HOME') or Path.home() / '.hermes').expanduser()
    try:
        config = _yaml_load((home / 'config.yaml').read_text(encoding='utf-8')) or {}
        value = (config.get('terminal') or {}).get('cwd')
        return str(value).strip() if value and str(value).strip() not in ('', '.') else ''
    except Exception:  # unreadable or malformed config.yaml: fall back to defaults
        return ''


_ALLOWED_TTL = 30.0
_allowed_cache: dict[tuple, tuple[float, frozenset[str]]] = {}
_allowed_lock = threading.Lock()


def _allowed_key() -> tuple:
    """Everything authorization depends on: any change recomputes it."""
    home = Path(os.environ.get('HERMES_HOME') or Path.home() / '.hermes').expanduser()
    latest = select_store.latest()
    return (str(home), _stamp(home / 'config.yaml'), gitx.session_cwd_rows(), latest['id'] if latest else 0)


def _stamp(path: Path) -> int:
    try:
        return path.stat().st_mtime_ns
    except OSError:
        return 0


def _allowed_repos(cwd: str) -> frozenset[str]:
    """One discovery policy for both inventory and authorization.

    Discovery spawns git per candidate, so the result is reused for a few seconds
    per profile home, config version and agent selection; any of those changing
    recomputes it, so another profile's authorization is never reused.
    """
    key = _allowed_key()
    now = time.monotonic()
    with _allowed_lock:
        hit = _allowed_cache.get(key)
        if hit and now - hit[0] < _ALLOWED_TTL:
            return hit[1]
    result = _compute_allowed_repos()
    with _allowed_lock:
        _allowed_cache.clear()
        _allowed_cache[key] = (time.monotonic(), result)
    return result


def _compute_allowed_repos() -> frozenset[str]:
    allowed: set[str] = set()
    config = settings()
    # The HTTP caller controls cwd and repo together: discovering cwd would
    # let that caller grant itself access to any repository on the machine.
    # Keep the hint accepted for existing clients; trusted sources below own
    # discovery, including workspace following through profile/session state.
    anchors = [profile_workspace()]
    for anchor in anchors:
        if not anchor:
            continue
        path = Path(anchor).expanduser()
        if not path.is_absolute():
            continue
        # The declared workspace may legitimately be broad (a home directory); a
        # filesystem root never is.
        if path.parent == path:
            continue
        try:
            allowed.update(gitx.discover(path if path.is_dir() else path.parent))
        except (gitx.GitError, OSError):
            continue
    allowed.update(gitx.session_cwds())
    allowed.update(gitx.extra_repos(config))
    for root in str(config.get('roots') or '').splitlines()[:16]:
        path = Path(root.strip()).expanduser()
        if root.strip() and path.is_absolute():
            allowed.update(gitx.discover(path))
    # The local agent tool's latest validated request is an explicit selection,
    # not a client-supplied arbitrary repository grant.
    latest = select_store.latest()
    if latest:
        try:
            allowed.add(gitx.normalize(latest['repo']))
        except gitx.GitError:
            pass
    return frozenset(allowed)


def _authorized(repo: str, cwd: str = "") -> str:
    """Normalize the repo and refuse paths outside the focused/configured set."""
    repo_str, path = _clean(repo)
    if not gitx.is_worktree(path):
        raise HTTPException(status_code=400, detail="not a git work tree")
    normalized = _guard(gitx.normalize, path)
    if normalized not in _allowed_repos(cwd):
        raise HTTPException(status_code=403, detail="repository is not the focused workspace or a configured repo/root")
    return normalized


@router.get("/worktrees")
def worktrees(cwd: str = Query(default="", max_length=1024)):
    """Trusted profile/session workspaces, configured repos/roots and agent selections.

    cwd is accepted for client compatibility but cannot expand discovery.
    """
    def entry(r: str) -> dict | None:
        try:
            return {"path": r, "name": Path(r).name, "branch": gitx.current_branch(r)}
        except gitx.GitError:
            return None
    found = sorted(_allowed_repos(cwd))[:128]
    return {"worktrees": [w for w in gitx.parallel(entry, found) if w], "version": "0.1.0"}


@router.get("/meta")
def meta(repo: str = Query(min_length=2, max_length=1024), cwd: str = Query(default="", max_length=1024)):
    normalized = _authorized(repo, cwd)
    b = _guard(gitx.branches, normalized)
    return {"repo": normalized, "name": Path(normalized).name, **b}


@router.get("/status")
def status(repo: str = Query(min_length=2, max_length=1024), cwd: str = Query(default="", max_length=1024)):
    normalized = _authorized(repo, cwd)
    s = _guard(gitx.status, normalized)
    s["repo"] = normalized
    return s


@router.get("/commits")
def commits(repo: str = Query(min_length=2, max_length=1024), base: str = Query(default=None, max_length=200),
            skip: int = Query(default=0, ge=0, le=100000), all: bool = Query(default=False),
            cwd: str = Query(default="", max_length=1024)):
    normalized = _authorized(repo, cwd)
    return _guard(gitx.commits, normalized, base, skip, all)


@router.get("/pr")
def pr(repo: str = Query(min_length=2, max_length=1024), cwd: str = Query(default="", max_length=1024)):
    """Open MR/PR for the checked-out branch, if any (read-only glab/gh lookup)."""
    normalized = _authorized(repo, cwd)
    info = _guard(gitx.branches, normalized)
    if info.get("detached"):
        return None
    return _guard(gitx.pr_for_branch, normalized, info["current"])


@router.get("/pending-select")
def pending_select(after: int = Query(default=0, ge=0)):
    """Latest pane-selection request pushed by the agent's git_review_select tool.

    The pane polls with `after=<last handled id>`; a row with id > after means
    "apply this selection". Returns {request: null} when nothing is pending.
    """
    latest = select_store.latest()
    if not latest or latest["id"] <= after:
        return {"request": None}
    return {"request": latest}


@router.get("/diff")
def diff(repo: str = Query(min_length=2, max_length=1024),
         scope: str = Query(default="uncommitted", max_length=32),
         path: str = Query(default=None, max_length=2048),
         ref: str = Query(default=None, max_length=gitx.MAX_REFS * 41 - 1),
         ignore_ws: bool = Query(default=False),
         cwd: str = Query(default="", max_length=1024)):
    normalized = _authorized(repo, cwd)
    return _guard(gitx.diff, normalized, scope, None, ref, path, ignore_ws)


class TurnBaseRequest(BaseModel):
    """Snapshot request sent by the desktop pane when an agent turn starts."""
    repo: str = Field(min_length=2, max_length=1024)
    cwd: str = Field(default="", max_length=1024)


@router.post("/turn-base")
def turn_base(request: TurnBaseRequest):
    """HEAD sha (null when unborn) and the untracked files present right now.

    Read-only: no index writes, no objects written.
    """
    normalized = _authorized(request.repo, request.cwd)
    return {"repo": normalized, **_guard(gitx.turn_base, normalized)}


class TurnDiffRequest(BaseModel):
    """Changes since a /turn-base snapshot."""
    repo: str = Field(min_length=2, max_length=1024)
    base: str | None = Field(default=None, max_length=64)
    preexisting_untracked: list[str] = Field(default_factory=list, max_length=gitx.MAX_FILES)
    ignore_ws: bool = False
    cwd: str = Field(default="", max_length=1024)


@router.post("/turn-diff")
def turn_diff(request: TurnDiffRequest):
    """Working tree vs the turn-start commit plus files that became untracked since."""
    normalized = _authorized(request.repo, request.cwd)
    return _guard(gitx.turn_diff, normalized, request.base, request.preexisting_untracked,
                  request.ignore_ws)


class FileLinesRequest(BaseModel):
    """Unchanged lines outside a patch's context, for expand buttons."""
    repo: str = Field(min_length=2, max_length=1024)
    path: str = Field(min_length=1, max_length=4096)
    rev: str = Field(min_length=1, max_length=64)
    start: int = Field(ge=1)
    end: int = Field(ge=1)
    cwd: str = Field(default="", max_length=1024)


@router.post("/file-lines")
def file_lines(request: FileLinesRequest):
    """Lines start..end (1-based, inclusive) of a file at worktree/index/<sha>."""
    normalized = _authorized(request.repo, request.cwd)
    try:
        return gitx.file_lines(normalized, request.path, request.rev, request.start, request.end)
    except gitx.NotFound as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except gitx.GitError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
