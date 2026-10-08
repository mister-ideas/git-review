"""Git review plugin — read-only pane and an agent selection tool.
The dashboard loader mounts dashboard/plugin_api.py via manifest.json."""

from .git_review.select_tool import register as _register_tool


def register(ctx):
    _register_tool(ctx)
