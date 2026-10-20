import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

const directory = resolve(process.argv[2] ?? 'out/canvas-scale')
function reports(path) {
  return statSync(path).isDirectory()
    ? readdirSync(path).flatMap(name => reports(join(path, name)))
    : path.endsWith('.json') ? [{ ...JSON.parse(readFileSync(path, 'utf8')), artifact: path }] : []
}
const rows = reports(directory).filter(r => r.fixture && r.status)
const number = value => typeof value === 'number' ? value.toFixed(1) : 'unavailable'
console.log('| Entities | Shape | Collection | Cold to target ms* | Warm p95 / p99 ms | Selection p95 ms | Sampled private MiB | Targets missed |')
console.log('| ---: | --- | --- | ---: | ---: | ---: | ---: | --- |')
for (const row of rows) {
  const warm = row.phaseFrames?.warm
  const missed = Object.entries(row.targets ?? {}).filter(([,value]) => value === false).map(([key]) => key)
  const unverified = Object.entries(row.targets ?? {}).filter(([,value]) => value === null).map(([key]) => key)
  const result = missed.join(', ') || (row.status === 'failed' ? 'collection failed' : unverified.length ? `unverified: ${unverified.join(', ')}` : 'none')
  console.log(`| ${row.fixture.systems + row.fixture.files} | ${row.shape} | ${row.status} | ${number(row.cold?.usableMs)} | ${number(warm?.p95)} / ${number(warm?.p99)} | ${number(row.selectionFeedback?.p95)} | ${number((row.sampledPeakPrivateKiB ?? row.peakPrivateKiB) / 1024 || null)} | ${result} |`)
}
console.log('\n* Includes scripted search and its intentional 850 ms flight/settle; not pure cold-layout time. Null targets are unverified, not passes. Stage timings are inclusive and cannot be summed across nested work.')
for (const row of rows) {
  console.log(`\n${row.shape} ${row.fixture.systems + row.fixture.files}: ${row.artifact}`)
  for (const [stage, data] of Object.entries(row.observed?.trace?.stages ?? {}))
    console.log(`  ${stage}: max ${number(data.maxMs)} ms, total ${number(data.totalMs)} ms, ${data.count} calls`)
  if (row.status === 'failed') console.log(`  FAILED: ${row.resourceFailure ?? row.error}; last stage: ${JSON.stringify(row.failureStage ?? row.events?.at(-1))}`)
}
