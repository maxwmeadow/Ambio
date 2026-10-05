import React from 'react'

interface State {
  error: Error | null
  componentStack: string | null
}

export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, State> {
  state: State = { error: null, componentStack: null }

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error }
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[ErrorBoundary] Render error caught:', error)
    console.error('[ErrorBoundary] Component stack:', info.componentStack)
    this.setState({ componentStack: info.componentStack ?? null })
  }

  render() {
    const { error, componentStack } = this.state
    if (!error) return this.props.children

    const button: React.CSSProperties = {
      background: 'transparent', border: '1px solid #52615c', borderRadius: 0,
      color: '#e6e3d8', padding: '8px 14px', fontSize: 13, cursor: 'pointer',
    }
    return (
      <div role="alert" style={{
        position: 'fixed', inset: 0,
        background: '#1b2421',
        color: '#e6e3d8',
        padding: 40,
        fontFamily: 'system-ui, sans-serif',
        fontSize: 14,
        overflowY: 'auto',
        zIndex: 99999,
      }}>
        <div style={{ maxWidth: 720 }}>
          <div style={{ fontSize: 11, letterSpacing: '0.08em', color: '#9fb3ab', marginBottom: 8, fontFamily: 'monospace' }}>
            SOMETHING WENT WRONG
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, marginBottom: 12 }}>
            This view hit an error and stopped drawing.
          </div>
          <p style={{ lineHeight: 1.55, color: '#c3cbc6', margin: '0 0 20px' }}>
            Your code and your project map are safe - nothing was changed. Try again to redraw it. If this keeps
            happening, reporting it helps get it fixed.
          </p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 28 }}>
            <button
              onClick={() => this.setState({ error: null, componentStack: null })}
              style={{ ...button, background: '#2f5f56', borderColor: '#4f8279' }}
            >
              Try again
            </button>
            {window.ambio?.reportBug && (
              <button onClick={() => void window.ambio.reportBug()} style={button}>Report a bug</button>
            )}
            {window.ambio?.copyDiagnostics && (
              <button onClick={() => void window.ambio.copyDiagnostics()} style={button}>Copy diagnostics</button>
            )}
          </div>

          <details style={{ fontFamily: 'monospace', fontSize: 12 }}>
            <summary style={{ cursor: 'pointer', color: '#9fb3ab', marginBottom: 10 }}>Technical details</summary>
            <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#f2b8ae', margin: '0 0 16px' }}>
              {error.message}
            </pre>
            {error.stack && (
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#94a39d', margin: '0 0 16px', fontSize: 11 }}>
                {error.stack}
              </pre>
            )}
            {componentStack && (
              <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#94a39d', margin: 0, fontSize: 11 }}>
                {componentStack}
              </pre>
            )}
          </details>
        </div>
      </div>
    )
  }
}
