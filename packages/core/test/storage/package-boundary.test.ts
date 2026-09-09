import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(fileURLToPath(new URL('../../src/', import.meta.url)))
const files = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory()
      ? files(path)
      : entry.name.endsWith('.ts')
        ? [path]
        : []
  })
const allowed = new Set(['@standard-schema/spec'])

/** Inspect syntax, so comments about adapters cannot hide or trigger violations. */
const violations = (text: string, file: string): string[] => {
  const found: string[] = []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  const module = (specifier: string) => {
    if (specifier.startsWith('.')) {
      if (!resolve(dirname(file), specifier).startsWith(`${root}/`))
        found.push(`outside core: ${specifier}`)
    } else if (!specifier.startsWith('node:') && !allowed.has(specifier))
      found.push(`dependency: ${specifier}`)
  }
  const visit = (node: ts.Node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    )
      module(node.moduleSpecifier.text)
    if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument) &&
      ts.isStringLiteral(node.argument.literal)
    )
      module(node.argument.literal.text)
    if (ts.isCallExpression(node)) {
      if (
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'query'
      )
        found.push('SQL query call')
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      ) {
        const argument = node.arguments[0]
        if (argument && ts.isStringLiteral(argument)) module(argument.text)
        else found.push('unreviewed dynamic dependency')
      }
    }
    if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node) ||
      ts.isTemplateHead(node) ||
      ts.isTemplateMiddle(node) ||
      ts.isTemplateTail(node)
    ) {
      if (
        /\b(?:select\s+.+\s+from|insert\s+into|delete\s+from|create\s+table|alter\s+table|update\s+\S+\s+set)\b/is.test(
          node.text,
        )
      )
        found.push('SQL statement')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

describe('core storage separation', () => {
  it('keeps core imports inside core, standard schemas and Node builtins', () => {
    const found = files(root).flatMap((file) =>
      violations(readFileSync(file, 'utf8'), file).map(
        (message) => `${file}: ${message}`,
      ),
    )
    expect(found).toEqual([])
  })
  it('keeps database libraries out of published dependencies', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    expect(Object.keys(pkg.dependencies).sort()).toEqual([...allowed].sort())
    expect(pkg.peerDependencies ?? {}).toEqual({})
    expect(pkg.optionalDependencies ?? {}).toEqual({})
  })
  it('detects type, dynamic, transitive-path and SQL leaks', () => {
    for (const text of [
      "import type { Pool } from 'pg'",
      "import type { AffordancePayload } from '@affordance/contract'",
      "import type { ApiRequest } from '../../../reference-app/src/http/api.js'",
      "export { createPgStorage } from '@affordance/pg'",
      "const db = await import('pg')",
      "type Pool = import('pg').Pool",
      "import { query } from '../../../pg/src/storage.js'",
      "db.query('select id from cases')",
      `const statement = \`insert into \${table} (id) values ($1)\``,
    ])
      expect(
        violations(text, resolve(root, 'engine/engine.ts')).length,
      ).toBeGreaterThan(0)
  })
})
