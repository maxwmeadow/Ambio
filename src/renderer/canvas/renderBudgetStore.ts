import type { RenderTier } from './renderBudgetGeometry'

/** Per-canvas admission, with per-node subscriptions rather than a camera-wide
 * context update. A selected/hovered node may bypass the background queue. */
export function createRenderBudgetStore() {
  const tiers = new Map<string, RenderTier>(), listeners = new Map<string, Set<() => void>>()
  let pending: Array<{ id: string; tier: RenderTier }> = []
  let enabled = false
  let moving = false
  return {
    enabled: () => enabled,
    configure(value: boolean) { enabled = value },
    motion(value: boolean) {
      moving = value
      if (moving) pending = pending.map(row => row.tier === 2 ? { ...row, tier: 1 } : row)
    },
    tier: (id: string): RenderTier => enabled ? tiers.get(id) ?? 0 : 2,
    subscribe(id: string, listener: () => void) {
      let set = listeners.get(id)
      if (!set) { set = new Set(); listeners.set(id, set) }
      set.add(listener)
      return () => { set!.delete(listener); if (!set!.size) listeners.delete(id) }
    },
    desired(rows: Array<{ id: string; tier: RenderTier }>) {
      const wanted = new Set(rows.map(r => r.id))
      for (const id of tiers.keys()) if (!wanted.has(id) && !listeners.has(id)) tiers.delete(id)
      pending = rows.map(row => moving && row.tier === 2 ? { ...row, tier: 1 as const } : row)
        .filter(row => row.tier > (tiers.get(row.id) ?? 0))
      // Demotion waits for viewport eviction. This keeps recently used rich
      // content intact through quick direction reversals and interrupted flights.
    },
    promote(id: string, interactive = true) {
      if (moving && !interactive) return
      if (tiers.get(id) === 2) return
      tiers.set(id, 2); for (const listener of listeners.get(id) ?? []) listener()
    },
    drain(limit: number, deadline: number, now: () => number) {
      let count = 0
      while (pending.length && count < limit && (count === 0 || now() < deadline)) {
        const next = pending.shift()!
        if ((tiers.get(next.id) ?? 0) >= next.tier) continue
        tiers.set(next.id, next.tier)
        for (const listener of listeners.get(next.id) ?? []) listener()
        count++
      }
      return { count, pending: pending.length }
    },
    clear() { pending = []; tiers.clear(); listeners.clear() },
  }
}
