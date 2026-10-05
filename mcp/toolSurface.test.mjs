import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

/**
 * Guards the size of the advertised tool surface.
 *
 * The listing is paid for on every request an agent makes, so it is a budget,
 * not a detail. Ambio previously advertised 59 tools costing ~9,600 tokens
 * before the agent had read a line of code. These tests exist so that cost
 * cannot creep back without someone deciding to raise the limit on purpose.
 */

// Normalized on read: git checks this file out with CRLF on Windows, and a
// regex anchored to "\n" silently matches nothing rather than failing loudly.
const source = readFileSync(new URL('./ambio-mcp.ts', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n')

function sliceBetween(start, end) {
  const from = source.indexOf(start)
  const to = source.indexOf(end)
  assert.ok(from >= 0 && to > from, `could not locate ${start}`)
  return source.slice(from, to)
}

const coreBlock = sliceBetween('const CORE_TOOLS = [', 'const DEBUG_PROFILE_TOOLS = [')
const debugBlock = sliceBetween('const DEBUG_PROFILE_TOOLS = [', 'const DEBUG_PROFILE_ENABLED')

function toolNames(block) {
  return [...block.matchAll(/^    name: '([^']+)',$/gm)].map(m => m[1])
}

test('the advertised surface stays small', () => {
  const core = toolNames(coreBlock)
  assert.ok(core.length <= 15, `core surface grew to ${core.length}: ${core.join(', ')}`)
  // Only value injection stays opt-in. Recording an investigation is core:
  // gating it meant no agent could ever see it.
  assert.equal(toolNames(debugBlock).length, 1)
})

test('the schema cost stays within budget', () => {
  // ~3.6 chars per token. The pre-consolidation surface was ~9,600 tokens.
  // Raised from 3,200 when investigation experiments (run, verdict, conclude)
  // and addressed inbox routing (messageId) landed together, and to 3,500 for
  // infra contracts, requirements, implementations and decisions (edit_infra
  // gave up category, srcType and infraId to pay for most of it), and for
  // structured work-order results; each fit alone, and 3,650 held both. Raised
  // to 3,700 when edit_sheet gained connect (draw-first) beside remove,
  // restore, export and import; each fit alone. Each was already trimmed to its
  // minimum. Raise it again only for a new capability, never for wording.
  const coreTokens = Math.round(coreBlock.length / 3.6)
  assert.ok(coreTokens < 3700, `core tool schema is ~${coreTokens} tokens, budget is 3700`)
})

test('debug tooling is not advertised by default', () => {
  assert.match(source, /AMBIO_MCP_PROFILE/)
  assert.match(source, /DEBUG_PROFILE_ENABLED \? \[\.\.\.CORE_TOOLS, \.\.\.DEBUG_PROFILE_TOOLS\] : CORE_TOOLS/)
})

test('no legacy tool name leaks back into the listing', () => {
  // These were merged away. Re-advertising one means the merge was undone.
  const merged = [
    'get_systems_overview', 'get_system_files', 'get_neighbors', 'get_family',
    'get_node', 'get_raw_files', 'get_unclassified_files', 'get_systems_with_files',
    'get_cross_system_dependencies', 'get_infra_for_files', 'list_infra',
    'get_activity_hotspots', 'list_infra_services', 'get_architecture_changes',
    'create_system', 'update_system', 'delete_system', 'assign_files_to_system',
    'merge_systems', 'update_systems_bulk',
    'create_infra_node', 'update_infra_node', 'delete_infra_node', 'connect_infra',
    'list_sheets', 'get_sheet', 'create_sheet', 'add_to_sheet', 'annotate_sheet',
    'get_symbols_for_files', 'get_function_body',
    'get_call_graph', 'get_call_graph_for_files',
    'get_canvas_updates', 'await_canvas', 'get_build_spec', 'get_plan_status',
    'note_work', 'finish_work',
    'watch_function', 'inject_value', 'launch_target',
    'start_investigation', 'annotate_investigation',
  ]
  const advertised = new Set([...toolNames(coreBlock), ...toolNames(debugBlock)])
  for (const name of merged) {
    assert.equal(advertised.has(name), false, `"${name}" was merged away but is advertised again`)
  }
})

test('every legacy handler survives as an adapter', () => {
  // Consolidation must not remove capability. The handlers stay; only the
  // advertisement shrinks, so an existing agent config keeps working.
  const handlers = [...source.matchAll(/^      case '([^']+)':/gm)].map(m => m[1])
  assert.ok(handlers.length >= 55, `only ${handlers.length} handlers remain; capability was lost`)
  for (const name of ['create_system', 'get_neighbors', 'inject_value', 'note_work']) {
    assert.ok(handlers.includes(name), `legacy handler "${name}" was deleted rather than kept`)
  }
})

test('descriptions stay short enough to be worth their tokens', () => {
  // Tool-level descriptions only, at four-space indentation - the nested
  // descriptions on schema properties are not what dominates the listing.
  const descriptions = [...coreBlock.matchAll(/\n {4}description: (['"])(.*?)\1,\n/gs)]
    .map(m => m[2])
  assert.ok(descriptions.length >= 10, `expected one per core tool, found ${descriptions.length}`)
  const longest = Math.max(...descriptions.map(d => d.length))
  // edit_systems is deliberately the longest: agents keeping the map true is
  // the product, so that tool reads as a first-class instruction rather than
  // a label. Everything else earns its length.
  assert.ok(longest < 460, `longest description is ${longest} chars; keep them tight`)
})

test('docs/MCP_SURFACE.md lists the real core tools and their ops', () => {
  const doc = readFileSync(new URL('../docs/MCP_SURFACE.md', import.meta.url), 'utf8').replace(/\r\n/g, '\n')
  const table = doc.slice(doc.indexOf('## Core profile'), doc.indexOf('## Debug profile'))
  const rows = new Map([...table.matchAll(/^\| `([a-z_]+)` \| (.*) \|$/gm)].map(m => [m[1], m[2]]))
  const core = toolNames(coreBlock)
  assert.deepEqual([...rows.keys()].sort(), [...core].sort(), 'the Core table and CORE_TOOLS disagree')
  assert.match(table, new RegExp(`## Core profile - ${core.length} tools`))
  for (const name of core) {
    const start = coreBlock.indexOf(`    name: '${name}',`)
    const next = coreBlock.indexOf("\n    name: '", start + 1)
    const block = coreBlock.slice(start, next < 0 ? undefined : next)
    const ops = block.match(/op: \{ type: 'string', enum: \[([^\]]*)\]/)
    if (!ops) continue
    const real = [...ops[1].matchAll(/'([^']+)'/g)].map(m => m[1]).sort()
    const documented = rows.get(name).split(/,\s*/).map(op => op.replace(/ - .*$/, '').trim()).sort()
    assert.deepEqual(documented, real, `${name}: documented ops differ from the schema`)
  }
})
