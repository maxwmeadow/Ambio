package main

import (
	"fmt"
	"net"
)

// listenPreferred binds 127.0.0.1:port. With fallback, a port another program
// already holds is replaced by one the OS picks; the port actually used is
// published in daemon.json, which the app and the MCP server read.
func listenPreferred(port int, fallback bool) (net.Listener, int, error) {
	listener, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", port))
	if err != nil && fallback {
		listener, err = net.Listen("tcp", "127.0.0.1:0")
	}
	if err != nil {
		return nil, 0, err
	}
	return listener, listener.Addr().(*net.TCPAddr).Port, nil
}
