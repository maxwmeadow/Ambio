import { useCallback, useEffect, useMemo, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { useShallow } from 'zustand/react/shallow'
import type { ProjectConfig } from '../../shared/types'
import { blockedReason, describeProgress, readProgress } from '../canvas/architectureProposal'
import { ArchitectureProposalPanel } from '../components/ArchitectureProposalPanel'
import { ProposalReviewCanvas } from '../components/ProposalReviewCanvas'
import { ProposalDraftProgress } from '../components/ProposalDraftProgress'
import { WorkbenchTitleBar } from '../components/ui/WorkbenchTitleBar'
import { useProposalStore } from '../store/architectureProposalStore'
import { useGraphStore } from '../store/graphStore'
import { rememberedMappingRun } from './MapWithAgent'
import { archdApi } from '../archdEndpoint'
import type { MappingAttempt } from '../../shared/agentDelivery'

interface ProjectReviewScreenProps {
  project: ProjectConfig
  onFinishReview: () => void
  onBack: () => void
}

/**
 * The proposal review is its own workspace around the real AmbioCanvas. Only
 * the scene data and persistence boundary differ: unapproved systems remain in
 * proposal storage until accepted, while rendering and interaction stay the
 * same implementation as the live Floor.
 */
export function ProjectReviewScreen({ project, onFinishReview, onBack }: ProjectReviewScreenProps) {
  const { proposal, loading, error, finalizing, load, finalize } = useProposalStore(useShallow(state => ({
    proposal: state.proposal,
    loading: state.loading,
    error: state.error,
    finalizing: state.finalizing,
    load: state.load,
    finalize: state.finalize,
  })))
  const { systems, files, floorLayouts } = useGraphStore(useShallow(state => ({
    systems: state.systems,
    files: state.files,
    floorLayouts: state.floorLayouts,
  })))

  useEffect(() => {
    let active = true
    const restore = async () => {
      const run = rememberedMappingRun(project.id)
      if (run?.attemptId) {
        useProposalStore.setState({ proposal: null, loading: true, error: null })
        const response = await fetch(`${archdApi()}/api/mapping-attempts/${encodeURIComponent(run.attemptId)}?workspace=${encodeURIComponent(project.id)}`)
        if (!response.ok) throw new Error('The mapping receipt could not be loaded. Return to agent connection to recover it.')
        const attempt = await response.json() as MappingAttempt
        if (attempt.state !== 'submitted' || !attempt.endedAt || !attempt.proposalId) throw new Error('Mapping must be submitted and its agent session stopped before review.')
        if (!active) return
        useProposalStore.setState({ pinned: { workspaceId: project.id, id: attempt.proposalId } })
      }
      if (active) await load(project.id)
    }
    void restore().catch(error => { if (active) useProposalStore.setState({ loading: false, error: error instanceof Error ? error.message : String(error) }) })
    return () => { active = false }
  }, [project.id, load])

  const progress = useMemo(
    () => readProgress(proposal?.systems ?? []),
    [proposal?.systems],
  )
  const proposedFiles = proposal?.memberships.filter(item => item.disposition === 'assign').length ?? 0
  const finishReview = useCallback(async () => {
    try {
      await finalize()
      onFinishReview()
    } catch {
      // The store surfaces the durable failure in the review rail. Staying on
      // this screen is intentional: navigation cannot outrun persistence.
    }
  }, [finalize, onFinishReview])

  // What finishing will leave out. Sending a system back is quiet at the time,
  // so the commit is where its consequences are spelled out.
  const [confirming, setConfirming] = useState(false)
  const sentBack = useMemo(() => {
    const all = proposal?.systems ?? []
    const byKey = new Map(all.map(system => [system.systemKey, system]))
    const filesIn = (systemKey: string) => proposal?.memberships
      .filter(item => item.disposition === 'assign' && item.targetSystemKey === systemKey).length ?? 0
    return {
      systems: all
        .filter(system => system.decision === 'rejected')
        .map(system => ({ ...system, files: filesIn(system.systemKey) })),
      // Still undecided inside something that was sent back: they cannot be
      // created without it, and the commit refuses to guess.
      stranded: all.filter(system => system.decision === 'pending' && blockedReason(system, byKey)),
    }
  }, [proposal])
  const strandedFiles = sentBack.systems.reduce((total, system) => total + system.files, 0)

  return (
    <main className="ambio-onboarding ambio-project-review">
      <WorkbenchTitleBar
        status={proposal ? describeProgress(progress).toUpperCase() : 'LOADING PROPOSAL'}
        statusTone={proposal ? (progress.settled ? 'ready' : 'busy') : 'busy'}
      />

      <div className="ambio-review__workspace ambio-review__workspace--proposal">
        <section className="ambio-review__panel ambio-review__panel--proposal" aria-labelledby="review-title">
          <header className="ambio-review__heading ambio-review__heading--proposal">
            <div className="ambio-review__heading-bar">
              <button className="ambio-onboarding__back" onClick={onBack} aria-label="Back to agent connection">
                <span aria-hidden="true">←</span>
                Agent connection
              </button>
              <div className="ambio-onboarding__step">STEP 04 / REVIEW THE MAP</div>
            </div>
            <h1 id="review-title">Review the architecture your agent found</h1>
            <p>
              Approve what fits, or send it back with a reason. Approving a system approves everything inside it.
              {proposal && <span className="ambio-review__summary"> {progress.total} {progress.total === 1 ? 'system' : 'systems'} · {proposedFiles} {proposedFiles === 1 ? 'file' : 'files'} placed.</span>}
            </p>
          </header>

          {proposal ? (
            <>
              {(proposal.rationale || proposal.evidenceSummary) && (
                <details className="ambio-review__brief" aria-label="Agent mapping brief">
                  <summary>Why the agent chose this structure</summary>
                  {proposal.rationale && <p><strong>Why this structure</strong>{proposal.rationale}</p>}
                  {proposal.evidenceSummary && <p><strong>Evidence</strong>{proposal.evidenceSummary}</p>}
                </details>
              )}

              <div className="ambio-review__proposal-list">
                <ArchitectureProposalPanel embedded />
              </div>
            </>
          ) : (
            <div className="ambio-review__loading" role="status">
              <strong>{loading ? 'Loading the proposed architecture…' : 'No proposal is available yet.'}</strong>
              <p>{error ?? 'Return to the connection step and ask the agent to map this project.'}</p>
              <ProposalDraftProgress workspaceId={project.id} inline />
            </div>
          )}

          <footer className="ambio-review__actions ambio-review__actions--proposal">
            <p>
              {progress.pending > 0
                ? 'Done Reviewing accepts the remaining proposed branches and commits this exact map.'
                : 'The review is settled. Commit it as the live canvas to continue.'}
            </p>
            <button
              className="ambio-onboarding__primary"
              onClick={() => {
                if (sentBack.systems.length > 0) setConfirming(true)
                else void finishReview()
              }}
              disabled={!proposal || finalizing}
            >
              <span>
                <strong>{finalizing ? 'Committing Architecture…' : 'Done Reviewing'}</strong>
                <small>{finalizing
                  ? 'Applying systems, nesting, files, and layout'
                  : 'Make this reviewed map the live canvas'}</small>
              </span>
              <span aria-hidden="true">→</span>
            </button>
          </footer>
        </section>

        <section className="ambio-review__canvas ambio-review__canvas--proposal" aria-label="Proposed architecture canvas">
          {proposal ? (
            <ReactFlowProvider>
              <ProposalReviewCanvas
                proposal={proposal}
                indexedSystems={systems}
                indexedFiles={files}
                indexedLayouts={floorLayouts}
              />
            </ReactFlowProvider>
          ) : (
            <div className="ambio-review__canvas-empty">Waiting for a proposal to draw.</div>
          )}
        </section>
      </div>

      {confirming && (
        <div className="ambio-create__scrim" onClick={() => setConfirming(false)}>
          <div
            className="ambio-remove-modal ambio-review-summary"
            role="dialog"
            aria-modal="true"
            aria-labelledby="review-summary-title"
            onClick={event => event.stopPropagation()}
            onKeyDown={event => { if (event.key === 'Escape') setConfirming(false) }}
            tabIndex={-1}
          >
            <div className="ambio-remove-modal__head">
              <span className="ambio-remove-modal__kicker">BEFORE YOU FINISH</span>
              <h3 id="review-summary-title">
                {sentBack.systems.length} {sentBack.systems.length === 1 ? 'system was' : 'systems were'} sent back
              </h3>
              <button className="ambio-remove-modal__close" onClick={() => setConfirming(false)} aria-label="Cancel">×</button>
            </div>

            <ul className="ambio-review-summary__list" aria-label="Systems sent back">
              {sentBack.systems.map(system => (
                <li key={system.systemKey}>
                  <strong>{system.name}</strong>
                  {system.files > 0 && <small>{system.files} {system.files === 1 ? 'file' : 'files'}</small>}
                  {system.rejectionReason && <p>{system.rejectionReason}</p>}
                </li>
              ))}
            </ul>

            <div className="ambio-remove-modal__body ambio-review-summary__meaning">
              <p>
                <strong>They will not be on your map.</strong>{' '}
                {strandedFiles > 0
                  ? `Their ${strandedFiles} ${strandedFiles === 1 ? 'file stays' : 'files stay'} in Unsorted until you or an agent places ${strandedFiles === 1 ? 'it' : 'them'}.`
                  : 'No files are left unplaced because of this.'}
              </p>
              <p>
                <strong>Your agent is not asked to redo them now.</strong>{' '}
                Your reasons are saved and shown to an agent the next time it starts work in this project.
              </p>
              {progress.pending - sentBack.stranded.length > 0 && (
                <p>
                  <strong>Everything else is approved.</strong>{' '}
                  The {progress.pending - sentBack.stranded.length} still undecided will be accepted as proposed.
                </p>
              )}
            </div>

            {sentBack.stranded.length > 0 && (
              <div className="ambio-create__error" role="alert">
                {sentBack.stranded.length === 1 ? 'One system is' : `${sentBack.stranded.length} systems are`} still
                undecided inside something you sent back, so there is nowhere to put {sentBack.stranded.length === 1 ? 'it' : 'them'}:{' '}
                {sentBack.stranded.map(system => system.name).join(', ')}. Send {sentBack.stranded.length === 1 ? 'it' : 'them'} back
                too before finishing.
              </div>
            )}

            <div className="ambio-remove-modal__actions">
              <button className="ambio-remove-modal__cancel" onClick={() => setConfirming(false)} autoFocus>
                Keep reviewing
              </button>
              <button
                className="ambio-create__go"
                disabled={sentBack.stranded.length > 0}
                onClick={() => { setConfirming(false); void finishReview() }}
              >
                Finish review <span aria-hidden="true">→</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
