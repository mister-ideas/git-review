// Effect-driven plugin tests; SDK is a Node test double, never SDK layout proof.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mount, byClass, byLabel, click, text, select, paths, latestDiff, hasClass } from './render-harness.mjs'
import { files, repo, makeContext, commits } from './fixtures.mjs'
import { act } from './render-harness.mjs'
import { host } from '@hermes/plugin-sdk'
import { jsx } from 'react/jsx-runtime'
import { GitReview } from '../desktop/plugin.js'

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
