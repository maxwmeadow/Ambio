import { useState } from 'react'
import type { Sheet } from '../store/sheetStore'
import { InboxIcon } from './InboxIcon'

export function InboxSheetPicker({ sheets, attachedId, onSelect, onClose }: {
  sheets: Sheet[]; attachedId: string | null; onSelect: (id: string) => void; onClose: () => void
}) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const matches = sheets.filter(sheet => !sheet.resolvedAt && `${sheet.name} ${sheet.purpose ?? ''}`.toLowerCase().includes(query.toLowerCase()))
  return <div className="ambio-inbox__picker" role="dialog" aria-label="Attach a sheet" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
  }}>
    <div className="ambio-inbox__search"><InboxIcon name="search" /><input autoFocus role="combobox" aria-label="Search sheets" aria-expanded="true" aria-controls="inbox-sheet-options" aria-autocomplete="list" aria-activedescendant={matches[active] ? `inbox-sheet-option-${active}` : undefined}
      placeholder="Find a sheet…" value={query} onChange={event => { setQuery(event.target.value); setActive(0) }} onKeyDown={event => {
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const next = matches.length ? (active + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length : 0
          setActive(next); document.getElementById(`inbox-sheet-option-${next}`)?.scrollIntoView({ block: 'nearest' })
        }
        if (event.key === 'Enter') { event.preventDefault(); if (matches[active]) onSelect(matches[active].id) }
      }} /><button type="button" className="ambio-inbox__icon" aria-label="Close sheet picker" onClick={onClose}><InboxIcon name="close" size={14} /></button></div>
    <div className="ambio-inbox__picker-label">Sheets <span>Snapshot + live comparison</span></div>
    <div id="inbox-sheet-options" role="listbox" aria-label="Project sheets">
      {matches.map((sheet, index) => <button type="button" role="option" aria-selected={active === index} id={`inbox-sheet-option-${index}`} tabIndex={-1} key={sheet.id} onMouseEnter={() => setActive(index)} onClick={() => onSelect(sheet.id)}>
        <span className="ambio-inbox__sheet-icon"><InboxIcon name="sheet" size={18} /></span><span><strong>{sheet.name}</strong><small>{sheet.purpose || `Revision ${sheet.revision}`}</small></span>{attachedId === sheet.id && <InboxIcon name="check" size={15} />}
      </button>)}
      {!matches.length && <p className="ambio-inbox__picker-empty">{query ? 'No matching sheets.' : 'No active sheets yet. Create one on the canvas, then attach it here.'}</p>}
    </div>
    <div className="ambio-inbox__picker-footer">Select a sheet to give your agent its structure and context.</div>
  </div>
}
