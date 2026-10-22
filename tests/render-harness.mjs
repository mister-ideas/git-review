// Node interaction layer: real React and plugin, SDK TEST DOUBLES (not SDK DOM).
import TestRenderer from 'react-test-renderer'
import { jsx } from 'react/jsx-runtime'
import { GitReview } from '../desktop/plugin.js'
import { makeContext } from './fixtures.mjs'
export const { act } = TestRenderer
export const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : (node.children || []).map(text).join('')
export const hasClass = (node, name) => typeof node.type === 'string' && (node.props.className || '').split(/\s+/).includes(name)
export const byClass = (root, name) => root.findAll(n => hasClass(n, name))
export const byLabel = (root, label) => root.findAll(n => n.props['aria-label'] === label && typeof n.props.onClick === 'function')[0]
export const switchFor = (root, label) => root.findAll(n => n.props['aria-label'] === label && typeof n.props.onCheckedChange === 'function')[0]
export const menuItem = (root, label) => root.findAll(n => typeof n.props.onSelect === 'function' && text(n) === label)[0]
export async function click(node) {
  if (!node) throw new Error('Required interaction target not rendered')
  await act(async () => { await node.props.onClick({ stopPropagation() {}, preventDefault() {} }) })
}
// Line selection lives on the gutter (the code keeps its text cursor), so tests
// press the line-number cell the way a user does.
export async function gutterDown(node) {
  if (!node) throw new Error('Required gutter not rendered')
  await act(async () => { node.props.onClick({ button: 0, stopPropagation() {}, preventDefault() {} }) })
}
export async function gutterEnter(node) {
  if (!node) throw new Error('Required gutter not rendered')
  await act(async () => { node.props.onMouseEnter({ buttons: 1, stopPropagation() {}, preventDefault() {} }) })
}
export async function select(root, label) {
  const node = menuItem(root, label)
  if (!node) throw new Error(`Required menu item not rendered: ${label}`)
  await act(async () => { node.props.onSelect({ preventDefault() {} }) })
}
const timerTests = new WeakSet()
export async function mount(t, options = {}) {
  if (!timerTests.has(t)) { t.mock.timers.enable({ apis: ['setTimeout'] }); timerTests.add(t) }
  const fixture = makeContext(options)
  let renderer
  await act(async () => { renderer = TestRenderer.create(jsx(GitReview, { ctx: fixture.ctx })) })
  t.after(async () => { await act(async () => renderer.unmount()) })
  return { ...fixture, renderer, root: renderer.root }
}
export const paths = root => byClass(root, 'af-file').map(n => n.props['data-path'])
export const file = (root, path) => byClass(root, 'af-file').find(n => n.props['data-path'] === path)
export const latestDiff = requests => new URL(requests.filter(r => r.url.startsWith('/diff?')).at(-1).url, 'http://fixture.local')
