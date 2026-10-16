## Summary

What does this change do?

## Checks

- [ ] `npm test` passes (unit, desktop smoke harness, import allowlist)
- [ ] `npm run test:layout` passes, or the change cannot affect layout (needs Chromium and the desktop sources)
- [ ] `python -m unittest discover -s tests -v` passes
- [ ] `node --check desktop/plugin.js` passes
- [ ] `hermes plugins doctor . --ci` and `hermes plugins validate .` pass
- [ ] `python scripts/package.py` builds and the zip contains only runtime files and docs
- [ ] No personal identifiers or machine-specific paths outside the LICENSE/author/maintainer lines
- [ ] Behavior changes are covered by tests and noted in CHANGELOG.md
