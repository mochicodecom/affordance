import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const root = fileURLToPath(new URL('../../', import.meta.url))
export const output = join(root, 'dist/npm')
export const registry = 'https://registry.npmjs.org'
export const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))
export const packages = ['core', 'pg'].map((directory) => ({
  directory: join(root, 'packages', directory),
  ...readJson(join(root, 'packages', directory, 'package.json')),
}))

export function run(command, args, cwd = root) {
  execFileSync(command, args, { cwd, stdio: 'inherit' })
}

export function integrity(path) {
  return `sha512-${createHash('sha512').update(readFileSync(path)).digest('base64')}`
}

export function validatePackages() {
  const version = packages[0].version
  assert.match(version, /^\d+\.\d+\.\d+$/, 'Use a synchronized stable version')
  const license = readFileSync(join(root, 'LICENSE'), 'utf8')
  for (const pkg of packages) {
    assert.equal(pkg.version, version, 'Public package versions must match')
    assert.notEqual(pkg.private, true)
    assert.equal(pkg.license, 'MIT')
    assert.equal(pkg.publishConfig.access, 'public')
    assert.equal(pkg.publishConfig.registry, registry)
    assert.equal(readFileSync(join(pkg.directory, 'LICENSE'), 'utf8'), license)
  }
  return version
}

export function readArtifacts() {
  validatePackages()
  const artifacts = readJson(join(output, 'manifest.json'))
  assert.equal(artifacts.length, packages.length)
  for (const [index, artifact] of artifacts.entries()) {
    const pkg = packages[index]
    assert.equal(artifact.name, pkg.name)
    assert.equal(artifact.version, pkg.version)
    assert.equal(
      artifact.file,
      `${pkg.name.slice(1).replace('/', '-')}-${pkg.version}.tgz`,
    )
    assert.equal(integrity(join(output, artifact.file)), artifact.integrity)
  }
  return artifacts
}
