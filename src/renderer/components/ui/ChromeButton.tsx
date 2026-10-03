import type { AriaAttributes, PropsWithChildren } from 'react'

type ChromeButtonProps = PropsWithChildren<{
  onClick: () => void
  label: string
  visualLabel?: string
  shortcut?: string
  active?: boolean
  ariaControls?: string
  ariaExpanded?: boolean
  ariaHasPopup?: AriaAttributes['aria-haspopup']
}>

export function ChromeButton({
  onClick,
  label,
  visualLabel,
  shortcut,
  active = false,
  ariaControls,
  ariaExpanded,
  ariaHasPopup,
  children,
}: ChromeButtonProps) {
  return (
    <button
      type="button"
      className={active ? 'ambio-chrome-button ambio-chrome-button--active' : 'ambio-chrome-button'}
      onClick={onClick}
      title={shortcut ? `${label} (${shortcut})` : label}
      aria-label={label}
      aria-controls={ariaControls}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHasPopup}
    >
      {children}
      <span className="ambio-chrome-button__label">{visualLabel ?? label}</span>
      {shortcut && <kbd className="ambio-chrome-button__shortcut">{shortcut}</kbd>}
    </button>
  )
}
