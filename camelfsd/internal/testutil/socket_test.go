package testutil

import (
	"net"
	"path/filepath"
	"testing"
)

func TestSocketDir(t *testing.T) {
	t.Run("a-long-test-name-that-would-exceed-the-Unix-socket-path-limit-under-the-default-test-temp-directory", func(t *testing.T) {
		p := filepath.Join(SocketDir(t), "v_5201")
		if len(p) >= 90 {
			t.Fatal(p)
		}
		l, e := net.Listen("unix", p)
		if e != nil {
			t.Fatal(e)
		}
		l.Close()
	})
}
