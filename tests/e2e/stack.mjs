// Starts the full E2E stack: real git repos, the real backend (Python/FastAPI) with a
// profile config that authorizes them, and the real pane built against the real
// Hermes UI components. Returns urls + a stop() that tears everything down.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { makeRepos } from './make-repos.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
export const project = path.resolve(here, '../..')
const freePort = () => new Promise(resolve => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) }) })

export async function startStack() {
  const base = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'git-review-e2e-'))
  const repos = makeRepos(path.join(base, 'repos'))
  const home = path.join(base, 'hermes-home')
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'config.yaml'), `terminal:\n  cwd: ${repos.main}\nplugins:\n  entries:\n    git-review:\n      settings:\n        repos: |\n          ${repos.clean}\n`)
  const py = process.env.GIT_REVIEW_PYTHON || 'python3'
  const port = await freePort()
  const server = spawn(py, [path.join(here, 'server.py'), String(port), home], {
    cwd: project, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, HERMES_HOME: home, PYTHONPATH: project, GIT_CONFIG_GLOBAL: os.devnull },
  })
  let log = ''
  server.stdout.on('data', d => { log += d }); server.stderr.on('data', d => { log += d })
  const backend = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(backend + '/worktrees')).ok) break } catch { /* not up yet */ }
    if (server.exitCode !== null) throw new Error('backend exited early:\n' + log)
    await new Promise(r => setTimeout(r, 100))
    if (i === 99) throw new Error('backend never became ready:\n' + log)
  }
  process.env.HERMES_FIXTURES = path.join(here, 'real-context.mjs')
  const { startLayoutHarness } = await import('../browser-harness.mjs')
  const harness = await startLayoutHarness()
  return {
    base, home, repos, backend, server, harness,
    url: (query = '') => `${harness.url}?backend=${encodeURIComponent(backend)}&repo=${encodeURIComponent(repos.main)}${query ? '&' + query : ''}`,
    log: () => log,
    async stop() { await harness.server.close(); server.kill('SIGTERM'); fs.rmSync(base, { recursive: true, force: true }) },
  }
}
