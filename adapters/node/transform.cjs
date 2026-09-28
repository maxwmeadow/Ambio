'use strict'
// AST instrumentation - the heart of the Node adapter.
//
// Every function in a watched workspace file is rewritten at load time to call
// into the main-thread runtime (globalThis.__axiom) on entry, return, throw,
// and exit. Instrumentation is UNCONDITIONAL (all functions), but the enter
// hook returns a shared inactive context in O(1) when the function isn't
// watched, so unwatched code stays near-native. Watches (and injections) can
// therefore be toggled at runtime with zero reload.
//
// Original:                          Instrumented:
//   function f(a, b) {                 function f(a, b) {
//     return a + b;                      const __axm = G.enter("file","f",12,[a,b],["a","b"]);
//   }                                    if (__axm.o) { if ("a" in __axm.o) a = __axm.o.a; ... }
//                                        try { return G.ret(__axm, (a + b)); }
//                                        catch (__axe) { G.error(__axm, __axe); throw __axe; }
//                                        finally { G.exit(__axm); }
//                                      }
//
// Only simple identifier params (incl. defaulted) are captured/injectable -
// destructured/rest params are skipped for capture (mirrors the Python
// adapter's pragmatic arg handling).

const acorn = require('acorn')
const MagicString = require('magic-string')
const { loadSourceMap, originalPosition } = require('./sourcemap.cjs')

const G = 'globalThis.__axiom'

// Instrumentable function node types.
const FN_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
])

/**
 * Instrument JS source. Returns { code, map } or null if the source could not
 * be parsed (caller falls back to the original source - never break the app).
 * @param {string} source
 * @param {{filename: string, sourceType?: 'module'|'script'}} opts
 */
// Node 22.13+ strips TypeScript by replacing every type with whitespace, so
// line and column positions survive exactly - a watch on line 14 of the .ts
// file is line 14 of what we instrument. TS that needs real transformation
// (enums, namespaces, parameter properties) throws here; the caller then
// leaves the file uninstrumented rather than breaking it.
let stripTypes = null
function stripTypeScript(source) {
  if (stripTypes === null) {
    try { stripTypes = require('module').stripTypeScriptTypes || false } catch (_) { stripTypes = false }
  }
  if (!stripTypes) return null
  // The API is flagged experimental and warns once per process. That warning
  // would land in the user's run output, attributed to their program.
  const emit = process.emitWarning
  process.emitWarning = function (warning, ...rest) {
    const text = typeof warning === 'string' ? warning : (warning && warning.message) || ''
    if (/stripTypeScriptTypes/.test(text)) return
    return emit.call(process, warning, ...rest)
  }
  try {
    return stripTypes(source, { mode: 'strip' })
  } catch (_) {
    return null
  } finally {
    process.emitWarning = emit
  }
}

const TS_FILE = /\.(ts|mts|cts)$/

function transform(source, opts) {
  const filename = opts.filename
  if (opts.typescript || TS_FILE.test(filename)) {
    const stripped = stripTypeScript(source)
    // Already-transpiled output (tsx, ts-node) is plain JS and strips to itself.
    if (stripped != null) source = stripped
  }
  let ast
  const parseOpts = {
    ecmaVersion: 'latest',
    locations: true,
    allowHashBang: true,
    allowReturnOutsideFunction: true,
    allowAwaitOutsideFunction: true,
  }
  try {
    ast = acorn.parse(source, { ...parseOpts, sourceType: opts.sourceType || 'module' })
  } catch (_) {
    // Retry as the other source type before giving up.
    try {
      ast = acorn.parse(source, {
        ...parseOpts,
        sourceType: opts.sourceType === 'script' ? 'module' : 'script',
      })
    } catch (_e) {
      return null
    }
  }

  const s = new MagicString(source)
  const fileLit = JSON.stringify(filename)
  // Build output with a source map is recorded in source terms (sourcemap.cjs).
  const sm = opts.typescript ? null : loadSourceMap(source, filename)
  let count = 0

  // Unique per-file identifiers so instrumentation never collides with a
  // user variable named __axm/__axe. Nested functions reuse the same names and
  // shadow correctly (inner returns reference the inner context).
  const sfx = Math.random().toString(36).slice(2, 8)
  const names = { CTX: '__axm_' + sfx, ERR: '__axe_' + sfx }

  // Collect all functions with their inferred names, then instrument each.
  const functions = []
  collectFunctions(ast, null, functions)

  for (const fn of functions) {
    const id = identityFor(sm, filename, fn)
    const lit = id.file === filename ? fileLit : JSON.stringify(id.file)
    if (instrumentFunction(s, source, fn.node, id.name, lit, names, id.line, sm)) count++
  }

  if (count === 0) return null
  const code = s.toString()
  // Instrumentation must never break the program it observes. Anything the
  // rewrite got wrong is caught here and the file runs uninstrumented.
  try {
    acorn.parse(code, { ...parseOpts, sourceType: ast.sourceType || opts.sourceType || 'module' })
  } catch (_) {
    return null
  }
  return {
    code,
    map: s.generateMap({ source: filename, hires: false, includeContent: false }),
  }
}

// ─── function discovery + name inference ──────────────────────────────────────

function collectFunctions(root, _parent, out) {
  // Manual traversal so we can infer names from parents (var declarators,
  // properties, methods, assignments).
  const visit = (node, parent, key) => {
    if (!node || typeof node.type !== 'string') return
    // Constructors are where objects get wired up, so they are observed too.
    // A derived class has no `this` until super() returns; mark which kind
    // each constructor is so instrumentation can start after that call.
    if ((node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.body) {
      for (const member of node.body.body) {
        if (member.type === 'MethodDefinition' && member.kind === 'constructor' && member.value) {
          member.value.__axCtor = { derived: !!node.superClass }
        }
      }
    }
    if (FN_TYPES.has(node.type) && !skipFunction(node, parent)) {
      out.push({ node, name: inferName(node, parent, key), nameNode: nameNodeOf(node, parent) })
    }
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue
      const v = node[k]
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === 'string') visit(c, node, k)
      } else if (v && typeof v.type === 'string') {
        visit(v, node, k)
      }
    }
  }
  visit(root, null, null)
}

function inferName(node, parent, key) {
  if (node.id && node.id.name) return node.id.name
  if (parent) {
    if (parent.type === 'VariableDeclarator' && parent.id && parent.id.name) return parent.id.name
    if (parent.type === 'MethodDefinition' && parent.key) return keyName(parent.key)
    if (parent.type === 'Property' && parent.key) return keyName(parent.key)
    if (parent.type === 'AssignmentExpression' && parent.left) {
      if (parent.left.type === 'Identifier') return parent.left.name
      if (parent.left.type === 'MemberExpression' && parent.left.property) return keyName(parent.left.property)
    }
    if (parent.type === 'ExportDefaultDeclaration') return 'default'
  }
  return '<anonymous>'
}

// The identifier a function's name came from - where a source map records the
// original, unminified name.
function nameNodeOf(node, parent) {
  if (node.id) return node.id
  if (!parent) return null
  if (parent.type === 'VariableDeclarator') return parent.id
  if ((parent.type === 'MethodDefinition' || parent.type === 'Property') && parent.key) return parent.key
  if (parent.type === 'AssignmentExpression' && parent.left) {
    return parent.left.type === 'MemberExpression' ? parent.left.property : parent.left
  }
  return null
}

function identityFor(sm, filename, fn) {
  const own = { file: filename, name: fn.name, line: fn.node.loc.start.line }
  if (!sm) return own
  const pos = originalPosition(sm, fn.node.loc.start.line, fn.node.loc.start.column)
  if (!pos) return own
  let name = fn.name
  if (fn.nameNode && fn.nameNode.loc) {
    const at = originalPosition(sm, fn.nameNode.loc.start.line, fn.nameNode.loc.start.column)
    if (at && at.exact && at.name) name = at.name
  }
  return { file: pos.source, name, line: pos.line }
}

function keyName(key) {
  if (!key) return '<computed>'
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal') return String(key.value)
  return '<computed>'
}

// Constructors, getters, and setters have special return/init semantics
// (super() ordering, implicit return of accessors) - leave them uninstrumented.
function skipFunction(node, parent) {
  if (!parent) return false
  if (parent.type === 'MethodDefinition') {
    return parent.kind === 'get' || parent.kind === 'set'
  }
  if (parent.type === 'Property') {
    return parent.kind === 'get' || parent.kind === 'set'
  }
  return false
}

// ─── instrumentation ──────────────────────────────────────────────────────────

function instrumentFunction(s, source, node, name, fileLit, names, mappedLine, sm) {
  const CTX = names.CTX
  const ERR = names.ERR
  const body = node.body
  const line = mappedLine || node.loc.start.line

  // Simple identifier params (incl. defaulted) are captured + injectable.
  const params = []
  for (const p of node.params) {
    if (p.type === 'Identifier') params.push(p.name)
    else if (p.type === 'AssignmentPattern' && p.left.type === 'Identifier') params.push(p.left.name)
  }
  const argsArr = '[' + params.join(', ') + ']'
  // Minified builds rename parameters (src -> e); the source map remembers.
  const shown = params.map((n) => {
    if (!sm) return n
    const p = node.params.find(x => (x.type === 'Identifier' ? x : x.left) && (x.type === 'Identifier' ? x.name : x.left && x.left.name) === n)
    const id = p && (p.type === 'Identifier' ? p : p.left)
    if (!id || !id.loc) return n
    const at = originalPosition(sm, id.loc.start.line, id.loc.start.column)
    return at && at.exact && at.name ? at.name : n
  })
  const namesArr = '[' + shown.map((n) => JSON.stringify(n)).join(', ') + ']'
  // Methods and plain functions pass their receiver, so a run can show the
  // object state a method reads and changes. Arrows have no receiver of their
  // own; `this` there is the enclosing one, already seen by the outer call.
  const receiver = node.type === 'ArrowFunctionExpression' ? '' : ', this'
  const enterCall = `${G}.enter(${fileLit}, ${JSON.stringify(name)}, ${line}, ${argsArr}, ${namesArr}${receiver})`

  // Parameter injection reassignment (only simple identifier params).
  let injectApply = ''
  if (params.length) {
    const asgs = params
      .map((n) => `if (${JSON.stringify(n)} in ${CTX}.o) ${n} = ${CTX}.o[${JSON.stringify(n)}];`)
      .join(' ')
    injectApply = ` if (${CTX}.o) { ${asgs} }`
  }

  if (body.type !== 'BlockStatement') {
    // Arrow with expression body: `(...) => EXPR`  →  block with wrapped return.
    // Any grouping parens acorn stripped around EXPR must be consumed too, or
    // `=> ( { ...block... } )` is a syntax error. We re-parenthesize EXPR
    // inside our own `ret(ctx, (…))`, so removing the outer parens is safe
    // (and required for `=> ({obj})`, whose parens would otherwise wrap a block).
    // Grouping parens acorn stripped from EXPR (`=> ({ obj })`) stay in the
    // output: the wrapper opens before them and closes after, so they become
    // part of the returned expression. Deleting them instead also deleted any
    // enclosing arrow's closer attached to the same character.
    let exprStart = body.start
    let exprEnd = body.end
    let li = exprStart - 1
    while (li >= 0 && /\s/.test(source[li])) li--
    let ri = exprEnd
    while (ri < source.length && /\s/.test(source[ri])) ri++
    while (li >= 0 && ri < source.length && source[li] === '(' && source[ri] === ')') {
      exprStart = li
      exprEnd = ri + 1
      li--
      while (li >= 0 && /\s/.test(source[li])) li--
      ri++
      while (ri < source.length && /\s/.test(source[ri])) ri++
    }
    const prefix = `{ const ${CTX} = ${enterCall};${injectApply} try { return ${G}.ret(${CTX}, (`
    const suffix = `)); } catch (${ERR}) { ${G}.error(${CTX}, ${ERR}); throw ${ERR}; } finally { ${G}.exit(${CTX}); } }`
    // Insertions that share a position must nest: openers outer-first,
    // closers inner-first. Functions are instrumented outer before inner, so
    // openers append to the right side and closers prepend to the left.
    s.appendRight(exprStart, prefix)
    s.prependLeft(exprEnd, suffix)
    return true
  }

  // Block body: inject after `{` and before final `}`, wrap own returns.
  const openBrace = body.start // index of '{'
  const closeBrace = body.end - 1 // index of '}'

  // In a derived class constructor, observation starts after a top-level
  // super(...) call; a conditional super() is left alone rather than risked.
  let startAt = openBrace + 1
  if (node.__axCtor && node.__axCtor.derived) {
    const superStmt = body.body.find(st =>
      st.type === 'ExpressionStatement' && st.expression.type === 'CallExpression' && st.expression.callee.type === 'Super')
    if (!superStmt) return false
    startAt = superStmt.end
  }

  const header = ` const ${CTX} = ${enterCall};${injectApply} try {`
  const footer = ` } catch (${ERR}) { ${G}.error(${CTX}, ${ERR}); throw ${ERR}; } finally { ${G}.exit(${CTX}); } `

  s.appendRight(startAt, header)
  s.prependLeft(closeBrace, footer)

  // Wrap this function's own return statements (not nested functions').
  const returns = []
  collectOwnReturns(body, returns)
  if (startAt !== openBrace + 1) {
    for (let i = returns.length - 1; i >= 0; i--) if (returns[i].start < startAt) returns.splice(i, 1)
  }
  // The footer is already in place, so each closer prepended here lands before
  // it - which matters for minified `return{...}}`, where the return value
  // ends exactly where the body does. The leading space covers `return{`.
  for (const ret of returns) {
    if (ret.argument) {
      s.appendRight(ret.argument.start, ` ${G}.ret(${CTX}, (`)
      s.prependLeft(ret.argument.end, `))`)
    } else {
      // `return;`  →  `return globalThis.__axiom.ret(__axm, void 0);`
      const afterReturn = ret.start + 'return'.length
      s.prependLeft(afterReturn, ` ${G}.ret(${CTX}, void 0)`)
    }
  }
  return true
}

// Collect ReturnStatements owned by this function body (stop at nested fns).
function collectOwnReturns(body, out) {
  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return
    if (FN_TYPES.has(node.type)) return // don't descend into nested functions
    if (node.type === 'ReturnStatement') out.push(node)
    for (const k of Object.keys(node)) {
      if (k === 'loc' || k === 'start' || k === 'end' || k === 'range') continue
      const v = node[k]
      if (Array.isArray(v)) {
        for (const c of v) if (c && typeof c.type === 'string') visit(c)
      } else if (v && typeof v.type === 'string') {
        visit(v)
      }
    }
  }
  // Visit the body's statements (not the function node itself).
  for (const stmt of body.body) visit(stmt)
}

module.exports = { transform, stripTypeScript }
