package cache

import (
	"bytes"
	"context"
	"os"
	"runtime"
	"sync/atomic"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"golang.org/x/sys/unix"
)

func TestHydrationWriteAndDemandFlight(t *testing.T) {
	for _, fallback := range []bool{false, true} {
		t.Run(map[bool]string{false: "clone", true: "fallback"}[fallback], func(t *testing.T) {
			s := &counted{b: make([]byte, root.ChunkSize), gate: make(chan struct{})}
			s.b[0] = 71
			c := New(t.TempDir(), s, 4)
			defer c.Close()
			var writes atomic.Int32
			original := c.writeAt
			c.writeAt = func(f *os.File, b []byte, off int64) (int, error) { writes.Add(1); return original(f, b, off) }
			atomicWrite := c.atomic
			c.atomic = func(p string, b []byte) error { writes.Add(1); return atomicWrite(p, b) }
			entered := make(chan struct{})
			c.cloneRange = func(dst, src *os.File, off int64) error {
				close(entered)
				if fallback {
					return unix.EOPNOTSUPP
				}
				// Model the ioctl without counting it as a data write.
				b := make([]byte, root.ChunkSize)
				if _, e := src.ReadAt(b, off); e != nil {
					return e
				}
				_, e := dst.Write(b)
				return e
			}
			f, e := os.CreateTemp(t.TempDir(), "image")
			if e != nil {
				t.Fatal(e)
			}
			defer f.Close()
			h := root.Hash(s.b)
			done := make(chan error, 1)
			go func() { _, e := c.Hydrate(context.Background(), "l", h, f, 0, root.ChunkSize); done <- e }()
			// Wait until the hydration flight owns the store request.
			for s.n.Load() == 0 {
				runtime.Gosched()
			}
			demand := make(chan error, 1)
			observed := &observedContext{Context: context.Background(), entered: make(chan struct{})}
			go func() { _, e := c.EnsureLineage(observed, "l", h); demand <- e }()
			<-observed.entered
			close(s.gate)
			if e := <-done; e != nil {
				t.Fatal(e)
			}
			if e := <-demand; e != nil {
				t.Fatal(e)
			}
			<-entered
			want := int32(1)
			if fallback {
				want = 2
			}
			if writes.Load() != want || s.n.Load() != 1 {
				t.Fatalf("writes=%d fetches=%d", writes.Load(), s.n.Load())
			}
			b, e := os.ReadFile(f.Name())
			if e != nil || !bytes.Equal(b, s.b) {
				t.Fatal("image mismatch", e)
			}
			p, e := c.Ensure(h)
			if e != nil {
				t.Fatal(e)
			}
			b, e = os.ReadFile(p)
			if e != nil || !bytes.Equal(b, s.b) {
				t.Fatal("cache mismatch", e)
			}
		})
	}
}

func TestHydrationRejectsCorruptionBeforeWrite(t *testing.T) {
	s := &counted{b: make([]byte, root.ChunkSize), gate: make(chan struct{})}
	close(s.gate)
	c := New(t.TempDir(), s, 4)
	defer c.Close()
	c.writeAt = func(*os.File, []byte, int64) (int, error) { t.Fatal("corrupt image write"); return 0, nil }
	if _, e := c.Hydrate(context.Background(), "l", root.Hash([]byte("wrong")), nil, 0, root.ChunkSize); e == nil {
		t.Fatal("accepted corruption")
	}
}

func TestHydrationRealCloneOrFallback(t *testing.T) {
	s := &counted{b: make([]byte, root.ChunkSize), gate: make(chan struct{})}
	s.b[0] = 5
	close(s.gate)
	c := New(t.TempDir(), s, 4)
	defer c.Close()
	f, e := os.CreateTemp(c.Dir, "image")
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	h := root.Hash(s.b)
	if _, e = c.Hydrate(context.Background(), "l", h, f, root.ChunkSize, root.ChunkSize); e != nil {
		t.Fatal(e)
	}
	p, e := c.Ensure(h)
	if e != nil {
		t.Fatal(e)
	}
	b, e := os.ReadFile(p)
	if e != nil || !bytes.Equal(b, s.b) {
		t.Fatal("bad cached range", e)
	}
}

// Signal only when the demand call has reached the existing flight's select.
type observedContext struct {
	context.Context
	entered chan struct{}
}

func (c *observedContext) Done() <-chan struct{} { close(c.entered); return nil }

func TestHydrationJoinsDemandAndHandlesPartialChunk(t *testing.T) {
	s := &counted{b: make([]byte, root.ChunkSize), gate: make(chan struct{})}
	s.b[0] = 23
	c := New(t.TempDir(), s, 4)
	defer c.Close()
	h := root.Hash(s.b)
	demand := make(chan error, 1)
	go func() { _, e := c.EnsureLineage(context.Background(), "l", h); demand <- e }()
	for s.n.Load() == 0 {
		runtime.Gosched()
	}
	f, e := os.CreateTemp(t.TempDir(), "image")
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	observed := &observedContext{Context: context.Background(), entered: make(chan struct{})}
	done := make(chan error, 1)
	go func() { _, e := c.Hydrate(observed, "l", h, f, 0, 512); done <- e }()
	<-observed.entered
	close(s.gate)
	if e = <-demand; e != nil {
		t.Fatal(e)
	}
	if e = <-done; e != nil {
		t.Fatal(e)
	}
	if s.n.Load() != 1 {
		t.Fatal("duplicate fetch", s.n.Load())
	}
	b, e := os.ReadFile(f.Name())
	if e != nil || !bytes.Equal(b, s.b[:512]) {
		t.Fatal("partial image differs", e)
	}
}
