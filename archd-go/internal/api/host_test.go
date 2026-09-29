package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestLoopbackHostCheckStopsRebindingRequests(t *testing.T) {
	handler := RequireLoopbackHost(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusNoContent)
	}))
	for host, want := range map[string]int{
		"127.0.0.1:7743":        http.StatusNoContent,
		"localhost:7743":        http.StatusNoContent,
		"[::1]:7743":            http.StatusNoContent,
		"LOCALHOST":             http.StatusNoContent,
		"evil.example.com":      http.StatusForbidden,
		"evil.example.com:7743": http.StatusForbidden,
		"127.0.0.1.nip.io:7743": http.StatusForbidden,
	} {
		request := httptest.NewRequest(http.MethodGet, "/api/snapshot/x", nil)
		request.Host = host
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != want {
			t.Errorf("Host %q: status %d, want %d", host, recorder.Code, want)
		}
	}
}
