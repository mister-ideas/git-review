"""Serve the REAL git-review backend routes over HTTP for the browser E2E run.

Usage: server.py <port> <hermes_home> — the profile config in <hermes_home> names the
repositories the plugin may expose, exactly like a real install. Nothing is mocked.
"""
import importlib.util
import sys
from pathlib import Path

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

root = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("_gr_http", root / "dashboard" / "plugin_api.py")
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(mod.router)

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
