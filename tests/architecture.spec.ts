import { readdirSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const ROOT = resolve(import.meta.dirname, '..')
const SOURCE_ROOT = resolve(ROOT, 'src')

interface ImportEdge {
  readonly source: string
  readonly specifier: string
  readonly target?: string
}

function sourceFiles(directory = SOURCE_ROOT): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(directory, entry.name)
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith('.ts') ? [path] : []
  })
}

function isRuntimeClause(clause: ts.ImportClause | undefined): boolean {
  if (clause === undefined) return true
  if (clause.isTypeOnly) return false
  if (clause.name !== undefined || clause.namedBindings === undefined) return true
  if (ts.isNamespaceImport(clause.namedBindings)) return true
  return clause.namedBindings.elements.some(element => !element.isTypeOnly)
}

function importEdges(files: readonly string[]): ImportEdge[] {
  const known = new Set(files)
  const edges: ImportEdge[] = []
  for (const source of files) {
    const file = ts.createSourceFile(source, readFileSync(source, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const statement of file.statements) {
      let specifier: string | undefined
      let runtime = false
      if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifier = statement.moduleSpecifier.text
        runtime = isRuntimeClause(statement.importClause)
      } else if (ts.isExportDeclaration(statement) && statement.moduleSpecifier !== undefined && ts.isStringLiteral(statement.moduleSpecifier)) {
        specifier = statement.moduleSpecifier.text
        runtime = !statement.isTypeOnly
          && (statement.exportClause === undefined
            || ts.isNamespaceExport(statement.exportClause)
            || statement.exportClause.elements.some(element => !element.isTypeOnly))
      }
      if (!runtime || specifier === undefined) continue
      const candidate = specifier.startsWith('.') ? resolve(dirname(source), specifier) : undefined
      edges.push({ source, specifier, target: candidate !== undefined && known.has(candidate) ? candidate : undefined })
    }
  }
  return edges
}

function runtimeCycles(files: readonly string[], edges: readonly ImportEdge[]): string[][] {
  const outgoing = new Map(files.map(file => [file, [] as string[]]))
  for (const edge of edges) {
    if (edge.target !== undefined) outgoing.get(edge.source)?.push(edge.target)
  }
  const state = new Map<string, 'visiting' | 'done'>()
  const stack: string[] = []
  const cycles: string[][] = []
  const visit = (file: string): void => {
    state.set(file, 'visiting')
    stack.push(file)
    for (const target of outgoing.get(file) ?? []) {
      if (state.get(target) === 'visiting') {
        const start = stack.indexOf(target)
        cycles.push([...stack.slice(start), target])
      } else if (state.get(target) === undefined) {
        visit(target)
      }
    }
    stack.pop()
    state.set(file, 'done')
  }
  for (const file of files) {
    if (state.get(file) === undefined) visit(file)
  }
  return cycles
}

const projectPath = (path: string): string => relative(ROOT, path).replaceAll('\\', '/')

describe('source architecture boundaries', () => {
  const files = sourceFiles()
  const edges = importEdges(files)

  it('keeps the runtime module graph acyclic', () => {
    const cycles = runtimeCycles(files, edges).map(cycle => cycle.map(projectPath))
    expect(cycles).toEqual([])
  })

  it('keeps runner, panel, UI, and session layers out of their forbidden dependencies', () => {
    const violations: string[] = []
    for (const edge of edges) {
      const source = projectPath(edge.source)
      const target = edge.target === undefined ? edge.specifier : projectPath(edge.target)
      if (source.startsWith('src/runner/') && (target === 'src/app.ts' || target === 'src/composer.ts' || target.startsWith('src/panels/'))) {
        violations.push(`${source} -> ${target}`)
      }
      if ((source.startsWith('src/panels/') || source.startsWith('src/ui/')) && (target === 'src/app.ts' || target === 'src/composer.ts')) {
        violations.push(`${source} -> ${target}`)
      }
      if (source.startsWith('src/session/') && edge.specifier === 'ink') {
        violations.push(`${source} -> ink`)
      }
    }
    expect(violations).toEqual([])
  })
})
