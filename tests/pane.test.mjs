// Effect-driven plugin tests; SDK is a Node test double, never SDK layout proof.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mount, byClass, byLabel, click, text, select, paths, latestDiff, hasClass, file } from './render-harness.mjs'
import { files, repo, makeContext, commits } from './fixtures.mjs'
import { act } from './render-harness.mjs'
import { host } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { readFileSync } from 'node:fs'
import { GitReview, filesToOpen, collapseRows, scrollTopFor } from '../desktop/plugin.js'

// Mutable real host-atom values; explicit rerenders mirror SDK subscriptions.
async function withHost(t, values = {}) {
  const previous = host.state
  let current = { cwd: '', profile: 'default', connectionId: 'local', ...values }
  host.state = Object.fromEntries(Object.keys(current).map(key => [key, { get: () => current[key] }]))
  t.after(() => { host.state = previous })
  return async (renderer, ctx, patch) => {
    current = { ...current, ...patch }
    await act(async () => renderer.update(jsx(GitReview, { ctx })))
  }
}

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r }); return { promise, resolve } }

async function instrument(t, handler, values) {
  const update = await withHost(t, values)
  const fixture = makeContext()
  const original = fixture.ctx.rest
  fixture.ctx.rest = (url, options) => handler(new URL(url, 'http://fixture.local'), () => original(url, options))
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const TestRenderer = (await import('react-test-renderer')).default
  let renderer
  await act(async () => { renderer = TestRenderer.create(jsx(GitReview, { ctx: fixture.ctx })) })
  t.after(async () => { await act(async () => renderer.unmount()) })
  return { ...fixture, renderer, root: renderer.root, update: patch => update(renderer, fixture.ctx, patch) }
}

for (const initial of [null, { id: 8, repo, scope: 'staged' }]) {
  test(`selection primes initial ${initial ? 'existing request once' : 'null'} then applies first new request`, async t => {
    let pending = initial
    const polls = []
    const { requests } = await instrument(t, (u, fallback) => {
      if (u.pathname !== '/pending-select') return fallback()
      polls.push(u.searchParams.get('after'))
      return Promise.resolve({ request: pending && pending.id > Number(u.searchParams.get('after')) ? pending : null })
    })
    assert.equal(latestDiff(requests).searchParams.get('scope'), 'uncommitted')
    pending = { id: 9, repo, scope: 'staged' }
    await act(async () => t.mock.timers.tick(3000))
    assert.equal(latestDiff(requests).searchParams.get('scope'), 'staged')
    assert.deepEqual(polls, ['0', initial ? '8' : '0'])
  })
}

for (const switchKey of ['profile', 'connectionId']) {
  test(`${switchKey} switch resets poll cursor/repository; ctx recreation does not`, async t => {
    let pending = null
    const polls = []
    const { root, renderer, ctx, requests, update } = await instrument(t, (u, fallback) => {
      if (u.pathname !== '/pending-select') return fallback()
      polls.push(u.searchParams.get('after'))
      return Promise.resolve({ request: pending && pending.id > Number(u.searchParams.get('after')) ? pending : null })
    })
    pending = { id: 90, repo: '/old-profile/repo', scope: 'range', ref: 'main..HEAD', base: 'main', path: 'old.ts' }
    await act(async () => t.mock.timers.tick(3000))
    assert.equal(latestDiff(requests).searchParams.get('repo'), '/old-profile/repo')
    await act(async () => renderer.update(jsx(GitReview, { ctx: { ...ctx } })))
    assert.equal(polls.at(-1), '90', 'ctx object changes must not reset identity')
    pending = null // A different backend/profile has its own sequence.
    await update({ [switchKey]: 'other' })
    assert.equal(polls.at(-1), '0')
    assert.equal(latestDiff(requests).searchParams.get('repo'), repo)
    assert.equal(latestDiff(requests).searchParams.get('scope'), 'uncommitted')
    assert.equal(latestDiff(requests).searchParams.has('path'), false)
    pending = { id: 1, repo, scope: 'staged' }
    await act(async () => t.mock.timers.tick(3000))
    assert.equal(latestDiff(requests).searchParams.get('scope'), 'staged')
  })
}

for (const winner of ['focusB', 'manual', 'agent']) {
  test(`deferred cwdA metadata cannot overwrite ${winner} selection`, async t => {
    const a = deferred(), b = deferred()
    let pending = null
    const { root, requests, update } = await instrument(t, (u, fallback) => {
      if (u.pathname === '/meta' && !u.searchParams.has('cwd')) {
        if (u.searchParams.get('repo') === '/cwdA') return a.promise
        if (u.searchParams.get('repo') === '/cwdB') return b.promise
      }
      if (u.pathname === '/pending-select') return Promise.resolve({ request: pending })
      return fallback()
    }, { cwd: '/cwdA' })
    let expected = repo
    if (winner === 'focusB') {
      await update({ cwd: '/cwdB' })
      expected = '/repoB'
      await act(async () => b.resolve({ repo: expected }))
    } else if (winner === 'manual') {
      // Choosing the already selected worktree is still a deliberate action.
      const item = root.findAll(n => typeof n.props.onSelect === 'function' && n.key !== '' && text(n).includes(repo.split('/').at(-1)))[0]
      await act(async () => item.props.onSelect())
    } else {
      expected = '/agentRepo'
      pending = { id: 1, repo: expected, scope: 'staged' }
      await act(async () => t.mock.timers.tick(3000))
    }
    await act(async () => a.resolve({ repo: '/staleRepoA' }))
    assert.equal(latestDiff(requests).searchParams.get('repo'), expected)
  })
}

test('60 full SHAs are sent intact and history truncation remains visible beside real patches', async t => {
  const many = Array.from({ length: 60 }, (_, i) => ({ ...commits[0], sha: i.toString(16).padStart(8, '0') + 'a'.repeat(32) }))
  const historyQueries = []
  const { root, requests } = await instrument(t, (u, fallback) => {
    if (u.pathname !== '/commits') return fallback()
    historyQueries.push(u)
    return Promise.resolve({ commits: many, truncated: true, note: 'Showing the latest 60 commits; older history is omitted.' })
  })
  await select(root, 'Commits')
  const request = latestDiff(requests)
  assert.deepEqual(request.searchParams.get('ref').split(','), many.map(c => c.sha))
  assert.equal(paths(root).length, 60)
  assert.match(text(root), /older history is omitted/)
  const commitsQueries = historyQueries.filter((u, i) => true)
  assert.ok(commitsQueries.every(u => !u.searchParams.get('base')), 'history must not inherit a branch base')
})

test('branch picker picks a comparison base: never checks anything out, adds no scope of its own', async t => {
  const { root, requests } = await mount(t)
  const branchMenu = root.findAll(n => (n.props.className || '').includes('repo-menu') && text(n).includes('main'))[0]
  assert.ok(branchMenu, 'branch menu missing')
  assert.ok(!requests.some(r => /checkout|switch/.test(r.url)))
  const scopeMenuItems = root.findAll(n => typeof n.props.onSelect === 'function' && text(n) === 'Branch vs base')
  assert.equal(scopeMenuItems.length, 0, 'Branch vs base must be removed from the scope menu')
})

test('click line then another highlights the range; cite inserts native @line reference in composer draft', async t => {
  const inserted = []
  const original = host.composer
  host.composer = { ...original, insertText: (sessionId, value, opts) => { if (sessionId !== null) throw new Error('cite must target the focused composer (null)'); if (typeof value !== 'string') throw new Error('insertText(sessionId, text) — text must be the 2nd argument'); inserted.push(value) } }
  t.after(() => { host.composer = original })
  const { root } = await mount(t)
  const lines = () => root.findAll(n => hasClass(n, 'line') && typeof n.props.onClick === 'function')
  const selected = () => root.findAll(n => hasClass(n, 'line-selected'))
  // first click anchors (within one file — selections never cross files)
  const inFile = lines().filter((n) => { let p = n; while (p && !(p.props && p.props['data-path'])) p = p.parent; return p?.props?.['data-path'] === 'src/architecture/deep/main.ts' })
  await click(inFile[0])
  assert.equal(selected().length, 1, 'anchor line must highlight')
  // second click in the same file completes the range (12 context lines apart in the fixture)
  await click(inFile[inFile.length - 1])
  assert.ok(selected().length > 1, `expected range highlight, got ${selected().length}`)
  // cite bar appears with native reference and inserts into the composer draft
  const cite = byLabel(root, 'Cite selected lines in focused message draft')
  assert.ok(cite, 'cite action missing')
  await click(cite)
  assert.equal(inserted.length, 1)
  // With no focused-session cwd the ref stays absolute (fixture repo prefix);
  // with a session cwd it comes out repo-relative — both are valid @line refs.
  assert.match(inserted[0], /^@line:(?:\/repositories\/[^:\s]+\/)?src\/architecture\/deep\/main\.ts:\d+-\d+$/)
  assert.equal(selected().length, 0, 'selection clears after citing')
})

test('clicking the only selected line again leaves selection mode', async t => {
  const { root } = await mount(t)
  const lines = () => root.findAll(n => hasClass(n, 'line') && typeof n.props.onClick === 'function')
  const selected = () => root.findAll(n => hasClass(n, 'line-selected'))
  await click(lines()[0])
  assert.equal(selected().length, 1, 'first click anchors')
  await click(lines()[0])
  assert.equal(selected().length, 0, 'clicking the selected line again must clear the selection')
})

test('a click that is not on a line leaves selection mode', async t => {
  const { root } = await mount(t)
  const lines = () => root.findAll(n => hasClass(n, 'line') && typeof n.props.onClick === 'function')
  const selected = () => root.findAll(n => hasClass(n, 'line-selected'))
  await click(lines()[0])
  assert.equal(selected().length, 1)
  const pane = root.findAll(n => hasClass(n, 'grd'))[0]
  assert.ok(pane?.props?.onClick, 'the pane must clear a selection on an outside click')
  await act(async () => pane.props.onClick())
  assert.equal(selected().length, 0, 'an outside click must clear the selection')
})

test('a selection spanning a hidden run cites the exact range', async t => {
  const inserted = []
  const original = host.composer
  host.composer = { ...original, insertText: (sessionId, value) => { if (sessionId !== null) throw new Error('cite must target the focused composer (null)'); inserted.push(value) } }
  t.after(() => { host.composer = original })
  const { root } = await mount(t)
  const path = 'src/architecture/deep/main.ts'
  const fileOf = (n) => { let p = n; while (p && !(p.props && p.props['data-path'])) p = p.parent; return p?.props?.['data-path'] }
  const inFile = () => root.findAll(n => hasClass(n, 'line') && typeof n.props.onClick === 'function').filter((n) => fileOf(n) === path)
  // Reveal the file, then hide it: the run between the two changes is only
  // hidden once the file is in "full" mode and the hide bar is used.
  await click(byLabel(root, `Expand the remaining unchanged lines (bottom) for ${path}`))
  await click(byLabel(root, `Hide all unchanged lines for ${path}`))
  const shown = inFile()
  assert.ok(shown.length >= 2, 'need two lines to select across the hidden run')
  await click(shown[0])
  await click(shown[shown.length - 1])
  await click(byLabel(root, 'Cite selected lines in focused message draft'))
  assert.equal(inserted.length, 1)
  const m = inserted[0].match(/^@line:(?:\/repositories\/[^:\s]+\/)?src\/architecture\/deep\/main\.ts:(\d+)-(\d+)$/)
  assert.ok(m, `unexpected ref ${inserted[0]}`)
  assert.ok(Number(m[2]) > Number(m[1]), 'the range must span the hidden lines')
})

test('clearing the line selection removes highlight and inserts nothing', async t => {
  const inserted = []
  const original = host.composer
  host.composer = { ...original, insertText: (sessionId, value, opts) => { if (sessionId !== null) throw new Error('cite must target the focused composer (null)'); if (typeof value !== 'string') throw new Error('insertText(sessionId, text) — text must be the 2nd argument'); inserted.push(value) } }
  t.after(() => { host.composer = original })
  const { root } = await mount(t)
  const lines = () => root.findAll(n => hasClass(n, 'line') && typeof n.props.onClick === 'function')
  await click(lines()[0])
  await click(lines()[2])
  await click(byLabel(root, 'Clear line selection'))
  assert.equal(root.findAll(n => hasClass(n, 'line-selected')).length, 0)
  assert.equal(inserted.length, 0)
})

test('worktree/meta effects populate repository and current branch', async t => {
  const { root, requests } = await mount(t)
  assert.ok(requests.some(r => r.url.startsWith('/worktrees?')))
  assert.ok(requests.some(r => r.url.startsWith('/meta?')))
  assert.ok(byClass(root, 'toolbar')[0].findAll(n => text(n).includes('a-very-long-repository-name')).length)
  assert.ok(byClass(root, 'toolbar')[0].findAll(n => text(n).includes('feature/a-very-long-branch-name')).length)
  assert.deepEqual(paths(root), files)
})

for (const [url, label] of [['https://gitlab.com/g/r/-/merge_requests/7', 'Open MR !7'], ['https://github.com/g/r/pull/9', 'Open PR #9']]) {
  test(`loaded review badge opens exact URL: ${label}`, async t => {
    const { root, external } = await mount(t, { pr: { url, iid: label.endsWith('7') ? 7 : 9, title: 'Fixture review' } })
    await click(byLabel(root, label))
    assert.deepEqual(external, [url])
  })
}

test('backend diff rejection renders actionable error alert, no stale diff', async t => {
  const { root } = await mount(t, { fail: '/diff' })
  const alerts = root.findAll(n => n.type === 'div' && n.props.role === 'alert')
  assert.equal(alerts.length, 1)
  assert.match(text(alerts[0]), /Could not compute this diff/)
  assert.equal(paths(root).length, 0)
})

test('scope interaction changes the actual REST scope; removed chat actions stay absent', async t => {
  const { root, requests } = await mount(t)
  await select(root, 'Staged')
  assert.equal(latestDiff(requests).searchParams.get('scope'), 'staged')
  assert.ok(!text(byClass(root, 'toolbar')[0]).includes('Find Issues'))
  assert.ok(!text(byClass(root, 'toolbar')[0]).includes('Send to chat'))
})

test('a run after the last change folds to the end of the file', () => {
  const rows = [
    { kind: 'context', before: 1, after: 1, text: ' a', hunk: 0 },
    { kind: 'add', before: 1, after: 2, text: '+b', hunk: 0 },
    ...Array.from({ length: 10 }, (_, i) => ({ kind: 'context', before: 2 + i, after: 3 + i, text: ` c${i}`, hunk: 0 })),
  ]
  const out = collapseRows(rows, 3)
  assert.equal(out.at(-1).kind, 'fold', 'the last run must end in its expander, not in a tail below it')
  assert.equal(out.filter((r) => r.kind === 'fold').length, 1)
  assert.equal(out.filter((r) => r.kind === 'context').length, 4, 'one leading line and the 3 nearest the change')
})

test('a run between two changes keeps both of its ends', () => {
  const ctx = (n, from) => Array.from({ length: n }, (_, i) => ({ kind: 'context', before: from + i, after: from + i, text: ` c${from + i}`, hunk: 0 }))
  const out = collapseRows([
    { kind: 'add', before: 1, after: 1, text: '+a', hunk: 0 },
    ...ctx(10, 2),
    { kind: 'remove', before: 12, after: 12, text: '-z', hunk: 0 },
    ...ctx(2, 13),
  ], 3)
  assert.equal(out.filter((r) => r.kind === 'fold').length, 1)
  assert.equal(out[out.length - 1].kind, 'context', 'the tail of a middle run stays visible')
})

test('picking a branch asks for commits since it, and the trigger names it', async t => {
  const { root, requests } = await mount(t)
  await select(root, 'Commits')
  const rows = () => root.findAll(n => typeof n.props.onSelect === 'function').map(n => text(n))
  // One row per branch: origin/main is the same branch as main and must not be
  // listed a second time under its remote name.
  assert.equal(rows().filter(t => t.includes('origin/main')).length, 0, 'a remote counterpart must not be listed twice')
  assert.equal(rows().filter(t => t.startsWith('main')).length, 1, 'main must be listed once')
  const row = root.findAll(n => typeof n.props.onSelect === 'function' && text(n).startsWith('main'))[0]
  assert.ok(row, 'branch row missing')
  await act(async () => row.props.onSelect())
  const last = [...requests].reverse().find(r => r.url.startsWith('/commits?'))
  assert.ok(last, 'picking a branch must refetch the commit list')
  assert.match(decodeURIComponent(last.url), /[?&]base=main/, 'the commit query must carry the chosen base')
  const labels = root.findAll(n => typeof n.type === 'string' && typeof n.props?.className === 'string' && n.props.className.includes('repo-text')).map(text)
  // The control picks a comparison base, so it must not read as the branch we are
  // on: the checked-out branch is named in the menu as "current".
  assert.ok(labels.some(t => t.trim() === 'vs main'), `the base control must name the comparison, got ${JSON.stringify(labels)}`)
})

test('the menu headers sit on the menu surface, and the divider is the desktop sash', async t => {
  const { root } = await mount(t)
  const css = root.findAll(n => n.type === 'style').map(n => (n.children || []).join('')).join('')
  assert.match(css, /\.menu-group[^{]*\{[^}]*background:var\(--ui-bg-elevated/, 'sticky group headers must be opaque: the menu surface is painted on the content element, where a child cannot inherit it')
  assert.ok(!/\.menu-group[^{]*\{[^}]*background:inherit/.test(css), 'inherit resolves to transparent inside the scroll wrapper')
  assert.match(css, /\.resizer\{[^}]*width:4px/, 'the divider must be a 4px sash, like the desktop\'s')
  assert.match(css, /\.resizer:hover[^{]*\{[^}]*ui-sash-hover-background/, 'the sash must fill with the desktop\'s hover token')
})

test('the diff column reserves no scrollbar gutter and styles no scrollbar', () => {
  // scrollbar-gutter: stable showed as permanent dead space, and styling any
  // ::-webkit-scrollbar part makes Chromium draw a classic bar that never goes
  // away. Left alone, the column gets the system overlay bar, only while scrolling.
  const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8');
  const rule = src.match(/\.grd \.allfiles\{[^}]*\}/)?.[0] || '';
  assert.ok(rule, 'the diff column style exists')
  assert.ok(!/scrollbar-gutter/.test(rule), 'no reserved gutter')
  // The core styles every scrollbar globally, which reserves width; the column
  // zeroes it and draws a floating bar over the diff instead.
  assert.match(src, /\.grd \.allfiles::-webkit-scrollbar\{width:0;height:0\}/, 'the native bar takes no width')
  assert.match(src, /\.grd \.ov-bar\{/, 'a floating bar is the affordance')
})

test('toolbar icon buttons are ghost, so none of them draws a border', () => {
  // The PR/MR button was the only icon-sm button on `outline`, which reads as an
  // unwanted border next to its ghost siblings. Outline is reserved for the one
  // text action (Cite in message) in the selection bar.
  const src = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8');
  const outlined = src.match(/variant: "outline"/g) || [];
  assert.equal(outlined.length, 1, 'exactly one outlined button, and it is text')
  assert.match(src, /variant: "outline", size: "sm", "aria-label": "Cite selected lines/)
})

test('scrollToSelection lands the header exactly at the top of the diff column', () => {
  // A section 300px into the column, already scrolled 200px, must return the
  // absolute scrollTop that puts its header flush with the column's top edge.
  assert.equal(scrollTopFor({ elementTop: 100, scrollerTop: 0, scrollTop: 200 }), 300)
  // The column itself offset down the viewport: only the delta matters.
  assert.equal(scrollTopFor({ elementTop: 140, scrollerTop: 40, scrollTop: 200 }), 300)
  // Never overscroll past the top when the header is already above the fold.
  assert.equal(scrollTopFor({ elementTop: 10, scrollerTop: 0, scrollTop: 0 }), 10)
  assert.equal(scrollTopFor({ elementTop: 10, scrollerTop: 0, scrollTop: 0, sticky: 34 }), 0)
})

test('the file section keeps no scroll margin, so a jump cannot stop short', () => {
  // scroll-margin-top made the sticky header land below the previous file's
  // header; the offset is computed instead. A stray margin is invisible in logic
  // tests and only shows up as a misaligned jump, so it is pinned here.
  const css = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8');
  assert.ok(!/\.af-file\{[^}]*scroll-margin-top/.test(css), 'no scroll margin on .af-file')
})

test('a menu group title has a rule above it, never below', () => {
  const css = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8');
  const group = css.match(/\.menu-group\{[^}]*\}/)?.[0] || '';
  assert.ok(group, 'the group style exists')
  assert.ok(!/border-bottom/.test(group), 'the divider lives above the title only')
})

test('filesToOpen: only files whose changes changed, and only when collapsed', () => {
  const prev = new Map([['a.txt', '1:0:10'], ['b.txt', '2:0:20']])
  const next = new Map([['a.txt', '1:0:10'], ['b.txt', '5:0:50'], ['c.txt', '0:1:8']])
  assert.deepEqual(filesToOpen(prev, next, { 'b.txt': true, 'c.txt': true }), ['b.txt', 'c.txt'],
    'a file with new changes, and a new file, must open')
  assert.deepEqual(filesToOpen(prev, next, { 'a.txt': true }), [],
    'a collapsed file whose changes did not change stays collapsed')
  assert.deepEqual(filesToOpen(prev, next, { 'b.txt': false }), [],
    'an expanded file is left alone')
  assert.deepEqual(filesToOpen(null, next, { 'b.txt': true }), [],
    'the first observation of a scope is not a change')
})

test('a gap bar sits between the hunks, not one row inside the next one', async t => {
  const twoHunks = [
    'diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt',
    '@@ -10,8 +10,8 @@', ' c10', ' c11', ' c12', '-old1', '+new1', ' c13', ' c14', ' c15',
    '@@ -40,8 +40,8 @@', ' c40', ' c41', ' c42', '-old2', '+new2', ' c43', ' c44', ' c45',
  ].join('\n')
  const { root } = await mount(t, { diffOverride: { patch: twoHunks, added: 2, removed: 2, note: '' } })
  // Document order: rows and bars as they are painted.
  const nodes = root.findAll((n) => typeof n.type === 'string' && (hasClass(n, 'fold') || hasClass(n, 'line')))
  const i15 = nodes.findIndex((n) => hasClass(n, 'line') && text(n).includes('c15'))
  assert.ok(i15 >= 0, 'last row of the first hunk missing')
  assert.ok(hasClass(nodes[i15 + 1], 'fold'), `a bar must close the run right after c15, got ${JSON.stringify(text(nodes[i15 + 1]))}`)
  assert.ok(text(nodes[i15 + 2]).includes('c40'), `the bar must precede the second hunk, got ${JSON.stringify(text(nodes[i15 + 2]))}`)
})

test('exactly one bar between two hunks, and none when the file ends there', async t => {
  const twoHunks = [
    'diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt',
    '@@ -10,8 +10,8 @@', ' c10', ' c11', ' c12', '-old1', '+new1', ' c13', ' c14', ' c15',
    '@@ -40,8 +40,8 @@', ' c40', ' c41', ' c42', '-old2', '+new2', ' c43', ' c44', ' c45',
  ].join('\n')
  const { root } = await mount(t, { diffOverride: { patch: twoHunks, added: 2, removed: 2, note: '', total_lines: { 'a.txt': 60 } } })
  const bars = byClass(file(root, 'a.txt'), 'fold-inline').map(n => n.props['aria-label'] || '')
  assert.equal(bars.filter(l => l.includes('(mid')).length, 1, `the run between the hunks must be exactly one bar, got ${JSON.stringify(bars)}`)
})

test('a real -U3 patch with two hunks puts one bar between them, not two', async t => {
  const patchText = [
    'diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt',
    '@@ -10,8 +10,8 @@', ' c10', ' c11', ' c12', '-old1', '+new1', ' c13', ' c14', ' c15',
    '@@ -40,8 +40,8 @@', ' c40', ' c41', ' c42', '-old2', '+new2', ' c43', ' c44', ' c45',
  ].join('\n')
  const { root } = await mount(t, { diffOverride: { patch: patchText, added: 2, removed: 2, note: '', total_lines: { 'a.txt': 60 } } })
  const bars = byClass(root, 'fold')
  assert.ok(bars.length > 0, 'the untouched run between the hunks must have a bar')
  const stacked = bars.filter((b, i) => {
    const prev = bars[i - 1]
    if (!b.parent || prev?.parent !== b.parent) return false
    const kids = (b.parent.children || []).filter((c) => c && typeof c === 'object')
    return kids.indexOf(b) - kids.indexOf(prev) === 1
  })
  assert.equal(stacked.length, 0, `${stacked.length} pair(s) of expanders stack with no change between them`)
})

test('a hidden run renders one expander, never two stacked', async t => {
  const { root } = await mount(t)
  const bars = byClass(root, 'fold')
  assert.ok(bars.length > 0, 'no expanders rendered for the fixture')
  // Expanders are siblings in the diff body; two in a row means one hidden run
  // was split into two controls instead of one bar covering the whole run.
  const stacked = bars.filter((b, i) => {
    const prev = bars[i - 1]
    if (!b.parent || prev?.parent !== b.parent) return false
    const kids = (b.parent.children || []).filter((c) => c && typeof c === 'object')
    return kids.indexOf(b) - kids.indexOf(prev) === 1
  })
  assert.equal(stacked.length, 0, `${stacked.length} pair(s) of expanders stack with no change between them`)
})

test('menu rows share one label slot, and the churn colours survive the portal', async t => {
  const { root } = await mount(t)
  // A menu portals to document.body, outside .grd, so a menu surface has to
  // carry the class the stylesheet scopes its own content to — otherwise the
  // churn colours, group headers and scroll cap silently stop applying.
  const surfaces = root.findAll(n => typeof n.props.className === 'string' && n.props.className.includes('repo-menu'))
  assert.ok(surfaces.length, 'menu surfaces missing')
  assert.ok(surfaces.every(s => s.props.className.split(/\s+/).includes('gr-menu')),
    'a menu surface is missing the menu scope class, so its content escapes every rule')
  const css = root.findAll(n => n.type === 'style').map(n => (n.children || []).join('')).join('')
  assert.match(css, /\.gr-menu \.fdelta \.add\{color:var\(--ui-green\)\}/, 'the added-line colour is not scoped to the menu surface')
  assert.match(css, /\.gr-menu \.fdelta \.del\{color:var\(--ui-red\)\}/, 'the removed-line colour is not scoped to the menu surface')
  // A row whose children are a bare array renders its label without the shared
  // gap, so its text starts left of every neighbour's.
  const rows = root.findAll(n => typeof n.props.onSelect === 'function'
    && n.findAll(c => (c.props.className || '').includes('check-slot')).length)
  assert.ok(rows.length > 3, `expected menu rows carrying a check slot, saw ${rows.length}`)
  const unwrapped = rows.filter(r => Array.isArray(r.props.children))
  assert.equal(unwrapped.length, 0, `${unwrapped.length} menu row(s) pass children as a bare array, so their label shifts left`)
  const gaps = [...new Set(rows.map(r => (r.props.children.props.style || {}).gap))]
  assert.deepEqual(gaps, [8], `menu rows use different label gaps: ${gaps}`)
})

test('search input callback filters real diff files case-insensitively', async t => {
  const { root } = await mount(t)
  const search = root.findAll(n => n.props['aria-label'] === 'Search files' && typeof n.props.onChange === 'function')[0]
  assert.ok(search)
  const { act } = await import('./render-harness.mjs')
  await act(async () => search.props.onChange('MAIN.TEST'))
  assert.deepEqual(paths(root), [files[2]])
  await act(async () => search.props.onChange(''))
  assert.deepEqual(paths(root), files)
})
