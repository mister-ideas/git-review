#!/usr/bin/env bash
# scripts/sync-desktop.sh
# Sync desktop/plugin.js from the source repo to where the Hermes Desktop loads
# the git-review plugin. Runs on the machine that hosts the Desktop app.
#
# Usage:
#   bash scripts/sync-desktop.sh            # from the git-review repo root
#
# Destination (configurable):
#   GIT_REVIEW_DESKTOP_DIR  (default): ~/.hermes/desktop-plugins/git-review/plugin.js
#   GIT_REVIEW_TARGET_HOST  (default): mister-ideas@192.168.1.50:~/DesktopPlugins
#
set -euo pipefail

SRC_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.."
# Resolve to the git repository root (handles any install path).
if git -C "$SRC_ROOT" rev-parse --show-toplevel >/dev/null 2>&1; then
  SRC_ROOT="$(git -C "$SRC_ROOT" rev-parse --show-toplevel)"
fi
PLUGIN_JS="$SRC_ROOT/desktop/plugin.js"

if [[ ! -f "$PLUGIN_JS" ]]; then
  echo "error: desktop/plugin.js not found at $PLUGIN_JS" >&2
  exit 1
fi

# Target is configured by env, the file $SRC_ROOT/.desktop-sync-target, or defaults.
DEST="${GIT_REVIEW_DESKTOP_DIR:-$HOME/.hermes/desktop-plugins/git-review/plugin.js}"
HOST_TARGET="${GIT_REVIEW_TARGET_HOST:-}"

if [[ "$DEST" == *::* ]] || [[ -n "$HOST_TARGET" ]]; then
  # Remote target: "user@host:path" or "host:path"
  if [[ -n "$HOST_TARGET" ]]; then
    DEST="$HOST_TARGET"
  fi
  # Normalize: user@host:path
  if [[ "$DEST" != *:* ]] && [[ "$DEST" != *::* ]]; then
    # bare path: assume user@localhost
    DEST="$USER@$DEST"
  fi
  # Ensure the remote dir exists
  REMOTE_DIR="$(dirname "$DEST")"
  if ! ssh "${DEST%%:*}" "mkdir -p '${REMOTE_DIR%/*}'"; then
    echo "error: cannot create remote dir ${REMOTE_DIR} (check SSH to $DEST)" >&2
    exit 1
  fi
  if ! rsync -a --rsync-path="mkdir -p '$(dirname "$DEST")' && rsync" "$PLUGIN_JS" "${DEST}"; then
    echo "error: rsync failed for $DEST" >&2
    exit 1
  fi
  echo "synced -> $DEST"
else
  # Local destination (e.g. the machine running Hermes Desktop)
  DEST_DIR="$(dirname "$DEST")"
  mkdir -p "$DEST_DIR"
  cp -f "$PLUGIN_JS" "$DEST"
  echo "synced -> $DEST"
fi
