/**
 * The CodeMirror setup behind the source viewer: Dark Modern colours, the
 * file's own line endings, and the lines someone pointed at, highlighted and
 * kept on the same code as it is edited.
 */

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, HighlightStyle, indentOnInput, LanguageDescription, syntaxHighlighting } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { EditorState, StateField, type Extension, type Range } from '@codemirror/state'
import { Decoration, type DecorationSet, drawSelection, dropCursor, EditorView, highlightActiveLine, highlightActiveLineGutter, highlightSpecialChars, keymap, lineNumbers, rectangularSelection } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import { sourceChanges, targetLinesFacet } from './sourceChanges.ts'

/**
 * The line break a file uses, so a save writes the same bytes the person did
 * not touch. Only that separator splits lines; a stray other break stays in
 * its line (shown as a special character) and is written back as it was.
 */
export function lineSeparatorOf(content: string): '\n' | '\r\n' {
  const crlf = content.match(/\r\n/g)?.length ?? 0
  const lf = (content.match(/\n/g)?.length ?? 0) - crlf
  return crlf > lf ? '\r\n' : '\n'
}

/** The editor language for a file, loaded on demand; null for plain text. */
export async function languageFor(relPath: string): Promise<Extension | null> {
  const description = LanguageDescription.matchFilename(languages, relPath.split('/').pop() ?? relPath)
  if (!description) return null
  try { return await description.load() } catch { return null }
}

/** VS Code's Dark Modern token colours (Dark+). */
const darkModern = HighlightStyle.define([
  { tag: [t.keyword, t.modifier, t.operatorKeyword, t.definitionKeyword, t.bool, t.null, t.atom, t.self], color: '#569CD6' },
  { tag: [t.controlKeyword, t.moduleKeyword], color: '#C586C0' },
  { tag: [t.string, t.special(t.string), t.character, t.attributeValue], color: '#CE9178' },
  { tag: [t.regexp, t.escape], color: '#D16969' },
  { tag: [t.number, t.unit], color: '#B5CEA8' },
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: '#6A9955' },
  { tag: [t.function(t.variableName), t.function(t.propertyName), t.function(t.definition(t.variableName)), t.macroName], color: '#DCDCAA' },
  { tag: [t.typeName, t.className, t.namespace, t.definition(t.typeName), t.standard(t.typeName)], color: '#4EC9B0' },
  { tag: [t.variableName, t.propertyName, t.attributeName, t.definition(t.variableName), t.definition(t.propertyName), t.labelName], color: '#9CDCFE' },
  { tag: [t.constant(t.variableName), t.standard(t.variableName)], color: '#4FC1FF' },
  { tag: [t.tagName, t.angleBracket], color: '#569CD6' },
  { tag: [t.operator, t.punctuation, t.separator, t.bracket], color: '#D4D4D4' },
  { tag: t.heading, color: '#569CD6', fontWeight: 'bold' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: 'bold' },
  { tag: t.link, color: '#CE9178', textDecoration: 'underline' },
  { tag: t.invalid, color: '#F44747' },
])

const theme = EditorView.theme({
  '&': { height: '100%', color: '#CCCCCC', backgroundColor: '#111719', fontSize: '12px' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.55' },
  '.cm-content': { padding: '10px 0 24px', caretColor: '#AEAFAD' },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: '#AEAFAD' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': { backgroundColor: '#264F78' },
  '.cm-gutters': { backgroundColor: '#141b1e', color: '#66736f', borderRight: '1px solid #263134' },
  '.cm-lineNumbers .cm-gutterElement': { minWidth: '44px', paddingRight: '10px' },
  '.cm-activeLine': { backgroundColor: 'rgba(255, 255, 255, 0.035)' },
  '.cm-activeLineGutter': { backgroundColor: '#1a2224', color: '#aab6b1' },
  '.cm-line.source-preview-line-highlighted': { backgroundColor: 'rgba(60, 125, 118, 0.27)', boxShadow: 'inset 3px 0 0 #65a69d' },
  '.cm-matchingBracket': { backgroundColor: 'rgba(101, 166, 157, 0.3)', outline: '1px solid #65a69d' },
  '.cm-selectionMatch': { backgroundColor: 'rgba(173, 214, 255, 0.15)' },
  '.cm-searchMatch': { backgroundColor: 'rgba(234, 92, 0, 0.33)' },
  '.cm-searchMatch-selected': { backgroundColor: 'rgba(98, 51, 21, 0.9)' },
  '.cm-panels': { backgroundColor: '#1a2224', color: '#cccccc' },
  '.cm-panels.cm-panels-bottom': { borderTop: '1px solid #263134' },
  '.cm-panel input, .cm-panel button': { fontSize: '11px' },
  '.cm-foldPlaceholder': { backgroundColor: '#263134', border: 'none', color: '#aab6b1' },
  // Changes since the last commit: green added, blue changed, red removed (a
  // wedge between lines); violet when only agents changed the file since.
  '.cm-change-gutter': { width: '6px', cursor: 'pointer' },
  '.cm-change-gutter .cm-gutterElement': { padding: '0' },
  '.cm-change-mark': { height: '100%', width: '3px', marginLeft: '1px' },
  '.cm-change-added': { backgroundColor: '#2EA043' },
  '.cm-change-modified': { backgroundColor: '#1B81A8' },
  '.cm-change-added.cm-change-by-agent': { backgroundColor: '#B180D7' },
  '.cm-change-modified.cm-change-by-agent': { background: 'repeating-linear-gradient(180deg, #B180D7 0 3px, transparent 3px 5px)' },
  '.cm-change-deleted': { height: '0', width: '0', marginTop: '-4px', borderTop: '4px solid transparent', borderBottom: '4px solid transparent', borderLeft: '6px solid #F14C4C' },
  '.cm-change-peek': { margin: '2px 0 4px', borderTop: '1px solid #3d4b47', borderBottom: '1px solid #3d4b47', backgroundColor: '#161e20', fontFamily: 'var(--font-mono)' },
  '.cm-change-peek-head': { display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 10px', color: '#aab6b1', fontSize: '11px' },
  '.cm-change-peek-head span': { flex: '1' },
  '.cm-change-peek-head button': { padding: '2px 8px', border: '1px solid #4d5955', borderRadius: '1px', backgroundColor: '#263134', color: '#e6e1d6', fontSize: '11px', cursor: 'pointer' },
  '.cm-change-peek-head button:hover': { borderColor: '#6fa9a0' },
  '.cm-change-peek-old': { margin: '0', padding: '4px 10px 6px', backgroundColor: 'rgba(241, 76, 76, 0.12)', color: '#d7b3ae', whiteSpace: 'pre', overflowX: 'auto' },
  '.cm-overview-ruler': { position: 'absolute', top: '0', right: '0', bottom: '0', width: '12px', pointerEvents: 'none', zIndex: '3' },
  '.cm-overview-mark': { position: 'absolute', left: '2px', right: '2px', opacity: '0.85' },
  '.cm-overview-added': { backgroundColor: '#2EA043' },
  '.cm-overview-modified': { backgroundColor: '#1B81A8' },
  '.cm-overview-deleted': { backgroundColor: '#F14C4C', height: '3px !important' },
  '.cm-overview-by-agent.cm-overview-added, .cm-overview-by-agent.cm-overview-modified': { backgroundColor: '#B180D7' },
  '.cm-overview-target': { left: '0', right: '6px', backgroundColor: '#65a69d' },
  '.cm-overview-search': { left: '6px', right: '0', height: '2px !important', backgroundColor: '#D18616' },
}, { dark: true })

const targetLine = Decoration.line({ class: 'source-preview-line-highlighted' })

/** The pointed-at lines, which move with the code when lines above them change. */
function targetLines(start: number, end: number): Extension {
  const build = (state: EditorState): DecorationSet => {
    const ranges: Range<Decoration>[] = []
    const last = Math.min(end, state.doc.lines)
    for (let number = Math.max(1, start); number <= last; number++) ranges.push(targetLine.range(state.doc.line(number).from))
    return Decoration.set(ranges)
  }
  return StateField.define<DecorationSet>({
    create: build,
    update: (decorations, transaction) => decorations.map(transaction.changes),
    provide: field => EditorView.decorations.from(field),
  })
}

export interface SourceEditorOptions {
  content: string
  range: { start: number; end: number }
  /** Compartment-wrapped extensions the dialog reconfigures: language, read-only, diff. */
  dynamic: Extension
  onSave: () => boolean
  onChange: (state: EditorState) => void
  /** Ctrl+I, VS Code's inline-chat key: ask the agent about the selection. */
  onAsk?: () => boolean
}

export function sourceEditorState({ content, range, dynamic, onSave, onChange, onAsk }: SourceEditorOptions): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [
      EditorState.lineSeparator.of(lineSeparatorOf(content)),
      lineNumbers(),
      highlightActiveLineGutter(),
      foldGutter(),
      sourceChanges(),
      targetLinesFacet.of(range),
      highlightSpecialChars(),
      history(),
      drawSelection(),
      dropCursor(),
      EditorState.allowMultipleSelections.of(true),
      indentOnInput(),
      syntaxHighlighting(darkModern),
      bracketMatching(),
      rectangularSelection(),
      highlightActiveLine(),
      highlightSelectionMatches(),
      keymap.of([{ key: 'Mod-s', run: onSave, preventDefault: true }, ...(onAsk ? [{ key: 'Mod-i', run: onAsk, preventDefault: true }] : []), ...defaultKeymap, ...searchKeymap, ...historyKeymap, ...foldKeymap, indentWithTab]),
      targetLines(range.start, range.end),
      EditorView.updateListener.of(update => { if (update.docChanged) onChange(update.state) }),
      theme,
      dynamic,
    ],
  })
}

/** At most this many lines of code go into a message to an agent; it can read the rest. */
const MAX_ASK_LINES = 200

/**
 * The start of a message to an agent about some lines of a file: where they
 * are, as a reference Ambio's chat turns back into a link, and the code
 * itself, fenced so nothing in it can end the fence. The person writes the
 * question after it.
 */
export function askAboutLines(relPath: string, fromLine: number, toLine: number, code: string): string {
  const where = fromLine === toLine ? `${relPath}:${fromLine}` : `${relPath}:${fromLine}-${toLine}`
  const lines = code.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  const shown = lines.slice(0, MAX_ASK_LINES).join('\n')
  const longestRun = Math.max(2, ...[...shown.matchAll(/`+/g)].map(run => run[0].length))
  const fence = '`'.repeat(longestRun + 1)
  const language = LanguageDescription.matchFilename(languages, relPath.split('/').pop() ?? relPath)
  const tag = language ? (language.alias[0] ?? language.name.toLowerCase()).replace(/\s+/g, '') : ''
  const cut = lines.length > MAX_ASK_LINES ? `\n(First ${MAX_ASK_LINES} of ${lines.length} lines; read the file for the rest.)` : ''
  return `About \`${where}\`:\n\n${fence}${tag}\n${shown}\n${fence}${cut}\n\n`
}

/** Put the first pointed-at line in the middle of the view, with the cursor on it. */
export function revealLine(view: EditorView, line: number): void {
  if (line < 1 || line > view.state.doc.lines) return
  const at = view.state.doc.line(line).from
  view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) })
}
