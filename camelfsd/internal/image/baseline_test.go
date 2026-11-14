package image

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/testguest"
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
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
	for _, name := range []string{"boot", "unchanged checkpoint", "stop before publish"} {
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
			if name == "unchanged checkpoint" {
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
				m.baselineWork.Wait()
			} else {
				publish, _ := m.SessionBaseline(t.Context(), v.JobID, guest)
				if publish == nil {
					t.Fatal("baseline snapshot missing")
				}
				if _, err := m.Refs.TreeRoot("l", tree.Tree); err == nil {
					t.Fatal("capture published a root")
				}
				if name == "stop before publish" {
					m.BaselineDiskMax = m.VirtualSize
					otherPending := baselineMount(t, m, tree.Tree, "over-cap")
					if !m.NeedsBaseline(otherPending.JobID) {
						t.Fatal("expected a missing baseline before checking the cap")
					}
					second, discard := m.SessionBaseline(t.Context(), otherPending.JobID, func(context.Context) error {
						t.Error("guest was asked to freeze while the baseline budget was full")
						return errors.New("unexpected freeze")
					})
					if discard != nil {
						discard()
					}
					if second != nil {
						t.Error("accepted another snapshot beyond disk cap")
					}
					// The first exec can run after capture. Hold the single
					// publisher slot across the subsequent stop so release
					// wins the race and deletes the mount before publication.
					m.baselineSlot <- struct{}{}
					done := make(chan struct{})
					go func() { defer close(done); publish() }()
					_, err := m.Release(t.Context(), v.JobID)
					<-m.baselineSlot
					<-done
					if err != nil {
						t.Fatal(err)
					}
					if _, err := os.Stat(v.Image); !errors.Is(err, os.ErrNotExist) {
						t.Fatalf("released mount image still present: %v", err)
					}
					if _, err := os.Stat(filepath.Join(filepath.Dir(v.Image), "state.json")); !errors.Is(err, os.ErrNotExist) {
						t.Fatalf("baseline recreated released mount state: %v", err)
					}
				} else {
					publish()
				}
			}
			if files, err := os.ReadDir(m.baselineDir()); err != nil || len(files) != 0 {
				t.Fatalf("baseline leftovers: %v %v", files, err)
			}
			id, err := m.Refs.TreeRoot("l", tree.Tree)
			if err != nil {
				t.Fatal(err)
			}
			if name != "stop before publish" {
				current, err := m.Status(t.Context(), v.JobID)
				if err != nil || current.Root != id {
					t.Fatalf("mount base was not updated: %+v %v", current, err)
				}
			}
			assertNoBaseline := func(manager *Manager, id string) {
				t.Helper()
				publish, discard := manager.SessionBaseline(t.Context(), id, func(context.Context) error {
					t.Error("exact-root mount requested a guest freeze")
					return errors.New("unexpected freeze")
				})
				if discard != nil {
					discard()
				}
				if publish != nil || manager.NeedsBaseline(id) {
					t.Fatal("exact-root mount needs a baseline")
				}
			}
			warm := baselineMount(t, m, tree.Tree, "second")
			if !warm.Warm || warm.State != "warm" || warm.Apply != nil || warm.Root != id {
				t.Fatalf("expected exact warm mount: %+v", warm)
			}
			assertNoBaseline(m, warm.JobID)
			out, err := exec.Command("debugfs", "-R", "dump /hello "+filepath.Join(dir, "restored"), warm.Image).CombinedOutput()
			if err != nil {
				t.Fatalf("debugfs: %v %s", err, out)
			}
			if got, err := os.ReadFile(filepath.Join(dir, "restored")); err != nil || !bytes.Equal(got, content) {
				t.Fatalf("warm image contents %q: %v", got, err)
			}
			otherData := t.TempDir()
			db, err := refs.Open(filepath.Join(otherData, "refs.db"))
			if err != nil {
				t.Fatal(err)
			}
			defer db.Close()
			shared := m.Store.(*store.Uploaded).Store
			other, err := New(Config{Data: otherData, VirtualSize: m.VirtualSize}, shared, cache.New(filepath.Join(otherData, "cache"), shared, 64), db)
			if err != nil {
				t.Fatal(err)
			}
			defer other.Close()
			cold := baselineMount(t, other, tree.Tree, "other")
			if cold.Warm || cold.State != "hydrated" || cold.Apply != nil || cold.Root != id {
				t.Fatalf("expected exact shared root materialization: %+v", cold)
			}
			assertNoBaseline(other, cold.JobID)
			out, err = exec.Command("debugfs", "-R", "dump /hello "+filepath.Join(dir, "shared"), cold.Image).CombinedOutput()
			if err != nil {
				t.Fatalf("debugfs: %v %s", err, out)
			}
			if got, err := os.ReadFile(filepath.Join(dir, "shared")); err != nil || !bytes.Equal(got, content) {
				t.Fatalf("shared image contents %q: %v", got, err)
			}
			var commits int
			if err := m.objects().DB.DB.QueryRow("SELECT count(*) FROM lineage_objects WHERE kind='commit'").Scan(&commits); err != nil || commits != 0 {
				t.Fatalf("baseline wrote %d commits: %v", commits, err)
			}
		})
	}
}

func TestBaselineDiskCapAndRecovery(t *testing.T) {
	m, tree := unit3(t)
	m.BaselineDiskMax = m.VirtualSize
	v := baselineMount(t, m, tree, "first")
	snap, err := m.reserveBaseline(v)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := m.reserveBaseline(v); err == nil {
		m.discardBaseline(second)
		t.Error("accepted another snapshot beyond disk cap")
	}
	m.discardBaseline(snap)
	snap, err = m.reserveBaseline(v)
	if err != nil {
		t.Fatal(err)
	}
	defer m.discardBaseline(snap)
	if err := clone(v.Dest, snap.path()); err != nil {
		t.Fatal(err)
	}
	// Leave a complete intent just before promotion, plus an unrelated
	// incomplete capture. Startup must publish one and discard the other.
	base, err := m.mountRoot(t.Context(), "l", "")
	if err != nil {
		t.Fatal(err)
	}
	var point Checkpoint
	if _, err := m.uploadSnapshot(t.Context(), v.Request, base, snap.path(), tree,
		[]chunk.Range{{Length: base.VirtualSize}}, &point); err != nil {
		t.Fatal(err)
	}
	body, err := json.Marshal(baselineRecord{"l", tree, point.Root})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Atomic(filepath.Join(snap.dir, baselineIntent), body); err != nil {
		t.Fatal(err)
	}
	if err := store.Atomic(filepath.Join(m.baselineDir(), "partial", "image.img"), []byte("partial")); err != nil {
		t.Fatal(err)
	}
	if err := m.recoverBaselines(); err != nil {
		t.Fatal(err)
	}
	warm := baselineMount(t, m, tree, "recovered")
	if !warm.Warm || warm.Root != point.Root {
		t.Fatalf("complete baseline not recovered: %+v", warm)
	}
	if files, err := os.ReadDir(m.baselineDir()); err != nil || len(files) != 0 {
		t.Fatalf("baseline leftovers: %v %v", files, err)
	}
}

func TestSessionBaselineFreezeTimeout(t *testing.T) {
	m, parent := unit3(t)
	content := []byte("file")
	sha := fmtHash(content)
	if _, err := m.objects("l").Upload(t.Context(), "l", sha, int64(len(content)), bytes.NewReader(content)); err != nil {
		t.Fatal(err)
	}
	tree, err := m.objects("l").Import(t.Context(), objects.Request{Lineage: "l", ParentTree: parent,
		Files: map[string]objects.File{"hello": {SHA256: sha}}})
	if err != nil {
		t.Fatal(err)
	}
	v := baselineMount(t, m, tree.Tree, "slow-freeze")
	var logs bytes.Buffer
	previous := slog.Default()
	slog.SetDefault(slog.New(slog.NewTextHandler(&logs, nil)))
	defer slog.SetDefault(previous)
	publish, discard := m.SessionBaseline(t.Context(), v.JobID, func(ctx context.Context) error {
		c, err := (&net.Dialer{}).DialContext(ctx, "unix", v.Vsock+"_5200")
		if err != nil {
			return err
		}
		defer c.Close()
		var ready struct{ Ready bool }
		if err := wire.JSON(c, &ready); err != nil {
			return err
		}
		if !ready.Ready {
			return errors.New("guest did not get ready")
		}
		<-ctx.Done()
		return ctx.Err()
	})
	if discard != nil {
		discard()
	}
	if publish != nil || !strings.Contains(logs.String(), "baseline timed out waiting for workspace freeze") {
		t.Fatalf("unexpected baseline outcome: %s", logs.String())
	}
	if !m.NeedsBaseline(v.JobID) {
		t.Fatal("timed-out capture must leave the unchanged checkpoint fallback eligible")
	}
	if files, err := os.ReadDir(m.baselineDir()); err != nil || len(files) != 0 {
		t.Fatalf("baseline leftovers: %v %v", files, err)
	}
}
