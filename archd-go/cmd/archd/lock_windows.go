//go:build windows

package main

import (
	"os"

	"golang.org/x/sys/windows"
)

// lockDataDir takes an exclusive, non-blocking lock that the OS releases when
// the process exits, however it exits.
func lockDataDir(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	overlapped := new(windows.Overlapped)
	flags := uint32(windows.LOCKFILE_EXCLUSIVE_LOCK | windows.LOCKFILE_FAIL_IMMEDIATELY)
	if err := windows.LockFileEx(windows.Handle(file.Fd()), flags, 0, 1, 0, overlapped); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}
