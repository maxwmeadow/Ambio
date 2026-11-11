import { Chevron } from './ui/Chevron'

type IconName = 'close' | 'attach' | 'send' | 'sheet' | 'canvas' | 'chevron' | 'check' | 'copy' | 'help' | 'search' | 'agent' | 'retry' | 'plus' | 'info' | 'stop' | 'code' | 'system' | 'infra' | 'file' | 'symbol'

const paths: Record<Exclude<IconName, 'chevron'>, React.ReactNode> = {
  close: <path d="m6 6 12 12M18 6 6 18" />,
  attach: <path d="m8 13 7-7a3 3 0 0 1 4 4l-9 9a5 5 0 0 1-7-7l9-9m-6 12 9-9" />,
  send: <path d="M12 19V5m-6 6 6-6 6 6" />,
  sheet: <><path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h5" /></>,
  canvas: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 9h18M9 9v11" /></>,
  check: <path d="m5 12 4 4L19 6" />,
  copy: <><rect x="8" y="8" width="12" height="13" rx="2" /><path d="M16 8V3H3v13h5" /></>,
  help: <><circle cx="12" cy="12" r="9" /><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4m0 3v.1" /></>,
  search: <><circle cx="10" cy="10" r="6" /><path d="m15 15 5 5" /></>,
  agent: <><path d="m12 2 9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10M7.5 4.5l9 5" /></>,
  retry: <><path d="M4 10a8 8 0 1 1 1 7M4 4v6h6" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7.5v.1" /></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1.5" fill="currentColor" />,
  code: <path d="m8 7-5 5 5 5M16 7l5 5-5 5" />,
  system: <path d="M3 6h7l2 2h9v11H3z" />,
  infra: <><ellipse cx="12" cy="6" rx="7" ry="3" /><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3" /></>,
  file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v4h4" /></>,
  symbol: <path d="M9 4c-3 0-2 4-3 6-.4.8-1 1.5-2 2 1 .5 1.6 1.2 2 2 1 2 0 6 3 6M15 4c3 0 2 4 3 6 .4.8 1 1.5 2 2-1 .5-1.6 1.2-2 2-1 2 0 6-3 6" />,
}

export function InboxIcon({ name, size = 16 }: { name: IconName; size?: number }) {
  if (name === 'chevron') return <Chevron size={size} />
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
