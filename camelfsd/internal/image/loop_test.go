package image

import (
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/testguest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	if e := testguest.Apply(strings.TrimSuffix(v.streams.paths[0], "_5200"), v.JobID, dir, idx); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(dir, "hello"), []byte("loop world"), 0644); e != nil {
		t.Fatal(e)
	}
	guest := make(chan error, 1)
	go func() {
		guest <- testguest.Checkpoint(strings.TrimSuffix(v.streams.paths[0], "_5200"), v.JobID, dir, idx)
	}()
	cp, e := m.SessionCheckpoint(t.Context(), v.JobID, CheckpointRequest{TimeoutMs: 5000}, acceptCheckpoint)
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

// Run at the parent commit and this commit on the same loop-capable host.
// testguest prints freeze_window_ms through ack and thaw, not just the trailer.
func TestLoopFreeze5000(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("loop mount requires root")
	}
	m, tree := unit3(t)
	m.VirtualSize = 128 << 20
	if e := blank(m.Config); e != nil {
		t.Fatal(e)
	}
	v := mount3(t, m, tree, "freeze5000")
	dir := t.TempDir()
	if b, e := exec.Command("mount", "-o", "loop", v.Image, dir).CombinedOutput(); e != nil {
		t.Skipf("loop mount unavailable: %v: %s", e, b)
	}
	defer exec.Command("umount", dir).Run()
	idx := filepath.Join(t.TempDir(), "idx.json")
	if e := testguest.Apply(strings.TrimSuffix(v.streams.paths[0], "_5200"), v.JobID, dir, idx); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 5000; i++ {
		if e := os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%05d", i)), []byte("base"), 0644); e != nil {
			t.Fatal(e)
		}
	}
	for generation := 0; generation < 2; generation++ {
		if generation == 1 {
			for i := 0; i < 3; i++ {
				os.WriteFile(filepath.Join(dir, fmt.Sprintf("f%05d", i)), []byte("edit"), 0644)
			}
		}
		done := make(chan error, 1)
		go func() {
			done <- testguest.Checkpoint(strings.TrimSuffix(v.streams.paths[0], "_5200"), v.JobID, dir, idx)
		}()
		cp, e := m.SessionCheckpoint(t.Context(), v.JobID, CheckpointRequest{TimeoutMs: 30000}, acceptCheckpoint)
		if e != nil {
			t.Fatal(e)
		}
		if e = <-done; e != nil {
			t.Fatal(e)
		}
		if e = testguest.Run([]string{"checkpointed", "--index", idx, "--tree", cp.Tree}); e != nil {
			t.Fatal(e)
		}
		if generation == 1 && cp.FilesChanged != 3 {
			t.Fatal(cp)
		}
		t.Logf("generation=%d files=%d trailerFreezeMs=%.3f", generation, cp.FilesChanged, cp.FreezeMs)
	}
}
