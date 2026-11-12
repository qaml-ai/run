package testguest

import (
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
	"net"
	"os"
	"path/filepath"
	"testing"
)

func TestApplyRefusesSymlinkParent(t *testing.T) {
	vsock := filepath.Join(testutil.SocketDir(t), "v")
	l, e := net.Listen("unix", vsock+"_5201")
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	mount, outside := t.TempDir(), t.TempDir()
	if e = os.Symlink(outside, filepath.Join(mount, "parent")); e != nil {
		t.Fatal(e)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		c, e := l.Accept()
		if e != nil {
			return
		}
		defer c.Close()
		wire.Send(c, wire.Header{V: 1, Kind: "apply", JobID: "j"})
		wire.Send(c, map[string]any{"indexEnd": true, "count": 0})
		wire.Send(c, wire.Op{Path: "parent/escape", Op: "put", Mode: "100644"})
		wire.Send(c, wire.Op{End: true, Files: 1})
	}()
	if e = Apply(vsock, "j", mount, ""); e == nil {
		t.Fatal("followed parent symlink")
	}
	<-done
	if _, e = os.Stat(filepath.Join(outside, "escape")); !os.IsNotExist(e) {
		t.Fatal("escaped mount")
	}
}
func TestCheckpointRefusesPlainDirectory(t *testing.T) {
	if e := Checkpoint("missing", "j", t.TempDir(), "missing"); e == nil {
		t.Fatal("froze plain directory")
	}
}

func TestApplyDirectoryToFile(t *testing.T) {
	vsock := filepath.Join(testutil.SocketDir(t), "v")
	l, e := net.Listen("unix", vsock+"_5201")
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	mount := t.TempDir()
	os.Mkdir(filepath.Join(mount, "a"), 0700)
	os.WriteFile(filepath.Join(mount, "a", "b"), nil, 0600)
	done := make(chan error, 1)
	go func() {
		c, e := l.Accept()
		if e != nil {
			done <- e
			return
		}
		defer c.Close()
		wire.Send(c, wire.Header{V: 1, Kind: "apply", JobID: "j"})
		wire.Send(c, map[string]any{"indexEnd": true, "count": 0})
		wire.Send(c, wire.Op{Path: "a/b", Op: "del"})
		wire.Send(c, wire.Op{Path: "a", Op: "put", Mode: "100644", Size: 1})
		wire.Write(c, []byte("x"))
		wire.Send(c, wire.Op{End: true, Files: 2, Bytes: 1})
		var ack any
		done <- wire.JSON(c, &ack)
	}()
	if e = Apply(vsock, "j", mount, ""); e != nil {
		t.Fatal(e)
	}
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile(filepath.Join(mount, "a"))
	if e != nil || string(b) != "x" {
		t.Fatal(string(b), e)
	}
}
