package main

import (
	"encoding/json"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"
)

// version is stamped at build time (scripts/archd.sh) from package.json.
var version = "dev"

// daemonInfo is written to <data>/daemon.json while archd runs. It is how the
// app and the MCP server find a daemon that is already running - started by
// the app, or started headless by an agent while the app was closed - instead
// of starting a second one that loses the race for the ports.
type daemonInfo struct {
	PID         int    `json:"pid"`
	Version     string `json:"version"`
	APIPort     int    `json:"apiPort"`
	WSPort      int    `json:"wsPort"`
	RuntimePort int    `json:"runtimePort"`
	Headless    bool   `json:"headless"`
	StartedAt   int64  `json:"startedAt"`
}

func daemonInfoPath(dataDir string) string {
	return filepath.Join(dataDir, "daemon.json")
}

func writeDaemonInfo(dataDir string, info daemonInfo) error {
	data, err := json.MarshalIndent(info, "", "  ")
	if err != nil {
		return err
	}
	temp := daemonInfoPath(dataDir) + ".tmp"
	if err := os.WriteFile(temp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(temp, daemonInfoPath(dataDir))
}

// removeDaemonInfo deletes the discovery file only if it still describes this
// process: a newer daemon may already have replaced it.
func removeDaemonInfo(dataDir string, pid int) {
	data, err := os.ReadFile(daemonInfoPath(dataDir))
	if err != nil {
		return
	}
	var info daemonInfo
	if json.Unmarshal(data, &info) == nil && info.PID == pid {
		_ = os.Remove(daemonInfoPath(dataDir))
	}
}

// activityTracker records when archd last served a request, so a headless
// daemon can exit once nobody is using it.
type activityTracker struct{ last atomic.Int64 }

func newActivityTracker() *activityTracker {
	tracker := &activityTracker{}
	tracker.touch()
	return tracker
}

func (a *activityTracker) touch() { a.last.Store(time.Now().UnixNano()) }

func (a *activityTracker) idleFor() time.Duration {
	return time.Since(time.Unix(0, a.last.Load()))
}

func (a *activityTracker) wrap(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		a.touch()
		next.ServeHTTP(w, r)
	})
}

// watchIdle stops a headless daemon after idleLimit with no requests and no
// connected windows. A daemon the app started never idles out: the app owns
// its lifetime.
func watchIdle(tracker *activityTracker, clients func() int, idleLimit time.Duration, stop chan<- os.Signal) {
	interval := idleLimit / 10
	if interval > 30*time.Second {
		interval = 30 * time.Second
	}
	if interval < 10*time.Millisecond {
		interval = 10 * time.Millisecond
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		if clients() > 0 {
			tracker.touch()
			continue
		}
		if tracker.idleFor() >= idleLimit {
			log.Printf("archd: idle for %s with no clients; exiting", idleLimit)
			stop <- os.Interrupt
			return
		}
	}
}

// registerDaemonRoutes adds the lifecycle endpoints. Both sit behind the local
// API token like every other route.
func registerDaemonRoutes(mux *http.ServeMux, info daemonInfo, stop chan<- os.Signal) {
	mux.HandleFunc("/api/daemon/info", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(info)
	})
	// The app asks a daemon from another Ambio version to step aside.
	mux.HandleFunc("/api/daemon/shutdown", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"stopping":true}`))
		go func() {
			time.Sleep(100 * time.Millisecond)
			stop <- os.Interrupt
		}()
	})
}
