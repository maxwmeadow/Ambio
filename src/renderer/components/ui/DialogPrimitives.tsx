import { useId } from 'react'
import type { CSSProperties, FormEventHandler, PropsWithChildren, WheelEventHandler } from 'react'

type DialogFrameProps = PropsWithChildren<{
  title: string
  width: number
  backdropClassName?: string
  onWheel?: WheelEventHandler<HTMLDivElement>
}>

export function DialogFrame({ children, title, width, backdropClassName, onWheel }: DialogFrameProps) {
  const titleId = useId()

  return (
    <div className={['ambio-dialog-backdrop', backdropClassName].filter(Boolean).join(' ')} onWheel={onWheel}>
      <section
        aria-labelledby={titleId}
        aria-modal="true"
        className="ambio-dialog-surface animate-fade-in"
        role="dialog"
        style={{ '--ambio-dialog-width': `${width}px` } as CSSProperties}
      >
        <header className="ambio-dialog-header">
          <h2 className="ambio-dialog-title" id={titleId}>{title}</h2>
        </header>
        <div className="ambio-dialog-content">{children}</div>
      </section>
    </div>
  )
}

export function DialogError({ children }: PropsWithChildren) {
  return <div className="ambio-dialog-error" role="alert">{children}</div>
}

type DialogFormProps = PropsWithChildren<{
  gap?: 14 | 16
  onSubmit: FormEventHandler<HTMLFormElement>
}>

export function DialogForm({ children, gap = 16, onSubmit }: DialogFormProps) {
  return <form className={`ambio-dialog-form ambio-dialog-form--gap-${gap}`} onSubmit={onSubmit}>{children}</form>
}

type DialogFieldProps = PropsWithChildren<{
  label: string
  optional?: string
}>

export function DialogField({ children, label, optional }: DialogFieldProps) {
  return (
    <label className="ambio-dialog-field">
      <span className="ambio-dialog-field__label">
        {label}
        {optional && <span className="ambio-dialog-field__optional">{optional}</span>}
      </span>
      {children}
    </label>
  )
}

export function DialogNote({ children }: PropsWithChildren) {
  return <p className="ambio-dialog-note">{children}</p>
}

type DialogActionsProps = PropsWithChildren<{ inset?: boolean }>

export function DialogActions({ children, inset = false }: DialogActionsProps) {
  return <div className={inset ? 'ambio-dialog-actions ambio-dialog-actions--inset' : 'ambio-dialog-actions'}>{children}</div>
}

type DialogButtonProps = PropsWithChildren<{
  type: 'button' | 'submit'
  variant: 'secondary' | 'primary' | 'agent'
  disabled?: boolean
  disabledOpacity?: number
  onClick?: () => void
}>

export function DialogButton({ children, type, variant, disabled = false, disabledOpacity, onClick }: DialogButtonProps) {
  return (
    <button
      type={type}
      className={`ambio-dialog-button ambio-dialog-button--${variant}`}
      disabled={disabled}
      onClick={onClick}
      style={disabledOpacity === undefined
        ? undefined
        : { '--ambio-dialog-disabled-opacity': disabledOpacity } as CSSProperties}
    >
      {children}
    </button>
  )
}
