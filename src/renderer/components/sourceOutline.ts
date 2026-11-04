/**
 * The open file's classes and functions, from Ambio's index, kept on the same
 * code as it is edited: the breadcrumb above the editor, and Ctrl+click to a
 * definition in the same file.
 */

import { StateEffect, StateField, type Text } from '@codemirror/state'

export interface OutlineSymbol {
  name: string
  kind: string
  from: number
  to: number
}

export const setOutline = StateEffect.define<readonly OutlineSymbol[]>()

export const outlineField = StateField.define<readonly OutlineSymbol[]>({
  create: () => [],
  update(symbols, tr) {
    for (const effect of tr.effects) if (effect.is(setOutline)) return effect.value
    if (!tr.docChanged) return symbols
    // Text typed just above a definition pushes it down; text typed at its end stays inside.
    return symbols.map(symbol => ({ ...symbol, from: tr.changes.mapPos(symbol.from, 1), to: tr.changes.mapPos(symbol.to, -1) }))
      .filter(symbol => symbol.to >= symbol.from)
  },
})

/** Indexed symbols, by line, as positions in the document the editor holds. */
export function outlineFromSymbols(doc: Text, symbols: readonly { name: string; kind: string; lineStart: number; lineEnd: number }[]): OutlineSymbol[] {
  return symbols
    .filter(symbol => symbol.lineStart >= 1 && symbol.lineStart <= doc.lines)
    .map(symbol => ({
      name: symbol.name,
      kind: symbol.kind,
      from: doc.line(symbol.lineStart).from,
      to: doc.line(Math.min(Math.max(symbol.lineEnd, symbol.lineStart), doc.lines)).to,
    }))
}

const SCOPES = new Set(['class', 'interface', 'type', 'function', 'method', 'struct', 'enum', 'trait', 'module', 'namespace'])

/** The classes and functions around a position, outermost first. */
export function enclosingSymbols(outline: readonly OutlineSymbol[], position: number): OutlineSymbol[] {
  return outline
    .filter(symbol => SCOPES.has(symbol.kind.toLowerCase()) && symbol.from <= position && position <= symbol.to)
    .sort((a, b) => (b.to - b.from) - (a.to - a.from) || a.from - b.from)
}

/**
 * The definition of this name in the same file: the only one, or the one
 * whose own first line was clicked. Two of the same name elsewhere in the
 * file are not guessed between.
 */
export function definitionInFile(outline: readonly OutlineSymbol[], name: string, position: number, doc: Text): OutlineSymbol | null {
  const named = outline.filter(symbol => symbol.name === name)
  if (named.length === 1) return named[0]
  const line = doc.lineAt(position).number
  return named.find(symbol => doc.lineAt(symbol.from).number === line) ?? null
}
