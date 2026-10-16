// Run: npm run test:layout. Requires installed Hermes desktop sources/deps.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { chromium } from 'playwright'
import { startLayoutHarness } from './browser-harness.mjs'
import { files } from './fixtures.mjs'

let server, browser
const failures = [], results = [], consoleErrors = []
const artifactDir = path.join(os.homedir(), '.hermes/cache/scratch/git-review-layout')
await fs.mkdir(artifactDir, { recursive: true })
async function check(name, fn) {
  try { await fn(); results.push({ name, passed: true }); console.log('PASS', name) }
  catch (error) { failures.push({ name, error: error.message }); results.push({ name, passed: false, error: error.message }); console.error('FAIL', name, error.message) }
}
try {
  const harness = await startLayoutHarness()
  server = harness.server
  console.log('Actual SDK components/styles from:', harness.desktop, '(host/i18n/keybind services mocked)')
  browser = await chromium.launch({ headless: true })
  const toolbarWidths = {}
  for (const width of [380, 720, 1280]) for (const layout of ['unified', 'split']) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: 'reduce' })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    const label = `${width}px ${layout}`
    try {
      await page.goto(`${harness.url}?layout=${layout}&wrap=true`)
      await page.locator('.af-file').first().waitFor({ timeout: 45000 })
      await page.evaluate(() => document.fonts.ready)
      await check(`${label}: real SDK provenance and no runtime errors`, async () => {
        assert.ok(await page.evaluate(() => window.sdkProvenance.components.endsWith('/components/ui')))
        assert.deepEqual(errors, [])
        assert.ok(await page.locator('button[data-slot="button"]').count() > 0, 'actual SDK Button markup missing; do not test SDK stubs')
        assert.equal(await page.locator('.af-file').count(), files.length)
      })
      // Capture the pane in its default state (every file expanded, real diff rows
      // visible) before the checks below mutate it; PR assets come from here.
      await page.screenshot({ path: path.join(artifactDir, `${width}-${layout}.png`) })
      await check(`${label}: wrap long unbroken text without clipping/overflow`, async () => {
        const metrics = await page.evaluate(() => {
          const code = [...document.querySelectorAll('.linecode')].find(n => n.textContent.includes('unbroken_'))
          const parent = code.closest('.line'), diff = code.closest('.diff,.splitwrap')
          const r = code.getBoundingClientRect(), p = parent.getBoundingClientRect()
          return { scroll: diff.scrollWidth, client: diff.clientWidth, codeScroll: code.scrollWidth, codeClient: code.clientWidth, height: r.height, lineHeight: parseFloat(getComputedStyle(code).lineHeight), right: r.right, parentRight: p.right, rootScroll: document.documentElement.scrollWidth, viewport: innerWidth }
        })
        assert.ok(metrics.height > metrics.lineHeight * 2, `long text did not visibly wrap: ${JSON.stringify(metrics)}`)
        assert.ok(metrics.scroll <= metrics.client + 1 && metrics.codeScroll <= metrics.codeClient + 1, `hidden overflow/clipping: ${JSON.stringify(metrics)}`)
        assert.ok(metrics.right <= metrics.parentRight + 1)
        assert.ok(metrics.rootScroll <= metrics.viewport + 1)
      })
      await check(`${label}: actual SDK search glyph inside field, filter same row`, async () => {
        const g = await page.evaluate(() => {
          const input = document.querySelector('input[aria-label="Search files"]')
          const field = input.parentElement, icon = field.querySelector('svg'), filter = document.querySelector('[aria-label="Show filters"]')
          const rect = n => { const r = n.getBoundingClientRect(); return { x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height } }
          return { field: rect(field), input: rect(input), icon: icon && rect(icon), filter: rect(filter), pseudo: getComputedStyle(field, '::before').content }
        })
        assert.ok(g.icon && g.icon.width > 0, 'actual SDK Search SVG missing')
        assert.ok(g.icon.x >= g.field.x && g.icon.right <= g.field.right && g.icon.y >= g.field.y && g.icon.bottom <= g.field.bottom)
        assert.ok(g.icon.right <= g.input.x + 1, 'icon overlaps input text')
        assert.ok(Math.abs((g.field.y + g.field.height / 2) - (g.filter.y + g.filter.height / 2)) <= 2, `filter wrapped: ${JSON.stringify(g)}`)
        assert.ok(g.filter.x >= g.field.right - 1)
        assert.ok(['none', 'normal', '""'].includes(g.pseudo), 'duplicate pseudo search icon')
      })
      await check(`${label}: valid opaque sticky headers and consistent five-digit gutters`, async () => {
        const data = await page.evaluate(() => ({
          headers: [...document.querySelectorAll('.af-head')].map(n => ({ bg:getComputedStyle(n).backgroundColor,position:getComputedStyle(n).position,top:getComputedStyle(n).top })),
          gutters: [...document.querySelectorAll('.lineno')].filter(n => n.textContent.trim()).map(n => ({ width:n.getBoundingClientRect().width,scroll:n.scrollWidth,client:n.clientWidth,text:n.textContent.trim() })),
        }))
        for (const h of data.headers) {
          assert.equal(h.position, 'sticky'); assert.equal(h.top, '0px')
          assert.ok(h.bg !== 'transparent' && !/rgba\(.*?,\s*0\)/.test(h.bg), `transparent header ${h.bg}`)
          if (h.bg.startsWith('rgba')) assert.ok(/,\s*1\)$/.test(h.bg), `non-opaque header ${h.bg}`)
          if (h.bg.includes('/')) assert.ok(/\/\s*1\s*\)$/.test(h.bg), `non-opaque header ${h.bg}`)
        }
        assert.ok(data.gutters.some(g => g.text.length === 5))
        assert.ok(Math.max(...data.gutters.map(g => g.width)) - Math.min(...data.gutters.map(g => g.width)) < 1)
        for (const g of data.gutters) assert.ok(g.scroll <= g.client + 1, `gutter clipped: ${JSON.stringify(g)}`)
        // Verify actual sticky behavior after scrolling, not only CSS declarations.
        await page.locator('.allfiles').evaluate(n => { n.scrollTop = 80 })
        await page.evaluate(() => new Promise(requestAnimationFrame))
        const geometry = await page.evaluate(() => ({head:document.querySelector('.af-head').getBoundingClientRect().top,scroller:document.querySelector('.allfiles').getBoundingClientRect().top}))
        assert.ok(Math.abs(geometry.head - geometry.scroller) <= 1, `header is not stuck: ${JSON.stringify(geometry)}`)
      })
      await check(`${label}: toolbar stays on one line with ellipsis labels`, async () => {
        const g = await page.evaluate(() => {
          const bar = document.querySelector('.toolbar'), buttons = [...bar.querySelectorAll('.repo-name')]
          return { bar:bar.getBoundingClientRect().toJSON(), buttons:buttons.map(n => ({ rect:n.getBoundingClientRect().toJSON(), labels:[...n.querySelectorAll('span')].filter(s => s.textContent.includes('a-very-long')).map(s => ({ overflow:getComputedStyle(s).overflowX,ellipsis:getComputedStyle(s).textOverflow,nowrap:getComputedStyle(s).whiteSpace,width:s.clientWidth,scroll:s.scrollWidth })) })) }
        })
        assert.equal(g.buttons.length, 2)
        for (const b of g.buttons) {
          assert.ok(b.rect.width > 20, 'repo/branch vanished')
          assert.ok(b.rect.top >= g.bar.top && b.rect.bottom <= g.bar.bottom + 1)
          assert.ok(b.rect.right <= g.bar.right + 1)
          assert.ok(b.labels.some(l => l.ellipsis === 'ellipsis' && l.nowrap === 'nowrap' && ['hidden','clip'].includes(l.overflow)), 'label missing ellipsis constraints')
        }
        toolbarWidths[`${layout}:${width}`] = g.buttons.map(b => b.rect.width)
      })
      if (layout === 'split') await check(`${label}: paired wrapped rows equal height and divider flush`, async () => {
        const rows = await page.locator('.af-file').first().locator('.split-row').evaluateAll(nodes => nodes.map(n => {
          const cells = [...n.querySelectorAll(':scope > .line')]
          const rect = el => el.getBoundingClientRect().toJSON()
          return { row:rect(n),cells:cells.map(c => ({ rect:rect(c),border:parseFloat(getComputedStyle(c).borderRightWidth),borderLeft:parseFloat(getComputedStyle(c).borderLeftWidth),side:c.dataset.side,text:c.textContent })) }
        }))
        assert.ok(rows.length > 0)
        for (const r of rows) {
          assert.equal(r.cells.length, 2)
          const [l,a] = r.cells
          assert.ok(Math.abs(l.rect.height - a.rect.height) <= 1, `height mismatch ${JSON.stringify(r)}`)
          assert.ok(Math.abs(l.rect.top - a.rect.top) <= 1)
          assert.ok(Math.abs(l.rect.right - a.rect.left) <= 1, 'divider gap')
          assert.ok(l.border >= 1 || a.borderLeft >= 1, 'center divider absent')
          assert.ok(Math.abs(l.rect.x - r.row.x) <= 1 && Math.abs(a.rect.right - r.row.right) <= 1, 'split outer inset')
        }
      })
      await check(`${label}: actual SDK menu wrap toggle and search/filter interactions`, async () => {
        const code = page.locator('.linecode').filter({ hasText: 'unbroken_' }).first()
        const wrappedHeight = await code.evaluate(n => n.getBoundingClientRect().height)
        await page.getByRole('button', { name: 'Display options', exact: true }).click()
        const wrap = page.getByRole('switch', { name: 'Word wrap', exact: true })
        if (layout === 'split') {
          // Split layout forces word wrap on: the switch is locked.
          assert.ok(await wrap.isDisabled(), 'split layout must lock the word-wrap switch')
        } else {
          await wrap.click()
          assert.ok(await code.evaluate(n => n.getBoundingClientRect().height) < wrappedHeight / 2, 'turning wrap off must shrink long-line height')
          assert.equal(await page.locator('.wordw').count(), 0, 'word wrap menu failed to update rendering')
          assert.equal(await page.evaluate(() => window.fixture.storage.get('display.v1').wordWrap), false)
          await wrap.click()
          assert.ok(await page.locator('.wordw').count() > 0)
          assert.ok(Math.abs(await code.evaluate(n => n.getBoundingClientRect().height) - wrappedHeight) <= 1, 'turning wrap on must restore long-line height')
        }
        await page.keyboard.press('Escape')
        const input = page.getByRole('textbox', { name: 'Search files', exact: true })
        await input.fill('MAIN.TEST')
        assert.deepEqual(await page.locator('.af-file').evaluateAll(nodes => nodes.map(n => n.dataset.path)), [files[2]])
        await input.fill('')
        await page.getByRole('button', { name: 'Show filters', exact: true }).click()
        await page.getByRole('menuitem', { name: 'Deleted files', exact: true }).click()
        assert.deepEqual(await page.locator('.af-file').evaluateAll(nodes => nodes.map(n => n.dataset.path)), files.slice(0, 3))
        await page.getByRole('button', { name: 'Show filters', exact: true }).click()
        await page.getByRole('menuitem', { name: 'Deleted files', exact: true }).click()
        assert.equal(await page.locator('.af-file').count(), files.length)
      })
      await check(`${label}: line click-highlight range and native cite inserts @line reference`, async () => {
        await page.locator('.af-file[data-path="src/architecture/deep/main.ts"]').getByRole('button', { name: `Expand all remaining unchanged lines for src/architecture/deep/main.ts`, exact: true }).first().click()
        const rows = page.locator('.af-file[data-path="src/architecture/deep/main.ts"] .line[data-line]:not(.line.hunk):not(.line.meta):not([data-side="left"])')
        const uniqueLines = () => page.locator('.line-selected').evaluateAll(nodes => new Set(nodes.map(n => n.dataset.line)).size)
        await rows.first().click()
        assert.equal(await uniqueLines(), 1, 'anchor line must highlight')
        await rows.nth(5).click()
        const highlighted = await uniqueLines()
        assert.ok(highlighted >= 3, `range must highlight, got ${highlighted}`)
        const bar = page.getByRole('toolbar', { name: 'Line selection actions' })
        await bar.getByRole('button', { name: 'Cite selected lines in focused message draft' }).click()
        const inserts = await page.evaluate(() => window.__composerInserts || [])
        assert.equal(inserts.length, 1, 'cite must insert exactly once into the composer draft')
        // With no focused-session cwd the ref keeps the absolute repo path.
        assert.match(inserts[0], /^@line:(?:\/repositories\/[^:\s]+\/)?src\/architecture\/deep\/main\.ts:\d+-\d+$/)
        assert.equal(await page.locator('.line-selected').count(), 0, 'selection must clear after citing')
      })
      await check(`${label}: drag selected lines carries composer-native cite payload`, async () => {
        const rows = page.locator('.af-file[data-path="src/architecture/deep/main.ts"] .line[data-line]:not(.line.hunk):not(.line.meta):not([data-side="left"])')
        await rows.first().click()
        const dragged = await page.evaluate(() => {
          const row = document.querySelector('.af-file[data-path="src/architecture/deep/main.ts"] .line[draggable="true"]')
          if (!row) return null
          const dt = new DataTransfer()
          row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt }))
          return { paths: dt.getData('application/x-hermes-paths'), plain: dt.getData('text/plain'), effect: dt.effectAllowed }
        })
        assert.ok(dragged, 'selected lines must become draggable')
        const entries = JSON.parse(dragged.paths)
        assert.ok(Array.isArray(entries) && entries.length === 1, 'HERMES_PATHS payload must be ONE range entry')
        assert.ok(entries[0].path.endsWith('/src/architecture/deep/main.ts') && entries[0].line > 0, 'entry must carry an absolute path + first line')
        if (entries[0].lineEnd != null) assert.ok(entries[0].lineEnd >= entries[0].line, 'lineEnd must not precede line')
        assert.match(dragged.plain, /^@line:(?:\/repositories\/[^:\s]+\/)?src\/architecture\/deep\/main\.ts:\d+(-\d+)?$/)
        await page.keyboard.press('Escape')
        await page.evaluate(() => document.body.click())
      })
      await check(`${label}: word wrap off leaves non-line components viewport-wide`, async () => {
        // Split forces wrap on, so only the unified layout can turn it off.
        if (layout !== 'split') {
          await page.getByRole('button', { name: 'Display options', exact: true }).click()
          await page.getByRole('switch', { name: 'Word wrap', exact: true }).click()
          await page.keyboard.press('Escape')
        }
        const metrics = await page.evaluate(() => {
          const fold = document.querySelector('.fold')
          const head = document.querySelector('.af-head')
          const diff = document.querySelector('.diff,.splitwrap')
          const strip = fold && fold.querySelector('.fold-strip')
          return {
            fold: fold && fold.getBoundingClientRect().width, strip: strip && strip.getBoundingClientRect().width,
            head: head.getBoundingClientRect().width, viewport: diff && diff.clientWidth,
          }
        })
        assert.ok(metrics.strip && Math.abs(metrics.strip - metrics.viewport) <= 1, `fold strip must span the viewport width, got ${metrics.strip} vs ${metrics.viewport}`)
        assert.ok(Math.abs(metrics.head - metrics.viewport) <= 1, `af-head must span the viewport width, got ${metrics.head} vs ${metrics.viewport}`)
        if (layout !== 'split') {
          await page.getByRole('button', { name: 'Display options', exact: true }).click()
          await page.getByRole('switch', { name: 'Word wrap', exact: true }).click()
          await page.keyboard.press('Escape')
        }
      })
      await check(`${label}: collapse-all icon button sits right of display options and collapses`, async () => {
        const geo = await page.evaluate(() => {
          const display = document.querySelector('[aria-label="Display options"]').getBoundingClientRect()
          const collapse = document.querySelector('[aria-label="Collapse all"]').getBoundingClientRect()
          return { display, collapse }
        })
        assert.ok(geo.collapse.left >= geo.display.right - 1, 'collapse-all must be right of the ellipsis button')
        assert.ok(geo.collapse.top >= geo.display.top - 1 && geo.collapse.bottom <= geo.display.bottom + 1, 'collapse-all must share the toolbar row')
        await page.getByRole('button', { name: 'Collapse all', exact: true }).click()
        assert.equal(await page.locator('.diff,.splitwrap').count(), 0, 'collapse all must hide every diff body')
        const heads = await page.locator('.af-head').count()
        assert.equal(await page.locator('.af-file.af-collapsed').count(), heads, 'collapsed files must not carry a second border')
      })
      await check(`${label}: scrollbar gutter reserves space without layout shift`, async () => {
        const result = await page.evaluate(() => {
          const el = document.querySelector('.allfiles')
          return { gutter: getComputedStyle(el).scrollbarGutter, borderRight: getComputedStyle(el).borderRightWidth }
        })
        assert.equal(result.gutter, 'stable', 'scrollbar-gutter:stable keeps the separator flush without a gap when scrolling')
        assert.ok(parseFloat(result.borderRight) >= 1)
      })
      await page.screenshot({ path: path.join(artifactDir, `${width}-${layout}-collapsed.png`) })
      await page.evaluate(() => window.unmountFixture())
    } catch (error) { failures.push({ name: label + ' harness', error: error.message }); console.error('FAIL', label, error.message); consoleErrors.push(...errors) }
    finally { await page.close() }
  }
  await check('adaptive repo/branch allocation grows from narrow to wide', async () => {
    for (const layout of ['unified', 'split']) {
      assert.ok(toolbarWidths[`${layout}:380`] && toolbarWidths[`${layout}:1280`], 'toolbar measurements incomplete')
      for (let i=0;i<2;i++) assert.ok(toolbarWidths[`${layout}:1280`][i] > toolbarWidths[`${layout}:380`][i] + 30, 'wide pane spare space not allocated to repo/branch')
    }
  })
} finally {
  await browser?.close()
  await server?.close()
  await fs.writeFile(path.join(artifactDir, 'results.json'), JSON.stringify({results, failures, consoleErrors}, null, 2))
}
console.log(`${results.filter(r => r.passed).length} passed; ${failures.length} failed. Artifacts: ${artifactDir}`)
if (failures.length) process.exitCode = 1
