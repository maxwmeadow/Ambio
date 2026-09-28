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

function normFile(p) {
  if (!p) return ''
  let out = p.replace(/\\/g, '/')
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

function flatten(root, prefix) {
  const out = new Map()
  const seen = new WeakSet()
  const walk = (v, p, depth) => {
    if (out.size >= FLATTEN_LEAVES) return
    const l = leaf(v)
    if (l) { out.set(p, l); return }
    if (seen.has(v)) { out.set(p, { k: 'ref', v: '<circular>' }); return }
    if (v instanceof Date) { out.set(p, { k: 'date', v: isNaN(v) ? 'Invalid Date' : v.toISOString() }); return }
    if (v instanceof Error) { out.set(p, { k: 'error', v: `${v.name}: ${v.message}` }); return }
    if (typeof Promise !== 'undefined' && v instanceof Promise) { out.set(p, { k: 'promise', v: '[Promise]' }); return }
    if (depth >= FLATTEN_DEPTH) {
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
    this.lastArgs = null
    this.repeats = 0
    this.repeatExample = null
  }

  observeArgs(call, paramNames, argsArr, fingerprint, argsPreview) {
    for (let i = 0; i < paramNames.length; i++) {
      const v = argsArr[i]
      if (v === null || (typeof v !== 'object' && typeof v !== 'function')) continue
      const first = this.seenObjects.get(v)
      if (first === undefined) {
        this.seenObjects.set(v, call)
      } else {
        const st = this.shared.get(paramNames[i]) || { calls: 0, firstCall: first }
        st.calls++
        this.shared.set(paramNames[i], st)
      }
    }
    if (this.lastArgs !== null && fingerprint === this.lastArgs && paramNames.length > 0) {
      this.repeats++
      if (!this.repeatExample) this.repeatExample = { call, args: argsPreview }
    }
    this.lastArgs = fingerprint
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
    if (this.head.length < SAMPLE_HEAD) this.head.push(s)
    else {
      this.tail.push(s)
      if (this.tail.length > SAMPLE_TAIL) this.tail.shift()
    }
  }

  toJSON() {
    return {
      file: this.spec.file,
      symbol: this.spec.symbol,
      line: this.spec.line,
      calls: this.calls,
      errors: this.errors,
      avgMs: this.calls ? +(this.totalMs / this.calls).toFixed(3) : 0,
      samples: this.head.concat(this.tail),
      values: Object.fromEntries([...this.paths].map(([k, v]) => [k, v.toJSON()])),
      mutations: [...this.mutations].map(([p, m]) => ({ path: p, calls: m.calls, examples: m.examples })),
      exceptions: [...this.exceptions].map(([what, n]) => ({ what, n })),
      returns: this.returns.toJSON(),
      shared: [...this.shared].map(([param, st]) => ({ param, calls: st.calls, firstCall: st.firstCall })),
      repeats: this.repeats,
      repeatExample: this.repeatExample || undefined,
    }
  }
}

// ─── the recorder ────────────────────────────────────────────────────────────

class Recorder {
  constructor(opts) {
    this.dir = opts.dir
    this.runId = opts.runId || ''
    this.startedAt = Date.now()
    this.functions = new Map()   // key -> {file,name,line,calls,errors,ms}
    this.edges = new Map()       // callerKey\u0001calleeKey -> count
    this.edgesDropped = 0
    this.stack = []
    this.watchSpecs = new Map()  // normFile -> [{symbol|'*', lineStart, lineEnd, file}]
    this.watched = new Map()     // functionKey -> WatchRecord
    this.uncaught = []
    this._lastWritten = -1
    for (const w of opts.watches || []) {
      const file = normFile(w.absPath || w.file || '')
      if (!file) continue
      const list = this.watchSpecs.get(file) || []
      list.push({
        symbol: w.symbol || '*',
        lineStart: w.lineStart | 0,
        lineEnd: w.lineEnd | 0,
      })
      this.watchSpecs.set(file, list)
    }
  }

  _fn(file, name, line) {
    const key = file + '\u0000' + name + '\u0000' + line
    let f = this.functions.get(key)
    if (!f) {
      if (this.functions.size >= MAX_FUNCTIONS) return null
      f = { key, file, name, line, calls: 0, errors: 0, ms: 0 }
      this.functions.set(key, f)
    }
    return f
  }

  _watchFor(f) {
    if (this.watched.has(f.key)) return this.watched.get(f.key)
    const specs = this.watchSpecs.get(normFile(f.file))
    if (!specs) return null
    let hit = null
    for (const s of specs) {
      if (s.symbol === '*') { hit = s; break }
      if (s.symbol !== f.name) continue
      if (!s.lineStart || (s.lineStart <= f.line && f.line <= Math.max(s.lineEnd, s.lineStart))) { hit = s; break }
    }
    // A stale index may disagree on line numbers; accept a unique name match.
    if (!hit) {
      const named = specs.filter(s => s.symbol === f.name)
      if (named.length === 1) hit = named[0]
    }
    const rec = hit ? new WatchRecord({ file: f.file, symbol: f.name, line: f.line }) : null
    this.watched.set(f.key, rec)
    return rec
  }

  enter(file, name, line, argsArr, paramNames) {
    const f = this._fn(file, name, line)
    if (!f) return null
    f.calls++
    const caller = this.stack.length ? this.stack[this.stack.length - 1].f : null
    if (caller && caller !== f) {
      const ek = caller.key + '\u0001' + f.key
      const n = this.edges.get(ek)
      if (n !== undefined) this.edges.set(ek, n + 1)
      else if (this.edges.size < MAX_EDGES) this.edges.set(ek, 1)
      else this.edgesDropped++
    }
    const frame = { f, t0: process.hrtime.bigint(), w: null }
    const w = this._watchFor(f)
    if (w) {
      w.calls++
      const before = new Map()
      const args = {}
      for (let i = 0; i < paramNames.length; i++) {
        args[paramNames[i]] = argsArr[i]
        for (const [p, l] of flatten(argsArr[i], paramNames[i])) {
          before.set(p, l)
          w.observe('arg.' + p, l)
        }
      }
      frame.w = { rec: w, argsArr, paramNames, before, call: w.calls, args: preview(args) }
      // Fingerprint on the flattened values, not the truncated preview, so two
      // large arguments that differ past the cut are not called identical.
      let fingerprint = ''
      for (const [p, l] of before) fingerprint += p + '=' + display(l) + '|'
      w.observeArgs(w.calls, paramNames, argsArr, fingerprint, frame.w.args)
    }
    this.stack.push(frame)
    return frame
  }

  ret(frame, value) {
    if (frame && frame.w && !frame.w.returned) {
      frame.w.returned = true
      frame.w.returnPreview = preview(value)
      const whole = frame.w.returnPreview.length > 80 ? frame.w.returnPreview.slice(0, 79) + '…' : frame.w.returnPreview
      frame.w.rec.returns.add(typeof value === 'number' ? { k: 'number', v: value } : { k: 'text', v: whole })
      for (const [p, l] of flatten(value, 'return')) frame.w.rec.observe(p, l)
    }
  }

  error(frame, err) {
    if (!frame) return
    frame.f.errors++
    if (frame.w) {
      frame.w.rec.errors++
      frame.w.threw = `${(err && err.name) || 'Error'}: ${String(err && err.message != null ? err.message : err).slice(0, 200)}`
      const ex = frame.w.rec.exceptions
      if (ex.size < MAX_EXCEPTIONS || ex.has(frame.w.threw)) ex.set(frame.w.threw, (ex.get(frame.w.threw) || 0) + 1)
    }
  }

  exit(frame) {
    if (!frame) return
    const ms = Number(process.hrtime.bigint() - frame.t0) / 1e6
    frame.f.ms += ms
    // Async functions exit out of order; remove this frame wherever it sits.
    const i = this.stack.lastIndexOf(frame)
    if (i >= 0) this.stack.splice(i, 1)
    const w = frame.w
    if (!w) return
    w.rec.totalMs += ms
    // Mutations: re-flatten the arguments now and diff against entry.
    const changed = []
    for (let i = 0; i < w.paramNames.length; i++) {
      const after = flatten(w.argsArr[i], w.paramNames[i])
      const keys = new Set()
      for (const k of w.before.keys()) if (k === w.paramNames[i] || k.startsWith(w.paramNames[i] + '.') || k.startsWith(w.paramNames[i] + '[')) keys.add(k)
      for (const k of after.keys()) keys.add(k)
      for (const k of keys) {
        const b = display(w.before.get(k))
        const a = display(after.get(k))
        if (a !== b) changed.push({ path: k, before: b, after: a })
      }
    }
    // `{}` gaining its first key reads as two changes: the empty-object leaf
    // disappearing and the new child appearing. Only the child is real.
    const real = changed.filter(c => !(
      (c.before === '{}' || c.before === '(absent)' || c.after === '{}' || c.after === '(absent)') &&
      changed.some(o => o !== c && (o.path.startsWith(c.path + '.') || o.path.startsWith(c.path + '[')))
    ))
    changed.length = 0
    changed.push(...real)
    for (const c of changed.slice(0, 20)) {
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
      mutated: changed.length ? changed.slice(0, 4).map(c => `${c.path}: ${c.before} → ${c.after}`) : undefined,
      ms: +ms.toFixed(3),
    })
  }

  _totalCalls() {
    let n = 0
    for (const f of this.functions.values()) n += f.calls
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
    if (this.functions.size === 0 && this.uncaught.length === 0) return
    const functions = []
    for (const f of this.functions.values()) {
      functions.push({ file: f.file, name: f.name, line: f.line, calls: f.calls, errors: f.errors, ms: +f.ms.toFixed(3) })
    }
    const edges = []
    for (const [k, n] of this.edges) {
      const [a, b] = k.split('\u0001')
      const [af, an, al] = a.split('\u0000')
      const [bf, bn, bl] = b.split('\u0000')
      edges.push({ from: { file: af, name: an, line: +al }, to: { file: bf, name: bn, line: +bl }, calls: n })
    }
    const watched = []
    for (const rec of this.watched.values()) if (rec) watched.push(rec.toJSON())
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
      watched,
      uncaught: this.uncaught,
    }
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(path.join(this.dir, `${process.pid}.json`), JSON.stringify(doc))
    } catch (_) {
      // Nowhere to report to. The run still completes; archd notices the gap.
    }
  }
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
