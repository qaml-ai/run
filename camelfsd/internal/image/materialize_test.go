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

	first, err := m.Mount(t.Context(), coldRequest(tree, "first"))
	if err != nil {
		t.Fatal(err)
	}
	if first.Warm || first.Root != id {
		t.Fatalf("first mount = %+v", first)
	}
	requireMissing(t, filepath.Join(filepath.Dir(first.Dest), pristineImage))
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

func TestColdMountChunkOffsets(t *testing.T) {
	m, tree := unit3(t)
	disk := make([]byte, 2*root.ChunkSize+512)
	disk[0] = 17
	disk[2*root.ChunkSize] = 42
	disk[len(disk)-1] = 99
	id, _ := recordColdRoot(t, m, tree, disk)
	v, err := m.Mount(t.Context(), coldRequest(tree, "offsets"))
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{m.image(id), v.Dest} {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, disk) {
			t.Fatalf("sparse disk with partial tail differs from root at %s, read error = %v", path, err)
		}
	}
}

func TestColdMountRecoveryDiscardsUnfinishedDisk(t *testing.T) {
	m, tree := unit3(t)
	disk := make([]byte, root.ChunkSize)
	disk[0] = 42
	id, _ := recordColdRoot(t, m, tree, disk)

	// A crash before sync completes leaves a session marker and staging image.
	dir := filepath.Join(m.Data, "mounts", "interrupted")
	if err := os.Mkdir(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "session"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, pristineImage), disk[:512], 0600); err != nil {
		t.Fatal(err)
	}
	recovered, err := New(m.Config, m.Store, m.Refs)
	if err != nil {
		t.Fatal(err)
	}
	defer recovered.Close()
	requireMissing(t, dir)
	requireMissing(t, m.image(id))
}

type chunkGetHook struct {
	store.Store
	key    string
	before func() error
}

func (s chunkGetHook) Get(ctx context.Context, key string) ([]byte, error) {
	if key == s.key {
		if err := s.before(); err != nil {
			return nil, err
		}
	}
	return s.Store.Get(ctx, key)
}

func TestColdMountKeepsConcurrentPromotion(t *testing.T) {
	m, tree := unit3(t)
	disk := make([]byte, root.ChunkSize)
	disk[0] = 17
	id, r := recordColdRoot(t, m, tree, disk)

	// Publish a competing image after the mount has observed the miss.
	winner := filepath.Join(t.TempDir(), "winner.img")
	if err := os.WriteFile(winner, disk, 0600); err != nil {
		t.Fatal(err)
	}
	m.Store = chunkGetHook{Store: m.Store, key: "l/c/" + r.Chunks["0"], before: func() error {
		return os.Link(winner, m.image(id))
	}}
	v, err := m.Mount(t.Context(), coldRequest(tree, "race"))
	if err != nil {
		t.Fatal(err)
	}
	requireMissing(t, filepath.Join(filepath.Dir(v.Dest), pristineImage))
	winnerInfo, err := os.Stat(winner)
	if err != nil {
		t.Fatal(err)
	}
	promotedInfo, err := os.Stat(m.image(id))
	if err != nil || !os.SameFile(winnerInfo, promotedInfo) {
		t.Fatalf("winning image was replaced, stat error = %v", err)
	}
	sessionInfo, err := os.Stat(v.Dest)
	if err != nil || os.SameFile(winnerInfo, sessionInfo) {
		t.Fatalf("expected a separate session disk, stat error = %v", err)
	}
	got, err := os.ReadFile(v.Dest)
	if err != nil || !bytes.Equal(got, disk) {
		t.Fatalf("session disk differs from winning image, read error = %v", err)
	}
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

func TestColdMountRejectsMalformedChunkOffset(t *testing.T) {
	m, _ := unit3(t)
	m.Store = store.WithDepth(store.Local{Dir: t.TempDir()}, 2)
	hash := root.Hash(make([]byte, root.ChunkSize))
	for _, key := range []string{"abc", "-262144", "524288", "100", ""} {
		dir := filepath.Join(m.Data, "mounts", "bad-offset")
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
		v := &Mount{Request: Request{JobID: "bad-offset", Lineage: "l"}, Root: strings.Repeat("a", 64), Dest: filepath.Join(dir, "image.img")}
		r := root.Root{V: 1, FSType: "ext4", VirtualSize: 2 * root.ChunkSize, Chunks: map[string]string{key: hash}}
		if err := m.materialize(t.Context(), v, r); err == nil || !strings.Contains(err.Error(), "invalid chunk offset") {
			t.Fatalf("key %q: materialize error = %v", key, err)
		}
		requireMissing(t, filepath.Join(dir, pristineImage))
		requireMissing(t, m.image(v.Root))
		if err := os.RemoveAll(dir); err != nil {
			t.Fatal(err)
		}
	}
}
