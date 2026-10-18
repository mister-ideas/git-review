// Shared deterministic API fixtures. These are not real repository/API results.
export const repo = '/repositories/architecture/a-very-long-repository-name-for-toolbar-sizing'
export const branch = 'feature/a-very-long-branch-name-for-adaptive-toolbar-sizing'
export const contexts = Array.from({ length: 24 }, (_, i) => ` context-${String(i).padStart(2, '0')}`)
export const longLine = 'unbroken_' + 'X'.repeat(640)
function patch(path, body, deleted = false) {
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, deleted ? '+++ /dev/null' : `+++ b/${path}`, '@@ -10001,28 +10001,29 @@', ...body].join('\n')
}
export const files = ['src/architecture/deep/main.ts', 'src/architecture/deep/other.ts', 'tests/main.test.ts', 'src/deleted.ts']
export const mainPatch = patch(files[0], [...contexts.slice(0, 12), '-old-short', '-old-second', `+${longLine}`, '+new-second', '+new-third', ...contexts.slice(12)])
export const diff = { patch: [mainPatch, patch(files[1], [' shared', '+other']), patch(files[2], ['+test']), patch(files[3], ['-deleted'], true)].join('\n'), added: 5, removed: 3, note: '' }
export const commits = Array.from({ length: 27 }, (_, i) => ({ sha: (i + 1).toString(16).padStart(8, '0') + 'a'.repeat(32), short: (i + 1).toString(16).padStart(8, '0'), subject: `Commit ${i + 1}`, added: 1, removed: 0 }))
export function makeContext({ storage = new Map(), fail = '', pr = null, diffOverride = null } = {}) {
  const served = diffOverride || diff
  const requests = [], clipboard = [], external = []
  const ctx = {
    register() {},
    storage: { get: (k, fallback) => storage.has(k) ? storage.get(k) : fallback, set: (k, v) => storage.set(k, v) },
    rest: async (url, options) => {
      requests.push({ url, options })
      const u = new URL(url, 'http://fixture.local')
      if (u.pathname === fail) throw new Error('fixture backend failure')
      switch (u.pathname) {
        case '/worktrees': return { worktrees: [{ path: repo, name: repo.split('/').at(-1), branch }], version: '0.1.0' }
        case '/meta': return { repo, name: repo.split('/').at(-1), current: branch, local: [branch, 'main'], remote: ['origin/main'] }
        case '/pending-select': return { request: null }
        case '/turn-base': return { repo, base: 'b'.repeat(40), untracked: [], untracked_truncated: false }
        case '/turn-diff': return served
        case '/pr': return pr
        case '/file-lines': {
          const body = options?.body || {}
          const start = Math.max(1, Number(body.start) || 1)
          const total = 10050
          const end = Math.min(Number(body.end) || start, total)
          return { lines: Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => `filler-${start + i}`), start, end, total }
        }
        case '/commits': return { commits, base: 'origin/main' }
        case '/diff': return u.searchParams.get('scope') === 'commits' ? {
          commits: (u.searchParams.get('ref') || '').split(',').filter(Boolean).map(sha => ({ sha, patch: mainPatch })), added: 27, removed: 0,
        } : served
        default: throw new Error('Unexpected fixture route: ' + url)
      }
    },
    os: { writeClipboard: async value => { clipboard.push(value); return true }, openExternal: async value => { external.push(value); return true } },
  }
  return { ctx, requests, clipboard, external, storage }
}
