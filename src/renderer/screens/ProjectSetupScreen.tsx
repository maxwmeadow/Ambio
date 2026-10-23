import { useCallback, useEffect, useMemo, useState } from 'react'
import type { MapBackup, ProjectConfig } from '../../shared/types'
import { completeSourceBoundaries } from '../../shared/projectLifecycle'
import { WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'
import type { ScopeEstimate } from '../../../electron/preload'
import {
  type DirEntry,
  type TreeNode,
  foldersFirst,
  makeTreeNode,
  findNode,
  toggleNode,
  setChildren,
  collectExcluded,
  isNeverRead,
  mergeExclusions,
  noiseFolderWarning,
  scopeHeadline,
  splitSetupRows,
  tuckedSummary,
} from './projectSetupModel'

interface ProjectSetupScreenProps {
  baseConfig: ProjectConfig
  /** "setup" is the first run; "edit" is Project Settings for an existing project. */
  mode?: 'setup' | 'edit'
  onConfirm: (config: ProjectConfig) => void
  onCancel: () => void
  backLabel?: string
  /** Edit mode for an open project: re-read every file without changing scope. */
  onReindex?: () => void
  /** Edit mode: a backup of the map was restored. */
  onBackupRestored?: () => void
}

export function ProjectSetupScreen({ baseConfig, mode = 'setup', onConfirm, onCancel, backLabel = 'Projects', onReindex, onBackupRestored }: ProjectSetupScreenProps) {
  const { rootPath, name: projectName } = baseConfig
  const editing = mode === 'edit'
  const [name, setName] = useState(projectName)
  // Editing starts from the project's own choices, not first-run defaults.
  const existing = useMemo(
    () => (editing ? new Set(baseConfig.ignoredPaths) : undefined),
    [editing, baseConfig.ignoredPaths],
  )
  const [tree, setTree] = useState<TreeNode[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setLoadError(null)

    if (!window.ambio) {
      setLoading(false)
      return () => { active = false }
    }

    void window.ambio.listDir(rootPath)
      .then(entries => {
        if (active) setTree(foldersFirst(entries).map(entry => makeTreeNode(entry, existing)))
      })
      .catch(() => {
        if (active) setLoadError('Ambio could not read this project directory.')
      })
      .finally(() => {
        if (active) setLoading(false)
      })

    return () => { active = false }
  }, [rootPath, existing])

  const toggleExclude = useCallback((nodePath: string) => {
    setTree(previous => toggleNode(previous, nodePath, 'excluded'))
  }, [])

  const toggleExpand = useCallback(async (nodePath: string) => {
    const node = findNode(tree, nodePath)
    if (!node?.isDirectory) return

    if (!node.children && window.ambio) {
      try {
        const entries = await window.ambio.listDir(nodePath)
        setTree(previous => setChildren(previous, nodePath, foldersFirst(entries).map(entry => makeTreeNode(entry, existing))))
      } catch {
        setLoadError(`Ambio could not read ${node.name}.`)
        return
      }
    }

    setTree(previous => toggleNode(previous, nodePath, 'expanded'))
  }, [tree, existing])

  const excludedPaths = useMemo(() => collectExcluded(tree), [tree])

  // How big this scope really is, recounted as folders are toggled. Big
  // trees are usually big because of generated or third-party code.
  const effectiveExclusions = useMemo(
    () => (editing ? mergeExclusions(tree, baseConfig.ignoredPaths) : excludedPaths),
    [editing, tree, baseConfig.ignoredPaths, excludedPaths],
  )
  const [estimate, setEstimate] = useState<ScopeEstimate | null>(null)
  // A folder's size is only counted while it is checked; remember it so an
  // unchecked folder still says what it would add.
  const [sizes, setSizes] = useState<Record<string, number>>({})
  const canEstimate = Boolean(window.ambio?.estimateScope)
  useEffect(() => {
    if (!window.ambio?.estimateScope || loading) return
    let active = true
    const timer = setTimeout(() => {
      void window.ambio.estimateScope(rootPath, effectiveExclusions).then(result => {
        if (!active) return
        setEstimate(result)
        if (result) setSizes(previous => ({ ...previous, ...result.folders }))
      })
    }, 400)
    return () => { active = false; clearTimeout(timer) }
  }, [rootPath, effectiveExclusions, loading])
  const largeScope = estimate && (estimate.truncated || estimate.sourceFiles > LARGE_SCOPE_FILES)

  const trimmedName = name.trim()
  const handleConfirm = () => {
    if (!trimmedName) return
    if (editing) {
      onConfirm(completeSourceBoundaries(
        { ...baseConfig, name: trimmedName },
        mergeExclusions(tree, baseConfig.ignoredPaths),
      ))
      return
    }
    onConfirm({
      ...completeSourceBoundaries({ ...baseConfig, name: trimmedName }, excludedPaths),
      openedAt: Date.now(),
    })
  }

  const nameField = (
    <label className="ambio-project-settings__name">
      <span>Project name</span>
      <input
        value={name}
        onChange={event => setName(event.target.value)}
        aria-label="Project name"
        spellCheck={false}
      />
    </label>
  )

  return (
    <main className="ambio-onboarding ambio-project-setup">
      <WorkbenchTitleBar status={editing ? 'SETTINGS' : 'SETUP'} />

      <div className="ambio-source-setup">
        <header className="ambio-source-setup__header">
          <button className="ambio-source-setup__back" onClick={onCancel} aria-label={`Back to ${backLabel.toLowerCase()}`}>
            <span aria-hidden="true">←</span>
            {backLabel}
          </button>
          <div className="ambio-source-setup__intro">
            {editing ? (
              <div>
                <p className="ambio-source-setup__eyebrow">Project settings</p>
                {nameField}
                <p className="ambio-source-setup__description">
                  Choose which folders Ambio reads. Changing them updates the map, and is not reported as a code
                  change in your review of what agents did.
                </p>
                {onReindex && (
                  <p className="ambio-project-settings__reindex">
                    <button type="button" onClick={onReindex}>Re-index project</button>
                    <span>Re-reads every file if the map seems out of date. Systems and layout are kept.</span>
                  </p>
                )}
                <MapBackups projectId={baseConfig.id} onRestored={onBackupRestored} />
              </div>
            ) : (
              <div>
                <h1>Set up your project</h1>
                {nameField}
                <code className="ambio-source-setup__path" title={rootPath}>{rootPath}</code>
                <p className="ambio-source-setup__description">
                  Ambio reads what is checked below and draws it as your map. The defaults suit most projects.
                  Uncheck anything that is not your own code, such as generated files, vendored libraries or fixtures.
                </p>
              </div>
            )}
            {editing && <code className="ambio-source-setup__path" title={rootPath}>{rootPath}</code>}
            <details className="ambio-source-setup__help">
              <summary>What does Ambio read?</summary>
              <ul>
                <li><strong>Source code</strong> (TypeScript, JavaScript, Python, Go, Rust, C#, C and C++, Ruby, Java, Kotlin, Swift, PHP, Scala, Groovy, Lua, Shell/Bash, and Elixir) becomes the map. Stylesheets (CSS, Sass/SCSS, and Less) are included too.</li>
                <li><strong>Documents</strong> (Markdown and text files) are kept searchable in Documents and are not drawn on the map.</li>
                <li><strong>Everything else</strong> (images, data, JSON and other configuration) is not read.</li>
                <li><strong>Dependency and build folders</strong> such as node_modules and dist, and folders whose name starts with a dot, are never read.</li>
              </ul>
            </details>
          </div>
        </header>

        <section className="ambio-source-browser" aria-labelledby="source-browser-title">
          <header className="ambio-source-browser__header">
            <h2 id="source-browser-title">Checked folders and files are read</h2>
          </header>

          {loadError && <div className="ambio-source-setup__notice" role="alert">{loadError}</div>}
          {largeScope && estimate && (
            <div className="ambio-source-setup__notice ambio-source-setup__notice--large" role="status">
              <strong>
                This will index {estimate.truncated ? 'more than ' : 'about '}
                {estimate.sourceFiles.toLocaleString()} source files.
              </strong>{' '}
              Large projects map best when generated, vendored and third-party code is excluded; indexing is faster
              and the systems describe your code rather than your dependencies.
              {estimate.largest.length > 0 && (
                <> Largest folders: {estimate.largest.map(folder => `${folder.name} (${folder.sourceFiles.toLocaleString()})`).join(', ')}.</>
              )}
            </div>
          )}

          <div className="ambio-setup-tree ambio-source-browser__tree" role="tree" aria-label="Project files and folders">
            {loading ? (
              <div className="ambio-setup-tree__state" role="status">
                <span className="ambio-setup-tree__busy" aria-hidden="true" />
                Reading project contents…
              </div>
            ) : tree.length === 0 ? (
              <div className="ambio-setup-tree__state">This project is empty.</div>
            ) : (
              <TreeLevel nodes={tree} depth={0} sizes={sizes} onToggleExclude={toggleExclude} onToggleExpand={toggleExpand} />
            )}
          </div>

          <footer className="ambio-source-browser__footer">
            <div className="ambio-source-browser__summary" aria-live="polite">
              <strong>{canEstimate ? scopeHeadline(estimate) : 'Everything checked will be read'}</strong>
              {estimate && estimate.documents > 0 && (
                <span>
                  {estimate.documents.toLocaleString()} {estimate.documents === 1 ? 'document' : 'documents'} kept searchable, not drawn on the map
                </span>
              )}
            </div>
            <button
              className="ambio-source-setup__submit"
              onClick={handleConfirm}
              disabled={loading || Boolean(loadError && tree.length === 0) || !trimmedName}
            >
              <span>
                <strong>{editing ? 'Save changes' : 'Index this project'}</strong>
                <small>{editing ? 'Updates the map in place' : 'You can change this later in Project Settings'}</small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          </footer>
        </section>
      </div>
    </main>
  )
}

/** Above this many source files the setup screen suggests trimming the scope. */
const LARGE_SCOPE_FILES = 15_000

interface TreeLevelProps {
  depth: number
  /** Source files under each folder, by path, where known. */
  sizes: Record<string, number>
  onToggleExclude: (path: string) => void
  onToggleExpand: (path: string) => void | Promise<void>
}

/**
 * One folder's contents: the rows worth a decision, then one line standing
 * for everything skipped automatically, which opens to show what that is.
 */
function TreeLevel({ nodes, ...rest }: TreeLevelProps & { nodes: TreeNode[] }) {
  const [open, setOpen] = useState(false)
  const { shown, tucked } = useMemo(() => splitSetupRows(nodes), [nodes])
  const depthClass = `ambio-setup-tree__row--depth-${Math.min(rest.depth, 8)}`
  return (
    <>
      {shown.map(node => <TreeRow key={node.path} node={node} {...rest} />)}
      {tucked.length > 0 && (
        <div className="ambio-setup-tree__skipped" role="none">
          <button
            type="button"
            className={`ambio-setup-tree__row ambio-setup-tree__skipped-toggle ${depthClass}`}
            aria-expanded={open}
            onClick={() => setOpen(value => !value)}
          >
            <span className="ambio-setup-tree__expand" aria-hidden="true"><span>›</span></span>
            <span className="ambio-setup-tree__skipped-summary">{tuckedSummary(tucked)}</span>
            <span className="ambio-setup-tree__skipped-action">{open ? 'Hide' : 'Show'}</span>
          </button>
          {open && tucked.map(node => <TreeRow key={node.path} node={node} {...rest} />)}
        </div>
      )}
    </>
  )
}

function TreeRow({ node, depth, sizes, onToggleExclude, onToggleExpand }: TreeLevelProps & { node: TreeNode }) {
  const depthClass = `ambio-setup-tree__row--depth-${Math.min(depth, 8)}`
  const neverRead = isNeverRead(node)
  const size = sizes[node.path]
  const warning = noiseFolderWarning(node, size)
  // What the row adds to the map, or why it adds nothing.
  const detail = neverRead
    ? 'Never read'
    : node.isDirectory
      ? size !== undefined
        ? `${size.toLocaleString()} source ${size === 1 ? 'file' : 'files'}${node.excluded ? ' · not read' : ''}`
        : node.excluded ? 'Not read' : ''
      : node.excluded
        ? 'Not read'
        : node.kind === 'document' ? 'Document' : ''

  return (
    <div
      className="ambio-setup-tree__branch"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={node.isDirectory && !neverRead ? node.expanded : undefined}
      data-kind={node.kind}
      data-never-read={neverRead || undefined}
    >
      <div className={`ambio-setup-tree__row ${depthClass}${node.excluded ? ' ambio-setup-tree__row--excluded' : ''}`}>
        {node.isDirectory && !neverRead ? (
          <button
            className="ambio-setup-tree__expand"
            onClick={() => void onToggleExpand(node.path)}
            aria-label={`${node.expanded ? 'Collapse' : 'Expand'} ${node.name}`}
          >
            <span aria-hidden="true">›</span>
          </button>
        ) : (
          <span className="ambio-setup-tree__expand-spacer" aria-hidden="true" />
        )}

        {neverRead ? (
          <span className="ambio-setup-tree__check-spacer" aria-hidden="true" />
        ) : (
          <label className="ambio-setup-tree__check">
            <input
              type="checkbox"
              checked={!node.excluded}
              onChange={() => onToggleExclude(node.path)}
              aria-label={`Include ${node.name}`}
            />
            <span aria-hidden="true" />
          </label>
        )}

        <span
          className={node.isDirectory
            ? `ambio-setup-tree__folder${node.expanded ? ' ambio-setup-tree__folder--open' : ''}`
            : 'ambio-setup-tree__file'}
          aria-hidden="true"
        />
        <span className="ambio-setup-tree__name" title={node.path}>{node.name}</span>
        <span className="ambio-setup-tree__detail">{detail}</span>
      </div>
      {warning && <p className={`ambio-setup-tree__warning ${depthClass}`} role="status">{warning}</p>}

      {node.expanded && node.children && !neverRead && (
        <div role="group">
          <TreeLevel nodes={node.children} depth={depth + 1} sizes={sizes} onToggleExclude={onToggleExclude} onToggleExpand={onToggleExpand} />
        </div>
      )}
    </div>
  )
}



/**
 * Ambio keeps a copy of each project's map once a day, seven deep. Restoring
 * one keeps the current map as a backup first, so it can be undone.
 */
function MapBackups({ projectId, onRestored }: { projectId: string; onRestored?: () => void }) {
  const [backups, setBackups] = useState<MapBackup[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    if (!window.ambio?.listBackups) return
    window.ambio.listBackups(projectId).then(setBackups).catch(() => setBackups([]))
  }, [projectId])
  useEffect(load, [load])
  if (!backups || backups.length === 0) return null

  const restore = async (backup: MapBackup) => {
    setBusy(true)
    setError(null)
    try {
      if (await window.ambio.restoreBackup(projectId, backup.name)) {
        load()
        onRestored?.()
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Ambio could not restore that backup.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="ambio-project-settings__backups">
      <summary>Map backups ({backups.length})</summary>
      <p>A copy of the map is kept once a day for the last seven days. Your code is never part of a backup.</p>
      {error && <p className="ambio-project-settings__backup-error" role="alert">{error}</p>}
      <ul>
        {backups.map(backup => (
          <li key={backup.name}>
            <span>{new Date(backup.createdAt).toLocaleString()}{backup.name.startsWith('before-restore') ? ' · before a restore' : ''}</span>
            <small>{formatBytes(backup.bytes)}</small>
            <button type="button" onClick={() => void restore(backup)} disabled={busy}>Restore</button>
          </li>
        ))}
      </ul>
    </details>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
