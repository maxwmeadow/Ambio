import type { ComponentPropsWithoutRef } from 'react'
import '../../styles/chevron.css'

export function Chevron({ size = 12, direction = 'right', expanded, className }: {
  size?: number
  direction?: 'right' | 'down' | 'left' | 'up'
  expanded?: boolean
  className?: string
}) {
  return (
    <svg className={className ? `ambio-chevron ${className}` : 'ambio-chevron'}
      width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      data-direction={direction} data-expanded={expanded || undefined}>
      <path d="m4 2 4 4-4 4" />
    </svg>
  )
}

export function DisclosureSummary({ children, className, ...props }: ComponentPropsWithoutRef<'summary'>) {
  return (
    <summary {...props} className={className ? `ambio-disclosure-summary ${className}` : 'ambio-disclosure-summary'}>
      <Chevron />
      {children}
    </summary>
  )
}
