import assert from 'node:assert/strict'
import test from 'node:test'
import { SHEET_TEMPLATES } from './sheetTemplates.ts'

// The same line shapes archd's importer reads (api/sheet_markdown.go).
const add = /^- (system|class|file|service|data_store|infra) `[^`]+`( at `[^`]+`)?( - .*)?$/
const member = /^\s+- `[^`]+`( - .*)?$/
const ref = /^- (system|file|infrastructure|infra) `[^`]+`$/
const connection = /^- `[^`]+` [A-Z_]+ `[^`]+`( - .*)?$/

test('every starter sheet is in the import format, so nothing is left out', () => {
  for (const template of SHEET_TEMPLATES) {
    let section = ''
    for (const line of template.markdown.split('\n')) {
      if (!line.trim() || line.startsWith('# ')) continue
      if (line.startsWith('## ')) { section = line.slice(3).toLowerCase(); continue }
      if (!section) continue
      const ok = section === 'add' ? add.test(line) || member.test(line)
        : section === 'connections' ? connection.test(line)
        : ref.test(line)
      assert.ok(ok, `${template.id}: ${line}`)
    }
  }
})
