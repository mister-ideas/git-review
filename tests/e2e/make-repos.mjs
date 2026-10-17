// Builds real git repositories for the E2E run: no mocks, every diff comes from git.
// `main` has history; `feature/invoice-totals` adds commits ahead of main, then
// leaves staged, unstaged, untracked, deleted, renamed and whitespace-only changes.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8',
  env: { ...process.env, GIT_CONFIG_GLOBAL: os.devnull, GIT_CONFIG_SYSTEM: os.devnull,
    GIT_AUTHOR_NAME: 'Ada Dev', GIT_AUTHOR_EMAIL: 'ada@example.com', GIT_COMMITTER_NAME: 'Ada Dev', GIT_COMMITTER_EMAIL: 'ada@example.com' },
}).trim()
const write = (root, rel, text) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text) }
const lines = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix} line ${i + 1}`).join('\n') + '\n'

export function makeRepos(base) {
  fs.rmSync(base, { recursive: true, force: true })
  const main = path.join(base, 'storefront')
  fs.mkdirSync(main, { recursive: true })
  git(main, 'init', '-q', '-b', 'main')
  write(main, 'src/billing/invoice.ts', `import { round } from '../util/money'\n\nexport function invoiceTotal(lines: number[]) {\n  let total = 0\n  for (const l of lines) total += l\n  return round(total)\n}\n\n${lines('// padding', 60)}export const VERSION = 1\n`)
  write(main, 'src/util/money.ts', 'export const round = (n: number) => Math.round(n * 100) / 100\n')
  write(main, 'src/legacy/old.ts', 'export const legacy = true\n')
  write(main, 'src/ws.ts', 'function f() {\n  return 1\n}\n')
  write(main, 'tests/invoice.test.ts', "import { invoiceTotal } from '../src/billing/invoice'\ntest('sums', () => expect(invoiceTotal([1, 2])).toBe(3))\n")
  write(main, 'README.md', '# storefront\n')
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'initial storefront')
  git(main, 'checkout', '-qb', 'feature/invoice-totals')
  write(main, 'src/billing/tax.ts', 'export const vat = (n: number) => n * 0.2\n')
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'billing: add VAT helper')
  const inv = fs.readFileSync(path.join(main, 'src/billing/invoice.ts'), 'utf8').replace('total += l', 'total += l * 1')
  write(main, 'src/billing/invoice.ts', inv)
  git(main, 'add', '-A'); git(main, 'commit', '-qm', 'billing: multiply lines explicitly')
  write(main, 'src/util/money.ts', 'export const round = (n: number) => Math.round(n * 100) / 100\nexport const cents = (n: number) => Math.round(n * 100)\n')
  git(main, 'add', 'src/util/money.ts') // staged only
  const inv2 = fs.readFileSync(path.join(main, 'src/billing/invoice.ts'), 'utf8')
    .replace('export const VERSION = 1', 'export const VERSION = 2\nexport const CURRENCY = "EUR"')
    .replace('  let total = 0', '  let total = 0 // running sum')
  write(main, 'src/billing/invoice.ts', inv2) // unstaged, two hunks far apart => a foldable gap between them
  write(main, 'src/ws.ts', 'function f() {\n    return 1\n}\n') // whitespace-only
  fs.rmSync(path.join(main, 'src/legacy/old.ts')) // deleted
  write(main, 'tests/invoice.test.ts', "import { invoiceTotal } from '../src/billing/invoice'\ntest('sums', () => expect(invoiceTotal([1, 2])).toBe(3))\ntest('empty', () => expect(invoiceTotal([])).toBe(0))\n")
  write(main, 'src/new/untracked.ts', 'export const fresh = 1\n') // untracked
  const clean = path.join(base, 'clean-repo')
  fs.mkdirSync(clean, { recursive: true })
  git(clean, 'init', '-q', '-b', 'main'); write(clean, 'a.txt', 'a\n'); git(clean, 'add', '-A'); git(clean, 'commit', '-qm', 'init')
  const shas = git(main, 'log', '--format=%H', 'main..HEAD').split('\n')
  return { main, clean, shas, branch: 'feature/invoice-totals' }
}
