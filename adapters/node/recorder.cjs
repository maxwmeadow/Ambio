'use strict'
// Run recorder - the evidence side of `investigation run`.
//
// Streaming every call over TCP (runtime.cjs) suits a long-lived server you are
// watching live. It fails a debugging *run*: a repro script calls a function
// 48 times in 10ms, trips the per-watch rate limiter, and exits before queued
// events flush. Watches that arrive over the socket after connect can also miss
// a short script entirely.
//
// So a run aggregates in-process instead. archd passes the watches in through
// the environment (active before the first line of user code), and the
// recorder writes one JSON file per process at exit. `npm run x` starts npm and
// then node, both with the adapter preloaded; each writes its own file (only if
// it executed workspace code), and archd merges them.
//
// For EVERY instrumented function: call count, errors, time, and the
// caller -> callee edges actually taken - what really ran, for the map.
// For WATCHED functions: bounded call samples, numeric trends per value path
// across calls, argument mutations (the side effects reading code hides), and
// exceptions.

const fs = require('fs')
const path = require('path')

const SAMPLE_HEAD = 6
const SAMPLE_TAIL = 4
const MAX_EDGES = 5000
const MAX_FUNCTIONS = 20000
const FLATTEN_DEPTH = 4
const FLATTEN_LEAVES = 160
const SERIES_KEEP = 12
const DISTINCT_KEEP = 24
const PREVIEW_MAX = 240
const MUTATION_EXAMPLES = 6
const MAX_EXCEPTIONS = 20

// Canonical path for matching watches to running code. Node reports resolved
// real paths; archd sends paths as the user registered them, which may go
// through a symlink (macOS /tmp -> /private/tmp, a linked home directory).
const realCache = new Map()
function normFile(p) {
  if (!p) return ''
  let real = realCache.get(p)
  if (real === undefined) {
    try { real = fs.realpathSync.native(p) } catch { real = p }
    realCache.set(p, real)
  }
  let out = real.replace(/\\/g, '/')
  if (process.platform === 'win32') out = out.toLowerCase()
  return out
}

// ─── value flattening ────────────────────────────────────────────────────────
// A watched value becomes a flat map of path -> primitive, bounded in depth and
// leaf count. Flat paths are what make trends and mutations comparable across
// calls ("surcharges.peak" is the same slot on call 1 and call 30).

function leaf(v) {
  if (v === null) return { k: 'null', v: null }
  const t = typeof v
  if (t === 'undefined') return { k: 'undefined', v: undefined }
  if (t === 'number') return { k: Number.isFinite(v) ? 'number' : 'special', v: Number.isFinite(v) ? v : String(v) }
  if (t === 'boolean') return { k: 'boolean', v }
  if (t === 'string') return { k: 'string', v: v.length > 120 ? v.slice(0, 119) + '…' : v }
  if (t === 'bigint') return { k: 'bigint', v: String(v) }
  if (t === 'symbol') return { k: 'symbol', v: String(v) }
  if (t === 'function') return { k: 'function', v: `[Function ${v.name || 'anonymous'}]` }
  return null
}

// Display text for a value that is a leaf in flattened form, or null for a
// container. Used to snapshot an object's own fields for drift detection.
function leafText(v) {
  const l = leaf(v)
  if (l) return display(l)
  if (v instanceof RegExp) return String(v).slice(0, 120)
  if (v instanceof Date) return isNaN(v) ? 'Invalid Date' : v.toISOString()
  return null
}

const MAX_NODES = 60
const NODE_DEPTH = 5
const NODE_FIELDS = 48

function flatten(root, prefix, maxDepth = FLATTEN_DEPTH, maxLeaves = FLATTEN_LEAVES) {
  const out = new Map()
  const seen = new WeakSet()
  const walk = (v, p, depth) => {
    if (out.size >= maxLeaves) return
    const l = leaf(v)
    if (l) { out.set(p, l); return }
    if (seen.has(v)) { out.set(p, { k: 'ref', v: '<circular>' }); return }
    if (v instanceof RegExp) { out.set(p, { k: 'regexp', v: String(v).slice(0, 120) }); return }
    if (v instanceof Date) { out.set(p, { k: 'date', v: isNaN(v) ? 'Invalid Date' : v.toISOString() }); return }
    if (v instanceof Error) { out.set(p, { k: 'error', v: `${v.name}: ${v.message}` }); return }
    if (typeof Promise !== 'undefined' && v instanceof Promise) { out.set(p, { k: 'promise', v: '[Promise]' }); return }
    if (depth >= maxDepth) {
      out.set(p, { k: 'object', v: Array.isArray(v) ? `[Array(${v.length})]` : `<${ctorName(v)}>` })
      return
    }
    seen.add(v)
    try {
      if (Array.isArray(v)) {
        out.set(p + '.length', { k: 'number', v: v.length })
        for (let i = 0; i < v.length && i < 8; i++) walk(v[i], `${p}[${i}]`, depth + 1)
        return
      }
      if (v instanceof Map) {
        out.set(p + '.size', { k: 'number', v: v.size })
        let i = 0
        for (const [k, val] of v) {
          if (i++ >= 8) break
          walk(val, `${p}.get(${String(k).slice(0, 40)})`, depth + 1)
        }
        return
      }
      if (v instanceof Set) { out.set(p + '.size', { k: 'number', v: v.size }); return }
      let keys
      try { keys = Object.keys(v) } catch { keys = [] }
      if (keys.length === 0) { out.set(p, { k: 'object', v: '{}' }); return }
      for (const k of keys.slice(0, 24)) {
        let child
        try { child = v[k] } catch { child = '<getter threw>' }
        walk(child, p ? `${p}.${k}` : k, depth + 1)
      }
    } finally {
      seen.delete(v)
    }
  }
  try { walk(root, prefix, 0) } catch { /* never break the target */ }
  return out
}

// Objects reachable from a value, each with a snapshot of its own leaf fields.
// A separate walk from flatten() with its own budget: flatten stops after 160
// values, often inside the first large sub-object, while shared state tends to
// sit a few objects down (options.tokenizer.rules.inline).
function collectNodes(root, prefix, nodes) {
  const seen = new WeakSet()
  const walk = (v, p, depth) => {
    if (nodes.length >= MAX_NODES || v === null || typeof v !== 'object' || depth > NODE_DEPTH) return
    if (seen.has(v) || v instanceof RegExp || v instanceof Date || v instanceof Promise || ArrayBuffer.isView(v)) return
    seen.add(v)
    const fields = new Map()
    const children = []
    try {
      if (Array.isArray(v)) {
        fields.set('length', String(v.length))
        for (let i = 0; i < v.length && i < 8; i++) children.push([`${p}[${i}]`, v[i]])
      } else if (v instanceof Map || v instanceof Set) {
        fields.set('size', String(v.size))
      } else {
        const keys = Object.keys(v)
        for (let i = 0; i < keys.length && i < NODE_FIELDS; i++) {
          let child
          try { child = v[keys[i]] } catch { continue }
          const t = leafText(child)
          if (t !== null) fields.set(keys[i], t)
          else if (child && typeof child === 'object') children.push([`${p}.${keys[i]}`, child])
        }
      }
    } catch { return }
    if (fields.size) nodes.push({ obj: v, path: p, fields })
    for (const [cp, c] of children) walk(c, cp, depth + 1)
  }
  try { walk(root, prefix, 0) } catch { /* never break the target */ }
}

function ctorName(v) {
  try { return (v && v.constructor && v.constructor.name) || 'Object' } catch { return 'Object' }
}

function preview(v) {
  if (v === undefined) return 'undefined'
  let s
  try {
    const seen = new WeakSet()
    s = JSON.stringify(v, (k, val) => {
      if (typeof val === 'bigint') return String(val)
      if (typeof val === 'function') return `[Function ${val.name || 'anonymous'}]`
      if (val === undefined) return '<undefined>'
      if (val && typeof val === 'object') {
        if (seen.has(val)) return '<circular>'
        seen.add(val)
        if (val instanceof Map) return Object.fromEntries([...val.entries()].slice(0, 8))
        if (val instanceof Set) return [...val].slice(0, 8)
      }
      return val
    })
  } catch {
    s = String(v)
  }
  if (s === undefined) s = String(v)
  return s.length > PREVIEW_MAX ? s.slice(0, PREVIEW_MAX - 1) + '…' : s
}

// What kind of outcome a call had, coarsely: undefined, null, a number, a
// string, or an object with a particular set of keys.
function outcomeShape(returned) {
  if (returned === undefined || returned === 'undefined') return 'undefined'
  const c = returned.charAt(0)
  if (c === '{') {
    const keys = returned.match(/"([^"]+)":/g)
    return 'object:' + (keys ? keys.slice(0, 4).join('') : '')
  }
  if (c === '[') return 'array'
  if (c === '"') return 'string'
  if (returned === 'null') return 'null'
  if (returned === 'true' || returned === 'false') return 'boolean:' + returned
  if (!isNaN(Number(returned))) return 'number'
  return 'other'
}

function display(l) {
  if (!l) return '(absent)'
  if (l.k === 'string') return JSON.stringify(l.v)
  if (l.k === 'undefined') return 'undefined'
  return String(l.v)
}

// ─── per-path statistics ─────────────────────────────────────────────────────

class PathStats {
  constructor() {
    this.count = 0
    this.kind = null
    this.first = undefined
    this.last = undefined
    this.min = Infinity
    this.max = -Infinity
    this.nonDecreasing = true
    this.nonIncreasing = true
    this.changes = 0
    this.series = []      // first SERIES_KEEP observations
    this.tail = []        // last 3 observations
    this.distinct = new Map() // display -> count, capped
    this.distinctOverflow = false
  }

  add(l) {
    this.count++
    const d = display(l)
    if (this.kind === null) this.kind = l ? l.k : 'absent'
    else if (l && this.kind !== l.k && this.kind !== 'mixed') this.kind = 'mixed'
    if (this.count > 1 && d !== this.last) this.changes++
    if (l && l.k === 'number' && typeof l.v === 'number') {
      if (this.count > 1 && typeof this.lastNum === 'number') {
        if (l.v < this.lastNum) this.nonDecreasing = false
        if (l.v > this.lastNum) this.nonIncreasing = false
      }
      this.lastNum = l.v
      if (l.v < this.min) this.min = l.v
      if (l.v > this.max) this.max = l.v
    }
    if (this.first === undefined) this.first = d
    this.last = d
    if (this.series.length < SERIES_KEEP) this.series.push(d)
    this.tail.push(d)
    if (this.tail.length > 3) this.tail.shift()
    if (this.distinct.has(d)) this.distinct.set(d, this.distinct.get(d) + 1)
    else if (this.distinct.size < DISTINCT_KEEP) this.distinct.set(d, 1)
    else this.distinctOverflow = true
  }

  toJSON() {
    const numeric = this.kind === 'number'
    return {
      kind: this.kind,
      count: this.count,
      changes: this.changes,
      distinct: this.distinctOverflow ? `${DISTINCT_KEEP}+` : this.distinct.size,
      first: this.first,
      last: this.last,
      min: numeric ? this.min : undefined,
      max: numeric ? this.max : undefined,
      trend: numeric && this.changes > 0
        ? (this.nonDecreasing ? 'increasing' : this.nonIncreasing ? 'decreasing' : 'varying')
        : this.changes > 0 ? 'varying' : 'constant',
      series: this.series,
      tail: this.count > SERIES_KEEP ? this.tail : undefined,
      top: this.distinct.size <= 8 && !this.distinctOverflow
        ? [...this.distinct.entries()].sort((a, b) => b[1] - a[1]).map(([value, n]) => ({ value, n }))
        : undefined,
    }
  }
}

// ─── watched function record ─────────────────────────────────────────────────

class WatchRecord {
  constructor(spec) {
    this.spec = spec
    this.calls = 0
    this.errors = 0
    this.totalMs = 0
    this.head = []
    this.tail = []
    this.novel = []
    this.shapes = new Set()
    this.paths = new Map()      // 'arg.x.y' | 'return.y' -> PathStats
    this.mutations = new Map()  // 'x.y' -> {calls, examples:[{call,before,after}]}
    this.exceptions = new Map() // 'Type: message' -> count
    // The whole return value, as text. Per-path stats cannot answer "what
    // does it return": an object's own path only exists when it is empty.
    this.returns = new PathStats()
    // Object identity across calls: the same object arriving again means
    // state is shared between calls - with a mutation, that is the bug.
    this.seenObjects = new WeakMap() // object -> first call number
    this.shared = new Map()          // param -> {calls, firstCall}
    // Repeats: a call with exactly the previous call's arguments usually means
    // the same work ran twice (a double subscription, a retry, a re-render).
    this.prevArgs = null
    this.prevSelf = undefined
    this.paramNames = []
    this.repeats = 0
    this.repeatExample = null
    // Detailed recording is sampled once a function gets hot (see sampled()).
    this.sampledCalls = 0
    // Drift: an object reached from this function's arguments on one call is
    // the same object on a later call, and its contents differ. That is state
    // shared between calls - module-level tables, caches, singletons - which
    // argument mutation alone cannot see.
    this.objects = new WeakMap() // object -> { path, call, fields }
    this.drift = new Map()       // path -> { calls, first, examples }
  }

  // Runs on EVERY call of a watched function, so it only compares identities:
  // no copying, no formatting. Shared objects and repeats stay exact even
  // when the detailed recording is sampled.
  observeArgs(call, argsArr, self) {
    for (let i = 0; i < argsArr.length; i++) {
      const v = argsArr[i]
      if (v === null || (typeof v !== 'object' && typeof v !== 'function')) continue
      const first = this.seenObjects.get(v)
      if (first === undefined) {
        this.seenObjects.set(v, call)
      } else {
        const name = this.paramNames[i] || `arg${i}`
        const st = this.shared.get(name) || { calls: 0, firstCall: first }
        st.calls++
        this.shared.set(name, st)
      }
    }
    // A repeat is the same arguments (identical objects, equal primitives) on
    // the same receiver as the call just before it.
    const prev = this.prevArgs
    let same = prev !== null && prev.length === argsArr.length && argsArr.length > 0 && self === this.prevSelf
    for (let i = 0; same && i < argsArr.length; i++) {
      if (!Object.is(argsArr[i], prev[i])) same = false
    }
    if (same) {
      this.repeats++
      if (!this.repeatExample) {
        const args = {}
        for (let i = 0; i < argsArr.length; i++) args[this.paramNames[i] || `arg${i}`] = argsArr[i]
        this.repeatExample = { call, args: preview(args) }
      }
    }
    this.prevArgs = argsArr
    this.prevSelf = self
  }

  checkDrift(nodes, call) {
    for (const n of nodes) {
      const root = n.path.split(/[.[]/)[0]
      // The receiver and its direct fields are the object's own state; they
      // are expected to change between method calls.
      if ((root === 'this') && n.path.split('.').length <= 2) continue
      const prev = this.objects.get(n.obj)
      if (prev && prev.call !== call) {
        const changes = []
        const keys = new Set([...prev.fields.keys(), ...n.fields.keys()])
        for (const k of keys) {
          const a = prev.fields.has(k) ? prev.fields.get(k) : '(absent)'
          const b = n.fields.has(k) ? n.fields.get(k) : '(absent)'
          if (a !== b) changes.push({ key: k, before: a, after: b })
        }
        if (changes.length) {
          let d = this.drift.get(n.path)
          if (!d) {
            if (this.drift.size >= 20) { this.objects.set(n.obj, { path: n.path, call, fields: n.fields }); continue }
            d = { calls: 0, examples: [] }
            this.drift.set(n.path, d)
          }
          d.calls++
          if (d.examples.length < 4) d.examples.push({ fromCall: prev.call, toCall: call, changes: changes.slice(0, 4) })
        }
      }
      this.objects.set(n.obj, { path: n.path, call, fields: n.fields })
    }
  }

  observe(p, l) {
    let st = this.paths.get(p)
    if (!st) {
      if (this.paths.size >= 400) return
      st = new PathStats()
      this.paths.set(p, st)
    }
    st.add(l)
  }

  sample(s) {
    // Keep the first example of each kind of outcome, wherever it happens: a
    // tokenizer that returns undefined for 700,000 calls and a token for the
    // rest is only understood from the token-returning calls.
    const shape = s.threw ? 'threw:' + s.threw.split(':')[0] : outcomeShape(s.returned)
    const known = this.shapes.has(shape)
    if (!known && this.shapes.size < 8) this.shapes.add(shape)
    if (this.head.length < SAMPLE_HEAD) { this.head.push(s); return }
    if (!known && this.novel.length < 6) { this.novel.push(s); return }
    this.tail.push(s)
    if (this.tail.length > SAMPLE_TAIL) this.tail.shift()
  }

  toJSON() {
    return {
      file: this.spec.file,
      symbol: this.spec.symbol,
      line: this.spec.line,
      calls: this.calls,
      errors: this.errors,
      avgMs: this.calls ? +(this.totalMs / this.calls).toFixed(3) : 0,
      samples: this.head.concat(this.novel, this.tail).sort((a, b) => a.call - b.call),
      values: Object.fromEntries([...this.paths].map(([k, v]) => [k, v.toJSON()])),
      mutations: [...this.mutations].map(([p, m]) => ({ path: p, calls: m.calls, examples: m.examples })),
      exceptions: [...this.exceptions].map(([what, n]) => ({ what, n })),
      returns: this.returns.toJSON(),
      shared: [...this.shared].map(([param, st]) => ({ param, calls: st.calls, firstCall: st.firstCall })),
      repeats: this.repeats,
      repeatExample: this.repeatExample || undefined,
      sampled: this.sampledCalls,
      drift: [...this.drift].map(([path, d]) => ({ path, calls: d.calls, examples: d.examples })),
    }
  }
}

// ─── the recorder ────────────────────────────────────────────────────────────

// Detailed recording per watched function: every call up to FULL_CALLS, then
// every 2nd, 4th, 8th... - roughly FULL_CALLS samples per doubling. A repro
// that calls a function 730,000 times would otherwise spend minutes copying
// arguments; this keeps a few hundred samples spread across the whole run.
const FULL_CALLS = 100
// The receiver is often a large object (a lexer with its whole token list).
const RECEIVER_DEPTH = 2
const RECEIVER_LEAVES = 60

class FnRec {
  constructor(file, name, line) {
    this.file = file
    this.name = name
    this.line = line
    this.calls = 0
    this.errors = 0
    this.callees = null // Map<FnRec, count>
    this.watch = undefined // WatchRecord | null, resolved on first call
  }
}

class Recorder {
  constructor(opts) {
    this.dir = opts.dir
    this.runId = opts.runId || ''
    this.startedAt = Date.now()
    this.byFile = new Map() // file -> Map<line, FnRec[]>
    this.fnCount = 0
    this.edgeCount = 0
    this.edgesDropped = 0
    this.stack = []
    this.watchSpecs = new Map()
    this.watched = []
    this.uncaught = []
    this._lastWritten = -1
    for (const w of opts.watches || []) {
      const file = normFile(w.absPath || w.file || '')
      if (!file) continue
      const list = this.watchSpecs.get(file) || []
      list.push({ symbol: w.symbol || '*', lineStart: w.lineStart | 0, lineEnd: w.lineEnd | 0 })
      this.watchSpecs.set(file, list)
    }
  }

  // No allocation on the hot path once a function has been seen.
  _fn(file, name, line) {
    let lines = this.byFile.get(file)
    if (lines === undefined) {
      lines = new Map()
      this.byFile.set(file, lines)
    }
    let list = lines.get(line)
    if (list !== undefined) {
      for (let i = 0; i < list.length; i++) if (list[i].name === name) return list[i]
    } else {
      list = []
      lines.set(line, list)
    }
    if (this.fnCount >= MAX_FUNCTIONS) return null
    const f = new FnRec(file, name, line)
    list.push(f)
    this.fnCount++
    return f
  }

  _watchFor(f) {
    const specs = this.watchSpecs.get(normFile(f.file))
    if (!specs) return null
    let hit = null
    for (const s of specs) {
      if (s.symbol === '*') { hit = s; break }
      if (s.symbol !== f.name) continue
      if (!s.lineStart || (s.lineStart <= f.line && f.line <= Math.max(s.lineEnd, s.lineStart))) { hit = s; break }
    }
    if (!hit) {
      const named = specs.filter(s => s.symbol === f.name)
      if (named.length === 1) hit = named[0]
    }
    if (!hit) return null
    const rec = new WatchRecord({ file: f.file, symbol: f.name, line: f.line })
    this.watched.push(rec)
    return rec
  }

  enter(file, name, line, argsArr, paramNames, self) {
    const f = this._fn(file, name, line)
    if (f === null) return null
    f.calls++
    const top = this.stack.length ? this.stack[this.stack.length - 1] : null
    const caller = top === null ? null : (top instanceof FnRec ? top : top.f)
    if (caller !== null && caller !== f) {
      let m = caller.callees
      if (m === null) m = caller.callees = new Map()
      const n = m.get(f)
      if (n !== undefined) m.set(f, n + 1)
      else if (this.edgeCount < MAX_EDGES) { m.set(f, 1); this.edgeCount++ }
      else this.edgesDropped++
    }
    let w = f.watch
    if (w === undefined) w = f.watch = this._watchFor(f)
    if (w === null) {
      // Unwatched: the function record itself is the frame.
      this.stack.push(f)
      return f
    }

    w.calls++
    if (w.paramNames.length === 0 && paramNames.length) w.paramNames = paramNames
    const receiver = self !== null && typeof self === 'object' && self !== globalThis ? self : undefined
    w.observeArgs(w.calls, argsArr, receiver)

    const sampled = w.calls <= FULL_CALLS || (w.calls & (sampleStride(w.calls) - 1)) === 0
    const frame = { isRec: true, f, w: null, t0: 0, watchOnly: null }
    if (sampled) {
      w.sampledCalls++
      frame.t0 = process.hrtime.bigint()
      const before = new Map()
      const args = {}
      const nodes = []
      for (let i = 0; i < paramNames.length; i++) {
        args[paramNames[i]] = argsArr[i]
        for (const [p, l] of flatten(argsArr[i], paramNames[i])) {
          before.set(p, l)
          w.observe('arg.' + p, l)
        }
        collectNodes(argsArr[i], paramNames[i], nodes)
      }
      if (receiver) {
        for (const [p, l] of flatten(receiver, 'this', RECEIVER_DEPTH, RECEIVER_LEAVES)) {
          before.set(p, l)
          w.observe('arg.' + p, l)
        }
        // Walked deeper for drift than for display: shared state usually
        // hangs a few objects below `this`.
        collectNodes(receiver, 'this', nodes)
      }
      w.checkDrift(nodes, w.calls)
      frame.w = {
        rec: w,
        argsArr: receiver ? argsArr.concat([receiver]) : argsArr,
        paramNames: receiver ? paramNames.concat(['this']) : paramNames,
        receiverAt: receiver ? paramNames.length : -1,
        before,
        call: w.calls,
        args: preview(args),
      }
    } else {
      frame.watchOnly = w // counts and exceptions only
    }
    this.stack.push(frame)
    return frame
  }

  ret(frame, value) {
    if (frame === null || frame instanceof FnRec) return
    if (frame.w && !frame.w.returned) {
      frame.w.returned = true
      frame.w.returnPreview = preview(value)
      const whole = frame.w.returnPreview.length > 80 ? frame.w.returnPreview.slice(0, 79) + '…' : frame.w.returnPreview
      frame.w.rec.returns.add(typeof value === 'number' ? { k: 'number', v: value } : { k: 'text', v: whole })
      for (const [p, l] of flatten(value, 'return')) frame.w.rec.observe(p, l)
      // A returned object that is the same object on a later call, with
      // different contents, is a cache handing out shared state that someone
      // else changed - the aliasing bug behind "it only happens sometimes".
      if (value !== null && typeof value === 'object') {
        const nodes = []
        collectNodes(value, 'return', nodes)
        frame.w.rec.checkDrift(nodes, frame.w.call)
      }
    }
  }

  error(frame, err) {
    if (frame === null) return
    if (frame instanceof FnRec) { frame.errors++; return }
    frame.f.errors++
    const w = frame.w ? frame.w.rec : frame.watchOnly
    if (!w) return
    w.errors++
    const what = `${(err && err.name) || 'Error'}: ${String(err && err.message != null ? err.message : err).slice(0, 200)}`
    if (frame.w) frame.w.threw = what
    if (w.exceptions.size < MAX_EXCEPTIONS || w.exceptions.has(what)) w.exceptions.set(what, (w.exceptions.get(what) || 0) + 1)
  }

  exit(frame) {
    if (frame === null) return
    const stack = this.stack
    if (stack[stack.length - 1] === frame) stack.pop()
    else {
      // Async functions finish out of order; remove this frame wherever it is.
      const i = stack.lastIndexOf(frame)
      if (i >= 0) stack.splice(i, 1)
    }
    if (frame instanceof FnRec || !frame.w) return
    const w = frame.w
    // A function that ends without a return statement returns undefined, and
    // the instrumentation only calls ret() for explicit returns.
    if (!w.returned && !w.threw) this.ret(frame, undefined)
    const ms = Number(process.hrtime.bigint() - frame.t0) / 1e6
    w.rec.totalMs += ms
    // Mutations: re-flatten the arguments now and diff against entry. The
    // exit walk also feeds drift detection: an object this call changed is
    // remembered in its new state.
    const changed = []
    const nodes = []
    for (let i = 0; i < w.paramNames.length; i++) {
      const name = w.paramNames[i]
      const after = i === w.receiverAt
        ? flatten(w.argsArr[i], name, RECEIVER_DEPTH, RECEIVER_LEAVES)
        : flatten(w.argsArr[i], name)
      collectNodes(w.argsArr[i], name, nodes)
      const keys = new Set()
      for (const k of w.before.keys()) if (k === name || k.startsWith(name + '.') || k.startsWith(name + '[')) keys.add(k)
      for (const k of after.keys()) keys.add(k)
      for (const k of keys) {
        const b = display(w.before.get(k))
        const a = display(after.get(k))
        if (a !== b) changed.push({ path: k, before: b, after: a })
      }
    }
    // `{}` gaining its first key reads as two changes: the empty-object leaf
    // disappearing and the new child appearing. Only the child is real.
    w.rec.checkDrift(nodes, w.call)
    const real = changed.filter(c => !(
      (c.before === '{}' || c.before === '(absent)' || c.after === '{}' || c.after === '(absent)') &&
      changed.some(o => o !== c && (o.path.startsWith(c.path + '.') || o.path.startsWith(c.path + '[')))
    ))
    for (const c of real.slice(0, 20)) {
      let m = w.rec.mutations.get(c.path)
      if (!m) {
        if (w.rec.mutations.size >= 40) continue
        m = { calls: 0, examples: [] }
        w.rec.mutations.set(c.path, m)
      }
      m.calls++
      if (m.examples.length < MUTATION_EXAMPLES) m.examples.push({ call: w.call, before: c.before, after: c.after })
    }
    w.rec.sample({
      call: w.call,
      args: w.args,
      returned: w.threw ? undefined : (w.returnPreview !== undefined ? w.returnPreview : 'undefined'),
      threw: w.threw,
      mutated: real.length ? real.slice(0, 4).map(c => `${c.path}: ${c.before} → ${c.after}`) : undefined,
      ms: +ms.toFixed(3),
    })
  }

  _totalCalls() {
    let n = 0
    for (const lines of this.byFile.values()) for (const list of lines.values()) for (const f of list) n += f.calls
    return n
  }

  uncaughtException(err) {
    if (this.uncaught.length >= 5) return
    this.uncaught.push({
      what: `${(err && err.name) || 'Error'}: ${String(err && err.message != null ? err.message : err).slice(0, 300)}`,
      stack: String((err && err.stack) || '').split('\n').slice(0, 12).join('\n'),
    })
  }

  write() {
    if (!this.dir) return
    const dirty = this._totalCalls() + this.uncaught.length
    if (dirty === this._lastWritten) return
    this._lastWritten = dirty
    // Processes that ran no workspace code (npm itself, a shell shim) have
    // nothing to say; writing them would only add empty files to merge.
    if (this.fnCount === 0 && this.uncaught.length === 0) return
    const functions = []
    const edges = []
    for (const lines of this.byFile.values()) {
      for (const list of lines.values()) {
        for (const f of list) {
          functions.push({ file: f.file, name: f.name, line: f.line, calls: f.calls, errors: f.errors, ms: 0 })
          if (f.callees === null) continue
          for (const [to, n] of f.callees) {
            edges.push({
              from: { file: f.file, name: f.name, line: f.line },
              to: { file: to.file, name: to.name, line: to.line },
              calls: n,
            })
          }
        }
      }
    }
    const doc = {
      version: 1,
      runId: this.runId,
      pid: process.pid,
      argv: process.argv.slice(1, 4).map(a => path.basename(String(a))),
      startedAt: this.startedAt,
      endedAt: Date.now(),
      functions,
      edges,
      edgesDropped: this.edgesDropped,
      watched: this.watched.map(w => w.toJSON()),
      uncaught: this.uncaught,
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      const target = path.join(this.dir, `${process.pid}.json`)
      fs.writeFileSync(target + '.tmp', JSON.stringify(doc))
      fs.renameSync(target + '.tmp', target)
    } catch (_) {
      // Nowhere to report to. The run still completes; archd notices the gap.
    }
  }
}

// Marks recorder frames, so the runtime can tell them from live-watch contexts.
FnRec.prototype.isRec = true

// Power-of-two stride that doubles each time the call count doubles past
// FULL_CALLS: calls 101-200 record every 2nd, 201-400 every 4th, and so on.
function sampleStride(calls) {
  let stride = 1
  let limit = FULL_CALLS
  while (calls > limit) { stride *= 2; limit *= 2 }
  return stride
}

/** Build a recorder from the environment, or null when this is not a run. */
function fromEnv() {
  const dir = process.env.AXIOM_EVIDENCE_DIR
  if (!dir) return null
  let watches = []
  try { watches = JSON.parse(process.env.AXIOM_WATCHES || '[]') } catch (_) { watches = [] }
  const rec = new Recorder({ dir, runId: process.env.AXIOM_RUN_ID, watches })
  process.on('uncaughtExceptionMonitor', err => rec.uncaughtException(err))
  process.on('exit', () => rec.write())
  // A signal (a run that hit its timeout, a server stopped by archd) skips
  // 'exit'. Installing signal handlers would override the app's own shutdown,
  // so flush periodically instead: a killed process leaves evidence at most a
  // second stale. The timer never keeps the process alive.
  const timer = setInterval(() => rec.write(), 1000)
  if (timer.unref) timer.unref()
  return rec
}

module.exports = { Recorder, fromEnv, flatten, PathStats }
