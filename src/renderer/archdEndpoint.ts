// Where archd is listening. It prefers 7743/7744 but can move when another
// program holds those ports, so every request builds its URL from here.

interface ArchdPorts { api: number; ws: number }

let ports: ArchdPorts = { api: 7743, ws: 7744 }

try {
  const initial = window.axiom?.archdPortsSync?.()
  if (initial) ports = initial
  window.axiom?.onArchdPorts?.(next => { ports = next })
} catch {
  // Browser demo or tests: keep the defaults.
}

/** Base URL of archd's HTTP API. */
export function archdApi(): string {
  return `http://127.0.0.1:${ports.api}`
}

/** archd's second HTTP listener, which also serves the WebSocket. */
export function archdWsHttp(): string {
  return `http://127.0.0.1:${ports.ws}`
}

/** WebSocket base URL (append /ws). */
export function archdWs(): string {
  return `ws://127.0.0.1:${ports.ws}`
}
