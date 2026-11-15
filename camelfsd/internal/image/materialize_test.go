package image

import (
	"bytes"
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func recordColdRoot(t *testing.T, m *Manager, tree string, disk []byte) (string, root.Root) {
	t.Helper()
	r := root.Root{V: 1, Tree: tree, FSType: "ext4", VirtualSize: int64(len(disk)), Chunks: map[string]string{}}
	s := store.ForLineage(m.Store, "l")
	for off := int64(0); off < r.VirtualSize; off += root.ChunkSize {
		b := make([]byte, root.ChunkSize)
		copy(b, disk[off:])
		if bytes.Count(b, []byte{0}) == len(b) {
			continue
		}
		hash := root.Hash(b)
		if err := s.Put(t.Context(), "c/"+hash, b); err != nil {
			t.Fatal(err)
		}
		r.Chunks[strconv.FormatInt(off, 10)] = hash
	}
	raw, err := root.Encode(r)
	if err != nil {
		t.Fatal(err)
	}
	id := root.Hash(raw)
	if err := s.Put(t.Context(), "r/"+id, raw); err != nil {
		t.Fatal(err)
	}
	if err := m.Refs.RecordTree("l", tree, id); err != nil {
		t.Fatal(err)
	}
	return id, r
}

func coldRequest(tree, job string) Request {
	return Request{JobID: job, Tree: tree, Lineage: "l", Parent: strings.Repeat("a", 40),
		Fence: &refs.Fence{Holder: "runtime", Epoch: 1}}
}

func requireMissing(t *testing.T, path string) {
	t.Helper()
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("want %s absent, stat error = %v", path, err)
	}
}

func TestColdMountPromotesPristineDisk(t *testing.T) {
	if _, err := exec.LookPath("debugfs"); err != nil {
		t.Skip("debugfs required")
	}
	m, tree := unit3(t)
	blank := filepath.Join(m.Data, "images", "blank-"+strconv.FormatInt(m.VirtualSize, 10)+".img")
	disk, err := os.ReadFile(blank)
	if err != nil {
		t.Fatal(err)
	}
	id, _ := recordColdRoot(t, m, tree, disk)

	entered, resume := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() { close(resume) })
	m.syncRoot = func(f *os.File) error {
		close(entered)
		<-resume
		return f.Sync()
	}
	first, err := m.Mount(t.Context(), coldRequest(tree, "first"))
	if err != nil {
		t.Fatal(err)
	}
	<-entered
	if first.Warm || first.Root != id {
		t.Fatalf("first mount = %+v", first)
	}
	requireMissing(t, m.image(id))
	got, err := os.ReadFile(first.Dest)
	if err != nil || !bytes.Equal(got, disk) {
		t.Fatalf("cold disk differs from root, read error = %v", err)
	}
	payload := filepath.Join(t.TempDir(), "payload")
	if err := os.WriteFile(payload, []byte("private to the first session\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if out, err := exec.Command("debugfs", "-w", "-R", "write "+payload+" /private", first.Dest).CombinedOutput(); err != nil || !bytes.Contains(out, []byte("Allocated inode:")) {
		t.Fatalf("write first session: %v\n%s", err, out)
	}

	resume <- struct{}{}
	<-first.promotionDone
	requireMissing(t, filepath.Join(filepath.Dir(first.Dest), pristineImage))
	second, err := m.Mount(t.Context(), coldRequest(tree, "second"))
	if err != nil {
		t.Fatal(err)
	}
	if !second.Warm || second.Root != id {
		t.Fatalf("second mount = %+v", second)
	}
	for _, path := range []string{m.image(id), second.Dest} {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, disk) {
			t.Fatalf("%s differs from pristine root, read error = %v", path, err)
		}
	}
}

func TestColdMountRecoveryDiscardsUnfinishedDisk(t *testing.T) {
	m, tree := unit3(t)
	disk := make([]byte, root.ChunkSize+512)
	disk[root.ChunkSize] = 42
	id, _ := recordColdRoot(t, m, tree, disk)

	entered, resume := make(chan struct{}), make(chan struct{})
	t.Cleanup(func() { close(resume) })
	m.syncRoot = func(*os.File) error {
		close(entered)
		<-resume
		return errors.New("injected sync failure")
	}
	v, err := m.Mount(t.Context(), coldRequest(tree, "old-boot"))
	if err != nil {
		t.Fatal(err)
	}
	<-entered
	requireMissing(t, m.image(id))
	got, err := os.ReadFile(v.Dest)
	if err != nil || !bytes.Equal(got, disk) {
		t.Fatalf("sparse disk with partial tail differs from root, read error = %v", err)
	}
	stage := filepath.Join(filepath.Dir(v.Dest), pristineImage)
	if _, err := os.Stat(stage); err != nil {
		t.Fatal(err)
	}

	// Reopen against the disk state left by a crash while the sync is pending.
	recovered, err := New(m.Config, m.Store, m.Refs)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	requireMissing(t, stage)
	requireMissing(t, m.image(id))
	// Old-boot sessions are released by computehost after registration fences them.
	if _, err := recovered.Release(context.Background(), v.JobID); err != nil {
		t.Fatal(err)
	}
	requireMissing(t, filepath.Dir(v.Dest))

	resume <- struct{}{}
	<-v.promotionDone
	requireMissing(t, m.image(id))
}

func TestColdMountRejectsCorruptChunk(t *testing.T) {
	for _, tc := range []struct {
		name string
		size int
	}{
		{"hash", int(root.ChunkSize)},
		{"size", 512},
	} {
		t.Run(tc.name, func(t *testing.T) {
			m, tree := unit3(t)
			local := store.Local{Dir: t.TempDir()}
			m.Store = store.WithDepth(local, 2)
			disk := make([]byte, root.ChunkSize)
			disk[0] = 1
			id, r := recordColdRoot(t, m, tree, disk)
			hash := r.Chunks["0"]
			if err := os.WriteFile(filepath.Join(local.Dir, "l", "c", hash), make([]byte, tc.size), 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := m.Mount(t.Context(), coldRequest(tree, "corrupt")); err == nil || !strings.Contains(err.Error(), "chunk "+hash+": size or hash mismatch") {
				t.Fatalf("mount error = %v", err)
			}
			requireMissing(t, m.image(id))
			requireMissing(t, filepath.Join(m.Data, "mounts", "corrupt"))
		})
	}
}
