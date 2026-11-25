package cfcontainer

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

type fakeBlobStore struct {
	mu      sync.RWMutex
	blobs   map[string][]byte
	fetches atomic.Int64
}

func newFakeBlobStore() *fakeBlobStore {
	return &fakeBlobStore{blobs: make(map[string][]byte)}
}

func (s *fakeBlobStore) put(data []byte) string {
	sum := sha256.Sum256(data)
	h := hex.EncodeToString(sum[:])
	s.mu.Lock()
	s.blobs[h] = append([]byte(nil), data...)
	s.mu.Unlock()
	return h
}

func (s *fakeBlobStore) FetchBlob(_ context.Context, hash string) ([]byte, error) {
	s.fetches.Add(1)
	s.mu.RLock()
	b, ok := s.blobs[hash]
	s.mu.RUnlock()
	if !ok {
		return nil, os.ErrNotExist
	}
	return append([]byte(nil), b...), nil
}

func TestUnprivilegedCowFuseMountLazyHydrationAndDelta(t *testing.T) {
	if _, err := os.Stat("/dev/fuse"); err != nil {
		t.Skipf("/dev/fuse not available: %v", err)
	}
	store := newFakeBlobStore()

	var manifest []TreeEntry
	for i := 0; i < 50; i++ {
		body := []byte(fmt.Sprintf("file content #%02d\n", i))
		h := store.put(body)
		manifest = append(manifest, TreeEntry{
			Path:     fmt.Sprintf("dir/file_%02d.txt", i),
			Type:     "file",
			Mode:     0o644,
			Size:     uint64(len(body)),
			BlobHash: h,
		})
	}
	readme := []byte("hello camelfs on cloudflare\n")
	manifest = append(manifest, TreeEntry{
		Path:     "README.md",
		Type:     "file",
		Mode:     0o644,
		Size:     uint64(len(readme)),
		BlobHash: store.put(readme),
	})

	baseDir := t.TempDir()
	stateDir := filepath.Join(baseDir, "state")
	mountDir := filepath.Join(baseDir, "workspace")

	sess, err := Mount(context.Background(), manifest, store, stateDir, mountDir)
	if err != nil {
		t.Fatalf("Mount failed: %v", err)
	}
	defer func() {
		if cErr := sess.Close(); cErr != nil {
			t.Errorf("Close failed: %v", cErr)
		}
	}()

	// 1. Walk entire 51-file tree metadata: must trigger ZERO blob fetches!
	fileCount := 0
	if err := filepath.WalkDir(mountDir, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !d.IsDir() {
			fileCount++
		}
		return nil
	}); err != nil {
		t.Fatalf("WalkDir: %v", err)
	}
	if fileCount != 51 {
		t.Fatalf("walked %d files, want 51", fileCount)
	}
	if got := store.fetches.Load(); got != 0 {
		t.Fatalf("metadata walk triggered %d blob fetches, want 0", got)
	}

	// 2. Read 1 file twice: must trigger EXACTLY 1 blob fetch!
	gotReadme, err := os.ReadFile(filepath.Join(mountDir, "README.md"))
	if err != nil {
		t.Fatalf("ReadFile README.md: %v", err)
	}
	if !bytes.Equal(gotReadme, readme) {
		t.Fatalf("README.md = %q, want %q", gotReadme, readme)
	}
	if _, err := os.ReadFile(filepath.Join(mountDir, "README.md")); err != nil {
		t.Fatalf("second ReadFile README.md: %v", err)
	}
	if got := store.fetches.Load(); got != 1 {
		t.Fatalf("after reading README.md twice, fetches = %d, want 1", got)
	}

	// 3. Copy-on-Write modify, create, chmod, unlink, rename!
	f, err := os.OpenFile(filepath.Join(mountDir, "README.md"), os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		t.Fatalf("open append README.md: %v", err)
	}
	if _, err := f.WriteString("appended line\n"); err != nil {
		t.Fatalf("append README.md: %v", err)
	}
	_ = f.Close()

	if err := os.MkdirAll(filepath.Join(mountDir, "newdir"), 0o755); err != nil {
		t.Fatalf("MkdirAll: %v", err)
	}
	if err := os.WriteFile(filepath.Join(mountDir, "newdir/script.sh"), []byte("#!/bin/sh\necho hi\n"), 0o755); err != nil {
		t.Fatalf("WriteFile script.sh: %v", err)
	}
	if err := os.Chmod(filepath.Join(mountDir, "newdir/script.sh"), 0o755); err != nil {
		t.Fatalf("Chmod: %v", err)
	}
	if err := os.Remove(filepath.Join(mountDir, "dir/file_00.txt")); err != nil {
		t.Fatalf("Remove file_00.txt: %v", err)
	}
	if err := os.Rename(filepath.Join(mountDir, "dir/file_01.txt"), filepath.Join(mountDir, "dir/renamed_01.txt")); err != nil {
		t.Fatalf("Rename file_01.txt: %v", err)
	}

	// Only README.md (already cached) + file_01.txt (for rename copy-up) should have been fetched -> 2 total!
	if got := store.fetches.Load(); got != 2 {
		t.Fatalf("expected 2 lazy blob fetches total across 51-file repo, got %d", got)
	}

	delta, err := sess.Server.CollectDelta()
	if err != nil {
		t.Fatalf("CollectDelta: %v", err)
	}
	if len(delta.Deletes) != 2 || delta.Deletes[0] != "dir/file_00.txt" || delta.Deletes[1] != "dir/file_01.txt" {
		t.Fatalf("unexpected deletes: %v", delta.Deletes)
	}
	putsByPath := map[string]DeltaPut{}
	for _, p := range delta.Puts {
		putsByPath[p.Path] = p
	}
	if len(putsByPath) != 3 {
		t.Fatalf("expected 3 puts (README.md, dir/renamed_01.txt, newdir/script.sh), got %d: %v", len(putsByPath), delta.Puts)
	}
	if !strings.Contains(string(putsByPath["README.md"].Data), "appended line") {
		t.Fatalf("README.md delta missing appended line: %q", putsByPath["README.md"].Data)
	}
	if putsByPath["newdir/script.sh"].Mode&0o111 == 0 {
		t.Fatalf("script.sh mode lost exec bit: %o", putsByPath["newdir/script.sh"].Mode)
	}

	// Second CollectDelta with no changes must be empty!
	delta2, err := sess.Server.CollectDelta()
	if err != nil {
		t.Fatalf("CollectDelta 2: %v", err)
	}
	if len(delta2.Puts) != 0 || len(delta2.Deletes) != 0 {
		t.Fatalf("expected empty second delta, got puts=%d deletes=%d", len(delta2.Puts), len(delta2.Deletes))
	}

	// 4. Live API ApplyOps must immediately appear on mount AND not emit in CollectDelta.
	if err := sess.Server.ApplyOps([]LiveOp{{
		Kind: "put",
		Path: "api_written.txt",
		Mode: 0o644,
		Data: []byte("written from worker API\n"),
	}}); err != nil {
		t.Fatalf("ApplyOps: %v", err)
	}
	apiRead, err := os.ReadFile(filepath.Join(mountDir, "api_written.txt"))
	if err != nil {
		t.Fatalf("ReadFile api_written.txt: %v", err)
	}
	if string(apiRead) != "written from worker API\n" {
		t.Fatalf("api_written.txt = %q", apiRead)
	}
	delta3, err := sess.Server.CollectDelta()
	if err != nil {
		t.Fatalf("CollectDelta 3: %v", err)
	}
	if len(delta3.Puts) != 0 || len(delta3.Deletes) != 0 {
		t.Fatalf("ApplyOps should not be re-emitted in CollectDelta: puts=%d dels=%d", len(delta3.Puts), len(delta3.Deletes))
	}
}
