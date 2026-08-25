// Inline shared assets into every lesson/reference page, in place.
//
// Authoring workflow: write a page with
//   <link rel="stylesheet" href="../assets/lesson.css">
//   <script src="../assets/quiz.js"></script>
// then run `node docs/tutorial/inline-assets.mjs`. Each reference is replaced
// with the asset's current content, so pages are self-contained (they render
// styled anywhere — file://, side panels, mail). Already-inlined pages are
// left untouched; to pick up asset changes, restore the tags and re-run.

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const asset = (name) => readFileSync(join(root, 'assets', name), 'utf8')

const replacements = [
  {
    tag: /<link rel="stylesheet" href="\.{1,2}\/assets\/lesson\.css">/g,
    inline: () => `<style>\n${asset('lesson.css')}</style>`,
  },
  {
    tag: /<script src="\.{1,2}\/assets\/quiz\.js"><\/script>/g,
    inline: () => `<script>\n${asset('quiz.js')}</script>`,
  },
]

for (const dir of ['.', 'lessons', 'reference']) {
  for (const file of readdirSync(join(root, dir))) {
    if (!file.endsWith('.html')) continue
    const path = join(root, dir, file)
    const source = readFileSync(path, 'utf8')
    let out = source
    for (const { tag, inline } of replacements) out = out.replace(tag, inline)
    if (out !== source) {
      writeFileSync(path, out)
      console.log(`inlined: ${dir}/${file}`)
    }
  }
}
