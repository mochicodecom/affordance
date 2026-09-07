import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'

// Each package runs this from its own directory. Remove stale output first.
rmSync('dist', { recursive: true, force: true })
execFileSync('pnpm', ['exec', 'tsc', '-p', 'tsconfig.build.json'], {
  stdio: 'inherit',
})
