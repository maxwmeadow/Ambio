package runtime

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
	"testing"
	"time"
)

// The DAP client speaks Content-Length framed JSON, matches responses to
// requests by seq, and hands events to the session.

type fakeAdapter struct {
	in  *bufio.Reader // what the client sends
	out io.Writer     // what the adapter answers
}

func (a fakeAdapter) read(t *testing.T) dapMessage {
	t.Helper()
	length, err := readDAPHeader(a.in)
	if err != nil {
		t.Fatal(err)
	}
	buf := make([]byte, length)
	if _, err := io.ReadFull(a.in, buf); err != nil {
		t.Fatal(err)
	}
	var msg dapMessage
	if err := json.Unmarshal(buf, &msg); err != nil {
		t.Fatal(err)
	}
	return msg
}

func (a fakeAdapter) write(t *testing.T, msg dapMessage) {
	t.Helper()
	body, _ := json.Marshal(msg)
	if _, err := fmt.Fprintf(a.out, "Content-Length: %d\r\n\r\n%s", len(body), body); err != nil {
		t.Fatal(err)
	}
}

func dapPair(t *testing.T) (*dapClient, fakeAdapter) {
	t.Helper()
	toAdapter, fromClient := io.Pipe()
	toClient, fromAdapter := io.Pipe()
	client := newDAPClient(toClient, fromClient, func() error {
		_ = fromClient.Close()
		return toClient.Close()
	})
	t.Cleanup(client.close)
	return client, fakeAdapter{in: bufio.NewReader(toAdapter), out: fromAdapter}
}

func TestDAPRequestsGetTheirOwnResponses(t *testing.T) {
	client, adapter := dapPair(t)
	type result struct {
		msg dapMessage
		err error
	}
	done := make(chan result, 1)
	go func() {
		msg, err := client.request("initialize", map[string]string{"adapterID": "test"})
		done <- result{msg, err}
	}()

	req := adapter.read(t)
	if req.Type != "request" || req.Command != "initialize" || !strings.Contains(string(req.Arguments), `"adapterID":"test"`) {
		t.Fatalf("request = %+v", req)
	}
	// An event and an unrelated response arrive first; neither answers it.
	adapter.write(t, dapMessage{Seq: 1, Type: "event", Event: "output", Body: json.RawMessage(`{"output":"hi"}`)})
	adapter.write(t, dapMessage{Seq: 2, Type: "response", RequestSeq: req.Seq + 100, Success: true})
	adapter.write(t, dapMessage{Seq: 3, Type: "response", RequestSeq: req.Seq, Success: true, Body: json.RawMessage(`{"supportsConfigurationDoneRequest":true}`)})

	got := <-done
	if got.err != nil || !strings.Contains(string(got.msg.Body), "supportsConfigurationDoneRequest") {
		t.Fatalf("response = %+v, %v", got.msg, got.err)
	}
	select {
	case event := <-client.events:
		if event.Event != "output" {
			t.Fatalf("event = %+v", event)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the event never arrived")
	}
}

func TestADAPFailureIsAnError(t *testing.T) {
	client, adapter := dapPair(t)
	done := make(chan error, 1)
	go func() {
		_, err := client.request("launch", nil)
		done <- err
	}()
	req := adapter.read(t)
	adapter.write(t, dapMessage{Type: "response", RequestSeq: req.Seq, Success: false, Message: "no such program"})
	if err := <-done; err == nil || !strings.Contains(err.Error(), "no such program") {
		t.Fatalf("err = %v", err)
	}
}

func TestADAPConnectionThatClosesFailsPendingRequests(t *testing.T) {
	client, adapter := dapPair(t)
	done := make(chan error, 1)
	go func() {
		_, err := client.request("threads", nil)
		done <- err
	}()
	adapter.read(t)
	// A hostile frame size closes the connection instead of allocating it.
	if _, err := fmt.Fprintf(adapter.out, "Content-Length: %d\r\n\r\n", maxDAPMessageBytes+1); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "closed") {
			t.Fatalf("err = %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the request never failed")
	}
}

func TestDAPHeaders(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want int
		ok   bool
	}{
		{"Content-Length: 12\r\n\r\n", 12, true},
		{"Content-Type: x\r\nContent-Length: 3\r\n\r\n", 3, true},
		{"\r\n", 0, false},
		{"Content-Length: nope\r\n\r\n", 0, false},
	} {
		got, err := readDAPHeader(bufio.NewReader(strings.NewReader(tc.raw)))
		if (err == nil) != tc.ok || (tc.ok && got != tc.want) {
			t.Errorf("%q → %d, %v", tc.raw, got, err)
		}
	}
}
