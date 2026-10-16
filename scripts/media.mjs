// Media production for the README and the catalog entry: static shots, motion
// clips (GIF + MP4) and the 1200x600 catalog banner, all rendered from the real
// pane. Run: npm run media [-- shots|motion|banner]. Every interaction also
// asserts what the pane is supposed to show, and the failures are the bug list.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const run = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.HERMES_FIXTURES ||= path.join(root, 'tests/demo-fixtures.mjs')
process.env.PATH = `${process.env.PATH}:/opt/homebrew/bin:/usr/local/bin`
const demo = await import('../tests/demo-fixtures.mjs')
const { startLayoutHarness } = await import('../tests/browser-harness.mjs')

const SHOTS = path.join(root, 'docs/screenshots')
const GIFS = path.join(root, 'docs/gifs')
const VIDEO = path.join(root, 'docs/video')
const WORK = path.join(os.tmpdir(), 'git-review-media')
const only = process.argv.slice(2).filter(a => !a.startsWith('-'))
const want = kind => !only.length || only.includes(kind)

const issues = []
function check(label, ok, detail = '') {
  if (!ok) { issues.push({ label, detail }); console.log('  ISSUE  ' + label + (detail ? ' :: ' + detail : '')) }
  else console.log('  ok     ' + label)
}

// ── demo cursor + caption: the recorder has no pointer of its own ────────────
const OVERLAY = () => {
  const mount = () => {
  const style = document.createElement('style')
  style.textContent = `
    #__demo-cursor{position:fixed;left:0;top:0;width:16px;height:16px;border-radius:50%;
      background:rgba(28,32,44,.85);border:2px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.45);
      pointer-events:none;z-index:2147483647;transition:transform .04s linear}
    .__demo-ripple{position:fixed;left:0;top:0;width:16px;height:16px;border-radius:50%;
      border:2px solid rgba(79,91,213,.9);pointer-events:none;z-index:2147483646;animation:__demo-ping .55s ease-out forwards}
    @keyframes __demo-ping{from{transform:scale(1);opacity:.9}to{transform:scale(3.2);opacity:0}}
    #__demo-caption{position:fixed;left:18px;bottom:16px;z-index:2147483645;max-width:70%;
      font:500 13px/1.45 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#fff;
      background:rgba(24,27,38,.88);padding:8px 14px;border-radius:999px;pointer-events:none;
      opacity:0;transition:opacity .25s ease;box-shadow:0 4px 18px rgba(0,0,0,.28)}
    #__demo-caption.__on{opacity:1}`
  document.head.appendChild(style)
  const dot = document.createElement('div')
  dot.id = '__demo-cursor'
  document.documentElement.appendChild(dot)
  addEventListener('mousemove', e => { dot.style.transform = `translate(${e.clientX - 8}px, ${e.clientY - 8}px)` }, true)
  addEventListener('mousedown', () => {
    const ring = document.createElement('div')
    ring.className = '__demo-ripple'
    ring.style.transform = dot.style.transform
    document.documentElement.appendChild(ring)
    setTimeout(() => ring.remove(), 560)
  }, true)
  }
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount, { once: true })
  else mount()
}

async function caption(page, text) {
  await page.evaluate(t => {
    let el = document.getElementById('__demo-caption')
    if (!el) { el = document.createElement('div'); el.id = '__demo-caption'; document.documentElement.appendChild(el) }
    el.textContent = t
    requestAnimationFrame(() => el.classList.add('__on'))
  }, text)
}
const beat = (page, ms) => page.waitForTimeout(ms)

async function clickAt(page, target, { steps = 22, settle = 420, moveOnly = false } = {}) {
  const locator = typeof target === 'string' ? page.locator(target).first() : target
  await locator.waitFor({ state: 'visible', timeout: 20000 })
  const box = await locator.boundingBox()
  if (!box) throw new Error('no bounding box for ' + (typeof target === 'string' ? target : 'locator'))
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps })
  await beat(page, 140)
  if (!moveOnly) { await page.mouse.down(); await beat(page, 60); await page.mouse.up() }
  await beat(page, settle)
  return locator
}

async function open(browser, { width = 1280, height = 900, layout = 'unified', ctx = null, video = null, scale = 2, ready = '.af-file', cursor = false } = {}) {
  const context = await browser.newContext({
    viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: 'reduce',
    ...(video ? { recordVideo: { dir: video.dir, size: video.size || { width, height } } } : {}),
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  // A recorded clip needs a visible pointer; a still must not carry one.
  if (cursor) await page.addInitScript(OVERLAY)
  const params = new URLSearchParams({ layout, wrap: 'true' })
  if (ctx) params.set('ctx', JSON.stringify(ctx))
  const t0 = Date.now()
  await page.goto(`${harness.url}?${params}`)
  if (ready) await page.locator(ready).first().waitFor({ timeout: 45000 })
  else await page.locator('.toolbar').first().waitFor({ timeout: 45000 })
  await page.evaluate(() => document.fonts.ready)
  return { context, page, errors, lead: (Date.now() - t0) / 1000 }
}

async function shot(page, file, dir = SHOTS) {
  await fs.mkdir(dir, { recursive: true })
  await page.screenshot({ path: path.join(dir, file) })
  console.log('  wrote  ' + path.relative(root, path.join(dir, file)))
}

// The demo diff must be a real diff: hunk headers have to account for the
// offset earlier hunks introduced, and the body must match the header counts.
function checkDataset() {
  console.log('\n== demo dataset')
  const lines = demo.diff.patch.split('\n')
  let file = null, offset = 0, added = 0, removed = 0
  for (let i = 0; i < lines.length; i++) {
    const head = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[i])
    if (head) { file = head[2]; offset = 0; continue }
    const hunk = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@$/.exec(lines[i])
    if (!hunk) continue
    const [oldStart, oldCount, newStart, newCount] = hunk.slice(1).map(Number)
    const addedFile = oldStart === 0 && oldCount === 0
    const deletedFile = newStart === 0 && newCount === 0
    if (!addedFile && !deletedFile) {
      check(`hunk of ${file} at line ${i + 1}: new start accounts for the running offset`,
        newStart === oldStart + offset, `declared +${newStart}, offset says +${oldStart + offset}`)
    }
    const seen = { old: 0, new: 0 }
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]
      if (l.startsWith('diff --git') || /^@@ /.test(l)) break
      if (l.startsWith(' ') || l.startsWith('-')) seen.old += 1
      if (l.startsWith(' ') || l.startsWith('+')) seen.new += 1
      if (l.startsWith('+') && !l.startsWith('+++')) added += 1
      if (l.startsWith('-') && !l.startsWith('---')) removed += 1
    }
    check(`hunk of ${file} at line ${i + 1}: body matches the header counts`,
      seen.old === oldCount && seen.new === newCount, `body ${seen.old}/${seen.new} vs header ${oldCount}/${newCount}`)
    if (!deletedFile) offset += newCount - oldCount
  }
  check('dataset totals match the toolbar', added === demo.diff.added && removed === demo.diff.removed,
    `walked +${added}/-${removed}, declared +${demo.diff.added}/-${demo.diff.removed}`)
}

// ── static shots ────────────────────────────────────────────────────────────
async function staticShots(browser) {
  console.log('\n== static shots')
  // README hero images.
  for (const [file, width, layout] of [['pane-unified.png', 1280, 'unified'], ['pane-split.png', 1280, 'split'], ['pane-narrow.png', 420, 'unified']]) {
    const { context, page, errors } = await open(browser, { width, layout, height: 900 })
    await shot(page, file, path.join(root, 'docs'))
    check(`${file}: renders every changed file`, await page.locator('.af-file').count() === demo.files.length,
      `files=${await page.locator('.af-file').count()} expected=${demo.files.length}`)
    check(`${file}: no runtime errors`, errors.length === 0, errors.join(' | '))
    await context.close()
  }
  // Feature states.
  const states = [
    ['scopes.png', 'unified', async page => { await clickAt(page, '.scope-btn') }, '.scope-btn'],
    ['commits.png', 'unified', async page => {
      await clickAt(page, '.scope-btn')
      await clickAt(page, page.getByRole('menuitem', { name: 'Commits', exact: true }), { settle: 500 })
      await clickAt(page, '.scope-btn', { settle: 600 })
    }, '[role="menuitem"]'],
    ['display.png', 'unified', async page => { await clickAt(page, '[aria-label="Display options"]') }, '[role="menuitem"]'],
    ['files.png', 'unified', async page => { await clickAt(page, '[aria-label="Show filters"]') }, '[role="menuitem"]'],
    ['search.png', 'unified', async page => {
      await clickAt(page, 'input[aria-label="Search files"]')
      await page.keyboard.type('invoice', { delay: 55 })
    }, '.file'],
    ['fold.png', 'unified', async page => {
      const bar = page.locator('.fold:not([data-gap])').first()
      await clickAt(page, bar.locator('.fold-inline').first())
    }, '.fold'],
    ['gap.png', 'unified', async page => {
      const bar = page.locator('.fold[data-gap="1"]').first()
      await clickAt(page, bar.locator('.fold-inline').first())
    }, '.fold'],
    ['cite.png', 'unified', async page => {
      const rows = page.locator('.af-file').first().locator('.line.add')
      await clickAt(page, rows.nth(1))
      await clickAt(page, rows.nth(3))
    }, '.cite-bar'],
    ['agent-turn.png', 'unified', async page => {
      await page.evaluate(() => window.__setBusy(true))
      await beat(page, 900)
      await page.evaluate(() => window.__setBusy(false))
      await beat(page, 600)
      await clickAt(page, '.scope-btn')
      await clickAt(page, page.getByRole('menuitem', { name: 'Last agent turn', exact: true }), { settle: 800 })
    }, '.af-file'],
    ['empty.png', 'unified', async page => {}, null, { empty: true }],
  ]
  for (const [file, layout, steps, expect, ctx] of states) {
    let session
    try {
      session = await open(browser, { layout, ctx: ctx || null, ready: ctx?.empty ? null : '.af-file' })
      const { page, errors } = session
      await steps(page)
      if (expect) {
        const found = await page.locator(expect).count()
        check(`${file}: ${expect} present`, found > 0, `count=${found}`)
      }
      if (ctx?.empty) {
        check('empty.png: empty state shown', await page.getByText('No worktrees found').count() > 0)
      }
      check(`${file}: no runtime errors`, errors.length === 0, errors.join(' | '))
      await shot(page, file)
    } catch (error) {
      check(`${file}: captured`, false, error.message)
    }
    await session?.context.close()
  }
}

// ── motion clips ────────────────────────────────────────────────────────────
const CLIPS = [
  {
    name: 'agent-reveal', readme: true, seconds: 9, caption: 'The agent calls git_review_select — the pane follows',
    ctx: { select: { id: 7, repo: demo.repo, scope: 'commits', ref: `${demo.commits[0].sha},${demo.commits[1].sha}`, path: 'src/invoice/totals.ts' } },
    async run(page) {
      await caption(page, 'Watching the focused repository…')
      await beat(page, 1500)
      await page.locator('.toolbar .scope-btn').first().hover()
      await beat(page, 4000)
      await caption(page, 'git_review_select: commits ' + demo.commits[0].short + '…')
      await beat(page, 2200)
    },
  },
  {
    name: 'scope-sweep', seconds: 10, caption: 'Five scopes, one pane',
    async run(page) {
      for (const text of ['Staged', 'Unstaged']) {
        await clickAt(page, '.scope-btn')
        await clickAt(page, page.getByRole('menuitem', { name: text, exact: true }), { settle: 700 })
        await caption(page, text + ' — the same pane, a different change set')
        await beat(page, 700)
      }
      await clickAt(page, '.scope-btn')
      await clickAt(page, page.getByRole('menuitem', { name: 'Uncommitted', exact: true }), { settle: 700 })
      await caption(page, 'Five scopes: agent turn · uncommitted · staged · unstaged · commits')
      await beat(page, 1600)
    },
  },
  {
    name: 'layout-flip', seconds: 8, caption: 'Unified ⇄ split, word wrap locked in split',
    async run(page) {
      await clickAt(page, '[aria-label="Display options"]')
      await clickAt(page, page.getByRole('menuitem', { name: 'Layout: Split' }), { settle: 800 })
      await caption(page, 'Split: paired rows, always wrapped')
      await beat(page, 1600)
      await clickAt(page, '[aria-label="Display options"]')
      await clickAt(page, page.getByRole('menuitem', { name: 'Layout: Unified' }), { settle: 800 })
      await caption(page, 'Unified: one column, folding')
      await beat(page, 1600)
    },
  },
  {
    name: 'commit-pick', seconds: 11, caption: 'Pick the commits to review',
    async run(page) {
      await clickAt(page, '.scope-btn')
      await clickAt(page, page.getByRole('menuitem', { name: 'Commits', exact: true }), { settle: 700 })
      await clickAt(page, '.scope-btn', { settle: 800 })
      await caption(page, 'Every loaded commit, all checked by default')
      await beat(page, 1500)
      await clickAt(page, page.getByRole('menuitem', { name: 'Clear' }), { settle: 500 })
      for (const index of [0, 2]) {
        await clickAt(page, page.getByRole('menuitem', { name: new RegExp(demo.commits[index].subject.slice(0, 24)) }), { settle: 420 })
      }
      await caption(page, 'Two commits selected — their patches render below')
      await beat(page, 900)
      await page.keyboard.press('Escape')
      await beat(page, 1800)
    },
  },
  {
    name: 'agent-turn', seconds: 12, caption: 'Last agent turn — everything since the turn began',
    async run(page) {
      await caption(page, 'The agent starts a turn…')
      await beat(page, 700)
      await page.evaluate(() => window.__setBusy(true))
      await beat(page, 1300)
      await page.evaluate(() => window.__setBusy(false))
      await beat(page, 700)
      const based = await page.evaluate(() => window.fixture.requests.some(r => r.url.includes('/turn-base')))
      check('agent-turn: the pane snapshots a turn baseline on the busy edge', based, 'no /turn-base request')
      await clickAt(page, '.scope-btn')
      await clickAt(page, page.getByRole('menuitem', { name: 'Last agent turn', exact: true }), { settle: 900 })
      const files = await page.locator('.af-file').count()
      check('agent-turn: the turn scope renders the turn diff', files > 0, `files=${files}`)
      await caption(page, 'Committed and uncommitted since the turn began')
      await beat(page, 2400)
    },
  },
  {
    name: 'fold-gap', readme: true, seconds: 11, caption: 'Fold the unchanged runs, expand the gaps',
    async run(page) {
      const foldBar = page.locator('.fold:not([data-gap])').first()
      await foldBar.scrollIntoViewIfNeeded()
      await clickAt(page, foldBar.locator('.fold-inline').first(), { settle: 700 })
      await caption(page, 'Reveal the unchanged lines inside the patch')
      await beat(page, 1400)
      const gapBar = page.locator('.fold[data-gap="1"]').first()
      await gapBar.scrollIntoViewIfNeeded()
      await clickAt(page, gapBar.locator('.fold-inline').first(), { settle: 900 })
      await caption(page, 'Expand the lines outside the patch — read from the file')
      await beat(page, 1600)
    },
  },
  {
    name: 'cite-line', readme: true, seconds: 11, caption: 'Cite the lines that matter into the draft',
    async run(page) {
      const rows = page.locator('.af-file').first().locator('.line.add')
      await clickAt(page, rows.nth(1))
      await clickAt(page, rows.nth(3), { settle: 600 })
      await caption(page, 'Click a line, then another')
      await beat(page, 1300)
      await clickAt(page, '[aria-label="Cite selected lines in focused message draft"]', { settle: 500 })
      const inserted = await page.evaluate(() => (window.__composerInserts || []).slice(-1)[0] || '')
      check('cite-line: composer received an @line reference', /^@line:.+:\d+-\d+$/.test(inserted), `got "${inserted}"`)
      await caption(page, inserted ? `Draft gets  ${inserted}` : 'Nothing inserted')
      await beat(page, 2000)
    },
  },
]

async function encode(name, raw, lead, seconds, readme) {
  const trim = Math.max(0, lead - 0.35).toFixed(2)
  const mp4 = path.join(VIDEO, `${name}.mp4`)
  const gif = path.join(GIFS, `${name}.gif`)
  await fs.mkdir(VIDEO, { recursive: true })
  await fs.mkdir(GIFS, { recursive: true })
  await run('ffmpeg', ['-y', '-ss', trim, '-t', String(seconds), '-i', raw,
    '-vf', 'fps=15,scale=1280:-2:flags=lanczos', '-c:v', 'libx264', '-crf', '26', '-preset', 'slow',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', mp4])
  const palette = path.join(WORK, `${name}-palette.png`)
  const encodeGif = async (fps, width, colors) => {
    await run('ffmpeg', ['-y', '-ss', trim, '-t', String(seconds), '-i', raw,
      '-vf', `fps=${fps},scale=${width}:-1:flags=lanczos,palettegen=max_colors=${colors}:stats_mode=diff`, palette])
    await run('ffmpeg', ['-y', '-ss', trim, '-t', String(seconds), '-i', raw, '-i', palette,
      '-lavfi', `fps=${fps},scale=${width}:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle`, gif])
    return (await fs.stat(gif)).size
  }
  // Only the README clips get a GIF: a README GIF costs every clone forever,
  // and an MP4 twin plays everywhere else (Discord, socials) at a tenth of it.
  let size = null
  if (readme) {
    size = await encodeGif(10, 880, 64)
    if (size > 2.6e6) size = await encodeGif(9, 800, 48)
  }
  const mp4Size = (await fs.stat(mp4)).size
  console.log(`  wrote  ${readme ? `docs/gifs/${name}.gif  ${(size / 1e6).toFixed(2)} MB   ` : ''}docs/video/${name}.mp4  ${(mp4Size / 1e6).toFixed(2)} MB`)
  return { gif: size, mp4: mp4Size }
}

async function motionClips(browser) {
  console.log('\n== motion clips')
  await fs.mkdir(WORK, { recursive: true })
  for (const clip of CLIPS) {
    const { context, page, errors, lead } = await open(browser, { cursor: true, video: { dir: WORK, size: { width: 1280, height: 900 } } })
    const video = page.video()
    try {
      await clip.run(page)
      check(`${clip.name}: no runtime errors`, errors.length === 0, errors.join(' | '))
      const rows = await page.locator('.af-file').count()
      check(`${clip.name}: pane still rendering after the interactions`, rows > 0, `files=${rows}`)
    } catch (error) {
      check(`${clip.name}: interaction completed`, false, error.message)
    }
    const raw = path.join(WORK, `${clip.name}-raw.webm`)
    await context.close()
    await video.saveAs(raw)
    const sizes = await encode(clip.name, raw, lead, clip.seconds, clip.readme)
    if (sizes.gif != null) check(`${clip.name}: gif within the 2.6 MB README budget`, sizes.gif <= 2.6e6, `${(sizes.gif / 1e6).toFixed(2)} MB`)
  }
}

// ── catalog card banner (1200x600, 2:1) ─────────────────────────────────────
async function banner(browser) {
  console.log('\n== catalog banner')
  const pane = (await fs.readFile(path.join(root, 'docs/pane-unified.png'))).toString('base64')
  const html = `<!doctype html><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    body{width:1200px;height:600px;font:400 16px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      background:linear-gradient(135deg,#f4f5fb 0%,#e8eaf6 100%);color:#1b1f2a;overflow:hidden;position:relative}
    .wrap{display:flex;gap:34px;padding:54px 0 54px 54px;height:100%;align-items:center}
    .copy{width:442px;flex:0 0 auto}
    h1{font-size:56px;line-height:1.02;letter-spacing:-1.6px;font-weight:700}
    h1 span{color:#4f5bd5}
    p.lede{margin-top:14px;font-size:18.5px;color:#3c4152}
    ul{margin-top:24px;list-style:none;display:grid;gap:11px;padding:0}
    li{display:flex;gap:9px;align-items:baseline;font-size:15.5px;color:#2b3040;white-space:nowrap}
    li b{font-weight:600}
    .dot{width:7px;height:7px;border-radius:50%;background:#4f5bd5;flex:0 0 auto;transform:translateY(-3px)}
    code{display:inline-block;margin-top:28px;font:600 15px ui-monospace,SFMono-Regular,Menlo,monospace;
      background:#1b1f2a;color:#f4f5fb;padding:11px 18px;border-radius:10px}
    /* The pane is captured at 2x, so showing it at its pixel width crops to a
       crisp, legible region instead of shrinking the whole window. */
    .shot{position:relative;flex:1 1 auto;height:100%;overflow:hidden;border-radius:14px 0 0 14px;box-shadow:0 24px 60px rgba(27,31,42,.22);background:#fff}
    .shot img{display:block;width:1500px;max-width:none;height:auto}
    .shot::after{content:'';position:absolute;inset:auto 0 0 0;height:70px;
      background:linear-gradient(to bottom,rgba(255,255,255,0),rgba(255,255,255,.92))}
  </style>
  <div class="wrap">
    <div class="copy">
      <h1>git-<span>review</span></h1>
      <p class="lede">Read-only Git review pane for Hermes Desktop.</p>
      <ul>
        <li><span class="dot"></span><span><b>Five scopes</b> — agent turn to commits</span></li>
        <li><span class="dot"></span><span><b>Unified or split</b>, with folding</span></li>
        <li><span class="dot"></span><span><b>@line citations</b> into the draft</span></li>
        <li><span class="dot"></span><span><b>Never fetches, stages or commits</b></span></li>
      </ul>
      <code>hermes plugins install git-review</code>
    </div>
    <div class="shot"><img src="data:image/png;base64,${pane}"></div>
  </div>`
  const context = await browser.newContext({ viewport: { width: 1200, height: 600 }, deviceScaleFactor: 2, reducedMotion: 'reduce' })
  const page = await context.newPage()
  await page.setContent(html, { waitUntil: 'load' })
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: path.join(root, 'docs/banner.png') })
  console.log('  wrote  docs/banner.png (1200x600)')
  await context.close()
}

// ── run ─────────────────────────────────────────────────────────────────────
const harness = await startLayoutHarness()
const browser = await chromium.launch({ headless: true })
try {
  checkDataset()
  if (want('shots')) await staticShots(browser)
  if (want('motion')) await motionClips(browser)
  if (want('banner')) await banner(browser)
} finally {
  await browser.close()
  await harness.server.close()
}
const report = { generated: new Date().toISOString(), issues, counts: { issues: issues.length } }
await fs.mkdir(WORK, { recursive: true })
await fs.writeFile(path.join(WORK, 'media-report.json'), JSON.stringify(report, null, 2))
console.log(`\n${issues.length} issue(s). Report: ${path.join(WORK, 'media-report.json')}`)
if (issues.length) process.exitCode = 1
