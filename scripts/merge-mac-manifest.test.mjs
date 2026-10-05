import assert from 'node:assert/strict'
import test from 'node:test'
import { formatManifest, mergeManifests, parseManifest } from './merge-mac-manifest.mjs'

const arm64 = `version: 1.4.0
files:
  - url: Ambio-1.4.0-arm64-mac.zip
    sha512: armzip==
    size: 101
  - url: Ambio-1.4.0-arm64.dmg
    sha512: armdmg==
    size: 202
path: Ambio-1.4.0-arm64-mac.zip
sha512: armzip==
releaseDate: '2026-10-01T10:00:00.000Z'
`
const x64 = `version: 1.4.0
files:
  - url: Ambio-1.4.0-mac.zip
    sha512: x64zip==
    size: 303
path: Ambio-1.4.0-mac.zip
sha512: x64zip==
releaseDate: '2026-10-01T10:05:00.000Z'
`

test('both architectures end up in one manifest', () => {
  const merged = mergeManifests(parseManifest(arm64), parseManifest(x64))
  assert.deepEqual(merged.files.map(file => file.url), [
    'Ambio-1.4.0-mac.zip', 'Ambio-1.4.0-arm64-mac.zip', 'Ambio-1.4.0-arm64.dmg',
  ])
  assert.equal(merged.path, 'Ambio-1.4.0-mac.zip')
  assert.equal(merged.releaseDate, '2026-10-01T10:05:00.000Z')
  assert.equal(merged.files[1].size, 101)
})

test('the written manifest reads back the same', () => {
  const merged = mergeManifests(parseManifest(arm64), parseManifest(x64))
  const text = formatManifest(merged)
  assert.match(text, /^version: 1\.4\.0\nfiles:\n  - url: Ambio-1\.4\.0-mac\.zip\n    sha512: x64zip==\n    size: 303\n/)
  assert.match(text, /releaseDate: '2026-10-01T10:05:00\.000Z'/)
  assert.deepEqual(parseManifest(text), merged)
})

test('mismatched versions are refused', () => {
  assert.throws(() => mergeManifests(parseManifest(arm64), parseManifest(x64.replace(/1\.4\.0/g, '1.3.9'))), /version mismatch/)
})
