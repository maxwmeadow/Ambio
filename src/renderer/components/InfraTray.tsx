import { useMemo, useState } from 'react'
import type { DbInfraNode } from '../../shared/types'
import { FloatingWindow } from './FloatingWindow'
import { ServiceIcon } from './InfraPickerDialog'
import { useGraphStore } from '../store/graphStore'
import { useRegistryStore } from '../store/registryStore'
import { CATEGORY_GLYPHS } from '../canvas/nodes/infraIcons'
import { IMPLEMENTATION_LABEL, ROLE_LABEL, fileName, readDetectedBy } from '../canvas/infraRoles'

/**
 * Infrastructure detection found and nobody has decided about yet.
 *
 * Detection proposes; a person or the agent confirms (INFRA_LAYER_PLAN.md L2).
 * A proposal stays off the Floor until it is confirmed, exactly as a new file
 * waits in Unsorted until it is placed - an index can propose a dozen services
 * at once, and the map should not fill with guesses.
 */
export function InfraTray({ onClose }: { onClose: () => void }) {
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')
  const infraNodes = useGraphStore(s => s.infraNodes)
  const dependencies = useGraphStore(s => s.dependencies)
  const files = useGraphStore(s => s.files)
  const requirements = useGraphStore(s => s.infraRequirements)
  const unresolved = useGraphStore(s => s.infraUnresolved)
  const services = useRegistryStore(s => s.byId)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const proposals = useMemo(
    () => infraNodes
      .filter(node => node.status === 'proposed')
      .sort((a, b) => (ROLE_LABEL[a.category] ?? a.category).localeCompare(ROLE_LABEL[b.category] ?? b.category)
        || a.name.localeCompare(b.name)),
    [infraNodes],
  )
  const pathById = useMemo(() => new Map(files.map(file => [file.id, file.relPath])), [files])

  const decide = async (nodes: DbInfraNode[], status: 'confirmed' | 'dismissed') => {
    setBusy(nodes.length === 1 ? nodes[0].id : 'all')
    setError(null)
    try {
      for (const node of nodes) {
        const response = await fetch(`http://127.0.0.1:7743/api/infra/${encodeURIComponent(node.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspaceId, status }),
        })
        if (!response.ok) throw new Error(await response.text())
      }
    } catch (err) {
      setError(`Could not save the decision: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(null)
    }
  }

  return (
    <FloatingWindow
      className="axiom-infra-tray"
      dataAttribute="data-infra-tray"
      title="Infrastructure found"
      subtitle={proposals.length === 0
        ? 'Nothing waiting'
        : `${proposals.length} to confirm, from imports, env files and config`}
      onClose={onClose}
      initialWidthRatio={0.34}
      initialHeightRatio={0.6}
      footer={proposals.length > 1 ? (
        <button type="button" className="axiom-infra-tray__all" disabled={busy !== null}
          onClick={() => void decide(proposals, 'confirmed')}>
          Confirm all {proposals.length}
        </button>
      ) : 'Confirmed infrastructure appears on the map.'}
    >
      <div className="axiom-infra-tray__scroll">
      {error && <p className="axiom-infra-tray__error" role="alert">{error}</p>}
      {proposals.length === 0 && unresolved.length === 0 && (
        <p className="axiom-infra-tray__empty">
          Everything detection found has been decided. New imports, env variables and config files are checked as you save.
        </p>
      )}
      <ul className="axiom-infra-tray__list">
        {proposals.map(node => {
          const service = services.get(node.service)
          const detected = readDetectedBy(node.detectedBy)
          const edges = dependencies.filter(d => d.dst === node.id && d.dstType === 'infra')
          const adapters = edges.filter(d => d.dependencyType === 'IMPLEMENTS')
          const users = edges.filter(d => d.dependencyType !== 'IMPLEMENTS')
          const local = (node.implementations ?? []).filter(impl => impl.kind !== 'vendor')
          const needs = requirements.filter(req => req.infraId === node.id).map(req => req.name)
          // The file that loads the SDK is the evidence; the facade around it is not.
          const vendor = (node.implementations ?? []).find(impl => impl.kind === 'vendor')
          const firstAdapter = vendor?.evidence ?? vendor?.ref ?? adapters.map(edge => pathById.get(edge.src)).find(Boolean)
          const firstEvidence = detected.evidence?.[0]
          return (
            <li key={node.id} className="axiom-infra-tray__item" data-infra-proposal={node.service}>
              <div className="axiom-infra-tray__head">
                {service ? <ServiceIcon service={service} size={22} /> : (
                  <svg viewBox="0 0 24 24" width={22} height={22} aria-hidden="true">
                    <path d={CATEGORY_GLYPHS[node.category] ?? CATEGORY_GLYPHS.api} fill="currentColor" />
                  </svg>
                )}
                <div className="axiom-infra-tray__title">
                  <strong>{node.name}</strong>
                  <span>{ROLE_LABEL[node.category] ?? node.category}</span>
                </div>
                {detected.declaredOnly && (
                  <span className="axiom-infra-tray__tag" title="A manifest lists it, but no file loads it">declared, not loaded</span>
                )}
              </div>
              <dl className="axiom-infra-tray__facts">
                {(firstAdapter || firstEvidence) && (
                  <>
                    <dt>Found in</dt>
                    <dd>{firstAdapter ?? firstEvidence?.ref}</dd>
                  </>
                )}
                {users.length > 0 && (
                  <>
                    <dt>Used by</dt>
                    <dd>{users.length} file{users.length === 1 ? '' : 's'}: {users.slice(0, 3).map(edge => fileName(pathById.get(edge.src) ?? '')).join(', ')}{users.length > 3 ? '…' : ''}</dd>
                  </>
                )}
                {local.length > 0 && (
                  <>
                    <dt>Locally</dt>
                    <dd>{local.map(impl => `${impl.ref.startsWith('compose:') ? impl.ref.slice(8) + ' (compose)' : fileName(impl.ref)} - ${IMPLEMENTATION_LABEL[impl.kind] ?? impl.kind}`).join('; ')}</dd>
                  </>
                )}
                {needs.length > 0 && (
                  <>
                    <dt>Needs</dt>
                    <dd className="axiom-infra-tray__env">{needs.join(', ')}</dd>
                  </>
                )}
              </dl>
              <div className="axiom-infra-tray__actions">
                <button type="button" className="axiom-infra-tray__confirm" disabled={busy !== null}
                  onClick={() => void decide([node], 'confirmed')}>
                  {busy === node.id ? 'Saving…' : 'Confirm'}
                </button>
                <button type="button" className="axiom-infra-tray__dismiss" disabled={busy !== null}
                  onClick={() => void decide([node], 'dismissed')}>
                  Dismiss
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {unresolved.length > 0 && (
        <section className="axiom-infra-tray__unresolved">
          <h3>Could not tell which service</h3>
          <ul>
            {unresolved.map(item => (
              <li key={`${item.Package}-${item.Evidence}`}>
                <code>{item.Package}</code> in {item.Evidence} could be {item.Candidates.map(id => services.get(id)?.name ?? id).join(', ')}.
              </li>
            ))}
          </ul>
          <p>Ask your agent to record which one; it can read how the code uses it.</p>
        </section>
      )}
      </div>
    </FloatingWindow>
  )
}
