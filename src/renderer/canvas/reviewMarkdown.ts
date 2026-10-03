import type { DeltaClaim, DeltaWorkSession } from '../../shared/types'

/**
 * Review Changes as Markdown, for a pull request description or a standup:
 * what changed in the architecture, who did it, and what the agents said
 * they were doing. Plain claims, no map required to read it.
 */
export function reviewMarkdown(input: {
  headline: string
  window: string
  claims: DeltaClaim[]
  sessions: DeltaWorkSession[]
  projectName?: string
}): string {
  const lines: string[] = []
  lines.push(`## Architecture changes${input.projectName ? ` · ${input.projectName}` : ''}`, '')
  lines.push(`${input.headline} (${input.window})`, '')
  if (input.sessions.length > 0) {
    lines.push('**What the agents set out to do**', '')
    for (const session of input.sessions) {
      const who = session.agent || 'agent'
      lines.push(`- ${who}: ${session.goal}${session.summary ? ` - ${session.summary}` : ''}`)
    }
    lines.push('')
  }
  if (input.claims.length > 0) {
    lines.push('**Changes**', '')
    for (const claim of input.claims) {
      const tags = [
        claim.createsCycle ? 'closes a dependency loop' : '',
        claim.actor === 'agent' && !claim.sessionId ? 'unexplained' : '',
        claim.codeFit?.length ? 'code still disagrees' : '',
      ].filter(Boolean)
      lines.push(`- ${claim.title}${claim.subtitle ? ` _(${claim.subtitle})_` : ''}${tags.length ? ` - ${tags.join(', ')}` : ''}`)
      for (const evidence of claim.evidence.slice(0, 5)) {
        lines.push(`  - ${evidence.label}${evidence.detail ? `: ${evidence.detail}` : ''}`)
      }
      if (claim.evidence.length > 5) lines.push(`  - and ${claim.evidence.length - 5} more`)
    }
    lines.push('')
  }
  lines.push('_From Ambio Review Changes._')
  return `${lines.join('\n')}\n`
}
