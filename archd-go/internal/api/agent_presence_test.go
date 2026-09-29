package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"axiom.local/archd/internal/hub"
	axiomruntime "axiom.local/archd/internal/runtime"
)

func TestAgentPresenceIsALiveLeaseNotPermanentHistory(t *testing.T) {
	now := time.UnixMilli(1_000_000)
	eventHub := hub.New()
	server := NewServer(t.TempDir(), eventHub, axiomruntime.NewManager(eventHub))
	server.presenceNow = func() time.Time { return now }
	server.agentPresenceTTL = 15 * time.Second

	body := []byte(`{"workspaceId":"ws","connectionId":"process-1","hostId":"codex"}`)
	post := httptest.NewRequest(http.MethodPost, "/api/agent/presence", bytes.NewReader(body))
	postResponse := httptest.NewRecorder()
	server.handleAgentPresence(postResponse, post)
	if postResponse.Code != http.StatusOK {
		t.Fatalf("POST status %d: %s", postResponse.Code, postResponse.Body.String())
	}
	var firstLease struct {
		NewLease bool `json:"newLease"`
	}
	if err := json.Unmarshal(postResponse.Body.Bytes(), &firstLease); err != nil {
		t.Fatal(err)
	}
	if !firstLease.NewLease {
		t.Fatal("first heartbeat should create a new lease")
	}

	renew := httptest.NewRequest(http.MethodPost, "/api/agent/presence", bytes.NewReader(body))
	renewResponse := httptest.NewRecorder()
	server.handleAgentPresence(renewResponse, renew)
	var renewedLease struct {
		NewLease bool `json:"newLease"`
	}
	if err := json.Unmarshal(renewResponse.Body.Bytes(), &renewedLease); err != nil {
		t.Fatal(err)
	}
	if renewedLease.NewLease {
		t.Fatal("renewing an active heartbeat should not create a new lease")
	}
	verified := httptest.NewRecorder()
	server.handleAgentPresence(verified, httptest.NewRequest(http.MethodPost, "/api/agent/presence", bytes.NewReader(
		[]byte(`{"workspaceId":"ws","connectionId":"process-1","hostId":"codex","verifiedTool":true}`),
	)))
	if verified.Code != http.StatusOK {
		t.Fatalf("verification status %d: %s", verified.Code, verified.Body.String())
	}

	read := func() struct {
		Connected   bool            `json:"connected"`
		Connections []AgentPresence `json:"connections"`
	} {
		response := httptest.NewRecorder()
		server.handleAgentPresence(
			response,
			httptest.NewRequest(http.MethodGet, "/api/agent/presence?workspace=ws", nil),
		)
		if response.Code != http.StatusOK {
			t.Fatalf("GET status %d: %s", response.Code, response.Body.String())
		}
		var result struct {
			Connected   bool            `json:"connected"`
			Connections []AgentPresence `json:"connections"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		return result
	}

	active := read()
	if !active.Connected || len(active.Connections) != 1 || active.Connections[0].HostID != "codex" || active.Connections[0].LastToolAt != now.UnixMilli() {
		t.Fatalf("active lease = %#v", active)
	}
	server.handleAgentPresence(httptest.NewRecorder(), httptest.NewRequest(http.MethodPost, "/api/agent/presence", bytes.NewReader(body)))
	if retained := read().Connections[0].LastToolAt; retained != now.UnixMilli() {
		t.Fatalf("heartbeat lost tool verification: %d", retained)
	}

	now = now.Add(16 * time.Second)
	rejoined := httptest.NewRecorder()
	server.handleAgentPresence(rejoined, httptest.NewRequest(http.MethodPost, "/api/agent/presence", bytes.NewReader(body)))
	var fresh struct {
		NewLease bool `json:"newLease"`
	}
	if err := json.Unmarshal(rejoined.Body.Bytes(), &fresh); err != nil {
		t.Fatal(err)
	}
	if !fresh.NewLease || read().Connections[0].LastToolAt != 0 {
		t.Fatal("an expired process must reconnect without inheriting old tool verification")
	}
	now = now.Add(16 * time.Second)
	expired := read()
	if expired.Connected || len(expired.Connections) != 0 {
		t.Fatalf("expired lease = %#v", expired)
	}
}
