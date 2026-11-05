import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSymbolCandidate, pickSymbol, symbolFromAmbioHref, symbolHref } from './symbolReference.ts'

const files = new Set(['robot/heuristics.py', 'robot/scene.py', 'tests/test_heuristics.py'])

test('every way clients write a symbol reads as its name, container and file', () => {
  const cases = {
    'evaluate_scene': { name: 'evaluate_scene' },
    'evaluate_scene()': { name: 'evaluate_scene' },
    'evaluate_scene(frame, config=cfg)': { name: 'evaluate_scene' },
    'def evaluate_scene': { name: 'evaluate_scene' },
    'async function load()': { name: 'load' },
    'class Scene': { name: 'Scene' },
    'Scene.update': { name: 'update', container: 'Scene' },
    'Scene::update()': { name: 'update', container: 'Scene' },
    'Scene#update': { name: 'update', container: 'Scene' },
    'scene->update': { name: 'update', container: 'scene' },
    'self.update()': { name: 'update' },
    'this.update': { name: 'update' },
    'self.config.fast_movement_threshold_mps': { name: 'fast_movement_threshold_mps', container: 'config' },
    'heuristics.evaluate_scene': { name: 'evaluate_scene', container: 'heuristics' },
    'tests/test_heuristics.py::test_stop': { name: 'test_stop', file: 'tests/test_heuristics.py' },
    'heuristics.py:evaluate_scene': { name: 'evaluate_scene', file: 'robot/heuristics.py' },
  }
  for (const [written, expected] of Object.entries(cases)) {
    assert.deepEqual(parseSymbolCandidate(written, files), expected, written)
  }
  // Values, expressions, commands and words are not symbols.
  for (const written of ['0.1', '>= 0.2', 'speed > threshold', 'npm run build', 'True', 'None', 'self', 'x', 'main', '"name"', 'a + b', '--force', '']) {
    assert.equal(parseSymbolCandidate(written, files), null, written)
  }
})

const hit = (id, name, kind, relPath, lineStart, lineEnd = lineStart) => ({ id, fileId: relPath, name, kind, relPath, lineStart, lineEnd })
const evaluate = hit('1', 'evaluate_scene', 'function', 'robot/heuristics.py', 100, 130)
const updateInScene = hit('2', 'update', 'method', 'robot/scene.py', 20, 30)
const updateInCamera = hit('3', 'update', 'method', 'robot/scene.py', 60, 70)
const scene = hit('4', 'Scene', 'class', 'robot/scene.py', 10, 40)
const camera = hit('5', 'Camera', 'class', 'robot/scene.py', 50, 80)

test('one definition is taken; several are not guessed between', () => {
  assert.equal(pickSymbol({ name: 'evaluate_scene' }, [evaluate]), evaluate)
  assert.equal(pickSymbol({ name: 'update' }, [updateInScene, updateInCamera]), null)
  assert.equal(pickSymbol({ name: 'missing' }, []), null)
  // Only exact names count; a case-different symbol is someone else's.
  assert.equal(pickSymbol({ name: 'Evaluate_scene' }, [evaluate]), null)
})

test('a class before the name picks the method inside that class', () => {
  const hits = [updateInScene, updateInCamera]
  assert.equal(pickSymbol({ name: 'update', container: 'Scene' }, hits, [scene, camera]), updateInScene)
  assert.equal(pickSymbol({ name: 'update', container: 'Camera' }, hits, [scene, camera]), updateInCamera)
  // A module name picks by file; an instance name falls back to the bare name.
  assert.equal(pickSymbol({ name: 'evaluate_scene', container: 'heuristics' }, [evaluate, hit('6', 'evaluate_scene', 'function', 'tools/replay.py', 3)]), evaluate)
  assert.equal(pickSymbol({ name: 'evaluate_scene', container: 'engine' }, [evaluate]), evaluate)
})

test('files the reply names choose between definitions, nearest first', () => {
  const other = hit('7', 'evaluate_scene', 'function', 'tools/replay.py', 3)
  const both = [evaluate, other]
  assert.equal(pickSymbol({ name: 'evaluate_scene' }, both), null)
  assert.equal(pickSymbol({ name: 'evaluate_scene' }, both, [], { nearby: ['robot/heuristics.py'], message: [] }), evaluate)
  assert.equal(pickSymbol({ name: 'evaluate_scene' }, both, [], { nearby: [], message: ['tools/replay.py'] }), other)
  assert.equal(pickSymbol({ name: 'evaluate_scene' }, both, [], { nearby: ['tools/replay.py'], message: ['robot/heuristics.py'] }), other)
  assert.equal(pickSymbol({ name: 'evaluate_scene', file: 'tools/replay.py' }, both), other)
})

test('a definition is preferred to a variable of the same name', () => {
  const variable = hit('8', 'threshold', 'variable', 'robot/config.py', 4)
  const fn = hit('9', 'threshold', 'function', 'robot/heuristics.py', 12)
  assert.equal(pickSymbol({ name: 'threshold' }, [variable, fn]), fn)
})

test('a symbol link carries its text and file hints', () => {
  const hints = { nearby: ['robot/a b.py'], message: ['robot/a b.py', 'x/y.ts'] }
  assert.deepEqual(symbolFromAmbioHref(symbolHref('Scene::update()', hints)), { text: 'Scene::update()', hints })
  assert.deepEqual(symbolFromAmbioHref(symbolHref('run', { nearby: [], message: [] })), { text: 'run', hints: { nearby: [], message: [] } })
  assert.equal(symbolFromAmbioHref('ambio://code/x.py'), null)
})
