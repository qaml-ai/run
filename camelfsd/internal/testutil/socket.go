package testutil

import (
	"os"
	"testing"
)

// SocketDir keeps Unix socket names below sun_path even for long test names.
func SocketDir(t *testing.T) string {
	t.Helper()
	d, e := os.MkdirTemp("/tmp", "cfs")
	if e != nil {
		t.Fatal(e)
	}
	t.Cleanup(func() { os.RemoveAll(d) })
	return d
}
