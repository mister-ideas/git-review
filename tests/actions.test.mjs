// Write actions, syntax colours and file icons: real plugin + React, SDK test doubles.
import test from 'node:test'
import assert from 'node:assert/strict'
import { act, byLabel, click, menuItem, mount, select, text } from './render-harness.mjs'
import { branch, files, repo } from './fixtures.mjs'
import plugin, { codiconForPath, discardPathsFor, errorText, syntaxFamily, tokenizeLine } from '../desktop/plugin.js'

const ship = { writable: true, branch, upstream: `origin/${branch}`, ahead: 0, behind: 0, has_origin: true, host: 'github', repo_programs: false, pr_ready: true }
const status = { files: [
  { path: files[0], orig: null, staged: 1, unstaged: 0, untracked: false, status: 'modified' },
  { path: files[1], orig: null, staged: 0, unstaged: 1, untracked: false, status: 'modified' },
  { path: files[2], orig: null, staged: 1, unstaged: 1, untracked: false, status: 'modified' },
], ahead: 0, behind: 0 }
const posts = (requests, route) => requests.filter(r => r.url === route && r.options?.method === 'POST')
const field = root => root.findAll(n => n.props['aria-label'] === 'Commit message' && typeof n.props.onChange === 'function')[0]
const settle = async () => { await act(async () => { await new Promise(r => setImmediate(r)) }) }

test('an older backend without /ship keeps the pane read-only', async t => {
  const { root } = await mount(t)
  assert.ok(!byLabel(root, `Stage ${files[1]}`))
  assert.ok(!field(root))
})

test('per-file stage and unstage follow where each file\'s changes sit', async t => {
  const { root, requests } = await mount(t, { ship, status })
  assert.ok(byLabel(root, `Unstage ${files[0]}`), 'staged file offers Unstage')
  assert.ok(!byLabel(root, `Stage ${files[0]}`), 'fully staged file has nothing to stage')
  assert.ok(byLabel(root, `Stage ${files[1]}`), 'unstaged file offers Stage')
  assert.ok(byLabel(root, `Stage ${files[2]}`) && byLabel(root, `Unstage ${files[2]}`), 'partly staged file offers both')
  assert.ok(root.findAll(n => (n.props.className || '').split(' ').includes('af-staged') && text(n) === 'partly staged').length, 'partly staged badge')
  const diffsBefore = requests.filter(r => r.url.startsWith('/diff?')).length
  await click(byLabel(root, `Stage ${files[1]}`))
  const [post] = posts(requests, '/stage')
  assert.deepEqual(post.options.body.paths, [files[1]])
  assert.equal(post.options.body.repo, repo)
  assert.ok(requests.filter(r => r.url.startsWith('/diff?')).length > diffsBefore, 'a write re-reads the diff')
})

test('discard asks first through Desktop\'s confirmation dialog, then posts the file', async t => {
  const { root, requests } = await mount(t, { ship, status })
  await click(byLabel(root, `Discard changes to ${files[1]}`))
  assert.equal(posts(requests, '/discard').length, 0, 'nothing is discarded before confirming')
  const dialog = root.findAll(n => typeof n.props.onConfirm === 'function')[0]
  assert.ok(dialog, 'confirmation dialog is open')
  assert.equal(dialog.props.destructive, true)
  assert.match(dialog.props.title, /Discard changes to other\.ts/)
  await act(async () => { await dialog.props.onConfirm() })
  assert.deepEqual(posts(requests, '/discard')[0].options.body.paths, [files[1]])
})

test('a renamed file discards both of its names', () => {
  assert.deepEqual(discardPathsFor('new.txt', { orig: 'old.txt' }), ['new.txt', 'old.txt'])
  assert.deepEqual(discardPathsFor('a.txt', { orig: null }), ['a.txt'])
  assert.deepEqual(discardPathsFor('a.txt', undefined), ['a.txt'])
})

test('commit sends the message, then clears the box', async t => {
  const { root, requests } = await mount(t, { ship, status })
  await act(async () => { field(root).props.onChange({ target: { value: 'feat: stage from the pane' } }) })
  assert.equal(field(root).props.value, 'feat: stage from the pane')
  await click(byLabel(root, 'Commit'))
  const [post] = posts(requests, '/commit')
  assert.deepEqual({ message: post.options.body.message, push: post.options.body.push }, { message: 'feat: stage from the pane', push: false })
  assert.equal(field(root).props.value, '')
})

test('commit & push from the split menu, and the default can be switched and is remembered', async t => {
  const { root, requests, storage } = await mount(t, { ship, status })
  await act(async () => { field(root).props.onChange({ target: { value: 'fix: push it' } }) })
  await select(root, 'Commit & push')
  assert.equal(posts(requests, '/commit')[0].options.body.push, true)
  await select(root, 'Make Commit & push the default')
  assert.equal(storage.get('ship.v1').commitDefault, 'commitPush')
  assert.ok(byLabel(root, 'Commit & push'), 'the main button now commits and pushes')
})

test('a failed write reports the backend reason and changes nothing', async t => {
  const { host } = await import('@hermes/plugin-sdk')
  const seen = []
  const prev = host.notify
  host.notify = n => seen.push(n)
  t.after(() => { host.notify = prev })
  const writes = { stage: new Error('409: {"detail":"This repository\'s own config names programs git would run (filter.x.clean)."}') }
  const { root } = await mount(t, { ship, status, writes })
  await click(byLabel(root, `Stage ${files[1]}`))
  assert.equal(seen.at(-1).kind, 'error')
  assert.match(seen.at(-1).message, /filter\.x\.clean/)
})

test('the commit message is drafted with Hermes\'s commit_message one-shot template', async t => {
  const { host } = await import('@hermes/plugin-sdk')
  const calls = []
  host.request = async (method, params) => { calls.push({ method, params }); return { text: 'feat: drafted by hermes' } }
  t.after(() => { delete host.request })
  const { root, requests } = await mount(t, { ship, status })
  await click(byLabel(root, 'Generate commit message'))
  await settle()
  assert.equal(posts(requests, '/commit-context').length, 1)
  assert.equal(calls[0].method, 'llm.oneshot')
  assert.equal(calls[0].params.template, 'commit_message')
  assert.deepEqual(calls[0].params.variables, { avoid: '', diff: '+x', recent_commits: 'feat: a' })
  assert.equal(field(root).props.value, 'feat: drafted by hermes')
})

test('without host.request there is no generate button', async t => {
  const { root } = await mount(t, { ship, status })
  assert.ok(!byLabel(root, 'Generate commit message'))
})

test('read_only on the backend hides every write', async t => {
  const { root } = await mount(t, { ship: { ...ship, writable: false }, status })
  assert.ok(!byLabel(root, `Stage ${files[1]}`))
  assert.ok(!field(root))
})

test('commit history is never offered writes', async t => {
  const { root } = await mount(t, { ship, status })
  await select(root, 'Commits')
  await settle()
  assert.equal(root.findAll(n => (n.props['aria-label'] || '').startsWith('Stage ')).length, 0)
  assert.ok(!field(root))
})

test('a branch with commits to push and a clean tree still shows push', async t => {
  const { root, requests } = await mount(t, { ship: { ...ship, ahead: 2 }, status: { files: [] }, diffOverride: { patch: '', added: 0, removed: 0, note: '' } })
  const push = byLabel(root, 'Push')
  assert.ok(push, 'push button')
  await click(push)
  assert.equal(posts(requests, '/push').length, 1)
})

test('create PR pushes through the backend and opens the link', async t => {
  const { root, requests, external } = await mount(t, { ship, status })
  await click(byLabel(root, 'Create pull request'))
  assert.equal(posts(requests, '/create-pr').length, 1)
  assert.deepEqual(external, ['https://github.com/o/r/pull/9'])
})

test('the Uncommitted scope asks for new files; Staged does not', async t => {
  const { root, requests } = await mount(t, { ship, status })
  const last = () => new URL(requests.filter(r => r.url.startsWith('/diff?')).at(-1).url, 'http://x')
  assert.equal(last().searchParams.get('untracked'), 'true')
  await select(root, 'Staged')
  await settle()
  assert.equal(last().searchParams.get('untracked'), null)
})

test('the Branch scope is offered and reads scope=branch', async t => {
  const { root, requests } = await mount(t)
  assert.ok(menuItem(root, 'Branch') || root.findAll(n => typeof n.props.onSelect === 'function' && text(n).includes('Branch')).length)
  await select(root, 'Branch')
  await settle()
  const url = new URL(requests.filter(r => r.url.startsWith('/diff?')).at(-1).url, 'http://x')
  assert.equal(url.searchParams.get('scope'), 'branch')
})

test('syntax colours: keywords, calls, numbers, strings and comments', () => {
  const parts = tokenizeLine('const total = sum(items, 2) // add "tax"', 'c')
  const cls = Object.fromEntries(parts.filter(([c]) => c).map(([c, v]) => [v.trim(), c]))
  assert.equal(cls.const, 'tk-k')
  assert.equal(cls.sum, 'tk-f')
  assert.equal(cls['2'], 'tk-n')
  assert.equal(cls['// add "tax"'], 'tk-c')
  assert.equal(parts.map(([, v]) => v).join(''), 'const total = sum(items, 2) // add "tax"', 'tokens rebuild the line exactly')
  const py = tokenizeLine("def run(x): return 'ok'  # done", 'py')
  assert.deepEqual(py.filter(([c]) => c).map(([c]) => c), ['tk-k', 'tk-f', 'tk-k', 'tk-s', 'tk-c'])
  assert.equal(tokenizeLine('x'.repeat(2000), 'c'), null, 'very long lines stay plain')
  assert.equal(syntaxFamily('src/a.tsx'), 'c')
  assert.equal(syntaxFamily('Dockerfile'), 'sh')
  assert.equal(syntaxFamily('notes.txt'), '')
})

test('file icons follow Desktop\'s filename table', () => {
  assert.equal(codiconForPath('README.md'), 'markdown')
  assert.equal(codiconForPath('deploy/Dockerfile'), 'package')
  assert.equal(codiconForPath('config.yml'), 'settings-gear')
  assert.equal(codiconForPath('run.sh'), 'terminal')
  assert.equal(codiconForPath('src/main.ts'), 'code')
})

test('backend errors read as their reason', () => {
  assert.equal(errorText(new Error('400: {"detail":"nothing to commit"}')), 'nothing to commit')
  assert.equal(errorText(new Error('500: boom')), 'boom')
  assert.equal(errorText(new Error('plain')), 'plain')
})

// A store that notifies like nanostores (value passed) or with a bare signal.
function store(initial, passValue) {
  let value = initial
  const subs = new Set()
  return {
    get: () => value,
    set: (v) => { value = v; subs.forEach(f => (passValue ? f(v) : f())) },
    subscribe: (f) => { subs.add(f); if (passValue) f(value); return () => subs.delete(f) },
  }
}
for (const passValue of [true, false]) {
  test(`the plugin records a turn baseline when a turn starts, pane closed (${passValue ? 'value' : 'signal'} listeners)`, async t => {
    const { host } = await import('@hermes/plugin-sdk')
    const prev = host.state
    const busy = store(false, passValue)
    host.state = { busy, cwd: store(repo, passValue) }
    const disposers = []
    t.after(() => { host.state = prev; disposers.forEach(d => d()) })
    const posts = []
    const ctx = {
      register() {}, onDispose: (d) => disposers.push(d),
      storage: { get: (k, f) => f, set() {} },
      rest: async (url, options) => { posts.push({ url, options }); return { repo, base: 'b'.repeat(40), untracked: [] } },
    }
    plugin.register(ctx)
    busy.set(true)
    busy.set(true)
    busy.set(false)
    const turnPosts = posts.filter(p => p.url === '/turn-base')
    assert.equal(turnPosts.length, 1, 'one baseline per rising edge')
    assert.equal(turnPosts[0].options.body.repo, repo)
  })
}

test('the plugin registers a rebindable shortcut, a palette row that shows it, and a status-bar count', () => {
  const regs = []
  plugin.register({ register: (r) => regs.push(r), storage: { get: (k, f) => f, set() {} }, rest: async () => ({}) })
  const kb = regs.find(r => r.area === 'keybinds')
  assert.deepEqual(kb.data.defaults, ['mod+alt+g'])
  assert.equal(regs.find(r => r.area === 'palette').data.action, kb.data.id)
  assert.equal(typeof regs.find(r => r.area === 'statusBar.right').render, 'function')
})

// #41: on a Desktop whose SDK can fold a plugin pane, the shortcut is a toggle (pressed
// while the pane is on screen it puts the pane away, pressed again it comes back), and
// the palette row is the same action. An older Desktop keeps the reveal-only shortcut.
function registrations(sdk) {
  const { host } = sdk
  const regs = []
  plugin.register({ register: (r) => regs.push(r), storage: { get: (k, f) => f, set() {} }, rest: async () => ({}) })
  return { keybind: regs.find(r => r.area === 'keybinds').data, palette: regs.find(r => r.area === 'palette').data, host }
}

test('the shortcut and the palette row toggle the pane where the Desktop can fold it', async t => {
  const sdk = await import('@hermes/plugin-sdk')
  const calls = []
  sdk.host.togglePane = (id) => calls.push(['toggle', id])
  const reveal = sdk.host.revealPane
  sdk.host.revealPane = (id) => calls.push(['reveal', id])
  t.after(() => { delete sdk.host.togglePane; sdk.host.revealPane = reveal })
  const { keybind, palette } = registrations(sdk)
  keybind.run()
  palette.run()
  assert.deepEqual(calls, [['toggle', 'git-review:pane'], ['toggle', 'git-review:pane']])
  assert.equal(keybind.label, 'Toggle git review')
  assert.equal(palette.label, keybind.label)
  // Same action id as before, so a shortcut the user rebound keeps working.
  assert.equal(keybind.id, 'git-review.open')
  assert.deepEqual(keybind.defaults, ['mod+alt+g'])
})

test('an older Desktop without a fold keeps the reveal-only shortcut', async t => {
  const sdk = await import('@hermes/plugin-sdk')
  const calls = []
  const reveal = sdk.host.revealPane
  sdk.host.revealPane = (id) => calls.push(['reveal', id])
  t.after(() => { sdk.host.revealPane = reveal })
  assert.equal(typeof sdk.host.togglePane, 'undefined')
  const { keybind, palette } = registrations(sdk)
  keybind.run()
  palette.run()
  assert.deepEqual(calls, [['reveal', 'git-review:pane'], ['reveal', 'git-review:pane']])
  assert.equal(keybind.label, 'Open git review')
})

test('files are reviewed in the file tree\'s order: folders first, new files in place', async t => {
  const { treeOrder } = await import('../desktop/plugin.js')
  const git = ['README.md', 'src/z.ts', 'src/a/b.ts', 'src/new.ts', 'a.md']
  assert.deepEqual([...git].sort(treeOrder), ['src/a/b.ts', 'src/new.ts', 'src/z.ts', 'README.md', 'a.md'])
})

test('no pull request button for a branch with nothing of its own to propose', async t => {
  const { root } = await mount(t, { ship: { ...ship, pr_ready: false }, status })
  assert.ok(!byLabel(root, 'Create pull request'))
})

test('a clean tree with commits to push keeps push, without the message box', async t => {
  const { root } = await mount(t, { ship: { ...ship, ahead: 2 }, status: { files: [] }, diffOverride: { repo_root: '/repo', patch: '', files: [] } })
  assert.ok(byLabel(root, 'Push'))
  assert.ok(!field(root))
})
