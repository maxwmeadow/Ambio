import assert from 'node:assert/strict'
import test from 'node:test'
import { infraGaps, infraSummary } from './infraSummary.ts'

const names = { f1: 'src/infra/db/postgres.ts', f2: 'src/repos/bookings.ts', f3: 'src/repos/marinas.ts', sys: 'Bookings' }
const input = {
  nodes: [
    { id: 'pg', name: 'PostgreSQL', category: 'database', subtype: 'sql', service: 'postgresql/postgres', status: 'confirmed',
      implementations: [{ environment: 'local', kind: 'in-process', ref: 'src/infra/db/sqlite.ts' }, { environment: 'local', kind: 'local-service', ref: 'compose:postgres' }] },
    { id: 'st', name: 'Stripe', category: 'api', service: 'stripe/api', status: 'proposed' },
    { id: 'ph', name: 'PostHog', category: 'observability', status: 'dismissed' },
  ],
  edges: [
    { src: 'f1', dst: 'pg', srcType: 'file', dependencyType: 'IMPLEMENTS' },
    { src: 'f2', dst: 'pg', srcType: 'file', dependencyType: 'WRITES', targetItem: 'bookings' },
    { src: 'f3', dst: 'pg', srcType: 'file', dependencyType: 'USES' },
  ],
  contents: [
    { infraId: 'pg', kind: 'table', name: 'bookings' },
    { infraId: 'pg', kind: 'topic', name: 'booking.reminder', detail: { publishers: ['src/jobs/sendReminders.ts'], consumers: [], warning: 'published, but nothing consumes it' } },
  ],
  requirements: [{ name: 'DATABASE_URL', infraId: 'pg', present: false }, { name: 'SESSION_SECRET', infraId: null, present: false }],
  unresolved: [{ Package: 'boto3', Candidates: ['aws/s3', 'aws/sqs'], Evidence: 'jobs.py:1' }],
  nameOf: id => names[id] ?? id,
}

test('the agent reads infra as paths, roles and next steps, not ids and joins', () => {
  const text = infraSummary(input)
  assert.match(text, /Infrastructure: 2 nodes, 1 proposed by detection\./, 'a dismissed node is not listed')
  assert.match(text, /PostgreSQL - database, sql \(postgresql\/postgres\) - id pg/)
  assert.match(text, /Locally: src\/infra\/db\/sqlite\.ts - in-process stand-in; postgres \(docker compose\) - local service/)
  assert.match(text, /Needs: DATABASE_URL \(not set locally\)/)
  assert.match(text, /Implemented by: src\/infra\/db\/postgres\.ts/)
  assert.match(text, /Writes bookings: src\/repos\/bookings\.ts/)
  assert.match(text, /Uses \(from imports\): src\/repos\/marinas\.ts/)
  assert.match(text, /tables: bookings/)
  assert.match(text, /! topic booking\.reminder: published, but nothing consumes it \(src\/jobs\/sendReminders\.ts\)/)
  assert.match(text, /Stripe - api \(stripe\/api\) - PROPOSED/)
  assert.match(text, /Env vars no infra claims: SESSION_SECRET/)
  assert.match(text, /boto3 in jobs\.py:1 - one of aws\/s3, aws\/sqs/)
  assert.match(text, /Next: confirm or dismiss proposals.*op:"decide".*op:"connect"/)
  assert.ok(text.indexOf('PostgreSQL') < text.indexOf('Stripe'), 'confirmed infra first')
})

test('an empty map says how it fills', () => {
  assert.match(infraSummary({ ...input, nodes: [], unresolved: [] }), /Detection runs as files are saved/)
  assert.equal(infraSummary({ ...input, status: 'proposed', nodes: [input.nodes[0]], unresolved: [] }), 'No proposed infrastructure.')
})

test('contract gaps are offered to an agent that starts debugging', () => {
  assert.deepEqual(infraGaps(input), ['PostgreSQL topic booking.reminder: published, but nothing consumes it (src/jobs/sendReminders.ts)'])
  assert.deepEqual(infraGaps({ ...input, nodes: [] }), [], 'gaps on unknown or dismissed nodes are not mentioned')
})
