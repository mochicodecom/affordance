import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  integrity,
  output,
  packages,
  run,
  validatePackages,
} from './artifacts.mjs'

validatePackages()
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
const artifacts = []
for (const pkg of packages) {
  run('pnpm', ['pack', '--pack-destination', output], pkg.directory)
  const file = `${pkg.name.slice(1).replace('/', '-')}-${pkg.version}.tgz`
  assert.match(file, /^[a-z0-9.-]+\.tgz$/)
  artifacts.push({
    name: pkg.name,
    version: pkg.version,
    file,
    integrity: integrity(join(output, file)),
  })
}
writeFileSync(
  join(output, 'manifest.json'),
  `${JSON.stringify(artifacts, null, 2)}\n`,
)
