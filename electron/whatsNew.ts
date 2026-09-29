// "What's New": after an update, show the CHANGELOG section for the version
// just installed, once. A fresh install shows nothing; it has no "before".

/** The body of `## [version]` in a Keep a Changelog document, if present. */
export function changelogSection(changelog: string, version: string): string | null {
  const lines = changelog.split(/\r?\n/)
  const heading = (line: string) => /^## \[/.test(line)
  const start = lines.findIndex(line => heading(line) && line.startsWith(`## [${version}]`))
  if (start < 0) return null
  let end = lines.findIndex((line, index) => index > start && heading(line))
  if (end < 0) end = lines.length
  const body = lines.slice(start + 1, end).join('\n').trim()
  return body || null
}

function parts(version: string): number[] {
  return version.split(/[.+-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0)
}

export function isNewer(current: string, previous: string): boolean {
  const [a, b] = [parts(current), parts(previous)]
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] > b[index]
  }
  return false
}

/** Whether to show What's New, given the version last seen (null = fresh install). */
export function shouldShowWhatsNew(current: string, lastSeen: string | null): boolean {
  return lastSeen !== null && isNewer(current, lastSeen)
}
