import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { GlobalCommands } from './app/GlobalCommands'
import { ErrorBoundary } from './components/ErrorBoundary'
// Bundled rather than fetched from Google Fonts: nothing leaves the machine
// just to draw the interface, and the app looks right offline.
import '@fontsource/ibm-plex-sans/400.css'
import '@fontsource/ibm-plex-sans/500.css'
import '@fontsource/ibm-plex-sans/600.css'
import '@fontsource/ibm-plex-sans/700.css'
import '@fontsource/jetbrains-mono/400.css'
import '@fontsource/jetbrains-mono/500.css'
import '@fontsource/jetbrains-mono/600.css'
import '@fontsource/jetbrains-mono/700.css'
import './styles/global.css'
// Per-track stylesheets. Loading them here keeps two long-running worktrees
// out of global.css, which is the one file guaranteed to conflict.
import './styles/agents.css'
import './styles/spine.css'
import './styles/proposal.css'
import './styles/connectAgent.css'
import './styles/windows.css'
import './styles/bins.css'
import './styles/infraSidebar.css'
import './styles/drafts.css'
import './styles/appChrome.css'

// Uncaught errors reach the log (warnings and errors are kept in
// ~/.axiom/logs/renderer.log) instead of vanishing with the console.
window.addEventListener('error', event => {
  console.error('[renderer] uncaught error:', event.error ?? event.message)
})
window.addEventListener('unhandledrejection', event => {
  console.error('[renderer] unhandled rejection:', event.reason)
})

const detectedPlatform = window.axiom?.platform
  || (navigator.userAgent.includes('Mac') ? 'darwin' : navigator.userAgent.includes('Win') ? 'win32' : 'linux')
document.documentElement.dataset.platform = detectedPlatform

const root = document.getElementById('root')
if (!root) {
  console.error('[axiom] #root element not found - check index.html')
} else {
  ReactDOM.createRoot(root).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
        <GlobalCommands />
      </ErrorBoundary>
    </React.StrictMode>
  )
}
