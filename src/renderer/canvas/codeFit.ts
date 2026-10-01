/**
 * Where the code disagrees with a meaning edit you just made (archd
 * `db/code_fit.go`). The map change is already recorded; making the code match
 * is real work, so it is offered as a work order, never done for you.
 */
export interface CodeFitFinding {
  kind: 'folder' | 'coupling'
  fileId: string
  filePath: string
  systemId: string
  systemName: string
  suggestedPath?: string
  otherSystemName?: string
  summary: string
  ask: string
}

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
