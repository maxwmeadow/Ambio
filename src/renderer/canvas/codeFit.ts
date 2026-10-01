import type { CodeCheckResult, CodeFitFinding } from '../../shared/types'

/**
 * Where the code disagrees with a meaning edit you just made (archd
 * `db/code_fit.go`). The map change is already recorded; making the code match
 * is real work, so it is offered as a work order, never done for you. The
 * order names the files, and Axiom re-checks them after the agent replies.
 */
export type { CodeCheckResult, CodeFitFinding }

/** One line for the notice: the first disagreement and how many more. */
export function codeFitNoticeBody(findings: CodeFitFinding[]): string | undefined {
  if (findings.length === 0) return undefined
  const more = findings.length - 1
  return more > 0
    ? `${findings[0].summary}, and ${more} more ${more === 1 ? 'thing disagrees' : 'things disagree'} with the code.`
    : `${findings[0].summary}.`
}

/** The work order an agent would act on to make the code agree with the map. */
export function codeFitInstruction(findings: CodeFitFinding[]): string {
  const lines = [
    'I changed the architecture map; please make the code match it.',
    '',
    ...findings.map(finding => `- ${finding.ask}`),
    '',
    'Do not change what the map says; when the code agrees, reply with what you changed.',
  ]
  return lines.join('\n')
}

/** Open Send to Agent with the make-the-code-match order written. */
export function openMakeCodeMatch(findings: CodeFitFinding[]): void {
  window.dispatchEvent(new CustomEvent('axiom:open-agent-dispatch', {
    detail: {
      note: codeFitInstruction(findings),
      codeFitFileIds: [...new Set(findings.map(finding => finding.fileId))],
    },
  }))
}

/** One line for a work order: what Axiom found when it checked the code. */
export function codeCheckHeadline(checks: CodeCheckResult[]): string {
  const agree = checks.filter(check => check.state === 'agrees').length
  const open = checks.filter(check => check.state === 'disagrees').length
  if (open === 0 && agree === checks.length) return 'Axiom checked the code: it now matches the map.'
  if (open === 0) return 'Axiom checked the code: nothing left disagrees, but the map changed since this was sent.'
  return `Axiom checked the code: ${open} of ${checks.length} still ${open === 1 ? 'disagrees' : 'disagree'} with the map.`
}
