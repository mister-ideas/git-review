// Isolated Vite fixture using REAL Hermes UI component source + styles.css.
// Only host/i18n/keybind services are doubles. Never starts/restarts the user app.
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import tailwind from '@tailwindcss/vite'
export const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// HERMES_FIXTURES swaps the fixture module (the E2E suite injects a real-backend context).
const fixturesModule = process.env.HERMES_FIXTURES || path.join(project, 'tests/fixtures.mjs')
export async function startLayoutHarness() {
  const desktop = process.env.HERMES_DESKTOP_SOURCE || path.join(os.homedir(), '.hermes/hermes-agent/apps/desktop')
  const src = path.join(desktop, 'src')
  try {
    await fs.access(path.join(src, 'components/ui/search-field.tsx'))
  } catch {
    throw new Error(`Desktop sources not found at ${desktop}. Set HERMES_DESKTOP_SOURCE to your apps/desktop checkout.`)
  }
  const coreRequire = createRequire(path.join(desktop, 'package.json'))
  // Tailwind only scans the project root by default; the real app's utility classes live in the
  // desktop sources, so point it there or menus/icons render unstyled.
  const entryCss = path.join(os.homedir(), '.hermes/cache/scratch/git-review-vite', 'fixture.css')
  await fs.mkdir(path.dirname(entryCss), { recursive: true })
  await fs.writeFile(entryCss, `@import ${JSON.stringify(path.join(src, 'styles.css'))};\n@source ${JSON.stringify(src)};\n`)
  const serviceId = '\0fixture-services'
  const sdkId = '\0fixture-sdk'
  const entryId = '\0fixture-entry'
  const service = `export const useI18n = () => ({t:{ui:{search:{clear:'Clear search'}}}}); export const useKeybindHint = () => '';`
  const ui = name => JSON.stringify(path.join(src, 'components/ui', name + '.tsx'))
  const sdk = `
import React from 'react';
export { Button } from ${ui('button')};
export { Badge } from ${ui('badge')};
export { Codicon } from ${ui('codicon')};
export { SearchField } from ${ui('search-field')};
export { Switch } from ${ui('switch')};
export { Tip } from ${ui('tooltip')};
export { EmptyState } from ${ui('empty-state')};
export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from ${ui('dropdown-menu')};
export { cn } from ${JSON.stringify(path.join(src, 'lib/utils.ts'))};
const atom = v => { let value = v; const subs = new Set(); return { get: () => value, set: next => { value = next; subs.forEach(f => f(next)) }, subscribe: f => { subs.add(f); return () => subs.delete(f) } }; };
export const host = {state:{cwd:atom(''), busy:atom(false), profile:atom(''), connectionId:atom('')},notify:()=>{},revealPane:()=>{},composer:{insertText:(sessionId,text,opts)=>{if(typeof text!=='string')throw new TypeError('insertText(sessionId,text,opts) — text must be the 2nd argument');window.__composerInserts=window.__composerInserts||[];window.__composerInserts.push(text);return Promise.resolve(true)},focus:()=>{}}};
// Reactive atoms: the pane's turn-baseline capture rides the busy rising edge,
// so a static stub could never exercise the Last agent turn scope.
export const useValue = a => { const [, force] = React.useReducer(x => x + 1, 0); React.useEffect(() => (a.subscribe ? a.subscribe(() => force()) : undefined), [a]); return a.get(); };
window.__setBusy = v => host.state.busy.set(v);`
  const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import ${JSON.stringify(entryCss)};
import {GitReview} from ${JSON.stringify(path.join(project, 'desktop/plugin.js'))};
import * as fixtures from ${JSON.stringify(fixturesModule)};
import {host} from '@hermes/plugin-sdk';
const params = new URLSearchParams(location.search);
const storage = new Map([['display.v1',{layout:params.get('layout')||'unified',wordWrap:params.get('wrap')==='true',files:true}]]);
let ctxOptions = {};
try { ctxOptions = JSON.parse(params.get('ctx') || '{}'); } catch { ctxOptions = {}; }
// The app's ThemeProvider injects these brand seeds from the active theme;
// without them every color-mix() in styles.css falls back to a mid gray and the
// pane renders mis-themed. Values are the app's light default (styles.css :root).
const seeds = {
  '--theme-foreground': '#17171a', '--theme-primary': '#0053fd', '--theme-secondary': '#6b6b73',
  '--theme-accent-soft': '#eef1f7', '--theme-midground': '#0053fd', '--theme-warm': '#0053fd',
  '--theme-background-seed': '#ffffff', '--theme-sidebar-seed': '#fafafa', '--theme-card-seed': '#fcfcfc',
  '--theme-elevated-seed': '#ffffff', '--theme-bubble-seed': '#ffffff',
};
for (const [name, value] of Object.entries(seeds)) document.documentElement.style.setProperty(name, value);
window.fixture = fixtures.makeContext({storage, ...ctxOptions});
// The pane reads the focused session's cwd for the turn baseline and for
// workspace-relative citations, so the fixture repo is the focused workspace.
host.state.cwd.set(fixtures.repo || '');
window.sdkProvenance = ${JSON.stringify({ components: src + '/components/ui', styles: src + '/styles.css', services: ['host', 'i18n', 'keybind-hint'] })};
const root = createRoot(document.getElementById('root'));
root.render(React.createElement(GitReview,{ctx:window.fixture.ctx}));
window.unmountFixture=()=>root.unmount();`
  const modules = { [serviceId]: service, [sdkId]: sdk, [entryId]: entry }
  const server = await createServer({
    configFile: false, root: project, cacheDir: path.join(os.homedir(), '.hermes/cache/scratch/git-review-vite'),
    plugins: [tailwind(), {
      name: 'git-review-real-sdk-fixture',
      resolveId(id) {
        if (Object.hasOwn(modules, id)) return id
        if (id === '@hermes/plugin-sdk') return sdkId
        if (id === '/fixture-entry.mjs') return entryId
        if (id === '@/i18n' || id === '@/lib/keybinds/use-keybind-hint' || id === path.join(src, 'i18n') || id === path.join(src, 'lib/keybinds/use-keybind-hint')) return serviceId
        return null
      },
      load(id) { return modules[id] },
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url?.split('?')[0] !== '/') return next()
        res.setHeader('Content-Type', 'text/html')
        res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;width:100%;margin:0}body{background:var(--ui-surface-background);overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/fixture-entry.mjs"></script></body></html>')
      }) },
    }],
    optimizeDeps: { exclude: ['@hermes/plugin-sdk'], include: ['react', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'clsx', 'tailwind-merge', 'class-variance-authority', 'radix-ui', '@tabler/icons-react', '@nanostores/react', 'nanostores'] },
    resolve: { alias: [
      { find: '@hermes/plugin-sdk', replacement: sdkId },
      { find: /^react\/jsx-runtime$/, replacement: coreRequire.resolve('react/jsx-runtime') },
      { find: /^react\/jsx-dev-runtime$/, replacement: coreRequire.resolve('react/jsx-dev-runtime') },
      { find: /^react$/, replacement: coreRequire.resolve('react') },
      { find: /^react-dom\/client$/, replacement: coreRequire.resolve('react-dom/client') },
      { find: /^react-dom$/, replacement: coreRequire.resolve('react-dom') },
      ...['clsx', 'tailwind-merge', 'class-variance-authority', 'radix-ui', '@tabler/icons-react', '@nanostores/react', 'nanostores'].map(name => ({ find: name, replacement: coreRequire.resolve(name) })),
      { find: '@', replacement: src },
    ] },
    server: { host: '127.0.0.1', port: 0, fs: { allow: [project, path.resolve(desktop, '../..')] } },
    esbuild: { jsx: 'automatic' },
  })
  await server.listen()
  return { server, url: server.resolvedUrls.local[0], desktop }
}
