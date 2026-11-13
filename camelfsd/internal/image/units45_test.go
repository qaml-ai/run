package image

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"

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
