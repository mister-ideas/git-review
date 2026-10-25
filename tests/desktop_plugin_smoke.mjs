// Desktop VM smoke harness — imports the REAL plugin.js with a stubbed SDK/React,
// then asserts the register() contract and registration payloads.
// Usage: node tests/desktop_plugin_smoke.mjs desktop/plugin.js
import fs from 'node:fs/promises'
import process from 'node:process'
import vm from 'node:vm'

const pluginPath = process.argv[2]
if (!pluginPath) throw new Error('desktop plugin path is required')
const source = await fs.readFile(pluginPath, 'utf8')

const registrations = []
const revealed = []
const notifications = []

// Host + SDK stubs are injected INTO the plugin body via stripped imports — the
// loader's blob-import mechanism does the same, so the body references them as
// bare identifiers. Append them to the top of the stripped body.
const inject = `
const { Fragment, jsx, jsxs } = jsxRuntime;
const { useState, useEffect, useMemo, useRef, useCallback, forwardRef } = reactValues;
const { Badge, Button, Codicon, DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger, EmptyState, SearchField, Switch, Tip, cn, host, useValue } = sdkValues;
const sdk = sdkValues;
const ctx = { register: (entry) => registrations.push(entry),
  storage: { get: (k, d) => storage.get(k) ?? d, set: (k, v) => storage.set(k, v) },
  rest: () => Promise.reject(new Error('no backend in smoke test')),
  os: { openExternal: () => Promise.resolve(false) } };
`

// Minimal React stubs: hooks return inert values; jsx/jsxs record their args so a
// crash-level mistake (missing props) would still surface in unit tests, not here.
const reactValues = {
  Fragment: Symbol.for('react.fragment'),
  useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
  useEffect: () => {},
  useMemo: (fn) => fn(),
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
  forwardRef: (fn) => fn,
  useValue: (atom) => (atom && typeof atom.get === 'function' ? atom.get() : ''),
}
const jsxRuntime = {
  Fragment: reactValues.Fragment,
  jsx: (type, props) => ({ type, props: props ?? {} }),
  jsxs: (type, props) => ({ type, props: props ?? {} }),
}

const host = {
  state: new Proxy({}, { get: () => ({ get: () => '' }) }),
  revealPane: (id) => revealed.push(id),
  notify: (n) => notifications.push(n),
  composer: { submit: () => false },
}

// SDK component stubs — anything the plugin imports must exist here or the smoke fails.
const sdkComponent = function Component() {}
const sdkValues = {
  Badge: sdkComponent, Button: sdkComponent, Codicon: sdkComponent,
  DropdownMenu: sdkComponent, DropdownMenuContent: sdkComponent, DropdownMenuItem: sdkComponent,
  DropdownMenuSeparator: sdkComponent, DropdownMenuTrigger: sdkComponent,
  EmptyState: sdkComponent, ErrorState: sdkComponent, SearchField: sdkComponent,
  ScrollArea: sdkComponent, Switch: sdkComponent, Tip: sdkComponent,
  cn: (...v) => v.filter(Boolean).join(' '),
  host,
  useValue: (atom) => (atom && typeof atom.get === 'function' ? atom.get() : ''),
}

const storage = new Map()
const ctx = {
  register: (entry) => registrations.push(entry),
  storage: { get: (k, d) => storage.get(k) ?? d, set: (k, v) => storage.set(k, v) },
  rest: () => Promise.reject(new Error('no backend in smoke test')),
  os: { openExternal: () => Promise.resolve(false) },
}

const moduleImports = new Map([
  ['@hermes/plugin-sdk', sdkValues],
  ['react', reactValues],
  ['react/jsx-runtime', jsxRuntime],
  ['react/jsx-dev-runtime', jsxRuntime],
])

// Strip ESM syntax: imports go away entirely; the export list is removed so the
// `plugin_default` const stays in the script scope. The body runs in a FRESH
// context (declaration errors in the plugin itself must fail loudly, not mix
// with harness globals).
let body = source
  .replace(/^import\s+[^;]+?from\s+['"][^'"]+['"];?\s*$/gm, '')
  .replace(/^export\s*\{[^}]*\};?\s*$/gm, '')

// Extract imported binding names so we can assert they're all stubbed.
const importNames = [...source.matchAll(/import\s*\{([^}]+)\}\s*from/g)]
  .flatMap((m) => m[1].split(',').map((s) => s.trim().split(' as ')[0]))
  .filter(Boolean)

const sandbox = { jsxRuntime, reactValues, sdkValues, registrations, storage, setTimeout, clearTimeout, Promise, URL, URLSearchParams, TextDecoder, Uint8Array }
vm.createContext(sandbox)
vm.runInContext(inject + body, sandbox, { filename: pluginPath })

// Top-level `const` declarations in a vm script live in the script scope, not the
// context object — read them back by running an expression in the SAME context.
const plugin = vm.runInContext('plugin_default', sandbox, { filename: pluginPath })
if (!plugin) throw new Error('smoke: no default export found')
if (typeof plugin.id !== 'string' || !plugin.id) throw new Error('smoke: default export missing string .id')
if (typeof plugin.register !== 'function') throw new Error('smoke: default export missing register(ctx)')
if (typeof plugin.defaultEnabled !== 'boolean') throw new Error('smoke: defaultEnabled should be explicit')

plugin.register(ctx)

const ids = registrations.map((r) => r.id)
if (!ids.includes('pane')) throw new Error('smoke: pane not registered')
if (!ids.includes('open')) throw new Error('smoke: palette command not registered')
for (const r of registrations) {
  if (r.area === 'panes' && typeof r.render !== 'function') throw new Error('smoke: pane render missing')
  if (r.area === 'palette') {
    if (typeof r.data?.run !== 'function') throw new Error('smoke: palette run missing')
    r.data.run() // must not throw
    if (!revealed.includes('git-review:pane')) throw new Error('smoke: palette run did not revealPane')
  }
}

// Every JSX-referenced SDK identifier must be importable (render-time ReferenceError guard).
for (const name of importNames) {
  if (!(name in sdkValues) && !(name in reactValues) && !(name in jsxRuntime)) {
    throw new Error(`smoke: imported "${name}" is not in the allowlist stubs (loader would reject it)`)
  }
}

console.log(`smoke OK: id=${plugin.id} registrations=[${ids.join(', ')}] imports=[${importNames.join(', ')}]`)
