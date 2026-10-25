// One-time setup for render tests: creates node_modules stubs that re-export the
// REAL react/react-dom plus jsx-runtime shims matching the desktop app's runtime,
// so the plugin's own import specifiers resolve under plain node --test.
// CI runs this via `npm install` (postinstall); the desktop app itself is unaffected.
import fs from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), '..')
const nm = path.join(root, 'node_modules')

const JXS = `const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const jsxs = jsx;
const Fragment = Symbol.for('react.fragment');
export { jsx, jsxs, Fragment };
export { default } from 'react';
export * from 'react';
`

async function writeModule(name, code) {
  const dir = path.join(nm, name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, type: 'module', main: 'index.mjs' }))
  await fs.writeFile(path.join(dir, 'index.mjs'), code)
}

await writeModule('react/jsx-runtime', JXS)
await writeModule('react/jsx-dev-runtime', JXS)
await writeModule('@hermes/plugin-sdk', `
// Test stub of the SDK surface — the real SDK exists only inside the desktop app.
// Components render their CHILDREN (unlike the real Radix-based ones, which mount
// content only when open): static render tests can then assert menu/button labels.
const Component = ({ children }) => children ?? null;
let atomValue = '';
const atom = { get: () => atomValue, set: (v) => { atomValue = v; }, reset: () => { atomValue = ''; } };
const host = {
  state: new Proxy({}, { get: () => atom }),
  revealPane: () => true, undismissPane: () => true, paneVisibility: () => atom,
  notify: () => {}, composer: { submit: () => false, getDraft: () => '', setDraft: () => {}, insertText: () => {}, focus: () => {} },
  os: { openExternal: async () => false, revealPath: async () => false, writeClipboard: async () => false, notify: () => {} },
};
export const Badge = Component, Button = Component, Codicon = Component,
  DropdownMenu = Component, DropdownMenuContent = Component, DropdownMenuItem = Component,
  DropdownMenuSeparator = Component, DropdownMenuTrigger = Component,
  EmptyState = Component, ErrorState = Component, SearchField = Component,
  ScrollArea = Component, Switch = Component, Tip = Component,
  ConfirmDialog = Component, Textarea = Component,
  ContextMenu = Component, ContextMenuTrigger = Component, ContextMenuContent = Component,
  ContextMenuItem = Component, ContextMenuSeparator = Component;
export const STATUSBAR_AREAS = { left: 'statusBar.left', right: 'statusBar.right' };
export const KEYBINDS_AREA = 'keybinds';
export const cn = (...v) => v.filter(Boolean).join(' ');
export { host, atom as $hostStateAtom };
export const useValue = (a) => (a && typeof a.get === 'function' ? a.get() : '');
// Mirrors the real SDK atom the pane keys per-session settings on.
export const $activeSessionId = { get: () => null };
`)
console.log('render-test stubs installed (react is the REAL npm react)')
