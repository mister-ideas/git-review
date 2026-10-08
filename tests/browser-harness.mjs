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
export async function startLayoutHarness() {
  const desktop = process.env.HERMES_DESKTOP_SOURCE || path.join(os.homedir(), '.hermes/hermes-agent/apps/desktop')
  const src = path.join(desktop, 'src')
  await fs.access(path.join(src, 'components/ui/search-field.tsx'))
  const coreRequire = createRequire(path.join(desktop, 'package.json'))
  const serviceId = '\0fixture-services'
  const sdkId = '\0fixture-sdk'
  const entryId = '\0fixture-entry'
  const service = `export const useI18n = () => ({t:{ui:{search:{clear:'Clear search'}}}}); export const useKeybindHint = () => '';`
  const ui = name => JSON.stringify(path.join(src, 'components/ui', name + '.tsx'))
  const sdk = `
export { Button } from ${ui('button')};
export { Badge } from ${ui('badge')};
export { Codicon } from ${ui('codicon')};
export { SearchField } from ${ui('search-field')};
export { Switch } from ${ui('switch')};
export { Tip } from ${ui('tooltip')};
export { EmptyState } from ${ui('empty-state')};
export { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from ${ui('dropdown-menu')};
export { cn } from ${JSON.stringify(path.join(src, 'lib/utils.ts'))};
const atom = {get:()=>''};
export const host = {state:{cwd:atom},notify:()=>{},revealPane:()=>{},composer:{insertText:(sessionId,text,opts)=>{if(typeof text!=='string')throw new TypeError('insertText(sessionId,text,opts) — text must be the 2nd argument');window.__composerInserts=window.__composerInserts||[];window.__composerInserts.push(text);return Promise.resolve(true)},focus:()=>{}}};
export const useValue = a => a.get();`
  const entry = `
import React from 'react';
import {createRoot} from 'react-dom/client';
import ${JSON.stringify(path.join(src, 'styles.css'))};
import {GitReview} from ${JSON.stringify(path.join(project, 'desktop/plugin.js'))};
import {makeContext} from ${JSON.stringify(path.join(project, 'tests/fixtures.mjs'))};
const params = new URLSearchParams(location.search);
const storage = new Map([['display.v1',{layout:params.get('layout')||'unified',wordWrap:params.get('wrap')==='true',files:true}]]);
window.fixture = makeContext({storage});
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
        res.end('<!doctype html><html class="dark"><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body,#root{height:100%;width:100%;margin:0}body{background:var(--ui-bg-primary);overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/fixture-entry.mjs"></script></body></html>')
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
