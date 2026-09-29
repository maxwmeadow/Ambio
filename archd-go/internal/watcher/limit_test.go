package watcher

import (
	"errors"
	"testing"
)

func TestWatchLimitErrorsAreRecognised(t *testing.T) {
	if !IsWatchLimit(errors.New("inotify_add_watch /x: no space left on device")) {
		t.Fatal("inotify limit not recognised")
	}
	if !IsWatchLimit(errors.New("too many open files")) {
		t.Fatal("open-file limit not recognised")
	}
	if IsWatchLimit(errors.New("permission denied")) || IsWatchLimit(nil) {
		t.Fatal("unrelated errors reported as a watch limit")
	}
}
