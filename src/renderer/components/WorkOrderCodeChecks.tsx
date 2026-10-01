import type { CodeCheckResult } from '../../shared/types'
import { codeCheckHeadline } from '../canvas/codeFit.ts'

const STATE_LABEL: Record<CodeCheckResult['state'], string> = {
  agrees: 'Matches',
  disagrees: 'Still disagrees',
  'map-changed': 'Map changed',
  'file-gone': 'File gone',
}

/**
 * What Axiom found when it re-checked a make-the-code-match order against the
 * indexed code. Verified by Axiom, unlike the agent's own report below it.
 */
export function WorkOrderCodeChecks({ checks }: { checks: CodeCheckResult[] }) {
  return <section className="axiom-inbox__code-checks" aria-label="Code checked by Axiom">
    <div className="axiom-inbox__evidence-label">Checked by Axiom <span>· against the indexed code</span></div>
    <p>{codeCheckHeadline(checks)}</p>
    <ul>{checks.map((check, index) => <li key={`${check.sent.fileId}:${check.sent.kind}:${index}`} data-state={check.state}>
      <strong>{STATE_LABEL[check.state]}</strong> {check.now}
    </li>)}</ul>
  </section>
}
