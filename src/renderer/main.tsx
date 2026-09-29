import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { GlobalCommands } from './app/GlobalCommands'
import { ErrorBoundary } from './components/ErrorBoundary'
import './styles/global.css'
// Per-track stylesheets. Loading them here keeps two long-running worktrees
// out of global.css, which is the one file guaranteed to conflict.
import './styles/agents.css'
import './styles/spine.css'
import './styles/proposal.css'
import './styles/connectAgent.css'
import './styles/windows.css'
import './styles/bins.css'
import './styles/drafts.css'
import './styles/appChrome.css'

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
