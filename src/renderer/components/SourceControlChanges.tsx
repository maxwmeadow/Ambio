import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiCommit, apiDiscardChanges, apiListChanges, apiStageChanges, type CheckoutChange } from '../canvas/arcdApi'
import { useCheckoutStore } from '../store/checkoutStore'
import { useGraphStore } from '../store/graphStore'
import { useSourcePreviewStore } from '../store/sourcePreviewStore'
import { GitIcon } from './GitIcon'
import { SectionLabel, ToolButton } from './SourceControlParts'

/** What each of Git's letters says, for the row's title and screen readers. */
const STATE_NAMES: Record<string, string> = {
  M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked',
}

/** Messages being written survive closing the menu, per project. */
const drafts = new Map<string, string>()

/**
 * The Floor's checkout as an editor's source control shows it
 * (docs/GIT_WORKFLOW.md stage 2): a message box and Commit, then Staged
 * Changes and Changes, each file with its state, its system on the map, and
 * stage, unstage and discard. Opening a file shows it in Ambio's editor.
 * `between` sits under the Commit button: the branch's sync action.
 */
export function SourceControlChanges({ workspaceId, branch, uncommitted, between, onNotice }: {
  workspaceId: string
  branch: string
  /** The snapshot's count; when it changes the list is read again. */
  uncommitted: number
  between?: React.ReactNode
  onNotice: (text: string | null, done: boolean) => void
}) {
  const [changes, setChanges] = useState<CheckoutChange[] | null>(null)
  const [message, setMessageState] = useState(() => drafts.get(workspaceId) ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState<string | null>(null)
  const files = useGraphStore(state => state.files)
  const systems = useGraphStore(state => state.systems)
  const messageRef = useRef<HTMLTextAreaElement>(null)

  const setMessage = (value: string) => {
    setMessageState(value)
    if (value) drafts.set(workspaceId, value)
    else drafts.delete(workspaceId)
  }

  const load = useCallback((signal?: AbortSignal) => apiListChanges(workspaceId, signal)
    .then(result => setChanges(result.files))
    .catch((error: unknown) => {
      if (!(error instanceof Error && error.name === 'AbortError')) setChanges([])
    }), [workspaceId])

  useEffect(() => {
    const request = new AbortController()
    void load(request.signal)
    return () => request.abort()
  }, [load, uncommitted])

  const fileByPath = useMemo(() => new Map(files.map(file => [file.relPath, file])), [files])
  const systemName = useMemo(() => new Map(systems.map(system => [system.id, system.name])), [systems])

  const staged = (changes ?? []).filter(change => change.staged)
  const unstaged = (changes ?? []).filter(change => change.unstaged)
  const total = changes?.length ?? uncommitted
  const commitAll = staged.length === 0
  const canCommit = !!message.trim() && total > 0 && busy === null

  const act = async (key: string, work: () => Promise<string | null>) => {
    setBusy(key)
    onNotice(null, false)
    try {
      const done = await work()
      if (done) onNotice(done, true)
    } catch (error) {
      onNotice(error instanceof Error ? error.message : 'Git refused without saying why.', false)
    } finally {
      setBusy(null)
      await load()
      await useCheckoutStore.getState().refresh(workspaceId)
    }
  }

  const stage = (paths: string[], to: boolean) => act(`${to ? 'stage' : 'unstage'}:${paths.join('\n')}`, async () => {
    await apiStageChanges(workspaceId, paths, to)
    return null
  })

  const discard = (change: CheckoutChange) => act(`discard:${change.path}`, async () => {
    setConfirmDiscard(null)
    await apiDiscardChanges(workspaceId, [change.path])
    return change.untracked ? `Deleted ${change.path}.` : `Discarded the changes to ${change.path}.`
  })

  const commit = () => {
    if (!canCommit) return
    void act('commit', async () => {
      const result = await apiCommit(workspaceId, message.trim(), commitAll)
      setMessage('')
      return `Committed ${result.files} file${result.files === 1 ? '' : 's'} to ${result.branch} as ${result.commit}.`
    })
  }

  const open = (change: CheckoutChange) => {
    const file = fileByPath.get(change.path)
    if (!file) return
    useSourcePreviewStore.getState().open({ fileId: file.id, workspaceId, name: change.path.split('/').pop() ?? change.path, lineStart: 1, wholeFile: true })
  }

  const row = (change: CheckoutChange, inIndex: boolean) => {
    const letter = change.conflicted ? '!' : (inIndex ? change.staged : change.unstaged) ?? ''
    const slash = change.path.lastIndexOf('/')
    const name = change.path.slice(slash + 1)
    const folder = slash > 0 ? change.path.slice(0, slash) : ''
    const file = fileByPath.get(change.path)
    const system = file?.systemId ? systemName.get(file.systemId) : undefined
    const state = change.conflicted ? 'Conflicted' : STATE_NAMES[letter] ?? letter
    const key = `${inIndex ? 'staged' : 'changes'}:${change.path}`
    return (
      <li key={key} className="ambio-scm-file" data-state={change.conflicted ? 'conflict' : letter}>
        <button type="button" className="ambio-scm-file__open" disabled={!file}
          title={file ? `Open ${change.path}` : `${change.path} is not on the map`}
          aria-label={`${change.path}, ${state}${inIndex ? ', staged' : ''}`} onClick={() => open(change)}>
          <GitIcon name="file" size={13} />
          <span className="ambio-scm-file__name">{name}</span>
          {folder && <span className="ambio-scm-file__folder">{folder}</span>}
          {system && <span className="ambio-scm-file__system">{system}</span>}
        </button>
        <span className="ambio-scm-file__tools" role="toolbar" aria-label={`${change.path} actions`}>
          {!inIndex && <ToolButton icon="discard" label={change.untracked ? 'Delete file…' : 'Discard changes…'} danger
            hint="asks first" disabled={busy !== null} onClick={() => setConfirmDiscard(confirmDiscard === key ? null : key)} />}
          {inIndex
            ? <ToolButton icon="minus" label="Unstage" disabled={busy !== null} onClick={() => void stage([change.path], false)} />
            : <ToolButton icon="plus" label="Stage" disabled={busy !== null || change.conflicted} onClick={() => void stage([change.path], true)} />}
        </span>
        <span className="ambio-scm-file__state" title={state} aria-hidden="true">{letter}</span>
        {confirmDiscard === key && (
          <div className="ambio-worktree__confirm ambio-scm-file__confirm" role="group" aria-label="Confirm discard">
            <span>{change.untracked
              ? `Delete ${name}? It was never committed, so it cannot be brought back.`
              : `Discard your changes to ${name}? They cannot be brought back.`}</span>
            <button type="button" data-danger disabled={busy !== null} onClick={() => void discard(change)}>{change.untracked ? 'Delete file' : 'Discard changes'}</button>
            <button type="button" onClick={() => setConfirmDiscard(null)}>Keep them</button>
          </div>
        )}
      </li>
    )
  }

  return <>
    {total > 0 && (
      <div className="ambio-scm-commit">
        <textarea
          ref={messageRef}
          className="ambio-scm-commit__message"
          aria-label="Commit message"
          placeholder={`Message (Ctrl+Enter to commit on ${branch})`}
          value={message}
          rows={Math.min(6, Math.max(2, message.split('\n').length))}
          spellCheck
          onChange={event => setMessage(event.target.value)}
          onKeyDown={event => {
            event.stopPropagation()
            if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit() }
          }}
        />
        <button type="button" className="ambio-sync__action ambio-scm-commit__button" disabled={!canCommit}
          title={!message.trim() ? 'Write a message first' : commitAll ? 'Nothing is staged: stage and commit every change' : `Commit the ${staged.length} staged file${staged.length === 1 ? '' : 's'}`}
          onClick={commit}>
          <GitIcon name="clean" size={14} className={busy === 'commit' ? 'ambio-tool__pulse' : undefined} />
          <span>{busy === 'commit' ? 'Committing…' : commitAll ? `Commit all ${total}` : `Commit ${staged.length}`}</span>
        </button>
      </div>
    )}
    {between}
    {staged.length > 0 && <>
      <SectionLabel count={staged.length} tools={
        <ToolButton icon="minus" label="Unstage all" disabled={busy !== null} onClick={() => void stage(staged.map(change => change.path), false)} />
      }>Staged changes</SectionLabel>
      <ul className="ambio-scm-files" aria-label="Staged changes">{staged.map(change => row(change, true))}</ul>
    </>}
    <SectionLabel count={unstaged.length || undefined} tools={unstaged.length > 0 ? (
      <ToolButton icon="plus" label="Stage all" disabled={busy !== null}
        onClick={() => void stage(unstaged.filter(change => !change.conflicted).map(change => change.path), true)} />
    ) : undefined}>Changes</SectionLabel>
    {unstaged.length > 0
      ? <ul className="ambio-scm-files" aria-label="Changes">{unstaged.map(change => row(change, false))}</ul>
      : (
        <div className="ambio-scm__row ambio-sync__tree">
          <GitIcon name="clean" size={14} />
          <span>{changes === null && uncommitted > 0 ? 'Reading changes…' : staged.length > 0 ? 'Everything else is committed' : 'No uncommitted changes'}</span>
        </div>
      )}
  </>
}
