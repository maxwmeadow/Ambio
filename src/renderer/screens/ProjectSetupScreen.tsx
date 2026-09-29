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
  countExploredKinds,
  formatExploredScopeSummary,
  mergeExclusions,
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

    if (!window.axiom) {
      setLoading(false)
      return () => { active = false }
    }

    void window.axiom.listDir(rootPath)
      .then(entries => {
        if (active) setTree(foldersFirst(entries).map(entry => makeTreeNode(entry, existing)))
      })
      .catch(() => {
        if (active) setLoadError('Axiom could not read this project directory.')
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

    if (!node.children && window.axiom) {
      try {
        const entries = await window.axiom.listDir(nodePath)
        setTree(previous => setChildren(previous, nodePath, foldersFirst(entries).map(entry => makeTreeNode(entry, existing))))
      } catch {
        setLoadError(`Axiom could not read ${node.name}.`)
        return
      }
    }

    setTree(previous => toggleNode(previous, nodePath, 'expanded'))
  }, [tree, existing])

  const excludedPaths = useMemo(() => collectExcluded(tree), [tree])
  const explored = useMemo(() => countExploredKinds(tree), [tree])
  const scopeSummary = useMemo(() => formatExploredScopeSummary(explored), [explored])

  // How big this scope really is, recounted as folders are toggled. Big
  // trees are usually big because of generated or third-party code.
  const effectiveExclusions = useMemo(
    () => (editing ? mergeExclusions(tree, baseConfig.ignoredPaths) : excludedPaths),
    [editing, tree, baseConfig.ignoredPaths, excludedPaths],
  )
  const [estimate, setEstimate] = useState<ScopeEstimate | null>(null)
  useEffect(() => {
    if (!window.axiom?.estimateScope || loading) return
    let active = true
    const timer = setTimeout(() => {
      void window.axiom.estimateScope(rootPath, effectiveExclusions).then(result => { if (active) setEstimate(result) })
    }, 400)
    return () => { active = false; clearTimeout(timer) }
  }, [rootPath, effectiveExclusions, loading])
  const largeScope = estimate && (estimate.truncated || estimate.sourceFiles > LARGE_SCOPE_FILES)

  const trimmedName = name.trim()
  const handleConfirm = () => {
    if (editing) {
      onConfirm(completeSourceBoundaries(
        { ...baseConfig, name: trimmedName || projectName },
        mergeExclusions(tree, baseConfig.ignoredPaths),
      ))
      return
    }
    onConfirm({
      ...completeSourceBoundaries(baseConfig, excludedPaths),
      openedAt: Date.now(),
    })
  }

  return (
    <main className="axiom-onboarding axiom-project-setup">
      <WorkbenchTitleBar context={editing ? 'Project Settings' : 'Project Setup'} status={editing ? 'SETTINGS' : 'PRE-INDEX'} />

      <div className="axiom-source-setup">
        <header className="axiom-source-setup__header">
          <button className="axiom-source-setup__back" onClick={onCancel} aria-label={`Back to ${backLabel.toLowerCase()}`}>
            <span aria-hidden="true">←</span>
            {backLabel}
          </button>
          <div className="axiom-source-setup__intro">
            {editing ? (
              <div>
                <p className="axiom-source-setup__eyebrow">Project settings</p>
                <label className="axiom-project-settings__name">
                  <span>Name</span>
                  <input
                    value={name}
                    onChange={event => setName(event.target.value)}
                    aria-label="Project name"
                    spellCheck={false}
                  />
                </label>
                <p className="axiom-source-setup__description">
                  Choose which folders Axiom reads. Changing them updates the map, and is not reported as a code
                  change in your review of what agents did.
                </p>
                {onReindex && (
                  <p className="axiom-project-settings__reindex">
                    <button type="button" onClick={onReindex}>Re-index project</button>
                    <span>Re-reads every file if the map seems out of date. Systems and layout are kept.</span>
                  </p>
                )}
                <MapBackups projectId={baseConfig.id} onRestored={onBackupRestored} />
              </div>
            ) : (
              <div>
                <p className="axiom-source-setup__eyebrow">Choose what Axiom reads</p>
                <h1>Set up {projectName}</h1>
                <p className="axiom-source-setup__description">
                  Source files are included by default. Common generated and dependency folders are skipped automatically;
                  documentation stays searchable outside the canvas, and unsupported assets are never indexed.
                </p>
              </div>
            )}
            <code className="axiom-source-setup__path" title={rootPath}>{rootPath}</code>
          </div>
        </header>

        <section className="axiom-source-browser" aria-labelledby="source-browser-title">
          <header className="axiom-source-browser__header">
            <div>
              <p>Project contents</p>
              <h2 id="source-browser-title">Files and folders</h2>
            </div>
            <div className="axiom-source-browser__legend" aria-label="Selection key">
              <span><i className="axiom-source-browser__legend-check" aria-hidden="true" /> Source → canvas</span>
              <span>Documents → library</span>
              <span>Excluded → skipped</span>
              <span>Unsupported → ignored</span>
            </div>
          </header>

          {loadError && <div className="axiom-source-setup__notice" role="alert">{loadError}</div>}
          {largeScope && estimate && (
            <div className="axiom-source-setup__notice axiom-source-setup__notice--large" role="status">
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

          <div className="axiom-setup-tree axiom-source-browser__tree" role="tree" aria-label="Project files and folders">
            {loading ? (
              <div className="axiom-setup-tree__state" role="status">
                <span className="axiom-setup-tree__busy" aria-hidden="true" />
                Reading project contents…
              </div>
            ) : tree.length === 0 ? (
              <div className="axiom-setup-tree__state">This project is empty.</div>
            ) : (
              tree.map(node => (
                <TreeRow
                  key={node.path}
                  node={node}
                  depth={0}
                  onToggleExclude={toggleExclude}
                  onToggleExpand={toggleExpand}
                />
              ))
            )}
          </div>

          <footer className="axiom-source-browser__footer">
            <div className="axiom-source-browser__summary" aria-live="polite">
              <strong>
                {scopeSummary.headline}
              </strong>
              <span>
                {excludedPaths.length === 0 ? 'No items excluded' : `${excludedPaths.length} ${excludedPaths.length === 1 ? 'item' : 'items'} excluded`}
                {explored.unsupported > 0 ? ` · ${explored.unsupported} unsupported skipped` : ''}
              </span>
              <small className="axiom-source-browser__summary-note">
                {scopeSummary.subtext}
              </small>
            </div>
            <button
              className="axiom-source-setup__submit"
              onClick={handleConfirm}
              disabled={loading || Boolean(loadError && tree.length === 0) || (editing && !trimmedName)}
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

interface TreeRowProps {
  node: TreeNode
  depth: number
  onToggleExclude: (path: string) => void
  onToggleExpand: (path: string) => void | Promise<void>
}

function TreeRow({ node, depth, onToggleExclude, onToggleExpand }: TreeRowProps) {
  const depthClass = `axiom-setup-tree__row--depth-${Math.min(depth, 8)}`
  const kindLabel = node.kind === 'source'
    ? 'Source'
    : node.kind === 'document'
      ? 'Document'
      : node.kind === 'unsupported'
        ? 'Unsupported'
        : 'Folder'

  return (
    <div
      className="axiom-setup-tree__branch"
      role="treeitem"
      aria-level={depth + 1}
      aria-expanded={node.isDirectory ? node.expanded : undefined}
      data-kind={node.kind}
    >
      <div className={`axiom-setup-tree__row ${depthClass}${node.excluded ? ' axiom-setup-tree__row--excluded' : ''}`}>
        {node.isDirectory ? (
          <button
            className="axiom-setup-tree__expand"
            onClick={() => void onToggleExpand(node.path)}
            aria-label={`${node.expanded ? 'Collapse' : 'Expand'} ${node.name}`}
          >
            <span aria-hidden="true">›</span>
          </button>
        ) : (
          <span className="axiom-setup-tree__expand-spacer" aria-hidden="true" />
        )}

        <label className="axiom-setup-tree__check">
          <input
            type="checkbox"
            checked={!node.excluded}
            onChange={() => onToggleExclude(node.path)}
            aria-label={`Include ${node.name}`}
            disabled={node.kind === 'unsupported'}
          />
          <span aria-hidden="true" />
        </label>

        <span
          className={node.isDirectory
            ? `axiom-setup-tree__folder${node.expanded ? ' axiom-setup-tree__folder--open' : ''}`
            : 'axiom-setup-tree__file'}
          aria-hidden="true"
        />
        <span className="axiom-setup-tree__name" title={node.path}>{node.name}</span>
        <span className="axiom-setup-tree__kind">{kindLabel}</span>
        <span className="axiom-setup-tree__state-label">
          {node.kind === 'unsupported' ? 'Skipped' : node.kind === 'document' ? 'Documents' : node.excluded ? 'Excluded' : 'Included'}
        </span>
      </div>

      {node.expanded && node.children && (
        <div role="group">
          {node.children.map(child => (
            <TreeRow
              key={child.path}
              node={child}
              depth={depth + 1}
              onToggleExclude={onToggleExclude}
              onToggleExpand={onToggleExpand}
            />
          ))}
        </div>
      )}
    </div>
  )
}



/**
 * Axiom keeps a copy of each project's map once a day, seven deep. Restoring
 * one keeps the current map as a backup first, so it can be undone.
 */
function MapBackups({ projectId, onRestored }: { projectId: string; onRestored?: () => void }) {
  const [backups, setBackups] = useState<MapBackup[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const load = useCallback(() => {
    if (!window.axiom?.listBackups) return
    window.axiom.listBackups(projectId).then(setBackups).catch(() => setBackups([]))
  }, [projectId])
  useEffect(load, [load])
  if (!backups || backups.length === 0) return null

  const restore = async (backup: MapBackup) => {
    setBusy(true)
    setError(null)
    try {
      if (await window.axiom.restoreBackup(projectId, backup.name)) {
        load()
        onRestored?.()
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : 'Axiom could not restore that backup.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <details className="axiom-project-settings__backups">
      <summary>Map backups ({backups.length})</summary>
      <p>A copy of the map is kept once a day for the last seven days. Your code is never part of a backup.</p>
      {error && <p className="axiom-project-settings__backup-error" role="alert">{error}</p>}
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
