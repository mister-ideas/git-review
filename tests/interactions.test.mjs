import test from 'node:test'
import assert from 'node:assert/strict'
import { act, mount, byClass, byLabel, switchFor, click, select, paths, file, latestDiff, text } from './render-harness.mjs'
import TestRenderer from 'react-test-renderer'
import { jsx } from 'react/jsx-runtime'
import { files, repo, makeContext, commits, contexts } from './fixtures.mjs'

import { GitReview } from '../desktop/plugin.js'

// The pane scopes its settings to the connection/profile and the workspace, and
// falls back to the unscoped key older versions wrote. Read what it wrote.
const paneSettings = (storage) => storage.get(
  [...storage.keys()].filter(k => k.startsWith('display.v1')).sort((a, b) => b.length - a.length)[0])

test('Review next file lands on a collapsed file without expanding it', async t => {
  // The jump itself is browser work; the state it must not change is what this covers.
  const raf = globalThis.requestAnimationFrame
  globalThis.requestAnimationFrame = () => 0
  t.after(() => { globalThis.requestAnimationFrame = raf })
  const { root } = await mount(t)
  // The first file is active, so the step-through target is the second one.
  await click(byClass(file(root, files[1]), 'file-toggle')[0])
  assert.equal(byClass(file(root, files[1]), 'diff').length, 0, 'precondition: collapsed')
  await click(byLabel(root, 'Review next file'))
  assert.equal(byClass(file(root, files[1]), 'diff').length, 0, 'stepping is navigation, not an expand')
  assert.equal(byClass(root, 'af-file')[1].props['data-path'], files[1])
})

test('Ignore whitespace requests false → true → false and persists each value', async t => {
  const { root, requests, storage } = await mount(t)
  assert.equal(latestDiff(requests).searchParams.get('ignore_ws'), 'false')
  for (const value of [true, false]) {
    const count = requests.filter(r => r.url.startsWith('/diff?')).length
    await act(async () => switchFor(root, 'Ignore whitespace').props.onCheckedChange(value))
    assert.equal(requests.filter(r => r.url.startsWith('/diff?')).length, count + 1)
    assert.equal(latestDiff(requests).searchParams.get('ignore_ws'), String(value))
    assert.equal(paneSettings(storage).ignoreWs, value)
  }
})

test('copy path spies clipboard, preserves expanded diff, and resets copied feedback', async t => {
  const { root, clipboard } = await mount(t)
  const target = file(root, files[0])
  const before = byClass(target, 'line').length
  await click(byLabel(target, `Copy path for ${files[0]}`))
  assert.deepEqual(clipboard, [files[0]])
  assert.equal(byClass(file(root, files[0]), 'line').length, before)
  assert.equal(byLabel(file(root, files[0]), `Copy path for ${files[0]}`).findAll(n => n.props.name === 'check').length, 1)
  await act(async () => t.mock.timers.tick(1500))
  assert.equal(byLabel(file(root, files[0]), `Copy path for ${files[0]}`).findAll(n => n.props.name === 'copy').length, 1)
})

test('deleted/test filters remove exact paths from both main view and tree', async t => {
  const { root, storage } = await mount(t)
  assert.deepEqual(paths(root), files)
  await select(root, 'Deleted files')
  assert.deepEqual(paths(root), files.slice(0, 3))
  assert.equal(paneSettings(storage).showDeleted, false)
  await select(root, 'Test files')
  assert.deepEqual(paths(root), files.slice(0, 2))
  assert.equal(paneSettings(storage).showTests, false)
  assert.deepEqual(byClass(root, 'file').map(text).map(s => s.replace(/[+−]\d+/g, '')), ['main.ts', 'other.ts'])
  await select(root, 'Deleted files')
  await select(root, 'Test files')
  assert.deepEqual(paths(root), files)
})

test('files hide/show persists through a real unmount/remount', async t => {
  const storage = new Map()
  const first = await mount(t, { storage })
  assert.equal(first.root.findAllByType('aside').length, 1)
  await click(byLabel(first.root, 'Hide file list'))
  assert.equal(first.root.findAllByType('aside').length, 0)
  assert.equal(paneSettings(storage).files, false)
  await act(async () => first.renderer.unmount())
  // mount uses the already-active timer mock for this test.
  const { root } = await mount(t, { storage })
  assert.equal(root.findAllByType('aside').length, 0)
  await click(byLabel(root, 'Show file list'))
  assert.equal(root.findAllByType('aside').length, 1)
  assert.equal(paneSettings(storage).files, true)
})

test('architecture folders default expanded; compact chain toggles descendants only', async t => {
  const { root } = await mount(t)
  const folders = byClass(root, 'folder')
  assert.ok(folders.some(n => text(n).includes('architecture/deep')), 'compact architecture chain missing')
  assert.equal(byClass(root, 'file').length, files.length)
  const folder = folders.find(n => text(n).includes('architecture/deep'))
  await click(folder)
  assert.equal(byClass(root, 'file').length, files.length - 2)
  assert.deepEqual(paths(root), files, 'folder navigation must not hide stacked diffs')
  await click(folder)
  assert.equal(byClass(root, 'file').length, files.length)
})

test('all files default expanded; one header collapse/reopen does not affect siblings', async t => {
  const { root } = await mount(t)
  for (const path of files) assert.equal(byClass(file(root, path), 'diff').length, 1)
  const initial = byClass(file(root, files[0]), 'line').map(text)
  await click(byClass(file(root, files[0]), 'file-toggle')[0])
  assert.equal(byClass(file(root, files[0]), 'diff').length, 0)
  for (const path of files.slice(1)) assert.equal(byClass(file(root, path), 'diff').length, 1)
  await click(byClass(file(root, files[0]), 'file-toggle')[0])
  assert.deepEqual(byClass(file(root, files[0]), 'line').map(text), initial)
})

for (const layout of ['unified', 'split']) {
  test(`${layout}: expanding first and second context folds reveals exactly hidden rows`, async t => {
    const { root } = await mount(t, { storage: new Map([['display.v1', { layout }]]) })
    const target = () => file(root, files[0])
    const contextText = () => byClass(target(), 'line').filter(n => n.props.className.split(/\s+/).includes('context')).map(n => text(byClass(n, 'linecode')[0]))
    const copies = layout === 'split' ? 2 : 1
    // GitHub semantics: leading run keeps its LAST 3 (3 rendered), trailing run
    // keeps 3 nearest the change, and the run after the last change folds to the
    // end of the file → 3 + 3 = 6 rendered contexts per side.
    assert.equal(contextText().length, 6 * copies)
    assert.equal(contextText().filter(s => s === contexts[3].slice(1)).length, 0)
    // GitHub-style expanders: reveal hidden rows progressively, then all.
    const expandAll = byLabel(target(), `Expand the remaining unchanged lines (bottom) for ${files[0]}`)
    assert.ok(expandAll, 'inline fold bar with expand-all affordance missing')
    await click(expandAll)
    // "all" opens the whole file: the in-patch rows plus every gap line of that file.
    assert.ok(contextText().length >= contexts.length * copies)
    for (const s of contexts) assert.equal(contextText().filter(v => v === s.slice(1)).length, copies)
    // Hide-all inline bar folds everything back.
    await click(byLabel(target(), `Hide all unchanged lines for ${files[0]}`))
    assert.equal(contextText().length, 0)
    assert.ok(byLabel(target(), `Show all unchanged lines for ${files[0]}`), 'hidden mode keeps the show-all bar')
    await click(byLabel(target(), `Show all unchanged lines for ${files[0]}`))
    assert.ok(contextText().length >= contexts.length * copies)
  })

  test(`${layout}: inline show-unchanged affordance acts on one file only`, async t => {
    const { root } = await mount(t, { storage: new Map([['display.v1', { layout }]]) })
    const target = () => file(root, files[0])
    const other = byClass(file(root, files[1]), 'line').map(text)
    // compact → full → hidden → full: each transition stays scoped to files[0]
    // The run after the last change merged into the bar below it, which reveals
    // the whole remaining run in one click.
    await click(byLabel(target(), `Expand the remaining unchanged lines (bottom) for ${files[0]}`))
    assert.ok(byClass(target(), 'line').filter(n => n.props.className.split(/\s+/).includes('context')).length >= contexts.length * (layout === 'split' ? 2 : 1))
    await click(byLabel(target(), `Hide all unchanged lines for ${files[0]}`))
    assert.equal(byClass(target(), 'line').filter(n => n.props.className.split(/\s+/).includes('context')).length, 0)
    assert.deepEqual(byClass(file(root, files[1]), 'line').map(text), other)
    await click(byLabel(target(), `Show all unchanged lines for ${files[0]}`))
    assert.ok(byClass(target(), 'line').filter(n => n.props.className.split(/\s+/).includes('context')).length >= contexts.length * (layout === 'split' ? 2 : 1))
    assert.deepEqual(byClass(file(root, files[1]), 'line').map(text), other)
  })
}

test('split unequal replacements pad both sides so subsequent context rows stay paired', async t => {
  const { root, storage } = await mount(t)
  await select(root, 'Layout: Split')
  assert.equal(paneSettings(storage).layout, 'split')
  const pairs = byClass(file(root, files[0]), 'split-row')
  assert.ok(pairs.length > 0)
  for (const pair of pairs) assert.equal(byClass(pair, 'line').length, 2)
  const rows = ['left', 'right'].map(side => pairs.map(pair => byClass(pair, 'line').find(n => n.props['data-side'] === side)))
  assert.equal(rows[0].length, rows[1].length)
  const codes = rows.map(side => side.map(row => text(byClass(row, 'linecode')[0])))
  for (const context of contexts.map(c => c.slice(1)).filter(s => codes[0].includes(s))) assert.equal(codes[0].indexOf(context), codes[1].indexOf(context), `mispaired ${context}`)
  assert.ok(codes[0].includes('old-short'), 'left side must show the removed text without the minus marker')
  assert.ok(!codes[1].includes('old-short'))
  assert.ok(codes[1].includes('new-third'), 'right side must show the added text without the plus marker')
  assert.equal(rows[0].filter(n => n.props.className.split(/\s+/).includes('empty')).length, 1)
})

test('commits scope selects ALL 27 commits by default, without a 20-commit cap', async t => {
  const { root, requests } = await mount(t)
  await select(root, 'Commits')
  assert.deepEqual(latestDiff(requests).searchParams.get('ref').split(','), commits.map(c => c.sha))
  assert.equal(paths(root).length, commits.length)
  await select(root, 'Clear')
  assert.equal(paths(root).length, 0, 'Clear must remain empty, not auto-select again')
  const afterClear = requests.filter(r => r.url.startsWith('/diff?')).length
  await act(async () => {})
  assert.equal(requests.filter(r => r.url.startsWith('/diff?')).length, afterClear)
  await select(root, 'Select all')
  assert.deepEqual(latestDiff(requests).searchParams.get('ref').split(','), commits.map(c => c.sha))
  assert.equal(paths(root).length, commits.length)
})

test('collapse state is saved with the pane settings', async t => {
  const storage = new Map()
  const { root } = await mount(t, { storage })
  await click(byLabel(root, `Collapse diff for ${files[1]}`))
  const saved = paneSettings(storage)
  assert.equal(saved?.collapsedFiles?.[files[1]], true, 'the collapsed file must be saved')
  assert.equal(saved.collapsedFiles[files[0]], undefined, 'only the file that was collapsed is saved')
})

test('a saved collapse state is applied on mount', async t => {
  const storage = new Map([['display.v1', { collapsedFiles: { [files[1]]: true } }]])
  const { root } = await mount(t, { storage })
  assert.ok(byLabel(root, `Expand diff for ${files[1]}`), 'a saved collapse must be applied on mount')
  assert.ok(byLabel(root, `Collapse diff for ${files[0]}`), 'a file with no saved state stays expanded')
})

test('search matches the changes, not only the file names', async t => {
  const { root } = await mount(t)
  const search = root.findAll(n => n.props['aria-label'] === 'Search files' && typeof n.props.onChange === 'function')[0]
  assert.ok(search, 'search field missing')
  const before = paths(root)
  // A token that exists only inside the diff body, taken from the rendered lines.
  const token = byClass(file(root, files[0]), 'linecode').map(text).map(s => s.trim())
    .find(s => s.length > 5 && !before.some(p => p.includes(s)))
  assert.ok(token, 'need a body token to search')
  await act(async () => search.props.onChange(token.slice(0, 6)))
  const after = paths(root)
  assert.ok(after.includes(files[0]), `a file whose changed line matches "${token.slice(0, 6)}" must stay visible`)
  assert.ok(after.length <= before.length, 'search must not add files')
})

test('the empty state names the scope being reviewed', async t => {
  const { root } = await mount(t, { diffOverride: { patch: '', added: 0, removed: 0, note: '' } })
  await select(root, 'Staged')
  const titles = root.findAll(n => n.props && typeof n.props.title === 'string').map(n => n.props.title)
  assert.ok(titles.some(t => /staged/i.test(t)), `a staged scope with nothing staged must say so, got ${JSON.stringify(titles)}`)
})

test('Word wrap changes rendered diff class and survives remount settings', async t => {
  const storage = new Map([['display.v1', { wordWrap: true }]])
  const { root } = await mount(t, { storage })
  assert.equal(byClass(root, 'wordw').length, files.length)
  await act(async () => switchFor(root, 'Word wrap').props.onCheckedChange(false))
  assert.equal(byClass(root, 'wordw').length, 0)
  assert.equal(paneSettings(storage).wordWrap, false)
})

test('Last agent turn scope: POSTs /turn-diff with the stored baseline; empty state without one', async t => {
  const storage = new Map([['turnBase.v1', { ['/repositories/architecture/a-very-long-repository-name-for-toolbar-sizing']: { base: 'a'.repeat(40), untracked: ['pre.txt'], at: 1 } }]])
  const { root, requests, ctx } = await mount(t, { storage })
  await select(root, 'Last agent turn')
  const post = requests.find(r => r.url === '/turn-diff' && r.options?.method === 'POST')
  assert.ok(post, 'agent_turn must POST /turn-diff')
  assert.deepEqual(post.options.body, {
    repo: '/repositories/architecture/a-very-long-repository-name-for-toolbar-sizing',
    base: 'a'.repeat(40), preexisting_untracked: ['pre.txt'], ignore_ws: false,
  })
  assert.ok(!requests.some(r => r.url.startsWith('/diff?') && r.url.includes('scope=agent_turn')), 'agent_turn must not use GET /diff')
  assert.ok(paths(root).length > 0, 'baseline diff must render sections')
  // no baseline → friendly empty state, no request
  const bare = new Map()
  const fixture2 = makeContext({ storage: bare })
  let r2
  await act(async () => { r2 = TestRenderer.create(jsx(GitReview, { ctx: fixture2.ctx })) })
  const menu2 = r2.root.findAll(n => typeof n.props.onSelect === 'function' && text(n) === 'Last agent turn')[0]
  await act(async () => { menu2.props.onSelect({ preventDefault() {} }) })
  const empty = r2.root.findAll(n => n.props && typeof n.props.title === 'string' && n.props.title.includes('No agent turn observed'))[0]
  assert.ok(empty, 'no-baseline empty state missing')
})

test('a busy rising edge snapshots the turn baseline via POST /turn-base', async t => {
  const { host } = await import('@hermes/plugin-sdk')
  const prev = host.state
  const cur = { cwd: repo, profile: 'default', connectionId: 'local', busy: false }
  host.state = Object.fromEntries(Object.keys(cur).map(k => [k, { get: () => cur[k] }]))
  t.after(() => { host.state = prev })
  const fixture = makeContext()
  const { requests } = fixture
  const mounted = await mount(t, { storage: fixture.storage })
  // simulate the SDK pushing a new busy atom value: swap the getter, then force a
  // re-render — the stub atom has no subscribe, so useValue picks it up on render.
  cur.busy = true
  await act(async () => { mounted.renderer.update(jsx(GitReview, { ctx: fixture.ctx })) })
  const post = requests.find(r => r.url === '/turn-base' && r.options?.method === 'POST')
  assert.ok(post, 'busy rising edge must POST /turn-base')
  assert.equal(post.options.body.repo, repo)
})

test('unified: gap expander fetches outside-patch lines from /file-lines', async t => {
  const { root, requests } = await mount(t)
  const target = () => file(root, files[0])
  const expander = target().findAll(n => typeof n.props.onClick === 'function' && (n.props['aria-label'] || '').includes('(top)'))[0]
  assert.ok(expander, 'top gap expander bar missing')
  await click(expander)
  // The pane pre-loads gaps for the visible file, so the click's request is the latest one.
  const post = [...requests].reverse().find(r => r.url === '/file-lines' && r.options?.method === 'POST')
  assert.ok(post, 'gap expander must POST /file-lines')
  // One control reveals the whole run: it reaches back to the file start rather
  // than stopping 20 lines short of it.
  assert.equal(post.options.body.start, 1, 'a gap bar must reveal its whole run in one click')
  assert.deepEqual({ ...post.options.body, start: 0, end: 0 }, { repo, path: files[0], rev: 'worktree', start: 0, end: 0 })
  assert.ok(byClass(target(), 'linecode').some(n => text(n) === `filler-${post.options.body.end}`), 'fetched gap line must render')
})


// Real `git diff -U3` output: a hunk that ends with fewer than 3 trailing context lines
// means the file ended, so there is nothing below to reveal; exactly 3 means it may go on.
const realPatch = (trailing) => ({ patch: ['diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', `@@ -10,5 +10,5 @@`, ' c1', ' c2', ' c3', '-old', '+new', ...Array.from({ length: trailing }, (_, i) => ` t${i}`)].join('\n'), added: 1, removed: 1, note: '' })
const belowBars = (root) => byClass(root, 'fold-inline').map(n => n.props['aria-label'] || '').filter(l => l.includes('(bottom)'))

test('the bar below the last hunk names the lines it hides when the total is known', async t => {
  const { root } = await mount(t, { diffOverride: { ...realPatch(5), total_lines: { 'a.txt': 40 } } })
  const bar = byClass(root, 'fold-inline').find(n => (n.props['aria-label'] || '').includes('(bottom)'))
  assert.ok(bar, 'bottom bar missing')
  assert.match(bar.props['aria-label'], /all 26 unchanged lines/, 'lines 15..40 are 26 lines')
})

test('the bar below the last hunk loads the lines it stands for', async t => {
  const { root, requests } = await mount(t, { diffOverride: realPatch(5) })
  const bar = byClass(root, 'fold-inline').find(n => (n.props['aria-label'] || '').includes('(bottom)'))
  assert.ok(bar, 'bottom bar missing')
  await click(bar)
  const post = requests.find(r => r.url === '/file-lines' && r.options?.method === 'POST')
  assert.ok(post, 'the bottom bar must fetch the lines it hides')
  assert.equal(post.options.body.start, 15, 'the run starts after the last hunk\'s context')
  assert.ok(post.options.body.end > post.options.body.start, 'the request must cover a run')
})

test('no "below" bar when the last hunk ends before 3 trailing lines (file ended)', async t => {
  const { root } = await mount(t, { diffOverride: realPatch(1) })
  assert.deepEqual(belowBars(root), [])
})

test('"below" bar shows when the last hunk has the full 3 trailing lines (file may continue)', async t => {
  const { root } = await mount(t, { diffOverride: realPatch(3) })
  assert.equal(belowBars(root).length, 1)
})
