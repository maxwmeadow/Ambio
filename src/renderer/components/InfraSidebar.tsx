import { useEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import type { DbInfraNode } from '../../shared/types'
import { ServiceIcon } from './InfraPickerDialog'
import { useGraphStore } from '../store/graphStore'
import { useRegistryStore } from '../store/registryStore'
import { CATEGORY_GLYPHS } from '../canvas/nodes/infraIcons'
import { ROLE_LABEL, fileName, readDetectedBy } from '../canvas/infraRoles'
import { infraLinks } from '../canvas/infraLinks'
import { CreateInfraDialog } from './CreateInfraDialog'
import { currentPlatform, useCommandHandlers } from '../app/commands'
import { COMMANDS, formatAccelerator } from '../../shared/appMenu'
import { archdApi } from '../archdEndpoint.ts'

/**
 * The infrastructure sidebar (INFRA_LAYER_PLAN.md, "Canvas placement").
 *
 * Infra code talks to - databases, caches, queues, APIs - has no honest place
 * on a map of code, so it lives here, on the canvas's left edge. Selecting a
 * row draws its relationships out onto the canvas; selecting a system or file
 * while the sidebar is open lights the rows it touches and draws lines back to
 * them. Hosting is listed too, but it is also on the canvas, as the frames
 * that hold what they run. Detection's proposals wait at the top until
 * someone confirms or dismisses them.
 */

const GROUPS: Array<{ label: string; roles: string[] }> = [
  { label: 'Data', roles: ['database', 'cache', 'search', 'storage'] },
  { label: 'Messaging and jobs', roles: ['queue', 'realtime', 'scheduler'] },
  { label: 'Services', roles: ['llm', 'api', 'email', 'auth', 'flags'] },
  { label: 'Observability', roles: ['observability'] },
  { label: 'Hosting', roles: ['platform'] },
]

export function InfraSidebar() {
  const open = useGraphStore(s => s.infraSidebarOpen)
  const setOpen = useGraphStore(s => s.setInfraSidebarOpen)
  const selectedInfraId = useGraphStore(s => s.selectedInfraId)
  const setSelectedInfra = useGraphStore(s => s.setSelectedInfra)
  const setInspectedNode = useGraphStore(s => s.setInspectedNode)
  const selectedNodeId = useGraphStore(s => s.selectedNodeId)
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const infraNodes = useGraphStore(s => s.infraNodes)
  const dependencies = useGraphStore(s => s.dependencies)
  const files = useGraphStore(s => s.files)
  const systems = useGraphStore(s => s.systems)
  const contents = useGraphStore(s => s.infraContents)
  const unresolved = useGraphStore(s => s.infraUnresolved)
  const proposalKey = useGraphStore(s => s.infraProposalKey)
  const services = useRegistryStore(s => s.byId)
  const { fitView } = useReactFlow()
  const [busy, setBusy] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  // Map → Add Infrastructure and the canvas right-click menu.
  useCommandHandlers({ 'map.addInfra': () => setAdding(true) })
  const [error, setError] = useState<string | null>(null)

  const listed = useMemo(() => infraNodes.filter(node => node.status !== 'dismissed'), [infraNodes])
  const proposals = useMemo(() => listed.filter(node => node.status === 'proposed')
    .sort((a, b) => a.name.localeCompare(b.name)), [listed])
  const confirmed = useMemo(() => listed.filter(node => node.status !== 'proposed'), [listed])

  // Distinct files that use each item, and what looks wrong in its contract.
  const facts = useMemo(() => {
    const users = new Map<string, Set<string>>()
    const implementers = new Map<string, Set<string>>()
    for (const dep of dependencies) {
      if (dep.dstType !== 'infra' || dep.status === 'dismissed') continue
      const bucket = dep.dependencyType === 'IMPLEMENTS' ? implementers : users
      const set = bucket.get(dep.dst) ?? new Set<string>()
      set.add(dep.src)
      bucket.set(dep.dst, set)
    }
    const gaps = new Map<string, string[]>()
    for (const item of contents) {
      if (typeof item.detail?.warning !== 'string') continue
      gaps.set(item.infraId, [...(gaps.get(item.infraId) ?? []), `${item.name} is ${item.detail.warning}`])
    }
    return { users, implementers, gaps }
  }, [dependencies, contents])

  // Rows the selected system or file touches, lit while the sidebar is open.
  const touched = useMemo(() => {
    if (!open || selectedInfraId || !selectedNodeId) return new Set<string>()
    const fileSystem = new Map(files.map(file => [file.id, file.systemId ?? null]))
    const systemParent = new Map(systems.map(system => [system.id, system.parentId ?? null]))
    return new Set(infraLinks({
      selectedInfraId: null, selectedNodeId, dependencies,
      infraIds: new Set(listed.map(node => node.id)), fileSystem, systemParent,
      visibleNodeId: id => id,
    }).map(link => link.infraId))
  }, [open, selectedInfraId, selectedNodeId, dependencies, listed, files, systems])

  // A new proposal pulses the collapsed tab once, like a file arriving in Unsorted.
  const [pulse, setPulse] = useState(0)
  const seenProposal = useRef(proposalKey)
  useEffect(() => {
    if (proposalKey === seenProposal.current) return
    seenProposal.current = proposalKey
    setPulse(proposalKey)
    const timer = window.setTimeout(() => setPulse(0), 1400)
    return () => window.clearTimeout(timer)
  }, [proposalKey])

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !useGraphStore.getState().selectedInfraId) return
      setSelectedInfra(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setSelectedInfra])

  const select = (node: DbInfraNode) => {
    if (selectedInfraId === node.id) {
      setSelectedInfra(null)
      return
    }
    setSelectedInfra(node.id)
    setInspectedNode(node.id)
    // Hosting is on the canvas as well: bring its frame into view.
    if (node.category === 'platform' && node.status !== 'proposed') {
      void fitView({ nodes: [{ id: node.id }], padding: 0.3, duration: 500, maxZoom: 1 })
    }
  }

  const decide = async (nodes: DbInfraNode[], status: 'confirmed' | 'dismissed') => {
    setBusy(nodes.length === 1 ? nodes[0].id : 'all')
    setError(null)
    try {
      for (const node of nodes) {
        const response = await fetch(`${archdApi()}/api/infra/${encodeURIComponent(node.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId, status }),
        })
        if (!response.ok) throw new Error(await response.text())
      }
      if (status === 'dismissed' && nodes.some(node => node.id === selectedInfraId)) setSelectedInfra(null)
    } catch (err) {
      setError(`Could not save the decision: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  const row = (node: DbInfraNode, proposal: boolean) => {
    const service = services.get(node.service)
    const users = facts.users.get(node.id)?.size ?? 0
    const implementers = facts.implementers.get(node.id)?.size ?? 0
    const gaps = facts.gaps.get(node.id) ?? []
    const usage = users > 0
      ? `${users} file${users === 1 ? '' : 's'}`
      : implementers > 0 ? 'implemented, not used yet' : 'nothing connected'
    const detected = proposal ? readDetectedBy(node.detectedBy) : null
    const vendor = (node.implementations ?? []).find(impl => impl.kind === 'vendor')
    const foundIn = proposal ? vendor?.ref ?? detected?.evidence?.[0]?.ref : undefined
    return (
      <li key={node.id} className="axiom-infra-sidebar__item">
        <button
          type="button"
          className="axiom-infra-sidebar__row"
          data-infra-row={node.id}
          data-selected={selectedInfraId === node.id || undefined}
          data-touched={touched.has(node.id) || undefined}
          data-proposed={proposal || undefined}
          aria-pressed={selectedInfraId === node.id}
          onClick={() => select(node)}
          title={gaps.length > 0 ? gaps.join('\n') : undefined}
        >
          <span className="axiom-infra-sidebar__icon" aria-hidden="true">
            {service ? <ServiceIcon service={service} size={18} /> : (
              <svg viewBox="0 0 24 24" width={18} height={18}>
                <path d={CATEGORY_GLYPHS[node.category] ?? CATEGORY_GLYPHS.api} fill="currentColor" />
              </svg>
            )}
          </span>
          <span className="axiom-infra-sidebar__text">
            <span className="axiom-infra-sidebar__name">{node.name}</span>
            <span className="axiom-infra-sidebar__meta">
              {ROLE_LABEL[node.category] ?? node.category}
              {' · '}
              {node.category === 'platform' && !proposal ? 'on the map' : usage}
            </span>
            {foundIn && <span className="axiom-infra-sidebar__found">found in {fileName(foundIn.replace(/:\d+$/, ''))}</span>}
          </span>
          {gaps.length > 0 && (
            <span className="axiom-infra-sidebar__gap" aria-label={`${gaps.length} thing${gaps.length === 1 ? '' : 's'} look wrong`}>!</span>
          )}
        </button>
        {proposal && (
          <div className="axiom-infra-sidebar__decide">
            <button type="button" disabled={busy !== null} onClick={() => void decide([node], 'confirmed')}>
              {busy === node.id ? 'Saving…' : 'Confirm'}
            </button>
            <button type="button" disabled={busy !== null} onClick={() => void decide([node], 'dismissed')}>Dismiss</button>
          </div>
        )}
      </li>
    )
  }

  // One thin tab on the sidebar's edge opens and closes it, and stays at the
  // same height either way. Collapsed, a single dot says there is something
  // to look at: amber when something looks wrong, green for new finds.
  const shortcut = formatAccelerator(COMMANDS['view.infrastructure'].accelerator!, currentPlatform())
  const alert = [...facts.gaps.keys()].some(id => confirmed.some(node => node.id === id))
  const tab = (
    <button
      key={`tab-${pulse}`}
      type="button"
      className="axiom-infra-sidebar-tab"
      data-open={open || undefined}
      data-arriving={pulse > 0 || undefined}
      onClick={() => setOpen(!open)}
      aria-label={open ? 'Close infrastructure' : 'Open infrastructure'}
      aria-expanded={open}
      title={open ? `Close infrastructure (${shortcut})`
        : `Infrastructure${proposals.length ? ` · ${proposals.length} new` : ''}${alert ? ' · something looks wrong' : ''} (${shortcut})`}
    >
      <span className="axiom-infra-sidebar-tab__chevron" aria-hidden="true">{open ? '‹' : '›'}</span>
      {!open && <span className="axiom-infra-sidebar-tab__label">Infrastructure</span>}
      {!open && (alert || proposals.length > 0) && (
        <span className="axiom-infra-sidebar-tab__dot" data-kind={alert ? 'alert' : 'new'} aria-hidden="true" />
      )}
    </button>
  )

  if (!open) {
    return (
      <>
        {tab}
        <CreateInfraDialog isOpen={adding} onClose={() => setAdding(false)} />
      </>
    )
  }

  const groups = GROUPS.map(group => ({
    ...group,
    nodes: confirmed.filter(node => group.roles.includes(node.category))
      .sort((a, b) => (facts.users.get(b.id)?.size ?? 0) - (facts.users.get(a.id)?.size ?? 0) || a.name.localeCompare(b.name)),
  })).filter(group => group.nodes.length > 0)
  const other = confirmed.filter(node => !GROUPS.some(group => group.roles.includes(node.category)))
  if (other.length > 0) groups.push({ label: 'Other', roles: [], nodes: other })
  const selected = selectedInfraId ? listed.find(node => node.id === selectedInfraId) : undefined

  return (
    <>
    <aside className="axiom-infra-sidebar" aria-label="Infrastructure">
      <header className="axiom-infra-sidebar__header">
        <div>
          <h2>Infrastructure</h2>
          <p>
            {confirmed.length} in use
            {proposals.length > 0 ? ` · ${proposals.length} to confirm` : ''}
          </p>
        </div>
        <button type="button" className="axiom-infra-sidebar__add" onClick={() => setAdding(true)}
          title="Add a database, queue, API or host">+ Add</button>
      </header>
      <div className="axiom-infra-sidebar__list">
        {error && <p className="axiom-infra-sidebar__error" role="alert">{error}</p>}
        {proposals.length > 0 && (
          <section className="axiom-infra-sidebar__group axiom-infra-sidebar__group--found">
            <div className="axiom-infra-sidebar__group-head">
              <h3>Found in your code</h3>
              {proposals.length > 1 && (
                <button type="button" disabled={busy !== null} onClick={() => void decide(proposals, 'confirmed')}>
                  {busy === 'all' ? 'Saving…' : `Confirm all ${proposals.length}`}
                </button>
              )}
            </div>
            <ul>{proposals.map(node => row(node, true))}</ul>
          </section>
        )}
        {groups.map(group => (
          <section key={group.label} className="axiom-infra-sidebar__group">
            <div className="axiom-infra-sidebar__group-head"><h3>{group.label}</h3></div>
            <ul>{group.nodes.map(node => row(node, false))}</ul>
          </section>
        ))}
        {listed.length === 0 && (
          <p className="axiom-infra-sidebar__empty">
            No infrastructure yet. Axiom looks for databases, queues and services as files are saved;
            you can also add one with Add Infra.
          </p>
        )}
        {unresolved.length > 0 && (
          <section className="axiom-infra-sidebar__group axiom-infra-sidebar__unresolved">
            <div className="axiom-infra-sidebar__group-head"><h3>Could not tell which service</h3></div>
            <ul>
              {unresolved.map(item => (
                <li key={`${item.Package}-${item.Evidence}`}>
                  <code>{item.Package}</code> in {fileName(item.Evidence.replace(/:\d+$/, ''))} could be{' '}
                  {item.Candidates.map(id => services.get(id)?.name ?? id).join(', ')}.
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      <footer className="axiom-infra-sidebar__footer">
        {selected
          ? <>Showing what uses <strong>{selected.name}</strong>. Esc to clear.</>
          : touched.size > 0
            ? <>The selection uses {touched.size} of these.</>
            : 'Select one to see what uses it, or select a system to see what it uses.'}
      </footer>
    </aside>
    {tab}
    <CreateInfraDialog isOpen={adding} onClose={() => setAdding(false)} />
    </>
  )
}

