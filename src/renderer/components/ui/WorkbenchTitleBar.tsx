import { useEffect } from 'react'
import { WindowControls } from './WindowControls'
import { AppMenuBar } from '../../app/AppMenuBar'
import { AmbioWordmark } from './AmbioBrand'

interface WorkbenchTitleBarProps {
  className?: string
}

export function WorkbenchTitleBar({
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
      <WindowControls />
    </header>
  )
}
