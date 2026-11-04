/**
 * What has changed in the open file since its last commit, VS Code style:
 * marks in the margin (added, changed, removed) and on the scrollbar, a
 * click that shows the old lines with Revert, and Alt+F5 to step between
 * changes. Each change also says whose it is - yours, made in this editor,
 * or the agents' and other editors' recorded since the commit.
 */

import { Chunk } from '@codemirror/merge'
import { getSearchQuery } from '@codemirror/search'
import { type EditorState, type Extension, Facet, RangeSet, StateEffect, StateField, Text, type Transaction, type TransactionSpec } from '@codemirror/state'
import { Decoration, EditorView, gutter, GutterMarker, keymap, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'
import { APP_CLIENTS, CLI_CLIENTS } from '../../shared/agentDelivery.ts'
import type { FileAuthor } from '../canvas/arcdApi.ts'

/** The committed version and who has changed the file since. */
export interface Baseline {
  text: Text
  /** False when the last commit does not hold the file: every line is new. */
  tracked: boolean
  authors: readonly FileAuthor[]
}

export const setBaseline = StateEffect.define<Baseline | null>()

/** The committed text as lines the editor can compare, split the way the editor splits. */
export function baselineText(content: string, lineBreak: string): Text {
  // A Windows checkout holds CRLF while the commit may hold LF; both are the same lines.
  return Text.of(content.split(lineBreak === '\r\n' ? /\r?\n/ : '\n'))
}

interface ChangeState {
  baseline: Baseline | null
  chunks: readonly Chunk[]
  /** Ranges this editor's person typed, deleted, pasted or undid, kept in place as text moves. */
  mine: readonly { from: number; to: number }[]
}

const isPersonEdit = (tr: Transaction) => ['input', 'delete', 'move', 'undo', 'redo'].some(event => tr.isUserEvent(event))

export const changeField = StateField.define<ChangeState>({
  create: () => ({ baseline: null, chunks: [], mine: [] }),
  update(value, tr) {
    let { baseline, chunks, mine } = value
    for (const effect of tr.effects) {
      if (!effect.is(setBaseline)) continue
      baseline = effect.value
      chunks = baseline ? Chunk.build(baseline.text, tr.state.doc) : []
    }
    if (!tr.docChanged) return baseline === value.baseline ? value : { baseline, chunks, mine }
    if (baseline && baseline === value.baseline) chunks = Chunk.updateB(chunks, baseline.text, tr.state.doc, tr.changes)
    mine = mine.map(range => ({ from: tr.changes.mapPos(range.from, -1), to: tr.changes.mapPos(range.to, 1) }))
    if (isPersonEdit(tr)) tr.changes.iterChangedRanges((_fromA, _toA, fromB, toB) => { mine = [...mine, { from: fromB, to: toB }] })
    return { baseline, chunks, mine }
  },
})

export type ChangeKind = 'added' | 'modified' | 'deleted'
export type ChangeOwner = 'mine' | 'agent' | 'other'

export function changeKind(chunk: Chunk): ChangeKind {
  if (chunk.fromA === chunk.toA) return 'added'
  if (chunk.fromB === chunk.toB) return 'deleted'
  return 'modified'
}

/**
 * Whose a change is. Yours when you made it in this editor; the agents' when
 * only agents changed the file since its commit; otherwise "other" (another
 * editor, or a mix the journal cannot split by line).
 */
export function changeOwner(chunk: Chunk, state: ChangeState, within?: { from: number; to: number }): ChangeOwner {
  // Within a chunk, by line: typing next to an agent's line does not make that line yours.
  const from = within?.from ?? chunk.fromB
  const to = within?.to ?? chunk.toB
  if (state.mine.some(range => range.from <= to && range.to >= from)) return 'mine'
  const authors = state.baseline?.authors ?? []
  return authors.length && authors.every(author => author.actor === 'agent') ? 'agent' : 'other'
}

const AGENT_LABELS = new Map<string, string>([...CLI_CLIENTS, ...APP_CLIENTS].map(client => [client.id, client.label.replace(/ CLI$/, '')]))

export function agentLabel(id?: string): string {
  if (!id) return 'An agent'
  return AGENT_LABELS.get(id) ?? id
}

export function ago(ms: number, now = Date.now()): string {
  const minutes = Math.round((now - ms) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  return `${Math.round(hours / 24)} d ago`
}

/** One line on who a change belongs to, for its tooltip and peek. */
export function ownerText(owner: ChangeOwner, authors: readonly FileAuthor[], now = Date.now()): string {
  if (owner === 'mine') return 'Changed by you in this editor'
  if (!authors.length) return 'Changed since the last commit'
  const named = authors.slice(0, 3).map(author => author.actor === 'agent'
    ? `${agentLabel(author.agent)}${author.goal ? ` ("${author.goal}")` : ''}, ${ago(author.lastAt, now)}`
    : `a person or another editor, ${ago(author.lastAt, now)}`)
  const more = authors.length > 3 ? ` and ${authors.length - 3} more` : ''
  return `Changed since the last commit by ${named.join('; ')}${more}`
}

const KIND_TEXT: Record<ChangeKind, string> = { added: 'Added', modified: 'Changed', deleted: 'Removed' }

class ChangeMarker extends GutterMarker {
  readonly kind: ChangeKind
  readonly owner: ChangeOwner
  readonly title: string
  constructor(kind: ChangeKind, owner: ChangeOwner, title: string) {
    super()
    this.kind = kind
    this.owner = owner
    this.title = title
  }
  eq(other: ChangeMarker) { return other.kind === this.kind && other.owner === this.owner && other.title === this.title }
  toDOM() {
    const mark = document.createElement('div')
    mark.className = `cm-change-mark cm-change-${this.kind} cm-change-by-${this.owner}`
    mark.title = this.title
    return mark
  }
}

function markers(state: EditorState): RangeSet<GutterMarker> {
  const field = state.field(changeField)
  const ranges = []
  const authors = field.baseline?.authors ?? []
  const marker = (kind: ChangeKind, owner: ChangeOwner) =>
    new ChangeMarker(kind, owner, `${KIND_TEXT[kind]}. ${ownerText(owner, authors)}. Click to see the committed lines.`)
  for (const chunk of field.chunks) {
    const kind = changeKind(chunk)
    if (kind === 'deleted') {
      ranges.push(marker(kind, changeOwner(chunk, field)).range(state.doc.lineAt(Math.min(chunk.fromB, state.doc.length)).from))
      continue
    }
    const first = state.doc.lineAt(chunk.fromB).number
    const last = state.doc.lineAt(Math.max(chunk.fromB, Math.min(chunk.endB, state.doc.length))).number
    for (let number = first; number <= last; number++) {
      const line = state.doc.line(number)
      ranges.push(marker(kind, changeOwner(chunk, field, line)).range(line.from))
    }
  }
  return RangeSet.of(ranges, true)
}

const togglePeek = StateEffect.define<number | null>()

/** The chunk whose committed lines are shown, by its start in the document. */
const peekField = StateField.define<number | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) if (effect.is(togglePeek)) return effect.value
    return value === null ? null : tr.changes.mapPos(value)
  },
})

function chunkAt(state: EditorState, position: number): Chunk | undefined {
  const line = state.doc.lineAt(position)
  return state.field(changeField).chunks.find(chunk => chunk.fromB <= line.to && Math.max(chunk.toB, chunk.fromB) >= line.from &&
    (chunk.fromB !== chunk.toB || state.doc.lineAt(Math.min(chunk.fromB, state.doc.length)).number === line.number))
}

/** The edit that puts the committed lines back in place of a chunk, in the file's own line breaks. */
export function revertSpec(state: EditorState, chunk: Chunk): TransactionSpec | null {
  const baseline = state.field(changeField).baseline
  if (!baseline) return null
  const insert = baseline.text.sliceString(chunk.fromA, Math.min(chunk.toA, baseline.text.length), state.lineBreak)
  return { changes: { from: chunk.fromB, to: Math.min(chunk.toB, state.doc.length), insert }, effects: togglePeek.of(null), userEvent: 'revert' }
}

function revertChunk(view: EditorView, chunk: Chunk): void {
  const spec = revertSpec(view.state, chunk)
  if (spec) view.dispatch(spec)
}

class PeekWidget extends WidgetType {
  readonly chunk: Chunk
  readonly old: string
  readonly header: string
  constructor(chunk: Chunk, old: string, header: string) {
    super()
    this.chunk = chunk
    this.old = old
    this.header = header
  }
  eq(other: PeekWidget) { return other.old === this.old && other.header === this.header && other.chunk.fromB === this.chunk.fromB }
  toDOM(view: EditorView) {
    const box = document.createElement('div')
    box.className = 'cm-change-peek'
    box.setAttribute('role', 'group')
    box.setAttribute('aria-label', 'Committed lines')
    const head = document.createElement('div')
    head.className = 'cm-change-peek-head'
    const label = document.createElement('span')
    label.textContent = this.header
    const revert = document.createElement('button')
    revert.type = 'button'
    revert.textContent = 'Revert'
    revert.title = 'Put back the committed lines'
    revert.onclick = () => revertChunk(view, this.chunk)
    const close = document.createElement('button')
    close.type = 'button'
    close.textContent = 'Close'
    close.onclick = () => view.dispatch({ effects: togglePeek.of(null) })
    head.append(label, revert, close)
    const code = document.createElement('pre')
    code.className = 'cm-change-peek-old'
    code.textContent = this.old || '(no committed lines here: these lines are new)'
    box.append(head, code)
    return box
  }
  ignoreEvent() { return true }
}

const peekDecorations = EditorView.decorations.compute([peekField, changeField], state => {
  const at = state.field(peekField)
  if (at === null) return Decoration.none
  const field = state.field(changeField)
  const chunk = chunkAt(state, Math.min(at, state.doc.length))
  if (!chunk || !field.baseline) return Decoration.none
  const old = field.baseline.text.sliceString(chunk.fromA, Math.min(chunk.endA, field.baseline.text.length))
  const header = `${KIND_TEXT[changeKind(chunk)]} · ${ownerText(changeOwner(chunk, field), field.baseline.authors)}`
  const below = changeKind(chunk) !== 'deleted'
  const position = below ? state.doc.lineAt(Math.max(chunk.fromB, Math.min(chunk.endB, state.doc.length))).to : state.doc.lineAt(Math.min(chunk.fromB, state.doc.length)).from
  return Decoration.set(Decoration.widget({ widget: new PeekWidget(chunk, old, header), block: true, side: below ? 1 : -1 }).range(position))
})

const changeGutter = gutter({
  class: 'cm-change-gutter',
  markers: view => markers(view.state),
  domEventHandlers: {
    mousedown(view, line) {
      const chunk = chunkAt(view.state, line.from)
      if (!chunk) return false
      const open = view.state.field(peekField)
      view.dispatch({ effects: togglePeek.of(open !== null && chunkAt(view.state, open) === chunk ? null : chunk.fromB) })
      return true
    },
  },
})

/** Move to the next (or previous) change, wrapping, and show it. */
export function goToChange(view: EditorView, direction: 1 | -1): boolean {
  const chunks = view.state.field(changeField).chunks
  if (!chunks.length) return false
  const here = view.state.doc.lineAt(view.state.selection.main.head).from
  const target = direction > 0
    ? chunks.find(chunk => chunk.fromB > here) ?? chunks[0]
    : [...chunks].reverse().find(chunk => chunk.fromB < here) ?? chunks[chunks.length - 1]
  const at = Math.min(target.fromB, view.state.doc.length)
  view.dispatch({ selection: { anchor: at }, effects: EditorView.scrollIntoView(at, { y: 'center' }) })
  return true
}

/**
 * Marks over the scrollbar: changes, the lines someone pointed at, and search
 * matches, each where it falls in the whole file.
 */
const overviewRuler = ViewPlugin.fromClass(class {
  view: EditorView
  dom: HTMLDivElement
  frame = 0
  constructor(view: EditorView) {
    this.view = view
    this.dom = document.createElement('div')
    this.dom.className = 'cm-overview-ruler'
    this.dom.setAttribute('aria-hidden', 'true')
    view.dom.appendChild(this.dom)
    this.schedule()
  }
  update(update: ViewUpdate) {
    if (update.docChanged || update.geometryChanged || update.transactions.some(tr => tr.effects.length) ||
      update.startState.field(changeField) !== update.state.field(changeField)) this.schedule()
  }
  schedule() {
    cancelAnimationFrame(this.frame)
    this.frame = requestAnimationFrame(() => this.draw())
  }
  draw() {
    const { state } = this.view
    const lines = Math.max(1, state.doc.lines)
    const marks: string[] = []
    // Where each line is in the whole scrollable height, scaled to the ruler: a
    // short file's marks sit beside their lines, a long file's spread out.
    const ruler = this.view.scrollDOM.clientHeight
    const scale = ruler / Math.max(this.view.contentHeight, ruler)
    const padding = this.view.documentPadding.top
    const mark = (kind: string, fromLine: number, toLine: number) => {
      const top = padding + this.view.lineBlockAt(state.doc.line(Math.min(fromLine, lines)).from).top
      const bottom = padding + this.view.lineBlockAt(state.doc.line(Math.min(toLine, lines)).from).bottom
      marks.push(`<div class="cm-overview-mark cm-overview-${kind}" style="top:${(top * scale).toFixed(1)}px;height:${Math.max(3, (bottom - top) * scale).toFixed(1)}px"></div>`)
    }
    const field = state.field(changeField)
    for (const chunk of field.chunks) {
      const kind = changeKind(chunk)
      const first = state.doc.lineAt(Math.min(chunk.fromB, state.doc.length)).number
      if (kind === 'deleted') { mark(`${kind} cm-overview-by-${changeOwner(chunk, field)}`, first, first); continue }
      const last = state.doc.lineAt(Math.max(chunk.fromB, Math.min(chunk.endB, state.doc.length))).number
      // One mark per run of lines with the same owner, as the margin shows them.
      let runStart = first
      let runOwner = changeOwner(chunk, field, state.doc.line(first))
      for (let number = first + 1; number <= last + 1; number++) {
        const owner = number <= last ? changeOwner(chunk, field, state.doc.line(number)) : null
        if (owner === runOwner) continue
        mark(`${kind} cm-overview-by-${runOwner}`, runStart, number - 1)
        runStart = number
        runOwner = owner!
      }
    }
    for (const target of state.facet(targetLinesFacet)) mark('target', target.start, Math.min(target.end, lines))
    const query = getSearchQuery(state)
    if (query.valid && query.search) {
      const cursor = query.getCursor(state)
      for (let count = 0, next = cursor.next(); !next.done && count < 1000; next = cursor.next(), count++) {
        const line = state.doc.lineAt(next.value.from).number
        mark('search', line, line)
      }
    }
    this.dom.innerHTML = marks.join('')
  }
  destroy() {
    cancelAnimationFrame(this.frame)
    this.dom.remove()
  }
})

/** The pointed-at line range, for the overview ruler. */
export const targetLinesFacet = Facet.define<{ start: number; end: number }>()

export function sourceChanges(): Extension {
  return [
    changeField,
    peekField,
    changeGutter,
    peekDecorations,
    overviewRuler,
    keymap.of([
      { key: 'Alt-F5', run: view => goToChange(view, 1) },
      { key: 'Shift-Alt-F5', run: view => goToChange(view, -1) },
    ]),
  ]
}
