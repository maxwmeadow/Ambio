package main

import (
	"os"
	"sync/atomic"
	"testing"
	"time"
)

func TestDaemonInfoIsRemovedOnlyByItsOwner(t *testing.T) {
	dir := t.TempDir()
	if err := writeDaemonInfo(dir, daemonInfo{PID: 42, Version: "1.2.3"}); err != nil {
		t.Fatal(err)
	}
	removeDaemonInfo(dir, 7)
	if _, err := os.Stat(daemonInfoPath(dir)); err != nil {
		t.Fatalf("another process removed our discovery file: %v", err)
	}
	removeDaemonInfo(dir, 42)
	if _, err := os.Stat(daemonInfoPath(dir)); !os.IsNotExist(err) {
		t.Fatalf("discovery file survived its owner: %v", err)
	}
}

func TestHeadlessDaemonStopsWhenIdleButNotWhileWindowsAreOpen(t *testing.T) {
	tracker := newActivityTracker()
	stop := make(chan os.Signal, 1)
	var clients atomic.Int32
	clients.Store(1)
	go watchIdle(tracker, func() int { return int(clients.Load()) }, 50*time.Millisecond, stop)
	select {
	case <-stop:
		t.Fatal("stopped while a window was connected")
	case <-time.After(150 * time.Millisecond):
	}
	clients.Store(0)
	select {
	case <-stop:
	case <-time.After(2 * time.Second):
		t.Fatal("idle daemon never stopped")
	}
}
