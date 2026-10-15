import { useEffect } from 'react'
import { WindowControls } from './WindowControls'
import { AppMenuBar } from '../../app/AppMenuBar'
import { AmbioWordmark } from './AmbioBrand'

interface WorkbenchTitleBarProps {
  /** A short state for the screen; omitted when there is nothing to report. */
  status?: string
  statusTone?: 'ready' | 'busy'
  className?: string
}

export function WorkbenchTitleBar({
  status,
  statusTone = 'ready',
  className = '',
}: WorkbenchTitleBarProps) {
  useEffect(() => {
    void window.ambio?.setTitleBarHeight?.(44)
  }, [])

  return (
    <header className={`ambio-workbench-titlebar ${className}`.trim()}>
      <div className="ambio-workbench-titlebar__product">
        <AmbioWordmark reversed />
        <AppMenuBar />
      </div>
      {status && (
        <span
          className={
            statusTone === 'busy'
              ? 'ambio-workbench-titlebar__status ambio-workbench-titlebar__status--busy'
              : 'ambio-workbench-titlebar__status'
          }
        >
          {status}
        </span>
      )}
      <WindowControls />
    </header>
  )
}
