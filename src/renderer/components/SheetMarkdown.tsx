// Sheets as Markdown specs (archd api/sheet_markdown.go): Map → Copy Sheet as
// Markdown puts the open sheet on the clipboard for a PR or AGENTS.md, and
// Map → New Sheet from Markdown… turns a pasted spec into a draft sheet.
// Agents do both through edit_sheet export / import.
import React, { useState } from 'react'
import { useCommandHandlers } from '../app/commands'
import { archdApi } from '../archdEndpoint'
import { useGraphStore } from '../store/graphStore'
import { useSheetStore } from '../store/sheetStore'
import { raiseNotice } from '../store/interruptionStore'
import { SHEET_TEMPLATES } from '../canvas/sheetTemplates'
import { DialogActions, DialogButton, DialogError, DialogField, DialogForm, DialogFrame, DialogNote } from './ui/DialogPrimitives'

const PLACEHOLDER = `# Payment flow

Card payments move out of Orders.

## Add
- system \`Payments\` at \`src/payments/\` - takes card payments
  - \`charge(amount)\` - charges the card

## Remove
- file \`src/legacy/billing.ts\`

## Connections
- \`Orders\` DEPENDS_ON \`Payments\``

function copyText(text: string) {
  if (window.axiom?.copyText) return window.axiom.copyText(text)
  return navigator.clipboard?.writeText(text)
}

export function SheetMarkdown() {
  const [importing, setImporting] = useState(false)
  const workspaceId = useGraphStore(s => s.currentProject?.id ?? '')

  useCommandHandlers({
    'map.copySheetMarkdown': () => {
      const sheetId = useSheetStore.getState().activeSheetId
      if (!sheetId || !workspaceId) {
        raiseNotice('sheet-markdown', 'Open a sheet first', 'Copy Sheet as Markdown copies the sheet you are looking at.')
        return
      }
      void (async () => {
        try {
          const response = await fetch(`${archdApi()}/api/sheets/${encodeURIComponent(sheetId)}/markdown?workspace=${encodeURIComponent(workspaceId)}`)
          if (!response.ok) throw new Error(await response.text())
          const { markdown } = await response.json() as { markdown: string }
          await copyText(markdown)
          raiseNotice('sheet-markdown', 'Sheet copied as Markdown', 'Paste it into a PR, an issue or AGENTS.md. New Sheet from Markdown… reads it back.')
        } catch (error) {
          raiseNotice('sheet-markdown', 'Could not copy the sheet', error instanceof Error ? error.message : String(error))
        }
      })()
    },
    'map.importSheetMarkdown': () => { if (workspaceId) setImporting(true) },
  })

  return importing ? <ImportDialog workspaceId={workspaceId} onClose={() => setImporting(false)} /> : null
}

function ImportDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [markdown, setMarkdown] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const fetchSheets = useSheetStore(s => s.fetchSheets)
  const openSheet = useSheetStore(s => s.openSheet)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!markdown.trim()) {
      setError('Paste a spec first')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await fetch(`${archdApi()}/api/sheet-import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workspaceId, markdown, createdBy: 'user' }),
      })
      if (!response.ok) throw new Error(await response.text())
      const { sheet, warnings } = await response.json() as { sheet: { id: string; name: string }; warnings: string[] }
      await fetchSheets(workspaceId)
      void openSheet(workspaceId, sheet.id)
      onClose()
      if (warnings.length > 0) {
        const more = warnings.length - 1
        raiseNotice('sheet-markdown', `${sheet.name} drafted, with ${warnings.length} ${warnings.length === 1 ? 'line' : 'lines'} left out`,
          more > 0 ? `${warnings[0]} (and ${more} more)` : warnings[0])
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Import failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <DialogFrame title="New Sheet from Markdown" width={560}>
      <DialogForm onSubmit={submit}>
        {error && <DialogError>{error}</DialogError>}
        <DialogField label="Start from" optional="optional - a starter sheet to edit">
          <select
            className="axiom-dialog-input"
            aria-label="Start from"
            defaultValue=""
            onChange={event => {
              const template = SHEET_TEMPLATES.find(item => item.id === event.target.value)
              if (template) setMarkdown(template.markdown)
            }}
          >
            <option value="">A blank spec</option>
            {SHEET_TEMPLATES.map(template => <option key={template.id} value={template.id}>{template.label}</option>)}
          </select>
        </DialogField>
        <DialogField label="Markdown spec">
          <textarea
            value={markdown}
            onChange={event => setMarkdown(event.target.value)}
            placeholder={PLACEHOLDER}
            className="axiom-dialog-input axiom-sheet-markdown__input"
            rows={14}
            spellCheck={false}
            autoFocus
          />
        </DialogField>
        <DialogNote>
          The sheet keeps what the map recognises: <code>## Add</code>, <code>## Remove</code>,{' '}
          <code>## Connections</code> and <code>## Context</code>. Anything else is left out and listed.
        </DialogNote>
        <DialogActions inset>
          <DialogButton type="button" variant="secondary" onClick={onClose} disabled={loading}>Cancel</DialogButton>
          <DialogButton type="submit" variant="primary" disabled={loading}>{loading ? 'Drafting…' : 'Draft Sheet'}</DialogButton>
        </DialogActions>
      </DialogForm>
    </DialogFrame>
  )
}
