//go:build kvm && camelfs_medium_bundles

package image

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
)

func TestApplyMediumBundlesExceedInflightBudget(t *testing.T) {
	const members = 8
	const packs = 34
	const size = 1 << 20
	ctx, cancel := context.WithTimeout(t.Context(), 30*time.Second)
	defer cancel()
	dir := t.TempDir()
	entries := make(map[string]objects.Entry, members*packs)
	locations := make(map[string]store.BundleRef, members*packs)
	physical := make(map[string]string, packs)
	expected := make(map[string]string, members*packs)
	paths := make([][]string, packs)
	for pack := range packs {
		name := filepath.Join(dir, fmt.Sprintf("pack-%d", pack))
		file, err := os.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		packHash := sha256.New()
		for member := range members {
			index := pack*members + member
			raw := bytes.Repeat([]byte{byte(index)}, size)
			binary.LittleEndian.PutUint32(raw, uint32(index))
			path := fmt.Sprintf("file-%03d", index)
			id := store.GitHash("blob", raw)
			entries[path] = objects.Entry{SHA1: id, Size: size}
			expected[path] = root.Hash(raw)
			locations[id] = store.BundleRef{SHA256: expected[path], Offset: int64(member * size), Size: size, PackSize: members * size}
			paths[pack] = append(paths[pack], path)
			if _, err := io.MultiWriter(file, packHash).Write(raw); err != nil {
				t.Fatal(err)
			}
		}
		if err := file.Close(); err != nil {
			t.Fatal(err)
		}
		key := "p/" + hex.EncodeToString(packHash.Sum(nil))
		physical["l/"+key] = name
		for _, path := range paths[pack] {
			id := entries[path].SHA1
			ref := locations[id]
			ref.Key = key
			locations[id] = ref
		}
	}
	// Interleave members from every pack so the ordered stream must move
	// through multiple byte reservations and revisit packs between windows.
	var ops []wire.Op
	for member := range members {
		for pack := range packs {
			ops = append(ops, wire.Op{Path: paths[pack][member], Op: "put", Mode: "100644", Size: size})
		}
	}
	var opened atomic.Int64
	source := store.ForLineage(applyStoreStub{open: func(_ context.Context, key string) (io.ReadCloser, error) {
		opened.Add(1)
		return os.Open(physical[key])
	}}, "l")
	reader, writer := io.Pipe()
	defer reader.Close()
	var reads applyReads
	done := make(chan error, 1)
	go func() {
		err := sendApplyWindows(ctx, writer, source, entries, ops, locations, applyInflightBytes, &reads)
		writer.CloseWithError(err)
		done <- err
	}()
	for _, want := range ops {
		var got wire.Op
		if err := wire.JSON(reader, &got); err != nil || got != want {
			t.Fatalf("ordered op = %+v, %v, want %+v", got, err, want)
		}
		raw, err := wire.Read(reader, wire.DataMax)
		if err != nil || len(raw) != size || root.Hash(raw) != expected[want.Path] {
			t.Fatalf("member %s = %d bytes, %v", want.Path, len(raw), err)
		}
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if opened.Load() <= packs || reads.packs+reads.ranges != int(opened.Load()) || reads.bytes <= applyInflightBytes {
		t.Fatalf("multi-window reads = %d opens, %+v", opened.Load(), reads)
	}
	t.Logf("restored_bytes=%d pack_gets=%d range_gets=%d fetched_bytes=%d", len(ops)*size, reads.packs, reads.ranges, reads.bytes)
}
