import React from 'react'
import { brandIcon } from './nodes/infraIcons'
import { LANGUAGES, languageDefinition } from './languageDefinitions'
export { LANGUAGES, languageDefinition, languageFromFilename, filenameForLanguage, type LanguageDefinition } from './languageDefinitions'
export function LanguageIcon({ language, size = 14 }: { language: string; size?: number }) {
  const definition = languageDefinition(language)
  if (!definition) {
    return <svg viewBox="0 0 24 24" width={size} height={size}><rect x="3" y="3" width="18" height="18" rx="1" fill="none" stroke="var(--text-secondary)" strokeWidth="2" /><path d="M9 17V7l7 5z" fill="none" stroke="var(--text-secondary)" strokeWidth="2" /></svg>
  }
  const icon = brandIcon(definition.icon)
  if (icon) return <svg viewBox="0 0 24 24" width={size} height={size} aria-label={icon.title}>
    <path d={icon.path} fill={definition.color} />
  </svg>
  return <svg viewBox="0 0 24 24" width={size} height={size} aria-label={definition.label}>
    <rect width="24" height="24" rx="2" fill={definition.color} />
    <text x="12" y="15.5" fill={definition.textColor ?? '#fff'} fontSize={definition.short.length > 2 ? 7 : 9} fontWeight="900" fontFamily="var(--font-mono)" textAnchor="middle">{definition.short}</text>
  </svg>
}

export function LanguagePicker({ value, onChange, iconSize = 14 }: { value: string; onChange?: (language: string) => void; iconSize?: number }) {
  const [open, setOpen] = React.useState(false)
  const id = React.useId()
  const anchor = React.useRef<HTMLButtonElement>(null)
  const popup = React.useRef<HTMLDivElement>(null)
  const position = () => {
    const button = anchor.current, panel = popup.current
    if (!button || !panel?.matches(':popover-open')) return
    const bounds = button.getBoundingClientRect(), margin = 8, gap = 6
    const width = Math.min(220, window.innerWidth - margin * 2)
    const below = window.innerHeight - bounds.bottom - margin - gap, above = bounds.top - margin - gap
    const upward = below < Math.min(240, above)
    panel.style.width = `${width}px`
    panel.style.maxHeight = `${Math.min(280, Math.max(40, upward ? above : below))}px`
    panel.style.left = `${Math.max(margin, Math.min(bounds.left, window.innerWidth - width - margin))}px`
    panel.style.top = `${upward ? bounds.top - gap - panel.getBoundingClientRect().height : bounds.bottom + gap}px`
    panel.style.visibility = 'visible'
  }
  React.useLayoutEffect(() => {
    const panel = popup.current
    if (!panel) return
    panel.popover = 'auto'
    anchor.current?.setAttribute('popovertarget', id)
    const toggle = () => {
      const shown = panel.matches(':popover-open')
      if (shown) position()
      else panel.style.visibility = 'hidden'
      setOpen(shown)
    }
    panel.addEventListener('toggle', toggle)
    return () => panel.removeEventListener('toggle', toggle)
  }, [id])
  React.useLayoutEffect(() => { if (open) position() }, [open])
  React.useEffect(() => {
    if (!open) return
    const resize = new ResizeObserver(position)
    if (anchor.current) resize.observe(anchor.current)
    if (popup.current) resize.observe(popup.current)
    const camera = anchor.current?.closest('.react-flow__viewport')
    const movement = new MutationObserver(position)
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation()
      popup.current?.hidePopover(); anchor.current?.focus({ preventScroll: true })
    }
    if (camera) movement.observe(camera, { attributes: true, attributeFilter: ['style'] })
    window.addEventListener('resize', position)
    document.addEventListener('scroll', position, true)
    document.addEventListener('keydown', escape, true)
    return () => { resize.disconnect(); movement.disconnect(); window.removeEventListener('resize', position); document.removeEventListener('scroll', position, true); document.removeEventListener('keydown', escape, true) }
  }, [open])
  return <div className="nodrag nopan" style={{ position: 'relative', flexShrink: 0 }} onPointerDown={event => event.stopPropagation()}>
    <button ref={anchor} type="button" disabled={!onChange} title={onChange ? 'Choose implementation language' : value || 'Unknown language'}
      aria-label={`Language: ${languageDefinition(value)?.label || 'Choose language'}`} aria-expanded={open} aria-controls={id} aria-haspopup="listbox"
      onClick={event => event.stopPropagation()}
      onKeyDown={event => {
        if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
        event.preventDefault(); event.stopPropagation()
        if (!popup.current?.matches(':popover-open')) popup.current?.showPopover()
        position()
        const options = Array.from(popup.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [])
        const selected = options.find(option => option.getAttribute('aria-selected') === 'true')
        ;(selected ?? (event.key === 'ArrowUp' ? options.at(-1) : options[0]))?.focus()
      }}
      style={{ border: 0, background: 'transparent', padding: 0, display: 'flex', cursor: onChange ? 'pointer' : 'default' }}>
      <LanguageIcon language={value} size={iconSize} />
    </button>
    <div ref={popup} id={id} role="listbox" aria-label="Implementation language" className="nowheel nodrag nopan" onWheel={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => {
        const options = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="option"]'))
        const current = options.indexOf(document.activeElement as HTMLButtonElement)
        const next = event.key === 'ArrowDown' ? (current + 1) % options.length : event.key === 'ArrowUp' ? current < 0 ? options.length - 1 : (current - 1 + options.length) % options.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : -1
        if (next >= 0) { event.preventDefault(); event.stopPropagation(); options[next]?.focus() }
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); popup.current?.hidePopover(); anchor.current?.focus() }
      }} style={{
      position: 'fixed', margin: 0, visibility: 'hidden', width: 220, maxHeight: 280, overflowY: 'auto',
      background: 'var(--bg-surface)', border: '1px solid var(--border)', boxShadow: 'var(--shadow-card)', padding: 4,
    }}>
      {open && LANGUAGES.map((language, index) => <button key={language.id} type="button" role="option" aria-selected={language.id === value}
        autoFocus={language.id === value || !languageDefinition(value) && index === 0} onClick={event => {
        event.stopPropagation(); popup.current?.hidePopover(); onChange?.(language.id)
      }} style={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 7, padding: '5px 6px', border: 0,
        background: language.id === value ? 'var(--bg-raised)' : 'transparent', color: 'var(--text-primary)',
        fontSize: 10, fontFamily: 'var(--font-mono)', cursor: 'pointer', textAlign: 'left',
      }}><LanguageIcon language={language.id} size={12} />{language.label}</button>)}
    </div>
  </div>
}
