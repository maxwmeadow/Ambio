/**
 * What an investigation run can see in this project, as one line for the agent
 * opening a case (docs/INVESTIGATION_RUNTIMES.md). Knowing up front whether a
 * run will show argument values or only output changes the repro it plans.
 */

export interface LanguageReadiness {
  language: string
  files: number
  level: 'full' | 'output' | 'missing'
  tool?: string
  version?: string
  note: string
}

export function readinessLine(languages: readonly LanguageReadiness[]): string {
  if (languages.length === 0) return ''
  const named = (list: LanguageReadiness[]) => list.map(l => `${l.language} (${l.files} file${l.files === 1 ? '' : 's'})`).join(', ')
  const full = languages.filter(l => l.level === 'full')
  const output = languages.filter(l => l.level === 'output')
  const missing = languages.filter(l => l.level === 'missing')
  const parts: string[] = []
  if (full.length) parts.push(`Runs record calls, arguments and returns for ${named(full)}.`)
  if (output.length) parts.push(`${named(output)}: exit code and output only.`)
  if (missing.length) parts.push(`${missing.map(l => `${l.language}: ${l.note}`).join('; ')}.`)
  return parts.join(' ')
}
