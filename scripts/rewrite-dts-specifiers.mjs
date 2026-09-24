// tsc emits declarations that keep the source's explicit `.ts` specifiers, and a consumer
// type-checking those hits TS5097 unless they enable allowImportingTsExtensions — which no
// consumer should. rewriteRelativeImportExtensions only rewrites emitted JS, not .d.ts, so
// rewrite relative `./x.ts` -> `./x.js` here. Resolution then finds ./x.d.ts beside it.
import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

const dir = process.argv[2] ?? 'dist'
const SPECIFIER = /(from\s+|import\s*\(\s*)(['"])(\.\.?\/[^'"]+)\.ts\2/g

const declarations = walk(dir).filter((f) => f.endsWith('.d.ts'))

let changed = 0
for (const path of declarations) {
  const before = readFileSync(path, 'utf8')
  const after = before.replace(SPECIFIER, (_m, kw, q, spec) => `${kw}${q}${spec}.js${q}`)
  if (after !== before) { writeFileSync(path, after); changed++ }
}

const leftover = declarations.filter((f) => SPECIFIER.test(readFileSync(f, 'utf8')))
if (leftover.length) {
  console.error(`rewrite-dts-specifiers: .ts specifiers survive in ${leftover.join(', ')}`)
  process.exit(1)
}
console.log(`rewrite-dts-specifiers: ${changed} file(s) rewritten in ${dir}`)
