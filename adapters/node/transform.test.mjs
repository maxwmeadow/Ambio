import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { mkdtempSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const { transform } = require('./transform.cjs')

// A stand-in runtime: every hook is a pass-through, so instrumented code must
// behave exactly like the original.
const passThrough = { enter: () => ({ active: false, o: null }), ret: (_c, v) => v, error() {}, exit() {} }

function run(code, sourceType = 'script') {
  // null means "leave this file alone" - the program then runs unmodified,
  // which is exactly what must still behave correctly.
  const out = transform(code, { filename: '/w/t.js', sourceType })
  globalThis.__axiom = passThrough
  const module = { exports: {} }
  new Function('module', out ? out.code : code)(module)
  return { module, code: out ? out.code : code }
}

test('minified and nested shapes stay valid and behave the same', () => {
  // Each of these broke once: `return{...}}` ends where the body does, and
  // nested arrows share positions with their parents' closers.
  const cases = [
    ['function f(){return()=>a=>b}', 'typeof f'],
    ['const g=a=>b=>({c:a+b})', 'g(1)(2).c'],
    ['const h=x=>((x))', 'h(7)'],
    ['function i(x){if(x)return;return}', 'String(i(1))'],
    ['function k(){return{a:1}}', 'k().a'],
    ['class A{m(){return this.x}static s(){return(1)}}', 'A.s()'],
    ['const j=a=>(b)=>({...a,b})', 'j({x:1})(2).b'],
    ['function*gen(){yield 1;return 2}', '[...gen()].length'],
    ['const o={m(){return 3},get g(){return 4}}', 'o.m()+o.g'],
    ['class B{constructor(x){this.x=x}}', 'new B(5).x'],
    ['class P{constructor(){this.p=1}} class C extends P{constructor(y){super();this.y=y}}', 'new C(2).p + new C(2).y'],
    ['class P{} class D extends P{constructor(z){if(z)super();else super()}}', 'new D(1) instanceof D'],
    ['class E extends Array{constructor(){super(3);return}}', 'new E().length'],
  ]
  for (const [src, expr] of cases) {
    const plain = new Function(`${src}; return ${expr}`)()
    const { module } = run(`${src}; module.exports = ${expr}`)
    assert.deepEqual(module.exports, plain, src)
  }
})

test('async functions and callbacks keep their results', async () => {
  const { module } = run('module.exports = [1,2,3].map(x => x * 2).filter(async function(){ return true }).length')
  assert.equal(module.exports, 3)
  const out = run('module.exports = (async x => { await null; return x + 1 })(1)')
  assert.equal(await out.module.exports, 2)
})

test('a rewrite that does not parse falls back to the original, never breaks the program', () => {
  assert.equal(transform('this is not javascript {', { filename: '/w/x.js' }), null)
})

test('TypeScript is stripped with line numbers intact', () => {
  const src = 'export function add(a: number,\n  b: number): number {\n  return a + b\n}\n'
  const out = transform(src, { filename: '/w/x.ts', sourceType: 'module' })
  assert.ok(out, 'TypeScript should instrument')
  assert.match(out.code, /__axiom\.enter\("\/w\/x\.ts", "add", 1, \[a, b\]/)
})

test('built code with a source map is recorded under its source names', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'axiom-sm-')))
  writeFileSync(join(dir, 'tokenizer.ts'), [
    'export class Tokenizer {',
    '  codespan(src: string) {',
    '    return src.trim()',
    '  }',
    '}',
    'export function normalizeLabel(label: string) {',
    '  return label.toLowerCase()',
    '}',
  ].join('\n'))
  buildSync({
    entryPoints: [join(dir, 'tokenizer.ts')],
    outfile: join(dir, 'bundle.js'),
    bundle: true, minify: true, sourcemap: true, format: 'esm', logLevel: 'silent',
  })
  const bundle = readFileSync(join(dir, 'bundle.js'), 'utf8')
  const out = transform(bundle, { filename: join(dir, 'bundle.js'), sourceType: 'module' })
  assert.ok(out)
  const calls = [...out.code.matchAll(/__axiom\.enter\("([^"]+)", "([^"]+)", (\d+), \[[^\]]*\], (\[[^\]]*\])/g)]
    .map(m => ({ file: JSON.parse(`"${m[1]}"`), name: m[2], line: Number(m[3]), params: JSON.parse(m[4]) }))
  const codespan = calls.find(c => c.name === 'codespan')
  assert.ok(codespan, `codespan not found in ${JSON.stringify(calls)}`)
  assert.equal(codespan.file, join(dir, 'tokenizer.ts'), 'recorded under the source file, not the bundle')
  assert.equal(codespan.line, 2)
  assert.deepEqual(codespan.params, ['src'], 'minified parameter names are recovered')
  assert.ok(calls.some(c => c.name === 'normalizeLabel' && c.line === 6), 'minified function names are recovered')
})

test('constructors are observed, after super() in derived classes', () => {
  const out = transform('class P{} class C extends P{constructor(y){super();this.y=y}} class B{constructor(){this.b=1}}', { filename: '/w/c.js' })
  const ctors = [...out.code.matchAll(/enter\("\/w\/c\.js", "constructor"/g)]
  assert.equal(ctors.length, 2, 'both constructors instrumented')
  assert.ok(out.code.indexOf('super();') < out.code.indexOf('enter("/w/c.js", "constructor", 1, [y]'), 'observation starts after super()')
})
