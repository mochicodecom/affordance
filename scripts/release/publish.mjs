import assert from 'node:assert/strict'
import { join } from 'node:path'
import { output, readArtifacts, readJson, registry, run } from './artifacts.mjs'

const artifacts = readArtifacts()
assert.deepEqual(
  readJson(join(output, 'checked.json')),
  artifacts,
  'Run release:smoke on these tarballs before publishing',
)
if (process.env.GITHUB_ACTIONS === 'true') {
  assert.equal(
    process.env.GITHUB_REF,
    `refs/tags/v${artifacts[0].version}`,
    'Release tag must match package versions',
  )
}
for (const artifact of artifacts) {
  // A failed multi-package release can be rerun, but a published version
  // with different bytes must never be silently accepted.
  const response = await fetch(
    `${registry}/${encodeURIComponent(artifact.name)}/${artifact.version}`,
  )
  if (response.ok) {
    const published = await response.json()
    assert.equal(
      published.dist.integrity,
      artifact.integrity,
      `${artifact.name} already exists with different contents`,
    )
    console.log(
      `${artifact.name}@${artifact.version} already published; skipping.`,
    )
    continue
  }
  assert.equal(
    response.status,
    404,
    `Registry lookup failed for ${artifact.name}`,
  )
  run('npm', [
    'publish',
    join(output, artifact.file),
    '--access',
    'public',
    '--tag',
    'latest',
    '--registry',
    registry,
  ])
}
