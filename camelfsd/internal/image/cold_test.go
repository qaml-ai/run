package image

import (
	"bytes"
	"context"
	"crypto/sha256"
	"io"
	"net"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/nbd"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
)

func TestColdSwapCheckpointRelease(t *testing.T) {
	if os.Geteuid() != 0 {
		t.Skip("requires root, NBD, dm-snapshot and loop")
	}
	if _, e := run(context.Background(), "dmsetup", "version"); e != nil {
		t.Skip(e)
	}
	devices, _ := filepath.Glob("/sys/block/nbd*")
	if len(devices) == 0 {
		t.Skip("NBD module unavailable")
	}
	m, _ := unit3(t)
	l, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	defer l.Close()
	m.NBDListen = l.Addr().String()
	m.Origin = &nbd.Server{Store: m.Store, Cache: m.Cache}
	go m.Origin.Serve(l)
	data := make([]byte, 8<<20)
	copy(data, bytes.Repeat([]byte{23}, 1<<20))
	p := filepath.Join(m.Data, "source.img")
	if e = os.WriteFile(p, data, 0600); e != nil {
		t.Fatal(e)
	}
	imp, e := m.Import(context.Background(), ImportRequest{Lineage: "l", Path: p})
	if e != nil {
		t.Fatal(e)
	}
	r, e := m.load(context.Background(), "l", imp.Root)
	if e != nil {
		t.Fatal(e)
	}
	os.Remove(m.image(imp.Root))
	dir := filepath.Join(m.Data, "mounts", "cold")
	os.Mkdir(dir, 0700)
	v := &Mount{Request: Request{JobID: "cold", Lineage: "l", Root: imp.Root, Fence: &refs.Fence{Holder: "test", Epoch: 1}}, Dest: filepath.Join(dir, "image.img"), mu: new(sync.Mutex)}
	v.releaseOrigin = m.Origin.Register(v.Root, v.Lineage, r)
	if e = m.cold(context.Background(), v, r); e != nil {
		m.cleanup(v)
		v.releaseOrigin()
		os.RemoveAll(dir)
		t.Fatal(e)
	}
	m.mu.Lock()
	m.mounts[v.JobID] = v
	m.mu.Unlock()
	digest := func() [32]byte {
		f, e := os.Open(v.Image)
		if e != nil {
			t.Fatal(e)
		}
		defer f.Close()
		h := sha256.New()
		if _, e = io.Copy(h, f); e != nil {
			t.Fatal(e)
		}
		var out [32]byte
		copy(out[:], h.Sum(nil))
		return out
	}
	before := digest()
	if before != sha256.Sum256(data) {
		t.Fatal("NBD read mismatch")
	}
	// Guest writes made before hydration must survive the origin swap.
	early, e := os.OpenFile(v.Image, os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	if _, e = early.WriteAt([]byte{99}, 4096); e != nil {
		t.Fatal(e)
	}
	early.Sync()
	early.Close()
	withEarly := append([]byte(nil), data...)
	withEarly[4096] = 99
	before = sha256.Sum256(withEarly)
	v.mu.Lock()
	m.startHydration(v, r)
	v.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	v.mu.Lock()
	e = m.awaitHydration(ctx, v)
	v.mu.Unlock()
	if e != nil {
		t.Fatal(e)
	}
	if v.NBD != "" || v.State != "hydrated" || digest() != before {
		t.Fatal("swap changed bytes or retained NBD")
	}
	f, e := os.OpenFile(v.Image, os.O_RDWR, 0)
	if e != nil {
		t.Fatal(e)
	}
	for _, off := range []int64{4096, 2 << 20, 6 << 20} {
		if _, e = f.WriteAt([]byte{99}, off); e != nil {
			t.Fatal(e)
		}
	}
	f.Sync()
	f.Close()
	cp, e := m.Checkpoint(ctx, v.JobID)
	if e != nil || cp.ChangedChunks != 3 {
		t.Fatal(cp, e)
	}
	cp2, e := m.Checkpoint(ctx, v.JobID)
	if e != nil || cp2.ChangedChunks != 0 {
		t.Fatal(cp2, e)
	}
	if _, e = m.Release(ctx, v.JobID); e != nil {
		t.Fatal(e)
	}
	base, e := os.ReadFile(m.image(imp.Root))
	if e != nil || !bytes.Equal(base, data) {
		t.Fatal("base promotion", e)
	}
	for _, off := range []int{4096, 2 << 20, 6 << 20} {
		data[off] = 99
	}
	promoted, e := os.ReadFile(m.image(cp.Root))
	if e != nil || !bytes.Equal(promoted, data) {
		t.Fatal("checkpoint promotion", e)
	}
}
