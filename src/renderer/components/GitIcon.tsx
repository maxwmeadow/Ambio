/**
 * Git's usual symbols, drawn like InboxIcon (24-unit grid, round 1.6 strokes)
 * so the branch menu reads as part of the same app: arrows down to pull and
 * up to push, a cloud for the remote, a branch fork, and so on.
 */
type GitIconName =
  | 'branch' | 'pull' | 'push' | 'publish' | 'cloud' | 'cloudOff' | 'refresh'
  | 'folder' | 'code' | 'eye' | 'review' | 'apply' | 'trash'
  | 'upToDate' | 'diverged' | 'edit' | 'clean' | 'chevronDown' | 'agent'

const paths: Record<GitIconName, React.ReactNode> = {
  branch: <><circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="7" r="2.2" /><path d="M6 7.2v9.6M18 9.2c0 4.5-6.5 3.8-11.2 8" /></>,
  pull: <path d="M12 4v11M7 10.5l5 5 5-5M5 20h14" />,
  push: <path d="M12 20V9M7 13.5l5-5 5 5M5 4h14" />,
  publish: <><path d="M7 18.5a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 10.5a4 4 0 0 1-.5 8" /><path d="M12 20v-7.5M9 15l3-3 3 3" /></>,
  cloud: <path d="M7 19a4.5 4.5 0 0 1-.6-8.96A6 6 0 0 1 18 11a4 4 0 0 1-.5 8z" />,
  cloudOff: <><path d="M7 19a4.5 4.5 0 0 1-.6-8.96 6 6 0 0 1 1.2-2.8M10.5 5.2A6 6 0 0 1 18 11a4 4 0 0 1 2.4 6.2M17 19H7" /><path d="m3 3 18 18" /></>,
  refresh: <><path d="M20 12a8 8 0 0 1-14.2 5.1M4 12a8 8 0 0 1 14.2-5.1" /><path d="M18.5 3v4h-4M5.5 21v-4h4" /></>,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  code: <path d="m8 8-4 4 4 4M16 8l4 4-4 4M13.5 5l-3 14" />,
  eye: <><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>,
  review: <><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8z" /><path d="M14 3v5h5M9.5 12.5h5M12 10v5M9.5 17.5h5" /></>,
  apply: <><circle cx="6" cy="5" r="2.2" /><circle cx="6" cy="19" r="2.2" /><circle cx="18" cy="12" r="2.2" /><path d="M6 7.2v9.6M6 7.2c0 3.5 4.5 4.8 9.8 4.8" /></>,
  trash: <path d="M4 7h16M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13M10 11v5.5M14 11v5.5" />,
  upToDate: <><circle cx="12" cy="12" r="9" /><path d="m8 12.3 2.8 2.8L16.2 9.5" /></>,
  diverged: <><path d="M12 3.5 21 19.5H3z" /><path d="M12 10v4.5M12 17.2v.1" /></>,
  edit: <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17zM14.5 7.5l3 3" />,
  clean: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  chevronDown: <path d="m6 9.5 6 6 6-6" />,
  agent: <><path d="m12 2.5 8.5 4.75v9.5L12 21.5l-8.5-4.75v-9.5z" /><path d="m3.5 7.25 8.5 4.75 8.5-4.75M12 12v9.5" /></>,
}

export function GitIcon({ name, size = 16, className }: { name: GitIconName; size?: number; className?: string }) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}
