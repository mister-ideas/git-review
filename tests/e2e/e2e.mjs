// Full-feature E2E: real git repos -> real backend -> real pane + real Hermes UI components.
// Run: npm run test:e2e
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { startStack, project } from './stack.mjs'

const results = []
let page, stack
const consoleProblems = []

async function check(name, fn) {
  try { await page.keyboard.press('Escape'); await fn(); results.push({ name, ok: true }); console.log('PASS', name) }
  catch (e) { results.push({ name, ok: false, error: e.message.split('\n')[0] }); console.error('FAIL', name, '-', e.message.split('\n')[0]) }
}
const grd = () => page.locator('.grd')
const text = async () => (await grd().innerText())
const open = async (query = 'layout=unified&wrap=true', width = 1280) => {
  await page.setViewportSize({ width, height: 900 })
  await page.goto(stack.url(query))
  await page.locator('.af-file').first().waitFor({ timeout: 30000 })
  await page.evaluate(() => document.fonts.ready)
}
const pickScope = async label => {
  await page.locator('.scope-btn').click()
  await page.getByRole('menuitem', { name: label, exact: true }).click()
  await page.waitForTimeout(700)
}
const displayMenu = async () => { await page.getByLabel('Display options').click(); await page.waitForTimeout(150) }
const fileNames = async () => page.$$eval('.af-file .fname, .af-file .af-head .fname', n => n.map(x => x.textContent.trim()))
const agentPush = args => execFileSync(process.env.GIT_REVIEW_PYTHON || 'python3', ['-c',
  `import json,sys;from git_review import select_tool as t;print(json.dumps(t.handle(**json.loads(sys.argv[1]))))`, JSON.stringify(args)],
  { cwd: project, encoding: 'utf8', env: { ...process.env, HERMES_HOME: stack.home, PYTHONPATH: project } })

stack = await startStack()
const browser = await chromium.launch({ headless: true })
try {
  page = await browser.newPage({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' })
  page.on('pageerror', e => consoleProblems.push('pageerror: ' + e.message))
  page.on('response', r => { if (r.status() >= 500) consoleProblems.push(`HTTP ${r.status()} ${r.url()}`) })
  await open()

  // ---- First paint -------------------------------------------------------------
  await check('first paint: scope, counts, repo, branch, all changed files', async () => {
    const t = await text()
    assert.match(t, /Uncommitted/); assert.match(t, /storefront/); assert.match(t, /feature\/invoice-totals/)
    for (const f of ['src/billing/invoice.ts', 'src/legacy/old.ts', 'src/util/money.ts', 'src/ws.ts', 'tests/invoice.test.ts']) assert.ok(t.includes(f), 'missing ' + f)
  })
  await check('OBSERVATION: Uncommitted lists tracked changes only; untracked files appear in Last agent turn', async () => {
    assert.ok(!(await text()).includes('src/new/untracked.ts'), 'behaviour changed: untracked file now in Uncommitted')
  })
  await check('diff lines are colored add/del with real line numbers', async () => {
    assert.ok(await page.locator('.line.add, .add').count() > 0); assert.ok(await page.locator('.line.del, .del').count() > 0)
    assert.ok(await page.locator('.lineno').count() > 0)
  })

  // ---- Scopes ------------------------------------------------------------------
  await check('scope menu offers the five scopes', async () => {
    await page.locator('.scope-btn').click()
    const items = await page.getByRole('menuitem').allInnerTexts()
    await page.keyboard.press('Escape')
    for (const s of ['Last agent turn', 'Uncommitted', 'Staged', 'Unstaged', 'Commits']) assert.ok(items.some(i => i.includes(s)), `scope ${s} missing in ${JSON.stringify(items)}`)
  })
  await check('Staged scope shows only the staged file', async () => {
    await pickScope('Staged'); const t = await text()
    assert.ok(t.includes('src/util/money.ts')); assert.ok(!t.includes('src/billing/invoice.ts'), 'unstaged file leaked into Staged')
  })
  await check('Unstaged scope shows unstaged files, not the staged one', async () => {
    await pickScope('Unstaged'); const t = await text()
    assert.ok(t.includes('src/billing/invoice.ts')); assert.ok(!t.includes('src/util/money.ts'), 'staged file leaked into Unstaged')
  })
  await check('Commits scope: picker lists commits, selecting narrows the diff, Select all / Clear work', async () => {
    await pickScope('Commits')
    await page.locator('.toolbar button', { hasText: /Commits \(/ }).click()
    const items = await page.getByRole('menuitem').allInnerTexts()
    assert.ok(items.some(i => i.includes('add VAT helper')) && items.some(i => i.includes('multiply lines')), JSON.stringify(items))
    await page.getByRole('menuitem', { name: /add VAT helper/ }).click(); await page.waitForTimeout(900)
    assert.ok(!(await text()).includes('tax.ts'), 'unchecked commit still in the diff')
    await page.getByRole('menuitem', { name: 'Clear' }).click(); await page.waitForTimeout(600)
    await page.getByRole('menuitem', { name: 'Select all' }).click(); await page.waitForTimeout(900)
    assert.ok((await text()).includes('tax.ts'), 'Select all did not restore the commit')
    await page.keyboard.press('Escape')
  })
  await check('Last agent turn scope is empty before any agent turn', async () => {
    await pickScope('Last agent turn')
    assert.ok(await page.locator('.af-file').count() === 0, 'files shown with no agent turn')
  })
  await check('Last agent turn: busy edge captures baseline, then shows only that turn\'s edits', async () => {
    await page.evaluate(() => window.__setBusy(true)); await page.waitForTimeout(1500)
    fs.writeFileSync(path.join(stack.repos.main, 'README.md'), '# storefront\n\nEdited by the agent turn.\n')
    fs.writeFileSync(path.join(stack.repos.main, 'src/agent-made.ts'), 'export const made = true\n')
    await page.evaluate(() => window.__setBusy(false)); await page.waitForFunction(() => document.querySelector('.grd')?.innerText.includes('agent-made.ts'), null, { timeout: 15000 })
    const t = await text()
    assert.ok(t.includes('README.md') && t.includes('agent-made.ts'), 'turn edits not shown: ' + t.slice(0, 200))
    assert.ok(t.includes('src/new/untracked.ts') === false, 'untracked file present before the turn must not be reported as new')
  })
  await pickScope('Uncommitted').catch(() => {})

  // ---- Display options ---------------------------------------------------------
  await check('layout: Split shows paired rows; Unified restores', async () => {
    await displayMenu(); await page.getByRole('menuitem', { name: /Split/ }).click(); await page.waitForTimeout(500)
    assert.ok(await page.locator('.split-row').count() > 0, 'no split rows')
    await displayMenu(); await page.getByRole('menuitem', { name: /Unified/ }).click(); await page.waitForTimeout(500)
    assert.equal(await page.locator('.split-row').count(), 0)
  })
  await check('Ignore whitespace hides the whitespace-only file', async () => {
    await displayMenu(); await page.getByLabel('Ignore whitespace').click(); await page.keyboard.press('Escape'); await page.waitForTimeout(1000)
    assert.ok(!(await text()).includes('src/ws.ts'), 'ws-only change still listed')
    await displayMenu(); await page.getByLabel('Ignore whitespace').click(); await page.keyboard.press('Escape'); await page.waitForTimeout(800)
    assert.ok((await text()).includes('src/ws.ts'))
  })
  await check('display settings persist in plugin storage', async () => {
    const saved = await page.evaluate(() => window.fixture.storage.get('display.v1'))
    assert.ok(saved && saved.layout === 'unified', JSON.stringify(saved))
  })
  await check('Collapse all collapses every diff body', async () => {
    await page.getByLabel('Collapse all').click(); await page.waitForTimeout(400)
    assert.equal(await page.locator('.diff .line, .splitwrap .split-row').count(), 0)
  })
  await check('per-file toggle expands one file again', async () => {
    await page.getByLabel(/^Expand diff for src\/ws\.ts/).click(); await page.waitForTimeout(300)
    assert.ok(await page.locator('.diff .line').count() > 0)
  })
  await check('file list hides and shows', async () => {
    await page.getByLabel('Hide file list').click(); await page.waitForTimeout(300)
    assert.equal(await page.locator('.tree-side, .tree').count(), 0, 'tree still visible')
    await page.getByLabel('Show file list').click(); await page.waitForTimeout(300)
    assert.ok(await page.locator('.tree-side, .tree').count() > 0)
  })

  // ---- Navigation, search, filters ---------------------------------------------
  await open()
  await check('clicking a file in the tree scrolls its diff into view', async () => {
    await page.locator('.tree').getByText('invoice.test.ts').first().click(); await page.waitForTimeout(700)
    const inView = await page.locator('.af-file', { hasText: 'tests/invoice.test.ts' }).first().evaluate(e => { const r = e.getBoundingClientRect(); return r.top < innerHeight && r.bottom > 0 })
    assert.ok(inView, 'target file diff is not in the viewport')
  })
  await check('Search files narrows the list', async () => {
    await page.getByLabel('Search files').fill('ws'); await page.waitForTimeout(500)
    const n = await page.locator('.af-file').count(); assert.ok(n >= 1 && n < 5, 'expected narrowed list, got ' + n)
    await page.getByLabel('Search files').fill(''); await page.waitForTimeout(300)
  })
  await check('filters: hide deleted files, hide test files', async () => {
    await page.getByLabel('Show filters').click()
    await page.getByRole('menuitem', { name: /deleted/i }).click(); await page.waitForTimeout(500)
    assert.ok(!(await text()).includes('src/legacy/old.ts'), 'deleted file still shown')
    await page.getByLabel('Show filters').click()
    await page.getByRole('menuitem', { name: /test/i }).click(); await page.waitForTimeout(500)
    assert.ok(!(await text()).includes('tests/invoice.test.ts'), 'test file still shown')
  })
  await open()
  await check('Copy path writes the path to the clipboard', async () => {
    await page.getByLabel('Copy path for src/billing/invoice.ts').click(); await page.waitForTimeout(300)
    const clip = await page.evaluate(() => window.fixture.clipboard); assert.deepEqual(clip, ['src/billing/invoice.ts'])
  })

  // ---- Fold / expand gaps ------------------------------------------------------
  await check('gap bar: expand 20 lines below, then expand all fetches real file lines', async () => {
    const before = await page.locator('.line').count()
    await page.getByLabel(/^Expand 20 unchanged lines below for src\/billing\/invoice\.ts/).click(); await page.waitForTimeout(800)
    const mid = await page.locator('.line').count(); assert.ok(mid > before, 'expand-below added no rows')
    await page.getByLabel(/^Expand all remaining unchanged lines for src\/billing\/invoice\.ts/).click().catch(() => {}); await page.waitForTimeout(800)
    assert.match(await text(), /padding line 3[0-9]/)
  })

  // ---- Cite --------------------------------------------------------------------
  await check('click a line then Cite in message inserts an @file:line reference', async () => {
    await page.locator('.line.add').first().click(); await page.locator('.line.add').nth(1).click({ modifiers: ['Shift'] }); await page.waitForTimeout(300)
    await page.getByLabel('Cite selected lines in focused message draft').click(); await page.waitForTimeout(300)
    const ins = await page.evaluate(() => window.__composerInserts || []); assert.ok(ins.length === 1 && /^@line:[^:]+:\d+-\d+$/.test(ins[0]), JSON.stringify(ins))
  })
  await check('Clear line selection dismisses the cite bar', async () => {
    await page.locator('.line.add').first().click(); await page.locator('.line.add').nth(1).click({ modifiers: ['Shift'] }); await page.waitForTimeout(200)
    await page.getByLabel('Clear line selection').click(); await page.waitForTimeout(200)
    assert.equal(await page.locator('.cite-bar').count(), 0)
  })

  // ---- Repository switching & empty state --------------------------------------
  await check('repo menu lists configured repos and switches to a clean one with an empty state', async () => {
    await page.locator('.repo-menu, .repo-label').first().click(); await page.waitForTimeout(200)
    await page.getByRole('menuitem', { name: /clean-repo/ }).click(); await page.waitForTimeout(1000)
    const t = await text(); assert.ok(t.includes('clean-repo')); assert.equal(await page.locator('.af-file').count(), 0)
  })

  // ---- Agent tool -> pane ------------------------------------------------------
  await open()
  await check('agent git_review_select reveals a scope in the open pane (real tool, real store)', async () => {
    const res = JSON.parse(agentPush({ repo: stack.repos.main, scope: 'staged' })); assert.equal(res.ok, true, JSON.stringify(res))
    await page.waitForFunction(() => document.querySelector('.scope-btn')?.textContent.includes('Staged'), null, { timeout: 25000 })
    assert.ok((await text()).includes('src/util/money.ts'))
  })
  await check('agent tool rejects a non-repo path with a clear error', async () => {
    const res = JSON.parse(agentPush({ repo: os.tmpdir() })); assert.equal(res.ok, false); assert.ok(res.error)
  })

  // ---- Responsive --------------------------------------------------------------
  for (const w of [380, 720]) await check(`${w}px dock: toolbar and diff stay usable`, async () => {
    await open('layout=unified&wrap=true', w)
    const o = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }))
    assert.ok(o.s <= o.c + 1, `horizontal overflow ${o.s} > ${o.c}`)
  })

  // ---- Backend failure ---------------------------------------------------------
  await check('backend down: the pane shows an error state instead of crashing', async () => {
    await open(); stack.server.kill('SIGTERM'); await page.waitForTimeout(500)
    await pickScope('Staged'); await page.waitForTimeout(1500)
    assert.ok(await grd().isVisible(), 'pane vanished')
  })
  await check('no uncaught page errors or 5xx responses during the whole run', async () => assert.deepEqual(consoleProblems, []))
} finally {
  await browser.close(); await stack.stop()
}
const failed = results.filter(r => !r.ok)
console.log(`\n${results.length - failed.length} passed; ${failed.length} failed.`)
process.exit(failed.length ? 1 : 0)
