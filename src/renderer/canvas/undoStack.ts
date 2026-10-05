/**
 * Canvas undo and redo (Edit → Undo, ⌘Z / Ctrl+Z outside a text field).
 *
 * Each entry knows how to reverse and replay itself, so the stack does not
 * care what it holds: today the meaning edits made on the Floor, which undo
 * through the journal like Review Changes does. Sheet removals are not on it;
 * they stay recoverable from the sheet itself (canvas contract).
 */
export interface UndoEntry {
  /** What the change was, for "Undid …" / "Redid …". */
  label: string
  undo: () => Promise<void>
  redo: () => Promise<void>
}

const LIMIT = 50
let past: UndoEntry[] = []
let future: UndoEntry[] = []

/** A new change: it can be undone, and nothing undone before it can be redone. */
export function pushUndo(entry: UndoEntry): void {
  past = [...past, entry].slice(-LIMIT)
  future = []
}

/** An entry undone some other way (its notice, Review Changes) leaves the stack. */
export function forgetUndo(entry: UndoEntry): void {
  past = past.filter(item => item !== entry)
  future = future.filter(item => item !== entry)
}

export function clearUndo(): void {
  past = []
  future = []
}

export function canUndo(): boolean { return past.length > 0 }
export function canRedo(): boolean { return future.length > 0 }

/**
 * Undo the latest change. Resolves to its label, or null when there is
 * nothing to undo. A refused undo stays on the stack and rethrows.
 */
export async function undoLast(): Promise<string | null> {
  const entry = past.at(-1)
  if (!entry) return null
  await entry.undo()
  past = past.slice(0, -1)
  future = [...future, entry]
  return entry.label
}

/** Redo the latest undone change, or resolve null when there is none. */
export async function redoNext(): Promise<string | null> {
  const entry = future.at(-1)
  if (!entry) return null
  await entry.redo()
  future = future.slice(0, -1)
  past = [...past, entry].slice(-LIMIT)
  return entry.label
}
