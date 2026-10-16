// Regenerate the images in docs/ used by the README and the catalog entry.
// Run: npm run shots. Renders the real pane against tests/demo-fixtures.mjs.
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
process.env.HERMES_FIXTURES ||= path.join(root, 'tests/demo-fixtures.mjs')
const { startLayoutHarness } = await import('../tests/browser-harness.mjs')

const shots = [
  { file: 'pane-unified.png', width: 1280, query: 'layout=unified&wrap=true' },
  { file: 'pane-split.png', width: 1280, query: 'layout=split&wrap=true' },
  { file: 'pane-narrow.png', width: 420, query: 'layout=unified&wrap=true' },
]

const out = path.join(root, 'docs')
await fs.mkdir(out, { recursive: true })
const harness = await startLayoutHarness()
const browser = await chromium.launch({ headless: true })
let server = harness.server
try {
  for (const shot of shots) {
    const page = await browser.newPage({ viewport: { width: shot.width, height: 900 }, reducedMotion: 'reduce' })
    try {
      await page.goto(`${harness.url}?${shot.query}`)
      await page.locator('.af-file').first().waitFor({ timeout: 45000 })
      await page.evaluate(() => document.fonts.ready)
      const target = path.join(out, shot.file)
      await page.screenshot({ path: target })
      console.log(`wrote docs/${shot.file} (${shot.width}px ${shot.query})`)
    } finally {
      await page.close()
    }
  }
} finally {
  await browser.close()
  await server.close()
}
