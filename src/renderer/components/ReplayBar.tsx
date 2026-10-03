import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useGraphStore, type CapturedEvent } from '../store/graphStore'

const MIN_GAP_MS = 180
const MAX_GAP_MS = 2400

/**
 * How long a moment stays on screen before the next one, at 1×. A replay
 * that plays at the recorded pace flashes a finding past faster than anyone
 * can read it (a 21-second case replayed in five), so the moments a person
 * came to see hold long enough to read; bookkeeping events pass quickly.
 */
const DWELL_MS: Record<string, number> = {
  'investigation:hypothesis': 2600,
  'investigation:run_started': 1100,
  'investigation:run': 4200,
  'investigation:verdict': 2400,
  'investigation:note': 2600,
  'investigation:conclusion': 4000,
  'investigation:message': 2200,
}

const SPEEDS = [1, 2, 4] as const

function clipText(text: string, n = 90): string {
  return text.length > n ? `${text.slice(0, n - 1)}…` : text
}

function eventLabel(event: CapturedEvent): string {
  const payload = event.payload as any
  if (!payload) return event.type
  switch (event.type) {
    case 'investigation:hypothesis': return `Suspects ${payload.hypothesis?.id}: ${clipText(payload.hypothesis?.text ?? '')}`
    case 'investigation:verdict': {
      const h = payload.hypothesis ?? {}
      const word = h.status === 'confirmed' ? 'Confirmed' : h.status === 'refuted' ? 'Ruled out' : 'Inconclusive'
      return `${word} ${h.id}${h.verdict ? `: ${clipText(h.verdict, 70)}` : ''}`
    }
    case 'investigation:run_started': return `Running ${clipText(payload.command ?? '', 60)}`
    case 'investigation:run': return `R${payload.run?.n ?? ''} ${clipText((payload.run?.headline ?? '').replace(/`/g, ''), 80)}`
    case 'investigation:conclusion': return `Root cause: ${clipText(payload.conclusion?.rootCause ?? '')}`
    case 'investigation:message': return `You said: ${clipText(payload.message?.text ?? '')}`
    case 'investigation:message_delivered': return 'Your message reached the agent'
    case 'investigation:note': return `Found: ${clipText(payload.text ?? '')}`
    case 'call:trace': return `Traced ${payload.steps?.length ?? 0} calls`
    case 'data:flow': return `Followed ${payload.variable} through the code`
    case 'runtime:call': return `Called ${payload.symbol ?? ''}`
    case 'runtime:return': return `Returned from ${payload.symbol ?? ''}`
    case 'runtime:exception': return `Threw ${payload.excType ?? ''}`
    case 'runtime:inject': return `Injected a value into ${payload.inject?.symbol ?? ''}`
    case 'runtime:watch': return `Watching ${payload.watch?.symbol ?? ''}`
    case 'runtime:session': return payload.status === 'connected' ? 'Program started' : 'Program stopped'
    case 'agent:activity': return clipText(String(payload.message ?? 'Agent activity'))
    default: return event.type
  }
}

export function ReplayBar() {
  const { replay, replayNext, replaySeek, stopReplay } = useGraphStore(useShallow(state => ({
    replay: state.replay,
    replayNext: state.replayNext,
    replaySeek: state.replaySeek,
    stopReplay: state.stopReplay,
  })))
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState<(typeof SPEEDS)[number]>(1)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const events = replay?.events ?? []
  const cursor = replay?.cursor ?? -1
  const atEnd = cursor >= events.length - 1
  const percent = events.length ? ((cursor + 1) / events.length) * 100 : 0
  const currentLabel = cursor >= 0 && cursor < events.length ? eventLabel(events[cursor]) : 'Press Play to watch it unfold'
  const lastNote = useMemo(() => {
    for (let index = cursor; index >= 0; index -= 1) {
      if (events[index].type === 'investigation:note') {
        return (events[index].payload as { text?: string })?.text ?? null
      }
    }
    return null
  }, [cursor, events])

  useEffect(() => {
    if (!playing || !replay) return
    if (atEnd) {
      setPlaying(false)
      return
    }
    const current = events[cursor]
    const next = events[cursor + 1]
    // Recorded pace, with long idle stretches compressed, but never less than
    // the time it takes to read the moment just shown.
    const recorded = Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, next.offsetMs - (current?.offsetMs ?? next.offsetMs)))
    const dwell = current ? DWELL_MS[current.type] ?? 0 : 400
    const gap = Math.max(recorded, dwell) / speed
    timer.current = setTimeout(() => {
      useGraphStore.getState().replayNext()
    }, gap)
    return () => {
      if (timer.current) clearTimeout(timer.current)
    }
  }, [playing, cursor, replay, atEnd, events, speed])

  if (!replay) return null

  const restart = () => {
    setPlaying(false)
    replaySeek(-1)
  }

  const close = () => {
    setPlaying(false)
    stopReplay()
  }

  return (
    <section className="ambio-replay" aria-label={`Investigation replay: ${replay.name}`}>
      <header className="ambio-replay__header">
        <div className="ambio-replay__identity">
          <span className="ambio-replay__mode">Replay</span>
          <strong title={replay.name}>{replay.name}</strong>
        </div>
        <code className="ambio-replay__revision">
          {replay.branch}@{replay.commit ? replay.commit.slice(0, 8) : '-'}
        </code>
        <button type="button" className="ambio-replay__close" onClick={close} aria-label="Exit replay">×</button>
      </header>

      <div className="ambio-replay__body">
        <input
          className="ambio-replay__timeline"
          type="range"
          min={-1}
          max={Math.max(0, events.length - 1)}
          value={cursor}
          aria-label="Investigation timeline"
          aria-valuetext={`${cursor + 1} of ${events.length}: ${currentLabel}`}
          onChange={event => {
            setPlaying(false)
            replaySeek(Number(event.target.value))
          }}
        />

        <div className="ambio-replay__progress">
          <span>{cursor + 1}/{events.length}</span>
          <strong title={currentLabel}>{currentLabel}</strong>
          <output>{Math.round(percent)}%</output>
        </div>

        <div className="ambio-replay__transport">
          <button type="button" className="ambio-replay__button" onClick={restart}>Restart</button>
          <button
            type="button"
            className="ambio-replay__button ambio-replay__button--primary"
            data-playing={playing || undefined}
            disabled={atEnd}
            onClick={() => {
              if (!atEnd) setPlaying(current => !current)
            }}
          >
            {playing ? 'Pause' : atEnd ? 'End' : 'Play'}
          </button>
          <button
            type="button"
            className="ambio-replay__button"
            disabled={atEnd}
            onClick={() => {
              setPlaying(false)
              replayNext()
            }}
          >
            Step
          </button>
          <button
            type="button"
            className="ambio-replay__button"
            aria-label={`Playback speed ${speed}×, click to change`}
            onClick={() => setSpeed(current => SPEEDS[(SPEEDS.indexOf(current) + 1) % SPEEDS.length])}
          >
            {speed}×
          </button>
          {lastNote && <aside className="ambio-replay__note" title={lastNote}>{lastNote}</aside>}
          <span className="ambio-replay__live-notice">
            Live activity is paused while you replay
          </span>
        </div>
      </div>
    </section>
  )
}
