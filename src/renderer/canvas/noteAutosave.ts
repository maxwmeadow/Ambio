export interface NoteTextVersion { id: string; body: string; revision: number }
export interface NoteTextDraft { body: string; revision: number }
interface Callbacks {
  save: (body: string, revision: number) => Promise<NoteTextVersion>
  remove: (revision: number) => Promise<void>
  draft: (value: NoteTextDraft | null) => void
}

/** One serialized text session per note, retained across sheet navigation. */
export function createNoteAutosave(note: NoteTextVersion, callbacks: Callbacks, draft?: NoteTextDraft, delay = 150) {
  let latest = note, savedBody = note.body, editable = true, removing = false
  let state = { body: draft?.body ?? note.body, revision: draft?.revision ?? note.revision,
    editing: !!draft, dirty: !!draft && draft.body !== note.body, saving: false,
    error: '', conflict: false, deleted: false }
  let failedOperation: 'save' | 'remove' = 'save'
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | undefined
  const listeners = new Set<() => void>()
  const cancelTimer = () => { clearTimeout(timer); timer = undefined }
  const publish = () => {
    state = { ...state }
    callbacks.draft(state.editing || state.dirty ? { body: state.body, revision: state.revision } : null)
    for (const listener of listeners) listener()
  }
  const observe = () => {
    if (pending || latest.revision <= state.revision) return
    if (state.dirty) { state.conflict = true; cancelTimer() }
    else { state.body = savedBody = latest.body; state.revision = latest.revision; state.conflict = false }
  }
  const schedule = () => {
    cancelTimer()
    if (state.dirty && !state.error && !state.conflict && !state.deleted && !removing) timer = setTimeout(() => { void flush() }, delay)
  }
  const flush = (): Promise<void> => {
    cancelTimer()
    if (pending) return pending
    observe()
    if (!state.dirty || state.conflict || state.deleted || removing) { publish(); return Promise.resolve() }
    const body = state.body, revision = state.revision
    state.saving = true; state.error = ''; publish()
    pending = Promise.resolve().then(() => callbacks.save(body, revision)).then(saved => {
      state.revision = saved.revision; savedBody = body; state.dirty = state.body !== body
      if (saved.id !== note.id) { state.editing = false; state.dirty = false }
    }).catch(reason => { failedOperation = 'save'; state.error = reason instanceof Error ? reason.message : 'Could not update this note.' })
      .finally(() => { pending = undefined; state.saving = false; observe(); publish(); schedule() })
    return pending
  }
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    configure(next: Callbacks) { callbacks = next },
    receive(next: NoteTextVersion, deleted: boolean, canEdit: boolean) {
      latest = next; editable = canEdit
      const before = JSON.stringify(state)
      state.deleted = deleted; observe()
      if (deleted) cancelTimer()
      if (before !== JSON.stringify(state)) publish()
    },
    begin() { if (!editable) return; state.editing = true; observe(); publish() },
    change(body: string) {
      if (!editable) return
      state.body = body; state.dirty = body !== savedBody; publish(); schedule()
    },
    end() { state.editing = false; publish(); void flush() },
    flush,
    useLatest() {
      cancelTimer(); state.body = savedBody = latest.body; state.revision = latest.revision
      state.dirty = false; state.conflict = false; state.error = ''; publish()
    },
    keepMine() {
      if (!editable) return Promise.resolve()
      state.revision = latest.revision; state.conflict = false; state.deleted = false
      state.error = ''; state.dirty = true; publish(); return flush()
    },
    retry(): Promise<void> { if (!editable) return Promise.resolve(); state.error = ''; publish(); return failedOperation === 'remove' ? this.remove() : flush() },
    async remove() {
      if (!editable || removing) return
      cancelTimer()
      if (state.deleted) { state.editing = false; state.dirty = false; state.error = ''; publish(); return }
      removing = true
      if (pending) await pending
      state.saving = true; publish()
      try { await callbacks.remove(state.revision); state.dirty = false; state.editing = false; callbacks.draft(null) }
      catch (reason) { failedOperation = 'remove'; state.error = reason instanceof Error ? reason.message : 'Could not delete this note.' }
      finally { removing = false; state.saving = false; publish() }
    },
  }
}
export type NoteAutosave = ReturnType<typeof createNoteAutosave>
