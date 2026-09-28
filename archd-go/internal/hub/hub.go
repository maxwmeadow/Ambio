// Package hub manages WebSocket clients and broadcasts graph updates to the renderer.
package hub

import (
	"encoding/json"
	"log"
	"sync"
	"sync/atomic"

	"github.com/gorilla/websocket"
)

// Message is the envelope for all WebSocket events.
type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
	Seq     uint64          `json:"seq"`
}

type client struct {
	workspace string
	seq       uint64
	conn      *websocket.Conn
	send      chan []byte
	done      chan struct{}
	once      sync.Once
}

func (c *client) close() {
	c.once.Do(func() {
		close(c.done)
		_ = c.conn.Close()
	})
}

// Hub maintains the set of active WebSocket connections.
type Hub struct {
	broadcastMu sync.Mutex
	mu          sync.RWMutex
	clients     map[*client]struct{}

	tapMu sync.RWMutex
	tap   func(msgType string, payload json.RawMessage)
	seq   atomic.Uint64
}

func New() *Hub {
	return &Hub{clients: make(map[*client]struct{})}
}

// SetTap registers a single observer that receives every broadcast (type +
// already-marshaled payload) before it is sent to clients. Used by the
// investigation recorder to capture the live event stream. The tap must be
// cheap and must never call back into Broadcast (it runs inline).
func (h *Hub) SetTap(fn func(msgType string, payload json.RawMessage)) {
	h.tapMu.Lock()
	h.tap = fn
	h.tapMu.Unlock()
}

// Register adds a new WebSocket connection and starts its write pump.
func (h *Hub) Register(conn *websocket.Conn, workspace ...string) {
	c := &client{conn: conn, send: make(chan []byte, 64), done: make(chan struct{})}
	if len(workspace) > 0 {
		c.workspace = workspace[0]
	}
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.mu.Unlock()
	go c.writePump(func() {
		h.mu.Lock()
		delete(h.clients, c)
		h.mu.Unlock()
	})
}

func (c *client) writePump(onDone func()) {
	defer func() {
		c.close()
		onDone()
	}()
	for {
		select {
		case msg := <-c.send:
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-c.done:
			return
		}
	}
}

// Broadcast sends a typed message to all connected clients.
func (h *Hub) Broadcast(msgType string, payload any) {
	h.broadcastMu.Lock()
	defer h.broadcastMu.Unlock()
	raw, err := json.Marshal(payload)
	if err != nil {
		log.Printf("hub: marshal %s: %v", msgType, err)
		return
	}
	msg, err := json.Marshal(Message{Type: msgType, Payload: raw, Seq: h.seq.Add(1)})
	if err != nil {
		log.Printf("hub: marshal envelope: %v", err)
		return
	}
	h.tapMu.RLock()
	tap := h.tap
	h.tapMu.RUnlock()
	if tap != nil {
		tap(msgType, raw)
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	workspace := eventWorkspace(raw)
	for c := range h.clients {
		out := msg
		if c.workspace != "" {
			if workspace != "" && workspace != c.workspace {
				continue
			}
			c.seq++
			kind, body := msgType, raw
			// Old unscoped events only invalidate. Never apply another project's
			// anonymous entity mutation to a scoped client.
			if workspace == "" {
				kind = "workspace:invalidate"
				body, _ = json.Marshal(map[string]string{"workspaceId": c.workspace})
			}
			out, _ = json.Marshal(Message{Type: kind, Payload: body, Seq: c.seq})
		}
		select {
		case c.send <- out:
		default:
			// Disconnect rather than silently dropping part of a graph update.
			log.Printf("hub: disconnecting slow client for snapshot resync")
			c.close()
		}
	}
}

func eventWorkspace(raw json.RawMessage) string {
	var envelope struct {
		WorkspaceID string          `json:"workspaceId"`
		Payload     json.RawMessage `json:"payload"`
	}
	if json.Unmarshal(raw, &envelope) != nil {
		return ""
	}
	if envelope.WorkspaceID != "" {
		return envelope.WorkspaceID
	}
	if len(envelope.Payload) > 0 {
		return eventWorkspace(envelope.Payload)
	}
	return ""
}

// BroadcastSnapshot sends a full graph:snapshot event.
func (h *Hub) BroadcastSnapshot(payload any) {
	h.Broadcast("graph:snapshot", payload)
}

// BroadcastClassification sends a complete semantic reconciliation without
// treating it as a cold-load snapshot. The renderer preserves interaction
// state and choreographs files moving into newly proposed systems.
func (h *Hub) BroadcastClassification(payload any) {
	h.Broadcast("classification:updated", payload)
}

// BroadcastPatch sends a graph:patch event with incremental changes.
func (h *Hub) BroadcastPatch(payload any) {
	h.Broadcast("graph:patch", payload)
}

// BroadcastIndexingProgress reports indexing progress to the UI.
func (h *Hub) BroadcastIndexingProgress(indexed, total int, workspace ...string) {
	payload := map[string]any{
		"indexed": indexed,
		"total":   total,
	}
	if len(workspace) > 0 {
		payload["workspaceId"] = workspace[0]
	}
	h.Broadcast("indexing:progress", payload)
}

// BroadcastIndexingComplete signals that initial indexing finished.
func (h *Hub) BroadcastIndexingComplete(workspaceID string) {
	h.Broadcast("indexing:complete", map[string]any{
		"workspaceId": workspaceID,
	})
}

// ClientCount returns the number of connected WebSocket clients.
func (h *Hub) ClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
