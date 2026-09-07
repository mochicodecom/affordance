import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  output,
  packages,
  readArtifacts,
  readJson,
  root,
  run,
} from './artifacts.mjs'

const artifacts = readArtifacts()
const receipt = join(output, 'checked.json')
rmSync(receipt, { force: true })
for (const [index, artifact] of artifacts.entries()) {
  const path = join(output, artifact.file)
  const files = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' })
    .trim()
    .split('\n')
  for (const file of files) {
    assert.match(
      file,
      /^package\/(?:package\.json|README\.md|LICENSE|dist\/.+\.(?:js|js\.map|d\.ts))$/,
    )
    assert(!file.includes('/../'))
  }
  for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    'dist/index.js',
    'dist/index.d.ts',
  ]) {
    assert(
      files.includes(`package/${required}`),
      `Missing ${required} in ${artifact.name}`,
    )
  }
  const packed = JSON.parse(
    execFileSync('tar', ['-xOf', path, 'package/package.json'], {
      encoding: 'utf8',
    }),
  )
  assert.equal(packed.name, artifact.name)
  assert.equal(packed.version, artifact.version)
  assert.deepEqual(packed.exports, packages[index].exports)
  assert.notEqual(packed.private, true)
  for (const [name, version] of Object.entries(packed.dependencies ?? {})) {
    assert(
      !/^(workspace:|file:|link:)/.test(version),
      `Unresolved dependency ${name}`,
    )
    if (name.startsWith('@affordance/')) {
      assert(
        artifacts.some(
          (entry) => entry.name === name && entry.version === version,
        ),
        `Private or mismatched dependency ${name}`,
      )
    }
  }
}

// Outside the workspace: neither its symlinks nor its dev dependencies can
// conceal missing exports, declarations, or dependencies in a tarball.
const consumer = mkdtempSync(join(tmpdir(), 'affordance-consumer-'))
try {
  const app = readJson(join(root, 'packages/reference-app/package.json'))
  const ts = readJson(join(root, 'node_modules/typescript/package.json'))
  writeFileSync(
    join(consumer, 'package.json'),
    JSON.stringify(
      {
        name: 'affordance-release-consumer',
        private: true,
        type: 'module',
        dependencies: {
          ...Object.fromEntries(
            artifacts.map((entry) => [
              entry.name,
              `file:${join(output, entry.file)}`,
            ]),
          ),
          pg: app.dependencies.pg,
          zod: app.dependencies.zod,
        },
        devDependencies: { typescript: ts.version },
      },
      null,
      2,
    ),
  )
  copyFileSync(
    new URL('./consumer.ts', import.meta.url),
    join(consumer, 'consumer.ts'),
  )
  writeFileSync(
    join(consumer, 'tsconfig.json'),
    JSON.stringify(
      {
        compilerOptions: {
          target: 'ES2023',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: false,
          verbatimModuleSyntax: true,
          outDir: 'dist',
        },
        include: ['consumer.ts'],
      },
      null,
      2,
    ),
  )
  run(
    'npm',
    [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--package-lock=false',
    ],
    consumer,
  )
  run(
    process.execPath,
    ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.json'],
    consumer,
  )
  run(process.execPath, ['dist/consumer.js'], consumer)
  writeFileSync(receipt, `${JSON.stringify(artifacts, null, 2)}\n`)
  console.log(
    'Tarball contents, consumer types, and Postgres/HTTP execution passed.',
  )
} finally {
  rmSync(consumer, { recursive: true, force: true })
}
