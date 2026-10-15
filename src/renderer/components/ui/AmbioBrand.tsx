import wordmark from '../../assets/branding/wordmark.svg'
import reversedWordmark from '../../assets/branding/wordmark-reversed.svg'
import mark from '../../assets/branding/mark.svg'
import reversedMark from '../../assets/branding/mark-reversed.svg'

interface BrandProps {
  reversed?: boolean
  className?: string
}

/** Approved outlined lettering, including the custom m and round i dot. */
export function AmbioWordmark({ reversed = false, className = '' }: BrandProps) {
  return <img className={`ambio-wordmark ${className}`.trim()} src={reversed ? reversedWordmark : wordmark} alt="Ambio" draggable={false} />
}

export function AmbioMark({ reversed = false, className = '' }: BrandProps) {
  return <img className={`ambio-brand-mark ${className}`.trim()} src={reversed ? reversedMark : mark} alt="Ambio" draggable={false} />
}
