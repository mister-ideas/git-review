import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// The pane is painted only from the host's theme tokens, so every Desktop skin
// (light, dark, Catppuccin, Solarized, a user theme) colours it the way it
// colours native panes. A hard-coded `.dark` palette ignored the active skin and
// left the pane a fixed grey island in every dark theme.
const source = fs.readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8');
const start = source.indexOf('const css = `');
const css = source.slice(start, source.indexOf('`;', start));

test('the stylesheet is found', () => {
  assert.ok(start > 0 && css.includes('.grd{'), 'css template literal not found');
});

test('no mode-specific palette: dark comes from the host tokens', () => {
  assert.doesNotMatch(css, /\.dark\s/, 'a .dark rule overrides the host theme');
});

test('no hard-coded colour literals', () => {
  const literals = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(/g) || [];
  assert.deepEqual(literals, [], `hard-coded colours: ${literals.join(', ')}`);
});

test('no light-only constants such as --ui-bg-input', () => {
  // Desktop defines --ui-bg-input once, as #fcfcfc, with no dark value.
  assert.doesNotMatch(css, /var\(--ui-bg-input\b/);
});

test('every colour token the pane uses is one Desktop defines', () => {
  const used = new Set([...css.matchAll(/var\(--(ui-[a-z0-9-]+)/g)].map((m) => m[1]));
  const known = new Set([
    'ui-accent', 'ui-bg-elevated', 'ui-blue', 'ui-orange', 'ui-bg-quinary', 'ui-diff-add-background', 'ui-diff-add-foreground',
    'ui-diff-remove-background', 'ui-diff-remove-foreground', 'ui-green', 'ui-red', 'ui-row-active-background',
    'ui-row-hover-background', 'ui-sash-hover-background', 'ui-sash-hover-border', 'ui-stroke-secondary',
    'ui-stroke-tertiary', 'ui-surface-background', 'ui-text-primary', 'ui-text-secondary', 'ui-text-tertiary',
  ]);
  const unknown = [...used].filter((t) => !known.has(t));
  assert.deepEqual(unknown, [], `tokens Desktop does not define: ${unknown.join(', ')}`);
});

test('no Tailwind arbitrary-value utilities: Desktop only ships the ones core uses', () => {
  const used = [...source.matchAll(/["'\s]((?:text|bg|border|fill|stroke)-\(--[a-z0-9-]+\))/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(used)], [], `utilities that may not exist in Desktop's CSS: ${used.join(', ')}`);
});
