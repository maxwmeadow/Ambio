//go:build !windows

package main

import (
	"os"
	"syscall"
)

// lockDataDir takes an exclusive, non-blocking lock that the OS releases when
// the process exits, however it exits.
func lockDataDir(path string) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		file.Close()
		return nil, err
	}
	return file, nil
}
