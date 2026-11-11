import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { InboxIcon } from './InboxIcon'

/**
 * Attached images, seen in the message box and in sent messages: a thumbnail,
 * and the image large on click. The page cannot load a file from disk, so the
 * main process reads it (attachments:preview); each image is read once.
 */

const previews = new Map<string, Promise<string>>()

function loadPreview(path: string): Promise<string> {
  let preview = previews.get(path)
  if (!preview) {
    preview = window.ambio.previewAttachment(path)
    // A failed read is tried again next time: the file may be back.
    preview.catch(() => previews.delete(path))
    previews.set(path, preview)
  }
  return preview
}

export function useAttachmentPreview(path: string): { src?: string; failed: boolean } {
  const [state, setState] = useState<{ src?: string; failed: boolean }>({ failed: false })
  useEffect(() => {
    let active = true
    setState({ failed: false })
    loadPreview(path).then(src => { if (active) setState({ src, failed: false }) }, () => { if (active) setState({ failed: true }) })
    return () => { active = false }
  }, [path])
  return state
}

/** The thumbnail inside an image chip; an image icon until it loads, or if it cannot. */
export function AttachmentThumbnail({ path }: { path: string }) {
  const { src } = useAttachmentPreview(path)
  return <span className="ambio-inbox__thumb" aria-hidden="true">
    {src ? <img src={src} alt="" draggable={false} /> : <InboxIcon name="image" size={18} />}
  </span>
}

/** An attached image at full size over everything; Escape or a click outside closes it. */
export function ImageLightbox({ path, label, onClose }: { path: string; label: string; onClose: () => void }) {
  const { src, failed } = useAttachmentPreview(path)
  useEffect(() => {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() } }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [onClose])
  return createPortal(<div className="ambio-lightbox" role="presentation" onPointerDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <figure className="ambio-lightbox__frame" role="dialog" aria-modal="true" aria-label={label}>
      <figcaption>
        <span title={path}>{label}</span>
        <button type="button" onClick={() => { void window.ambio.openAttachment(path).catch(() => {}) }}>Open</button>
        <button type="button" className="ambio-lightbox__close" aria-label="Close image" onClick={onClose}><InboxIcon name="close" size={14} /></button>
      </figcaption>
      <div className="ambio-lightbox__image">
        {src ? <img src={src} alt={label} /> : <p>{failed ? 'This image is no longer on this computer.' : 'Loading…'}</p>}
      </div>
    </figure>
  </div>, document.body)
}
