/**
 * Ambio's nested canvas interaction controller. Numeric Floor/sheet geometry is
 * prepared by the shared scene worker. Complete canonical geometry stays
 * available independently of Flow's disposable viewport interaction subset.
 * Camera movement changes semantic visibility and render tiers; authored layout
 * remains fixed. Human and agent edits share the existing persistence paths.
 */
import type { SheetChange } from './sceneTypes'
import { BASE_FILE_W, BASE_FILE_H, type GeneratedPlacement } from './scene/sceneGeometry'
import { createSceneController } from './scene/sceneController'
import { usePreparedFloorGeometry, type FloorModel } from './scene/usePreparedFloorGeometry'
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ReactFlow,
  MarkerType,
  getViewportForBounds,
  Background,
  BackgroundVariant,
  useReactFlow,
  useStoreApi,
  useNodesInitialized,
  type Node,
  type Edge,
  type NodeTypes,
  type OnNodesChange,
  type OnEdgesChange,
  type OnNodeDrag,
  type OnMove,
  type Connection,
  type OnConnectStart,
  applyNodeChanges,
  applyEdgeChanges,
  SelectionMode,
  ConnectionMode,
  Panel,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
// ELK removed

import { BudgetedSystemNode as SystemNode, BudgetedFileNode as FileNode, BudgetedInfraNode as InfraNode } from './nodes/BudgetedNodes'
import { RenderBudgetContext, useCanvasRenderBudget } from './useCanvasRenderBudget'
import { useCanvasFrameTiming } from './useCanvasFrameTiming'
import { useCanvasFitView } from './useCanvasFitView'
import { canvasScene, canonicalInternalNode } from './scene/canonicalScene'
import { stampBooleanOverlay, stampRuntimeOverlay } from './nodeOverlays'
import { CanvasMiniMap } from './CanvasMiniMap'
import { OrthogonalEdge } from './edges/OrthogonalEdge'
import { useGraphStore } from '../store/graphStore'
import { useShallow } from 'zustand/react/shallow'
import type { DbSystem, DbFile, DbInfraNode, DbDependency, FloorLayout, FloorNodeType } from '../../shared/types'
import { isCanvasSourceFile } from '../../shared/fileKinds'
import { BINNED_FILE_MIME, CanvasBins } from '../components/CanvasBins'
import { partitionCanvasFiles } from './binModel'
import { dropOnFloorAt, registerFloorDropTarget, systemAtFloorPoint } from './binDropBridge'
import { hideBinGhost, hideRealNode, moveBinGhost, showBinGhost } from './binDragGhost'
import { GroupDialog } from '../components/GroupDialog'
import { describeDropEdits, meaningEditsForDrop } from './floorMeaning.ts'
import { commitMeaningEdits } from './meaningActions.ts'
import { FloorEditContext, type FloorEdits } from './floorEditContext'
import { NewSheetDialog } from '../components/NewSheetDialog'
import { useCommandHandlers } from '../app/commands'
import { layoutUndoEntry } from './layoutUndo'
import { pushUndo } from './undoStack'
import { CanvasContextMenu, type CanvasContextTarget } from './CanvasContextMenu'
import { SheetPalette, STENCILS, type StencilDef } from '../components/SheetPalette'
import { InfraPickerDialog } from '../components/InfraPickerDialog'
import { untakenSheetName } from '../../shared/sheetNames'
import { plannedMembers, plannedMetadata, proposeSheetRemoval, restoreSheetRemoval, sheetElementMetadata, useSheetStore } from '../store/sheetStore'
import type { PlannedNodeKind, PlannedNodeMetadata, SheetLayoutMutation } from '../store/sheetStore'
import { filenameForLanguage, languageFromFilename } from './languages'
import {
  apiAssignFile,
  apiRemoveFloorLayouts,
  apiSaveFloorLayouts,
} from './arcdApi'
import { contentRectFor, FRAME_ITEM_GAP } from './frameGeometry'
import { packFrame } from './packing'
import { resizeChanged, type NodeResizeParams } from './resizeGeometry'
import { planCanvasResize, replaceFloorLayouts, type ResizeSessionStart } from './resizePersistence'
import { canPersistGeneratedFrame } from './incrementalFrameLayout'
import { INFRA_CARD_SIZE, PLATFORM_FRAME_SIZE } from './infraRoles'
import { easeViewportTowardZoom, MAX_CANVAS_ZOOM, MIN_CANVAS_ZOOM, nextWheelZoomTarget, ZOOM_SNAP_EPSILON, zoomViewportAroundPoint } from './viewportMath'
import {
  emptySelection,
  isAdditiveEvent,
  selectionAfterDragStart,
  selectionAfterNodeChanges,
  singleNodeSelection,
  stampSelection,
} from './selectionController'
import { planCanvasDrop } from './dropPersistence'
import { planStencilPlacement, stencilStartInFrame, stencilTargetAt } from './stencilPlacement'
import { raiseFailure, raiseNotice, resolveInterruption } from '../store/interruptionStore'
import { applyZoomVisibility, makeFullyVisible, revealNodePath } from './semanticZoom'
import { compactSheetSystems } from './compactSheetSystems'
import { useSheetView } from './sheetView'
import { createSheetPresentation } from './sheetPresentation'
import { surfaceLivingNodeFx } from './livingVisibility'
import { absoluteRects, withFacingHandles } from './folderAnchors'
import { applyDeltaMarks, buildDeltaReview, claimFocusTargets, clampClaimCursor } from './deltaReview'
import { applyAgentAttention, surfaceAgentAttention } from './agentAttentionProjection'
import { useSheetPhase } from './sheetPhase'
import { stampAgentPresence } from './agentPresence'
import { LivingFlowOverlay } from './LivingFlowOverlay'
import { RunTraceOverlay } from './RunTraceOverlay'
import { InfraSidebarLinks } from './InfraSidebarLinks'
import { arrangeHosting, planHosting, type HostedChild } from './hostingPlan'
import { readDetectedBy } from './infraRoles'
import { InfraSidebar } from '../components/InfraSidebar'
import { runCallouts } from './runTraceProjection'
import { createFloorSceneInspector, partitionCanvasNodeChanges } from './sceneIntegrity'
import { CANVAS_SCOPE_ATTR, useCanvasWasdPan } from './useCanvasWasdPan'
import { canvasZoomChrome } from './canvasZoomChrome'
import { recordCanvasRender, recordZoomVisibilityPass, recordSheetLayoutBuild } from './perfMetrics'
import { routeWheelEvent, wheelScrollStep } from './wheelRouting'
import { rectContainsRect } from './selectionResize'
import { sheetEditableNodeIds } from './sheetEditability'
import { advanceSceneMeasurement, sceneMeasurementIsSettled } from './initialCameraFit'
import {
  LARGE_SCENE_NODE_COUNT,
  VIEWPORT_CULLING_NODE_COUNT,
  shouldDeferCanvasMaterialization,
} from './canvasPerformance'
import {
  diffScene,
  recordSceneMutation,
  sceneDeltaIsQuiet,
  sceneGeometry,
  sceneTracingEnabled,
  type SceneNodeGeometry,
} from './sceneDiagnostics'

// A wheel gesture keeps its scroll target until this long after its last event.
const WHEEL_LATCH_MS = 220

/** Matches the .layout-transition duration in global.css. */
const LAYOUT_TRANSITION_MS = 500

// Morning Delta framing bounds. Showing someone a change is not the same as
// pointing the camera at it: the floor stops a claim about two small files
// from landing at an illegible scale, the ceiling stops a two-system boundary
// from filling the viewport with a single box, and the generous padding keeps
// the surrounding architecture visible so the change has context.
const DELTA_REVIEW_MIN_ZOOM = 0.45
const DELTA_REVIEW_MAX_ZOOM = 0.95
const DELTA_REVIEW_PADDING = 0.5

/** Opt-in pointer/geometry drag tracing. Off by default: it is expensive. */
function dragTraceEnabled(): boolean {
  return (globalThis as { __ambioDragTrace?: boolean }).__ambioDragTrace === true
}

// ─── Node type registry ────────────────────────────────────────────────────

export const NODE_TYPES: NodeTypes = {
  system:  SystemNode     as any,
  file:    FileNode       as any,
  infra:   InfraNode      as any,
}

const EDGE_TYPES = {
  orthogonal: OrthogonalEdge as any,
}
// StoreUpdater writes changed prop identities into Flow one at a time. In
// particular, an inline fitViewOptions object can overwrite a queued explicit
// navigation before its node batch resolves. Keep default inputs stable.
const INITIAL_FIT_OPTIONS = { padding: 0.14, maxZoom: 1.0 }
const INITIAL_VIEWPORT = { x: 0, y: 0, zoom: 0.5 }
const DEFAULT_EDGE_OPTIONS = { type: 'orthogonal' }
const FLOW_PRO_OPTIONS = { hideAttribution: true }
const MULTI_SELECTION_KEYS = ['Meta', 'Control', 'Shift']
const SELECTION_PAN_BUTTONS = [1, 2]

type MoveTraceRow = Record<string, string | number | boolean | null>

type NodeMoveTrace = {
  session: number
  nodeId: string
  startedAt: number
  lastLiveLogAt: number
  startClientX: number
  startClientY: number
  previousClientX: number
  previousClientY: number
  startFlowX: number
  startFlowY: number
  startNodeX: number
  startNodeY: number
  startAbsoluteX: number
  startAbsoluteY: number
  startDomLeft: number | null
  startDomTop: number | null
  previousNodeX: number
  previousNodeY: number
  previousChangeByNodeId: Map<string, { x: number; y: number }>
  callbackRows: MoveTraceRow[]
  changeRows: MoveTraceRow[]
}

function pointerTraceCoordinates(event: unknown): {
  clientX: number
  clientY: number
  movementX: number | null
  movementY: number | null
  coalescedEvents: number
  pointerType: string
} {
  const candidate = event as {
    clientX?: number
    clientY?: number
    movementX?: number
    movementY?: number
    pointerType?: string
    touches?: ArrayLike<{ clientX: number; clientY: number }>
    nativeEvent?: unknown
  }
  const touch = candidate.touches?.[0]
  const native = (candidate.nativeEvent ?? candidate) as {
    movementX?: number
    movementY?: number
    pointerType?: string
    getCoalescedEvents?: () => unknown[]
  }
  return {
    clientX: candidate.clientX ?? touch?.clientX ?? 0,
    clientY: candidate.clientY ?? touch?.clientY ?? 0,
    movementX: typeof native.movementX === 'number' ? native.movementX : null,
    movementY: typeof native.movementY === 'number' ? native.movementY : null,
    coalescedEvents: typeof native.getCoalescedEvents === 'function' ? native.getCoalescedEvents().length : 0,
    pointerType: native.pointerType ?? (touch ? 'touch' : 'mouse'),
  }
}

function renderedNodeRect(nodeId: string): DOMRect | null {
  const elements = document.querySelectorAll<HTMLElement>('.react-flow__node[data-id]')
  for (const element of elements) {
    if (element.dataset.id === nodeId) return element.getBoundingClientRect()
  }
  return null
}

// ─── World-space sizing ────────────────────────────────────────────────────
// One scale factor halves the cell size per depth level.
// One gap value drives everything: gap = floor(cellH / 2).
// Container formula (same for width and height):
//   width  = n_cols * cw + (n_cols + 1) * gap
//   height = n_rows * ch + (n_rows + 1) * gap
// The header area equals one gap, so the formula is symmetric in all directions.

export { BASE_FILE_W, BASE_FILE_H } from './scene/sceneGeometry'
// ─── Node data types ───────────────────────────────────────────────────────

export interface SystemNodeData {
  id: string
  name: string
  source: DbSystem['source']
  color: string
  colorRgb: string
  description: string | null
  agentNotes: string | null
  depth: number
  /** Every direct child descriptor, regardless of type, counted exactly once. */
  directChildCount: number
  currentZoom: number
  isChild: boolean
  childrenVisible: number  // 0–1 continuous alpha, not boolean
  selfScale?: number
  selfBlur?: number
  isDropTarget?: boolean
  onResizeStart?: (params: NodeResizeParams) => void
  onResizeEnd?: (params: NodeResizeParams) => void
  onRename?: (name: string) => void
  umlKind?: PlannedNodeKind
  umlMetadata?: PlannedNodeMetadata
  onUmlMetadataChange?: (metadata: PlannedNodeMetadata) => void
  // Drop-target grid overlay
  nodeW?: number
  nodeH?: number
  gridCellW?: number
  gridCellH?: number
  gridGap?: number
  occupiedCells?: Set<string>
  snapPreview?: { col: number; row: number; wUnits: number; hUnits: number } | null
  previewOffset?: { x: number; y: number } | null   // pixel offset showing predicted post-drop position
  frameScale?: number
  worldScale?: number
  minResizeWidth?: number
  minResizeHeight?: number
  presentationBaseWidth?: number
  presentationBaseHeight?: number
}

export interface FileNodeData {
  id: string
  label: string
  relPath: string
  language: string
  lineCount: number
  churnScore: number
  /** Semantic role: '' plain | 'class' (class-first header) | 'cylinder' | 'hexagon'. */
  shape: '' | 'class' | 'cylinder' | 'hexagon'
  /** Class-first title when shape==='class'. */
  displayName: string
  depth: number
  currentZoom: number
  childrenVisible: number
  worldScale: number  // fileNodeSize(parentDepth).w / BASE_FILE_W - drives proportional font/padding
  previewOffset?: { x: number; y: number } | null   // pixel offset showing predicted post-drop position
  frameScale?: number
  /** Optional synthetic symbols supplied by a sheet-local planned file/class. */
  symbols?: Array<{ name: string; kind: string; lineStart: number; lineEnd: number }>
  onRename?: (name: string) => void
  onLanguageChange?: (language: string) => void
  onResizeStart?: (params: NodeResizeParams) => void
  onResizeEnd?: (params: NodeResizeParams) => void
  onSymbolsChange?: (symbols: Array<{ name: string; kind: string; lineStart: number; lineEnd: number }>) => void
  umlKind?: PlannedNodeKind
  umlMetadata?: PlannedNodeMetadata
  onUmlMetadataChange?: (metadata: PlannedNodeMetadata) => void
}

export interface InfraNodeData {
  id: string
  label: string
  name: string
  /** @deprecated superseded by category/provider/service */
  infraType: string
  category: string
  provider: string
  service: string
  subtype: string
  status: string
  umlKind?: PlannedNodeKind
  umlMetadata?: PlannedNodeMetadata
  onRename?: (name: string) => void
  onChooseInfra?: () => void
  onUmlMetadataChange?: (metadata: PlannedNodeMetadata) => void
  onResizeStart?: (params: NodeResizeParams) => void
  onResizeEnd?: (params: NodeResizeParams) => void
  frameScale?: number
  worldScale?: number
}

/**
 * A repository/proposal refresh may finish while a pointer gesture is still
 * authoritative. Reproject the new semantic scene, but retain geometry for
 * the exact nodes whose active resize has already changed. Without this merge,
 * a delayed persistence response paints the previous width/position for one
 * frame and the next pointer sample paints the live size again.
 */
function preserveActiveResizeGeometry(
  projected: Node[],
  interactive: readonly Node[],
  affectedNodeIds: ReadonlySet<string>,
): Node[] {
  if (affectedNodeIds.size === 0) return projected
  const interactiveById = new Map(interactive.map(node => [node.id, node]))
  return projected.map(node => {
    if (!affectedNodeIds.has(node.id)) return node
    const current = interactiveById.get(node.id)
    // Pointer ownership covers the whole presentation node, not just its box.
    // Combining current geometry with freshly projected data still remounted
    // the inner system presentation during review responses (typography,
    // presentation scale, and chrome could restamp while the outline stayed
    // fixed). Keep the exact interactive node until pointer-up, then the
    // projection revision below applies the newest canonical data once.
    return current ?? node
  })
}

/** What a sheet changes about a live node: where it sits, what it is called, or both. */
function sheetChangeOf(moved: boolean, renamed: boolean): SheetChange | undefined {
  return moved && renamed ? 'move rename' : moved ? 'move' : renamed ? 'rename' : undefined
}

/**
 * A sheet member or planned node saved with no geometry at all carries no
 * layout opinion (the daemon's unplacedElement says the same).
 */
function isUnplaced(item: { positionX: number; positionY: number; width?: number | null; height?: number | null }): boolean {
  return item.width == null && item.height == null && item.positionX === 0 && item.positionY === 0
}

// ─── Main component ────────────────────────────────────────────────────────

interface AmbioCanvasProps {
  readOnly?: boolean
  reviewScene?: {
    id: string
    workspaceId: string
    systems: DbSystem[]
    files: DbFile[]
    /** Every indexed file, so the bins can see past what this proposal claimed. */
    binFiles?: readonly DbFile[]
    /** Real file ids this proposal places, by which the bins judge "has a home". */
    placedBinFileIds?: ReadonlySet<string>
    floorLayouts: FloorLayout[]
    editableNodeIds: ReadonlySet<string>
    selectedNodeId: string | null
    onSelectNode: (nodeId: string | null) => void
    onPreviewLayouts: (layouts: Array<Omit<FloorLayout, 'workspaceId' | 'updatedAt'>>) => void
    onSaveLayouts: (layouts: Array<Omit<FloorLayout, 'workspaceId' | 'updatedAt'>>) => Promise<void>
  }
  /**
   * The unsorted bin, rendered as a real canvas of real file nodes.
   *
   * Deliberately has no layout: the bin is a waiting room, so its contents pack
   * themselves fresh every time rather than remembering an arrangement nobody
   * asked to keep. Nothing here ever writes a layout row.
   */
  binScene?: {
    workspaceId: string
    files: readonly DbFile[]
  }
}

/**
 * Where a gesture ended, mouse or touch. A released touch reports its position
 * on `changedTouches` and leaves `touches` empty, so reading the event blindly
 * loses the drop point on exactly the gesture that needs it.
 */
function rectContains(element: Element | null, point: { x: number; y: number }): boolean {
  if (!element) return false
  const rect = element.getBoundingClientRect()
  return point.x >= rect.left && point.x <= rect.right
    && point.y >= rect.top && point.y <= rect.bottom
}

function pointerOf(event: React.MouseEvent | MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in event) return { x: event.clientX, y: event.clientY }
  const touch = event.changedTouches[0]
  return touch ? { x: touch.clientX, y: touch.clientY } : null
}

/**
 * Bin drag diagnostics. Off by default; turn them on from the devtools console
 * with `window.__ambioBinDragDebug = true` and repeat the gesture - read at
 * call time so no rebuild is needed.
 */
function binDragDebug(): boolean {
  return (window as unknown as { __ambioBinDragDebug?: boolean }).__ambioBinDragDebug === true
}

/** Stable identities, so the bin canvas does not rebuild its layout every render. */
const emptyBinSystems: DbSystem[] = []
/** The bin never persists geometry, so it always packs from nothing. */
const emptyBinLayouts: FloorLayout[] = []

/** Puts a Floor move or resize on Edit → Undo (layoutUndo.ts). */
function pushFloorLayoutUndo(
  workspaceId: string,
  label: string,
  before: FloorLayout[],
  after: Omit<FloorLayout, 'workspaceId' | 'updatedAt'>[],
) {
  const entry = layoutUndoEntry({
    label, before, after,
    save: async rows => {
      const changedKeys = new Set(rows.map(row => `${row.nodeType}:${row.nodeId}`))
      useGraphStore.setState(state => ({
        floorLayouts: replaceFloorLayouts(state.floorLayouts,
          rows.map(row => ({ ...row, workspaceId, updatedAt: Date.now() })), changedKeys),
      }))
      await apiSaveFloorLayouts(workspaceId, rows)
    },
  })
  if (entry) pushUndo(entry)
}

export function AmbioCanvas({ readOnly = false, reviewScene, binScene }: AmbioCanvasProps = {}) {
  recordCanvasRender()
  const reviewMode = reviewScene !== undefined
  const binMode = binScene !== undefined
  // Both modes swap the scene data and cut every live subscription. The Floor
  // is the only surface that owns the workspace's real state.
  const isolatedScene = reviewMode || binMode
  const reviewEditableNodeIds = reviewScene?.editableNodeIds
  const previewReviewLayouts = reviewScene?.onPreviewLayouts
  const saveReviewLayouts = reviewScene?.onSaveLayouts
  // Ignore live-only channels at the subscription boundary, not just after
  // reading them: agent/runtime updates must not rerender an isolated canvas.
  type GraphState = ReturnType<typeof useGraphStore.getState>
  const emptyReviewLiveState = useMemo(() => ({
    infraNodes: [] as GraphState['infraNodes'],
    dependencies: [] as GraphState['dependencies'],
    activeTrace: [] as GraphState['activeTrace'],
    runtimeNodes: {} as GraphState['runtimeNodes'],
    nodeFx: {} as GraphState['nodeFx'],
    relationshipFx: [] as GraphState['relationshipFx'],
    activeWorkSessions: [] as GraphState['activeWorkSessions'],
    agentAttention: {} as GraphState['agentAttention'],
  }), [])
  const {
    systems: liveSystems, files: liveFiles, infraNodes: liveInfraNodes,
    dependencies: liveDependencies, floorLayouts: liveFloorLayouts,
    selectedNodeId: liveSelectedNodeId, infraPickerNodeId, selectionMode,
    activeTrace: liveActiveTrace, runtimeNodes: liveRuntimeNodes,
    dataFlow: liveDataFlow, nodeFx: liveNodeFx, relationshipFx: liveRelationshipFx,
    delta: liveDelta, activeWorkSessions: liveActiveWorkSessions,
    deltaReviewing: liveDeltaReviewing, deltaCursor: liveDeltaCursor,
    agentAttention: liveAgentAttention, isIndexing: liveIsIndexing,
  } = useGraphStore(useShallow(s => ({
    agentAttention:  isolatedScene ? emptyReviewLiveState.agentAttention : s.agentAttention,
    delta:           isolatedScene ? null : s.delta,
    activeWorkSessions: isolatedScene ? emptyReviewLiveState.activeWorkSessions : s.activeWorkSessions,
    deltaReviewing:  isolatedScene ? false : s.deltaReviewing,
    deltaCursor:     isolatedScene ? 0 : s.deltaCursor,
    systems:         s.systems,
    files:           s.files,
    infraNodes:      isolatedScene ? emptyReviewLiveState.infraNodes : s.infraNodes,
    dependencies:    isolatedScene ? emptyReviewLiveState.dependencies : s.dependencies,
    floorLayouts:    s.floorLayouts,
    selectedNodeId:  s.selectedNodeId,
    infraPickerNodeId: s.infraPickerNodeId,
    selectionMode:   s.selectionMode,
    activeTrace:     isolatedScene ? emptyReviewLiveState.activeTrace : s.activeTrace,
    runtimeNodes:    isolatedScene ? emptyReviewLiveState.runtimeNodes : s.runtimeNodes,
    dataFlow:        isolatedScene ? null : s.dataFlow,
    nodeFx:          isolatedScene ? emptyReviewLiveState.nodeFx : s.nodeFx,
    relationshipFx:  isolatedScene ? emptyReviewLiveState.relationshipFx : s.relationshipFx,
    isIndexing:      isolatedScene ? false : s.isIndexing,
  })))

  // Review and the unsorted bin are data/persistence modes of this component,
  // not other canvases. Every interaction below therefore remains the live
  // Floor implementation - which is the whole point: a file in the bin is a
  // real file node you can zoom into and read, not a lookalike card.
  const systems = binScene ? emptyBinSystems : reviewScene?.systems ?? liveSystems
  const sceneFiles = binScene?.files ?? reviewScene?.files ?? liveFiles
  // The bins draw from the complete indexed population, which is not the same
  // list the canvas draws. In review the scene holds only the files a proposal
  // claimed, so the full set arrives alongside it.
  const binSourceFiles = reviewScene?.binFiles ?? liveFiles
  const reviewPlacedFileIds = reviewScene?.placedBinFileIds
  const floorLayouts = binMode ? emptyBinLayouts : reviewScene?.floorLayouts ?? liveFloorLayouts

  /**
   * Files placed on the Floor by hand while belonging to no system.
   *
   * "Unclassified" covers two different situations and only one of them belongs
   * in a bin: a file nobody has touched is waiting, while a file someone
   * dragged onto the Floor has been put somewhere on purpose. A root layout row
   * is the difference - it exists only because a person made it exist - so it
   * is what separates "on the map, just not in a system" from "still unsorted".
   */
  const looseFileIds = useMemo(() => new Set(
    floorLayouts
      .filter(layout => layout.nodeType === 'file' && layout.containmentKind === 'root')
      .map(layout => layout.nodeId),
  ), [floorLayouts])
  // A file has a home only in a system the canvas shows. A system_id that
  // points at a withheld inferred grouping is not a home: without this the
  // file floated loose on the Floor instead of waiting in the Unsorted bin.
  // The scene's own systems (the proposal's, during review); bin mode empties
  // its scene's systems on purpose, so it answers from the live Floor.
  const homeSystems = binScene ? liveSystems : systems
  const shownSystemIds = useMemo(() => new Set(homeSystems.map(system => system.id)), [homeSystems])
  const fileBelongsOnFloor = useCallback(
    (file: DbFile) => (!!file.systemId && shownSystemIds.has(file.systemId)) || looseFileIds.has(file.id),
    [looseFileIds, shownSystemIds],
  )
  const bins = useMemo(() => partitionCanvasFiles(binSourceFiles, {
    hasHome: reviewPlacedFileIds
      ? (file: DbFile) => reviewPlacedFileIds.has(file.id)
      : fileBelongsOnFloor,
  }), [binSourceFiles, reviewPlacedFileIds, fileBelongsOnFloor])

  // An unclassified file only belongs in a bin once there is an architecture to
  // be unclassified FROM. Before anyone has authored one, every file is
  // unplaced - binning them all would empty the map and hide the whole project
  // behind a tray, which is the opposite of "the map is always complete".
  // Repository frames are where files live, not an authored architecture.
  const binsHoldUnclassified = !binMode && systems.some(system => system.kind !== 'repository')
  const files = useMemo(
    () => binsHoldUnclassified
      ? sceneFiles.filter(file => isCanvasSourceFile(file) && fileBelongsOnFloor(file))
      : sceneFiles.filter(isCanvasSourceFile),
    [sceneFiles, binsHoldUnclassified, fileBelongsOnFloor],
  )
  // Only infra that runs code is on the canvas: confirmed platforms, as frames
  // that hold the systems they host. Everything code talks to (databases,
  // queues, APIs...) lives in the infrastructure sidebar, which draws its
  // relationships onto the canvas on demand (docs/INFRA.md, "Canvas
  // placement"). There is no good automatic place for a database on a map of
  // code.
  const hostingInfraNodes = useMemo(
    () => liveInfraNodes.filter(node => (node.status ?? 'confirmed') === 'confirmed' && node.category === 'platform'),
    [liveInfraNodes],
  )
  const infraNodes = isolatedScene ? emptyReviewLiveState.infraNodes : hostingInfraNodes
  const dependencies = isolatedScene ? emptyReviewLiveState.dependencies : liveDependencies
  const selectedNodeId = reviewScene?.selectedNodeId ?? liveSelectedNodeId
  const activeTrace = isolatedScene ? emptyReviewLiveState.activeTrace : liveActiveTrace
  const runtimeNodes = isolatedScene ? emptyReviewLiveState.runtimeNodes : liveRuntimeNodes
  const dataFlow = isolatedScene ? null : liveDataFlow
  const nodeFx = isolatedScene ? emptyReviewLiveState.nodeFx : liveNodeFx
  const relationshipFx = isolatedScene ? emptyReviewLiveState.relationshipFx : liveRelationshipFx
  const delta = isolatedScene ? null : liveDelta
  const activeWorkSessions = isolatedScene ? emptyReviewLiveState.activeWorkSessions : liveActiveWorkSessions
  const deltaReviewing = isolatedScene ? false : liveDeltaReviewing
  const deltaCursor = isolatedScene ? 0 : liveDeltaCursor
  const agentAttention = isolatedScene ? emptyReviewLiveState.agentAttention : liveAgentAttention
  const isIndexing = isolatedScene ? false : liveIsIndexing

  const { setLiveSelectedNode, setInspectedNode, setInfraPickerNode, setSelectionMode } = useGraphStore(
    useShallow(s => ({
      setLiveSelectedNode: s.setSelectedNode,
      setInspectedNode: s.setInspectedNode,
      setInfraPickerNode: s.setInfraPickerNode,
      setSelectionMode: s.setSelectionMode,
    }))
  )
  const setSelectedNode = reviewScene?.onSelectNode ?? setLiveSelectedNode
  const currentProject = useGraphStore(s => s.currentProject)
  const { getViewport, setViewport, getInternalNode: getFlowInternalNode, screenToFlowPosition, zoomIn, zoomOut } = useReactFlow()
  const fitView = useCanvasFitView()
  const reactFlowStore = useStoreApi()
  const [preparationRetry, setPreparationRetry] = useState(0)
  const getInternalNode = useCallback((id: string) => {
    const node = getFlowInternalNode(id)
    return node?.measured.width ? node : canonicalInternalNode(canvasScene(reactFlowStore), id) ?? node
  }, [getFlowInternalNode, reactFlowStore])
  // Subscribed rather than read once: the bin button shows whether the reader
  // is open, and a stale read would leave it stuck looking closed.
  const documentsOpen = useGraphStore(state => state.documentsOpen)
  // Semantically hidden descendants are intentionally not mounted. Camera
  // readiness therefore tracks the visible render set rather than waiting for
  // measurements that hidden nodes should never produce.
  const nodesInitialized = useNodesInitialized()
  const caseRun = useGraphStore(s =>
    !isolatedScene && s.caseFile && s.caseDismissedId !== s.caseFile.id ? s.caseFile.runs.at(-1) ?? null : null)
  const livingVisibilityOptions = useMemo(() => {
    if (!Object.keys(nodeFx).length && !relationshipFx.length && !Object.keys(agentAttention).length &&
        !Object.keys(runtimeNodes).length && !activeTrace?.length && !dataFlow && !caseRun && !activeWorkSessions.length) return {}
    const semanticParentById = new Map<string, string | null>()
    const labelById = new Map<string, string>()
    for (const system of systems) {
      semanticParentById.set(system.id, system.parentId ?? null)
      labelById.set(system.id, system.name)
    }
    for (const file of files) {
      semanticParentById.set(file.id, file.systemId ?? null)
      labelById.set(file.id, file.relPath.split('/').pop() ?? file.relPath)
    }
    for (const infra of infraNodes) {
      semanticParentById.set(infra.id, null)
      labelById.set(infra.id, infra.name)
    }
    return { semanticParentById, labelById }
  }, [systems, files, infraNodes, nodeFx, relationshipFx, agentAttention, runtimeNodes, activeTrace, dataFlow, caseRun, activeWorkSessions])

  const [candidateRfNodes, setRfNodes] = useState<Node[]>([])
  const [candidateOwner, setCandidateOwner] = useState<string | null>(null)
  const [rfEdges, setRfEdges] = useState<Edge[]>([])
  const canonicalNodeIds = useMemo(() => new Set([
    ...systems.map(system => system.id),
    ...files.map(file => file.id),
    ...infraNodes.map(infra => infra.id),
  ]), [systems, files, infraNodes])
  const canonicalNodeCount = canonicalNodeIds.size
  const sceneProjectId = binScene ? `bin:${currentProject?.id ?? 'demo'}`
    : reviewScene ? `review:${reviewScene.workspaceId}:${reviewScene.id}` : currentProject?.id ?? 'demo'
  const sceneWorker = useMemo(() => createSceneController(), [preparationRetry, sceneProjectId])
  useEffect(() => () => sceneWorker.stop(), [sceneWorker])
  const [reviewReadySceneId, setReviewReadySceneId] = useState<string | null>(null)
  const reviewLayoutReady = !reviewMode || reviewReadySceneId === sceneProjectId
  const classifiedFileCount = useMemo(
    () => files.reduce((count, file) => count + (file.systemId ? 1 : 0), 0),
    [files],
  )
  const deferCanvasMaterialization = shouldDeferCanvasMaterialization({
    isIndexing,
    fileCount: files.length,
    classifiedFileCount,
    systemCount: systems.length,
    floorLayoutCount: floorLayouts.length,
  })
  // Memoized because this object is an effect dependency. Rebuilding it every
  // render restarts the debounce on the blank-canvas recovery below, which can
  // starve that recovery indefinitely during exactly the render storms (a save
  // burst with living flows in flight) that it exists to recover from.
  const [inspectCandidateScene] = useState(createFloorSceneInspector)
  const candidateSceneIntegrity = useMemo(
    () => inspectCandidateScene(candidateRfNodes, canonicalNodeCount, canonicalNodeIds),
    [inspectCandidateScene, candidateRfNodes, canonicalNodeCount, canonicalNodeIds],
  )
  const lastHealthySceneRef = useRef<{ projectId: string; nodes: Node[] } | null>(null)
  if (lastHealthySceneRef.current?.projectId !== sceneProjectId) lastHealthySceneRef.current = null
  if (candidateOwner === sceneProjectId && !deferCanvasMaterialization && candidateSceneIntegrity.valid && candidateRfNodes.length > 0) {
    lastHealthySceneRef.current = { projectId: sceneProjectId, nodes: candidateRfNodes }
  }
  const retainedCandidate = lastHealthySceneRef.current?.projectId === sceneProjectId
    ? lastHealthySceneRef.current.nodes
    : null
  // A healthy snapshot from before an index add/delete is not a valid recovery
  // target for the new canonical graph. Reusing it creates a permanent
  // canonical-mismatch loop and leaves deleted nodes interactive.
  const retainedScene = useMemo(() => !candidateSceneIntegrity.valid && retainedCandidate &&
    retainedCandidate.length === canonicalNodeIds.size &&
    retainedCandidate.every(node => canonicalNodeIds.has(node.id))
    ? retainedCandidate : null, [candidateSceneIntegrity.valid, retainedCandidate, canonicalNodeIds])
  const rfNodes = deferCanvasMaterialization || candidateOwner !== sceneProjectId
    ? []
    : !candidateSceneIntegrity.valid && retainedScene?.length
      ? retainedScene
      : candidateRfNodes
  useLayoutEffect(() => {
    if (deferCanvasMaterialization) return
    if (candidateSceneIntegrity.valid || !retainedScene?.length) return
    console.error('[scene-integrity] rejected invalid Floor projection', {
      projectId: sceneProjectId,
      canonicalNodeCount,
      ...candidateSceneIntegrity,
      retainedNodeCount: retainedScene.length,
    })
    // Restore the controlled candidate too, so later interaction changes are
    // based on the valid scene rather than the rejected transient projection.
    sceneSourceRef.current = `integrity-restore:${candidateSceneIntegrity.reason}`
    setRfNodes(retainedScene)
  }, [
    candidateSceneIntegrity.valid,
    candidateSceneIntegrity.reason,
    candidateSceneIntegrity.nodeCount,
    candidateSceneIntegrity.rootCount,
    candidateSceneIntegrity.visibleRootCount,
    candidateSceneIntegrity.invalidNodeIds,
    canonicalNodeCount,
    retainedScene,
    sceneProjectId,
    deferCanvasMaterialization,
  ])
  // Sheet composition also needs the current zoom, so this ref must be
  // initialized before its memoized layout runs.
  const currentZoomRef = useRef(0.5)
  const wheelLatchRef = useRef<{ element: Element; lastEventAt: number } | null>(null)
  // Which code path most recently asked the controlled scene to change. Read by
  // the scene-mutation tracer so a teleporting frame names its own cause.
  const sceneSourceRef = useRef<string>('init')
  const sceneSnapshotRef = useRef<SceneNodeGeometry[]>([])
  // Semantic visibility only changes with zoom - track the last zoom we restamped
  // at so panning (zoom unchanged) never re-renders every node.
  const lastVisibilityZoomRef = useRef(0.5)
  // Live reframing: gently fit the growing graph into view, but yield to the
  // user while they are actively navigating.
  const liveNodeCountRef = useRef(0)
  const lastUserMoveAtRef = useRef(0)
  const cameraFitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingInitialFitProjectRef = useRef<string | null>(null)
  const manualCameraProjectRef = useRef<string | null>(null)
  const runningInitialFitProjectRef = useRef<string | null>(null)
  const canvasRootRef = useRef<HTMLDivElement>(null)
  const zoomChromeRef = useRef<ReturnType<typeof canvasZoomChrome> | null>(null)
  useLayoutEffect(() => {
    if (!canvasRootRef.current) return
    const chrome = canvasZoomChrome(canvasRootRef.current, getViewport().zoom)
    zoomChromeRef.current = chrome
    return () => { chrome.dispose(); zoomChromeRef.current = null }
  }, [getViewport])
  const domSceneRecoveryRef = useRef('')
  const cursorTraceSignatureRef = useRef('')
  const selectedIdsRef = useRef<Set<string>>(new Set())
  // The selection chip used to read `selected` off the projected React Flow
  // nodes, but that projection is rebuilt or restored by several independent
  // paths (layout rebuild, integrity restore, living FX, the zoom pass). Any
  // one of them dropping the flag for a frame made the chip blink out. The
  // authoritative set is selectedIdsRef, so mirror its file subset into state
  // and render the chip from that instead.
  const [selectedFileIds, setSelectedFileIds] = useState<string[]>([])
  const [selectionRevision, setSelectionRevision] = useState(0)
  const selectionFileIndex = useRef<{ source: DbFile[]; ids: Set<string> }>()
  if (selectionFileIndex.current?.source !== files) selectionFileIndex.current = undefined
  const commitSelection = useCallback((ids: Set<string>) => {
    const previous = selectedIdsRef.current
    const changed = previous.size !== ids.size || [...ids].some(id => !previous.has(id))
    selectedIdsRef.current = ids
    if (changed) useSheetStore.setState({ selectedCanvasIds: [...ids] })
    if (changed) setSelectionRevision(revision => revision + 1)
    if (ids.size && selectionFileIndex.current?.source !== files) selectionFileIndex.current = { source: files, ids: new Set(files.map(file => file.id)) }
    const next = ids.size ? [...ids].filter(id => selectionFileIndex.current!.ids.has(id)) : []
    setSelectedFileIds(previous => {
      if (previous.length === next.length && next.every(id => previous.includes(id))) {
        return previous
      }
      return next
    })
  }, [files])
  const timeoutHandlesRef = useRef<Set<number>>(new Set())
  const scheduleTimeout = useCallback((callback: () => void, delay: number) => {
    const handle = window.setTimeout(() => {
      timeoutHandlesRef.current.delete(handle)
      callback()
    }, delay)
    timeoutHandlesRef.current.add(handle)
    return handle
  }, [])
  useEffect(() => () => {
    for (const handle of timeoutHandlesRef.current) window.clearTimeout(handle)
    timeoutHandlesRef.current.clear()
    if (cameraFitTimerRef.current) window.clearTimeout(cameraFitTimerRef.current)
  }, [])
  const queueCameraFit = useCallback((
    delay: number,
    options: { padding: number; duration: number; maxZoom?: number },
  ) => {
    if (cameraFitTimerRef.current) clearTimeout(cameraFitTimerRef.current)
    const runWhenIdle = () => {
      const idleFor = Date.now() - lastUserMoveAtRef.current
      const requiredIdle = 1200
      if (idleFor < requiredIdle) {
        cameraFitTimerRef.current = setTimeout(runWhenIdle, requiredIdle - idleFor)
        return
      }
      cameraFitTimerRef.current = null
      void fitView(options)
    }
    cameraFitTimerRef.current = setTimeout(runWhenIdle, delay)
  }, [fitView])

  /**
   * Moving a node between the Floor and the bin must not move the camera.
   *
   * The live reframe exists for files streaming in from the watcher - the map
   * genuinely growing as code is written. A file crossing between two views of
   * the same workspace is not that: it is one node the user deliberately moved,
   * and reframing on it yanks the view out from under the gesture they are
   * still performing.
   *
   * Both halves matter. The flag stops the next reframe from being scheduled,
   * and the cancel kills one already counting down from an earlier crossing -
   * which is why the camera only jumped on some drops and not others.
   */
  const suppressGrowthFitRef = useRef(false)
  const holdCameraForGesture = useCallback(() => {
    suppressGrowthFitRef.current = true
    if (cameraFitTimerRef.current) {
      clearTimeout(cameraFitTimerRef.current)
      cameraFitTimerRef.current = null
    }
  }, [])
  const [groupDialogOpen, setGroupDialogOpen] = useState(false)
  const [sheetDialogOpen, setSheetDialogOpen] = useState(false)
  // What the next New Sheet starts with: the selection, or one right-clicked node.
  const [sheetSourceIds, setSheetSourceIds] = useState<string[]>([])
  // Review and bin canvases reuse this component; only the live Floor answers.
  useCommandHandlers({ 'map.newSheet': () => {
    if (isolatedScene) return
    setSheetSourceIds([...selectedIdsRef.current])
    setSheetDialogOpen(true)
  } })
  // ── Sheet overlay (REVISION 2: sheets are layers over the Floor) ─────────
  // The live canvas is the base layer. When a sheet is active: dim non-member
  // live nodes in place (stencil highlight), draw planned UML elements and
  // planned edges on top. Live members keep their Floor positions.
  const liveOverlaySheetId = useSheetStore(s => s.activeSheetId)
  const overlaySheetId = isolatedScene ? null : liveOverlaySheetId
  // The live Floor accepts meaning edits; sheets, reviews and the bin do not.
  const floorEditable = !readOnly && !isolatedScene && !overlaySheetId
  // Sheet mode outlives its own exit so the departure can animate. See
  // sheetPhase.ts - a class that vanishes with the state can only fade IN.
  const sheetPhase = useSheetPhase(overlaySheetId)
  const liveVisibleSheetIds = useSheetStore(s => s.visibleSheetIds)
  const emptyReviewVisibleSheetIds = useMemo<string[]>(() => [], [])
  const visibleSheetIds = reviewMode ? emptyReviewVisibleSheetIds : liveVisibleSheetIds
  const layersById = useSheetStore(s => s.layersById)
  const overlayElements = useSheetStore(s => s.elements)
  const liveWorkspaceIdForOverlay = useGraphStore(s => s.currentProject?.id ?? '')
  const workspaceIdForOverlay = reviewScene?.workspaceId ?? liveWorkspaceIdForOverlay

  // Resolve bottom-to-top, always applying the primary sheet last. A node has
  // one visual owner, so secondary layers contribute nodes but never create a
  // second instance of the same live model element.
  const visibleLayers = useMemo(() => {
    const ordered = visibleSheetIds.filter(id => id !== overlaySheetId)
    if (overlaySheetId && visibleSheetIds.includes(overlaySheetId)) ordered.push(overlaySheetId)
    return ordered.map(id => layersById[id]).filter(Boolean)
  }, [visibleSheetIds, overlaySheetId, layersById])

  const effectiveElements = useMemo(() => {
    const byNodeId = new Map<string, (typeof overlayElements)[number]>()
    for (const layer of visibleLayers) {
      for (const e of layer.elements) {
        const nodeId = e.systemId ?? e.fileId ?? e.infraId
        if (nodeId) byNodeId.set(nodeId, e)
      }
    }
    return byNodeId
  }, [visibleLayers, overlayElements])
  const sheetOpinionIds = useMemo(() => new Set(visibleLayers.flatMap(layer => [
    ...layer.elements.flatMap(element => {
      const id = element.systemId ?? element.fileId ?? element.infraId
      return id ? [id] : []
    }),
    ...layer.planned.map(node => `planned:${node.id}`),
    ...layer.layouts.map(layout => layout.nodeId),
  ])), [visibleLayers])

  const activeElementByNodeId = useMemo(() => {
    const result = new Map<string, (typeof overlayElements)[number]>()
    for (const e of overlayElements) {
      const nodeId = e.systemId ?? e.fileId ?? e.infraId
      if (nodeId) result.set(nodeId, e)
    }
    return result
  }, [overlayElements])

  const overlayPlanned = useMemo(() => visibleLayers.flatMap(layer => layer.planned), [visibleLayers])
  const allSheetRelationships = useSheetView(s => s.allRelationships)
  const focusedRelationship = useSheetView(s => s.relationship)
  useEffect(() => { if (!isolatedScene) useSheetView.setState({ allRelationships: false, relationship: null }) }, [overlaySheetId, isolatedScene])
  const overlayPlannedEdges = useMemo(() => visibleLayers.flatMap(layer => layer.plannedEdges), [visibleLayers])
  const visiblePlannedByNodeId = useMemo(() => new Map(
    overlayPlanned.map(p => [`planned:${p.id}`, p]),
  ), [overlayPlanned])
  const activePlannedByNodeId = useMemo(() => new Map(
    (layersById[overlaySheetId ?? '']?.planned ?? []).map(p => [`planned:${p.id}`, p]),
  ), [layersById, overlaySheetId])
  const activeNodeIds = useMemo(() => !overlaySheetId ? new Set<string>() : sheetEditableNodeIds({
    activeSheetId: overlaySheetId,
    // Live entities are shared with the Floor. Moving one for the first time
    // promotes its geometry into a sparse sheet layout row.
    liveNodeIds: [
      ...systems.map(system => system.id),
      ...files.map(file => file.id),
      ...infraNodes.map(infra => infra.id),
    ],
    activePlannedNodeIds: activePlannedByNodeId.keys(),
    activeLayoutNodeIds: (layersById[overlaySheetId ?? '']?.layouts ?? []).map(layout => layout.nodeId),
  }), [overlaySheetId, systems, files, infraNodes, activePlannedByNodeId, layersById])
  // A sheet is a sparse set of layout opinions over the complete live Floor.
  // Overlaying those full rows gives the one canonical layout input used by
  // projection, drag/drop, resize, and tidy. Legacy columns are read only as an
  // upgrade fallback for a node whose canonical row has not arrived yet.
  /**
   * Nodes a sheet moves to another parent without placing them (an agent's
   * proposed move, db.ProposeSheetMove): node ID -> its new parent. The layout
   * then places each inside that parent instead of where the Floor has it.
   */
  const sheetMoves = useMemo(() => {
    const moves = new Map<string, string | null>()
    if (!visibleLayers.length) return moves
    const floorParent = new Map(floorLayouts.map(layout => [layout.nodeId, layout.parentNodeId ?? null]))
    const semanticParent = new Map<string, string | null>([
      ...systems.map(system => [system.id, system.parentId ?? null] as const),
      ...files.map(file => [file.id, file.systemId ?? null] as const),
    ])
    for (const layer of visibleLayers) {
      const canonicalIds = new Set(layer.layouts.map(layout => layout.nodeId))
      for (const element of layer.elements) {
        const nodeId = element.systemId ?? element.fileId
        if (!nodeId || canonicalIds.has(nodeId) || !isUnplaced(element)) continue
        const current = floorParent.has(nodeId) ? floorParent.get(nodeId)! : semanticParent.get(nodeId) ?? null
        const wanted = element.parentSystemId ?? null
        if (wanted !== current) moves.set(nodeId, wanted)
      }
    }
    return moves
  }, [floorLayouts, systems, files, visibleLayers])

  /** Members an agent proposes moving, still waiting for the human. */
  const pendingMoveIds = useMemo(() => new Set(visibleLayers.flatMap(layer => layer.elements
    .filter(element => element.approvalStatus === 'pending')
    .map(element => element.systemId ?? element.fileId ?? ''))), [visibleLayers])

  /** Systems a sheet proposes renaming (pending or confirmed): node ID -> the new name. */
  const sheetRenames = useMemo(() => new Map(visibleLayers.flatMap(layer => layer.elements
    .filter(element => element.systemId && element.proposedName && (element.renameStatus === 'pending' || element.renameStatus === 'approved'))
    .map(element => [element.systemId!, { name: element.proposedName!, pending: element.renameStatus === 'pending' }] as const))), [visibleLayers])

  const sheetEffectiveLayouts = useMemo<FloorLayout[]>(() => {
    if (!visibleLayers.length) return floorLayouts
    const byId = new Map(floorLayouts.map(layout => [layout.nodeId, layout]))
    const liveSystems = new Map(systems.map(system => [system.id, system]))
    const liveFiles = new Map(files.map(file => [file.id, file]))
    const liveInfra = new Map(infraNodes.map(infra => [infra.id, infra]))
    const plannedInfraIds = new Set(overlayPlanned
      .filter(node => node.kind === 'infra')
      .map(node => `planned:${node.id}`))
    const parentType = (id: string | null): 'system' | 'infra' | null => id
      ? (liveInfra.has(id) || plannedInfraIds.has(id) ? 'infra' : 'system')
      : null
    const containment = (type: 'system' | 'infra' | null) => type === 'infra'
      ? 'hosted_by' as const
      : type === 'system' ? 'part_of' as const : 'root' as const
    for (const layer of visibleLayers) {
      const canonicalIds = new Set(layer.layouts.map(layout => layout.nodeId))
      for (const element of layer.elements) {
        const nodeId = element.systemId ?? element.fileId ?? element.infraId
        if (!nodeId || canonicalIds.has(nodeId)) continue
        // Added with no geometry (an agent naming it for the sheet): it stays
        // exactly where the Floor has it, rather than jumping to the origin -
        // unless the sheet moves it, when the layout places it in its new parent.
        if (isUnplaced(element)) {
          if (sheetMoves.has(nodeId)) byId.delete(nodeId)
          continue
        }
        const previous = byId.get(nodeId)
        const nodeType: FloorNodeType = element.systemId ? 'system' : element.fileId ? 'file' : 'infra'
        const infra = liveInfra.get(nodeId)
        const type = parentType(element.parentSystemId)
        byId.set(nodeId, {
          workspaceId: workspaceIdForOverlay,
          nodeId,
          nodeType,
          parentNodeId: element.parentSystemId,
          parentNodeType: type,
          containmentKind: containment(type),
          positionX: element.positionX,
          positionY: element.positionY,
          width: element.width ?? previous?.width
            ?? liveSystems.get(nodeId)?.width ?? liveFiles.get(nodeId)?.width
            ?? (infra?.category === 'platform' ? PLATFORM_FRAME_SIZE.width : infra ? INFRA_CARD_SIZE.width : BASE_FILE_W),
          height: element.height ?? previous?.height
            ?? liveSystems.get(nodeId)?.height ?? liveFiles.get(nodeId)?.height
            ?? (infra?.category === 'platform' ? PLATFORM_FRAME_SIZE.height : infra ? INFRA_CARD_SIZE.height : BASE_FILE_H),
          scale: element.scale ?? previous?.scale ?? 1,
          interiorScale: previous?.interiorScale ?? 1,
          updatedAt: 0,
        })
      }
      for (const planned of layer.planned) {
        const nodeId = `planned:${planned.id}`
        if (canonicalIds.has(nodeId)) continue
        // Drawn with no position: the layout places it in free space.
        if (isUnplaced(planned)) continue
        const metadata = plannedMetadata(planned)
        const nodeType: FloorNodeType = planned.kind === 'system'
          ? 'system' : planned.kind === 'infra' ? 'infra' : 'file'
        const type = parentType(planned.parentSystemId)
        byId.set(nodeId, {
          workspaceId: workspaceIdForOverlay,
          nodeId,
          nodeType,
          parentNodeId: planned.parentSystemId,
          parentNodeType: type,
          containmentKind: containment(type),
          positionX: planned.positionX,
          positionY: planned.positionY,
          width: planned.width ?? (nodeType === 'system'
            ? 620 : nodeType === 'infra' ? (metadata.category === 'platform' ? PLATFORM_FRAME_SIZE.width : INFRA_CARD_SIZE.width) : BASE_FILE_W),
          height: planned.height ?? (nodeType === 'system'
            ? 420 : nodeType === 'infra' ? (metadata.category === 'platform' ? PLATFORM_FRAME_SIZE.height : INFRA_CARD_SIZE.height) : BASE_FILE_H),
          scale: planned.scale ?? 1,
          interiorScale: 1,
          updatedAt: 0,
        })
      }
      for (const layout of layer.layouts) byId.set(layout.nodeId, layout)
    }
    return [...byId.values()]
  }, [floorLayouts, systems, files, infraNodes, overlayPlanned, visibleLayers, workspaceIdForOverlay, sheetMoves])
  const sheetSystemIds = useMemo(() => new Set(visibleLayers.length ? [
    ...systems.map(system => system.id),
    ...overlayPlanned.filter(node => node.kind === 'system').map(node => `planned:${node.id}`),
  ] : []), [systems, overlayPlanned, visibleLayers])
  const sheetFileIds = useMemo(() => new Set(visibleLayers.length ? [
    ...files.map(file => file.id),
    ...overlayPlanned.filter(node => node.kind !== 'system' && node.kind !== 'infra').map(node => `planned:${node.id}`),
  ] : []), [files, overlayPlanned, visibleLayers])
  const sheetInfraIds = useMemo(() => new Set(visibleLayers.length ? [
    ...infraNodes.map(infra => infra.id),
    ...overlayPlanned.filter(node => node.kind === 'infra').map(node => `planned:${node.id}`),
  ] : []), [infraNodes, overlayPlanned, visibleLayers])
  const [isTransitioningLayout, setIsTransitioningLayout] = useState(false)
  // Placements decided for nodes with no persisted row. Refs, not state: they
  // must survive every reprojection without causing one. See GeneratedPlacement.
  const floorPlacementsRef = useRef(new Map<string, GeneratedPlacement>())
  const sheetPlacementsRef = useRef(new Map<string, GeneratedPlacement>())
  // True for the whole of any drag gesture, including a box-selection drag.
  // Reconciliation easing must be off for the entire scene while dragging or
  // node bodies glide behind the cursor while their chrome tracks it exactly.
  const [isDraggingScene, setIsDraggingScene] = useState(false)
  const onSelectionDragStart = useCallback(() => setIsDraggingScene(true), [])
  const onSelectionDragStop = useCallback(() => setIsDraggingScene(false), [])

  const sheetComposition = `${overlaySheetId ?? ''}|${visibleSheetIds.join('|')}`
  const previousSheetComposition = useRef(sheetComposition)
  useLayoutEffect(() => {
    // There is no previous layout to glide from on first mount (including a
    // Strict Mode effect replay). Only actual sheet changes need this phase.
    if (previousSheetComposition.current === sheetComposition) return
    previousSheetComposition.current = sheetComposition
    setIsTransitioningLayout(true)
    const timer = window.setTimeout(() => setIsTransitioningLayout(false), 500)
    return () => window.clearTimeout(timer)
  }, [sheetComposition])

  useEffect(() => {
    setInspectedNode(null)
    setInfraPickerNode(null)
  }, [overlaySheetId, setInspectedNode, setInfraPickerNode])

  // Layout and authoring callbacks depend on model edits, never on camera or
  // selection. In particular, do not inherit rfNodes here: its visibility flags
  // change during a camera flight and used to rebuild the entire sheet.
  const sheetModel = useMemo<FloorModel | null>(() => {
    if (visibleLayers.length === 0) return null
    recordSheetLayoutBuild()

    const visiblePlanned = overlayPlanned.filter(p => p.status !== 'flattened')
    const plannedSystems: DbSystem[] = visiblePlanned
      .filter(p => p.kind === 'system')
      .map(p => ({
        id: `planned:${p.id}`,
        workspaceId: p.workspaceId,
        name: p.name,
        parentId: p.parentSystemId,
        source: p.createdBy === 'agent' ? 'agent' : 'user',
        color: p.color || null,
        description: plannedMetadata(p).description || p.notes || null,
        agentNotes: null,
        depth: 0,
        positionX: p.positionX,
        positionY: p.positionY,
        width: p.width,
        height: p.height,
        createdAt: 0,
        updatedAt: 0,
      }))
    const virtualSystems: DbSystem[] = systems.map(system => ({ ...system, ...(sheetMoves.has(system.id) ? { parentId: sheetMoves.get(system.id) ?? null } : {}) })).concat(plannedSystems)
    const plannedFiles: DbFile[] = visiblePlanned
      .filter(p => p.kind !== 'system' && p.kind !== 'infra')
      .map(p => {
        const metadata = plannedMetadata(p)
        const inferredLanguage = languageFromFilename(p.name)?.id ?? ''
        return {
          id: `planned:${p.id}`,
          rootId: '',
          path: p.declaredPath || p.name,
          relPath: p.declaredPath || p.name,
          language: metadata.language ?? inferredLanguage,
          systemId: p.parentSystemId,
          lineCount: 0,
          churnScore: 0,
          shape: p.shape === 'cylinder' || p.shape === 'hexagon'
            ? p.shape
            : (p.kind === 'class' ? 'class' : ''),
          displayName: p.kind === 'class' ? p.name : '',
          positionX: p.positionX,
          positionY: p.positionY,
          width: p.width,
          height: p.height,
          indexedAt: 0,
        }
      })
    const virtualFiles: DbFile[] = files.map(file => ({ ...file, ...(sheetMoves.has(file.id) ? { systemId: sheetMoves.get(file.id) ?? null } : {}) })).concat(plannedFiles)
    const plannedInfra: DbInfraNode[] = visiblePlanned
      .filter(p => p.kind === 'infra')
      .map(p => {
        const metadata = plannedMetadata(p)
        return {
          id: `planned:${p.id}`,
          workspaceId: p.workspaceId,
          name: p.name,
          infraType: metadata.category ?? 'api',
          category: (metadata.category ?? 'api') as DbInfraNode['category'],
          provider: metadata.provider ?? 'generic',
          service: metadata.service ?? '',
          subtype: metadata.subtype ?? '',
          status: 'proposed',
          config: {},
          positionX: p.positionX,
          positionY: p.positionY,
        }
      })
    const virtualInfra = infraNodes.map(infra => ({ ...infra })).concat(plannedInfra)
    const authored = new Set(visibleLayers.flatMap(layer => layer.layouts.map(layout => layout.nodeId)))
    const automatic = new Set([
      ...[...sheetMoves.keys()].filter(id => virtualSystems.some(system => system.id === id)),
      ...visiblePlanned.filter(node => node.kind === 'system' && isUnplaced(node)).map(node => `planned:${node.id}`),
    ].filter(id => !authored.has(id)))
    const compact = compactSheetSystems(virtualSystems, virtualFiles, sheetEffectiveLayouts, automatic)
    return { systems: compact.systems, files: virtualFiles, infraNodes: virtualInfra, dependencies,
      layouts: compact.layouts, scope: `${sceneProjectId}:sheets:${visibleSheetIds.join('|')}` }
  }, [visibleLayers, systems, files, infraNodes, dependencies, overlayPlanned, sheetEffectiveLayouts, sheetMoves, sceneProjectId, visibleSheetIds])
  const sheetPreparation = usePreparedFloorGeometry(sceneWorker, 'sheet', sheetModel, sheetPlacementsRef.current, preparationRetry, () => currentZoomRef.current)
  const sheetBaseNodes = useMemo(() => {
    if (!sheetModel || !sheetPreparation.value) return null
    const { input, geometry } = sheetPreparation.value
    const virtualSystems = input.systems, virtualFiles = input.files
    const sheetLayout = sheetPreparation.value.nodes
    const originalParents = new Map<string, string | null>([
      ...systems.map(node => [node.id, node.parentId] as const), ...files.map(node => [node.id, node.systemId] as const),
      ...floorLayouts.map(row => [row.nodeId, row.parentNodeId] as const),
    ])
    const proposedParents = new Map<string, string | null>([
      ...virtualSystems.map(node => [node.id, node.parentId] as const), ...virtualFiles.map(node => [node.id, node.systemId] as const),
      ...input.layouts.map(row => [row.nodeId, row.parentNodeId] as const),
    ])
    const morphed = sheetLayout.map(sheetNode => {
      const planned = visiblePlannedByNodeId.get(sheetNode.id)
      const editablePlanned = activePlannedByNodeId.get(sheetNode.id)
      const sheetElement = effectiveElements.get(sheetNode.id)
      const editableElement = activeElementByNodeId.get(sheetNode.id)
      const isMoved = !planned && !!sheetElement && originalParents.get(sheetNode.id) !== proposedParents.get(sheetNode.id)
      const metadata = planned ? plannedMetadata(planned) : undefined
      const liveDesignMetadata = sheetElement ? sheetElementMetadata(sheetElement) : undefined
      const suppliedSymbols = planned && planned.kind !== 'system' && planned.kind !== 'infra'
        ? (() => {
            const rows: Array<{ name: string; kind: string; lineStart: number; lineEnd: number }> = []
            if (planned.kind === 'class') {
              metadata?.attributes?.forEach(item => rows.push({ name: `${item.name}${item.dataType ? `: ${item.dataType}` : ''}`, kind: 'variable', lineStart: 0, lineEnd: 0 }))
              metadata?.methods?.forEach(item => rows.push({ name: item.name, kind: 'method', lineStart: 0, lineEnd: 0 }))
            } else if (planned.kind === 'service') {
              metadata?.endpoints?.forEach(item => rows.push({ name: item.name, kind: 'method', lineStart: 0, lineEnd: 0 }))
            } else {
              ;(metadata?.symbols ?? metadata?.exports?.map(name => ({ name, kind: 'variable' })) ?? []).forEach(item =>
                rows.push({ name: item.name, kind: item.kind, lineStart: 0, lineEnd: 0 }))
            }
            if (rows.length === 0) plannedMembers(planned).forEach(member => rows.push({
              name: member.signature.split('(')[0]?.trim() || member.signature, kind: 'method', lineStart: 0, lineEnd: 0,
            }))
            return rows
          })()
        : sheetNode.type === 'file' && liveDesignMetadata?.symbols
          ? liveDesignMetadata.symbols.map(symbol => ({ ...symbol, lineStart: 0, lineEnd: 0 }))
          : undefined
      const nodeOpacity = typeof sheetNode.style?.opacity === 'number' ? sheetNode.style.opacity : 1
      const isFloorContextNode = !effectiveElements.has(sheetNode.id) && !planned
      const isSheetPlaced = sheetOpinionIds.has(sheetNode.id)
      const isStructuralFloorContext = Boolean(
        !planned && sheetNode.type === 'system' && !effectiveElements.has(sheetNode.id),
      )
      const sheetW = parseFloat(String(sheetNode.style?.width ?? 0))
      const sheetH = parseFloat(String(sheetNode.style?.height ?? 0))
      const renderedW = sheetW
      const renderedH = sheetH
      return {
        ...sheetNode,
        selected: false,
        data: {
          // Live runtime/focus/trace flags are merged by sheetPresentation;
          // this projection owns geometry and authoring callbacks only.
          ...sheetNode.data,
          sheetPlaced: isSheetPlaced,
          sheetChange: planned ? 'addition' : sheetChangeOf(isMoved, sheetRenames.has(sheetNode.id)),
          ...(planned && planned.kind !== 'system' ? {
            label: planned.name,
            displayName: planned.name,
            relPath: planned.declaredPath || planned.name,
          } : {}),
          ...(planned ? {
            umlKind: planned.kind,
            umlMetadata: plannedMetadata(planned),
          } : {}),
          ...(suppliedSymbols ? { symbols: suppliedSymbols } : {}),
          ...(editablePlanned ? {
            onChooseInfra: editablePlanned.kind === 'infra' ? () => setInfraPickerNode(editablePlanned.id) : undefined,
            onRename: (name: string) => {
              const current = useSheetStore.getState().planned.find(p => p.id === editablePlanned.id)
              if (!current) return
              const inferred = current.kind === 'file' ? languageFromFilename(name) : undefined
              const nextMetadata = inferred ? { ...plannedMetadata(current), language: inferred.id } : current.metadata
              void useSheetStore.getState().updatePlanned(workspaceIdForOverlay, {
                ...current, name, declaredPath: current.kind === 'file' ? name : '', metadata: nextMetadata,
              })
            },
            onLanguageChange: editablePlanned.kind === 'class' || editablePlanned.kind === 'file' ? (language: string) => {
              const current = useSheetStore.getState().planned.find(p => p.id === editablePlanned.id)
              if (!current) return
              const name = current.kind === 'file' ? filenameForLanguage(current.name, language) : current.name
              void useSheetStore.getState().updatePlanned(workspaceIdForOverlay, {
                ...current, name, declaredPath: current.kind === 'file' ? name : '',
                metadata: { ...plannedMetadata(current), language },
              })
            } : undefined,
            onSymbolsChange: (symbols: Array<{ name: string; kind: string }>) => {
              const current = useSheetStore.getState().planned.find(p => p.id === editablePlanned.id)
              if (!current) return
              const meta = plannedMetadata(current)
              let next: PlannedNodeMetadata
              if (current.kind === 'class') {
                const methods = symbols.filter(symbol => symbol.kind === 'function' || symbol.kind === 'method').map((symbol, index) => ({
                  ...(meta.methods?.[index] ?? { visibility: 'public' as const, parameters: [], returnType: '' }), name: symbol.name,
                }))
                const attributes = symbols.filter(symbol => symbol.kind !== 'function' && symbol.kind !== 'method' && symbol.kind !== 'class').map((symbol, index) => {
                  const [name, dataType = ''] = symbol.name.split(':').map(part => part.trim())
                  return { ...(meta.attributes?.[index] ?? { visibility: 'private' as const }), name, dataType }
                })
                next = { ...meta, methods, attributes }
              } else if (current.kind === 'service') {
                next = { ...meta, endpoints: symbols.map((symbol, index) => ({
                  ...(meta.endpoints?.[index] ?? { visibility: 'public' as const, parameters: [], returnType: '' }), name: symbol.name,
                })) }
              } else next = { ...meta, symbols: symbols.map(({ name, kind }) => ({ name, kind })) }
              void useSheetStore.getState().updatePlanned(workspaceIdForOverlay, { ...current, metadata: next })
            },
            onUmlMetadataChange: (metadata: PlannedNodeMetadata) => {
              const current = useSheetStore.getState().planned.find(p => p.id === editablePlanned.id)
              if (current) void useSheetStore.getState().updatePlanned(
                workspaceIdForOverlay, {
                  ...current, metadata,
                  ...((current.kind === 'class' || current.kind === 'file') && metadata.path !== undefined
                    ? { declaredPath: metadata.path }
                    : {}),
                },
              )
            },
          } : {}),
          ...(!editablePlanned && editableElement && sheetNode.type === 'file' ? {
            onSymbolsChange: (symbols: Array<{ name: string; kind: string }>) => {
              const current = useSheetStore.getState().elements.find(element => element.id === editableElement.id)
              if (!current) return
              const currentMetadata = sheetElementMetadata(current) ?? { version: 1 as const }
              void useSheetStore.getState().updateElementMetadata(workspaceIdForOverlay, current.id, {
                ...currentMetadata,
                symbols: symbols.map(({ name, kind }) => ({ name, kind })),
              }).catch(error => console.error('[sheets] live file design metadata update failed:', error))
            },
          } : {}),
          ...(isStructuralFloorContext ? { nodeW: renderedW, nodeH: renderedH } : {}),
          // A proposed rename shows the new name, with the one the map has today under it.
          ...(sheetNode.type === 'system' && sheetRenames.has(sheetNode.id)
            ? { name: sheetRenames.get(sheetNode.id)!.name, renamedFrom: (sheetNode.data as { name?: string }).name }
            : {}),
        },
        style: {
          ...sheetNode.style,
          ...(isStructuralFloorContext ? { width: renderedW, height: renderedH } : {}),
          // Structural context is NOT scenery. It renders at full fidelity and
          // stays clickable, because a sheet is where you work on the
          // architecture - dimming the thing you are reasoning about is what
          // made a sheet feel like drawing on glass over the map.
          ...(isFloorContextNode ? { pointerEvents: 'auto' as const } : {}),
        },
        domAttributes: {
          ...sheetNode.domAttributes,
          'data-sheet-placed': isSheetPlaced ? 'true' : undefined,
          // An agent's proposal waits for you; a rejected one stays visible but faded.
          'data-proposal': planned && planned.approvalStatus !== 'approved' ? planned.approvalStatus
            : pendingMoveIds.has(sheetNode.id) || sheetRenames.get(sheetNode.id)?.pending ? 'pending' : undefined,
          'data-proposal-kind': planned ? undefined
            : [pendingMoveIds.has(sheetNode.id) ? 'move' : '', sheetRenames.get(sheetNode.id)?.pending ? 'rename' : ''].filter(Boolean).join(' ') || undefined,
          'data-sheet-change': planned ? 'addition' : sheetChangeOf(isMoved, sheetRenames.has(sheetNode.id)),
        },
        draggable: activeNodeIds.has(sheetNode.id) && nodeOpacity > 0.1,
        // Context nodes are selectable so they can be inspected, connected and
        // included in a prompt. Only repositioning is reserved for the sheet's
        // own members, since a sheet-local move has to persist as an override.
        selectable: nodeOpacity > 0.1,
        zIndex: sheetNode.id.startsWith('planned:') ? 10000 : sheetNode.zIndex,
      }
    })
    return morphed
  }, [sheetModel, sheetPreparation.value, effectiveElements, sheetOpinionIds, activeElementByNodeId, systems, files, infraNodes, dependencies, overlayPlanned, visiblePlannedByNodeId, activePlannedByNodeId, activeNodeIds, workspaceIdForOverlay, setInfraPickerNode, sheetEffectiveLayouts, sheetMoves, pendingMoveIds, floorLayouts, sheetRenames])

  const [sheetVisibility, setSheetVisibility] = useState<{ source: Node[]; nodes: Node[] } | null>(null)
  useEffect(() => { if (!sheetBaseNodes) setSheetVisibility(null) }, [sheetBaseNodes])
  const sheetBaseNodesRef = useRef(sheetBaseNodes)
  sheetBaseNodesRef.current = sheetBaseNodes
  const visibleSheetNodes = useMemo(() => sheetBaseNodes
    ? sheetVisibility?.source === sheetBaseNodes ? sheetVisibility.nodes
      : applyZoomVisibility(sheetBaseNodes, currentZoomRef.current)
    : null, [sheetBaseNodes, sheetVisibility])
  const sheetPresentation = useRef(createSheetPresentation())
  // React Flow clears handleBounds when a controlled node drops `measured`.
  // Its culler then force-mounts every such node, including off-screen cards.
  // Measurements are presentation, not an interaction snapshot or saved layout.
  const [sheetMeasurements, setSheetMeasurements] = useState(new Map<string, Node['measured']>())
  useEffect(() => setSheetMeasurements(new Map()), [overlaySheetId, sceneProjectId])
  const composedNodes = useMemo(() => {
    const presented = visibleSheetNodes ? sheetPresentation.current(visibleSheetNodes, rfNodes, selectedIdsRef.current, activeNodeIds, sheetMeasurements) : rfNodes
    return isTransitioningLayout
      ? presented.map(node => ({ ...node, style: { ...node.style, transition: 'transform 500ms cubic-bezier(0.16, 1, 0.3, 1), width 500ms cubic-bezier(0.16, 1, 0.3, 1), height 500ms cubic-bezier(0.16, 1, 0.3, 1), opacity 400ms ease-in-out' } }))
      : presented
  }, [visibleSheetNodes, rfNodes, selectionRevision, isTransitioningLayout, activeNodeIds, sheetMeasurements])

  const [sheetInteractionNodes, setSheetInteractionNodes] = useState<Node[] | null>(null)
  useEffect(() => setSheetInteractionNodes(null), [overlaySheetId, visibleSheetIds.join('|')])
  const displayNodes = sheetInteractionNodes ?? composedNodes
  const displayNodesRef = useRef<Node[]>(displayNodes)
  displayNodesRef.current = displayNodes
  const relationshipEndpoints = useMemo(() => {
    const edge = overlayPlannedEdges.find(edge => edge.id === focusedRelationship && edge.approvalStatus !== 'rejected')
    if (!edge) return []
    const source = edge.srcLive ?? (edge.srcPlanned ? `planned:${edge.srcPlanned}` : '')
    const target = edge.dstLive ?? (edge.dstPlanned ? `planned:${edge.dstPlanned}` : '')
    return source && target && (selectedNodeId === source || selectedNodeId === target) ? [source, target] : []
  }, [overlayPlannedEdges, focusedRelationship, selectedNodeId])
  const navigableDisplayNodes = useMemo(() => {
    let nodes = revealNodePath(displayNodes, selectedNodeId)
    for (const id of relationshipEndpoints) nodes = revealNodePath(nodes, id)
    return relationshipEndpoints.length ? nodes.map(node => relationshipEndpoints.includes(node.id)
      ? { ...node, data: { ...node.data, relationshipFocus: true } } : node) : nodes
  }, [displayNodes, selectedNodeId, relationshipEndpoints])
  useEffect(() => {
    if (relationshipEndpoints.length !== 2) return
    // Canonical bounds include off-screen nodes before DOM measurement. A
    // source-only flight or waiting for both cards to mount can strand the
    // destination outside the viewport indefinitely.
    const frame = requestAnimationFrame(() => {
      const rects = absoluteRects(displayNodesRef.current)
      const pair = relationshipEndpoints.flatMap(id => rects.get(id) ? [rects.get(id)!] : [])
      if (pair.length !== 2) return
      const left = Math.min(...pair.map(rect => rect.x))
      const top = Math.min(...pair.map(rect => rect.y))
      const right = Math.max(...pair.map(rect => rect.x + rect.width))
      const bottom = Math.max(...pair.map(rect => rect.y + rect.height))
      const canvas = reactFlowStore.getState()
      canvas.domNode?.dispatchEvent(new Event('ambio:camera-navigation', { bubbles: true }))
      void setViewport(getViewportForBounds({ x: left, y: top, width: right - left, height: bottom - top }, canvas.width, canvas.height, MIN_CANVAS_ZOOM, 1.6, 0.35), { duration: 850 })
    })
    return () => cancelAnimationFrame(frame)
  }, [relationshipEndpoints, reactFlowStore, setViewport])

  /**
   * Record a new selection and repaint the scene from it in one step.
   *
   * Selection reaches the screen by several routes - the layout projection, the
   * sheet projection, React Flow's own select changes - and any gesture that
   * updated only some of them left the highlight disagreeing with what the next
   * drag would actually pick up. Every deliberate selection change goes through
   * here so the set and the pixels can never drift apart. The sheet snapshot is
   * only touched when it already exists; creating one here would freeze the
   * scene outside a gesture.
   */
  const applySelection = useCallback((next: Set<string>) => {
    commitSelection(next)
    setRfNodes(current => stampSelection(current, next))
    setSheetInteractionNodes(current => current && stampSelection(current, next))
  }, [commitSelection])
  // The investigation run on screen: its watched functions get callouts. A
  // callout sits on the file once it is visible, and on its closed system,
  // naming the file, before then. Revealing the file inside the closed system
  // instead covered the system's own title.
  const runCalloutList = useMemo(
    () => (isolatedScene ? [] : runCallouts(caseRun)),
    [caseRun, isolatedScene],
  )
  const livingRevealIds = useMemo(() => {
    // A node appears only for its own stage: first the edited origin, then the
    // impact target. The top-layer flow can route to hidden authored geometry
    // without prematurely revealing both endpoints.
    return new Set(Object.keys(nodeFx))
  }, [nodeFx])
  // Live FX are a projection, not mutable canvas state. Deriving them here
  // means layout, selection, zoom, and sheet updates cannot accidentally
  // overwrite an in-flight edit signal in rfNodes.
  const livingDisplayNodes = useMemo(
    () => surfaceLivingNodeFx(
      stampAgentPresence(navigableDisplayNodes, activeWorkSessions),
      nodeFx,
      livingVisibilityOptions,
      livingRevealIds,
    ),
    [navigableDisplayNodes, activeWorkSessions, nodeFx, livingVisibilityOptions, livingRevealIds],
  )

  // ── Morning Delta review ────────────────────────────────────────────────
  // Marks are a projection over the living nodes, layered the same way live FX
  // are: reviewing never mutates canvas state, so ending a review restores the
  // map exactly and an incoming live edit still animates on top of a mark.
  const deltaKnownNodeIds = useMemo(() => {
    const ids = new Set<string>()
    if (!deltaReviewing || !delta) return ids
    for (const file of files) ids.add(file.id)
    for (const system of systems) ids.add(system.id)
    return ids
  }, [files, systems, deltaReviewing, delta])
  const deltaReview = useMemo(
    () => buildDeltaReview(deltaReviewing ? delta : null, deltaKnownNodeIds),
    [delta, deltaReviewing, deltaKnownNodeIds],
  )
  const deltaFocusTargets = useMemo(() => {
    const claims = [...deltaReview.claims, ...deltaReview.internalClaims]
    const index = clampClaimCursor(claims, deltaCursor)
    return claimFocusTargets(index >= 0 ? claims[index] : null, deltaKnownNodeIds)
  }, [deltaReview, deltaCursor, deltaKnownNodeIds])
  const reviewDisplayNodes = useMemo(
    () => applyDeltaMarks(livingDisplayNodes, deltaReview, deltaFocusTargets),
    [livingDisplayNodes, deltaReview, deltaFocusTargets],
  )
  // Agent attention: "my agent is reading here, right now". A projection like
  // every other live signal, and the only visual the action stream owns -
  // writes and traces are animated by the semantic stream that already
  // broadcasts them, never twice. See agentActionVisual.ts.
  const surfacedAttention = useMemo(
    () => surfaceAgentAttention(reviewDisplayNodes, agentAttention, livingVisibilityOptions),
    [reviewDisplayNodes, agentAttention, livingVisibilityOptions],
  )
  const attentionNodes = useMemo(
    () => applyAgentAttention(reviewDisplayNodes, surfacedAttention),
    [reviewDisplayNodes, surfacedAttention],
  )
  // Selecting a claim is explicit navigation, so it frames immediately rather
  // than deferring to the idle-aware growth fit.
  //
  // The bounds matter more than the fit. DELTA_REVIEW_MIN_ZOOM stops a claim
  // about two small nodes from dropping the camera at an unreadable scale, and
  // the max keeps a two-system boundary from filling the screen with one box.
  // A claim with nothing on canvas (a tombstone) leaves the camera alone
  // instead of jumping somewhere arbitrary.
  const deltaFocusKey = deltaFocusTargets.join('|')
  useEffect(() => {
    if (!deltaReviewing || !deltaFocusKey) return
    void fitView({
      nodes: deltaFocusKey.split('|').map(id => ({ id })),
      padding: DELTA_REVIEW_PADDING,
      duration: 620,
      minZoom: DELTA_REVIEW_MIN_ZOOM,
      maxZoom: DELTA_REVIEW_MAX_ZOOM,
    })
  }, [deltaReviewing, deltaFocusKey, fitView])
  const updateInteractiveNodes = useCallback((updater: (nodes: Node[]) => Node[]) => {
    if (useSheetStore.getState().activeSheetId) {
      setSheetInteractionNodes(current => updater(current ?? displayNodesRef.current))
    } else {
      setRfNodes(updater)
    }
  }, [])

  const displayEdges = useMemo(() => {
    const surfacedRfEdges = withFacingHandles(rfEdges, displayNodes)
    if (visibleLayers.length === 0) return surfacedRfEdges
    const visibleIds = new Set(displayNodes.filter(n => n.style?.opacity !== 0).map(n => n.id))
    // A sheet's relationships route like the map's own edges (facing sides,
    // right angles) rather than as curves through the boxes between. One an
    // agent proposed is dashed amber until confirmed; a rejected one is gone.
    const plannedRf: Edge[] = withFacingHandles(overlayPlannedEdges
      .filter(e => e.approvalStatus !== 'rejected')
      .filter(edge => {
        if (allSheetRelationships) return true
        if (relationshipEndpoints.length) return edge.id === focusedRelationship
        const source = edge.srcLive ?? (edge.srcPlanned ? `planned:${edge.srcPlanned}` : '')
        const target = edge.dstLive ?? (edge.dstPlanned ? `planned:${edge.dstPlanned}` : '')
        return selectedIdsRef.current.has(source) || selectedIdsRef.current.has(target)
      })
      .map(e => ({
        id: `pedge:${e.id}`,
        type: 'orthogonal',
        source: e.srcPlanned ? `planned:${e.srcPlanned}` : (e.srcLive ?? ''),
        target: e.dstPlanned ? `planned:${e.dstPlanned}` : (e.dstLive ?? ''),
        animated: false,
        markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color: e.approvalStatus === 'pending' ? '#8b6429' : 'var(--accent)' },
        style: e.approvalStatus === 'pending'
          ? { strokeDasharray: '5 4', stroke: '#8b6429', strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' as const }
          : { strokeDasharray: '6 4', stroke: 'var(--accent)', strokeWidth: 1.5, vectorEffect: 'non-scaling-stroke' as const },
        zIndex: 10000,
      }))
      .filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target)), displayNodes)
    return [
      ...surfacedRfEdges.map(e => visibleIds.has(e.source) && visibleIds.has(e.target) && (allSheetRelationships || (!relationshipEndpoints.length && (selectedIdsRef.current.has(e.source) || selectedIdsRef.current.has(e.target))))
        ? e
        : { ...e, style: { ...e.style, opacity: 0 }, selectable: false }),
      ...plannedRf,
    ]
  }, [rfEdges, visibleLayers, overlayPlannedEdges, displayNodes, allSheetRelationships, focusedRelationship, relationshipEndpoints, selectionRevision])

  /**
   * Was this gesture released over the unclassified bin?
   *
   * The bin is pinned to the viewport, not placed in world space, so this is a
   * screen-space hit test against the rendered element rather than anything the
   * layout engine knows about. Reading the live rect means the test cannot
   * drift out of sync with where the bin actually is.
   */
  /**
   * Is this screen point over somewhere a Floor node can be dropped to unsort it?
   *
   * The closed bin and the open bin window are both valid targets: once the
   * window is open it is the obvious place to drop, and refusing it because the
   * small tile is now behind it would be a trap.
   */
  const pointOverBinTarget = useCallback((point: { x: number; y: number } | null): boolean => {
    if (readOnly || isolatedScene || !point) return false
    const targets = document.querySelectorAll('[data-bin="unclassified"], [data-bin-window]')
    for (const target of targets) {
      const rect = target.getBoundingClientRect()
      if (point.x >= rect.left && point.x <= rect.right
        && point.y >= rect.top && point.y <= rect.bottom) return true
    }
    return false
  }, [readOnly, isolatedScene])

  const droppedOnUnclassifiedBin = useCallback(
    (event: React.MouseEvent | MouseEvent | TouchEvent): boolean =>
      pointOverBinTarget(pointerOf(event)),
    [pointOverBinTarget],
  )

  const systemAtScreenPoint = useCallback((
    clientX: number,
    clientY: number,
    explain = false,
  ): string | null => {
    const point = screenToFlowPosition({ x: clientX, y: clientY })
    const systemIds = new Set(systems.map(system => system.id))
    let target: { id: string; depth: number } | null = null
    const examined: Array<Record<string, unknown>> = []
    for (const node of rfNodesRef.current) {
      if (!systemIds.has(node.id)) continue
      const internal = getInternalNode(node.id)
      const origin = internal?.internals.positionAbsolute ?? node.position
      const width = Number(node.style?.width ?? node.measured?.width ?? 0)
      const height = Number(node.style?.height ?? node.measured?.height ?? 0)
      const hit = point.x >= origin.x && point.x <= origin.x + width
        && point.y >= origin.y && point.y <= origin.y + height
      if (explain && binDragDebug() && examined.length < 6) {
        examined.push({ id: node.id, x: origin.x, y: origin.y, width, height, hit })
      }
      if (!hit) continue
      const depth = Number((node.data as Record<string, unknown> | undefined)?.depth ?? 0)
      if (!target || depth >= target.depth) target = { id: node.id, depth }
    }
    if (explain && binDragDebug()) {
      console.log('[bins] systemAtScreenPoint', {
        client: { x: clientX, y: clientY },
        flow: point,
        systemsInScene: systemIds.size,
        nodesInScene: rfNodesRef.current.length,
        systemNodesFound: rfNodesRef.current.filter(n => systemIds.has(n.id)).length,
        firstFew: examined,
        result: target?.id ?? null,
      })
    }
    return target?.id ?? null
  }, [screenToFlowPosition, systems, getInternalNode])

  /**
   * Move a file into a system, or out of every system when null.
   *
   * Optimistic, because the file must leave the bin on the same frame the
   * pointer released it. A failed write puts it back rather than leaving the
   * canvas asserting a placement the daemon rejected.
   */
  const placeFile = useCallback((fileId: string, systemId: string | null) => {
    holdCameraForGesture()
    const state = useGraphStore.getState()
    const workspaceId = state.currentProject?.id
    const known = state.files.find(file => file.id === fileId)
    const previous = known?.systemId ?? null
    if (binDragDebug()) {
      console.log('[bins] placeFile', {
        fileId, systemId, workspaceId, previous,
        fileIsKnownToTheStore: !!known,
        willWrite: !!workspaceId && previous !== systemId,
      })
    }
    if (!workspaceId || previous === systemId) return
    useGraphStore.setState(current => ({
      files: current.files.map(file => file.id === fileId ? { ...file, systemId } : file),
    }))
    void apiAssignFile(fileId, systemId, workspaceId).catch(error => {
      console.error('[bins] could not move file', error)
      useGraphStore.setState(current => ({
        files: current.files.map(file => file.id === fileId ? { ...file, systemId: previous } : file),
      }))
    })
  }, [holdCameraForGesture])

  /**
   * Put a file on the Floor at a screen point without giving it a system.
   *
   * The row itself is the statement: geometry at the Floor root exists only
   * because someone put it there, which is what distinguishes a file placed on
   * the map from one still waiting in the bin.
   */
  const placeFileLoose = useCallback((fileId: string, clientX: number, clientY: number) => {
    holdCameraForGesture()
    const workspaceId = useGraphStore.getState().currentProject?.id
    if (!workspaceId) return
    const point = screenToFlowPosition({ x: clientX, y: clientY })
    const layout = {
      nodeId: fileId,
      nodeType: 'file' as const,
      parentNodeId: null,
      parentNodeType: null,
      containmentKind: 'root' as const,
      // Dropped by the cursor, so the cursor marks the middle of the card.
      positionX: point.x - BASE_FILE_W / 2,
      positionY: point.y - BASE_FILE_H / 2,
      width: BASE_FILE_W,
      height: BASE_FILE_H,
      scale: 1,
      interiorScale: 1,
    }
    useGraphStore.setState(state => ({
      floorLayouts: [
        ...state.floorLayouts.filter(item => !(item.nodeType === 'file' && item.nodeId === fileId)),
        { ...layout, workspaceId, updatedAt: Date.now() },
      ],
    }))
    void apiSaveFloorLayouts(workspaceId, [layout]).catch(error => {
      console.error('[bins] could not place file on the Floor', error)
      useGraphStore.setState(state => ({
        floorLayouts: state.floorLayouts.filter(
          item => !(item.nodeType === 'file' && item.nodeId === fileId),
        ),
      }))
    })
  }, [screenToFlowPosition, holdCameraForGesture])

  // The Floor answers "which system is under this point?" for the bin canvas,
  // which cannot know that itself. Registered only by the real Floor: an
  // isolated scene has no authority over the workspace.
  useEffect(() => {
    if (isolatedScene || readOnly) return
    return registerFloorDropTarget({
      systemAt: systemAtScreenPoint,
      place: placeFile,
      placeLoose: placeFileLoose,
      element: () => canvasRootRef.current,
    })
  }, [isolatedScene, readOnly, systemAtScreenPoint, placeFile, placeFileLoose])

  /**
   * Resolve a bin drag, wherever the pointer let go.
   *
   * Idempotent: React Flow's own `onNodeDragStop` still fires when the gesture
   * ends inside the bin, so both paths call this and the first one wins.
   */
  /** Whether the pointer is currently over a bin, so enter/leave fire once. */
  const binCrossingRef = useRef(false)
  const binDragNodeRef = useRef<string | null>(null)
  const finishBinDrag = useCallback((clientX: number, clientY: number, source: string) => {
    const nodeId = binDragNodeRef.current
    if (!nodeId) return
    binDragNodeRef.current = null
    hideBinGhost()
    const placed = dropOnFloorAt(nodeId, clientX, clientY)
    if (binDragDebug()) {
      console.debug('[bins] drag ended', {
        source, nodeId, clientX, clientY, placed,
        systemUnderPointer: systemAtFloorPoint(clientX, clientY),
      })
    }
    if (placed) return
    // Refused, or released back inside the bin. The node keeps whatever
    // position the gesture left it at, which for a drag that went outside the
    // window is somewhere the window clips - so it would simply be gone. Put it
    // back; the bin owns no geometry worth keeping.
    const origin = dragPositionRef.current.get(nodeId)
    if (origin) {
      setRfNodes(current => current.map(item =>
        item.id === nodeId ? { ...item, position: { ...origin } } : item))
    }
  }, [holdCameraForGesture])

  const beginBinDrag = useCallback((nodeId: string) => {
    binDragNodeRef.current = nodeId
    const onPointerUp = (event: PointerEvent) => {
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      finishBinDrag(event.clientX, event.clientY, 'window-pointerup')
    }
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
    if (binDragDebug()) console.debug('[bins] drag started', { nodeId })
  }, [finishBinDrag])

  /**
   * Send a file back to the bin: out of its system, and out of any placement it
   * had on the bare Floor.
   *
   * Both have to go. Clearing the system alone would leave a loose file still
   * holding root geometry, which is exactly what marks it as placed - so it
   * would sit on the Floor claiming to be sorted while the bin said otherwise.
   */
  const unclassifyDraggedFile = useCallback((nodeId: string) => {
    holdCameraForGesture()
    const state = useGraphStore.getState()
    const workspaceId = state.currentProject?.id
    const file = state.files.find(item => item.id === nodeId)
    // Systems and infra have no "unclassified" state to fall into, so the bin
    // simply refuses them rather than pretending the drop did something.
    if (!workspaceId || !file) return
    const previousSystem = file.systemId ?? null
    const previousLayouts = state.floorLayouts
    if (!previousSystem && !previousLayouts.some(
      item => item.nodeType === 'file' && item.nodeId === nodeId,
    )) return

    useGraphStore.setState(current => ({
      files: current.files.map(item => item.id === nodeId ? { ...item, systemId: null } : item),
      floorLayouts: current.floorLayouts.filter(
        item => !(item.nodeType === 'file' && item.nodeId === nodeId),
      ),
    }))
    const restore = (error: unknown) => {
      console.error('[bins] could not return file to the bin', error)
      useGraphStore.setState(current => ({
        files: current.files.map(item =>
          item.id === nodeId ? { ...item, systemId: previousSystem } : item),
        floorLayouts: previousLayouts,
      }))
    }
    void Promise.all([
      previousSystem ? apiAssignFile(nodeId, null, workspaceId) : Promise.resolve(),
      apiRemoveFloorLayouts(workspaceId, [{ nodeId, nodeType: 'file' }]),
    ]).catch(restore)
  }, [])

  /**
   * Resolve a Floor drag that ended over a bin, wherever the pointer let go.
   *
   * The mirror of the bin's problem, and the same cure. The bin window is
   * portalled to the document, so releasing over it means releasing over a
   * different React Flow instance's pane - whose own pointer handling swallows
   * the event the Floor's drag terminates on. The node stayed on the cursor
   * until it wandered back over the Floor, exactly as it did in reverse.
   *
   * So the Floor owns this terminating event too. Idempotent with React Flow's
   * own dragStop, whichever arrives first.
   */
  const floorBinDragRef = useRef<string | null>(null)
  const finishFloorBinDrag = useCallback((clientX: number, clientY: number, source: string) => {
    binCrossingRef.current = false
    reactFlowStore.setState({ autoPanOnNodeDrag: true })
    const nodeId = floorBinDragRef.current
    if (!nodeId) return false
    floorBinDragRef.current = null
    hideBinGhost()
    const overBin = pointOverBinTarget({ x: clientX, y: clientY })
    if (binDragDebug()) {
      console.log('[bins] floor drag ended', { source, nodeId, clientX, clientY, overBin })
    }
    if (!overBin) return false
    unclassifyDraggedFile(nodeId)
    return true
  }, [pointOverBinTarget, unclassifyDraggedFile, reactFlowStore])

  const beginFloorBinDrag = useCallback((nodeId: string) => {
    floorBinDragRef.current = nodeId
    const onPointerUp = (event: PointerEvent) => {
      window.removeEventListener('pointerup', onPointerUp, true)
      window.removeEventListener('pointercancel', onPointerUp, true)
      finishFloorBinDrag(event.clientX, event.clientY, 'window-pointerup')
    }
    window.addEventListener('pointerup', onPointerUp, true)
    window.addEventListener('pointercancel', onPointerUp, true)
  }, [finishFloorBinDrag])

  /**
   * Innermost system under a screen point, or null for bare canvas. Deepest
   * frame wins, matching how a node drop resolves its parent rather than
   * whichever container the hit test happens to reach first.
   */

  const stencilCreationPending = useRef(false)
  const [creatingStencil, setCreatingStencil] = useState(false)
  const [stencilFocusId, setStencilFocusId] = useState<string | null>(null)
  const stencilScene = useCallback(() => {
    const nodes = displayNodesRef.current
    const positions = new Map(nodes.map(node => [node.id,
      getInternalNode(node.id)?.internals.positionAbsolute ?? node.position]))
    return { nodes, positions }
  }, [getInternalNode])

  const createStencil = useCallback(async (stencil: StencilDef, point: { x: number; y: number }, target: Node | null, focusCreated = false) => {
    if (readOnly || reviewMode || !overlaySheetId || stencilCreationPending.current) return
    stencilCreationPending.current = true
    setCreatingStencil(true)
    let createdId: string | null = null
    try {
      const store = useSheetStore.getState()
      if (stencil.shape === 'note') {
        await store.createFloatingNote(workspaceIdForOverlay, overlaySheetId, 'New note - double-click to edit', point.x, point.y)
        return
      }
      const id = crypto.randomUUID()
      const { nodes, positions } = stencilScene()
      const { plan, layout } = planStencilPlacement({
        id: `planned:${id}`, stencil, point, target, nodes, positions,
        editableIds: activeNodeIds, workspaceId: workspaceIdForOverlay, layouts: sheetEffectiveLayouts,
        systemIds: sheetSystemIds, fileIds: sheetFileIds, infraIds: sheetInfraIds,
      })
      const created = await store.createPlanned(workspaceIdForOverlay, overlaySheetId, {
        id, name: `New${stencil.label.replace(/\s/g, '')}`, kind: stencil.kind,
        shape: stencil.shape as 'box' | 'folder' | 'cylinder' | 'hexagon',
        parentSystemId: layout.parentNodeId,
        positionX: layout.positionX, positionY: layout.positionY,
        width: layout.width, height: layout.height, scale: layout.scale,
      })
      if (!created) throw new Error('The new node was not returned by the server.')
      createdId = created.id
      await store.updateLayoutsBatch(workspaceIdForOverlay, overlaySheetId, plan.updates)
      if (useSheetStore.getState().activeSheetId === overlaySheetId) {
        setSelectedNode(`planned:${created.id}`)
        if (focusCreated) setStencilFocusId(`planned:${created.id}`)
        if (stencil.kind === 'infra') setInfraPickerNode(created.id)
      }
    } catch (error) {
      console.error('[sheets] stencil creation failed:', error)
      raiseFailure(`sheet-create:${overlaySheetId}`, createdId ? 'Node created, but its placement could not be saved' : 'Could not create the node',
        error instanceof Error ? error.message : String(error))
    } finally {
      stencilCreationPending.current = false
      setCreatingStencil(false)
    }
  }, [readOnly, reviewMode, overlaySheetId, workspaceIdForOverlay, stencilScene, activeNodeIds,
    sheetEffectiveLayouts, sheetSystemIds, sheetFileIds, sheetInfraIds, setSelectedNode, setInfraPickerNode])

  // New System Here (Floor right-click): a system with no code yet is a plan,
  // so it is drawn on a new sheet, in the same place, ready to name and send.
  // The sheet opens first; the system is placed through the palette's own
  // path once the sheet is the active surface.
  const pendingNewSystem = useRef<{ sheetId: string; point: { x: number; y: number } } | null>(null)
  // Deleting code is drawn, not done: a sheet proposing the removal, opened
  // and attached to a work order with the instruction written. Nothing is
  // deleted until an agent does it, and the comparison checks that it did.
  const startRemovalSheet = useCallback(async (nodeId: string, label: string, instruction: string) => {
    const workspaceId = useGraphStore.getState().currentProject?.id
    if (!workspaceId) return
    try {
      const store = useSheetStore.getState()
      const name = untakenSheetName(store.sheets, `Remove ${label}`)
      const sheet = await store.createSheet(workspaceId, name, `Take ${label} out of the code`, [])
      await store.openSheet(workspaceId, sheet.id)
      await proposeSheetRemoval(workspaceId, sheet.id, nodeId)
      window.dispatchEvent(new CustomEvent('ambio:open-agent-dispatch', { detail: { sheetId: sheet.id, note: instruction } }))
    } catch (error) {
      raiseFailure('removal-sheet', 'Could not draw the removal', error instanceof Error ? error.message : String(error))
    }
  }, [])

  const startDependencySheet = useCallback(async (sourceId: string, targetId: string) => {
    const graph = useGraphStore.getState()
    const workspaceId = graph.currentProject?.id
    if (!workspaceId) return
    const label = (id: string) => graph.systems.find(system => system.id === id)?.name
      ?? graph.files.find(file => file.id === id)?.relPath
      ?? graph.infraNodes.find(node => node.id === id)?.name
    const from = label(sourceId)
    const to = label(targetId)
    if (!from || !to) return
    try {
      const store = useSheetStore.getState()
      const sheet = await store.createSheet(workspaceId, untakenSheetName(store.sheets, `${from} uses ${to}`), `${from} should depend on ${to}`, [])
      await store.openSheet(workspaceId, sheet.id)
      await store.createPlannedEdge(workspaceId, sheet.id, { kind: 'DEPENDS_ON', srcLive: sourceId, dstLive: targetId })
      window.dispatchEvent(new CustomEvent('ambio:open-agent-dispatch', {
        detail: { sheetId: sheet.id, note: `Make ${from} use ${to}, as drawn on the attached sheet. Keep the dependency in that direction only.` },
      }))
    } catch (error) {
      raiseFailure('dependency-sheet', 'Could not draw the dependency', error instanceof Error ? error.message : String(error))
    }
  }, [])

  const startNewSystemSheet = useCallback(async (point: { x: number; y: number }) => {
    const workspaceId = useGraphStore.getState().currentProject?.id
    if (!workspaceId) return
    try {
      const store = useSheetStore.getState()
      const sheet = await store.createSheet(workspaceId, 'New system', 'A system to build: name it, then send it to an agent', [])
      pendingNewSystem.current = { sheetId: sheet.id, point }
      await store.openSheet(workspaceId, sheet.id)
    } catch (error) {
      pendingNewSystem.current = null
      raiseFailure('new-system-sheet', 'Could not start a new system', error instanceof Error ? error.message : String(error))
    }
  }, [])
  useEffect(() => {
    const pending = pendingNewSystem.current
    if (!pending || overlaySheetId !== pending.sheetId) return
    pendingNewSystem.current = null
    const systemStencil = STENCILS.find(stencil => stencil.kind === 'system')
    if (!systemStencil) return
    void createStencil(systemStencil, pending.point, null, true).then(() => {
      raiseNotice('new-system-sheet', 'New system drawn on a sheet',
        'Name it, add what it should hold, then send the sheet to an agent with ↗ in the sheet rail.')
    })
  }, [overlaySheetId, createStencil])

  const onPaletteCreate = useCallback((stencil: StencilDef) => {
    const { nodes, positions } = stencilScene()
    const selected = selectedIdsRef.current.size === 1 ? nodes.find(node => selectedIdsRef.current.has(node.id)) : null
    const target = selected?.type === 'system' ? selected : nodes.find(node => node.id === selected?.parentId && node.type === 'system')
    const eligibleTarget = target && activeNodeIds.has(target.id) ? target : null
    const canvas = canvasRootRef.current?.getBoundingClientRect()
    if (!canvas) return
    const point = eligibleTarget
      ? stencilStartInFrame(eligibleTarget, positions.get(eligibleTarget.id)!)
      : screenToFlowPosition({ x: canvas.left + canvas.width / 2, y: canvas.top + canvas.height / 2 })
    void createStencil(stencil, point, eligibleTarget, !eligibleTarget)
  }, [stencilScene, activeNodeIds, screenToFlowPosition, createStencil])

  // Stencil creation and existing-node moves share one placement engine.
  const onOverlayDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('application/ambio-stencil')) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'copy'
    } else if (e.dataTransfer.types.includes(BINNED_FILE_MIME)) {
      e.preventDefault()
      e.stopPropagation()
      e.dataTransfer.dropEffect = 'move'
    }
  }, [])

  /**
   * A file dragged out of the unclassified bin onto a system joins it.
   *
   * The system is read from what is under the cursor rather than from a
   * selection, because the gesture already said where it goes. Dropping on bare
   * canvas is deliberately a no-op: the Floor root is not a system, so there is
   * nothing there for the file to join and silently leaving it unsorted is
   * more honest than inventing a home for it.
   */
  const onBinnedFileDrop = useCallback((e: React.DragEvent): boolean => {
    const raw = e.dataTransfer.getData(BINNED_FILE_MIME)
    if (!raw || readOnly || reviewMode) return false
    e.preventDefault()
    e.stopPropagation()
    let fileId: string
    try {
      fileId = (JSON.parse(raw) as { fileId: string }).fileId
    } catch (error) {
      console.error('[bins] ignored invalid binned-file payload', error)
      return true
    }
    const systemId = systemAtScreenPoint(e.clientX, e.clientY)
    if (systemId) placeFile(fileId, systemId)
    return true
  }, [readOnly, reviewMode, systemAtScreenPoint, placeFile])
  const onOverlayDrop = useCallback((e: React.DragEvent) => {
    if (readOnly) return
    if (onBinnedFileDrop(e)) return
    const raw = e.dataTransfer.getData('application/ambio-stencil')
    if (!raw || !overlaySheetId) return
    e.preventDefault()
    e.stopPropagation()
    let stencil: StencilDef
    try {
      stencil = JSON.parse(raw) as StencilDef
    } catch (error) {
      console.error('[sheets] ignored invalid stencil payload', error)
      return
    }
    const pos = screenToFlowPosition({ x: e.clientX, y: e.clientY })
    const { nodes, positions } = stencilScene()
    const target = stencilTargetAt(pos, nodes, positions, activeNodeIds)
    void createStencil(stencil, pos, target)
  }, [readOnly, overlaySheetId, screenToFlowPosition, onBinnedFileDrop, stencilScene, activeNodeIds, createStencil])

  // The node a connection was drawn FROM is its source, whichever of the
  // overlapping handles the pointer happened to grab.
  const connectionOrigin = useRef<string | null>(null)
  const onConnectStart = useCallback<OnConnectStart>((_event, params) => {
    connectionOrigin.current = params.nodeId
  }, [])
  const drawnDirection = (conn: Connection): Connection => {
    const origin = connectionOrigin.current
    connectionOrigin.current = null
    return origin && origin === conn.target ? { ...conn, source: conn.target, target: conn.source } : conn
  }

  const onConnectPlanned = useCallback((drawn: Connection) => {
    const conn = drawnDirection(drawn)
    if (!overlaySheetId || !conn.source || !conn.target) return
    const src = conn.source.startsWith('planned:') ? { srcPlanned: conn.source.slice(8) } : { srcLive: conn.source }
    const dst = conn.target.startsWith('planned:') ? { dstPlanned: conn.target.slice(8) } : { dstLive: conn.target }
    // Between two live nodes the connection is a proposal too: "this should
    // depend on that", met once the code does (relationshipPresent in archd).
    if (conn.source === conn.target) return
    void useSheetStore.getState().createPlannedEdge(workspaceIdForOverlay, overlaySheetId, {
      kind: 'DEPENDS_ON', ...src, ...dst,
    })
  }, [overlaySheetId, workspaceIdForOverlay])

  // On the Floor a new dependency is code, so drawing one starts a work order:
  // a sheet proposing it, opened and attached to the send dialog.
  const onConnectFloor = useCallback((drawn: Connection) => {
    const conn = drawnDirection(drawn)
    if (!conn.source || !conn.target || conn.source === conn.target) return
    void startDependencySheet(conn.source, conn.target)
  }, [startDependencySheet])
  const [isTidying, setIsTidying] = useState(false)
  // Focused-subgraph mode: when a trace or runtime session is active, dim the
  // nodes that are off the active path so the investigation stays legible on a
  // large graph. User-toggleable; on by default.
  const [focusEnabled, setFocusEnabled] = useState(true)
  // Bumped whenever the layout is fully rebuilt, so overlay effects restamp.
  const [layoutVersion, setLayoutVersion] = useState(0)

  const tidyFrame = useCallback(async () => {
    const all = displayNodesRef.current
    const selectedContainer = selectedNodeId
      ? all.find(node => node.id === selectedNodeId && node.type === 'system')
      : undefined
    const scopeId = selectedContainer?.id ?? null
    const children = all.filter(node => (node.parentId ?? null) === scopeId && node.draggable !== false)
      .sort((a, b) => a.id.localeCompare(b.id))
    if (children.length === 0) return
    setIsTidying(true)
    try {
      const containerData = selectedContainer?.data as Record<string, unknown> | undefined
      const parentScale = selectedContainer ? Number(containerData?.worldScale ?? 1) : 1
      // Children are authored in the container's CONTENT space, so every child
      // quantity converts through contentScale while the container's own box
      // converts through its own world scale.
      const parentContentScale = selectedContainer ? Number(containerData?.contentScale ?? parentScale) : 1
      const parentInterior = selectedContainer ? Number(containerData?.interiorScale ?? 1) : 1
      const parentCanonical = selectedContainer ? {
        width: Number(selectedContainer.style?.width ?? selectedContainer.measured?.width ?? 1) / parentScale,
        height: Number(selectedContainer.style?.height ?? selectedContainer.measured?.height ?? 1) / parentScale,
      } : { width: 2600, height: 1800 }
      // The projected base is canonical already - dividing by world scale here
      // would reintroduce exactly the coupling the isolation removes.
      const ownContent = scopeId
        ? contentRectFor(parentCanonical, Number(containerData?.depth ?? 0), parentScale)
        : { x: 80, y: 80, width: parentCanonical.width - 160, height: parentCanonical.height - 160 }
      // Express the content box in the space the children are actually stored in.
      const content = {
        x: ownContent.x / parentInterior,
        y: ownContent.y / parentInterior,
        width: ownContent.width / parentInterior,
        height: ownContent.height / parentInterior,
      }
      const packed = packFrame(
        children.map(child => ({
          id: child.id,
          width: Number(child.style?.width ?? child.measured?.width ?? BASE_FILE_W) / parentContentScale,
          height: Number(child.style?.height ?? child.measured?.height ?? BASE_FILE_H) / parentContentScale,
        })),
        {
          baseGap: FRAME_ITEM_GAP,
          aspect: content.width / Math.max(1, content.height),
        },
      )
      const positions = new Map<string, { x: number; y: number }>()
      for (const child of children) {
        const position = packed.positions.get(child.id)!
        positions.set(child.id, { x: content.x + position.x, y: content.y + position.y })
      }

      const sheet = useSheetStore.getState()
      if (reviewMode && saveReviewLayouts) {
        const updates: Array<Omit<FloorLayout, 'workspaceId' | 'updatedAt'>> = children.map(child => {
          const nodeType: FloorNodeType = systems.some(item => item.id === child.id) ? 'system' : 'file'
          const previous = floorLayouts.find(item => item.nodeId === child.id && item.nodeType === nodeType)
          const worldScale = Number((child.data as any).worldScale ?? previous?.scale ?? 1)
          const position = positions.get(child.id)!
          return {
            nodeId: child.id,
            nodeType,
            parentNodeId: scopeId,
            parentNodeType: scopeId ? 'system' : null,
            containmentKind: scopeId ? 'part_of' : 'root',
            positionX: position.x,
            positionY: position.y,
            width: previous?.width ?? Number(child.style?.width ?? BASE_FILE_W) / Math.max(0.0001, worldScale),
            height: previous?.height ?? Number(child.style?.height ?? BASE_FILE_H) / Math.max(0.0001, worldScale),
            scale: previous?.scale ?? Number((child.data as any).frameScale ?? 1),
            interiorScale: previous?.interiorScale ?? Number((child.data as any).interiorScale ?? 1),
          }
        })
        await saveReviewLayouts(updates)
      } else if (sheet.activeSheetId) {
        const mutations: SheetLayoutMutation[] = children.map(child => {
          const position = positions.get(child.id)!
          const nodeType: FloorNodeType = sheetSystemIds.has(child.id)
            ? 'system' : sheetFileIds.has(child.id) ? 'file' : 'infra'
          const previous = sheetEffectiveLayouts.find(layout => layout.nodeId === child.id)
          const data = child.data as Record<string, unknown>
          const worldScale = Number(data.worldScale ?? 1)
          const parentNodeType = scopeId ? (sheetInfraIds.has(scopeId) ? 'infra' : 'system') : null
          return {
            nodeId: child.id,
            nodeType,
            parentNodeId: scopeId,
            parentNodeType,
            containmentKind: parentNodeType === 'infra' ? 'hosted_by' : parentNodeType ? 'part_of' : 'root',
            positionX: position.x,
            positionY: position.y,
            width: previous?.width ?? Number(child.style?.width ?? BASE_FILE_W) / Math.max(0.0001, worldScale),
            height: previous?.height ?? Number(child.style?.height ?? BASE_FILE_H) / Math.max(0.0001, worldScale),
            scale: previous?.scale ?? Number(data.frameScale ?? 1),
            interiorScale: previous?.interiorScale ?? Number(data.interiorScale ?? 1),
          }
        })
        await sheet.updateLayoutsBatch(workspaceIdForOverlay, sheet.activeSheetId, mutations)
      } else {
        const graph = useGraphStore.getState()
        const workspaceId = graph.currentProject?.id
        if (!workspaceId) return
        const updates: Omit<FloorLayout, 'workspaceId' | 'updatedAt'>[] = children.map(child => {
          const nodeType: FloorNodeType = graph.systems.some(item => item.id === child.id)
            ? 'system' : graph.files.some(item => item.id === child.id) ? 'file' : 'infra'
          const previous = graph.floorLayouts.find(item => item.nodeId === child.id && item.nodeType === nodeType)
          const worldScale = Number((child.data as any).worldScale ?? previous?.scale ?? 1)
          const ownScale = previous?.scale ?? Number((child.data as any).frameScale ?? 1)
          const position = positions.get(child.id)!
          return {
            nodeId: child.id, nodeType, parentNodeId: scopeId,
            parentNodeType: scopeId ? (graph.infraNodes.some(item => item.id === scopeId) ? 'infra' : 'system') : null,
            containmentKind: scopeId ? (graph.infraNodes.some(item => item.id === scopeId) ? 'hosted_by' : 'part_of') : 'root',
            positionX: position.x, positionY: position.y,
            width: previous?.width ?? Number(child.style?.width ?? BASE_FILE_W) / Math.max(0.0001, worldScale),
            height: previous?.height ?? Number(child.style?.height ?? BASE_FILE_H) / Math.max(0.0001, worldScale),
            scale: ownScale,
            // Tidy rearranges a frame's contents; it says nothing about how the
            // children themselves compress theirs. Carry it through unchanged.
            interiorScale: previous?.interiorScale ?? Number((child.data as any).interiorScale ?? 1),
          }
        })
        await apiSaveFloorLayouts(workspaceId, updates)
        const saved = updates.map(update => ({ ...update, workspaceId, updatedAt: Date.now() }))
        const changed = new Set(saved.map(item => item.nodeType + ':' + item.nodeId))
        useGraphStore.setState(state => ({
          floorLayouts: [...state.floorLayouts.filter(item => !changed.has(item.nodeType + ':' + item.nodeId)), ...saved],
        }))
      }
      queueCameraFit(80, { padding: 0.2, duration: 900, maxZoom: 1.0 })
    } catch (error) {
      console.error('[AmbioCanvas] tidy frame failed', error)
    } finally {
      setIsTidying(false)
    }
  }, [queueCameraFit, selectedNodeId, workspaceIdForOverlay, sheetEffectiveLayouts, sheetSystemIds, sheetFileIds, sheetInfraIds, reviewMode, saveReviewLayouts, systems, floorLayouts])

  const zoomRafRef        = useRef<number | null>(null)
  const layoutBuiltRef = useRef<string | null>(null)
  const initialFloorPersistRef = useRef<string | null>(null)
  const [floorPersistenceRetry, setFloorPersistenceRetry] = useState(0)
  const incrementalFloorPersistRef = useRef<string | null>(null)
  const reviewLayoutPersistRef = useRef<string | null>(null)
  const reviewLayoutPersistingSceneRef = useRef<string | null>(null)
  const [reviewLayoutPersistenceRevision, setReviewLayoutPersistenceRevision] = useState(0)
  const [interactionProjectionRevision, setInteractionProjectionRevision] = useState(0)
  // Remembered placements are per-workspace; carrying them across a project
  // switch would apply one project's coordinates to another's node ids.
  const placementScopeRef = useRef<string | null>(null)
  if (placementScopeRef.current !== sceneProjectId) {
    placementScopeRef.current = sceneProjectId
    floorPlacementsRef.current.clear()
    sheetPlacementsRef.current.clear()
  }
  const resizeStartRef    = useRef<Map<string, ResizeSessionStart>>(new Map())
  const resizingNodeIdRef = useRef<string | null>(null)
  // IDs are recorded from the actual React Flow changes, rather than inferred
  // from selection. That covers the resized node, compensated children, and
  // every member of a group resize without pinning unrelated scene updates.
  const resizeInteractionNodeIdsRef = useRef<Set<string>>(new Set())
  const rfNodesRef        = useRef<Node[]>([])
  const dropTargetRef     = useRef<string | null>(null)
  const draggingNodeIdRef = useRef<string | null>(null)
  const dragPositionRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  // XYFlow commits its internal node store asynchronously. Keep every emitted
  // absolute drag position outside React so the drop planner never reads the
  // previous frame, especially for secondary nodes in a multi-selection.
  const dragAbsolutePositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map())
  const resizePointerCleanupRef = useRef<(() => void) | null>(null)
  const dragTraceSessionRef = useRef(0)
  const dragTraceRef = useRef<NodeMoveTrace | null>(null)
  const targetZoomRef      = useRef<number | null>(null)
  const targetViewportRef  = useRef<{ x: number; y: number } | null>(null)
  const smoothZoomRafRef   = useRef<number | null>(null)
  const smoothZoomMouseRef = useRef<{ mx: number; my: number } | null>(null)

  rfNodesRef.current = rfNodes

  useEffect(() => () => {
    resizePointerCleanupRef.current?.()
    resizePointerCleanupRef.current = null
    if (zoomRafRef.current !== null) cancelAnimationFrame(zoomRafRef.current)
    zoomRafRef.current = null
    wheelLatchRef.current = null
  }, [])

  // ── Node resize ──────────────────────────────────────────────────────────
  const armResizeEndFallback = useCallback((nodeId: string) => {
    // XYFlow intentionally omits onResizeEnd when a handle is pressed and
    // released without a drag. Clear our interaction session after pointer-up
    // only if the normal end callback did not already consume it.
    resizePointerCleanupRef.current?.()
    const onPointerUp = () => {
      resizePointerCleanupRef.current?.()
      requestAnimationFrame(() => {
        if (!resizeStartRef.current.has(nodeId)) return
        resizeStartRef.current.delete(nodeId)
        resizeInteractionNodeIdsRef.current.clear()
        if (resizingNodeIdRef.current === nodeId) resizingNodeIdRef.current = null
        if (useSheetStore.getState().activeSheetId) setSheetInteractionNodes(null)
        setInteractionProjectionRevision(revision => revision + 1)
      })
    }
    resizePointerCleanupRef.current = () => {
      window.removeEventListener('pointerup', onPointerUp, true)
      resizePointerCleanupRef.current = null
    }
    window.addEventListener('pointerup', onPointerUp, { once: true, capture: true })
  }, [])

  const onNodeResizeEnd = useCallback((nodeId: string, end: NodeResizeParams) => {
    const start = resizeStartRef.current.get(nodeId)
    resizeStartRef.current.delete(nodeId)
    resizeInteractionNodeIdsRef.current.clear()
    requestAnimationFrame(() => {
      if (resizingNodeIdRef.current === nodeId) resizingNodeIdRef.current = null
      setInteractionProjectionRevision(revision => revision + 1)
    })
    if (!start) {
      if (useSheetStore.getState().activeSheetId) setSheetInteractionNodes(null)
      return
    }
    if (!resizeChanged(start, end)) {
      if (useSheetStore.getState().activeSheetId) setSheetInteractionNodes(null)
      return
    }

    // React Flow emits rendered, parent-local geometry; persistence uses
    // canonical geometry in the immediate parent's frame.
    const sheetState = useSheetStore.getState()
    const node = (!reviewMode && sheetState.activeSheetId ? displayNodesRef.current : rfNodesRef.current).find(n => n.id === nodeId)
    if (!node) {
      if (sheetState.activeSheetId) setSheetInteractionNodes(null)
      return
    }

    if (reviewMode && reviewScene && saveReviewLayouts) {
      const plan = planCanvasResize({
        workspaceId: reviewScene.workspaceId,
        nodeId,
        node,
        start,
        end,
        nodes: rfNodesRef.current,
        systemIds: new Set(systems.map(system => system.id)),
        fileIds: new Set(files.map(file => file.id)),
        infraIds: new Set(),
        floorLayouts,
      })
      if (plan.updates.every(update => reviewEditableNodeIds?.has(update.nodeId))) {
        void saveReviewLayouts(plan.updates).catch(error => {
          console.error('[AmbioCanvas] proposal resize failed', error)
        })
      }
      return
    }

    // Both surfaces use the exact same canonical resize planner. The only
    // difference is which sparse layout store receives its writes.
    if (sheetState.activeSheetId) {
      const plan = planCanvasResize({
        workspaceId: workspaceIdForOverlay,
        nodeId,
        node,
        start,
        end,
        nodes: displayNodesRef.current,
        systemIds: sheetSystemIds,
        fileIds: sheetFileIds,
        infraIds: sheetInfraIds,
        floorLayouts: sheetEffectiveLayouts,
      })
      if (plan.updates.length > 0) {
        void sheetState.updateLayoutsBatch(
          workspaceIdForOverlay,
          sheetState.activeSheetId,
          plan.updates,
        ).catch(() => {})
      }
      setSheetInteractionNodes(null)
      return
    }

    const graph = useGraphStore.getState()
    const workspaceId = graph.currentProject?.id
    if (!workspaceId) return
    const plan = planCanvasResize({
      workspaceId,
      nodeId,
      node,
      start,
      end,
      nodes: rfNodesRef.current,
      systemIds: new Set(graph.systems.map(system => system.id)),
      fileIds: new Set(graph.files.map(file => file.id)),
      infraIds: new Set(graph.infraNodes.map(infra => infra.id)),
      floorLayouts: graph.floorLayouts,
    })
    useGraphStore.setState(state => ({
      floorLayouts: replaceFloorLayouts(state.floorLayouts, plan.optimisticLayouts, plan.changedKeys),
    }))
    void apiSaveFloorLayouts(workspaceId, plan.updates).then(() => {
      pushFloorLayoutUndo(workspaceId, 'Resize', plan.previousLayouts, plan.updates)
    }).catch(error => {
      console.error('[AmbioCanvas] floor resize failed', error)
      useGraphStore.setState(state => ({
        floorLayouts: replaceFloorLayouts(state.floorLayouts, plan.previousLayouts, plan.changedKeys),
      }))
    })
  }, [workspaceIdForOverlay, sheetSystemIds, sheetFileIds, sheetInfraIds, sheetEffectiveLayouts, reviewMode, reviewScene?.workspaceId, reviewEditableNodeIds, saveReviewLayouts, systems, files, floorLayouts])

  const onNodeResizeEndRef = useRef(onNodeResizeEnd)
  onNodeResizeEndRef.current = onNodeResizeEnd

  const armResizeEndFallbackRef = useRef(armResizeEndFallback)
  armResizeEndFallbackRef.current = armResizeEndFallback

  const resizeHandlersRef = useRef(new Map<string, { onResizeStart: (p: NodeResizeParams) => void; onResizeEnd: (p: NodeResizeParams) => void }>())
  const getResizeHandlers = useCallback((nodeId: string, isSheet = false) => {
    const key = `${nodeId}:${isSheet ? 'sheet' : 'canvas'}`
    let handlers = resizeHandlersRef.current.get(key)
    if (!handlers) {
      const onResizeStart = (params: NodeResizeParams) => {
        setIsTransitioningLayout(false)
        resizingNodeIdRef.current = nodeId
        draggingNodeIdRef.current = null
        dragPositionRef.current.delete(nodeId)
        const sourceNodes = isSheet ? displayNodesRef.current : rfNodesRef.current
        const children = new Map(sourceNodes
          .filter(child => child.parentId === nodeId)
          .map(child => [child.id, { x: child.position.x, y: child.position.y }]))
        resizeInteractionNodeIdsRef.current = new Set([nodeId, ...children.keys()])
        resizeStartRef.current.set(nodeId, { ...params, children })
        armResizeEndFallbackRef.current?.(nodeId)
        if (isSheet) {
          setSheetInteractionNodes(current => current ?? displayNodesRef.current)
        }
      }
      const onResizeEnd = (params: NodeResizeParams) => onNodeResizeEndRef.current?.(nodeId, params)
      handlers = { onResizeStart, onResizeEnd }
      resizeHandlersRef.current.set(key, handlers)
    }
    return handlers
  }, [])


  const floorModel = useMemo<FloorModel | null>(() => deferCanvasMaterialization || systems.length + files.length + infraNodes.length === 0 ? null : {
    systems, files, infraNodes, dependencies, layouts: floorLayouts, scope: `${sceneProjectId}:floor`,
  }, [systems, files, infraNodes, dependencies, floorLayouts, sceneProjectId, deferCanvasMaterialization])
  const floorPreparation = usePreparedFloorGeometry(sceneWorker, 'floor', floorModel, floorPlacementsRef.current, preparationRetry, () => currentZoomRef.current,
    reviewMode ? undefined : () => layoutBuiltRef.current !== sceneProjectId && systems.length + files.length + infraNodes.length > LARGE_SCENE_NODE_COUNT ? MIN_CANVAS_ZOOM : currentZoomRef.current)
  const [adoptedFloorModel, setAdoptedFloorModel] = useState<FloorModel | null>(null)
  const floorPending = Boolean(floorModel && adoptedFloorModel !== floorModel && !floorPreparation.error)

  useEffect(() => {
    if (deferCanvasMaterialization) {
      pendingInitialFitProjectRef.current = null
      setRfNodes(current => current.length === 0 ? current : [])
      setRfEdges(current => current.length === 0 ? current : [])
      return
    }
    // The map must always show every file. A fresh project (agent building into
    // an empty folder) has files before any system exists - render them at the
    // top level rather than an empty Floor; live classification groups them into
    // systems as the topology emerges.
    if (systems.length === 0 && infraNodes.length === 0 && files.length === 0) {
      pendingInitialFitProjectRef.current = null
      setRfNodes(current => current.length ? [] : current)
      setRfEdges(current => current.length ? [] : current)
      setCandidateOwner(sceneProjectId)
      setAdoptedFloorModel(null)
      return
    }

    const projectId = sceneProjectId
    // On first layout for a project, don't use existing positions - force fresh grid layout.
    // On subsequent data updates (same project), preserve user-dragged positions.
    const isFirstLayout = layoutBuiltRef.current !== projectId
    if (!floorPreparation.current || !floorPreparation.value) return
    const geometry = floorPreparation.value.geometry
    const { generatedLayoutNodeIds, resizedContainerIds } = geometry
    const layout = floorPreparation.value.nodes
    const newEdges: Edge[] = []
    let persistenceIndex: { files: Map<string, DbFile>; systems: Set<string>; infra: Set<string> } | undefined
    const persistence = () => persistenceIndex ??= {
      files: new Map(files.map(file => [file.id, file])),
      systems: new Set(systems.map(system => system.id)),
      infra: new Set(infraNodes.map(infra => infra.id)),
    }

    const serializeFloorNode = (node: Node): Omit<FloorLayout, 'workspaceId' | 'updatedAt'> => {
      const nodeType: FloorNodeType = persistence().systems.has(node.id)
        ? 'system' : persistence().files.has(node.id) ? 'file' : 'infra'
      const ownScale = Number((node.data as any).frameScale ?? 1)
      const worldScale = Number((node.data as any).worldScale ?? ownScale)
      // The parent factor that produced this node's world position is the
      // parent's CONTENT scale; dividing it back out recovers canonical coords.
      const parentWorldScale = node.parentId ? worldScale / Math.max(0.0001, ownScale) : 1
      const parentNodeType = node.parentId
        ? (persistence().infra.has(node.parentId) ? 'infra' : 'system')
        : null
      return {
        nodeId: node.id,
        nodeType,
        parentNodeId: node.parentId ?? null,
        parentNodeType,
        containmentKind: parentNodeType === 'infra' ? 'hosted_by' : parentNodeType === 'system' ? 'part_of' : 'root',
        positionX: node.position.x / Math.max(0.0001, parentWorldScale),
        positionY: node.position.y / Math.max(0.0001, parentWorldScale),
        width: Number(node.style?.width ?? node.measured?.width ?? 1) / Math.max(0.0001, worldScale),
        height: Number(node.style?.height ?? node.measured?.height ?? 1) / Math.max(0.0001, worldScale),
        scale: ownScale,
        interiorScale: Number((node.data as any).interiorScale ?? 1),
      }
    }

    // A genuinely empty Floor gets one relationship-aware initialization.
    // Persist the complete result immediately; after this, authored freeform
    // geometry is the sole source of truth and the force layout never reruns.
    // Only freeze an initial layout once real containers exist. Persisting root
    // positions for still-unclassified files would pin them, blocking live
    // classification from later moving them into their system.
    if (reviewMode && saveReviewLayouts && reviewEditableNodeIds) {
      // The live Floor freezes every generated row before the first gesture.
      // Review must do the same. Leaving proposal geometry sparse meant the
      // first user move persisted one node, then every untouched node entered
      // fresh-packing again and the whole review appeared to tidy itself.
      const savedIds = new Set(floorLayouts.map(row => row.nodeId))
      const missingEditableIds = new Set([...reviewEditableNodeIds].filter(id => !savedIds.has(id)))
      for (const id of resizedContainerIds) {
        if (reviewEditableNodeIds.has(id)) missingEditableIds.add(id)
      }
      const updates = layout
        .filter(node => missingEditableIds.has(node.id))
        .map(serializeFloorNode)
      if (updates.length > 0) {
        setReviewReadySceneId(current => current === projectId ? null : current)
        const signature = projectId + ':' + updates.map(update => [
          update.nodeType, update.nodeId, update.parentNodeId ?? '',
          update.positionX, update.positionY, update.width, update.height,
          update.scale, update.interiorScale,
        ].join(':')).sort().join('|')
        if (reviewLayoutPersistRef.current !== signature) {
          reviewLayoutPersistRef.current = signature
          reviewLayoutPersistingSceneRef.current = projectId
          void saveReviewLayouts(updates)
            .catch(error => {
              console.error('[AmbioCanvas] initial proposal layout failed', error)
            })
            .finally(() => {
              if (reviewLayoutPersistingSceneRef.current === projectId) {
                reviewLayoutPersistingSceneRef.current = null
              }
              setReviewLayoutPersistenceRevision(revision => revision + 1)
            })
        }
      } else if (reviewLayoutPersistingSceneRef.current !== projectId) {
        setReviewReadySceneId(current => current === projectId ? current : projectId)
      }
    } else if (!reviewMode && !binMode && !readOnly && currentProject && systems.length > 0 && floorLayouts.length === 0 && files.every(file => !!file.systemId) && initialFloorPersistRef.current !== projectId) {
      initialFloorPersistRef.current = projectId
      const initialLayouts = layout.map(serializeFloorNode)
      const optimistic = initialLayouts.map(item => ({ ...item, workspaceId: currentProject.id, updatedAt: Date.now() }))
      useGraphStore.setState({ floorLayouts: optimistic })
      const noticeId = `initial-floor-save:${projectId}`
      void apiSaveFloorLayouts(currentProject.id, initialLayouts).then(() => {
        resolveInterruption(noticeId)
      }).catch(error => {
        console.error('[AmbioCanvas] initial Floor layout failed', error)
        if (useGraphStore.getState().currentProject?.id !== projectId) return
        // Keep the attempt latched. Clearing it here made every failed request
        // immediately repack and retry, overwhelming the canvas while offline.
        useGraphStore.setState({ floorLayouts: [] })
        raiseFailure(noticeId, 'Could not save the map layout', String(error), [{ label: 'Retry', run: () => {
          if (useGraphStore.getState().currentProject?.id !== projectId) return
          initialFloorPersistRef.current = null
          setFloorPersistenceRetry(revision => revision + 1)
        } }])
      })
    } else if (!reviewMode && !binMode && !readOnly && currentProject && floorLayouts.length > 0 && (generatedLayoutNodeIds.size > 0 || resizedContainerIds.size > 0)) {
      // Do not pin a just-created, still-unclassified file to the Floor root.
      // Its semantic parent arrives in the classifier's atomic snapshot.
      const persistableGeneratedIds = [...generatedLayoutNodeIds].filter(nodeId => {
        const file = persistence().files.get(nodeId)
        const nodeType: FloorNodeType = file ? 'file' : persistence().systems.has(nodeId) ? 'system' : 'infra'
        return canPersistGeneratedFrame(nodeType, file?.systemId ?? null)
      })
      const reconciledIds = new Set([...persistableGeneratedIds, ...resizedContainerIds])
      const updates = layout.filter(node => reconciledIds.has(node.id)).map(serializeFloorNode)
      if (updates.length > 0) {
        const signature = currentProject.id + ':' + updates
          // Every field the write actually changes. Omitting one makes a real
          // change look like a repeat and get skipped - `interiorScale` and
          // `containmentKind` were both missing.
          .map(update => [
            update.nodeType, update.nodeId, update.parentNodeId ?? '', update.parentNodeType ?? '',
            update.containmentKind, update.positionX, update.positionY,
            update.width, update.height, update.scale, update.interiorScale,
          ].join(':'))
          .sort()
          .join('|')
        if (incrementalFloorPersistRef.current !== signature) {
          incrementalFloorPersistRef.current = signature
          const changedKeys = new Set(updates.map(update => update.nodeType + ':' + update.nodeId))
          const previousLayouts = floorLayouts.filter(item => changedKeys.has(item.nodeType + ':' + item.nodeId))
          const optimistic = updates.map(update => ({
            ...update,
            workspaceId: currentProject.id,
            updatedAt: Date.now(),
          }))
          useGraphStore.setState(state => ({
            floorLayouts: replaceFloorLayouts(state.floorLayouts, optimistic, changedKeys),
          }))
          void apiSaveFloorLayouts(currentProject.id, updates).catch(error => {
            console.error('[AmbioCanvas] incremental Floor reconciliation failed', error)
            useGraphStore.setState(state => ({
              floorLayouts: replaceFloorLayouts(state.floorLayouts, previousLayouts, changedKeys),
            }))
          })
        }
      }
    }

    const layoutWithCallbacks = !reviewMode ? layout : layout.map(n => {
      return {
        ...n,
        draggable: reviewMode
          ? reviewLayoutReady && (reviewEditableNodeIds?.has(n.id) ?? false)
          : n.draggable,
        selectable: true,
      }
    })
    // A large first projection is about to be fitted to an overview. Starting
    // its semantic tier at the default 0.5x would briefly mount every child of
    // a large root before fitView reaches the real overview zoom - exactly the
    // expensive flash this path is meant to prevent.
    const visibilityZoom = isFirstLayout && layout.length > LARGE_SCENE_NODE_COUNT
      ? MIN_CANVAS_ZOOM
      : currentZoomRef.current
    const gestureSafeLayout = resizeStartRef.current.size > 0
      ? preserveActiveResizeGeometry(
          layoutWithCallbacks,
          rfNodesRef.current,
          resizeInteractionNodeIdsRef.current,
        )
      : layoutWithCallbacks
    const withZoom = reviewMode
      ? gestureSafeLayout.map(makeFullyVisible)
      : applyZoomVisibility(gestureSafeLayout, visibilityZoom)
    const fixed = stampSelection(withZoom, selectedIdsRef.current)
    sceneSourceRef.current = isFirstLayout ? 'layout-build' : 'layout-rebuild'
    setRfNodes(fixed)
    setCandidateOwner(sceneProjectId)
    setAdoptedFloorModel(floorModel)
    setRfEdges(newEdges)
    // Signal overlay effects (runtime / focus / trace) to restamp their
    // per-node flags, which this full rebuild just discarded.
    setLayoutVersion(v => v + 1)

    if (isFirstLayout) {
      layoutBuiltRef.current = projectId
      pendingInitialFitProjectRef.current = manualCameraProjectRef.current === projectId ? null : projectId
    }
  }, [floorPersistenceRetry, floorModel, floorPreparation.current, floorPreparation.value, systems, files, infraNodes, floorLayouts, dependencies, getResizeHandlers, readOnly, deferCanvasMaterialization, reviewMode, reviewLayoutReady, reviewEditableNodeIds, saveReviewLayouts, reviewLayoutPersistenceRevision, interactionProjectionRevision, sceneProjectId])

  // The first camera used to be an 80ms guess after setRfNodes. That raced both
  // React Flow measurement and the immediate persisted-layout reprojection, so
  // unrelated mount work could decide which bounds fitView observed. Sample
  // the complete internal scene until its absolute measured geometry is stable
  // across consecutive frames, then fit exactly once for this project.
  useEffect(() => {
    const fitNodes = rfNodes.filter(node => !node.hidden)
    if (pendingInitialFitProjectRef.current !== sceneProjectId || fitNodes.length === 0) {
      return
    }

    let frame = 0
    let measurement = { signature: null as string | null, stableFrames: 0 }
    const sampleMeasuredScene = () => {
      if (pendingInitialFitProjectRef.current !== sceneProjectId) return

      const parts: string[] = []
      for (const node of fitNodes) {
        const internal = getInternalNode(node.id)
        const width = internal?.measured.width
        const height = internal?.measured.height
        const position = internal?.internals.positionAbsolute
        if (!position || !width || !height) {
          measurement = advanceSceneMeasurement(measurement, null)
          frame = requestAnimationFrame(sampleMeasuredScene)
          return
        }
        parts.push(`${node.id}:${position.x},${position.y},${width},${height}`)
      }
      parts.sort()
      measurement = advanceSceneMeasurement(measurement, parts.join('|'))
      if (!sceneMeasurementIsSettled(measurement)) {
        frame = requestAnimationFrame(sampleMeasuredScene)
        return
      }

      if (runningInitialFitProjectRef.current === sceneProjectId) return
      runningInitialFitProjectRef.current = sceneProjectId
      // maxZoom keeps a sparse Floor from filling the viewport. The short
      // authored entrance completes well before the canvas is interactive.
      void fitView({
        nodes: fitNodes.map(node => ({ id: node.id })),
        padding: 0.25,
        duration: 400,
        maxZoom: 1.0,
      }).finally(() => {
        if (runningInitialFitProjectRef.current === sceneProjectId) {
          runningInitialFitProjectRef.current = null
        }
        if (pendingInitialFitProjectRef.current !== sceneProjectId) return
        pendingInitialFitProjectRef.current = null
        const settledZoom = getViewport().zoom
        currentZoomRef.current = settledZoom
        lastVisibilityZoomRef.current = settledZoom
        sceneSourceRef.current = 'initial-fit-visibility'
        setRfNodes(current => reviewMode
          ? current.map(makeFullyVisible)
          : applyZoomVisibility(current, settledZoom))
      })
    }

    frame = requestAnimationFrame(sampleMeasuredScene)
    return () => cancelAnimationFrame(frame)
  }, [fitView, getInternalNode, getViewport, nodesInitialized, rfNodes, sceneProjectId, reviewMode])

  // Live reframing - as files stream in from the watcher, gently fit the growing
  // graph so new nodes come into view at a sensible zoom, instead of leaving the
  // camera parked on the first node. Skips the initial 0→N population (handled by
  // the first-layout fit) and yields while the user is actively navigating.
  useEffect(() => {
    const count = systems.length + files.length + infraNodes.length
    const prev = liveNodeCountRef.current
    liveNodeCountRef.current = count
    if (suppressGrowthFitRef.current) {
      // Consumed once: the baseline above is already updated, so the next real
      // growth still reframes normally.
      suppressGrowthFitRef.current = false
      return
    }
    if (deferCanvasMaterialization || reviewMode) return
    if (prev === 0 || count <= prev) return
    queueCameraFit(1800, { padding: 0.28, duration: 1100, maxZoom: 1.0 })
  }, [systems.length, files.length, infraNodes.length, queueCameraFit, deferCanvasMaterialization, reviewMode])

  // Revealing a node from outside the canvas - search, the agent log, the
  // detail panel - selects it, exactly as clicking it would.
  //
  // This used to paint `selected` straight onto the scene without telling the
  // authoritative set, so the canvas and the set disagreed from that moment on:
  // the highlight said one thing, and the next drag acted on another. It also
  // fired on every change of the pointer, including to null, silently wiping a
  // multi-selection the user had just made. A null pointer now means "no single
  // node is current" - a group has no single node - and clears nothing.
  useEffect(() => {
    if (!selectedNodeId) return
    const current = selectedIdsRef.current
    if (current.size === 1 && current.has(selectedNodeId)) return
    applySelection(singleNodeSelection(selectedNodeId))
  }, [selectedNodeId, applySelection])

  // ── Runtime activity ─────────────────────────────────────────────────────
  // Stamp live runtime state (watch markers, call counts, pulse triggers)
  // onto the affected file nodes. runtimeNodes only contains watched files,
  // so untouched nodes keep referential identity and skip re-render.
  useEffect(() => {
    setRfNodes(curr => stampRuntimeOverlay(curr, runtimeNodes))
  }, [runtimeNodes, layoutVersion])

  // ── Data-flow slice (purple overlay) ───────────────────────────────────────
  // Stamp `sliced` on file nodes in the current variable-reference slice.
  useEffect(() => {
    const ids = dataFlow?.fileIds ?? null
    setRfNodes(curr => stampBooleanOverlay(curr, 'sliced', id => Boolean(ids?.has(id))))
  }, [dataFlow, layoutVersion])

  // ── Focused subgraph ───────────────────────────────────────────────────────
  // The focus set = files in the active trace + files with runtime activity,
  // plus their ancestor systems (so a focused file's containers stay lit).
  // Everything else is dimmed. Off when nothing is active or the user disables it.
  // Stable content key: the SET of focused files changes only when a watch is
  // added/removed or the trace changes - not on every runtime metric tick. This
  // keeps the focus effect from re-running (and re-mapping all nodes) ~12×/sec.
  const focusKey = useMemo(() => {
    const ids: string[] = []
    if (activeTrace) {
      for (const step of activeTrace) { ids.push(step.callerFile); ids.push(step.calleeFile) }
    }
    ids.push(...Object.keys(runtimeNodes))
    return Array.from(new Set(ids)).sort().join('|')
  }, [activeTrace, runtimeNodes])

  const focusFileIds = useMemo(
    () => new Set(focusKey ? focusKey.split('|') : []),
    [focusKey],
  )

  useEffect(() => {
    const active = focusEnabled && focusFileIds.size > 0
    if (!active) {
      setRfNodes(curr => stampBooleanOverlay(curr, 'dimmed', () => false))
      return
    }
    // Keep focused files and every ancestor system on their parent chain lit.
    const systemById = new Map(systems.map(s => [s.id, s]))
    const fileById = new Map(files.map(f => [f.id, f]))
    const keep = new Set<string>(focusFileIds)
    for (const fileId of focusFileIds) {
      let sysId = fileById.get(fileId)?.systemId ?? null
      while (sysId && !keep.has(sysId)) {
        keep.add(sysId)
        sysId = systemById.get(sysId)?.parentId ?? null
      }
    }
    setRfNodes(curr => stampBooleanOverlay(curr, 'dimmed', id => !keep.has(id)))
  }, [focusEnabled, focusFileIds, systems, files, layoutVersion])

  // ── Call trace ───────────────────────────────────────────────────────────
  // Stamp isTraced on the files a call path runs through. The path itself is
  // drawn by RunTraceOverlay, merged per visible pair of nodes, rather than as
  // one React Flow edge per call.
  useEffect(() => {
    const tracedIds = new Set<string>()
    for (const step of activeTrace ?? []) {
      tracedIds.add(step.callerFile)
      tracedIds.add(step.calleeFile)
    }
    setRfNodes(curr => stampBooleanOverlay(curr, 'isTraced', id => tracedIds.has(id)))
  }, [activeTrace, layoutVersion])

  // ── WASD pan ────────────────────────────────────────────────────────────
  // Keyboard panning listens on the window, so every mounted canvas would
  // answer the same keypress. Only the Floor owns WASD; the bin is navigated
  // by dragging it, which is unambiguous about which surface you meant.
  // WASD follows the pointer: whichever canvas you are hovering is the one
  // that pans. The Floor is the fallback for when the pointer is over neither
  // (a toolbar, a side panel), so the keys never simply stop working.
  const wasdScope = useMemo(() => ({
    element: () => canvasRootRef.current,
    fallback: !binMode,
  }), [binMode])
  useCanvasWasdPan(getViewport, setViewport, true, wasdScope)

  // Delete on the Floor changes meaning, never code: a system is ungrouped
  // (its contents move up a level) and a file is left alone with a pointer to
  // the way files really go away - a work order (DECISIONS 2026-10-01).
  useEffect(() => {
    if (!floorEditable || !selectedNodeId) return
    const onDeleteOnFloor = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return
      const state = useGraphStore.getState()
      const workspaceId = state.currentProject?.id
      const system = state.systems.find(candidate => candidate.id === selectedNodeId)
      if (system && workspaceId) {
        event.preventDefault()
        setSelectedNode(null)
        setInspectedNode(null)
        void commitMeaningEdits(workspaceId, [{ op: 'ungroup', systemId: system.id }], `${system.name} ungrouped`)
        return
      }
      if (state.files.some(file => file.id === selectedNodeId)) {
        event.preventDefault()
        raiseNotice('floor-delete-file', 'Files are code', 'Deleting one changes the code, so it is never done on the Floor. Right-click it and choose Delete This File… to send the change to an agent.')
      }
    }
    window.addEventListener('keydown', onDeleteOnFloor)
    return () => window.removeEventListener('keydown', onDeleteOnFloor)
  }, [floorEditable, selectedNodeId, setSelectedNode, setInspectedNode])

  useEffect(() => {
    if (readOnly || !overlaySheetId || !selectedNodeId) return
    const onDeleteSelectedSheetNode = (event: KeyboardEvent) => {
      if (event.key !== 'Delete' && event.key !== 'Backspace') return
      const target = event.target as HTMLElement | null
      const tag = target?.tagName?.toLowerCase()
      if (tag === 'input' || tag === 'textarea' || target?.isContentEditable) return

      const planned = activePlannedByNodeId.get(selectedNodeId)
      const graph = useGraphStore.getState()
      const live = graph.files.find(file => file.id === selectedNodeId)?.relPath
        ?? graph.systems.find(system => system.id === selectedNodeId)?.name
        ?? graph.infraNodes.find(node => node.id === selectedNodeId)?.name
      if (!planned && !live) return

      event.preventDefault()
      event.stopPropagation()
      setSelectedNode(null)
      setInspectedNode(null)
      if (planned?.id === infraPickerNodeId) setInfraPickerNode(null)
      if (planned) {
        // Sheet-only content is really deleted.
        void useSheetStore.getState().deletePlanned(workspaceIdForOverlay, planned.id)
          .catch(error => console.error('[sheets] failed to delete selected planned node:', error))
      } else if (live) {
        // Live code on a sheet is proposed for removal: gone from this
        // sheet's picture, listed, restorable, and nothing real changes.
        const sheetId = overlaySheetId
        const nodeId = selectedNodeId
        void proposeSheetRemoval(workspaceIdForOverlay, sheetId, nodeId).then(() => {
          const id = `sheet-removal-${sheetId}-${nodeId}`
          raiseNotice(id, `${live} proposed for removal`, 'Only on this sheet. Send the sheet to an agent to remove the code.', [{
            label: 'Restore',
            run: () => {
              resolveInterruption(id)
              void restoreSheetRemoval(workspaceIdForOverlay, sheetId, nodeId)
                .catch(error => raiseFailure(`${id}-restore`, "Couldn't restore", String(error)))
            },
          }])
        }).catch(error => raiseFailure('sheet-removal', "Couldn't propose the removal", error instanceof Error ? error.message : String(error)))
      }
    }
    window.addEventListener('keydown', onDeleteSelectedSheetNode)
    return () => window.removeEventListener('keydown', onDeleteSelectedSheetNode)
  }, [readOnly, overlaySheetId, selectedNodeId, activePlannedByNodeId, workspaceIdForOverlay, setSelectedNode, setInspectedNode, setInfraPickerNode, infraPickerNodeId])

  useEffect(() => {
    return () => {
      if (smoothZoomRafRef.current !== null) {
        cancelAnimationFrame(smoothZoomRafRef.current)
      }
    }
  }, [])

  const handleWheel = useCallback((e: WheelEvent) => {
    // This canvas consumes the gesture, whatever it decides to do with it.
    //
    // The bin window is positioned against the viewport but is still a DOM
    // descendant of the Floor, so without this a wheel over the bin bubbled
    // into the Floor's listener and zoomed both canvases at once. Stopping
    // here means the surface under the cursor is the only one that answers.
    e.stopPropagation()
    // Scrollable node content (symbol lists, class members) gets the wheel
    // while it can still scroll; the canvas takes over at the boundary.
    const route = routeWheelEvent(
      e.target as Element | null,
      e.deltaY,
      canvasRootRef.current,
      element => {
        const style = window.getComputedStyle(element)
        return {
          overflowY: style.overflowY,
          scrollTop: element.scrollTop,
          scrollHeight: element.scrollHeight,
          clientHeight: element.clientHeight,
        }
      },
    )
    if (route.kind === 'ignore') return

    // Scroll latching. Once a gesture is scrolling a list it keeps that list
    // until the user actually stops, even after hitting an end. Without this,
    // running out of list mid-flick hands the rest of the same gesture to the
    // canvas and it scrolls and zooms at once.
    const now = e.timeStamp
    const latched = wheelLatchRef.current
    const latchedElement = latched && now - latched.lastEventAt < WHEEL_LATCH_MS &&
      latched.element.isConnected
      ? latched.element
      : null
    const scrollElement = latchedElement ??
      (route.kind === 'scroll' ? route.element : null)

    if (scrollElement) {
      // Consume it outright. Native scrolling is unreliable inside a
      // transform-scaled node, and any other wheel listener acting on the same
      // event would fight Ambio's zoom.
      e.preventDefault()
      e.stopPropagation()
      wheelLatchRef.current = { element: scrollElement, lastEventAt: now }
      // A gesture that began before the latch may have started a smooth zoom
      // that keeps easing for many frames. It must die here.
      if (smoothZoomRafRef.current !== null) {
        cancelAnimationFrame(smoothZoomRafRef.current)
        smoothZoomRafRef.current = null
      }
      targetZoomRef.current = null
      targetViewportRef.current = null
      scrollElement.scrollTop += wheelScrollStep(e.deltaY, scrollElement.clientHeight)
      return
    }
    wheelLatchRef.current = null

    e.preventDefault()

    const currentViewport = getViewport()
    const rect = (e.currentTarget as HTMLDivElement).getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top

    smoothZoomMouseRef.current = { mx, my }

    // Initialize targetZoom if not set or if it has converged
    if (targetZoomRef.current === null) {
      targetZoomRef.current = currentViewport.zoom
    }

    targetZoomRef.current = nextWheelZoomTarget(targetZoomRef.current, e.deltaY)

    // Start the animation loop if it's not already running
    if (smoothZoomRafRef.current === null) {
      const ease = () => {
        const vp = getViewport()
        const tz = targetZoomRef.current
        const mouse = smoothZoomMouseRef.current

        if (tz === null || mouse === null) {
          smoothZoomRafRef.current = null
          return
        }

        const nextViewport = easeViewportTowardZoom(vp, { x: mouse.mx, y: mouse.my }, tz)
        setViewport(nextViewport)

        // Stop the animation if we are very close to target zoom
        if (Math.abs(nextViewport.zoom - tz) < ZOOM_SNAP_EPSILON) {
          // Final snap
          const finalVp = getViewport()
          setViewport(zoomViewportAroundPoint(finalVp, { x: mouse.mx, y: mouse.my }, tz))

          targetZoomRef.current = null
          smoothZoomRafRef.current = null
        } else {
          smoothZoomRafRef.current = requestAnimationFrame(ease)
        }
      }
      smoothZoomRafRef.current = requestAnimationFrame(ease)
    }
  }, [getViewport, setViewport])

  useEffect(() => {
    const element = canvasRootRef.current
    if (!element) return
    element.addEventListener('wheel', handleWheel, { passive: false })
    const navigate = (event: Event) => {
      event.stopPropagation()
      manualCameraProjectRef.current = sceneProjectId
      pendingInitialFitProjectRef.current = null
      if (smoothZoomRafRef.current !== null) cancelAnimationFrame(smoothZoomRafRef.current)
      smoothZoomRafRef.current = null
      targetZoomRef.current = null
      targetViewportRef.current = null
      if (cameraFitTimerRef.current) clearTimeout(cameraFitTimerRef.current)
      cameraFitTimerRef.current = null
      lastUserMoveAtRef.current = Date.now()
    }
    element.addEventListener('ambio:camera-navigation', navigate)
    return () => {
      element.removeEventListener('wheel', handleWheel)
      element.removeEventListener('ambio:camera-navigation', navigate)
    }
  }, [handleWheel, sceneProjectId])

  const onMove: OnMove = useCallback((event, viewport) => {
    const zoom = viewport.zoom
    currentZoomRef.current = zoom
    // Write only to activity badges, never an inherited canvas-wide variable.
    zoomChromeRef.current?.setZoom(zoom)
    // Keep the conservative overview tier throughout the entrance animation.
    // Once fitView settles, its completion handler applies the final zoom once.
    const visibilityZoom = pendingInitialFitProjectRef.current
      ? MIN_CANVAS_ZOOM
      : zoom

    // A sheet interaction snapshot must never outlive the geometry mutation
    // that created it, or it freezes semantic zoom on stale node styles.
    if (useSheetStore.getState().activeSheetId && !draggingNodeIdRef.current && resizeStartRef.current.size === 0) {
      setSheetInteractionNodes(null)
    }

    // Cancel smooth zoom animation if movement is driven by user interaction (drag, pinch, etc.)
    if (event) {
      lastUserMoveAtRef.current = Date.now()
      if (smoothZoomRafRef.current !== null) {
        cancelAnimationFrame(smoothZoomRafRef.current)
        smoothZoomRafRef.current = null
      }
      targetZoomRef.current = null
      targetViewportRef.current = null
    }

    if (zoomRafRef.current !== null) cancelAnimationFrame(zoomRafRef.current)
    zoomRafRef.current = null
    // Review has no zoom-dependent visibility. Its layout projection already
    // reveals every node; restamping a new array here reruns the entire scene
    // projection, React Flow node adoption and diagnostics on every frame.
    if (reviewMode) return
    zoomRafRef.current = requestAnimationFrame(() => {
      zoomRafRef.current = null
      const draggingId = draggingNodeIdRef.current
      // Panning (zoom unchanged) never alters semantic visibility. Restamping
      // every node on each pan frame is what made panning feel janky - skip it
      // unless the zoom actually changed (or a node is being dragged).
      if (!draggingId && Math.abs(visibilityZoom - lastVisibilityZoomRef.current) < 1e-4) return
      lastVisibilityZoomRef.current = visibilityZoom
      recordZoomVisibilityPass()
      sceneSourceRef.current = 'zoom-visibility'
      const sheetBase = sheetBaseNodesRef.current
      if (sheetBase) {
        setSheetVisibility(current => {
          const nodes = current?.source === sheetBase ? current.nodes : sheetBase
          const updated = applyZoomVisibility(nodes, visibilityZoom)
          return current?.source === sheetBase && current.nodes === updated ? current : { source: sheetBase, nodes: updated }
        })
      }
      setRfNodes(curr => {
        let updated = applyZoomVisibility(curr, visibilityZoom)
        if (draggingId) {
          updated = updated.map(n => n.id === draggingId ? makeFullyVisible(n) : n)
        }
        return updated
      })
    })
  }, [reviewMode])

  const onNodesChange: OnNodesChange = useCallback(
    (changes) => {
      const { interaction, rejectedStructural } = partitionCanvasNodeChanges(changes)
      if (rejectedStructural.length > 0) {
        console.error('[scene-integrity] rejected structural React Flow changes', {
          projectId: useGraphStore.getState().currentProject?.id ?? 'demo',
          canonicalNodeCount:
            useGraphStore.getState().systems.length +
            useGraphStore.getState().files.length +
            useGraphStore.getState().infraNodes.length,
          sceneNodeCount: displayNodesRef.current.length,
          // 'add' changes carry the whole node instead of a bare id, so the id
          // has to be read defensively or this diagnostic throws while
          // reporting the very corruption it exists to catch.
          changes: rejectedStructural.map(change => ({
            type: change.type,
            id: 'id' in change ? change.id : change.item?.id ?? null,
          })),
        })
      }
      if (interaction.length === 0) return
      if (resizeStartRef.current.size > 0) {
        for (const change of interaction) {
          if (change.type === 'position' || change.type === 'dimensions') {
            resizeInteractionNodeIdsRef.current.add(change.id)
          }
        }
      }
      if (draggingNodeIdRef.current) {
        for (const change of interaction) {
          if (change.type === 'position' && change.positionAbsolute) {
            dragAbsolutePositionsRef.current.set(change.id, {
              x: change.positionAbsolute.x,
              y: change.positionAbsolute.y,
            })
          }
        }
      }
      const moveTrace = dragTraceRef.current
      if (moveTrace) {
        const viewport = getViewport()
        const now = performance.now()
        for (const change of interaction) {
          if (change.type !== 'position') continue
          const previous = moveTrace.previousChangeByNodeId.get(change.id)
          const x = change.position?.x ?? null
          const y = change.position?.y ?? null
          moveTrace.changeRows.push({
            sample: moveTrace.changeRows.length + 1,
            tMs: now - moveTrace.startedAt,
            nodeId: change.id,
            primaryNode: change.id === moveTrace.nodeId,
            dragging: change.dragging ?? null,
            zoom: viewport.zoom,
            emittedX: x,
            emittedY: y,
            emittedAbsoluteX: change.positionAbsolute?.x ?? null,
            emittedAbsoluteY: change.positionAbsolute?.y ?? null,
            deltaFromPreviousX: x !== null && previous ? x - previous.x : null,
            deltaFromPreviousY: y !== null && previous ? y - previous.y : null,
            screenDeltaFromPreviousX: x !== null && previous ? (x - previous.x) * viewport.zoom : null,
            screenDeltaFromPreviousY: y !== null && previous ? (y - previous.y) * viewport.zoom : null,
          })
          if (x !== null && y !== null) moveTrace.previousChangeByNodeId.set(change.id, { x, y })
        }
      }
      commitSelection(selectionAfterNodeChanges(selectedIdsRef.current, interaction))
      // North/west resize handles change the frame origin as well as its
      // dimensions. Apply the complete React Flow change set so the edge under
      // the pointer remains under the pointer and child compensation stays live.
      const interactionChanges = interaction
      // Planned overlay nodes live in the sheet store, not rfNodes - route
      // their drags there and keep the rest on the normal path.
      if (overlaySheetId) {
        const measuredChanges = interactionChanges.filter(change => change.type === 'dimensions' && change.dimensions)
        if (measuredChanges.length > 0) {
          setSheetMeasurements(current => {
            let next = current
            for (const change of measuredChanges) {
              if (change.type !== 'dimensions' || !change.dimensions) continue
              const previous = current.get(change.id)
              if (previous?.width === change.dimensions.width && previous?.height === change.dimensions.height) continue
              if (next === current) next = new Map(current)
              next.set(change.id, change.dimensions)
            }
            return next
          })
        }
        const geometryChanges = interactionChanges.filter(change => change.type === 'position' ||
          (change.type === 'dimensions' && resizeStartRef.current.size > 0))
        if (geometryChanges.length > 0) {
          setSheetInteractionNodes(nodes => applyNodeChanges(geometryChanges, nodes ?? displayNodesRef.current))
        }
      } else {
        sceneSourceRef.current = 'react-flow-interaction'
        setRfNodes(nodes => applyNodeChanges(interactionChanges, nodes))
      }
    }, [getViewport, overlaySheetId]
  )
  const onEdgesChange: OnEdgesChange = useCallback(
    (changes) => setRfEdges(es => applyEdgeChanges(changes, es)), []
  )

  const onNodeClick = useCallback((event: React.MouseEvent, node: Node) => {
    useSheetView.getState().focusRelationship(null)
    // By the time this runs, the press has ALREADY been turned into a selection
    // - React Flow applies the platform-standard rule on pointer down (plain
    // press replaces, modifier press toggles) and those changes have already
    // flowed through onNodesChange into the authoritative set.
    //
    // So this handler adopts that outcome; it must not re-derive it. Computing
    // the toggle a second time here undid the first one, which is exactly why a
    // modifier click looked like it did nothing at all. A plain click hid the
    // problem because replacing a selection twice lands in the same place.
    //
    // Re-stamping the same set is not redundant: on a sheet, select changes do
    // not reach the interaction snapshot, so this is what repaints it.
    const selection = new Set(selectedIdsRef.current)
    applySelection(selection)
    // The store's node pointer follows the selection rather than pinning it: it
    // is what the detail panel and the agent dialog read, so it should name the
    // node just acted on, and nothing at all once a group is in play.
    setSelectedNode(selection.size === 1 ? [...selection][0] : null)
    const target = event.target as HTMLElement | null
    if (!target?.closest('input, textarea, select, button, [contenteditable="true"], [data-node-editable="true"]')) {
      setInspectedNode(null)
    }
  }, [applySelection, setSelectedNode, setInspectedNode])

  const onNodeDoubleClick = useCallback((event: React.MouseEvent, node: Node) => {
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, select, button, [contenteditable="true"], [data-node-editable="true"]')) return
    setSelectedNode(node.id)
    setInspectedNode(node.id)
  }, [setSelectedNode, setInspectedNode])

  // Right-click menus on the live Floor. Right-clicking a node outside the
  // current selection selects it first, as file managers do.
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; target: CanvasContextTarget } | null>(null)
  const closeContextMenu = useCallback(() => setContextMenu(null), [])
  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    if (isolatedScene) return
    const { files, systems, infraNodes } = useGraphStore.getState()
    const kind = files.some(file => file.id === node.id)
      ? 'file'
      : systems.some(system => system.id === node.id)
        ? 'system'
        : infraNodes.some(infra => infra.id === node.id) ? 'infra' : null
    if (!kind) return
    event.preventDefault()
    if (!selectedIdsRef.current.has(node.id)) {
      applySelection(new Set([node.id]))
      setSelectedNode(node.id)
    }
    setContextMenu({ x: event.clientX, y: event.clientY, target: { kind, id: node.id } })
  }, [isolatedScene, applySelection, setSelectedNode])
  const onPaneContextMenu = useCallback((event: React.MouseEvent | MouseEvent) => {
    if (isolatedScene) return
    event.preventDefault()
    setContextMenu({ x: event.clientX, y: event.clientY, target: { kind: 'pane' } })
  }, [isolatedScene])

  const onPaneClick = useCallback(() => {
    useSheetView.getState().focusRelationship(null)
    applySelection(emptySelection())
    setSelectedNode(null)
    setInspectedNode(null)
  }, [applySelection, setSelectedNode, setInspectedNode])

  // ── Drag visibility override ─────────────────────────────────────────────
  const onNodeDragStart: OnNodeDrag = useCallback((event, node) => {
    if (resizingNodeIdRef.current === node.id) return
    setIsTransitioningLayout(false)
    setIsDraggingScene(true)
    // A drag out of the bin ends outside the canvas that started it, which is
    // not a gesture React Flow models: released over the Floor, its drag never
    // terminated and the node stayed glued to the cursor. Released back over
    // the bin it ended normally - the asymmetry that gave this away.
    //
    // So the bin owns the terminating event itself. Bound on the window in the
    // capture phase, it fires wherever the pointer happens to be.
    if (binMode) beginBinDrag(node.id)
    else if (!readOnly) beginFloorBinDrag(node.id)
    // Grabbing a node that was not part of the selection makes it the whole
    // selection, before anything reads the group this gesture will move. A drag
    // never silently carries along whatever was selected beforehand. React Flow
    // reaches the same conclusion through its own select changes; committing it
    // here keeps Ambio's authoritative set from lagging a frame behind them.
    //
    // Held modifier means the press was building a selection, not starting a
    // fresh gesture - including a press that just toggled this node OUT. Reset
    // it there and the node the user was deselecting snaps back on the smallest
    // jitter of the mouse.
    if (!isAdditiveEvent(event) && !selectedIdsRef.current.has(node.id)) {
      applySelection(selectionAfterDragStart(selectedIdsRef.current, node.id))
      setSelectedNode(node.id)
    }
    draggingNodeIdRef.current = node.id
    dragPositionRef.current.set(node.id, { x: node.position.x, y: node.position.y })
    dragAbsolutePositionsRef.current.clear()
    const startingInternal = getInternalNode(node.id)
    dragAbsolutePositionsRef.current.set(
      node.id,
      startingInternal?.internals.positionAbsolute ?? node.position,
    )
    // Forcing the dragged node fully visible is drag BEHAVIOR, not
    // instrumentation, so it has to run before the tracing gate below. A
    // semantically faded node keeps `pointerEvents: none`, and a node that
    // cannot receive its own pointerup never ends its drag - it just follows
    // the cursor until the app is reloaded.
    updateInteractiveNodes(curr => curr.map(n => n.id === node.id ? makeFullyVisible(n) : n))
    // The pointer/geometry move trace samples getBoundingClientRect and builds
    // a wide row on every pointer move, forcing synchronous layout mid-drag.
    // That is a debugging instrument, not drag behavior: leaving it hot costs
    // frames on every drag, and a multi-node drag pays it per moved node.
    // Enable with `window.__ambioDragTrace = true` when investigating drags.
    if (!dragTraceEnabled()) {
      dragTraceRef.current = null
      return
    }
    const pointer = pointerTraceCoordinates(event)
    const viewport = getViewport()
    const flowPointer = screenToFlowPosition({ x: pointer.clientX, y: pointer.clientY })
    const internal = getInternalNode(node.id)
    const absolute = internal?.internals.positionAbsolute ?? node.position
    const domRect = renderedNodeRect(node.id)
    const session = ++dragTraceSessionRef.current
    dragTraceRef.current = {
      session,
      nodeId: node.id,
      startedAt: performance.now(),
      lastLiveLogAt: 0,
      startClientX: pointer.clientX,
      startClientY: pointer.clientY,
      previousClientX: pointer.clientX,
      previousClientY: pointer.clientY,
      startFlowX: flowPointer.x,
      startFlowY: flowPointer.y,
      startNodeX: node.position.x,
      startNodeY: node.position.y,
      startAbsoluteX: absolute.x,
      startAbsoluteY: absolute.y,
      startDomLeft: domRect?.left ?? null,
      startDomTop: domRect?.top ?? null,
      previousNodeX: node.position.x,
      previousNodeY: node.position.y,
      previousChangeByNodeId: new Map([[node.id, { x: node.position.x, y: node.position.y }]]),
      callbackRows: [],
      changeRows: [],
    }
    const traceState = useSheetStore.getState()
    console.info(`[AmbioMoveTrace #${session}] start`, {
      id: node.id,
      type: node.type,
      callbackPosition: node.position,
      absolutePosition: absolute,
      parentId: node.parentId ?? null,
      viewport,
      pointerClientCssPixels: { x: pointer.clientX, y: pointer.clientY },
      pointerFlowUnits: flowPointer,
      devicePixelRatio: window.devicePixelRatio,
      conversion: `1 browser CSS px = ${1 / viewport.zoom} React Flow units at ${viewport.zoom}x zoom`,
      units: {
        clientAndDom: 'browser CSS pixels',
        nodeAndFlow: 'React Flow world units',
        screenEquivalent: 'React Flow delta multiplied by zoom (browser CSS pixels)',
        devicePixelEstimate: 'browser CSS pixels multiplied by devicePixelRatio',
      },
      activeSheetId: traceState.activeSheetId,
      planned: node.id.startsWith('planned:')
        ? traceState.planned.find(p => p.id === node.id.slice(8))
        : undefined,
      element: traceState.elements.find(e => (e.systemId ?? e.fileId ?? e.infraId) === node.id),
    })
  }, [applySelection, getInternalNode, getViewport, screenToFlowPosition, setSelectedNode, updateInteractiveNodes])

  const onNodeDrag: OnNodeDrag = useCallback((event, node) => {
    // Dragging a file out of the bin crosses a window boundary. The window
    // clips its own contents, so the real node vanishes the moment it leaves -
    // a ghost carries the gesture the rest of the way, at document level,
    // where nothing can clip it.
    // A drag that crosses between the Floor and the bin is one gesture over two
    // canvases, and whichever surface it is leaving clips or covers it. A ghost
    // carries the node the rest of the way, portalled to the document where
    // nothing can clip or stack above it.
    const crossPoint = pointerOf(event)
    const crossing = binMode
      // Leaving the bin window, which clips its own contents.
      ? !!crossPoint && !rectContains(document.querySelector('[data-bin-window]'), crossPoint)
      // Entering a bin, which is portalled above the Floor and so covers it.
      : pointOverBinTarget(crossPoint)

    if (crossing !== binCrossingRef.current) {
      binCrossingRef.current = crossing
      if (!binMode) {
        // Over a bin the canvas must hold still: the bin sits in the corner,
        // which is exactly where edge auto-pan would scroll the target out from
        // under the cursor aiming at it.
        reactFlowStore.setState({ autoPanOnNodeDrag: !crossing })
      }
    }
    if (!crossing || !crossPoint) {
      hideBinGhost()
    } else {
      const dragged = rfNodesRef.current.find(item => item.id === node.id)
      if (dragged) {
        showBinGhost({ node: dragged, scale: currentZoomRef.current })
        hideRealNode(node.id)
        // Position never enters React state, so following the cursor costs no
        // renders and cannot disturb the gesture React Flow is tracking.
        moveBinGhost(
          crossPoint.x,
          crossPoint.y,
          binMode ? !!systemAtFloorPoint(crossPoint.x, crossPoint.y) : true,
        )
      }
    }
    if (binMode) return
    if (resizingNodeIdRef.current === node.id) return
    const pointer = pointerTraceCoordinates(event)
    const clientX = pointer.clientX
    const clientY = pointer.clientY

    const moveTrace = dragTraceRef.current
    if (moveTrace?.nodeId === node.id) {
      const now = performance.now()
      const viewport = getViewport()
      const flowPointer = screenToFlowPosition({ x: clientX, y: clientY })
      const internal = getInternalNode(node.id)
      const absolute = internal?.internals.positionAbsolute ?? node.position
      const domRect = renderedNodeRect(node.id)
      const pointerStepX = clientX - moveTrace.previousClientX
      const pointerStepY = clientY - moveTrace.previousClientY
      const pointerTotalX = clientX - moveTrace.startClientX
      const pointerTotalY = clientY - moveTrace.startClientY
      const nodeStepX = node.position.x - moveTrace.previousNodeX
      const nodeStepY = node.position.y - moveTrace.previousNodeY
      const nodeTotalX = node.position.x - moveTrace.startNodeX
      const nodeTotalY = node.position.y - moveTrace.startNodeY
      const expectedFlowTotalX = pointerTotalX / viewport.zoom
      const expectedFlowTotalY = pointerTotalY / viewport.zoom
      const trackingErrorFlowX = nodeTotalX - expectedFlowTotalX
      const trackingErrorFlowY = nodeTotalY - expectedFlowTotalY
      const row: MoveTraceRow = {
        sample: moveTrace.callbackRows.length + 1,
        tMs: now - moveTrace.startedAt,
        zoom: viewport.zoom,
        viewportX: viewport.x,
        viewportY: viewport.y,
        pointerType: pointer.pointerType,
        clientX,
        clientY,
        pointerStepCssX: pointerStepX,
        pointerStepCssY: pointerStepY,
        pointerTotalCssX: pointerTotalX,
        pointerTotalCssY: pointerTotalY,
        pointerStepDeviceEstimateX: pointerStepX * window.devicePixelRatio,
        pointerStepDeviceEstimateY: pointerStepY * window.devicePixelRatio,
        eventMovementX: pointer.movementX,
        eventMovementY: pointer.movementY,
        coalescedEvents: pointer.coalescedEvents,
        expectedFlowStepX: pointerStepX / viewport.zoom,
        expectedFlowStepY: pointerStepY / viewport.zoom,
        cursorFlowX: flowPointer.x,
        cursorFlowY: flowPointer.y,
        cursorFlowTotalX: flowPointer.x - moveTrace.startFlowX,
        cursorFlowTotalY: flowPointer.y - moveTrace.startFlowY,
        nodeLocalX: node.position.x,
        nodeLocalY: node.position.y,
        nodeStepFlowX: nodeStepX,
        nodeStepFlowY: nodeStepY,
        nodeTotalFlowX: nodeTotalX,
        nodeTotalFlowY: nodeTotalY,
        nodeStepScreenX: nodeStepX * viewport.zoom,
        nodeStepScreenY: nodeStepY * viewport.zoom,
        expectedNodeX: moveTrace.startNodeX + expectedFlowTotalX,
        expectedNodeY: moveTrace.startNodeY + expectedFlowTotalY,
        trackingErrorFlowX,
        trackingErrorFlowY,
        trackingErrorScreenX: trackingErrorFlowX * viewport.zoom,
        trackingErrorScreenY: trackingErrorFlowY * viewport.zoom,
        nodeAbsoluteX: absolute.x,
        nodeAbsoluteY: absolute.y,
        absoluteTotalFlowX: absolute.x - moveTrace.startAbsoluteX,
        absoluteTotalFlowY: absolute.y - moveTrace.startAbsoluteY,
        domLeft: domRect?.left ?? null,
        domTop: domRect?.top ?? null,
        domTotalCssX: domRect && moveTrace.startDomLeft !== null ? domRect.left - moveTrace.startDomLeft : null,
        domTotalCssY: domRect && moveTrace.startDomTop !== null ? domRect.top - moveTrace.startDomTop : null,
      }
      moveTrace.callbackRows.push(row)
      moveTrace.previousClientX = clientX
      moveTrace.previousClientY = clientY
      moveTrace.previousNodeX = node.position.x
      moveTrace.previousNodeY = node.position.y
      if (now - moveTrace.lastLiveLogAt >= 250) {
        moveTrace.lastLiveLogAt = now
        console.debug(`[AmbioMoveTrace #${moveTrace.session}] live sample ${row.sample}`, row)
      }
    }

    // Freeform hit-testing: the CURSOR chooses which frame you are dropping
    // into - that is the gesture the hand is making, and requiring the whole
    // node to be inside made frames nearly impossible to hit. Containment is
    // enforced separately, at commit, by nudging the node fully inside the
    // frame it landed in. No barriers, cell snapping, sibling displacement,
    // or DOM nudges.
    dragPositionRef.current.set(node.id, { x: node.position.x, y: node.position.y })
    const currentInternal = getInternalNode(node.id)
    if (currentInternal) {
      dragAbsolutePositionsRef.current.set(node.id, {
        x: currentInternal.internals.positionAbsolute.x,
        y: currentInternal.internals.positionAbsolute.y,
      })
    }
    const cursor = screenToFlowPosition({ x: clientX, y: clientY })
    const allNodes = displayNodesRef.current
    const parentById = new Map(allNodes.map(candidate => [candidate.id, candidate.parentId ?? null]))
    const selectedDuringDrag = new Set(allNodes.filter(candidate => candidate.selected).map(candidate => candidate.id))
    selectedDuringDrag.add(node.id)
    const isInsideDraggedSubtree = (candidateId: string) => {
      let current: string | null = candidateId
      const visited = new Set<string>()
      while (current && !visited.has(current)) {
        if (selectedDuringDrag.has(current)) return true
        visited.add(current)
        current = parentById.get(current) ?? null
      }
      return false
    }
    const candidates = allNodes.filter(candidate => {
      if (candidate.id === node.id || isInsideDraggedSubtree(candidate.id) || candidate.type !== 'system') return false
      if (reviewMode && files.some(file => file.id === node.id) &&
          !reviewEditableNodeIds?.has(candidate.id)) return false
      // A live system IS a valid drop target on a sheet: nesting a planned
      // class into an existing system is the whole point of proposing one.
      // This used to exclude anything the sheet had no opinion about, which
      // made sense while the Floor was dimmed and inert beneath a sheet. The
      // Floor is fully interactive now, so the exclusion only blocked nesting.
      if (overlaySheetId && candidate.id.startsWith('planned:') &&
          !activeNodeIds.has(candidate.id)) return false
      const internal = getInternalNode(candidate.id)
      if (!internal) return false
      const absolute = internal.internals.positionAbsolute
      const width = Number(candidate.measured?.width ?? candidate.style?.width ?? 0)
      const height = Number(candidate.measured?.height ?? candidate.style?.height ?? 0)
      return cursor.x >= absolute.x && cursor.x <= absolute.x + width &&
        cursor.y >= absolute.y && cursor.y <= absolute.y + height
    }).sort((a, b) => {
      const area = (candidate: Node) => Number(candidate.measured?.width ?? candidate.style?.width ?? 0) * Number(candidate.measured?.height ?? candidate.style?.height ?? 0)
      return area(a) - area(b)
    })
    const previousTarget = dropTargetRef.current
    const nextTarget = candidates[0]?.id ?? null
    dropTargetRef.current = nextTarget
    if (previousTarget !== nextTarget) {
      updateInteractiveNodes(current => current.map(candidate => ({
        ...candidate,
        data: { ...candidate.data, isDropTarget: candidate.id === nextTarget },
      })))
    }
  }, [getInternalNode, getViewport, screenToFlowPosition, overlaySheetId, activeNodeIds, updateInteractiveNodes, reviewMode, reviewEditableNodeIds, files])

  const onNodeDragStop: OnNodeDrag = useCallback((event, node) => {
    if (resizingNodeIdRef.current === node.id) return
    const finalPosition = dragPositionRef.current.get(node.id) ?? node.position
    dragPositionRef.current.delete(node.id)
    const moveTrace = dragTraceRef.current
    if (moveTrace?.nodeId === node.id) {
      const viewport = getViewport()
      const stopPointer = pointerTraceCoordinates(event)
      const renderedPosition = displayNodesRef.current.find(n => n.id === node.id)?.position
      const nonZeroScreenSteps = moveTrace.callbackRows.flatMap(row => {
        const x = typeof row.nodeStepScreenX === 'number' ? Math.abs(row.nodeStepScreenX) : 0
        const y = typeof row.nodeStepScreenY === 'number' ? Math.abs(row.nodeStepScreenY) : 0
        return [x, y].filter(value => value > Number.EPSILON)
      })
      const nonZeroFlowSteps = moveTrace.callbackRows.flatMap(row => {
        const x = typeof row.nodeStepFlowX === 'number' ? Math.abs(row.nodeStepFlowX) : 0
        const y = typeof row.nodeStepFlowY === 'number' ? Math.abs(row.nodeStepFlowY) : 0
        return [x, y].filter(value => value > Number.EPSILON)
      })
      const summary = {
        id: node.id,
        parentId: node.parentId ?? null,
        elapsedMs: performance.now() - moveTrace.startedAt,
        zoomAtStop: viewport.zoom,
        browserCssPixelsPerFlowUnit: viewport.zoom,
        flowUnitsPerBrowserCssPixel: 1 / viewport.zoom,
        devicePixelRatio: window.devicePixelRatio,
        callbackSamples: moveTrace.callbackRows.length,
        reactFlowPositionChanges: moveTrace.changeRows.length,
        smallestObservedNodeStepFlowUnits: nonZeroFlowSteps.length ? Math.min(...nonZeroFlowSteps) : 0,
        smallestObservedNodeStepBrowserCssPixels: nonZeroScreenSteps.length ? Math.min(...nonZeroScreenSteps) : 0,
        startPointerCss: { x: moveTrace.startClientX, y: moveTrace.startClientY },
        stopPointerCss: { x: stopPointer.clientX, y: stopPointer.clientY },
        totalPointerCss: {
          x: stopPointer.clientX - moveTrace.startClientX,
          y: stopPointer.clientY - moveTrace.startClientY,
        },
        startNodeFlow: { x: moveTrace.startNodeX, y: moveTrace.startNodeY },
        callbackPosition: node.position,
        authoritativePosition: finalPosition,
        renderedPosition,
        totalNodeFlow: {
          x: finalPosition.x - moveTrace.startNodeX,
          y: finalPosition.y - moveTrace.startNodeY,
        },
        totalNodeScreenEquivalent: {
          x: (finalPosition.x - moveTrace.startNodeX) * viewport.zoom,
          y: (finalPosition.y - moveTrace.startNodeY) * viewport.zoom,
        },
      }
      console.groupCollapsed(`[AmbioMoveTrace #${moveTrace.session}] COMPLETE - ${node.id}`)
      console.info('Summary and unit conversion', summary)
      console.info('Drag callback samples - pointer input compared with node output')
      console.table(moveTrace.callbackRows)
      console.info('Raw onNodesChange position emissions from React Flow')
      console.table(moveTrace.changeRows)
      console.log('Copyable raw trace', {
        summary,
        callbackSamples: moveTrace.callbackRows,
        reactFlowPositionChanges: moveTrace.changeRows,
      })
      console.groupEnd()
      dragTraceRef.current = null
    }
    // Clear drag state - restore zoom visibility, clear drop highlight
    setIsDraggingScene(false)
    // Both bin gestures are resolved before any layout write, because a file
    // crossing between canvases must not also persist a position on the canvas
    // it just left.
    const pointer = pointerOf(event)
    if (binMode) {
      // The window listener normally got here first; this covers the gesture
      // that ended inside the bin, where React Flow's own drag does terminate.
      if (pointer) finishBinDrag(pointer.x, pointer.y, 'react-flow-dragstop')
      draggingNodeIdRef.current = null
      dropTargetRef.current = null
      return
    }
    // The window listener normally got here first; this covers a release the
    // Floor's own drag did terminate.
    if (!binMode && pointer && finishFloorBinDrag(pointer.x, pointer.y, 'react-flow-dragstop')) {
      draggingNodeIdRef.current = null
      dropTargetRef.current = null
      return
    }
    if (!binMode) {
      floorBinDragRef.current = null
      hideBinGhost()
    }
    draggingNodeIdRef.current = null
    const prevTarget = dropTargetRef.current
    dropTargetRef.current = null

    // Direct DOM cleanup of the React Flow node wrapper styles
    const el = document.querySelector(`.react-flow__node[data-id="${node.id}"]`) as HTMLElement | null
    if (el) {
      el.style.transition = ''
      el.style.marginLeft = ''
      el.style.marginTop = ''
    }
    // A drop is one atomic frame transform. On the Floor it may also change
    // what a node belongs to (see the save below); sheets and reviews only
    // ever rewrite their own layout layer.
    const sheetState = useSheetStore.getState()
    const sheetId = isolatedScene ? null : sheetState.activeSheetId
    const graph = useGraphStore.getState()
    const workspaceId = reviewScene?.workspaceId ?? (sheetId ? workspaceIdForOverlay : graph.currentProject?.id)
    const all = displayNodesRef.current
    const absolutePositions = new Map(all.map(candidate => [
      candidate.id,
      getInternalNode(candidate.id)?.internals.positionAbsolute ?? candidate.position,
    ]))
    // Position changes are the authoritative gesture output. They can be one
    // React render ahead of both displayNodesRef and XYFlow's internal store.
    for (const [id, position] of dragAbsolutePositionsRef.current) {
      absolutePositions.set(id, position)
    }
    // The stop callback owns the primary node's final local position. Derive
    // its absolute value explicitly so a final pointer move without a committed
    // onNodesChange sample cannot be lost.
    const dragged = all.find(candidate => candidate.id === node.id)
    const parentAbsolute = dragged?.parentId
      ? absolutePositions.get(dragged.parentId) ?? { x: 0, y: 0 }
      : { x: 0, y: 0 }
    absolutePositions.set(node.id, {
      x: parentAbsolute.x + finalPosition.x,
      y: parentAbsolute.y + finalPosition.y,
    })
    dragAbsolutePositionsRef.current.clear()

    // This is the only drop engine. A Sheet changes the writable layout layer
    // and selection boundary; geometry, collision, packing, containment,
    // size parity, and compression are the live Canvas implementation.
    const plan = planCanvasDrop({
      workspaceId: workspaceId ?? null,
      draggedNodeId: node.id,
      targetNodeId: prevTarget,
      allNodes: all,
      absolutePositions,
      systemIds: sheetId
        ? sheetSystemIds
        : new Set(systems.map(system => system.id)),
      fileIds: sheetId
        ? sheetFileIds
        : new Set(files.map(file => file.id)),
      infraIds: sheetId
        ? sheetInfraIds
        : new Set(infraNodes.map(infra => infra.id)),
      floorLayouts: reviewScene ? floorLayouts : sheetId ? sheetEffectiveLayouts : graph.floorLayouts,
      editableNodeIds: reviewEditableNodeIds ?? (sheetId ? activeNodeIds : undefined),
    })

    if (workspaceId && plan.updates.length > 0) {
      setIsTransitioningLayout(false)
      if (reviewMode && previewReviewLayouts && saveReviewLayouts) {
        const withoutPersistenceFields = (layouts: FloorLayout[]) => layouts.map(({
          workspaceId: _workspaceId,
          updatedAt: _updatedAt,
          ...layout
        }) => layout)
        previewReviewLayouts(withoutPersistenceFields(plan.arrivalLayouts))
        requestAnimationFrame(() => {
          setIsTransitioningLayout(true)
          requestAnimationFrame(() => {
            void saveReviewLayouts(plan.updates).catch(error => {
              console.error('[AmbioCanvas] proposal group drop failed', error)
            })
            window.setTimeout(() => setIsTransitioningLayout(false), LAYOUT_TRANSITION_MS)
          })
        })
      } else if (sheetId) {
        const rollbackLayouts = sheetState.layouts
        const arrivalMutations = plan.arrivalLayouts.map(({
          workspaceId: _workspaceId,
          updatedAt: _updatedAt,
          ...layout
        }) => layout)
        sheetState.previewLayoutsBatch(workspaceId, sheetId, arrivalMutations)
        // The transient XYFlow interaction snapshot has completed its one job.
        // Keeping it alive masks the optimistic canonical layouts and made
        // nodes jump back as soon as selection changed.
        setSheetInteractionNodes(null)
        requestAnimationFrame(() => {
          setIsTransitioningLayout(true)
          requestAnimationFrame(() => {
            void sheetState.updateLayoutsBatch(
              workspaceId,
              sheetId,
              plan.updates,
              rollbackLayouts,
            ).catch(() => {})
            window.setTimeout(() => setIsTransitioningLayout(false), LAYOUT_TRANSITION_MS)
          })
        })
      } else {
        // On the Floor, placement is meaning: landing inside another system
        // moves the node there (docs/PRODUCT.md §2). Ownership is recorded
        // first, so the layout saved after it can never disagree with it.
        // Compare with the owner the Floor shows: inferred systems never reach
        // the canvas, so their files sit at the top level until someone
        // places them, and moving one around there changes nothing.
        const shownSystemIds = new Set(graph.systems.map(system => system.id))
        const shown = (id: string | null | undefined) => (id && shownSystemIds.has(id) ? id : null)
        const meaningEdits = meaningEditsForDrop(plan.updates, {
          fileSystem: new Map(graph.files.map(file => [file.id, shown(file.systemId)])),
          systemParent: new Map(graph.systems.map(system => [system.id, shown(system.parentId)])),
        })
        const restoreLayouts = () => useGraphStore.setState(state => ({
          floorLayouts: replaceFloorLayouts(state.floorLayouts, plan.previousLayouts, plan.changedKeys),
        }))
        const ownershipRecorded = meaningEdits.length === 0
          ? Promise.resolve(true)
          : commitMeaningEdits(workspaceId, meaningEdits, describeDropEdits(meaningEdits, {
              file: id => graph.files.find(file => file.id === id)?.relPath.split('/').pop() ?? 'File',
              system: id => id === null ? 'no system' : graph.systems.find(system => system.id === id)?.name ?? 'a system',
            }))
        useGraphStore.setState(state => ({
          floorLayouts: replaceFloorLayouts(state.floorLayouts, plan.arrivalLayouts, plan.changedKeys),
        }))
        requestAnimationFrame(() => {
          setIsTransitioningLayout(true)
          requestAnimationFrame(() => {
            useGraphStore.setState(state => ({
              floorLayouts: replaceFloorLayouts(state.floorLayouts, plan.optimisticLayouts, plan.changedKeys),
            }))
            window.setTimeout(() => setIsTransitioningLayout(false), LAYOUT_TRANSITION_MS)
            void ownershipRecorded.then(recorded => {
              if (!recorded) {
                restoreLayouts()
                return
              }
              return apiSaveFloorLayouts(workspaceId, plan.updates).then(() => {
                // A drop into another system is a meaning edit with its own
                // undo; only a plain move is undone as placement.
                if (meaningEdits.length === 0) pushFloorLayoutUndo(workspaceId, 'Move', plan.previousLayouts, plan.updates)
              }).catch(error => {
                console.error('[AmbioCanvas] floor group drop failed', error)
                restoreLayouts()
              })
            })
          })
        })
      }
    }

    // A drop the layer refused to plan (a sheet node the sheet cannot move) has
    // no group of its own, and must not be read as "the user selected nothing".
    if (plan.selectedIds.length > 0) commitSelection(new Set(plan.selectedIds))
    sceneSourceRef.current = `${sheetId ? 'sheet' : 'floor'}-drop${plan.updates.length > 1 ? '-repack' : ''}`
    if (sheetId) {
      // Selection is projected from selectedIdsRef/selectionRevision. Do not
      // recreate a stale sheetInteractionNodes snapshot merely to clear flags.
      setSheetInteractionNodes(null)
    } else {
      updateInteractiveNodes(current => current.map(candidate => ({
        ...candidate,
        selected: plan.selectedIds.length > 0
          ? plan.selectedIds.includes(candidate.id)
          : candidate.selected,
        data: { ...candidate.data, isDropTarget: false, snapPreview: null, previewOffset: null },
      })))
    }

  }, [currentProject, getInternalNode, getViewport, screenToFlowPosition, overlaySheetId, activeElementByNodeId, activePlannedByNodeId, activeNodeIds, workspaceIdForOverlay, updateInteractiveNodes, sheetSystemIds, sheetFileIds, sheetInfraIds, sheetEffectiveLayouts, reviewMode, reviewScene?.workspaceId, reviewEditableNodeIds, previewReviewLayouts, saveReviewLayouts, systems, files, infraNodes, floorLayouts])

  // Meaning edits offered to nodes on the live Floor (floorEditContext). The
  // value is stable: it reads current state when called, so providing it
  // never re-renders the map.
  const floorEdits = useMemo<FloorEdits | null>(() => floorEditable ? {
    canRename: id => useGraphStore.getState().systems.some(system => system.id === id),
    renameSystem: (id, name) => {
      const workspaceId = useGraphStore.getState().currentProject?.id
      const system = useGraphStore.getState().systems.find(candidate => candidate.id === id)
      if (!workspaceId || !system || system.name === name) return
      void commitMeaningEdits(workspaceId, [{ op: 'rename', systemId: id, name }], `${system.name} renamed to ${name}`)
    },
  } : null, [floorEditable])

  // A removal takes the node out of the sheet's picture only (contract: "a
  // proposal never touches reality"); what sits inside it goes with it.
  const sheetRemovedIds = useMemo(() => new Set(
    overlaySheetId ? visibleLayers.flatMap(layer => (layer.removals ?? []).map(removal => removal.nodeId)) : [],
  ), [overlaySheetId, visibleLayers])

  const renderedNodes = useMemo(() => {
    if (!overlaySheetId) return attentionNodes
    const parentOf = new Map(attentionNodes.map(n => [n.id, n.parentId]))
    const removed = (id: string) => {
      for (let current: string | undefined = id, hops = 0; current && hops < 64; current = parentOf.get(current), hops++) {
        if (sheetRemovedIds.has(current)) return true
      }
      return false
    }
    return attentionNodes.map(n => {
      if (sheetRemovedIds.size > 0 && removed(n.id)) return n.hidden ? n : { ...n, hidden: true }
      return n
    })
  }, [attentionNodes, overlaySheetId, activeNodeIds, readOnly, getResizeHandlers, sheetRemovedIds])

  // A palette click can find a free root slot beyond the viewport. Reveal it
  // after React Flow measures it, so the new node never feels lost.
  useEffect(() => {
    if (!stencilFocusId || !nodesInitialized) return
    if (!overlaySheetId) { setStencilFocusId(null); return }
    if (!getInternalNode(stencilFocusId)?.measured?.width) return
    setStencilFocusId(null)
    void fitView({ nodes: [{ id: stencilFocusId }], padding: 0.25, duration: 350, maxZoom: 1.2 })
  }, [stencilFocusId, nodesInitialized, renderedNodes, overlaySheetId, getInternalNode, fitView])

  // Identity of renderedNodes churns every render while a sheet overlay is
  // open, so the recovery below keys off this value-stable signature instead.
  const sceneIdentityRef = useRef<{ projectId: string; ids: string[]; signature: string }>()
  const renderedSceneSignature = useMemo(() => {
    const previous = sceneIdentityRef.current
    if (previous?.projectId === sceneProjectId && previous.ids.length === renderedNodes.length &&
      renderedNodes.every((node, i) => node.id === previous.ids[i])) return previous.signature
    const ids = renderedNodes.map(node => node.id)
    const signature = `${sceneProjectId}:${[...ids].sort().join('|')}`
    sceneIdentityRef.current = { projectId: sceneProjectId, ids, signature }
    return signature
  }, [renderedNodes, sceneProjectId])
  const attachNodeInteractions = useCallback((node: Node): Node => {
    const editable = !readOnly && (!reviewMode || reviewLayoutReady)
    const handlers = editable ? getResizeHandlers(node.id, Boolean(overlaySheetId && activeNodeIds.has(node.id))) : undefined
    if (node.data.onResizeStart === handlers?.onResizeStart && node.data.onResizeEnd === handlers?.onResizeEnd) return node
    return { ...node, data: { ...node.data, onResizeStart: handlers?.onResizeStart, onResizeEnd: handlers?.onResizeEnd } }
  }, [readOnly, reviewMode, reviewLayoutReady, getResizeHandlers, overlaySheetId, activeNodeIds])
  const resizeOwner = resizingNodeIdRef.current
  const pinnedResizeOwners = useMemo(() => new Set(resizeOwner ? [resizeOwner] : []), [resizeOwner])
  const renderBudget = useCanvasRenderBudget(renderedNodes, renderedNodes.length > VIEWPORT_CULLING_NODE_COUNT, displayEdges, isTransitioningLayout, pinnedResizeOwners, sceneWorker, attachNodeInteractions)
  useEffect(() => {
    const retained = new Set(renderBudget.nodes.map(node => node.id))
    for (const key of resizeHandlersRef.current.keys()) {
      const id = key.slice(0, key.lastIndexOf(':'))
      if (!retained.has(id) && !resizeStartRef.current.has(id)) resizeHandlersRef.current.delete(key)
    }
  }, [renderBudget.nodes])
  useCanvasFrameTiming()
  const renderedNodesRef = useRef(renderedNodes)
  renderedNodesRef.current = renderedNodes

  // Scene-mutation tracer. Diffs what is actually about to be painted, so a
  // frame where geometry jumps is attributed to the path that caused it.
  useEffect(() => {
    if (!sceneTracingEnabled()) {
      if (sceneSnapshotRef.current.length) sceneSnapshotRef.current = []
      return
    }
    const next = sceneGeometry(renderedNodes)
    const delta = diffScene(sceneSnapshotRef.current, next)
    sceneSnapshotRef.current = next
    if (sceneDeltaIsQuiet(delta)) return
    recordSceneMutation({
      ...delta,
      at: Math.round(performance.now()),
      source: sceneSourceRef.current,
      zoom: currentZoomRef.current,
      nodeCount: next.length,
      dragging: draggingNodeIdRef.current,
    })
  }, [renderedNodes])

  useEffect(() => {
    if (canonicalNodeCount === 0 || renderedNodesRef.current.length === 0) return
    const signature = renderedSceneSignature
    const timer = window.setTimeout(() => {
      const root = canvasRootRef.current
      if (!root) return
      const domNodes = [...root.querySelectorAll<HTMLElement>('.react-flow__node')]
      const visibleDomNodeCount = domNodes.filter(node => {
        const style = window.getComputedStyle(node)
        return style.visibility !== 'hidden' &&
          style.display !== 'none' &&
          Number(style.opacity) > 0.1
      }).length
      if (visibleDomNodeCount > 0) {
        domSceneRecoveryRef.current = ''
        return
      }
      if (domSceneRecoveryRef.current === signature) return
      domSceneRecoveryRef.current = signature
      console.error('[scene-integrity] React Flow DOM diverged from controlled scene', {
        projectId: sceneProjectId,
        canonicalNodeCount,
        candidateNodeCount: candidateRfNodes.length,
        renderedNodeCount: renderedNodesRef.current.length,
        domNodeCount: domNodes.length,
        visibleDomNodeCount,
        candidateIntegrity: candidateSceneIntegrity,
      })
      // Re-issue fresh node objects once. This re-synchronizes React Flow's
      // internal lookup with the still-valid controlled projection.
      sceneSourceRef.current = 'dom-recovery'
      setRfNodes(current => current.map(node => ({ ...node })))
    }, 80)
    return () => window.clearTimeout(timer)
  }, [
    candidateSceneIntegrity,
    canonicalNodeCount,
    renderedSceneSignature,
    sceneProjectId,
  ])

  const traceSuspiciousCursor = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!(window as unknown as { __ambioCursorDebug?: boolean }).__ambioCursorDebug) return
    const element = document.elementFromPoint(event.clientX, event.clientY) as HTMLElement | null
    if (!element) return
    const cursor = window.getComputedStyle(element).cursor
    if (!['crosshair', 'cell', 'copy', 'alias'].includes(cursor)) return
    const ancestry: string[] = []
    let current: HTMLElement | null = element
    for (let depth = 0; current && depth < 7; depth++, current = current.parentElement) {
      ancestry.push([
        current.tagName.toLowerCase(),
        current.id ? `#${current.id}` : '',
        ...[...current.classList].map(name => `.${name}`),
        current.dataset.id ? `[data-id=${current.dataset.id}]` : '',
      ].join(''))
    }
    const signature = `${cursor}|${ancestry.join('>')}|${selectionMode}|${overlaySheetId ?? 'floor'}`
    if (cursorTraceSignatureRef.current === signature) return
    cursorTraceSignatureRef.current = signature
    console.warn('[AmbioCursorTrace]', {
      cursor,
      element: ancestry[0],
      ancestry,
      selectionMode,
      sheetId: overlaySheetId,
      readOnly,
      nodeConnectionsEnabled: !readOnly && !!overlaySheetId,
    })
  }, [selectionMode, overlaySheetId, readOnly])

  const traceCanvasHit = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    if (!event.altKey) return
    const point = { x: event.clientX, y: event.clientY }
    const stack = document.elementsFromPoint(point.x, point.y).slice(0, 12).map(element => {
      const html = element as HTMLElement
      return {
        tag: html.tagName.toLowerCase(),
        id: html.id || null,
        className: typeof html.className === 'string' ? html.className : null,
        dataId: html.dataset?.id ?? null,
        resizeDirection: html.dataset?.resizeDirection ?? null,
        pointerEvents: getComputedStyle(html).pointerEvents,
      }
    })
    const claimingNodes = [...(canvasRootRef.current?.querySelectorAll<HTMLElement>('.react-flow__node') ?? [])]
      .filter(element => {
        const rect = element.getBoundingClientRect()
        return point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom
      })
      .map(element => {
        const id = element.dataset.id ?? ''
        const rect = element.getBoundingClientRect()
        const node = displayNodesRef.current.find(candidate => candidate.id === id)
        const resizer = [...(canvasRootRef.current?.querySelectorAll<HTMLElement>('.ambio-node-resizer') ?? [])]
          .find(candidate => candidate.dataset.nodeId === id) ?? null
        const handles = resizer ? [...resizer.querySelectorAll<HTMLElement>('.ambio-floating-resize-handle')] : []
        return {
          id,
          selected: element.classList.contains('selected'),
          rectX: rect.x,
          rectY: rect.y,
          rectWidth: rect.width,
          rectHeight: rect.height,
          pointerEvents: getComputedStyle(element).pointerEvents,
          inlineStyle: element.getAttribute('style'),
          modelWidth: node?.width ?? null,
          modelHeight: node?.height ?? null,
          modelStyleWidth: node?.style?.width ?? null,
          modelStyleHeight: node?.style?.height ?? null,
          resizerRect: resizer ? (() => {
            const value = resizer.getBoundingClientRect()
            return { x: value.x, y: value.y, width: value.width, height: value.height }
          })() : null,
          handleRects: handles.map(handle => {
            const value = handle.getBoundingClientRect()
            return { direction: handle.dataset.resizeDirection, x: value.x, y: value.y, width: value.width, height: value.height }
          }),
        }
      })
    const payload = {
      point,
      viewport: getViewport(),
      target: stack[0] ?? null,
      elementStack: stack,
      claimingNodes,
    }
    const flatNodes = claimingNodes.map(node => {
      const handles = node.handleRects.map(handle =>
        `${handle.direction}:${handle.width.toFixed(1)}x${handle.height.toFixed(1)}`).join(',') || 'none'
      return `${node.id}[selected=${node.selected},rect=${node.rectWidth.toFixed(1)}x${node.rectHeight.toFixed(1)},handles=${handles}]`
    }).join(' | ') || 'none'
    console.warn(
      `[AmbioHitTraceSummary] point=${point.x},${point.y} zoom=${payload.viewport.zoom} ` +
      `target=${payload.target?.className ?? payload.target?.tag ?? 'none'} claiming=${flatNodes}`,
    )
    console.warn('[AmbioHitTrace]', payload)
    window.setTimeout(() => {
      const selected = [...(canvasRootRef.current?.querySelectorAll<HTMLElement>('.react-flow__node.selected') ?? [])]
        .map(element => {
          const rect = element.getBoundingClientRect()
          const resizer = [...(canvasRootRef.current?.querySelectorAll<HTMLElement>('.ambio-node-resizer') ?? [])]
            .find(candidate => candidate.dataset.nodeId === element.dataset.id)
          const firstHandle = resizer?.querySelector<HTMLElement>('.ambio-floating-resize-handle') ?? null
          const firstVisual = firstHandle?.firstElementChild as HTMLElement | null
          const hitRect = firstHandle?.getBoundingClientRect()
          const visualRect = firstVisual?.getBoundingClientRect()
          return `${element.dataset.id}[node=${rect.width.toFixed(1)}x${rect.height.toFixed(1)},` +
            `hit=${hitRect ? `${hitRect.width.toFixed(1)}x${hitRect.height.toFixed(1)}` : 'none'},` +
            `visual=${visualRect ? `${visualRect.width.toFixed(1)}x${visualRect.height.toFixed(1)}` : 'none'}]`
        })
      console.warn(`[AmbioPostClickSummary] selected=${selected.join(' | ') || 'none'}`)
    }, 100)
  }, [getViewport])

  const onCanvasPointerDownCapture = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    traceCanvasHit(event)
    const target = event.target as HTMLElement
    // Review exposes every child. Capture a genuine pane pan so Chromium need
    // not hit-test that entire painted tree again for each mouse position.
    // Leave node gestures, Shift/lasso selection and touch/pinch to React Flow.
    if (!reviewMode || event.pointerType !== 'mouse' || !event.isPrimary || event.ctrlKey ||
        event.button > 2 || (event.button === 2 && !selectionMode) ||
        !target.classList.contains('react-flow__pane') || target.closest(`[${CANVAS_SCOPE_ATTR}]`) !== event.currentTarget ||
        (event.button === 0 && (selectionMode || event.shiftKey))) return
    try { target.setPointerCapture(event.pointerId) }
    catch { /* A cancelled/synthetic pointer can use Flow's ordinary pan path. */ }
  }, [reviewMode, selectionMode, traceCanvasHit])

  // Canvas commands (docs/INFRA.md, "Canvas chrome"): zoom, tidy and
  // the infrastructure sidebar live in the View and Map menus, the palette
  // and the keyboard (src/shared/appMenu.ts) rather than as buttons on the
  // canvas. Fit is the toolbar's. Only the main canvas answers them.
  const tidyFrameRef = useRef(tidyFrame)
  tidyFrameRef.current = tidyFrame
  useCommandHandlers({
    'view.zoomMapIn': () => { if (!binMode) void zoomIn({ duration: 180 }) },
    'view.zoomMapOut': () => { if (!binMode) void zoomOut({ duration: 180 }) },
    'map.tidy': () => { if (!binMode && !readOnly) void tidyFrameRef.current() },
    'view.sheetRelationships': () => { if (!binMode && !reviewMode && overlaySheetId) useSheetView.getState().toggleRelationships() },
    'view.infrastructure': () => {
      if (binMode || reviewMode) return
      const store = useGraphStore.getState()
      store.setInfraSidebarOpen(!store.infraSidebarOpen)
    },
  })

  // ── Hosting frames ────────────────────────────────────────────────────────
  // A confirmed platform wraps the code it runs, nested the way it really is
  // (docs/INFRA.md, "Canvas placement"). Arranged once per platform:
  // afterwards the frame is the person's to rearrange, and emptying it on
  // purpose must not make it grab the code back.
  const infraContents = useGraphStore(s => s.infraContents)
  const hostingArrangedRef = useRef(new Set<string>())
  useEffect(() => {
    if (isolatedScene || readOnly || !currentProject || hostingInfraNodes.length === 0) return
    const workspaceId = currentProject.id
    const platforms = hostingInfraNodes.map(node => {
      const instance = readDetectedBy(node.detectedBy).instance
      return {
        id: node.id,
        key: instance ? `${node.service}#${instance}` : node.service,
        name: node.name,
        hosts: infraContents
          .filter(item => item.infraId === node.id && item.kind === 'hosts')
          .map(item => ({
            dir: typeof item.detail?.dir === 'string' ? item.detail.dir : '.',
            via: typeof item.detail?.via === 'string' ? item.detail.via : undefined,
          })),
      }
    })
    const runsOn = dependencies.filter(dep => dep.dstType === 'infra' && dep.status !== 'dismissed'
      && (dep.dependencyType === 'RUNS_ON' || dep.dependencyType === 'DEPLOYS_TO'))
    const plan = planHosting({ platforms, systems, files, runsOn })
    if (plan.parentOf.size === 0) return
    const layoutById = new Map(floorLayouts.map(layout => [layout.nodeId, layout]))
    const frameIds = new Set(platforms.map(platform => platform.id))
    const parents = new Set(plan.parentOf.values())
    const outermost = [...parents].filter(id => !plan.parentOf.has(id))
    const storageKey = (id: string) => `ambio:hosting-arranged:${workspaceId}:${id}`
    const remembered = (id: string) => {
      try { return window.localStorage.getItem(storageKey(id)) === '1' } catch { return false }
    }
    const remember = (id: string) => {
      hostingArrangedRef.current.add(`${workspaceId}:${id}`)
      try { window.localStorage.setItem(storageKey(id), '1') } catch { /* per-session only */ }
    }
    for (const rootFrame of outermost) {
      if (hostingArrangedRef.current.has(`${workspaceId}:${rootFrame}`) || remembered(rootFrame)) continue
      const members: string[] = []
      const collect = (frame: string) => {
        for (const [child, parent] of plan.parentOf) if (parent === frame) { members.push(child); collect(child) }
      }
      collect(rootFrame)
      if (members.every(member => layoutById.get(member)?.parentNodeId === plan.parentOf.get(member))) {
        remember(rootFrame)
        continue
      }
      // Code someone already put in a frame of their own stays there.
      const claimed = members.filter(member => {
        const parent = layoutById.get(member)?.parentNodeId ?? null
        return parent !== null && !frameIds.has(parent)
      })
      if (claimed.length > 0) { remember(rootFrame); continue }
      const rendered = displayNodesRef.current
      const rects = absoluteRects(rendered)
      const current = new Map<string, HostedChild>()
      for (const member of members) {
        const rect = rects.get(member)
        const layout = layoutById.get(member)
        if (!rect) continue
        current.set(member, {
          id: member,
          nodeType: frameIds.has(member) ? 'infra' : 'system',
          worldX: rect.x,
          worldY: rect.y,
          width: layout?.width ?? rect.width,
          height: layout?.height ?? rect.height,
          scale: layout?.scale ?? 1,
          interiorScale: layout?.interiorScale ?? 1,
        })
      }
      if (current.size === 0) continue
      const moving = new Set([rootFrame, ...members])
      const occupied = rendered
        .filter(node => !node.parentId && !moving.has(node.id) && !node.hidden)
        .map(node => rects.get(node.id))
        .filter((rect): rect is NonNullable<typeof rect> => Boolean(rect))
      const rows = arrangeHosting(rootFrame, plan, current, occupied)
      remember(rootFrame)
      const changedKeys = new Set(rows.map(row => `${row.nodeType}:${row.nodeId}`))
      const previousLayouts = floorLayouts.filter(item => changedKeys.has(`${item.nodeType}:${item.nodeId}`))
      useGraphStore.setState(state => ({
        floorLayouts: replaceFloorLayouts(state.floorLayouts,
          rows.map(row => ({ ...row, workspaceId, updatedAt: Date.now() })), changedKeys),
      }))
      void apiSaveFloorLayouts(workspaceId, rows).catch(error => {
        console.error('[AmbioCanvas] hosting arrangement failed', error)
        useGraphStore.setState(state => ({
          floorLayouts: replaceFloorLayouts(state.floorLayouts, previousLayouts, changedKeys),
        }))
      })
    }
  }, [isolatedScene, readOnly, currentProject, hostingInfraNodes, infraContents, dependencies, systems, files, floorLayouts])

  return (
    <div
      ref={canvasRootRef}
      {...{ [CANVAS_SCOPE_ATTR]: '' }}
      data-canonical-node-count={renderedNodes.length}
      data-scene-preparing={floorPending || sheetPreparation.pending || floorPreparation.error || sheetPreparation.error ? 'true' : undefined}
      className={[
        reviewMode ? 'ambio-canvas-review' : '',
        reviewMode && reviewLayoutReady ? 'ambio-canvas-review-ready' : '',
        isTransitioningLayout ? 'layout-transition' : '',
        isDraggingScene ? 'ambio-dragging' : '',
        // Sheet mode is signalled by the SURFACE, not by degrading the nodes.
        // The architecture stays at full fidelity because a sheet is where you
        // work on it; the environment is what tells you edits are a proposal.
        // Driven by phase, not by the raw id, so leaving animates too.
        sheetPhase.phase ? 'ambio-sheet-mode' : '',
      ].filter(Boolean).join(' ') || undefined}
      data-sheet-phase={sheetPhase.phase ?? undefined}
      onDragOverCapture={onOverlayDragOver}
      onDropCapture={onOverlayDrop}
      onPointerDownCapture={onCanvasPointerDownCapture}
      onPointerMoveCapture={traceSuspiciousCursor}
      style={{ width: '100%', height: '100%', position: 'relative' }}
    >
      {(floorPending || sheetPreparation.pending || floorPreparation.error || sheetPreparation.error) &&
        <div className="ambio-canvas-preparation" role="status">
          {floorPreparation.error || sheetPreparation.error || 'Preparing map…'}
          {(floorPreparation.error || sheetPreparation.error) && <button onClick={() => setPreparationRetry(n => n + 1)}>Retry</button>}
        </div>}
      <FloorEditContext.Provider value={floorEdits}>
      <RenderBudgetContext.Provider value={renderBudget.budget}>
      <ReactFlow
        zoomOnScroll={false}
        nodes={renderBudget.nodes}
        edges={renderBudget.edges}
        nodeTypes={NODE_TYPES}
        edgeTypes={EDGE_TYPES}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        onNodesChange={readOnly ? undefined : onNodesChange}
        onEdgesChange={readOnly ? undefined : onEdgesChange}
        onConnect={readOnly ? undefined : overlaySheetId ? onConnectPlanned : floorEditable ? onConnectFloor : undefined}
        onEdgeClick={(_event, edge) => {
          if (!overlaySheetId || !edge.id.startsWith('pedge:')) return
          applySelection(new Set([edge.source]))
          setSelectedNode(edge.source)
          setInspectedNode(null)
          useSheetView.getState().focusRelationship(edge.id.slice('pedge:'.length))
        }}
        onNodeClick={onNodeClick}
        onNodeDoubleClick={onNodeDoubleClick}
        onPaneClick={onPaneClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneContextMenu={onPaneContextMenu}
        onSelectionDragStart={readOnly ? undefined : onSelectionDragStart}
        onSelectionDragStop={readOnly ? undefined : onSelectionDragStop}
        onNodeDragStart={readOnly ? undefined : onNodeDragStart}
        onNodeDrag={readOnly ? undefined : onNodeDrag}
        onNodeDragStop={readOnly ? undefined : onNodeDragStop}
        onMove={onMove}
        minZoom={MIN_CANVAS_ZOOM}
        maxZoom={MAX_CANVAS_ZOOM}
        defaultViewport={INITIAL_VIEWPORT}
        fitViewOptions={INITIAL_FIT_OPTIONS}
        proOptions={FLOW_PRO_OPTIONS}
        panOnDrag={selectionMode ? SELECTION_PAN_BUTTONS : true}
        selectionOnDrag={readOnly ? false : selectionMode}
        selectionMode={selectionMode ? SelectionMode.Partial : SelectionMode.Full}
        // Must match what the click handler treats as "add to my selection", or
        // React Flow collapses the selection on the same click Ambio extends it
        // on, and the highlight disagrees with what the next drag picks up.
        multiSelectionKeyCode={MULTI_SELECTION_KEYS}
        nodesDraggable={!readOnly}
        nodesConnectable={!readOnly && (!!overlaySheetId || floorEditable)}
        // Source and target handles share each side, and the target is drawn
        // on top; loose mode lets a drag from any handle reach any other, with
        // the node it started from as the source.
        connectionMode={ConnectionMode.Loose}
        onConnectStart={onConnectStart}
        deleteKeyCode={null}
        elementsSelectable={!readOnly}
        snapToGrid={false}
        // Hidden nodes otherwise still get a NodeWrapper and store subscription.
        // Keep the full geometry in Flow for Fit, navigation and picking, but
        // bound its component tree too. The budget still owns buffered detail
        // admission; Flow retains measured handles after an endpoint unmounts.
        // A CSS glide still paints between its old and new canonical positions.
        // Retain the existing transition path until it finishes, so exact
        // culling cannot cut off a card that is still moving through the view.
        onlyRenderVisibleElements={renderedNodes.length > VIEWPORT_CULLING_NODE_COUNT && !isTransitioningLayout}
      >
        {/* Pattern color transparent - the drafting line grid is painted by
            .react-flow__background CSS; this component just provides the element. */}
        <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="transparent" />
        <CanvasMiniMap />
        <LivingFlowOverlay
          events={relationshipFx}
          nodes={livingDisplayNodes}
          visibilityOptions={livingVisibilityOptions}
        />
        <RunTraceOverlay
          steps={activeTrace}
          callouts={runCalloutList}
          nodes={livingDisplayNodes}
          visibilityOptions={livingVisibilityOptions}
        />
        {deferCanvasMaterialization && (
          <Panel position="top-center" className="ambio-canvas-materializing">
            <div role="status" aria-live="polite">
              <span aria-hidden="true" />
              <div>
                <strong>Organizing {files.length.toLocaleString()} files</strong>
                <small>Building stable architecture before drawing the Floor</small>
              </div>
            </div>
          </Panel>
        )}
        <Panel position="top-left" className="ambio-canvas-toolbar">
          {focusFileIds.size > 0 && (
            <button
              type="button"
              onClick={() => setFocusEnabled(v => !v)}
              title="Dim nodes that are off the active trace / runtime path"
              className={focusEnabled
                ? 'ambio-canvas-command ambio-canvas-command--trace-active'
                : 'ambio-canvas-command'}
            >
              <svg style={{ width: '14px', height: '14px' }} viewBox="0 0 24 24" fill="none"
                stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M12 5V3M12 21v-2M5 12H3M21 12h-2" />
              </svg>
              Focus{focusEnabled ? ' On' : ' Off'}
            </button>
          )}
        </Panel>
        {/* The bin canvas must not grow its own bins. Gated on mount rather
            than hidden in CSS, so the inner canvas never subscribes to a
            bin it is itself the inside of. */}
        {!binMode && (
          <Panel position="bottom-right" className="ambio-canvas-bins-panel">
            <CanvasBins
              documents={bins.documents}
              unclassified={binsHoldUnclassified ? bins.unclassified : []}
              documentsOpen={documentsOpen}
              onToggleDocuments={() => {
                const store = useGraphStore.getState()
                store.setDocumentsOpen(!store.documentsOpen)
              }}
              dragActive={isDraggingScene}
              readOnly={readOnly}
            />
          </Panel>
        )}
      </ReactFlow>
      </RenderBudgetContext.Provider>
      </FloorEditContext.Provider>
      {!isolatedScene && (
        <>
          <InfraSidebarLinks
            nodes={livingDisplayNodes}
            dependencies={dependencies}
            files={files}
            systems={systems}
            selectedNodeId={selectedNodeId ?? null}
            visibilityOptions={livingVisibilityOptions}
            containerRef={canvasRootRef}
          />
          <InfraSidebar />
        </>
      )}

      {!reviewMode && selectedIdsRef.current.size > 1 && (
        <div className="ambio-selection-actions">
          <span className="ambio-selection-actions__summary">
            <strong>{selectedIdsRef.current.size}</strong>
            <span>items selected</span>
          </span>
          <button
            type="button"
            onClick={() => window.dispatchEvent(new Event('ambio:open-agent-dispatch'))}
            className="ambio-selection-action"
          >Message agent</button>
          <button
            type="button"
            onClick={() => setGroupDialogOpen(true)}
            disabled={selectedFileIds.length < 2}
            className="ambio-selection-action ambio-selection-action--primary"
          >
            Group into System
          </button>
          <button
            type="button"
            onClick={() => { setSheetSourceIds([...selectedIdsRef.current]); setSheetDialogOpen(true) }}
            title="Curate the selection onto a named sheet - a live diagram telling one story"
            className="ambio-selection-action"
          >
            New Sheet
          </button>
          <button
            type="button"
            onClick={() => setSelectionMode(false)}
            className="ambio-selection-action ambio-selection-action--ghost"
          >
            Cancel
          </button>
        </div>
      )}

      {!reviewMode && <GroupDialog
        isOpen={groupDialogOpen}
        onClose={() => setGroupDialogOpen(false)}
        selectedFileIds={selectedFileIds}
        onSuccess={() => {
          setRfNodes(nodes => nodes.map(n => ({ ...n, selected: false })))
          commitSelection(emptySelection())
          useGraphStore.getState().setSelectionMode(false)
        }}
      />}

      {/* Sheet layer active: the stencil palette. The PROPOSAL band on the
          canvas already says which layer you are on. */}
      {overlaySheetId && (
        <SheetPalette onCreate={onPaletteCreate} disabled={readOnly || reviewMode || creatingStencil} />
      )}

      {contextMenu && (
        <CanvasContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          target={contextMenu.target}
          onClose={closeContextMenu}
          onShowDetails={id => { setSelectedNode(id); setInspectedNode(id) }}
          onZoomTo={id => { void fitView({ nodes: [{ id }], padding: 0.2, duration: 600 }) }}
          floorEdits={floorEditable ? {
            // Group what is selected; a right-clicked file outside the
            // selection is grouped on its own.
            groupFiles: fileId => {
              if (!selectedIdsRef.current.has(fileId)) commitSelection(new Set([fileId]))
              setGroupDialogOpen(true)
            },
            // The selection when the node is part of it, else the node alone.
            newSheetFrom: nodeId => {
              setSheetSourceIds(selectedIdsRef.current.has(nodeId) ? [...selectedIdsRef.current] : [nodeId])
              setSheetDialogOpen(true)
            },
            // Reality changes are never faked on the Floor: they go to an
            // agent as a work order, with the node attached and the
            // instruction already written (docs/PRODUCT.md §2).
            removeCode: (nodeId, label, instruction) => { void startRemovalSheet(nodeId, label, instruction) },
            newSystemHere: screen => { void startNewSystemSheet(screenToFlowPosition(screen)) },
          } : undefined}
        />
      )}

      {!reviewMode && <NewSheetDialog
        isOpen={sheetDialogOpen}
        onClose={() => setSheetDialogOpen(false)}
        nodeIds={sheetSourceIds}
        onSuccess={() => {
          setRfNodes(nodes => nodes.map(n => ({ ...n, selected: false })))
          commitSelection(emptySelection())
          useGraphStore.getState().setSelectionMode(false)
        }}
      />}

      {infraPickerNodeId && activePlannedByNodeId.get(`planned:${infraPickerNodeId}`) && (
        <InfraPickerDialog
          mode="assign"
          node={activePlannedByNodeId.get(`planned:${infraPickerNodeId}`)!}
          onClose={() => setInfraPickerNode(null)}
        />
      )}

    </div>
  )
}
