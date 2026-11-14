package image

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/testguest"
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
)

func baselineMount(t *testing.T, m *Manager, tree, job string) *Mount {
	t.Helper()
	v, err := m.Mount(t.Context(), Request{Session: true, Parent: strings.Repeat("a", 40),
		Fence: &refs.Fence{Holder: "runtime", Epoch: 1}, Lineage: "l", Tree: tree, JobID: job,
		Vsock: filepath.Join(testutil.SocketDir(t), "v")})
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func TestSessionBaseline(t *testing.T) {
	if _, err := exec.LookPath("debugfs"); err != nil {
		t.Skip("debugfs required")
	}
	for _, fallback := range []bool{false, true} {
		name := "boot"
		if fallback {
			name = "unchanged checkpoint"
		}
		t.Run(name, func(t *testing.T) {
			m, parent := unit3(t)
			content := []byte("materialized file\n")
			sha := fmtHash(content)
			_, err := m.objects("l").Upload(t.Context(), "l", sha, int64(len(content)), bytes.NewReader(content))
			if err != nil {
				t.Fatal(err)
			}
			tree, err := m.objects("l").Import(t.Context(), objects.Request{Lineage: "l", ParentTree: parent,
				Files: map[string]objects.File{"hello": {SHA256: sha}}})
			if err != nil {
				t.Fatal(err)
			}
			v := baselineMount(t, m, tree.Tree, "first")
			if v.Root != "" || v.Apply == nil || v.Apply.Files != 1 {
				t.Fatalf("expected blank mount with apply delta: %+v", v)
			}
			dir := t.TempDir()
			if err := testguest.Apply(v.Vsock, v.JobID, dir, filepath.Join(t.TempDir(), "index")); err != nil {
				t.Fatal(err)
			}
			// Populate the ext4 fixture from the applied file without a loop mount.
			if out, err := exec.Command("debugfs", "-w", "-R", "write "+filepath.Join(dir, "hello")+" /hello", v.Image).CombinedOutput(); err != nil {
				t.Fatalf("debugfs: %v %s", err, out)
			}
			guest := func(context.Context) error { return testguest.Baseline(v.Vsock, v.JobID, tree.Tree) }
			if fallback {
				if !m.NeedsBaseline(v.JobID) {
					t.Fatal("missing baseline was not detected")
				}
				done := make(chan error, 1)
				go func() { done <- guest(t.Context()) }()
				_, err := m.SessionCheckpoint(t.Context(), v.JobID, true, CheckpointRequest{}, func(context.Context, Checkpoint) error {
					t.Error("unchanged checkpoint attempted CAS")
					return nil
				})
				if err != nil {
					t.Fatal(err)
				}
				if err := <-done; err != nil {
					t.Fatal(err)
				}
			} else {
				publish, _ := m.SessionBaseline(t.Context(), v.JobID, guest)
				if publish == nil {
					t.Fatal("baseline snapshot missing")
				}
				if _, err := m.Refs.TreeRoot("l", tree.Tree); err == nil {
					t.Fatal("capture published a root")
				}
				publish()
			}
			id, err := m.Refs.TreeRoot("l", tree.Tree)
			if err != nil {
				t.Fatal(err)
			}
			current, err := m.Status(t.Context(), v.JobID)
			if err != nil || current.Root != id {
				t.Fatalf("mount base was not updated: %+v %v", current, err)
			}
			warm := baselineMount(t, m, tree.Tree, "second")
			if !warm.Warm || warm.State != "warm" || warm.Apply != nil || warm.Root != id {
				t.Fatalf("expected exact warm mount: %+v", warm)
			}
			out, err := exec.Command("debugfs", "-R", "dump /hello "+filepath.Join(dir, "restored"), warm.Image).CombinedOutput()
			if err != nil {
				t.Fatalf("debugfs: %v %s", err, out)
			}
			if got, err := os.ReadFile(filepath.Join(dir, "restored")); err != nil || !bytes.Equal(got, content) {
				t.Fatalf("warm image contents %q: %v", got, err)
			}
			var commits int
			if err := m.objects().DB.DB.QueryRow("SELECT count(*) FROM lineage_objects WHERE kind='commit'").Scan(&commits); err != nil || commits != 0 {
				t.Fatalf("baseline wrote %d commits: %v", commits, err)
			}
		})
	}
}
