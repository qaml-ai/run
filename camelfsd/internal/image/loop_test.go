package image

import (
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/testguest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestLoopGuestCycle(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("loop mount requires root")
	}
	m, tree := unit3(t)
	v := mount3(t, m, tree, "loop")
	dir := t.TempDir()
	if b, e := exec.Command("mount", "-o", "loop", v.Image, dir).CombinedOutput(); e != nil {
		t.Skipf("loop mount unavailable: %v: %s", e, b)
	}
	defer func() {
		if b, e := exec.Command("umount", dir).CombinedOutput(); e != nil {
			t.Errorf("umount: %v %s", e, b)
		}
	}()
	idx := filepath.Join(t.TempDir(), "idx.json")
	if e := testguest.Apply(v.Vsock, v.JobID, dir, idx); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(dir, "hello"), []byte("loop world"), 0644); e != nil {
		t.Fatal(e)
	}
	guest := make(chan error, 1)
	go func() { guest <- testguest.Checkpoint(v.Vsock, v.JobID, dir, idx) }()
	cp, e := m.StreamCheckpoint(context.Background(), v.JobID, 5000, CheckpointRequest{})
	if e != nil {
		t.Fatal(e)
	}
	if e = <-guest; e != nil {
		t.Fatal(e)
	}
	if cp.FilesChanged != 1 || cp.Tree == tree {
		t.Fatal(cp)
	}
	if e = testguest.Run([]string{"checkpointed", "--index", idx, "--tree", cp.Tree}); e != nil {
		t.Fatal(e)
	}
}
