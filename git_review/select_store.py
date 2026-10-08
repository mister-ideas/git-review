"""Pending pane-selection requests, shared between the agent and HTTP processes.

The git_review_select tool (agent process) pushes a request here; the desktop
pane polls the /pending-select route (gateway process) and applies it. SQLite
in the plugin-data dir is the transport — the same pattern hermes-session-diff
uses for its journal.
"""

from __future__ import annotations

import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS pending_select (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo TEXT NOT NULL,
  scope TEXT NOT NULL,
  ref TEXT NOT NULL DEFAULT '',
  base TEXT NOT NULL DEFAULT '',
  path TEXT NOT NULL DEFAULT '',
  ignore_ws INTEGER NOT NULL DEFAULT 0,
  created REAL NOT NULL);
"""


def data_root() -> Path:
    home = os.environ.get("HERMES_HOME", "").strip() or str(Path.home() / ".hermes")
    return Path(home).expanduser() / "plugin-data" / "git-review"


@contextmanager
def connect():
    root = data_root()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    db = sqlite3.connect(root / "select.sqlite3", timeout=5, isolation_level=None)
    db.row_factory = sqlite3.Row
    try:
        db.execute("PRAGMA journal_mode=WAL")
        db.executescript(SCHEMA)
        yield db
    finally:
        db.close()


def push(repo: str, scope: str, ref: str = "", base: str = "", path: str = "", ignore_ws: bool = False) -> int:
    with connect() as db:
        cur = db.execute(
            "INSERT INTO pending_select(repo,scope,ref,base,path,ignore_ws,created) VALUES (?,?,?,?,?,?,?)",
            (repo, scope, ref, base, path, 1 if ignore_ws else 0, time.time()))
        db.execute("DELETE FROM pending_select WHERE id <= ? AND id NOT IN "
                   "(SELECT id FROM pending_select ORDER BY id DESC LIMIT 20)", (cur.lastrowid,))
        return cur.lastrowid


def latest() -> dict | None:
    with connect() as db:
        row = db.execute("SELECT * FROM pending_select ORDER BY id DESC LIMIT 1").fetchone()
        if not row:
            return None
        return {"id": row["id"], "repo": row["repo"], "scope": row["scope"], "ref": row["ref"],
                "base": row["base"], "path": row["path"], "ignore_ws": bool(row["ignore_ws"]), "created": row["created"]}
