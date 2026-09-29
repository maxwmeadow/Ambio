import React from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { DbDependency, DbFile, DbInfraNode, DbSystem } from '../../shared/types'
import { IMPLEMENTATION_LABEL, ITEM_ROLE, RELATIONSHIP_LABEL, RELATIONSHIP_ORDER, ROLE_LABEL, readDetectedBy } from '../canvas/infraRoles'
import { apiUpdateSystem } from '../canvas/arcdApi'
import { filenameForLanguage, LanguagePicker } from '../canvas/languages'
import { UmlMetadataPanel } from '../canvas/nodes/UmlMetadataPanel'
import { useGraphStore } from '../store/graphStore'
import { useRegistryStore } from '../store/registryStore'
import {
  plannedMetadata,
  useSheetStore,
  type PlannedNode,
  type PlannedNodeMetadata,
} from '../store/sheetStore'

const CONTENT_TITLE: Record<string, string> = {
  hosts: 'Folders it runs',
  schedule: 'Schedules',
  key_pattern: 'Cache keys',
  topic: 'Topics',
  table: 'Tables',
  collection: 'Collections',
  flag: 'Flag keys',
  model: 'Models',
}

export function DetailPanel() {
  const { inspectedNodeId, files, systems, infraNodes, dependencies, setSelectedNode, setInspectedNode } = useGraphStore(
    useShallow(s => ({
      inspectedNodeId: s.inspectedNodeId,
      files: s.files,
      systems: s.systems,
      infraNodes: s.infraNodes,
      dependencies: s.dependencies,
      setSelectedNode: s.setSelectedNode,
      setInspectedNode: s.setInspectedNode,
    }))
  )
  const plannedNodes = useSheetStore(s => s.planned)

  if (!inspectedNodeId) return null

  const file = files.find(candidate => candidate.id === inspectedNodeId)
  const system = !file ? systems.find(candidate => candidate.id === inspectedNodeId) : undefined
  const infra = !file && !system ? infraNodes.find(candidate => candidate.id === inspectedNodeId) : undefined
  const planned = inspectedNodeId.startsWith('planned:')
    ? plannedNodes.find(node => node.id === inspectedNodeId.slice('planned:'.length))
    : undefined

  if (!file && !system && !infra && !planned) return null

  const typeLabel = planned
    ? `Planned ${planned.kind.replace('_', ' ')}`
    : file
      ? 'File'
      : system
        ? 'System'
        : 'Infrastructure'

  return (
    <aside
      className="axiom-detail-panel"
      aria-label={`${typeLabel} properties`}
      data-inspected-node-id={inspectedNodeId}
    >
      <header className="axiom-detail-panel__titlebar">
        <span>Properties</span>
        <span className="axiom-detail-panel__type">{typeLabel}</span>
        <button
          type="button"
          className="axiom-detail-panel__close"
          aria-label="Close properties"
          onClick={() => setInspectedNode(null)}
        >
          ×
        </button>
      </header>

      <div className="axiom-detail-panel__body">
        {planned && <PlannedDetail node={planned} />}
        {file && !planned && (
          <FileDetail
            file={file}
            systems={systems}
            dependencies={dependencies}
            setSelectedNode={id => {
              setSelectedNode(id)
              setInspectedNode(id)
            }}
          />
        )}
        {system && <SystemDetail system={system} files={files} systems={systems} />}
        {infra && (
          <InfraDetail
            infra={infra}
            dependencies={dependencies}
            onOpen={id => {
              setSelectedNode(id)
              setInspectedNode(id)
            }}
          />
        )}
      </div>
    </aside>
  )
}

function InspectorIdentity({
  kicker,
  name,
  detail,
}: {
  kicker: string
  name: string
  detail?: React.ReactNode
}) {
  return (
    <div className="axiom-detail-panel__identity">
      <div className="axiom-detail-panel__kicker">{kicker}</div>
      <h2>{name}</h2>
      {detail && <div className="axiom-detail-panel__identity-detail">{detail}</div>}
    </div>
  )
}

function InspectorText({
  label,
  value,
  multiline,
  onCommit,
}: {
  label: string
  value: string
  multiline?: boolean
  onCommit: (value: string) => void
}) {
  const [draft, setDraft] = React.useState(value)
  React.useEffect(() => setDraft(value), [value])
  const common = {
    value: draft,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft(event.target.value),
    onBlur: () => {
      if (draft !== value) onCommit(draft)
    },
    className: 'axiom-inspector-input',
  }

  return (
    <label className="axiom-inspector-field">
      <span className="axiom-inspector-field__label">{label}</span>
      {multiline ? <textarea {...common} rows={3} /> : <input {...common} />}
    </label>
  )
}

interface KeyValueRow {
  id: number
  key: string
  value: string
}

function KeyValueEditor({
  label,
  value,
  onChange,
}: {
  label: string
  value: Record<string, string>
  onChange: (value: Record<string, string>) => void
}) {
  const nextId = React.useRef(0)
  const toRows = React.useCallback((record: Record<string, string>): KeyValueRow[] =>
    Object.entries(record).map(([key, entryValue]) => ({
      id: nextId.current++,
      key,
      value: entryValue,
    })), [])
  const serialized = JSON.stringify(value)
  const lastCommitted = React.useRef(serialized)
  const [rows, setRows] = React.useState<KeyValueRow[]>(() => toRows(value))

  React.useEffect(() => {
    if (serialized === lastCommitted.current) return
    lastCommitted.current = serialized
    setRows(toRows(value))
  }, [serialized, toRows, value])

  const commit = (nextRows: KeyValueRow[]) => {
    const next: Record<string, string> = {}
    for (const row of nextRows) {
      const key = row.key.trim()
      if (key) next[key] = row.value
    }
    const nextSerialized = JSON.stringify(next)
    if (nextSerialized === serialized) return
    lastCommitted.current = nextSerialized
    onChange(next)
  }

  const updateRow = (id: number, field: 'key' | 'value', entryValue: string) => {
    setRows(current => current.map(row => row.id === id ? { ...row, [field]: entryValue } : row))
  }
  const removeRow = (id: number) => {
    const next = rows.filter(row => row.id !== id)
    setRows(next)
    commit(next)
  }
  const addRow = () => {
    setRows(current => [...current, { id: nextId.current++, key: '', value: '' }])
  }

  return (
    <div className="axiom-inspector-field">
      <div className="axiom-inspector-field__label">{label}</div>
      {rows.length > 0 && (
        <div className="axiom-inspector-key-values">
          <span>Key</span>
          <span>Value</span>
          <span />
          {rows.map((row, index) => (
            <React.Fragment key={row.id}>
              <input
                autoFocus={index === rows.length - 1 && !row.key}
                className="axiom-inspector-input axiom-inspector-input--mono"
                value={row.key}
                placeholder="VARIABLE_NAME"
                onChange={event => updateRow(row.id, 'key', event.target.value)}
                onBlur={() => commit(rows)}
              />
              <input
                className="axiom-inspector-input axiom-inspector-input--mono"
                value={row.value}
                placeholder="value"
                onChange={event => updateRow(row.id, 'value', event.target.value)}
                onBlur={() => commit(rows)}
              />
              <button
                type="button"
                className="axiom-inspector-icon-button"
                aria-label={`Remove ${row.key || 'environment variable'}`}
                onClick={() => removeRow(row.id)}
              >
                ×
              </button>
            </React.Fragment>
          ))}
        </div>
      )}
      <button
        type="button"
        className="axiom-inspector-add-button"
        onClick={addRow}
        title="Add environment variable"
      >
        <span aria-hidden="true">+</span> Add variable
      </button>
    </div>
  )
}

function PlannedDetail({ node }: { node: PlannedNode }) {
  const metadata = plannedMetadata(node)
  const updatePlanned = useSheetStore(s => s.updatePlanned)
  const { services, loaded, fetchRegistry } = useRegistryStore()
  const setInfraPickerNode = useGraphStore(s => s.setInfraPickerNode)
  const hasContainedNodes = useSheetStore(s => [
    ...s.planned.map(child => child.parentSystemId),
    ...s.elements.map(child => child.parentSystemId),
  ].includes(`planned:${node.id}`))

  React.useEffect(() => {
    if (!loaded) void fetchRegistry()
  }, [loaded, fetchRegistry])

  const update = (patch: Partial<PlannedNode>, metadataPatch?: Partial<PlannedNodeMetadata>) => {
    void updatePlanned(node.workspaceId, {
      ...node,
      ...patch,
      metadata: metadataPatch ? { ...metadata, ...metadataPatch, version: 1 } : node.metadata,
    })
  }
  const service = metadata.service ? services.find(item => item.id === metadata.service) : undefined
  const config = metadata.config ?? {}

  return (
    <>
      <InspectorIdentity
        kicker={`Planned ${node.kind.replace('_', ' ')}`}
        name={node.name}
        detail="Overlay-authored architecture element"
      />
      <div className="axiom-inspector-form">
        <InspectorText label="NAME" value={node.name} onCommit={name => update({ name })} />

        {(node.kind === 'class' || node.kind === 'file') && (
          <div className="axiom-inspector-field">
            <div className="axiom-inspector-field__label">LANGUAGE</div>
            <div className="axiom-inspector-language">
              <LanguagePicker
                value={metadata.language ?? ''}
                onChange={language => {
                  const name = node.kind === 'file' ? filenameForLanguage(node.name, language) : node.name
                  update({ name, declaredPath: node.kind === 'file' ? name : '' }, { language })
                }}
              />
              <span>{metadata.language || 'Choose language'}</span>
            </div>
          </div>
        )}

        {node.kind === 'class' && (
          <>
            <label className="axiom-inspector-field">
              <span className="axiom-inspector-field__label">CLASS KIND</span>
              <select
                className="axiom-inspector-input"
                value={metadata.classKind ?? 'class'}
                onChange={event => update({}, { classKind: event.target.value as PlannedNodeMetadata['classKind'] })}
              >
                <option value="class">Class</option>
                <option value="interface">Interface</option>
                <option value="abstract">Abstract class</option>
              </select>
            </label>
            <InspectorText label="ROLE (OPTIONAL)" value={metadata.role ?? ''} onCommit={role => update({}, { role })} />
          </>
        )}

        <InspectorText
          label="DESCRIPTION (OPTIONAL)"
          value={metadata.description ?? ''}
          multiline
          onCommit={description => update({}, { description })}
        />

        {(node.kind === 'class' || node.kind === 'service') && (
          <Section title="Detailed structure">
            <div className="axiom-inspector-uml-frame">
              <UmlMetadataPanel
                kind={node.kind}
                metadata={metadata}
                editable
                onChange={next => update({}, next)}
              />
            </div>
          </Section>
        )}

        {node.kind === 'infra' && (
          <>
            <div className="axiom-inspector-field">
              <div className="axiom-inspector-field__label">INFRASTRUCTURE</div>
              <div className="axiom-inspector-service">
                <strong>{service?.name ?? 'Not assigned'}</strong>
                {service && (
                  <span>
                    {service.provider} · {service.category}{service.subtype ? ` / ${service.subtype}` : ''}
                  </span>
                )}
              </div>
              <button
                type="button"
                className="axiom-inspector-command"
                onClick={() => setInfraPickerNode(node.id)}
              >
                {service ? 'Change infrastructure…' : 'Choose infrastructure…'}
              </button>
              {hasContainedNodes && (
                <span className="axiom-inspector-help">
                  This node contains hosted elements, so it can only be reassigned to other container-capable infrastructure.
                </span>
              )}
            </div>

            {service?.configFields?.map(field => (
              <InspectorText
                key={field}
                label={field.toUpperCase()}
                value={config[field] ?? ''}
                onCommit={value => update({}, { config: { ...config, [field]: value } })}
              />
            ))}

            {(metadata.capabilities?.includes('environment') || metadata.category === 'platform') && (
              <KeyValueEditor
                label="ENVIRONMENT VARIABLES"
                value={metadata.environmentVariables ?? {}}
                onChange={environmentVariables => update({}, { environmentVariables })}
              />
            )}

            {(metadata.capabilities?.includes('schema') || metadata.category === 'database') && (
              <InspectorText
                label="TABLES / COLLECTIONS (ONE PER LINE)"
                value={(metadata.tables ?? []).map(table =>
                  table.schema ? `${table.name}: ${table.schema}` : table.name
                ).join('\n')}
                multiline
                onCommit={value => update({}, {
                  tables: value.split('\n').map(line => line.trim()).filter(Boolean).map(line => {
                    const [name, ...schema] = line.split(':')
                    return { name: name.trim(), schema: schema.join(':').trim() || undefined }
                  }),
                })}
              />
            )}
          </>
        )}
      </div>
    </>
  )
}

function FileDetail({
  file,
  systems,
  dependencies,
  setSelectedNode,
}: {
  file: DbFile
  systems: DbSystem[]
  dependencies: DbDependency[]
  setSelectedNode: (id: string | null) => void
}) {
  const filename = file.relPath.split('/').pop() ?? file.relPath
  const parentSystem = systems.find(system => system.id === file.systemId)
  const churn = file.churnScore ?? 0
  const outDeps = dependencies.filter(dependency => dependency.src === file.id && dependency.srcType === 'file')
  const inDeps = dependencies.filter(dependency => dependency.dst === file.id && dependency.dstType === 'file')

  const openFile = () => {
    if (window.axiom) window.axiom.showInFolder(file.path)
  }

  return (
    <>
      <InspectorIdentity
        kicker="Selected source file"
        name={filename}
        detail={(
          <button type="button" className="axiom-detail-panel__path" onClick={openFile} title="Show in folder">
            {file.relPath}
          </button>
        )}
      />

      <Section title="General">
        <div className="axiom-inspector-properties">
          <Stat label="Language" value={file.language} />
          {file.lineCount > 0 && <Stat label="Lines" value={String(file.lineCount)} />}
          {churn > 0 && <Stat label="Churn" value={`${Math.round(churn * 100)}%`} warn={churn > 0.7} />}
          {parentSystem && <Stat label="System" value={parentSystem.name} />}
        </div>
      </Section>

      {outDeps.length > 0 && (
        <DependencySection
          title={`Imports (${outDeps.length})`}
          dependencies={outDeps}
          direction="out"
          onClick={setSelectedNode}
        />
      )}
      {inDeps.length > 0 && (
        <DependencySection
          title={`Imported by (${inDeps.length})`}
          dependencies={inDeps}
          direction="in"
          onClick={setSelectedNode}
        />
      )}
    </>
  )
}

function SystemDetail({
  system,
  files,
  systems,
}: {
  system: DbSystem
  files: DbFile[]
  systems: DbSystem[]
}) {
  const childFiles = files.filter(file => file.systemId === system.id)
  const childSystems = systems.filter(candidate => candidate.parentId === system.id)
  const parent = systems.find(candidate => candidate.id === system.parentId)
  const [confirming, setConfirming] = React.useState(false)
  const [confirmationError, setConfirmationError] = React.useState<string | null>(null)

  const confirmArchitecture = async () => {
    if (confirming || system.source !== 'cluster') return
    setConfirming(true)
    setConfirmationError(null)
    try {
      await apiUpdateSystem({ ...system, source: 'user' })
    } catch (error) {
      setConfirmationError(error instanceof Error ? error.message : 'Unable to confirm system')
    } finally {
      setConfirming(false)
    }
  }

  return (
    <>
      <InspectorIdentity
        kicker="Selected system"
        name={system.name}
        detail={system.description}
      />

      <Section title="General">
        <div className="axiom-inspector-properties">
          <Stat label="Files" value={String(childFiles.length)} />
          {childSystems.length > 0 && <Stat label="Subsystems" value={String(childSystems.length)} />}
          <Stat label="Source" value={system.source} />
          {parent && <Stat label="Parent" value={parent.name} />}
        </div>
      </Section>

      {system.source === 'cluster' && (
        <Section title="Architectural proposal">
          <div className="axiom-inspector-note">
            Axiom inferred this boundary from authored names, parsed symbols, dependencies, and co-change signals.
            Confirm it to protect this system from future automatic reclustering.
          </div>
          <button
            type="button"
            className="axiom-inspector-command"
            disabled={confirming}
            onClick={() => void confirmArchitecture()}
          >
            {confirming ? 'Confirming…' : 'Confirm as architecture'}
          </button>
          {confirmationError && (
            <div className="axiom-inspector-property__value--warn">{confirmationError}</div>
          )}
        </Section>
      )}

      {system.agentNotes && (
        <Section title="Agent notes">
          <div className="axiom-inspector-note">{system.agentNotes}</div>
        </Section>
      )}
    </>
  )
}

function DependencySection({
  title,
  dependencies,
  direction,
  onClick,
}: {
  title: string
  dependencies: DbDependency[]
  direction: 'in' | 'out'
  onClick: (id: string) => void
}) {
  const nameOf = useNodeName()
  const shown = dependencies.slice(0, 10)
  return (
    <Section title={title}>
      <div className="axiom-inspector-dependencies">
        {shown.map(dependency => {
          const target = direction === 'out' ? dependency.dst : dependency.src
          return (
            <button
              type="button"
              key={dependency.id}
              className="axiom-inspector-dependency"
              onClick={() => onClick(target)}
              title={nameOf(target)}
            >
              <span>{direction === 'out' ? '→' : '←'} {dependency.dependencyType}</span>
              <strong>{nameOf(target)}</strong>
            </button>
          )
        })}
        {dependencies.length > 10 && (
          <div className="axiom-inspector-more">+{dependencies.length - 10} more</div>
        )}
      </div>
    </Section>
  )
}

function Stat({ label, value, warn }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="axiom-inspector-property">
      <span>{label}</span>
      <strong className={warn ? 'axiom-inspector-property__value--warn' : undefined}>{value}</strong>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="axiom-inspector-section">
      <h3>{title}</h3>
      <div className="axiom-inspector-section__body">{children}</div>
    </section>
  )
}

/** Resolves a node id to what a person calls it: a path, a system or infra name. */
function useNodeName(): (id: string) => string {
  const files = useGraphStore(state => state.files)
  const systems = useGraphStore(state => state.systems)
  const infraNodes = useGraphStore(state => state.infraNodes)
  return React.useMemo(() => {
    const names = new Map<string, string>()
    for (const file of files) names.set(file.id, file.relPath)
    for (const system of systems) names.set(system.id, system.name)
    for (const node of infraNodes) names.set(node.id, node.name)
    return (id: string) => names.get(id) ?? id
  }, [files, systems, infraNodes])
}

/**
 * An infra node as the plan says it must read (INFRA_LAYER_PLAN.md "Why this
 * exists"): what role it plays and what fills it here, who touches it and
 * how, what code depends on inside it, and what running it locally needs.
 */
function InfraDetail({
  infra,
  dependencies,
  onOpen,
}: {
  infra: DbInfraNode
  dependencies: DbDependency[]
  onOpen: (id: string) => void
}) {
  const service = useRegistryStore(state => state.byId.get(infra.service))
  const contents = useGraphStore(state => state.infraContents)
  const requirements = useGraphStore(state => state.infraRequirements)
  const workspaceId = useGraphStore(state => state.currentProject?.id ?? '')
  const nameOf = useNodeName()
  const [error, setError] = React.useState<string | null>(null)

  const touching = dependencies.filter(d => d.dst === infra.id && d.dstType === 'infra' && d.status !== 'dismissed')
  // One row per file and kind, with the items it touches: "bookings.ts -
  // bookings, slips" rather than a row per table. A file already listed with
  // a specific relationship is not repeated under the generic "uses".
  const specificSources = new Set(touching.filter(d => d.dependencyType !== 'USES').map(d => d.src))
  const byKind = new Map<string, Map<string, { dep: DbDependency; items: string[]; proposed: boolean }>>()
  for (const dep of touching) {
    if (dep.dependencyType === 'USES' && specificSources.has(dep.src)) continue
    const rows = byKind.get(dep.dependencyType) ?? new Map()
    const row = rows.get(dep.src) ?? { dep, items: [], proposed: false }
    if (dep.targetItem) row.items.push(dep.targetItem)
    row.proposed ||= dep.status === 'proposed'
    rows.set(dep.src, row)
    byKind.set(dep.dependencyType, rows)
  }
  const kinds = [...byKind.keys()].sort((a, b) => RELATIONSHIP_ORDER.indexOf(a) - RELATIONSHIP_ORDER.indexOf(b))
  const items = contents.filter(item => item.infraId === infra.id)
  // A near-identical name on the other side (a likely typo) is the gap most
  // often behind a bug; it leads.
  const gapsSeen = new Set<string>()
  const gaps = items.filter(item => typeof item.detail?.warning === 'string')
    .sort((a, b) => (b.detail?.similar ? 1 : 0) - (a.detail?.similar ? 1 : 0))
    // A typo shows on both sides (receipts published, receipt consumed): once.
    .filter(item => {
      const similar = typeof item.detail?.similar === 'string' ? item.detail.similar : null
      if (similar && gapsSeen.has(similar)) return false
      gapsSeen.add(item.name)
      return true
    })
  const itemUse = (name: string) => {
    const kindsFor = new Map<string, number>()
    for (const dep of touching) {
      if (dep.targetItem === name) kindsFor.set(dep.dependencyType, (kindsFor.get(dep.dependencyType) ?? 0) + 1)
    }
    return [...kindsFor.entries()]
      .sort((a, b) => RELATIONSHIP_ORDER.indexOf(a[0]) - RELATIONSHIP_ORDER.indexOf(b[0]))
      .map(([kind, count]) => {
        const [one, many] = ITEM_ROLE[kind] ?? [kind.toLowerCase(), kind.toLowerCase()]
        return `${count} ${count === 1 ? one : many}`
      })
      .join(' · ')
  }
  const itemKinds = [...new Set(items.map(item => item.kind))]
  const needs = requirements.filter(req => req.infraId === infra.id)
  const detected = readDetectedBy(infra.detectedBy)
  const implementations = infra.implementations ?? []

  const decide = async (status: 'confirmed' | 'dismissed') => {
    setError(null)
    const response = await fetch(`http://127.0.0.1:7743/api/infra/${encodeURIComponent(infra.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ workspaceId, status }),
    })
    if (!response.ok) setError(`Could not save: ${await response.text()}`)
  }

  return (
    <>
      <InspectorIdentity
        kicker={infra.status === 'proposed' ? 'Found by Axiom, not confirmed' : ROLE_LABEL[infra.category] ?? 'Infrastructure'}
        name={infra.name}
        detail={[service?.name !== infra.name ? service?.name : '', ROLE_LABEL[infra.category] ?? infra.category, infra.subtype]
          .filter(Boolean).join(' · ')}
      />
      {infra.status === 'proposed' && (
        <Section title="Decide">
          <div className="axiom-inspector-decide">
            <button type="button" className="axiom-inspector-decide__confirm" onClick={() => void decide('confirmed')}>Confirm</button>
            <button type="button" className="axiom-inspector-decide__dismiss" onClick={() => void decide('dismissed')}>Dismiss</button>
          </div>
          {error && <p className="axiom-inspector-error" role="alert">{error}</p>}
        </Section>
      )}

      {gaps.length > 0 && (
        <Section title="Looks wrong">
          <ul className="axiom-inspector-list axiom-inspector-list--gaps">
            {gaps.map(item => {
              const who = [item.detail?.publishers, item.detail?.consumers]
                .flatMap(value => Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
              const fileId = who.length > 0 ? useGraphStore.getState().files.find(file => file.relPath === who[0])?.id : undefined
              return (
                <li key={item.id} title={item.evidence ?? undefined}>
                  <span><code>{item.name}</code> is {String(item.detail!.warning)}.</span>
                  {fileId && (
                    <button type="button" className="axiom-inspector-link" onClick={() => onOpen(fileId)}>{who[0]}</button>
                  )}
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      {implementations.length > 0 && (
        <Section title="How it runs">
          <ul className="axiom-inspector-list">
            {implementations.map((impl, index) => {
              const fileId = impl.kind === 'in-process' || impl.kind === 'vendor'
                ? useGraphStore.getState().files.find(file => file.relPath === impl.ref)?.id
                : undefined
              return (
                <li key={`${impl.kind}-${impl.ref}-${index}`}>
                  <span className="axiom-inspector-list__kind">{impl.environment} · {IMPLEMENTATION_LABEL[impl.kind] ?? impl.kind}</span>
                  {fileId
                    ? <button type="button" className="axiom-inspector-link" onClick={() => onOpen(fileId)}>{impl.ref}</button>
                    : <code>{impl.ref.startsWith('compose:') ? `${impl.ref.slice(8)} (docker compose)` : impl.ref}</code>}
                </li>
              )
            })}
          </ul>
        </Section>
      )}

      {needs.length > 0 && (
        <Section title="Needs to run">
          <ul className="axiom-inspector-list">
            {needs.map(req => (
              <li key={req.id} title={req.evidence ?? undefined}>
                <code>{req.name}</code>
                <span className={req.present ? 'axiom-inspector-list__ok' : 'axiom-inspector-list__missing'}>
                  {req.present ? 'set in .env' : 'not set locally'}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {kinds.length === 0 ? (
        <Section title="Who touches it">
          <p className="axiom-inspector-note">No file is connected to it yet. Ask your agent to record who uses it, or save a file that imports it.</p>
        </Section>
      ) : kinds.map(kind => {
        const rows = [...(byKind.get(kind)?.values() ?? [])]
        return (
          <Section key={kind} title={`${RELATIONSHIP_LABEL[kind] ?? kind} (${rows.length})`}>
            <ul className="axiom-inspector-list">
              {rows.slice(0, 12).map(({ dep, items: touched, proposed }) => (
                <li key={dep.id}>
                  <button type="button" className="axiom-inspector-link" onClick={() => onOpen(dep.src)}>{nameOf(dep.src)}</button>
                  {touched.length > 0 && <code>{touched.sort().join(', ')}</code>}
                  {proposed && <span className="axiom-inspector-list__proposed">proposed</span>}
                </li>
              ))}
              {rows.length > 12 && <li className="axiom-inspector-more">+{rows.length - 12} more</li>}
            </ul>
          </Section>
        )
      })}

      {itemKinds.map(kind => (
        <Section key={`contents-${kind}`} title={CONTENT_TITLE[kind] ?? `${kind.replace('_', ' ')}s`}>
          <ul className="axiom-inspector-list">
            {items.filter(item => item.kind === kind).map(item => (
              <li key={item.id} title={item.evidence ?? undefined}>
                <code>{item.name}</code>
                {typeof item.detail?.cron === 'string' && <span className="axiom-inspector-list__kind">{item.detail.cron}</span>}
                {itemUse(item.name) && <span className="axiom-inspector-list__kind">{itemUse(item.name)}</span>}
                {typeof item.detail?.warning === 'string' && <span className="axiom-inspector-list__missing">{item.detail.warning}</span>}
              </li>
            ))}
          </ul>
        </Section>
      ))}

      {(detected.evidence?.length ?? 0) > 0 && (
        <Section title="Why Axiom thinks it's here">
          <ul className="axiom-inspector-list axiom-inspector-list--quiet">
            {detected.evidence!.slice(0, 8).map((evidence, index) => (
              <li key={`${evidence.ref}-${index}`}>
                <span className="axiom-inspector-list__kind">{evidence.signal}</span>
                <code>{evidence.ref}</code>
                {evidence.detail && <span>{evidence.detail}</span>}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}
