package image

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"path/filepath"
	"strconv"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

func TestHydrationDefaults(t *testing.T) {
	for _, tc := range []struct {
		body string
		want bool
	}{{`{}`, true}, {`{"hydrate":false}`, false}, {`{"hydrate":true}`, true}} {
		var q Request
		if e := json.Unmarshal([]byte(tc.body), &q); e != nil || q.Hydrate != tc.want {
			t.Fatal(q, e)
		}
	}
}
func TestPackWindows(t *testing.T) {
	r := root.Root{Chunks: map[string]string{"0": "a", strconv.Itoa(4 << 20): "b", strconv.Itoa((4 << 20) - int(chunk.Size)): "c"}}
	w := packWindows(r, 4<<20)
	if len(w) != 2 || len(w[0]) != 2 || len(w[1]) != 1 || w[0][0] != "0" {
		t.Fatal(w)
	}
}
func TestEvictionProtectsLiveFilesAndReachesLowWatermark(t *testing.T) {
	m, _ := unit3(t)
	r := root.Root{Chunks: map[string]string{"0": root.Hash([]byte("live chunk"))}}
	id := root.Hash([]byte("live image"))
	m.protect("live", r, id)
	paths := []string{m.image(id), m.image(root.Hash([]byte("old"))), m.image(root.Hash([]byte("new")))}
	for i, p := range paths {
		if e := os.WriteFile(p, make([]byte, 8192), 0600); e != nil {
			t.Fatal(e)
		}
		os.Chtimes(p, time.Unix(int64(i), 0), time.Unix(int64(i), 0))
	}
	h := r.Chunks["0"]
	p := filepath.Join(m.Cache.Dir, h[:2], h)
	os.MkdirAll(filepath.Dir(p), 0700)
	os.WriteFile(p, make([]byte, 8192), 0600)
	freed, e := m.evict(32768, 16384)
	if e != nil || freed != 16384 {
		t.Fatal(freed, e)
	}
	for _, p := range []string{paths[0], p} {
		if _, e := os.Stat(p); e != nil {
			t.Fatal(e)
		}
	}
	if _, e := os.Stat(paths[1]); !os.IsNotExist(e) {
		t.Fatal("old image retained", e)
	}
}
func TestHydratedPartnerEarlyAndLaterWrites(t *testing.T) {
	if os.Getenv("CAMELFSD_TEST_NO_REFLINK") == "1" {
		t.Skip("requires FIEMAP and reflink")
	}
	dir := t.TempDir()
	if e := Probe(dir); e != nil {
		t.Skip(e)
	}
	// Use the local store helper, then restore real reflink for this test.
	m, _ := unit3(t)
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "")
	p := filepath.Join(dir, "dest.img")
	b := make([]byte, 8*chunk.Size)
	b[0] = 1
	if e := os.WriteFile(p, b, 0600); e != nil {
		t.Fatal(e)
	}
	imp, e := m.Import(context.Background(), ImportRequest{Lineage: "l", Name: "source", Path: p})
	if e != nil {
		m.ImportAllow = append(m.ImportAllow, dir)
		imp, e = m.Import(context.Background(), ImportRequest{Lineage: "l", Name: "source", Path: p})
	}
	if e != nil {
		t.Fatal(e)
	}
	f, _ := os.OpenFile(p, os.O_RDWR, 0)
	defer f.Close()
	f.WriteAt([]byte{2}, chunk.Size)
	f.Sync()
	private, e := extents(f)
	if e != nil {
		t.Fatal(e)
	}
	partner := filepath.Join(dir, "hydrated.img")
	if e = clone(p, partner); e != nil {
		t.Fatal(e)
	}
	early, e := m.earlyWrites(context.Background(), partner, imp.Root, private)
	if e != nil || len(early) != 1 || early[0].Offset != chunk.Size {
		t.Fatal(early, e)
	}
	f.WriteAt([]byte{3}, 3*chunk.Size)
	f.Sync()
	r, _ := m.load(context.Background(), imp.Root)
	ranges, e := changedRanges(f, int64(len(b)), r.Chunks)
	if e != nil {
		t.Fatal(e)
	}
	hashed := map[int64]bool{}
	sf, _ := os.Open(p)
	defer sf.Close()
	e = (chunk.Chunker{}).Ranges(sf, int64(len(b)), append(ranges, early...), func(o int64, _ string, _ []byte) error { hashed[o] = true; return nil })
	if e != nil || !hashed[chunk.Size] || !hashed[3*chunk.Size] || len(hashed) > 3 {
		t.Fatal(hashed, e)
	}
}

type noReleaseReads struct{ store.Store }

func (s noReleaseReads) Get(context.Context, string) ([]byte, error) {
	return nil, fmt.Errorf("release attempted a store read/hash")
}
func TestReleasePromotesOnlyVerifiedHydratedSnapshot(t *testing.T) {
	for _, early := range []bool{false, true} {
		t.Run(strconv.FormatBool(early), func(t *testing.T) {
			m, tree := unit3(t)
			mounted := mount3(t, m, tree, "release")
			v := m.lookup(mounted.JobID)
			original := []byte("hydrated original")
			id := root.Hash(original)
			v.hydrated = filepath.Join(filepath.Dir(v.Dest), "hydrated.img")
			v.hydrationRoot = id
			if e := os.WriteFile(v.hydrated, original, 0600); e != nil {
				t.Fatal(e)
			}
			// Later guest writes are irrelevant to promotion of the immutable partner.
			f, e := os.OpenFile(v.Dest, os.O_WRONLY, 0)
			if e != nil {
				t.Fatal(e)
			}
			f.WriteAt([]byte("guest write"), 0)
			f.Close()
			v.early = &earlyResult{done: make(chan struct{}), clean: !early}
			if early {
				v.early.ranges = []chunk.Range{{Offset: 0, Length: chunk.Size}}
			}
			close(v.early.done)
			v.earlyCancel = func() {}
			m.Store = noReleaseReads{m.Store}
			promoted, e := m.Release(context.Background(), v.JobID)
			if e != nil || promoted == early {
				t.Fatal(promoted, e)
			}
			b, e := os.ReadFile(m.image(id))
			if early {
				if !os.IsNotExist(e) {
					t.Fatal("edited partner promoted", e)
				}
			} else if e != nil || !bytes.Equal(b, original) {
				t.Fatal(e, string(b))
			}
		})
	}
}

func TestEarlyRangesSkipHoles(t *testing.T) {
	r := root.Root{VirtualSize: 1 << 40, Chunks: map[string]string{"0": "a", strconv.FormatInt(10*chunk.Size, 10): "b"}}
	hashes, changed := earlyRanges(r, []extent{
		{Logical: 0, Length: uint64(chunk.Size)},
		{Logical: uint64(20 * chunk.Size), Length: uint64(chunk.Size)},
		{Logical: uint64(30 * chunk.Size), Length: uint64(chunk.Size), Flags: 0x2000},
	})
	if len(hashes) != 2 || len(changed) != 1 || changed[0].Offset != 20*chunk.Size {
		t.Fatal(hashes, changed)
	}
	t.Logf("1 TiB sparse image: hash %d parent chunks; mark %d new chunks without hashing", len(hashes), len(changed))
}

func TestHydrationPollBackoffAndStop(t *testing.T) {
	for _, release := range []bool{false, true} {
		ticks := make(chan time.Time, 20)
		stop := make(chan struct{})
		host := make(chan struct{})
		start := time.Unix(100, 0)
		checks, resets := 0, 0
		for i := 1; i <= 12; i++ {
			ticks <- start.Add(time.Duration(i) * 100 * time.Millisecond)
		}
		done := make(chan struct{})
		go func() {
			pollHydration(stop, host, ticks, func(d time.Duration) {
				if d != time.Second {
					t.Error(d)
				}
				resets++
			}, start, func() bool {
				checks++
				if checks == 11 {
					if release {
						close(stop)
						return false
					}
					return true
				}
				return false
			})
			close(done)
		}()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Fatal("poll did not stop")
		}
		if checks != 11 || resets != 1 {
			t.Fatal(checks, resets)
		}
	}
}
