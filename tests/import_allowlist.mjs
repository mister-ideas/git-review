// Import-allowlist gate — the desktop loader only resolves four specifiers, and the
// admission lint rejects anything else. Fails CI when plugin.js imports outside it.
// Usage: node tests/import_allowlist.mjs desktop/plugin.js
import fs from 'node:fs/promises'
import process from 'node:process'

const ALLOWED = new Set([
  '@hermes/plugin-sdk',
  'react',
  'react/jsx-runtime',
  'react/jsx-dev-runtime',
])

const source = await fs.readFile(process.argv[2] ?? 'desktop/plugin.js', 'utf8')
const specs = [...source.matchAll(/(?:^|[\n;])\s*import[\s{*[\]]([^;]*?)from\s*['"]([^'"]+)['"]/g)]
  .map((m) => m[2])
const bad = specs.filter((s) => !ALLOWED.has(s))
if (bad.length) {
  console.error(`import allowlist VIOLATION: ${bad.join(', ')} — the desktop loader refuses these`)
  process.exit(1)
}
if (/<script/i.test(source)) {
  console.error('desktop surface lint: raw <script> pattern present')
  process.exit(1)
}
if (/\beval\s*\(/.test(source)) {
  console.error('desktop surface lint: eval() present')
  process.exit(1)
}
console.log(`import allowlist OK (${specs.length} imports, all allowed; no eval/<script>)`)
