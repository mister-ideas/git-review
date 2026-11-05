"""git_review_select — point the desktop Git review pane at a worktree/scope.

Called by the model when the user says "review" / "show changes": pushes a
selection request into the shared store; the desktop pane polls and applies it.
"""

from __future__ import annotations

import json
import os
from pathlib import Path

from . import gitx, select_store

TOOLSET = "git"

PARAMETERS = {
    "type": "object",
    "properties": {
        "repo": {
            "type": "string",
            "description": "Absolute path to the git worktree to show. Omit to use the current working directory.",
        },
        "scope": {
            "type": "string",
            "enum": list(gitx.SCOPES),
            "description": "Diff scope. uncommitted = working tree vs HEAD (the default review view).",
        },
        "ref": {
            "type": "string",
            "description": "Ref for the commits scope: comma-separated shas.",
        },
        "path": {
            "type": "string",
            "description": "Optional file path to filter the diff to.",
        },
        "ignore_ws": {
            "type": "boolean",
            "description": "Ignore whitespace-only differences.",
        },
        "base": {
            "type": "string",
            "description": "Optional base ref for the commits scope: the pane then lists only base..HEAD history.",
        },
    },
    "required": [],
}

# Hermes's tool contract: an OpenAI function schema. A bare JSON Schema here left the
# agent with no description and no parameters.
SCHEMA = {
    "name": "git_review_select",
    "description": (
        "Point the git-review pane in Hermes Desktop at a repository and scope, so the user "
        "sees the change there. Use it when the user asks to see, review or show changes "
        "(optionally one file, via path)."
    ),
    "parameters": PARAMETERS,
}


def handle(args: dict | None = None, **context) -> str:
    """Hermes calls ``handler(args, **context)`` and accepts a string result."""
    args = args if isinstance(args, dict) else {}
    known = ("repo", "scope", "ref", "path", "base", "ignore_ws")
    return json.dumps(select(**{k: args[k] for k in known if k in args}))


def select(repo: str = "", scope: str = "uncommitted", ref: str = "", path: str = "",
           base: str = "", ignore_ws: bool = False) -> dict:
    repo = (repo or "").strip() or os.getcwd()
    try:
        normalized = gitx.normalize(Path(os.path.expanduser(repo)))
    except gitx.GitError as exc:
        return {"ok": False, "error": str(exc)}

    scope = (scope or "uncommitted").strip()
    if scope not in gitx.SCOPES:
        return {"ok": False, "error": f"unknown scope: {scope}"}

    # Pre-validate the diff resolves so the pane never opens on an error.
    try:
        gitx.diff(normalized, scope, base=base or None, ref=ref or None, path=path or None, ignore_ws=ignore_ws)
    except gitx.GitError as exc:
        return {"ok": False, "error": str(exc)}

    request_id = select_store.push(normalized, scope, ref=ref or "", base=base or "", path=path or "", ignore_ws=ignore_ws)
    branch = ""
    try:
        branch = gitx.branches(normalized)["current"]
    except gitx.GitError:
        pass
    return {"ok": True, "request_id": request_id, "repo": normalized, "branch": branch,
            "scope": scope, "ref": ref, "note": "Desktop pane will reveal this selection on its next poll."}


def register(ctx) -> None:
    """Wire the tool into the agent's registry (called once at plugin load)."""
    ctx.register_tool(name="git_review_select", toolset=TOOLSET, schema=SCHEMA, handler=handle)
