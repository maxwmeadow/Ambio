'use strict'
// Source maps for instrumentation: record built code under its source name.
//
// Real projects often run tests against build output - tsc into dist/, a
// bundle in lib/ - not the files a developer reads. A watch on
// src/Tokenizer.ts:codespan would then never fire while the tests exercise
// exactly that code from lib/marked.esm.js, and a run would wrongly report it
// "never ran". When a file being instrumented carries a source map, each
// function is recorded under its ORIGINAL file, line and name (minified names
// are recovered from the map's names table), so watches, evidence and the map
// all speak in source terms.
//
// Only what instrumentation needs: VLQ decoding and a position lookup.

const fs = require('fs')
const path = require('path')

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Int16Array(128).fill(-1)
for (let i = 0; i < B64.length; i++) B64_INDEX[B64.charCodeAt(i)] = i

/** Decode `mappings` into per-generated-line arrays of [genCol, src, line, col, name]. */
function decodeMappings(mappings) {
  const lines = []
  let line = []
  let src = 0, srcLine = 0, srcCol = 0, name = 0
  let genCol = 0
  let seg = []
  let value = 0, shift = 0
  const flushSeg = () => {
    if (seg.length === 0) return
    genCol += seg[0]
    const out = [genCol]
    if (seg.length >= 4) {
      src += seg[1]; srcLine += seg[2]; srcCol += seg[3]
      out.push(src, srcLine, srcCol)
      if (seg.length >= 5) { name += seg[4]; out.push(name) }
    }
    line.push(out)
    seg = []
  }
  for (let i = 0; i < mappings.length; i++) {
    const ch = mappings.charCodeAt(i)
    if (ch === 59 /* ; */) {
      flushSeg()
      lines.push(line)
      line = []
      genCol = 0
      continue
    }
    if (ch === 44 /* , */) { flushSeg(); continue }
    const digit = ch < 128 ? B64_INDEX[ch] : -1
    if (digit < 0) return null // malformed
    value += (digit & 31) << shift
    if (digit & 32) {
      shift += 5
    } else {
      const negative = value & 1
      value >>>= 1
      seg.push(negative ? -value : value)
      value = 0
      shift = 0
    }
  }
  flushSeg()
  lines.push(line)
  return lines
}

const URL_COMMENT = /\/[/*][#@]\s*sourceMappingURL=([^\s'"*]+)\s*(?:\*\/)?\s*$/

/**
 * Load the source map a generated file points at. Returns null when there is
 * none, it is unreadable, or it is an index map (sections), which bundlers
 * rarely emit for a single output.
 */
function loadSourceMap(source, filename) {
  try {
    const tail = source.slice(-2048)
    const m = URL_COMMENT.exec(tail)
    if (!m) return null
    let raw
    let base = path.dirname(filename)
    const url = m[1]
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',')
      const meta = url.slice(5, comma)
      const payload = url.slice(comma + 1)
      raw = meta.includes('base64') ? Buffer.from(payload, 'base64').toString('utf8') : decodeURIComponent(payload)
    } else {
      const mapPath = path.resolve(base, decodeURIComponent(url.replace(/^file:\/\//, '')))
      raw = fs.readFileSync(mapPath, 'utf8')
      base = path.dirname(mapPath)
    }
    const map = JSON.parse(raw)
    if (map.sections || typeof map.mappings !== 'string' || !Array.isArray(map.sources)) return null
    const lines = decodeMappings(map.mappings)
    if (!lines) return null
    const root = map.sourceRoot || ''
    const sources = map.sources.map(s => {
      if (s == null) return null
      const joined = root ? root.replace(/\/?$/, '/') + s : s
      if (/^webpack:\/\//.test(joined)) return path.resolve(base, joined.replace(/^webpack:\/\/[^/]*\//, ''))
      if (/^file:\/\//.test(joined)) return decodeURIComponent(joined.slice(7))
      return path.resolve(base, joined)
    })
    return { lines, sources, names: Array.isArray(map.names) ? map.names : [] }
  } catch (_) {
    return null
  }
}

/**
 * Original position for a generated (1-based line, 0-based column): the
 * mapping segment at or before the column on that line.
 */
function originalPosition(sm, line, column) {
  const segs = sm.lines[line - 1]
  if (!segs || segs.length === 0) return null
  let best = null
  for (const s of segs) {
    if (s.length < 4) continue
    if (s[0] <= column) best = s
    else break
  }
  if (!best) best = segs.find(s => s.length >= 4) || null
  if (!best) return null
  const source = sm.sources[best[1]]
  if (!source) return null
  return {
    source,
    line: best[2] + 1,
    name: best.length >= 5 ? sm.names[best[4]] : undefined,
    exact: best[0] === column,
  }
}

module.exports = { loadSourceMap, originalPosition, decodeMappings }
