# Ambio Canvas Behavior Contract

Status: preservation baseline for the renderer refactor  
Baseline commit: `7e55a2a` (`Canvas: stabilize extreme-zoom resize interactions`)  
Last verified: 2026-07-22

Product direction lives in [PRODUCT.md](PRODUCT.md) and open work in
[../WORK.md](../WORK.md). This document records *behavior*; those record
*intent and progress*.

## Purpose

The agent panel permits a text correction during a qualified Antigravity ACP
turn. Stop remains available; model, mode and attachment choices stay fixed
while it runs. Sending waits for acknowledgement, keeps a failed draft, and
never creates a second work order or changes transport. Other ordinary managed
routes retain the disabled-during-work composer. Model selection chooses the
connection for a new Antigravity conversation; existing conversations retain
their connection. Tool output and diffs can be expanded without changing the
canvas selection or camera. (Approved joint Antigravity approach, 2026-11-04.)

This document records behavior that exists and is intentionally tuned today.
Refactors may change ownership, module boundaries, and implementation details,
but must not change these observable results unless a later product decision
explicitly revises this contract.

The contract protects the current Floor, sheet overlay, semantic zoom, node
presentation, selection, resize, drag, connection, and persistence behavior
while `AmbioCanvas` is decomposed and the application visual system is rebuilt.

## Refactor rule

Every preservation refactor must satisfy all three gates:

1. Existing unit tests and TypeScript checks pass.
2. Canvas interaction smoke tests pass at ordinary and extreme zoom.
3. Approved screenshots remain visually equivalent within the documented
   dynamic regions (timestamps, runtime counts, and asynchronous data).

Structural extraction and visual redesign must be separate commits. A commit
that claims no visual change must not intentionally alter colors, spacing,
typography, silhouettes, reveal thresholds, geometry, or interaction timing.

## Viewport and camera

- Canvas zoom range is `0.02` through `100`.
- The canvas is only the part of the window you can see: while the agent
  panel is open the canvas area ends at its edge (`--workbench-sidebar-inset`), so
  every fit, search result, selection and chip centres there, not under the
  panel. The terminal sidebar uses the same right-hand space and also reduces
  the canvas viewport. Both share one saved width: resizing either applies to
  the other, including after reopening. Switching replaces the contents in
  place without overlapping slide animations or changing the canvas width.
  Opening from closed and closing to the canvas retain the shared slide-in/out
  animations; only switching between the two skips a new animation. Closing
  content is inert. The canvas edge follows the visible sidebar edge throughout
  opening and closing, revealing the live map with no empty strip or final
  width jump. One shared animation progress drives both edges. Reduced motion
  skips the animation.
  The terminal has a single compact control bar and no footer.
  Opening either sidebar hides the other; terminal shells
  and scrollback remain alive while hidden. Ctrl+` toggles the terminal on every
  platform, including when its input has focus. Shell editing, signals and Escape
  stay inside the terminal; the command palette remains available.
- Navigation from outside the canvas (a file chip in a reply, a row under To
  review, a system in the mapping review list) brings the node into view the
  way search does: it opens a collapsed system, selects the node and fits once
  the node has been measured. All of them share one flight and its framing.
  Search and Model Explorer open the Floor for a live target outside the
  current sheet's scope.
  A file chip that names a line, or a symbol chip, opens the source viewer at
  that line or definition instead, leaving the map where it is. The viewer's
  Show on map (and its breadcrumb's system) closes it, after asking about
  unsaved changes, and takes the same flight to the file or system.
- Initial viewport is `{ x: 0, y: 0, zoom: 0.5 }`, followed by `fitView` with
  `0.14` padding.
- Automatic live-growth reframes are debounced through classification and
  animate pan and zoom as one camera move. A pending reframe yields while the
  user is navigating instead of being discarded or fighting manual movement.
- React Flow's wheel zoom is disabled. Ambio owns wheel zoom.
- Each wheel step multiplies or divides the target zoom by `1.15`.
- Zoom eases toward its target by `15%` per animation frame.
- The flow coordinate beneath the pointer remains beneath the pointer while
  zooming.
- Wheel zoom works over revealed file-node content. An explicit `nowheel`
  ancestor opts a surface out of canvas zoom entirely.
- An overflowing region inside a node (file descriptions, symbol lists, class
  members) owns the wheel even at either end. Reaching the end of text never
  becomes camera zoom. Content without overflow leaves the wheel to the canvas;
  the canvas root itself never counts as node content. Invisible compact/detail
  title copies cannot intercept the active layer's scroll or editing controls.
- Normal mode pans with the primary, middle, or secondary drag accepted by
  React Flow. Selection mode reserves primary drag for partial-box selection
  and limits panning to middle/secondary drag.
- The canvas does not snap nodes to a grid.
- Off-screen culling activates above 40 composed React Flow nodes, including
  planned sheet nodes (the implementation threshold since the October 13 audit;
  150 is the separate large-scene initial-materialization threshold).
- Camera and selection updates retain measured node dimensions, so already
  initialized off-screen nodes do not remount just to be measured again.
- Search and agent reply file pills wait for their target to be visible and
  measured before flying. A newer pending navigation supersedes the older one,
  and explicit navigation cancels wheel easing and pending growth reframes on
  that canvas. Flight duration remains 850 ms.

## Rendering budget (approved 2026-10-20)

- On the initial-mapping approval canvas, a mouse pan begun on the empty pane
  captures that pointer until release. Node gestures, Shift/lasso selection and
  touch/pinch remain React Flow interactions; nested canvases own their pointer.
  This review surface has no connection gestures or drawn relationship edges,
  so its connection handles are omitted from both full and compact node
  components. CSS hiding alone leaves their camera subscriptions active. Floor/sheet
  endpoint handles retain their ordinary geometry. While this review camera is
  being dragged, decorative card/folder shadow filters are suspended and return
  when panning ends. Resting artwork, node drag/resize chrome and WASD retain
  their normal appearance. This is an intentional motion-cost reduction added
  for the 2026-10-23 review mouse-pan regression.
- Above 40 composed nodes, spatial visibility runs in the same worker as
  numeric Floor/sheet preparation. Complete canonical geometry lives outside
  React Flow; its interaction collection contains the admitted region and
  required interaction/relationship ancestors and endpoints. Canonical layout,
  semantic membership and authored dimensions remain independent from culling.
  Pending preparation retains the previous coherent scene and shows progress.
  Only current workspace/sheet/model requests may adopt geometry or persist
  generated placement. Equivalent metadata/save echoes reuse preparation.
  Small worker failures can recover cooperatively. Above 2,000 entities or
  relationships, no huge synchronous fallback is attempted: retain coherent
  content and offer Retry. Unresponsive superseded work is terminated after its
  cancellation acknowledgement deadline instead of blocking newer work forever.
- Large HTTP snapshot reads and canvas preparation publish only completed,
  current results. Byte decoding runs off-thread for large replies; row/geometry
  transfers use acknowledged batches. Projection yields without publishing
  incomplete hierarchy or saving stale placement. Same-scope preparation keeps
  coherent content visible; empty/new scopes release old prepared models.
  Failure remains recoverable without synchronously decoding a huge reply.
  This scheduling change preserves authored geometry, reveal thresholds and
  navigation timing; it does not imply a fully paged project model.
- Floor preparation may precompute canonical indexes before publication.
  Selection and activity overlays reuse these only while geometry, ordering,
  hidden state and semantic detail remain unchanged. An inactive overlay does
  not replace the scene. Geometry/visibility edits still reconcile and all
  candidates still pass the existing integrity audit. That same audit may finish
  cooperatively before Floor publication and be reused only for the exact node
  array and canonical membership, including trusted presentation-only stamps.
  Cancellation never publishes a partial audit; edits invalidate the result.
  Semantic-index sorting yields in bounded chunks without changing stable depth
  order or reveal thresholds. Sheet-specific composition remains authoritative.
- The detail budget has a 240-screen-pixel buffer and retains recent admissions
  for 450 ms, capped at about two buffered screenfuls, to absorb quick reversals.
  React Flow additionally culls offscreen components; retention no longer requires
  their DOM or subscribers to stay mounted. Fit includes viewport-culled nodes
  and excludes semantically hidden descendants. Canonical geometry remains
  available for camera bounds, offscreen drop targets and resize compensation.
  Relationship admission includes viewport-crossing endpoint bounds even when
  both endpoints are offscreen; disconnected offscreen paths need not adopt
  their endpoints. Admitted endpoints initialize ordinary handles and preserve
  valid offscreen routing after their shells unmount. Layout glides retain the
  outgoing interaction subset until the transition phase ends, so final-position
  culling cannot cut off a moving card.
  While the first spatial answer is pending, root shells already respect this
  buffer; startup must not admit every off-screen root at once. The same active
  node and relationship endpoint exceptions apply.
- The passive minimap retains its size, colors, rounded marks, viewport mask
  and admitted-node bounds. It has one surface subscription and creates marks
  only for admitted nodes, rather than a subscribed component per project entity.
- Focused inline titles, symbol names and metadata finish their normal save
  before culling removes the input. Escape still cancels the draft. Removing a
  browser input does not itself dispatch React's blur event; drafts must not be
  silently discarded during camera or semantic visibility changes.
- Very long static dashed relationships draw only their buffered viewport
  segments. Their canonical route, dash phase, real endpoint arrows and click
  target remain equivalent to the full route. No arrow is added at a clip cut.
  Explicit search/reply fits retain their target and 850 ms duration through
  concurrent canvas updates; default Fit options cannot replace a queued request.
  Navigation issued during preparation waits for its accepted geometry. A manual
  navigation takes priority over initial automatic framing.
- A node smaller than 14 pixels on its shortest side may use its silhouette.
  Other background file cards use compact identity while detail waits. Systems
  and infrastructure retain their normal identity at readable sizes. Selection,
  dragging, hover at rest and live visual signals admit the editable component.
- Detail admission prioritizes the viewport center and grants at most six
  promotions per frame, adaptively reducing that count after a slow frame, with
  a 3 ms scheduler deadline. React/browser commit work is not preemptible; this
  is an admission limit, not a guaranteed 3 ms total frame.
- A navigation flight prewarms its destination and symbols. Intermediate new
  file cards remain compact while the camera moves; previously admitted detail
  may be retained. A superseding search cancels its old symbol-prefetch consumer.
- Rich file detail unmounts after its 250 ms exit crossfade. Symbol lists render
  a visible window plus four rows of overscan, retaining a focused editor. Source
  actions, authoring, list scrolling and keyboard navigation remain available.
- Empty editable symbol categories use one compact Add first function/variable/
  class button that combines the empty state and add action. Read-only and
  loading lists retain plain status text. The member tab determines what is added.
- Shared symbol requests have independent consumer cancellation, a four-request
  concurrency limit, revision invalidation, short-lived empty replies and a
  bounded LRU. Large lists do not create one DOM row per indexed symbol.
- Local diagnostics record camera frame tails, renderer long frames, detail
  admissions, requests and background batches. There is no uploaded telemetry
  or idle animation-frame sampling loop. Full geometry mutation tracing requires
  `window.__ambioSceneDebug = true`; scene-integrity protection remains active.

- An initial layout save failure is reported with Retry. It must not create an
  automatic save/repack loop; retry cannot write another workspace's geometry.

## Semantic zoom

- Container reveal is based on rendered size, not hierarchy depth.
- A measurable container reveals its children when
  `sqrt(worldWidth * worldHeight) * zoom >= 480` screen pixels.
- A child cannot reveal before all of its ancestors reveal.
- Hidden descendants fade to opacity `0`, become non-interactive at opacity
  `<= 0.1`, scale toward `0.92`, and blur toward `3px`.
- Opacity transitions over `0.25s ease-out`.
- Opening a system is sequenced (`REVEAL_MOTION`, changed 2026-10-27): its
  centred name fades out over `200ms`, and only then do its tab title, count
  and the nodes it reveals fade in over `300ms`. Revealed nodes mount already
  visible, so their entrance is played on mount, anchored to the moment of the
  reveal; a node scrolled into view or remounted later has none. Closing is
  immediate: the contents unmount, the tab title fades out over `120ms` and the
  name returns over `240ms`. Reduced motion skips the node entrance.
- A node being dragged or directly interacted with is forced fully visible.
- The mapping review canvas has the same semantic zoom as the Floor (changed
  2026-10-27; it used to reveal every system and file at once): systems start
  closed with their name, and open as you zoom in.
- Revealing a node never makes it draggable when its scene locked it: review's
  approved and live nodes stay in place at every zoom.
- The initial fit settles the zoom tier once it lands; a visibility pass queued
  by its last animation frame is dropped rather than folding the scene back.
- File detail reveals when effective zoom reaches `1.075`, where effective
  zoom is viewport zoom multiplied by the node world scale.
- File details crossfade over `0.25s`; hidden details do not receive pointer
  events.

## World geometry and presentation

- A depth-zero file frame is authored at `220 x 110` flow units.
- File cells halve per depth level (`FILE_SCALE = 2`) with floors of
  `80 x 44` flow units.
- Grid gap and system header height are derived from half the file-cell height
  at that depth.
- File content uses a `220 x 110` presentation reference.
- Infra content uses a `260 x 160` presentation reference.
- Systems use their authored presentation base dimensions, falling back to
  their current dimensions and then `620 x 420`.
- Presentation scale is uniform and controlled by the limiting axis. Resizing
  may change aspect ratio without stretching typography or internal chrome.
- Presentation scale is `canonical size / authored design size`. Both terms are
  canonical: it carries no world-scale factor on either side, so it is blind to
  nesting depth and to interior compression. It is computed once, in the
  projection. Components consume it and must never re-derive it from rendered
  dimensions.
- Depth reaches system chrome through `DEPTH_TITLE_PX` and nowhere else.
- A frame has two scales. `scale` is its own size in its parent's space;
  `interiorScale` is how much it compresses its contents. A child's world scale
  is `parent.worldScale x parent.interiorScale x child.scale`.
- A frame's own geometry, chrome, and presentation scale are never expressed in
  terms of its `interiorScale`, so compressing an interior cannot disturb the
  frame itself or anything outside it.
- Containment shrinks inward; it never grows outward (Max, 2026-11-11). When a
  saved frame's children no longer fit (one grew because files were assigned
  to it), the frame keeps its size and position and compresses its interior
  until they do. The shrink is anchored at its children's top-left, so the
  first child stays where it was, clear of the title, and the arrangement is
  unchanged. Only the frame that received new children may grow (or compress,
  hemmed in by neighbours); frames above it never move. A saved layout with a
  child sticking out is repaired the same way when it is next drawn.
- Child positions and sizes convert through the parent's **content** scale;
  the parent's own box converts through its own world scale.
- Every layout write replaces a whole row, so `interiorScale` is mandatory on
  `FloorLayout` - a writer that is not about compression must carry it through.
- Node shells fill the live frame synchronously. Shell geometry must not trail
  resizing through a React-state measurement loop.
- Container children remain visually stationary when a north or west parent
  edge moves; their persisted local positions are compensated accordingly.
- Dragging a container moves every descendant as one rigid visual body; child
  wrappers must not ease behind the parent.
- A released node stays where the pointer left it, and a resized node keeps the
  size it was released at; any settling animates from there. On a sheet the
  drag's or resize's interaction snapshot is held until the worker has projected
  the new layout (or failed), because until then the prepared geometry is still
  the layout from before the gesture.

## Node visual states

### Files

- Compact and detailed states share one shell and one frame.
- Detailed symbol content remains `nodrag` and `nopan` but does not suppress
  canvas wheel zoom.
- Dimmed files render at opacity `0.22` with reduced saturation.
- Watched/runtime files can display pulse, call count, args, return,
  exception, rate-limit, perturbation, and verdict feedback.
- Runtime exception, rate-limit, perturbation, and success states keep their
  current semantic colors.
- Live filesystem edits always ping the affected file regardless of writer.
  Updates use teal, creation uses green, and deletion performs a red exit
  before semantic removal.
- A new file with no home (including one only a clusterer has guessed a
  system for) waits in the Unsorted bin and does not appear on the Floor. The
  bin pulses once for the first arrival of a burst and stays lit until the
  burst goes quiet. Assignment to a system is when the file arrives on the
  canvas, shown as `ADDED`; moving between systems shows as `MOVED`.
- The header shelf is the strip at the top of a pad and the body below it is
  the page, so the shelf carries the warmth and the body stays plain. On a
  sheet the shelf deepens to pad yellow; on the Floor it stays quiet.
- File connection handles remain invisible until React Flow needs them and
  must never create a large invisible interaction surface at extreme zoom.

### Systems

- The system structural silhouette exists at every zoom.
- The centered identity and the detailed header/grid crossfade according to
  child reveal.
- Activity on a hidden descendant surfaces on the nearest visible semantic
  ancestor as a lower-right structural rail. The rail must remain clear of
  both the collapsed centered identity and the expanded title/tab band.
- The ancestor marks where the hidden file sits with an outline window at its
  authored rectangle, and its rail names what happened (`EDITED · rates.ts`).
  The hidden file card is not popped out over the collapsed system, and the
  system keeps its centered identity while the window is open. Three or more
  windows share one rail summary (`ADDED · 5 files`).
- Activity labels and badges are counter-scaled against the zoom so they are
  never smaller on screen than their natural size.
- Dimmed systems render at opacity `0.3`.
- A system another checkout of the project is also changing (a branch
  collision, `GET /api/checkouts`) carries a branch mark with the number of
  other branches: beside the file count in the centered identity, and beside
  the agent mark in the tab band once open. Its tooltip names the branches;
  Properties lists them under "Changing on other branches". Nothing on the
  canvas opens or moves because a worktree appeared.
- Other checkouts' work is drawn on the Floor without moving, resizing or
  adding nodes. A file another branch changes or deletes carries a dashed,
  branch-tinted mark on its lower-left corner (`~ branch`, or struck through
  for a deletion). New files a branch adds to a system are a dashed caption
  just below the system's frame (`+ RetryBanner.tsx branch`). Both are
  counter-scaled like activity chrome. Which branches draw is the lens in the
  Checkouts popover: Off, Agents only (default: checkouts with an active work
  session) or All, remembered per project.
- Show on the Floor moves the Floor to another checkout of the repository.
  Files keep their identity, so systems, layout and history stay; the change
  in contents is reconciled quietly, and nothing is journaled.
- In a project holding several repositories, each repository is a top-level
  frame (a system of kind `repository`) named for its folder, and inferred
  systems never span two of them. The frame is an ordinary system: it is
  renamed, moved, resized and nested like any other. Its identity carries a
  `REPOSITORY · branch` kicker above the title, and its tab band a
  `REPO · branch` tag once open; the branch is that repository's own HEAD
  (`GET /api/checkouts`). Files outside every repository are clustered at the
  top level beside the frames.
- Drop preview translation affects the visual shell, not the logical React
  Flow frame or interaction chrome.

### Infrastructure

- Category determines silhouette; provider/service determines identity and
  accent treatment.
- Proposed infrastructure is dashed and renders at opacity `0.65`.
- Missing registry entries retain an editable fallback node rather than
  disappearing.
- Only hosting infrastructure (platforms, containers) is on the Floor, as
  frames that hold the systems they run. Everything code talks to lives in
  the infrastructure sidebar on the canvas's left edge.
- The sidebar opens and closes from one thin tab at mid-height that rides its
  edge. Adding infrastructure starts from the sidebar's "+ Add"; the toolbar
  has no infra button.
- Detected infrastructure is proposed and waits at the top of the sidebar
  until it is confirmed or dismissed. Dismissal is sticky.
- A confirmed platform arranges its hosted systems once (containers inside
  platforms, systems inside containers) without covering other nodes; after
  that its contents are only moved by the person.
- Selecting a sidebar row draws its relationships onto the canvas: lines to
  visible boxes, outlines, a label on each box, and edge markers for boxes out
  of view. Selecting a system or file while the sidebar is open lights the rows
  it touches and draws lines back to them. Lines exist only while the
  selection holds, have no arrowheads, and are dashed when only an import is
  known.
- Systems carry no infrastructure chips.
- A contract gap (a topic published with no consumer, or the reverse) marks
  the sidebar row and heads the inspector.
- Fit, zoom and Tidy Layout are View-menu and keyboard commands; the canvas
  shows no zoom buttons or zoom readout. Fit also has its button under the
  minimap (Project chrome).

### Planned UML elements

- Planned and partial elements remain visually distinct from realized/live
  elements.
- User-authored planned elements are approved intent. Agent-authored planned
  elements enter as pending proposals and must expose Confirm/Reject directly
  on the canvas.
- Pending and rejected agent proposals never enter planned reconciliation,
  build specs, or dispatched Sheet context. Rejection is final; agents poll
  the proposal status and must not implement before approval.
- The same holds for everything else an agent proposes on a sheet: moving an
  existing file or system, renaming a system, a new relationship. Each is
  listed under To review in the sheet rail with Confirm/Reject, and its name
  there takes you to it. Until decided, a moved or renamed node carries a
  dashed amber outline. What a sheet changes about a node is a small badge in
  its card (`SheetChangeBadge`: Added, Moved, Renamed, Moved + renamed) that
  keeps its screen size at any zoom; a renamed system shows the new name with
  the current one struck through under it, and an unfocused relationship is
  drawn dashed charcoal with a narrow ivory outline, contrasting with amber
  proposal borders. Rejecting a move puts the node
  back where the Floor has it; a rejected relationship is not drawn.
- A sheet's relationships route between the facing sides of the two nodes,
  with orthogonal gutters and small rounded corners, and carry no text label
  over node titles. Incident connections use distinct ports; reserved gutters
  discourage overlapping routes. The last segment approaches the target face
  normally, with enough straight ink for its bounded screen-size arrowhead.
  Rounded corners stay within the route's obstacle clearance.
- Selecting a connection in the sheet sidebar reveals both endpoints and
  their complete route, including below the normal semantic zoom threshold.
  Revealed ancestors keep titles in their header tabs. The camera fits the
  endpoint cards and route detours clear of the stencil palette and open sheet
  inspector. Individual navigation and the all-connections view share the same
  dashed charcoal ink, width, ivory outline, arrowheads and source dots; other
  proposed routes dim while focus is active. Camera and selection changes
  alone do not reroute the connection.
- The stencil palette sits at the top left of the canvas, clear of the
  Infrastructure tab, and moves beside the Infrastructure sidebar while it is
  open. The PROPOSAL band is the only mode badge.
- Opening a sheet, by any route, clears its "an agent proposed…" notification;
  none is raised for a sheet that is already open.
- Planned/partial outlines are dashed; realized/flattened outlines are solid.
- Realized members display independently from pending members.
- Status colors remain: planned/neutral, partial/warning, realized/success.
- Dispatch snapshots the active Sheet's approved build spec together with its
  live Floor context and the user's text. Later Sheet edits cannot mutate an
  already queued work order.
- Work-session presence is projected onto every declared live file/system
  boundary. Multiple agents can remain active on the same boundary and are
  shown together; finishing one session removes only that agent's presence.
- Morning Delta compares agent-produced claims with immutable dispatch
  snapshots. A matching plan or planned edge dispatched before the change is
  EXPECTED; unmatched agent work is DRIFT. Human work is not judged against an
  agent work order.

## Selection and resize

- A selected resizable node has one authoritative selection outline. Node
  components must not add a duplicate selected-frame border.
- The outline is one composed screen pixel at every viewport zoom.
- Eight resize anchors are located at the exact `0%`, `50%`, and `100%` SVG
  frame coordinates.
- Each visible resize anchor is `8 x 8` composed screen pixels.
- Each resize hit target is `18 x 18` composed screen pixels.
- Outline, visible anchors, and hit targets share one SVG coordinate system.
  CSS inverse-transform placement must not be reintroduced.
- Resize starts from controlled fractional width/height. Integer DOM
  `offsetWidth`/`offsetHeight` measurements are fallback data only.
- Pointer-to-flow conversion remains floating point. At `100x`, a one-screen-
  pixel movement changes geometry by `0.01` flow units.
- All eight directions resize independently, preserve the opposite edge when
  clamped, and support arbitrary aspect ratios.
- Pointer capture loss, pointer cancellation, window blur, rerender, and
  unmount terminate the resize session cleanly.
- Selection chrome follows the node's own DOM transform and must not update
  through an independently sampled portal frame.
- The shell drop shadow is suppressed only during active resizing to prevent
  Chromium from retaining a stale filtered surface.

## Selection, editing, and connections

- Read-only mode disables node changes, edge changes, dragging, connecting,
  box selection, and element selection.
- Box selection uses partial intersection while selection mode is active.
- Editable text, symbol rows, buttons, and scroll regions do not begin node
  drags or pane pans.
- Double-clicking a live file (any shape, including class cards) selects it
  and opens the whole file in the code editor at the top, with no lines
  highlighted. Its Properties open from the right-click menu (Properties;
  Open Code in Ambio is the menu's first item). Systems, infrastructure and
  planned files, which have no code to open, keep opening Properties on
  double-click. Double-clicking editable text edits it, as before. (Max,
  2026-11-03.)
- The code editor keeps one tab per open file, in a strip above it. Closing
  the editor (Escape, ×, a click outside, Ask agent, Show on map) only hides
  it: its tabs, unsaved edits included, stay open, and the next file opened
  from anywhere joins them as another tab. Tabs close only from the tab
  strip: a tab's ×, a middle-click, or its right-click menu (Close, Close
  Others, Close All); a tab with unsaved changes asks first, each in turn.
  Opening an open file (from chat, search, a symbol row or Back) goes to its
  tab at the new lines, keeping its edits; following a definition opens the
  other file in its own tab. Ctrl+Tab / Ctrl+Shift+Tab and Ctrl+PageDown /
  Ctrl+PageUp switch tabs. Each project's open tabs are kept across restarts.
  Past 12 tabs, the least recently used tab without unsaved changes closes.
  (Max, 2026-11-04.)
- Right-clicking in the code editor opens its own menu, never the canvas's:
  Go to Definition, Ask Agent About This, Cut, Copy, Paste, Select All, Find,
  Copy Reference, Revert This Change (on a changed line) and Show on Map. A
  right-click outside the selection moves the cursor there first. Escape
  closes the menu and leaves the editor open. (Max, 2026-11-04.)
- Floor nodes are not manually connectable.
- Nodes become connectable on an active editable sheet overlay.
- Planned edges may connect planned and live sheet members according to the
  current sheet authoring rules.
- Default rendered edges use the orthogonal edge implementation.

## Floor, sheets, and persistence

- The Floor remains the live base model.
- Sheets project a scoped view of the live Floor plus sheet-specific proposals
  and notes. Leaving a sheet restores the complete Floor and its camera.

### Placement on the Floor is meaning (decided 2026-10-01)

See [PRODUCT.md §2](PRODUCT.md). On the live Floor:

- Dropping a file inside a system makes it belong to that system; dropping a
  system inside another nests it; dropping either on open canvas takes it out
  of every system. Infrastructure hosting (a frame around what it runs) is
  visual and changes no ownership.
- Ownership is recorded before the layout is saved, through the one recorded
  path for meaning edits, so where a node sits and what it belongs to never
  disagree. A refused edit rolls the layout back with an explanation.
- Rearranging within the same parent is presentation and records nothing.
- Inferred (cluster) systems are not drawn, so their files sit at the top
  level (in a folder of repositories, in their repository's frame); moving
  one there changes nothing. Repository frames are drawn, but are not an
  authored architecture: alone they do not send new files to Unsorted.
- A live system's title is renamable in place.
- Every meaning edit confirms itself with a notice that offers Undo, and
  appears in Review Changes attributed to you.
- Sheets, proposal reviews and the unsorted bin only ever write their own
  layout layer; none of this applies there.

### What a sheet is (revised 2026-07-30)

- The canvas shows the visible sheets' live members, the descendants of their
  member systems, and their planned nodes and notes. Proposed placements and
  connections bring in the live nodes they reference. Live dependencies require
  both endpoints in scope. A blank sheet opens with an empty canvas and the
  stencil palette.
- A sheet's overview is a clean proposed arrangement. Relationships are hidden
  by default; selecting a node shows its connections. Selecting a relationship
  review row frames and accents both endpoints and explains the interaction.
  Show All Sheet Relationships exposes the broader view and resets when the
  active sheet changes. Hidden lines never remove items from proposal review.
  Visible proposed relationships retain a readable screen-space line weight
  when zoomed out, with an arrow showing which system uses the other.
- Proposed relationships choose endpoint faces and orthogonal gutters together,
  avoiding unrelated cards and folder tabs. Ancestor frames are traversable
  context. Routes attach to actual perimeters, retain selection, and cache by
  scene geometry rather than camera position. Stroke, dashes, hit targets and
  arrowheads have bounded screen sizes at wide and close zoom.
- Moves and additions have small screen-size markers, without a second dashed
  perimeter. Selecting a move explains its original and proposed parent.
- Unplaced new systems and automatically moved systems fit their contents using
  the shared packer. Explicit sheet positions/sizes stay authoritative; neither
  compacting nor reviewing a proposal rewrites Floor geometry.
- Automatic sheet compaction accounts for nesting, world scale and interior
  scale when reserving header clearance. A system's dimensions and its layout
  row agree, so projection cannot reuse an oversized Floor frame.
- To review stays compact in the sidebar. A nested addition and its connections
  form one change card; independent additions and connections between them
  remain separate. Inspect changes opens a nonmodal panel with additions,
  connections, moves and renames grouped for individual decisions; the compact
  card shows actual system/file/connection counts and descriptive intent.
  Group approval/rejection applies exactly the displayed pending parts in one
  revision-checked transaction. A stale plan refreshes for review without
  retrying approval; approved children/connections cannot have unapproved parents
  or endpoints. Request changes records the reason against each selected part.
  Opening a sheet reveals To review upward from the bottom over roughly 260ms,
  without replaying the entrance on ordinary updates to an existing card.
  Leaving the sheet or deciding its final proposal collapses/fades the review
  downward over roughly 220ms. The exiting snapshot is immediately inert and
  hidden from assistive technology, its actions disabled and inspector closed.
  Reopening reverses the exit; another sheet cannot be cleared by the old exit.
  Reduced-motion mode removes the review immediately.
- Approval removes pending decisions, not navigation. Each sheet row has a
  chevron that expands its additions, meaningful live edits and connections before
  and after approval. Expanding a sheet does not activate or display its layer;
  selecting a content entry opens that sheet and reveals nested/off-screen
  content. There is no separate bottom Contents section.
- Sheet, system and Connections disclosures expand/collapse their actual height
  over roughly 240ms with a short fade. Reversing a toggle mid-transition starts
  from its current position. Contents mount on first opening and retain local
  state afterward; closed content is inert and hidden from assistive technology
  immediately. Reduced-motion preferences disable these transitions and the
  To review entrance.
- The sheet tree omits unchanged live context, connection-only endpoints and
  layout-only repositioning. Explicit reparenting, reviewed renames and authored
  file design remain discoverable; Connections retains all of its endpoints.
  The underlying sheet membership and build context are unchanged by this filter.
- Expanded sheet contents fill the rail width. Systems use warm tinted headers,
  folder icons and trailing disclosure controls; files use flat rows below.
  Nested systems use a quieter header tint rather than cumulative indentation.
  A continuous accent frame joins the owning sheet header to its expanded
  sections, with a shared backing and closing bottom edge. Collapsing the sheet
  removes that frame; opening an inactive sheet's contents does not activate it.
- Connections use a compact tinted toolbar with a connection icon, count and
  right-side disclosure, distinct from the system tree without a separator
  rule. The map-visibility button belongs to this toolbar and includes an eye
  icon; it is available on the active sheet whether the connections are
  expanded or collapsed.
- Stencils use equal top and left canvas insets. On short windows the palette
  scrolls within the available space, keeping the Infrastructure tab below it
  and reachable; when Infrastructure opens, the palette sits beside that panel.
- A normal sheet-title click makes it the only visible overlay and primary
  editing target. Ctrl/Cmd-click toggles additional layers without changing the
  primary target; hiding that primary promotes the last remaining visible layer,
  or returns to the Floor if none remain. The Floor stays the base. Active rows
  are teal; other visible layers use a quieter tint. Titles allow two lines.
- Sheet rows omit checkboxes, type abbreviations and author badges. A hover/
  keyboard-focus menu and the same right-click/Shift-F10 menu provide Rename,
  Discuss or implement, and Delete. Connections visibility lives inside the
  expanded active sheet. Approval confirms a plan; implementation is separate.
- Planned file headers use their declared filename and the normal language
  icon. Cards and Properties share a single filename, language and description
  model, including path-derived languages and legacy descriptions stored in
  notes. Recognized file extensions override stale language metadata. There is
  no separate semantic filename in the file UI, and no repeated full path in
  the body; paths remain in the proposal data and hover context. Filename edits
  preserve directories. Description and function/variable/class controls remain
  available together, with the same members editable in Properties. Explicitly
  clearing descriptions/members cannot resurrect legacy notes/member lists.
- Language menus use the browser top layer at screen size, outside node
  stacking/clipping. They stay within the window, follow their anchor, support
  keyboard selection and outside-click dismissal; Escape restores focus to the
  language button. Closed menus do not mount their option lists.
- Proposed systems show their responsibility below the collapsed title.
  Full description editing uses the normal Properties inspector (double-click
  the frame); there is no separate information badge on the header ledge.
  Cards and Properties share the same metadata/legacy-notes fallback, including
  explicit description clearing.
- If an incoming proposal compresses an existing live context frame, sheet
  preparation refits its content subtree against each frame's canonical body
  insets, using the final inherited scale. Its children cannot shrink upward
  into the title. Outer frame geometry, neighboring frames and saved Floor
  layouts remain unchanged; unchanged authored interiors are not repacked.


- A sheet is a scoped proposal about the live architecture, made of three
  kinds of opinion: moves, additions and removals. Its live members provide
  the context for that proposal.
- All three are design intent. Removal must be expressible, because "this
  system should be dissolved" is as much a proposal as drawing a new box; a
  sheet you cannot delete from can only describe growth.
- **A proposal never touches reality.** Removing a live node on a sheet takes
  it out of that sheet's picture only. Leave the sheet and it is there again.
- **A removal is always recoverable, and not through undo.** Undo is a
  keystroke you must think of in time and it decays the moment you do something
  else. Every removal stays listed on the sheet that made it, restorable long
  afterwards, because changing your mind about a proposal is normal.
- A removal whose node has since genuinely left the Floor is kept and marked,
  never silently dropped - otherwise the Removed list cannot be trusted.
- Removal wins over a move, so a node is never both gone and animated into
  place.
- The same delete gesture means different things in different places, so the UI
  states which: sheet-only content is really deleted, live code on a sheet is
  proposed for removal. On the Floor, Delete never touches code: a selected
  system is ungrouped (its contents move up a level, undoable), and a selected
  file stays, with a notice that deleting code goes through a work order.
  Changes that need code start from the right-click menu instead: New
  System Here… draws a planned system on a new sheet, ready to send, and
  Delete This File… / Delete <system>'s Code… draw the removal on a new
  "Remove …" sheet and open the send dialog with it attached. Split System…
  draws a "Split <system>" sheet with the system as context and two new
  systems to name and fill before sending. Drawing a
  connection between two live nodes on the Floor draws "A uses B" on a new
  sheet the same way. A connection's source is always the node it was drawn
  from, whichever overlapping handle the pointer grabbed.
- New Sheet from Selection… (right-click a system, file or infrastructure
  node, or New Sheet in the selection bar) starts a sheet with what is
  selected, of every kind; right-clicking a node outside the selection
  starts it with that node alone. The selection keeps its Floor spacing,
  alignment, world dimensions and in-scope nesting. The initial layout is
  presentation only. Opening a populated sheet frames its scope with 0.2
  padding.
- On a sheet, the removed node leaves that sheet's picture together with
  what sits inside it, a notice offers Restore, and the sheet rail lists it
  under "Removed on this sheet". Once its code is really gone it is marked
  GONE there, and a work order that carried it counts it as done.
- Edit → Undo / Redo step back and forward through the meaning edits made on
  the Floor, and through moving and resizing nodes there (a move that changes
  which system a node is in is a meaning edit and undoes as one); in a text
  field they undo typing. Undoing one from its notice takes it off the stack.
  Sheet removals are not on it, nor is placing a node for the first time.
- When the code disagrees with a meaning edit (the file lives outside its new
  system's folder, or its imports still mostly connect to another system),
  the edit still happens; its notice says where the code disagrees and offers
  Make the Code Match…, a work order with the fix written. It is never done
  for you. The offer stays on the change in Review Changes while the code
  disagrees, and the sent order shows what Ambio found when it re-checked the
  code ("Checked by Ambio"), separate from the agent's own report.
- Live nodes outside the visible sheets' scope are excluded from the scene.
- A member saved without geometry keeps its Floor world position and size.
  It stands on its own if its parent is outside the scope. Proposed into
  another parent, it is placed in free space inside that parent. A planned
  node with no position is placed in free space.
- A node the sheet moves detaches from Floor containment, because a proposed
  arrangement is not bound by the current one.

### Sheet mode is signalled by the surface

- A sheet never communicates its mode by degrading the architecture. Live nodes
  render at full opacity and stay selectable, inspectable and connectable,
  because a sheet is precisely where you work ON the architecture - fading the
  thing you are reasoning about to 45% and making it inert is what made a sheet
  feel like drawing on glass over the map.
- The signal lives entirely in the environment: a cooler paper tint beneath the
  nodes, a framed viewport edge, and a standing mark stating that the live map
  is untouched.
- Structural context nodes are equally undimmed. They are context, not scenery.
- Repositioning remains the one gesture reserved to a sheet's own members,
  because a sheet-local move must persist as an override rather than moving the
  Floor. Selection, inspection and connection are never reserved.
- A node the sheet has an opinion about is marked, so what a proposal *changes*
  is distinguishable from what it merely *contains*.

### Node material is declared in exactly two blocks

- Floor stock is declared on `.react-flow`; sheet stock on planned elements
  within a sheet. Same token names, two values. Node material lives nowhere
  else, so reconciling or unifying the two is a matter of comparing two lists
  rather than searching the codebase.
- **Material marks what is PROPOSED, not which surface you are looking at.**
  Live code renders identically on the Floor and on a sheet. Only planned
  elements - new files, classes, systems - take sheet stock. If the same file
  changed appearance between views, the map would stop being one thing you
  trust and become two drawings of it.
- The BOARD still changes with the mode, because the board is the mode. The
  nodes are not.
- Sheet stock MUST be scoped to `.react-flow` itself, never to the
  `.ambio-sheet-mode` container that wraps it. `.react-flow` declares these
  tokens on itself, and a custom property declared on a closer ancestor always
  beats one inherited from further up - so setting them on the container is
  silently a no-op. This produced a real bug with no error and no warning:
  sheet headers stayed Floor-grey while every other part of sheet mode worked.
- Tokens the canvas does not redeclare (`--sheet-presence`, `--sheet-ink`)
  belong on the container, with the chrome that reads them.
- The exit target for any token that changes with the mode must equal its Floor
  value, or leaving fades to a colour the Floor never uses.

### Sheet mode enters and leaves symmetrically

- Sheet mode is a PHASE, not a boolean. It stays applied through `leaving` long
  enough for the exit to play, and only then unmounts.
- A CSS keyframe on a pseudo-element that exists only while the mode class is
  applied can animate IN and never OUT: the moment the class is removed the
  element is gone. Every value in the sheet chrome is therefore a transition on
  a presence variable, which makes both directions the same move run in
  opposite directions, and makes an interrupted switch resolve to a real value
  rather than jumping.
- `leaving` keeps the sheet id, so the chrome it belongs to is still on screen
  to animate. Dropping the id with the phase is what makes an exit snap.
- Switching directly between two sheets re-enters rather than leaving, because
  the board never goes away and a fade-out/fade-in would read as a flicker.
- Anything that changes value with the mode - including the header shelf colour
  - transitions back on exit. A single snapping value is as conspicuous as an
  entirely missing animation.

### Sheet transitions

- Switching between the Floor and a sheet animates, because a cut between two
  static layouts hides what moved, what was added, what was taken out, and
  whether it is even the same map.
- One rule decides everything: **a node fades when it exists in one world and
  not the other, and glides when it exists in both.**
  - Moves live in both worlds: they glide and never fade. Fading one would say
    "created" or "destroyed" about a file that exists either way.
  - Additions live only on the sheet: they appear on entry, depart on exit.
  - Removals live only on the Floor: they depart on entry, appear on exit -
    the same vocabulary inverted, because a removal is an addition seen from
    the other side.
- Live nodes outside the sheet's scope leave the canvas on entry and return
  on exit.
- Arrivals wait for the rearrangement to be underway so the eye follows
  movement first; departures leave immediately so they are clear before the map
  settles.
- Transition state is a projection, never canvas state, so a layout, zoom or
  selection pass cannot strand a node mid-flight.
- Opacity is driven by explicit progress rather than a CSS keyframe, so an
  interrupted transition resolves to a real value instead of snapping.
- Switching sheets mid-flight takes out whatever the previous sheet was
  bringing in; content is never stranded half-visible. A node the new plan
  accounts for is never additionally faded.
- A half-faded node never swallows clicks meant for the map.

## Living relationships

- Live reindexing diffs both file imports and the resolved symbol-level call
  graph; it never deletes inbound relationships owned by another source file.
- A created call travels source-to-target in green, every retained call touched
  by a real content edit travels in teal, and a removed call travels in red
  before fading. Choreography never depends on guessing who wrote the file.
- Flow endpoints resolve to the nearest visible semantic ancestor at the
  current zoom. An internal flow whose endpoints resolve to the same visible
  container becomes one surfaced container signal instead of a self-loop.
- Animated motion communicates direction; living and trace flows have no
  arrowheads. While a pulse travels, its whole route is drawn faintly and
  leaves with it, so a pulse never crosses empty canvas unexplained.
- When an import and a resolved call change between the same files, both
  semantic updates are retained but only the higher-value function-call pulse
  renders, preventing coincident duplicate animation.
- Living relationship traces are transient event choreography, not permanent
  all-graph wiring. Persistent edges remain focus/selection driven so the
  Floor cannot collapse into a spaghetti graph.

## Morning Delta

### What a delta contains

- The delta is a NET architectural diff, never an event log. A file created
  and then deleted, or an edge wired and then unwired, does not appear at all.
  Repeated saves of one file are one entry.
- An endpoint with no system is UNCLASSIFIED, not a different system. A file
  the classifier has not placed has no boundary to cross and can never produce
  a cross-boundary claim.
- A project's first index is its baseline, not a delta. Classifier-contract
  migrations reshape systems without entering the delta for the same reason:
  they change how Ambio reads the code, not the code.
- Reopening a project reconciles the tree against disk through the same
  reindex path the watcher uses, so work done while Ambio was closed produces
  a true delta. Once the catch-up burst settles, the guarded live classifier
  may place new unclassified peers; authored systems and existing Floor
  layouts remain untouched.
- Returning focus to an open Ambio window or opening Review Changes refreshes
  the delta, so new work surfaces without reopening the project.

### Claims are the unit of review

- The reviewable unit is a CLAIM - the smallest statement that changes your
  understanding of the architecture - not a raw change. Call sites, imports,
  and individual files are EVIDENCE nested under the claim they support.
- One new dependency between two systems is one claim, however many call sites
  it has. The report needs topology at both boundaries to call a dependency
  new or gone. Otherwise it describes the observed link changes.
- An IMPORTS that merely accompanies a resolved CALLS between the same files is
  not separate evidence. This matches the living-relationship rule that one
  code change reads as one signal.
- Claims are titled by content, never by category: "Api now depends on
  Storage", not "New cross-boundary calls".
- Claims are ranked by consequence, not recency. A coupling that closes a
  dependency cycle outranks everything. Evidence count weights sub-linearly.
- Hub transitions and orphaned systems are asserted only from exact persisted
  before/after system-graph snapshots. A hub crosses from fewer than three
  neighbors to at least three; an orphaned system still exists but has lost
  its final incoming or outgoing architectural connection.
- Churn wholly inside one system is collapsed to one muted claim per system
  and hidden until the user asks for it.

### Narration (bidirectional)

- Structural facts alone are thin: topology says what moved, never why. The
  agent that made the change writes its intent INTO the map via MCP
  (`start_work` / `note_work` / `finish_work`). With one active session the
  row inherits it; with parallel sessions, declared file/system scope must
  select exactly one owner or the row remains unexplained.
- A claim shows the agent's own words as its rationale, preferring the closing
  summary and falling back to the declared goal while work is in flight.
- Narration is always optional. An un-narrated agent change still appears and
  is marked UNEXPLAINED - silence about a real change is information, not a
  reason to hide it.
- Starting new work closes only the same MCP client's session left open, so a
  crashed agent cannot block narration or evict another agent's live presence.
- Burst collapse never merges saves carrying different work-session IDs, and a
  net change spanning multiple sessions never quotes either as its sole cause.

### Project chrome (approved October 20, 2026)

- Routine index activity, daemon health and passive graph counts take no
  permanent screen space. The canvas and chat extend to the bottom edge.
- The toolbar reads left to right as the screen is laid out (Max, November
  10): where you are (project, branch, open sheet name), as wide as the sheet
  rail under it; the canvas tool switch Select | Lasso | Note; Review Changes
  and Investigations; Search centred in the window while both sides fit; and
  Terminal | Message Agent, the one right-hand panel slot, last. A one-choice
  row is drawn as one joined control. Fit is a button under the minimap.
- Note arms placement: the next click on empty canvas places a note there and
  returns to Select; Escape, Select or Lasso puts it down. Map ▸ Add Note
  still places one in the middle of the view. Investigations opens the saved
  investigations popover under its button (also Tools ▸ Saved
  Investigations…). Recording lives in Tools; an active recording retains a
  visible Stop control.
- The Floor name appears in the left rail only; its toolbar label and reserved
  space are omitted. Open sheets keep their name in the toolbar.
- The saved project title appears immediately left of the branch control on
  both surfaces (Max, November 3). Long titles truncate with the full name on
  hover; changing the project or its name updates the readout. The branch
  control retains its existing appearance and behavior.
- Reads lasting over 1.5 seconds show progress and Stop in the interruption
  lane; quick reads stay quiet. Interrupted live updates show a useful recovery
  notice after 3 seconds. Completion and reconnection clear their notices.
- Workbench architecture drafts use that same lane, become unfinished after
  five minutes without an update, and remain recoverable from Agent →
  Architecture Draft after dismissal. Progress yields to decisions and failures.
- Routine code changes do not raise Review Changes invitations. Pending review
  remains reachable from the toolbar, View and command palette, including while
  new changes arrive. Opening or dismissing an invitation never acknowledges
  the underlying changes. No permanent footer is required.
- Review Changes is selected/expanded only while its review is open. Repeating
  the command closes it without acknowledging changes, just like Escape or
  Close review; pending updates alone do not select the toolbar button.

### Investigation reader and feedback (Max, November 3, 2026)

- Investigations read as an animated step carousel. Recorded questions,
  experiments, observations, assessments and guidance remain separate cards;
  the finding and suggested fix each have a prominent card. An in-progress
  command becomes its completed experiment in the same live timeline position;
  saved playback retains recorded start/result moments as distinct cards.
  There is no repeated hypothesis board or separate composer.
- New live steps queue in order behind a 3.5–7.5 second reading interval,
  rather than silently replacing a paragraph or skipping a burst of results.
  Only explicit Pause or step browsing disables following. Hover, focus,
  selection, opening evidence and ordinary content clicks never disable it or
  restart its timer. Resume advances to the next queued step immediately and
  follows subsequent arrivals with the reading interval; Latest skips directly
  to the newest. The step index temporarily holds the view while open without
  changing the live following setting. Previous/Next, pagination dots with an
  elongated active indicator, the complete index and Left/Right/Home/End
  navigate the sequence. Opening a case midway starts at
  its latest step rather than replaying its entire backlog.
- The card fills the available canvas height above the floating bins or replay
  transport, measured rather than using a fixed height cap. A compact header
  combines title, status, elapsed time, step index and a newer-step shortcut.
  One bottom bar combines previous/next, an explicit following toggle and the
  chat/replay action. Header and controls stay reachable; the current card or
  index is the only scrolling body. Full descriptions render as readable
  paragraphs without a preview cutoff. Incoming events preserve an explicitly
  selected earlier card and its scroll position. Step headings have strong
  visual weight, and each code destination has one filename with optional
  distinct symbol context; redundant module-name/filename pairs are suppressed.
- Run details preserve all findings, samples and available output. No watched
  functions and no fix-verification run are stated separately from successful
  command execution and the agent's conclusion.
- Reply in chat explicitly targets the live case in the existing composer,
  including while a turn is working. Feedback has queued/delivered state and
  uses the shared investigation queue for both managed and client agents.
  Stop remains available for the managed turn. Failed sends retain the draft;
  closed/replaced cases disable sending until the user chooses another context.
  Case-bound server requests and feedback events cannot target a replacement.
- Below 340px of available canvas width, a chip replaces the default card.
  Explicit expansion borrows bounded viewport space; replying minimizes it
  again to keep chat usable. Ordinary card width is at most 420px.
- Saved replay builds its complete reader deck before playback. Opening selects
  the first meaningful recorded step; all later cards remain available through
  arrows, dots and the full index. Raw event count and card count can differ:
  runtime/delivery bookkeeping does not add story cards, while a finding/fix can
  produce two cards at one event. Runtime-only captures remain browsable as
  recorded activity with expandable details. Empty captures stay empty.
- Carousel navigation seeks the timeline and rebuilds the map/runtime prefix.
  Timeline seeks, stepping, playback and restart select the corresponding card.
  The shared player owns event position, reader position and play/pause.
  Playback buttons live only in the timeline. The replay card footer is a
  single centered cluster of nearby chevron arrows and pagination dots, without
  a duplicate Play button or read-only caption. Live follow/chat remain. Restart returns to the beginning without discarding the full
  index; each finding and fix gets its own reading time even at one timestamp.
  Manual navigation pauses playback. Historical cards carry event-time case
  snapshots, so earlier hypotheses cannot display later assessments. Different
  live/saved case IDs remain compatible; live case markers cannot replace a
  replay. Feedback stays read-only, running commands are labeled recorded and
  the playback transport remains clear of the card.
- Reduced-motion mode disables arrival, pulse, chevron and swipe animations;
  outgoing animation layers cannot intercept pointer or keyboard access to
  the step index.

### First-run payoff

- The initial review shows the real repository materializing as the baseline;
  it never substitutes sample data or calls the baseline a change.
- The guide advances from Sheet creation to drawing to dispatch only when each
  persisted state exists, and completes only when that exact planned node is
  realized or flattened.
- The legacy guide opens only from Help → Setup Guide. Project entry and
  relaunch leave it hidden while preserving its saved progress. Hiding the
  guide does not mark onboarding complete.
- The launcher Command Deck derives recent-project signals from each durable
  project database: unreviewed claims, unexplained work, drift, active agents,
  open plans, and pending proposals.

### Review surface

- Review is triage, not playback: the whole ranked list is visible at once and
  any claim can be jumped to directly. There is no "item N of M" transport.
- The panel uses the workbench's chrome and a compact list of observed claims.
  Internal claims are visible when they are the only changes. Agent reports
  expand beside related claims, with other activity available separately.
- Review marks and ghosting are a projection over the living nodes, exactly
  like live FX. Reviewing never mutates canvas state, and a live edit still
  animates on top of a mark.
- Mark colors are the living choreography's vocabulary: green created, teal
  edited, red deleted. During review the mark outranks the churn heat on the
  file perimeter.
- Selecting a claim ghosts everything unrelated using the existing dim
  treatment. The subject, everything inside it, and every container around it
  stay lit - never a lit node inside a ghosted parent.
- A boundary claim frames both SYSTEMS, because the boundary is the claim.
  A file claim frames the file within its parent. A claim with nothing on
  canvas leaves the camera where it is.
- Framing is bounded at both ends: a zoom floor so a small subject never lands
  illegibly, and a ceiling so a two-system claim never fills the viewport with
  one box.
- Reading a delta never acknowledges it. Mark reviewed advances the watermark.
  Closing the panel or Ambio mid-review leaves the delta waiting.
- An active review is a stable snapshot. A focus refresh waits until review
  ends rather than replacing claims or moving the cursor under the reader.
- Mark reviewed acknowledges the report's full window, including hidden
  claims. Later changes survive into the next delta, which loads immediately
  after the acknowledgement completes.

## Agent visibility

### Two streams, one animation

- Two live streams reach the canvas: the SEMANTIC stream (`graph:patch`,
  `call:trace`, `data:flow`, `runtime:*`, `planned:*`) describing consequence,
  and the ACTION stream (`agent:action`) describing agent activity including
  reads. They overlap almost entirely.
- **One consequence, one animation.** The semantic stream owns animation: it
  fires whether the change came from an agent, from you, or from git, and it
  carries the geometry. The action stream owns attribution and the log.
- The action stream's only original visual is the read/attention signal,
  because a read produces no consequence and therefore no semantic broadcast.
  Nothing else can show it.
- Adding an action kind requires answering one question: does a broadcast
  already exist for its consequence? If yes it must not animate from the
  action stream. `agentActionVisual.ts` encodes this per kind and names the
  owning stream, so the rule is executable rather than remembered.
- A failed action never lights a node. The agent looked and got nothing;
  showing it as read would be a lie.
- Repeated reads of one node deepen a single signal. Attention never stacks
  into overlapping glows, and expiry never clears a node a newer signal owns.

### The log

- Every MCP tool call is recorded from one wrapper around the dispatch, so a
  tool added later is captured without being instrumented individually.
- Reads are first-class in the log and absent from the structural journal.
  Watching an agent trace a path is the point of a living canvas even though
  tracing changes nothing.
- Actions are attributed to the declared work session when one is open, so the
  log groups into tasks rather than reading as a flat firehose.
- Recording is best-effort. Failing to log never fails the agent's work.

## Semantic system invariant

- Filesystem directories and filenames never create classifier membership
  edges and never form a system boundary.
- Inferred membership comes only from parsed dependency topology, symbol
  similarity, and git co-change evidence.
- Moving files between folders without changing those semantic signals cannot
  change their inferred systems.
- A single unconnected file remains at the current scope; the classifier must
  not invent a one-file system.

## Required regression matrix

The automated harness must cover these cases before structural extraction:

| Area | Required cases |
|---|---|
| Camera | wheel zoom on pane, compact file, revealed file, symbol row; pointer anchor remains fixed |
| Zoom range | `0.02`, `0.5`, `1`, detail threshold, `10`, `66+`, `100` |
| Selection | click, partial box selection, multi-selection, deselection, read-only |
| Resize | all eight handles; root and nested nodes; ordinary and `100x`; min clamp; cancellation |
| Drag | root, nested file, container, sheet member, drop preview, drop commit |
| Files | compact, detailed, selected, dimmed, runtime, perturbed, long symbol list |
| Systems | collapsed identity, revealed grid, selected, dimmed, drop target |
| Infra | confirmed, proposed, missing registry entry, selected/resized |
| Planned | planned, partial, realized, editable metadata, planned edge |
| Persistence | Floor drag/resize save, sheet drag/resize save, failed save rollback behavior |
| Chrome | 1px outline, 8px handles, 18px hit targets, no ghost shell, no duplicate borders |

## Initial extraction boundaries

The first architecture pass may extract these responsibilities without
changing their behavior:

1. Pure Floor scene projection.
2. Pure sheet-overlay scene projection.
3. Viewport and semantic-zoom controller.
4. Selection controller.
5. Drag/drop controller.
6. Resize persistence controller.
7. Layout persistence and optimistic update boundary.

`AmbioCanvas` remains the integration shell until each extracted module has
characterization coverage. Node components, `frameGeometry`, `packing`, and
the resize SVG remain protected until the harness covers their contracts.


## Sticky notes

- Floor notes belong to the project; sheet notes belong to their sheet. Opening
  a sheet keeps Floor note text read-only. Review/bin canvases do not author notes.
- Notes are native leaf nodes. Dragging into/out of a system uses the existing
  target detection, collision, packing, compression and canonical layout writes.
  The Note stencil uses the same creation/drop path. Parent movement, scaling
  and resizing carry notes exactly like other children; selection/grouping is
  the normal canvas selection model. Notes never become semantic code entities
  or pending code proposals.
- Note geometry lives in the existing Floor/sheet layout tables. Parent-relative
  coordinates and inherited world/content scales use the same preparation,
  projection, worker and resize logic as other nodes. A sheet transforms its own
  geometry, including Floor context children, without changing the Floor.
- Double-click text (or Enter on a focused note) opens multiline editing.
  Typing automatically persists serialized updates; blur flushes pending text.
  Escape/Ctrl/Cmd+Enter ends editing without discarding changes. Empty text is
  valid. There are no normal Edit/Save/Cancel/Delete buttons; Delete/Backspace
  removes a selected note and edits text normally inside its textarea.
- Overflowing text consumes scrolling; note paper/content scales with its
  canonical geometry and stays clipped to its bounds. The standard eight resize
  handles retain normal canvas behavior and screen size.
- Human/agent text updates and deletion require a note revision. Conflicts keep
  local text until an explicit choice; failed writes remain visible and preserve
  drafts. Remote deletion retains draft recovery. Surface changes retain active
  text sessions and flush pending updates; project changes flush and clear them.
- Expanded sheets list notes independently of code review. Agent reads expose
  current canonical geometry in `layout`; agent owner changes use `parentNodeId`.
