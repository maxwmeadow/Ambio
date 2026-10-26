import React, { StrictMode, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { createSceneController } from '../../../src/renderer/canvas/scene/sceneController'
import { usePreparedFloorGeometry, type FloorModel } from '../../../src/renderer/canvas/scene/usePreparedFloorGeometry'
import type { GeneratedPlacement } from '../../../src/renderer/canvas/scene/sceneGeometry'

function Fixture() {
  const preparations = useRef(0)
  const controller = useMemo(() => {
    const scene = createSceneController()
    return { ...scene, prepare: (...args: Parameters<typeof scene.prepare>) => {
      preparations.current += 1
      return scene.prepare(...args)
    } }
  }, [])
  useEffect(() => () => controller.stop(), [controller])
  const placements = useRef(new Map<string, GeneratedPlacement>())
  const [revision, setRevision] = useState(0)
  const [width, setWidth] = useState(360)
  const [empty, setEmpty] = useState(false)
  const model = useMemo<FloorModel | null>(() => empty ? null : ({
    scope: 'review:strict-mode', systems: [], infraNodes: [], dependencies: [],
    files: [{ id: 'file', systemId: null, positionX: 1, positionY: 20, width, height: 110 }] as FloorModel['files'],
    layouts: [{ nodeId: 'file', parentNodeId: null, positionX: 1, positionY: 20, width, height: 110, scale: 1, interiorScale: 1 }] as FloorModel['layouts'],
  }), [revision, width, empty])
  const prepared = usePreparedFloorGeometry(controller, 'floor', model, placements.current, 0)
  return <>
    <div id="status">{empty ? 'empty' : prepared.error ?? (prepared.current ? 'ready' : 'pending')}</div>
    <div id="geometry">{prepared.value?.geometry.descriptors[0]?.geometry.width}</div>
    <div id="preparations">{preparations.current}</div>
    <button onClick={() => setRevision(value => value + 1)}>Echo model</button>
    <button onClick={() => setWidth(720)}>Change geometry</button>
    <button onClick={() => setEmpty(true)}>Clear model</button>
    <button onClick={() => setEmpty(false)}>Restore model</button>
  </>
}

if (new URLSearchParams(location.search).has('fallback')) {
  (globalThis as { __ambioDisableRenderWorker?: boolean }).__ambioDisableRenderWorker = true
}
createRoot(document.getElementById('root')!).render(<StrictMode><Fixture /></StrictMode>)
