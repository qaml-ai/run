package fuseoverlay

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

func buildReq(opcode uint32, unique, nodeid uint64, payload []byte) []byte {
	pkt := make([]byte, fuseInHeaderSize+len(payload))
	le := binary.LittleEndian
	le.PutUint32(pkt[0:4], uint32(len(pkt)))
	le.PutUint32(pkt[4:8], opcode)
	le.PutUint64(pkt[8:16], unique)
	le.PutUint64(pkt[16:24], nodeid)
	copy(pkt[fuseInHeaderSize:], payload)
	return pkt
}

func replyErr(pkt []byte) int32 {
	return int32(binary.LittleEndian.Uint32(pkt[4:8]))
}

type memStore struct {
	rtt   time.Duration
	mu    sync.RWMutex
	blobs map[string][]byte
	rpcs  atomic.Int64
	bytes atomic.Int64
}

func (s *memStore) put(b []byte) string {
	sum := sha256.Sum256(b)
	h := hex.EncodeToString(sum[:])
	s.mu.Lock()
	s.blobs[h] = append([]byte(nil), b...)
	s.mu.Unlock()
	return h
}

func (s *memStore) FetchBlob(_ context.Context, h string) ([]byte, error) {
	if s.rtt > 0 {
		time.Sleep(s.rtt)
	}
	s.mu.RLock()
	d, ok := s.blobs[h]
	s.mu.RUnlock()
	if !ok {
		return nil, os.ErrNotExist
	}
	s.rpcs.Add(1)
	s.bytes.Add(int64(len(d)))
	return d, nil
}

func TestWireMetadataZeroRPCAndLazySingleFlightRead(t *testing.T) {
	store := &memStore{rtt: 5 * time.Millisecond, blobs: map[string][]byte{}}
	helloHash := store.put([]byte("hello lazy world\n"))
	bigPayload := bytes.Repeat([]byte("abc123"), 4096)
	bigHash := store.put(bigPayload)

	manifest := []TreeEntry{
		{Path: "README.md", Mode: S_IFREG | 0o644, Size: 17, BlobHash: helloHash},
		{Path: "src/app.bin", Mode: S_IFREG | 0o755, Size: uint64(len(bigPayload)), BlobHash: bigHash},
		{Path: "latest", Mode: S_IFLNK | 0o777, Size: 9, LinkTarget: "README.md"},
	}

	srv := NewReadOnlyFuseServer(manifest, store, ServerConfig{})
	ctx := context.Background()

	initBody := make([]byte, 16)
	binary.LittleEndian.PutUint32(initBody[0:4], fuseKernelVersion)
	binary.LittleEndian.PutUint32(initBody[4:8], fuseKernelMinorVersion)
	binary.LittleEndian.PutUint32(initBody[8:12], 128*1024)
	binary.LittleEndian.PutUint32(initBody[12:16], capAsyncRead|capDoReaddirplus|capNoOpenSupport|capCacheSymlinks|capParallelDirops)
	initRep := srv.HandlePacket(ctx, buildReq(opInit, 1, 0, initBody))
	if got := replyErr(initRep); got != 0 {
		t.Fatalf("FUSE_INIT errno = %d", got)
	}
	negFlags := binary.LittleEndian.Uint32(initRep[fuseOutHeaderSize+12 : fuseOutHeaderSize+16])
	if negFlags&capNoOpenSupport == 0 || negFlags&capDoReaddirplus == 0 {
		t.Fatalf("expected FUSE_NO_OPEN_SUPPORT and DO_READDIRPLUS in flags %#x", negFlags)
	}

	lkRep := srv.HandlePacket(ctx, buildReq(opLookup, 2, fuseRootID, []byte("src\x00")))
	srcIno := binary.LittleEndian.Uint64(lkRep[fuseOutHeaderSize : fuseOutHeaderSize+8])
	lkApp := srv.HandlePacket(ctx, buildReq(opLookup, 3, srcIno, []byte("app.bin\x00")))
	appIno := binary.LittleEndian.Uint64(lkApp[fuseOutHeaderSize : fuseOutHeaderSize+8])

	lkSym := srv.HandlePacket(ctx, buildReq(opLookup, 4, fuseRootID, []byte("latest\x00")))
	symIno := binary.LittleEndian.Uint64(lkSym[fuseOutHeaderSize : fuseOutHeaderSize+8])
	symRep := srv.HandlePacket(ctx, buildReq(opReadlink, 5, symIno, nil))
	if string(symRep[fuseOutHeaderSize:]) != "README.md" {
		t.Fatalf("readlink = %q, want README.md", symRep[fuseOutHeaderSize:])
	}

	gxRep := srv.HandlePacket(ctx, buildReq(opGetxattr, 6, appIno, []byte("trusted.overlay.opaque\x00")))
	if replyErr(gxRep) != -int32(unix.ENODATA) {
		t.Fatalf("getxattr errno = %d, want -ENODATA", replyErr(gxRep))
	}

	rdBody := make([]byte, 24)
	binary.LittleEndian.PutUint32(rdBody[16:20], 4096)
	rdRep := srv.HandlePacket(ctx, buildReq(opReaddirplus, 7, fuseRootID, rdBody))
	if replyErr(rdRep) != 0 || len(rdRep) <= fuseOutHeaderSize {
		t.Fatalf("readdirplus failed: errno=%d len=%d", replyErr(rdRep), len(rdRep))
	}

	if store.rpcs.Load() != 0 {
		t.Fatalf("expected 0 blob RPCs after metadata-only ops, got %d", store.rpcs.Load())
	}

	readBody := make([]byte, 24)
	binary.LittleEndian.PutUint32(readBody[16:20], uint32(len(bigPayload)))
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(u uint64) {
			defer wg.Done()
			r := srv.HandlePacket(ctx, buildReq(opRead, u, appIno, readBody))
			if replyErr(r) != 0 || !bytes.Equal(r[fuseOutHeaderSize:], bigPayload) {
				t.Errorf("read %d mismatch/err=%d len=%d", u, replyErr(r), len(r))
			}
		}(uint64(100 + i))
	}
	wg.Wait()

	if store.rpcs.Load() != 1 || store.bytes.Load() != int64(len(bigPayload)) {
		t.Fatalf("expected 1 single-flight RPC of %d bytes, got rpcs=%d bytes=%d", len(bigPayload), store.rpcs.Load(), store.bytes.Load())
	}
}

func TestIncrementalDeltaTrackerAndWhiteouts(t *testing.T) {
	upper := t.TempDir()
	basePaths := []string{
		"base.txt",
		"replaced_dir/old_a.txt",
		"replaced_dir/sub/old_b.txt",
	}
	inspect := &UpperInspect{
		IsWhiteout: func(fp string, _ fs.FileInfo) bool {
			return filepath.Base(fp) == "base.txt.wh"
		},
		IsOpaque: func(fp string) bool {
			return filepath.Base(fp) == "replaced_dir"
		},
	}

	tracker := NewDeltaTracker(upper, basePaths, inspect)

	// Exec 1: create session.txt, executable run.sh, and whiteout + opaque dir replacement.
	if err := os.WriteFile(filepath.Join(upper, "session.txt"), []byte("v1"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(upper, "run.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(upper, "base.txt.wh"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(upper, "replaced_dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(upper, "replaced_dir", "fresh.txt"), []byte("fresh"), 0o644); err != nil {
		t.Fatal(err)
	}

	d1, err := tracker.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(d1.Puts) != 3 || len(d1.Deletes) != 3 {
		t.Fatalf("exec1 delta mismatch: puts=%+v deletes=%v", d1.Puts, d1.Deletes)
	}

	// Exec 2 with no mutations must emit empty delta.
	d2, err := tracker.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(d2.Puts) != 0 || len(d2.Deletes) != 0 {
		t.Fatalf("expected empty no-op delta, got puts=%+v deletes=%v", d2.Puts, d2.Deletes)
	}

	// Exec 3 deletes session.txt (vanishes from upperDir without whiteout) and edits run.sh -> emits both.
	if err := os.Remove(filepath.Join(upper, "session.txt")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(upper, "run.sh"), []byte("#!/bin/sh\necho hi\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	d3, err := tracker.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(d3.Puts) != 1 || d3.Puts[0].Path != "run.sh" {
		t.Fatalf("expected only run.sh put, got %+v", d3.Puts)
	}
	if len(d3.Deletes) != 1 || d3.Deletes[0] != "session.txt" {
		t.Fatalf("expected session.txt delete, got %v", d3.Deletes)
	}
	_ = fmt.Sprint(d3)
}

func TestDeltaTrackerSyncOpsPreservesUncommittedGuestEdits(t *testing.T) {
	upper := t.TempDir()
	tracker := NewDeltaTracker(upper, []string{"base.txt"}, &UpperInspect{
		IsWhiteout: func(fp string, _ fs.FileInfo) bool {
			return filepath.Base(fp) == "base.txt.wh"
		},
	})

	// Uncommitted guest file (e.g. from commit.skip=true) already sitting in upperDir.
	if err := os.WriteFile(filepath.Join(upper, "guest_uncommitted.txt"), []byte("keep-me"), 0o644); err != nil {
		t.Fatal(err)
	}

	// Host-driven API write creates api_written.txt and deletes base.txt via SyncOps.
	if err := os.WriteFile(filepath.Join(upper, "api_written.txt"), []byte("from-api"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(upper, "base.txt.wh"), nil, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := tracker.SyncOps([]SyncOp{
		{Kind: "put", Path: "api_written.txt"},
		{Kind: "delete", Path: "base.txt.wh"},
	}); err != nil {
		t.Fatal(err)
	}

	// Subsequent Collect must omit api_written.txt and base.txt.wh, while preserving guest_uncommitted.txt.
	d, err := tracker.Collect()
	if err != nil {
		t.Fatal(err)
	}
	if len(d.Puts) != 1 || d.Puts[0].Path != "guest_uncommitted.txt" || len(d.Deletes) != 0 {
		t.Fatalf("expected only guest_uncommitted.txt in delta, got puts=%+v deletes=%v", d.Puts, d.Deletes)
	}
}
