/**
 * Agent action classification.
 *
 * Every MCP tool call is logged from one wrapper around the dispatch switch,
 * so a tool added later is captured without anyone remembering to instrument
 * it. This module decides three things about a call:
 *
 *   kind    - how the canvas should react (a read is an attention signal, a
 *             trace animates a path, a write animates the map changing)
 *   targets - which canvas nodes it touched, so the right part lights up
 *   summary - one human line for what it was about, shown after the tool's
 *             name in the agent's steps ("Put 3 files in Payments")
 *   detail  - what it was asked and what came back, trimmed, so a step opens
 *             to them
 *
 * It is pure and has no imports, so it can be tested directly.
 */

export type ActionKind = 'read' | 'trace' | 'write' | 'plan' | 'debug' | 'narrate'

const TRACE_TOOLS = new Set([
  // trace_calls is the name agents actually call - the consolidated surface
  // advertises it, and the log records what the agent called rather than the
  // legacy name it routes to. Without it here, the most common tracing tool
  // in the product was filed as a plain read and lit the canvas as one.
  'trace_calls',
  'get_call_path', 'get_call_graph', 'get_call_graph_for_files', 'get_data_flow',
])

const WRITE_TOOLS = new Set([
  'create_system', 'update_system', 'delete_system', 'assign_files_to_system',
  'merge_systems', 'update_systems_bulk', 'edit_systems',
  'create_infra_node', 'update_infra_node', 'delete_infra_node', 'connect_infra',
  'record_infra_contents', 'record_infra_requirements', 'decide_infra',
  'edit_infra',
  'create_sheet', 'add_to_sheet', 'move_on_sheet', 'rename_on_sheet', 'annotate_sheet', 'connect_sheet', 'edit_sheet',
])

const PLAN_TOOLS = new Set([
  'plan_element', 'get_plan_status', 'get_build_spec', 'get_build_plan',
  'get_canvas_updates', 'await_canvas', 'reply_to_canvas', 'review-canvas',
  'start_review', 'get_inbox', 'claim_build_plan', 'propose_change',
])

const DEBUG_TOOLS = new Set([
  'watch_function', 'unwatch_function', 'inject_value', 'cancel_injection',
  'get_runtime_snapshot', 'launch_target', 'stop_target', 'get_target_log',
  'debug_runtime',
  'start_investigation', 'annotate_investigation', 'stop_investigation',
  'list_investigations', 'get_investigation', 'investigation',
])

const NARRATE_TOOLS = new Set(['start_work', 'note_work', 'finish_work', 'update_work'])

/** Reads are the default: a tool that does not declare otherwise only looks. */
export function actionKind(tool: string): ActionKind {
  if (TRACE_TOOLS.has(tool)) return 'trace'
  if (WRITE_TOOLS.has(tool)) return 'write'
  if (PLAN_TOOLS.has(tool)) return 'plan'
  if (DEBUG_TOOLS.has(tool)) return 'debug'
  if (NARRATE_TOOLS.has(tool)) return 'narrate'
  return 'read'
}

/** Argument keys that carry a canvas node identity, in priority order. */
const ID_KEYS = [
  // Consolidated surface: get_architecture and friends take a generic id/ids.
  // Missing these is why a read once lit nothing on the canvas.
  'id', 'ids',
  'fileId', 'fileIds', 'systemId', 'systemIds', 'nodeId', 'nodeIds',
  'infraId', 'targetId', 'sourceId', 'from', 'to', 'src', 'dst',
  'focusSystemIds', 'focusFileIds',
]

function pushIds(into: Set<string>, value: unknown): void {
  if (typeof value === 'string' && value) into.add(value)
  else if (Array.isArray(value)) for (const entry of value) pushIds(into, entry)
}

/**
 * Ids inside a call's lists of edits (edit_systems' updates, an add_chunk's
 * systems): today's tools take batches, so the ids are rarely at the top.
 */
function pushNestedIds(into: Set<string>, value: unknown, depth: number): void {
  if (depth > 3 || !value || typeof value !== 'object') return
  if (Array.isArray(value)) { for (const entry of value) pushNestedIds(into, entry, depth + 1); return }
  const record = value as Record<string, unknown>
  for (const key of ID_KEYS) if (key in record && depth > 0) pushIds(into, record[key])
  for (const entry of Object.values(record)) if (entry && typeof entry === 'object') pushNestedIds(into, entry, depth + 1)
}

/**
 * The canvas nodes an action touched.
 *
 * Arguments are the honest source: they are what the agent asked about. The
 * result is also mined for call-path hops, because the interesting part of a
 * trace is the path it found, not the two endpoints it was given.
 */
export function actionTargets(
  tool: string,
  args: Record<string, unknown>,
  result?: unknown,
): string[] {
  const targets = new Set<string>()
  for (const key of ID_KEYS) {
    if (key in args) pushIds(targets, args[key])
  }
  pushNestedIds(targets, args, 0)

  // A traced path is only worth animating if we know every hop it went through.
  const steps = (result as { steps?: unknown[] } | undefined)?.steps
  if (Array.isArray(steps)) {
    for (const step of steps) {
      const hop = step as Record<string, unknown>
      pushIds(targets, hop.callerFile)
      pushIds(targets, hop.calleeFile)
    }
  }
  const fileIds = (result as { fileIds?: unknown } | undefined)?.fileIds
  if (fileIds) pushIds(targets, fileIds)

  return [...targets]
}

function firstString(args: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value) return value
  }
  return ''
}

/** System (or other node) names by id, when the caller could look them up. */
export type ActionNames = ReadonlyMap<string, string>

/** The ids a summary may want to name, so the caller can look them up first. */
export function actionNameIds(args: Record<string, unknown>): string[] {
  return ['id', 'systemId', 'sourceSystemId', 'targetSystemId', 'parentId']
    .map(key => args[key]).filter((value): value is string => typeof value === 'string' && !!value)
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`
const listLength = (value: unknown) => (Array.isArray(value) ? value.length : 0)

/**
 * One line on what a call was about, said the way you would say it out loud;
 * the tool's own name is shown before it, so this does not repeat it. Says
 * nothing rather than inventing detail it does not have.
 */
export function actionSummary(tool: string, args: Record<string, unknown>, names: ActionNames = new Map()): string {
  const subject = firstString(args, ['name', 'goal', 'symbol', 'variable', 'query', 'text', 'summary'])
  const named = (id: unknown, fallback = '') => (typeof id === 'string' && (names.get(id) ?? '')) || fallback
  const op = firstString(args, ['op'])
  switch (tool) {
    case 'get_architecture': {
      const scope = firstString(args, ['scope']) || 'overview'
      const about = named(args.id) || (listLength(args.ids) ? plural(listLength(args.ids), 'item') : '')
      return about ? `${scope.replace(/_/g, ' ')} of ${about}` : scope.replace(/_/g, ' ')
    }
    case 'edit_systems': {
      const files = listLength(args.fileIds) + listLength(args.filePaths)
      switch (op) {
        case 'begin_session': return 'Started a map draft'
        case 'add_chunk': return `Drafted ${plural(listLength(args.systems), 'system')}`
        case 'commit_session': return 'Submitted the map'
        case 'abort_session': return 'Cleared the map draft'
        case 'session_status': return 'Checked the map draft'
        case 'propose': return `Proposed ${plural(listLength(args.systems), 'system')}`
        case 'create': return `Created ${subject || 'a system'}`
        case 'update': return `Updated ${named(args.systemId, subject || 'a system')}`
        case 'delete': return `Deleted ${named(args.systemId, 'a system')}`
        case 'assign': return `Put ${plural(files, 'file')} in ${named(args.systemId, subject || 'a system')}`
        case 'merge': return `Merged ${named(args.sourceSystemId, 'a system')} into ${named(args.targetSystemId, 'another')}`
        case 'bulk': return `Updated ${plural(listLength(args.updates), 'system')}`
      }
      return op.replace(/_/g, ' ')
    }
    case 'edit_infra': {
      const what = firstString(args, ['name', 'service', 'id'])
      switch (op) {
        case 'create': return `Added ${what || 'infrastructure'}`
        case 'update': return `Updated ${what || 'infrastructure'}`
        case 'delete': return `Removed ${what || 'infrastructure'}`
        case 'connect': return `Connected ${firstString(args, ['src']) || 'code'} to ${what || 'infrastructure'}`
        case 'contents': return `Recorded what ${what || 'it'} holds`
        case 'require': return `Recorded what ${what || 'it'} needs`
        case 'decide': return `Decided on ${what || 'infrastructure'}`
      }
      return [op, what].filter(Boolean).join(' ')
    }
    case 'edit_sheet': {
      const sheet = firstString(args, ['sheet']) || firstString(args, ['name'])
      const on = sheet ? ` on ${sheet}` : ''
      switch (op) {
        case 'list': return 'Listed sheets'
        case 'get': return `Read ${sheet || 'a sheet'}`
        case 'create': return `Created ${firstString(args, ['name']) || 'a sheet'}`
        case 'compare': return `Compared ${sheet || 'a sheet'} with the code`
        case 'annotate': return `Added a note${on}`
        case 'notes': return `Read notes${on}`
        case 'connect': return `Drew a connection${on}`
        case 'resolve': return `Resolved ${sheet || 'a sheet'}`
      }
      return `${op.replace(/_/g, ' ')}${on}`.trim()
    }
    case 'get_inbox': return args.watch ? 'Watched for requests' : args.messageHandle ? 'Read a request' : 'Checked for requests'
    case 'reply_to_canvas': return 'Replied in Message agent'
    case 'update_work': return firstString(args, ['note', 'summary', 'goal'])
    case 'trace_calls': return [firstString(args, ['from', 'symbol', 'name']), firstString(args, ['to'])].filter(Boolean).join(' → ')
    case 'get_symbols': return firstString(args, ['symbol']) || (listLength(args.fileIds) ? plural(listLength(args.fileIds), 'file') : firstString(args, ['file']))
    case 'investigation': return [op.replace(/_/g, ' '), subject].filter(Boolean).join(', ')
    case 'connect': return 'Connected to Ambio'
    case 'get_call_path':
      return `Traced ${firstString(args, ['from'])} → ${firstString(args, ['to'])}`
    case 'get_data_flow':
      return subject
    case 'search_symbols':
      return `"${subject}"`
    case 'create_system':
      return `Created system ${subject}`
    case 'update_system':
      return `Updated system ${subject || firstString(args, ['systemId'])}`
    case 'delete_system':
      return `Deleted a system`
    case 'merge_systems':
      return `Merged systems into ${subject}`
    case 'assign_files_to_system':
      return `Reassigned files to ${subject || firstString(args, ['systemId'])}`
    case 'update_systems_bulk':
      return `Bulk-updated systems`
    case 'plan_element':
      return `Planned ${subject}`
    case 'start_work':
      return subject
    case 'note_work':
    case 'finish_work':
      return subject
    case 'watch_function':
      return subject
    case 'inject_value':
      return `Injected a value into ${subject}`
    default:
      return subject
  }
}

/** Longest input or result kept with an action. */
const DETAIL_LIMIT = 4000

function trimmed(text: string): string {
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}\n…` : text
}

/**
 * What a call was asked and what came back (or its error), trimmed, as the
 * JSON kept in an action's detail.
 */
export function actionDetail(args: Record<string, unknown>, result: unknown, error?: string): string {
  const show = (value: unknown) => {
    if (value === undefined || value === null) return ''
    if (typeof value === 'string') return trimmed(value)
    try { return trimmed(JSON.stringify(value, null, 2)) } catch { return '' }
  }
  const input = Object.keys(args).length ? show(args) : ''
  const output = error ? trimmed(error) : show(result)
  return JSON.stringify({ ...(input ? { input } : {}), ...(output ? { output } : {}) })
}
