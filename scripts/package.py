"""Build an installable zip containing only runtime files and user docs.

Usage: python scripts/package.py  → dist/git-review-<version>.zip
Ships the runtime halves and docs; never caches, tests, CI or VCS files.
"""
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
version = next(
    line.split(":", 1)[1].strip().strip('"')
    for line in (root / "plugin.yaml").read_text().splitlines()
    if line.startswith("version:")
)
out = root / "dist"
out.mkdir(exist_ok=True)
archive = out / f"git-review-{version}.zip"

files = [root / name for name in ("plugin.yaml", "__init__.py", "README.md", "LICENSE")]
for directory in ("git_review", "dashboard", "desktop"):
    files.extend(
        p for p in (root / directory).rglob("*")
        if p.is_file() and "__pycache__" not in p.parts and p.suffix != ".pyc"
    )

with ZipFile(archive, "w", ZIP_DEFLATED) as output:
    for path in sorted(files):
        output.write(path, "git-review/" + path.relative_to(root).as_posix())
print(archive)
