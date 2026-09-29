// SheetPalette - the UML stencil sidebar, shown when a sheet layer is active.
// Click to add to the selected system, or drag onto a specific frame.
export interface StencilDef {
  id: string
  label: string
  kind: 'system' | 'class' | 'file' | 'service' | 'data_store' | 'infra'
  shape: 'box' | 'folder' | 'cylinder' | 'hexagon' | 'note'
  hint: string
}

export const STENCILS: StencilDef[] = [
  { id: 'class', label: 'Class', kind: 'class', shape: 'box', hint: 'Compartment box - functions/methods inside' },
  { id: 'file', label: 'File', kind: 'file', shape: 'box', hint: 'A source file to be created' },
  { id: 'system', label: 'System', kind: 'system', shape: 'folder', hint: 'Package/module grouping' },
  { id: 'service', label: 'Service', kind: 'service', shape: 'hexagon', hint: 'Service / API surface' },
  { id: 'infra', label: 'Infra', kind: 'infra', shape: 'box', hint: 'Choose hosting, database, queue, API, or another provider service' },
  { id: 'note', label: 'Note', kind: 'class', shape: 'note', hint: 'Free-floating annotation' },
]

function StencilGlyph({ shape }: { shape: StencilDef['shape'] }) {
  const common = {
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.4,
    strokeDasharray: '4 3',
  }

  switch (shape) {
    case 'folder':
      return <svg width="26" height="20" viewBox="0 0 26 20"><path d="M1 5h9l2 0v0h13v14H1V5zM1 5V2h8v3" {...common} /></svg>
    case 'cylinder':
      return <svg width="26" height="20" viewBox="0 0 26 20"><ellipse cx="13" cy="4" rx="11" ry="3" {...common} /><path d="M2 4v12c0 1.7 4.9 3 11 3s11-1.3 11-3V4" {...common} /></svg>
    case 'hexagon':
      return <svg width="26" height="20" viewBox="0 0 26 20"><path d="M7 1h12l6 9-6 9H7L1 10z" {...common} /></svg>
    case 'note':
      return <svg width="26" height="20" viewBox="0 0 26 20"><path d="M1 1h18l6 6v12H1V1zM19 1v6h6" {...common} /></svg>
    default:
      return <svg width="26" height="20" viewBox="0 0 26 20"><rect x="1" y="1" width="24" height="18" {...common} /><path d="M1 8h24" {...common} /></svg>
  }
}

export function SheetPalette({ onCreate, disabled = false }: { onCreate: (stencil: StencilDef) => void; disabled?: boolean }) {
  return (
    <div className="axiom-sheet-palette" aria-label="Sheet stencils" data-onboarding-target="stencils">
      <div className="axiom-sheet-palette__title">Stencils</div>
      {STENCILS.map(stencil => (
        <button
          type="button"
          key={stencil.id}
          aria-label={`Add ${stencil.label}`}
          disabled={disabled}
          onClick={() => onCreate(stencil)}
          title={`${stencil.hint} · click to add to the selected system, or drag to place`}
          draggable={!disabled}
          onDragStart={event => {
            event.dataTransfer.setData('application/axiom-stencil', JSON.stringify(stencil))
            event.dataTransfer.effectAllowed = 'copy'
          }}
          className="axiom-sheet-palette__item"
        >
          <StencilGlyph shape={stencil.shape} />
          <span>{stencil.label}</span>
        </button>
      ))}
      <div className="axiom-sheet-palette__hint">
        click to add · drag to place · double-click to rename
      </div>
    </div>
  )
}
