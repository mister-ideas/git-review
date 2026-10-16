// A realistic dataset for the README screenshots (npm run shots). The test suite
// runs against tests/fixtures.mjs instead; nothing here is asserted on.
export const repo = '/repositories/acme/storefront'
export const branch = 'feature/invoice-totals'

function hunk(path, startOld, body, deleted = false) {
  const old = body.filter(l => l.startsWith(' ') || l.startsWith('-')).length
  const neu = body.filter(l => l.startsWith(' ') || l.startsWith('+')).length
  return ['diff --git a/' + path + ' b/' + path, '--- a/' + path, deleted ? '+++ /dev/null' : '+++ b/' + path,
    '@@ -' + startOld + ',' + old + ' +' + startOld + ',' + neu + ' @@', ...body].join('\n')
}

const totalsBody = [
  " import { round } from '../util/money'",
  " import type { Line } from './types'",
  " ",
  '-export function invoiceTotal(lines: Line[]) {',
  '-  return lines.reduce((sum, line) => sum + line.price * line.qty, 0)',
  '-}',
  '+export function lineNet(line: Line): number {',
  '+  return round(line.price * line.qty)',
  '+}',
  '+',
  '+export function invoiceTotal(lines: Line[]): number {',
  '+  return round(lines.reduce((sum, line) => sum + lineNet(line), 0))',
  '+}',
  " ",
  ' export function invoiceTax(lines: Line[], rate: number): number {',
  '   return round(invoiceTotal(lines.filter(line => line.taxable)) * rate)',
  ' }',
  " ",
  ' export function invoiceGross(lines: Line[], rate: number): number {',
  '   return round(invoiceTotal(lines) + invoiceTax(lines, rate))',
  ' }',
]
const summaryBody = [
  " import { invoiceTotal } from '../invoice/totals'",
  " ",
  ' export function cartSummary(lines: Line[]) {',
  '-  return { total: lines.reduce((sum, line) => sum + line.price * line.qty, 0) }',
  '+  return { total: invoiceTotal(lines) }',
  ' }',
]
const testBody = [
  " import { invoiceTotal, lineNet } from '../../src/invoice/totals'",
  " ",
  '+describe("invoiceTotal", () => {',
  '+  it("rounds each line before summing", () => {',
  '+    expect(lineNet({ price: 0.1, qty: 3 })).toBe(0.3)',
  '+    expect(invoiceTotal([{ price: 0.1, qty: 3 }])).toBe(0.3)',
  '+  })',
  '+})',
]
const legacyBody = [
  '-export function priceOf(line: Line) {',
  '-  return line.price * line.qty',
  '-}',
]

export const files = ['src/invoice/totals.ts', 'src/cart/summary.ts', 'tests/invoice/totals.test.ts', 'src/legacy/pricing.ts']
export const mainPatch = hunk(files[0], 12, totalsBody)
const patch = [mainPatch, hunk(files[1], 8, summaryBody), hunk(files[2], 1, testBody), hunk(files[3], 1, legacyBody, true)].join('\n')
export const diff = {
  patch,
  added: patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
  removed: patch.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length,
  note: '',
}

export const commits = [
  ['4f2b9c1d', 'Extract line-item totals into a pure function', 24, 9],
  ['8c1e4a72', 'Round every line before summing it', 6, 4],
  ['a97d3f05', 'Cover rounding in the totals tests', 18, 0],
  ['2e5b8c61', 'Point the cart summary at invoiceTotal', 3, 3],
  ['b0c47d9e', 'Drop the legacy pricing shim', 0, 12],
  ['61f8a3d4', 'Document the tax rate fallback', 5, 1],
  ['d34e7b28', 'Tidy imports in the invoice module', 4, 4],
  ['9a6c0e17', 'Reformat totals.ts', 31, 31],
].map(([short, subject, added, removed]) => ({ sha: short + 'c5f7'.repeat(6).slice(0, 32), short, subject, added, removed }))

const source = [
  "import { round } from '../util/money'",
  "import type { Line } from './types'",
  '',
  'const DEFAULT_TAX_RATE = 0.2',
  '',
  'export function lineNet(line: Line): number {',
  '  return round(line.price * line.qty)',
  '}',
  '',
  'export function invoiceTotal(lines: Line[]): number {',
  '  return round(lines.reduce((sum, line) => sum + lineNet(line), 0))',
  '}',
  '',
  'export function invoiceTax(lines: Line[], rate = DEFAULT_TAX_RATE): number {',
  '  return round(invoiceTotal(lines.filter(line => line.taxable)) * rate)',
  '}',
  '',
  'export function invoiceGross(lines: Line[], rate = DEFAULT_TAX_RATE): number {',
  '  return round(invoiceTotal(lines) + invoiceTax(lines, rate))',
  '}',
]

export function makeContext({ storage = new Map(), fail = '', pr = null } = {}) {
  const requests = [], clipboard = [], external = []
  const ctx = {
    register() {},
    storage: { get: (k, fallback) => storage.has(k) ? storage.get(k) : fallback, set: (k, v) => storage.set(k, v) },
    rest: async (url, options) => {
      requests.push({ url, options })
      const u = new URL(url, 'http://fixture.local')
      if (u.pathname === fail) throw new Error('fixture backend failure')
      switch (u.pathname) {
        case '/worktrees': return { worktrees: [{ path: repo, name: 'storefront', branch }], version: '0.1.2' }
        case '/meta': return { repo, name: 'storefront', current: branch, local: [branch, 'main'], remote: ['origin/main'] }
        case '/pending-select': return { request: null }
        case '/turn-base': return { repo, base: 'b'.repeat(40), untracked: [], untracked_truncated: false }
        case '/turn-diff': return diff
        case '/pr': return pr
        case '/file-lines': {
          const body = options?.body || {}
          const start = Math.max(1, Number(body.start) || 1)
          const total = 412
          const end = Math.min(Number(body.end) || start, total)
          return { lines: Array.from({ length: Math.max(0, end - start + 1) }, (_, i) => source[(start + i - 1) % source.length]), start, end, total }
        }
        case '/commits': return { commits, base: 'origin/main' }
        case '/diff': return u.searchParams.get('scope') === 'commits' ? {
          commits: (u.searchParams.get('ref') || '').split(',').filter(Boolean).map(sha => ({ sha, patch: mainPatch })), added: 27, removed: 0,
        } : diff
        default: throw new Error('Unexpected fixture route: ' + url)
      }
    },
    os: { writeClipboard: async value => { clipboard.push(value); return true }, openExternal: async value => { external.push(value); return true } },
  }
  return { ctx, requests, clipboard, external, storage }
}
