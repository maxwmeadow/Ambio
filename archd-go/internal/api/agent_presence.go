package api

import (
	"encoding/json"
	"net/http"
	"sort"
)

// AgentPresence is one running MCP process with a renewable connection lease.
// HostID identifies the harness when Ambio installed it; "unknown" preserves
// compatibility with manually configured and older MCP entries.
type AgentPresence struct {
	ConnectionID string `json:"connectionId"`
	HostID       string `json:"hostId"`
	LastSeenAt   int64  `json:"lastSeenAt"`
	LastToolAt   int64  `json:"lastToolAt,omitempty"`
	// WatchingUntil is set while the session is waiting on the inbox for the
	// next request (get_inbox with wait), so the canvas can send to it.
	WatchingUntil int64 `json:"watchingUntil,omitempty"`
}

func (s *Server) handleAgentPresence(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodPost:
		var body struct {
			WorkspaceID  string `json:"workspaceId"`
			ConnectionID string `json:"connectionId"`
			HostID       string `json:"hostId"`
			VerifiedTool bool   `json:"verifiedTool"`
			// WatchingForMs says the session is waiting on the inbox this long.
			WatchingForMs int64 `json:"watchingForMs"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			jsonError(w, "invalid body", http.StatusBadRequest)
			return
		}
		if body.WorkspaceID == "" || body.ConnectionID == "" {
			jsonError(w, "workspaceId and connectionId are required", http.StatusBadRequest)
			return
		}
		if len(body.ConnectionID) > 128 || len(body.HostID) > 128 {
			jsonError(w, "connectionId or hostId is too long", http.StatusBadRequest)
			return
		}
		if body.HostID == "" {
			body.HostID = "unknown"
		}
		now := s.presenceNow().UnixMilli()
		presence := AgentPresence{
			ConnectionID: body.ConnectionID,
			HostID:       body.HostID,
			LastSeenAt:   now,
		}
		s.presenceMu.Lock()
		connections := s.agentPresence[body.WorkspaceID]
		if connections == nil {
			connections = make(map[string]AgentPresence)
			s.agentPresence[body.WorkspaceID] = connections
		}
		previous, existed := connections[body.ConnectionID]
		existed = existed && previous.HostID == body.HostID && previous.LastSeenAt >= now-s.agentPresenceTTL.Milliseconds()
		if existed {
			presence.LastToolAt = previous.LastToolAt
			if previous.WatchingUntil > now {
				presence.WatchingUntil = previous.WatchingUntil
			}
		}
		if body.WatchingForMs > 0 {
			if body.WatchingForMs > 120_000 {
				body.WatchingForMs = 120_000
			}
			presence.WatchingUntil = now + body.WatchingForMs
		}
		if body.VerifiedTool {
			presence.LastToolAt = now
		}
		connections[body.ConnectionID] = presence
		s.presenceMu.Unlock()
		jsonOK(w, map[string]any{
			"connectionId": presence.ConnectionID,
			"hostId":       presence.HostID,
			"lastSeenAt":   presence.LastSeenAt,
			"lastToolAt":   presence.LastToolAt,
			"newLease":     !existed,
		})

	case http.MethodGet:
		workspaceID := r.URL.Query().Get("workspace")
		if workspaceID == "" {
			jsonError(w, "workspace is required", http.StatusBadRequest)
			return
		}
		cutoff := s.presenceNow().Add(-s.agentPresenceTTL).UnixMilli()
		active := []AgentPresence{}
		s.presenceMu.Lock()
		connections := s.agentPresence[workspaceID]
		for id, presence := range connections {
			if presence.LastSeenAt < cutoff {
				delete(connections, id)
				continue
			}
			active = append(active, presence)
		}
		if len(connections) == 0 {
			delete(s.agentPresence, workspaceID)
		}
		s.presenceMu.Unlock()
		sort.Slice(active, func(i, j int) bool {
			if active[i].HostID == active[j].HostID {
				return active[i].ConnectionID < active[j].ConnectionID
			}
			return active[i].HostID < active[j].HostID
		})
		jsonOK(w, map[string]any{
			"connected":   len(active) > 0,
			"connections": active,
		})

	default:
		http.NotFound(w, r)
	}
}
