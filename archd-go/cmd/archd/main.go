// archd - Axiom parser daemon.
//
// Usage:
//
//	archd -data <dir> [-ws-port 7744] [-api-port 7743]
//
// The daemon:
//  1. Opens (or creates) the SQLite graph database at <data>/axiom.db
//  2. Starts an HTTP server on api-port (REST API + WebSocket on /ws)
//  3. Reads JSON commands from stdin (sent by Electron main process via IPC pipe)
//  4. On receiving an "open:project" command, indexes the root and watches for changes
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"axiom.local/archd/internal/api"
	"axiom.local/archd/internal/hub"
	"axiom.local/archd/internal/runtime"
)

func main() {
	if len(os.Args) > 1 && os.Args[1] == mcpRunCommand {
		runMCP(os.Args[2:])
		return
	}
	dataDir := flag.String("data", "", "directory for axiom.db (required)")
	wsPort := flag.Int("ws-port", 7744, "WebSocket port")
	apiPort := flag.Int("api-port", 7743, "HTTP API port")
	runtimePort := flag.Int("runtime-port", 7745, "runtime adapter TCP port")
	headless := flag.Bool("headless", false, "started for an agent without the app; exit when idle")
	idleExit := flag.Duration("idle-exit", 15*time.Minute, "with -headless, exit after this long unused")
	showVersion := flag.Bool("version", false, "print the version and exit")
	autoPorts := flag.Bool("auto-ports", false, "if a port is taken by another program, use a free one (published in daemon.json)")
	flag.Parse()

	if *showVersion {
		fmt.Println(version)
		return
	}

	if *dataDir == "" {
		fmt.Fprintln(os.Stderr, "archd: -data flag required")
		os.Exit(1)
	}

	// One daemon per data folder. A second one - two agents starting archd at
	// the same moment, or an app racing an agent - would share the databases
	// and double every watcher, so it steps aside instead.
	if err := os.MkdirAll(*dataDir, 0o755); err != nil {
		log.Fatalf("archd: data dir: %v", err)
	}
	lock, err := lockDataDir(filepath.Join(*dataDir, "archd.lock"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "archd: another archd is already running for %s\n", *dataDir)
		os.Exit(3)
	}
	defer lock.Close()

	// ── Hub ───────────────────────────────────────────────────────────────────
	h := hub.New()

	// ── Runtime adapter server ────────────────────────────────────────────────
	// Language adapters running inside target processes connect here over TCP
	// (newline-delimited JSON) to stream call/return events.
	rt := runtime.NewManager(h)
	if os.Getenv("AXIOM_AUTO_CONFIRM_INJECT") == "1" {
		log.Println("archd: AXIOM_AUTO_CONFIRM_INJECT=1 - injections skip user confirmation")
		rt.SetAutoConfirm(true)
	}
	// The port is often still held for a moment by the archd this one
	// replaces. Wait briefly; with -auto-ports take any free port instead.
	// Failing that, run without live run tracing rather than take the whole
	// map down with it.
	var runtimeErr error
	for attempt := 0; attempt < 10; attempt++ {
		if runtimeErr = rt.Listen(*runtimePort); runtimeErr == nil {
			break
		}
		if *autoPorts {
			runtimeErr = rt.Listen(0)
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	if runtimeErr != nil {
		log.Printf("archd: runtime: %v - investigations cannot capture runs until archd restarts", runtimeErr)
	}

	apiListener, actualAPIPort, err := listenPreferred(*apiPort, *autoPorts)
	if err != nil {
		log.Fatalf("archd: http: %v", err)
	}
	actualWSPort := actualAPIPort
	var wsListener net.Listener
	if *wsPort != *apiPort {
		wsListener, actualWSPort, err = listenPreferred(*wsPort, *autoPorts)
		if err != nil {
			log.Fatalf("archd: ws: %v", err)
		}
	}

	// ── HTTP server ───────────────────────────────────────────────────────────
	// Each project gets its own database at <dataDir>/<workspaceId>/axiom.db,
	// opened on demand when POST /api/workspace is called. No global DB here.
	srv := api.NewServer(*dataDir, h, rt)
	mux := http.NewServeMux()
	srv.RegisterRoutes(mux)

	quit := make(chan os.Signal, 1)
	info := daemonInfo{
		PID: os.Getpid(), Version: version, APIPort: actualAPIPort, WSPort: actualWSPort,
		RuntimePort: rt.Port(), Headless: *headless, StartedAt: time.Now().UnixMilli(),
	}
	registerDaemonRoutes(mux, info, quit)
	activity := newActivityTracker()

	// Loopback-origin CORS: the dev renderer is served from localhost:5173,
	// a different origin from this port. See api.AllowLoopbackOrigins.
	token, err := api.LocalAPIToken(*dataDir)
	if err != nil {
		log.Fatalf("archd: local authentication: %v", err)
	}
	handler := activity.wrap(api.RequireLoopbackHost(api.AllowAuthenticatedOrigins(api.RequireLocalToken(token, mux))))
	httpServer := &http.Server{Handler: handler}
	go func() {
		log.Printf("archd: HTTP API listening on %s", apiListener.Addr())
		if err := httpServer.Serve(apiListener); err != nil && err != http.ErrServerClosed {
			log.Fatalf("archd: http: %v", err)
		}
	}()

	// WebSocket runs on the same mux (the /ws route), so we also listen on wsPort
	// if it differs from apiPort. Electron may connect either port.
	if wsListener != nil {
		wsServer := &http.Server{Handler: handler}
		go func() {
			log.Printf("archd: WebSocket listening on %s", wsListener.Addr())
			if err := wsServer.Serve(wsListener); err != nil && err != http.ErrServerClosed {
				log.Fatalf("archd: ws: %v", err)
			}
		}()
	}

	// ── Stdin IPC loop ────────────────────────────────────────────────────────
	// Electron sends newline-delimited JSON commands to our stdin.
	// We respond by writing JSON to stdout (one line per response).
	go runIPCLoop(h, srv)

	// Announce ourselves once the listeners are up; see daemonInfo.
	if err := writeDaemonInfo(*dataDir, info); err != nil {
		log.Printf("archd: could not write daemon.json: %v", err)
	}
	defer removeDaemonInfo(*dataDir, info.PID)
	if *headless {
		log.Printf("archd: headless; exits after %s unused", *idleExit)
		go watchIdle(activity, h.ClientCount, *idleExit, quit)
	}

	// ── Signals ───────────────────────────────────────────────────────────────
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	log.Println("archd: shutting down")
}

// IPCCommand is the envelope for all stdin commands from Electron.
type IPCCommand struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

// IPCResponse is the envelope for stdout responses.
type IPCResponse struct {
	Type    string `json:"type"`
	Success bool   `json:"success"`
	Error   string `json:"error,omitempty"`
	Payload any    `json:"payload,omitempty"`
}

func respond(v IPCResponse) {
	line, _ := json.Marshal(v)
	fmt.Println(string(line))
}

func runIPCLoop(_ *hub.Hub, _ *api.Server) {
	scanner := bufio.NewScanner(os.Stdin)
	for scanner.Scan() {
		line := scanner.Bytes()
		var cmd IPCCommand
		if err := json.Unmarshal(line, &cmd); err != nil {
			log.Printf("ipc: bad command: %v", err)
			continue
		}
		switch cmd.Type {
		case "ping":
			respond(IPCResponse{Type: "pong", Success: true})
		default:
			// Most commands go through the REST API directly (Electron uses fetch).
			// The IPC pipe is only for commands that need process-level awareness.
			log.Printf("ipc: unknown command type: %s", cmd.Type)
		}
	}
	if err := scanner.Err(); err != nil {
		log.Printf("ipc: stdin error: %v", err)
	}
}
