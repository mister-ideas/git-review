// Browser-side plugin context whose ctx.rest talks to the REAL git-review backend.
// Only the Hermes host shell (clipboard, openExternal, composer) is a recording double.
// BACKEND and REPO are injected by run.mjs via the ?backend=...&repo=... query.
const q = new URLSearchParams(location.search)
const BACKEND = q.get('backend') || ''
export const repo = q.get('repo') || ''

export function makeContext({ storage = new Map() } = {}) {
  const requests = [], clipboard = [], external = []
  const ctx = {
    register() {},
    storage: { get: (k, fallback) => storage.has(k) ? storage.get(k) : fallback, set: (k, v) => storage.set(k, v) },
    rest: async (url, options = {}) => {
      requests.push({ url, options })
      const init = { method: options.method || 'GET' }
      if (options.body !== undefined) { init.body = JSON.stringify(options.body); init.headers = { 'content-type': 'application/json' } }
      const res = await fetch(BACKEND + url, init)
      const text = await res.text()
      if (!res.ok) throw new Error(`${res.status} ${text}`)
      return text ? JSON.parse(text) : null
    },
    os: { writeClipboard: async value => { clipboard.push(value); return true }, openExternal: async value => { external.push(value); return true } },
  }
  return { ctx, requests, clipboard, external, storage }
}
