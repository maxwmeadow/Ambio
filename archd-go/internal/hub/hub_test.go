package hub

import (
	"github.com/gorilla/websocket"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestScopedClientsCannotReceiveAnotherWorkspaceAndSequencesRemainContiguous(t *testing.T) {
	h := New()
	registered := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upgrade := websocket.Upgrader{}
		conn, err := upgrade.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		h.Register(conn, r.URL.Query().Get("workspace"))
		registered <- struct{}{}
	}))
	defer server.Close()
	connect := func(workspace string) *websocket.Conn {
		conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"?workspace="+workspace, nil)
		if err != nil {
			t.Fatal(err)
		}
		<-registered
		t.Cleanup(func() { conn.Close() })
		return conn
	}
	a, b := connect("a"), connect("b")
	h.BroadcastPatch(map[string]any{"type": "canvas:message", "payload": map[string]string{"workspaceId": "b", "note": "B-private"}})
	h.BroadcastPatch(map[string]any{"type": "canvas:message", "payload": map[string]string{"workspaceId": "a", "note": "A-private"}})
	read := func(conn *websocket.Conn) Message {
		conn.SetReadDeadline(time.Now().Add(time.Second))
		var msg Message
		if err := conn.ReadJSON(&msg); err != nil {
			t.Fatal(err)
		}
		return msg
	}
	am, bm := read(a), read(b)
	if am.Seq != 1 || bm.Seq != 1 || strings.Contains(string(am.Payload), "B-private") || strings.Contains(string(bm.Payload), "A-private") {
		t.Fatal(am, bm)
	}
	h.BroadcastPatch(map[string]any{"type": "file:deleted", "payload": map[string]string{"id": "anonymous-private-id"}})
	for _, conn := range []*websocket.Conn{a, b} {
		m := read(conn)
		if m.Type != "workspace:invalidate" || m.Seq != 2 || strings.Contains(string(m.Payload), "anonymous") {
			t.Fatal(m)
		}
	}
	var wg sync.WaitGroup
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); h.Broadcast("update", map[string]string{"workspaceId": "a"}) }()
	}
	wg.Wait()
	for i := uint64(3); i < 23; i++ {
		m := read(a)
		if m.Seq != i {
			t.Fatalf("out of order sequence %d != %d", m.Seq, i)
		}
	}
}
