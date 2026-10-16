// A realistic dataset for the README screenshots, the demo clips and the media
// run (npm run media). The test suite runs against tests/fixtures.mjs instead;
// nothing here is asserted on. Options: empty (no worktrees), select (an agent
// selection that arrives after the pane has primed its poll cursor), pr, fail.
export const repo = '/repositories/acme/storefront'
export const branch = 'feature/invoice-totals'

const ADDED = 'added', DELETED = 'deleted'
// One `diff --git` header per file, as git emits it, with every hunk under it.
function filePatch(path, hunks, mode) {
  const from = mode === ADDED ? '/dev/null' : 'a/' + path
  const to = mode === DELETED ? '/dev/null' : 'b/' + path
  const bodies = hunks.map(([startOld, body, startNew]) => {
    const old = body.filter(l => l.startsWith(' ') || l.startsWith('-')).length
    const neu = body.filter(l => l.startsWith(' ') || l.startsWith('+')).length
    const oldPart = mode === ADDED ? '0,0' : startOld + ',' + old
    const newPart = mode === DELETED ? '0,0' : (startNew == null ? startOld : startNew) + ',' + neu
    return ['@@ -' + oldPart + ' +' + newPart + ' @@', ...body].join('\n')
  })
  return ['diff --git a/' + path + ' b/' + path, '--- ' + from, '+++ ' + to, ...bodies].join('\n')
}
const c = text => ' ' + text
const del = text => '-' + text
const add = text => '+' + text

const totals = [
  c("import { round } from '../util/money'"),
  c("import type { Line } from './types'"),
  c(''),
  del('export function invoiceTotal(lines: Line[]) {'),
  del('  return lines.reduce((sum, line) => sum + line.price * line.qty, 0)'),
  del('}'),
  add('export function lineNet(line: Line): number {'),
  add('  return round(line.price * line.qty)'),
  add('}'),
  add(''),
  add('export function invoiceTotal(lines: Line[]): number {'),
  add('  return round(lines.reduce((sum, line) => sum + lineNet(line), 0))'),
  add('}'),
  c(''),
  c('export function invoiceTax(lines: Line[], rate: number): number {'),
  c('  return round(invoiceTotal(lines.filter(line => line.taxable)) * rate)'),
  c('}'),
  c(''),
  c('export function invoiceGross(lines: Line[], rate: number): number {'),
  c('  return round(invoiceTotal(lines) + invoiceTax(lines, rate))'),
  c('}'),
  c(''),
  c('export function invoiceDiscount(lines: Line[], pct: number): number {'),
  c('  return round(invoiceTotal(lines) * (pct / 100))'),
  c('}'),
  c(''),
  c('export function invoiceNet(lines: Line[], pct: number): number {'),
  c('  return round(invoiceGross(lines, DEFAULT_TAX_RATE) - invoiceDiscount(lines, pct))'),
  c('}'),
  c(''),
  c('export function formatTotal(value: number): string {'),
  c('  return round(value).toFixed(2)'),
  c('}'),
]
const totalsSummary = [
  c('export function summarize(lines: Line[]) {'),
  del('  const total = lines.reduce((sum, line) => sum + line.price * line.qty, 0)'),
  add('  const total = invoiceTotal(lines)'),
  c('  return { total, count: lines.length }'),
  c('}'),
]
const types = [
  c('export interface Line {'),
  c('  price: number'),
  c('  qty: number'),
  add('  taxable: boolean'),
  add('  label?: string'),
  c('}'),
]
const summary = [
  c("import { invoiceTotal } from '../invoice/totals'"),
  c(''),
  c('export function cartSummary(lines: Line[]) {'),
  del('  return { total: lines.reduce((sum, line) => sum + line.price * line.qty, 0) }'),
  add('  return { total: invoiceTotal(lines) }'),
  c('}'),
]
const cart = [
  c('export function addLine(cart: Cart, line: Line) {'),
  c('  const lines = [...cart.lines, line]'),
  del('  return { ...cart, lines, total: lines.length }'),
  add('  return { ...cart, lines, total: invoiceTotal(lines) }'),
  c('}'),
  c(''),
  c('export function removeLine(cart: Cart, index: number) {'),
  del('  return { ...cart, lines: cart.lines.filter((_, i) => i !== index) }'),
  add('  const lines = cart.lines.filter((_, i) => i !== index)'),
  add('  return { ...cart, lines, total: invoiceTotal(lines) }'),
  c('}'),
]
const totalsTest = [
  add("import { describe, expect, it } from 'vitest'"),
  add("import { invoiceTotal, invoiceTax, lineNet } from '../../src/invoice/totals'"),
  add(''),
  add("describe('invoiceTotal', () => {"),
  add("  it('rounds each line before summing', () => {"),
  add('    expect(lineNet({ price: 0.1, qty: 3, taxable: true })).toBe(0.3)'),
  add('    expect(invoiceTotal([{ price: 0.1, qty: 3, taxable: true }])).toBe(0.3)'),
  add('  })'),
  add(''),
  add("  it('ignores tax-exempt lines in invoiceTax', () => {"),
  add('    const lines = ['),
  add('      { price: 10, qty: 1, taxable: true },'),
  add('      { price: 25, qty: 2, taxable: false },'),
  add('    ]'),
  add('    expect(invoiceTax(lines, 0.2)).toBe(2)'),
  add('  })'),
  add('})'),
]
const summaryTest = [
  c("import { cartSummary } from '../../src/cart/summary'"),
  c(''),
  del("it('sums the cart', () => {"),
  del('  expect(cartSummary(lines).total).toBe(61)'),
  add("it('sums the cart through invoiceTotal', () => {"),
  add('  expect(cartSummary(lines).total).toBe(60.999)'),
  c('})'),
]
const legacy = [
  del('export function priceOf(line: Line) {'),
  del('  return line.price * line.qty'),
  del('}'),
  del(''),
  del('export function cartTotal(cart: Cart) {'),
  del('  return cart.lines.reduce((sum, line) => sum + priceOf(line), 0)'),
  del('}'),
  del(''),
  del('export function withTax(cart: Cart, rate: number) {'),
  del('  return cartTotal(cart) * (1 + rate)'),
  del('}'),
]
const docs = [
  c('# Invoices'),
  c(''),
  del('Totals are computed inline wherever they are needed.'),
  add('Totals go through `invoiceTotal`, which rounds each line before summing.'),
  add(''),
  add('Use `invoiceNet` for a discounted, taxed total.'),
]

export const files = [
  'src/invoice/totals.ts', 'src/invoice/types.ts', 'src/cart/summary.ts', 'src/cart/cart.ts',
  'tests/invoice/totals.test.ts', 'tests/cart/summary.test.ts', 'src/legacy/pricing.ts', 'docs/invoice.md',
]
export const mainPatch = filePatch(files[0], [[12, totals]])
const patch = [
  filePatch(files[0], [[12, totals], [88, totalsSummary, 92]]),
  filePatch(files[1], [[4, types]]),
  filePatch(files[2], [[8, summary]]),
  filePatch(files[3], [[6, cart]]),
  filePatch(files[4], [[1, totalsTest]], ADDED),
  filePatch(files[5], [[3, summaryTest]]),
  filePatch(files[6], [[1, legacy]], DELETED),
  filePatch(files[7], [[5, docs]]),
].join('\n')
export const diff = {
  patch,
  added: patch.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).length,
  removed: patch.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---')).length,
  note: '',
}

export const commits = [
  ['4f2b9c1d', 'Extract line-item totals into a pure function', 24, 9],
  ['8c1e4a72', 'Round every line before summing it', 6, 4],
  ['a97d3f05', 'Cover rounding and tax-exempt lines in the totals tests', 18, 0],
  ['2e5b8c61', 'Point the cart summary at invoiceTotal', 3, 3],
  ['b0c47d9e', 'Drop the legacy pricing shim', 0, 12],
  ['61f8a3d4', 'Document the tax rate fallback', 5, 1],
  ['d34e7b28', 'Tidy imports in the invoice module', 4, 4],
  ['9a6c0e17', 'Reformat totals.ts', 31, 31],
  ['7b1d5e93', 'Type the taxable flag on Line', 2, 0],
  ['c48f2a60', 'Rename cart total to invoiceTotal', 8, 8],
].map(([short, subject, added, removed]) => ({ sha: short + 'c5f7'.repeat(6).slice(0, 32), short, subject, added, removed }))

// The file bodies the gap expanders read. `totals` is the NEW side of
// src/invoice/totals.ts line for line, so an expanded gap is consistent with
// the hunks above it; the other files fall back to a plausible generic body.
const header = [
  '// Copyright (c) 2026 Acme Retail',
  '// Licensed under the Apache License, Version 2.0 (the "License");',
  '// you may not use this file except in compliance with the License.',
  '// You may obtain a copy of the License at',
  '//     http://www.apache.org/licenses/LICENSE-2.0',
  '// Unless required by applicable law or agreed to in writing, software',
  '// distributed under the License is distributed on an "AS IS" BASIS,',
  '// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.',
  '// See the License for the specific language governing permissions and',
  '// limitations under the License.',
  '',
]
const totalsNewSide = [
  "import { round } from '../util/money'",
  "import type { Line } from './types'",
  '',
  'export function lineNet(line: Line): number {',
  '  return round(line.price * line.qty)',
  '}',
  '',
  'export function invoiceTotal(lines: Line[]): number {',
  '  return round(lines.reduce((sum, line) => sum + lineNet(line), 0))',
  '}',
  '',
  'export function invoiceTax(lines: Line[], rate: number): number {',
  '  return round(invoiceTotal(lines.filter(line => line.taxable)) * rate)',
  '}',
  '',
  'export function invoiceGross(lines: Line[], rate: number): number {',
  '  return round(invoiceTotal(lines) + invoiceTax(lines, rate))',
  '}',
  '',
  'export function invoiceDiscount(lines: Line[], pct: number): number {',
  '  return round(invoiceTotal(lines) * (pct / 100))',
  '}',
  '',
  'export function invoiceNet(lines: Line[], pct: number): number {',
  '  return round(invoiceGross(lines, DEFAULT_TAX_RATE) - invoiceDiscount(lines, pct))',
  '}',
  '',
  'export function formatTotal(value: number): string {',
  '  return round(value).toFixed(2)',
  '}',
]
const filler = [
  '', 'const DEFAULT_TAX_RATE = 0.2', '',
  'export function taxableLines(lines: Line[]): Line[] {',
  '  return lines.filter(line => line.taxable)',
  '}',
  '',
  'export function lineCount(lines: Line[]): number {',
  '  return lines.length',
  '}',
  '',
  'export function sortLines(lines: Line[]): Line[] {',
  '  return [...lines].sort((a, b) => a.price - b.price)',
  '}',
  '',
  '// Rounding happens per line, never on the summed total.',
  'export function sumRounded(values: number[]): number {',
  '  return round(values.reduce((sum, value) => sum + value, 0))',
  '}',
  '',
]
function buildBody(lines) {
  const out = Array.from({ length: lines }, (_, i) => filler[i % filler.length])
  header.forEach((l, i) => { out[i] = l })
  return out
}
const totalsBody = (() => {
  const out = buildBody(412)
  totalsNewSide.forEach((l, i) => { out[11 + i] = l })
  out[91] = 'export function summarize(lines: Line[]) {'
  out[92] = '  const total = invoiceTotal(lines)'
  out[93] = '  return { total, count: lines.length }'
  out[94] = '}'
  return out
})()
const genericBody = buildBody(240)
const totalsByFile = {
  'src/invoice/totals.ts': 412, 'src/invoice/types.ts': 46, 'src/cart/summary.ts': 38,
  'src/cart/cart.ts': 74, 'tests/cart/summary.test.ts': 52, 'docs/invoice.md': 31,
}

export function makeContext({ storage = new Map(), fail = '', pr = null, select = null, empty = false } = {}) {
  const requests = [], clipboard = [], external = []
  let polls = 0, delivered = false
  const ctx = {
    register() {},
    storage: { get: (k, fallback) => storage.has(k) ? storage.get(k) : fallback, set: (k, v) => storage.set(k, v) },
    rest: async (url, options) => {
      requests.push({ url, options })
      const u = new URL(url, 'http://fixture.local')
      if (u.pathname === fail) throw new Error('fixture backend failure')
      switch (u.pathname) {
        case '/worktrees': return empty
          ? { worktrees: [], version: '0.1.2' }
          : { worktrees: [{ path: repo, name: 'storefront', branch }], version: '0.1.2' }
        case '/meta': return { repo, name: 'storefront', current: branch, local: [branch, 'main'], remote: ['origin/main'] }
        case '/pending-select': {
          polls += 1
          // The pane primes its cursor on the first response; a request that
          // arrives after that is what an agent selection looks like live.
          if (!select || polls < 2 || delivered) return { request: null }
          delivered = true
          return { request: select }
        }
        case '/turn-base': return { repo, base: 'b'.repeat(40), untracked: [], untracked_truncated: false }
        case '/turn-diff': return diff
        case '/pr': return pr
        case '/file-lines': {
          const body = options?.body || {}
          const start = Math.max(1, Number(body.start) || 1)
          const isTotals = body.path === 'src/invoice/totals.ts'
          const file = isTotals ? totalsBody : genericBody
          const total = totalsByFile[body.path] || file.length
          const end = Math.min(Number(body.end) || start, total)
          return { lines: file.slice(start - 1, end), start, end, total }
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
