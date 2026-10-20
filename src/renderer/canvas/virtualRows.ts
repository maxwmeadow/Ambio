export const SYMBOL_ROW_HEIGHT = 17
export function virtualRowRange(count: number, scrollTop: number, height: number, rowHeight = SYMBOL_ROW_HEIGHT, overscan = 4) {
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan)
  const end = Math.min(count, Math.ceil((scrollTop + Math.max(rowHeight, height)) / rowHeight) + overscan)
  return { start: Math.min(start, Math.max(0, count - 1)), end, totalHeight: count * rowHeight }
}
