package image

import (
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

func TestLeaseLiveness(t *testing.T) {
	db, e := refs.Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	now := time.Unix(100, 0)
	db.Now = func() time.Time { return now }
	db.TTL = 5 * time.Second
	m := &Manager{Config: Config{LeaseTTL: db.TTL, Now: db.Now}, Refs: db}
	for _, live := range []bool{false, true} {
		db.Ensure("l", "r")
		epoch, e := db.Lease("l", "r", "a")
		if e != nil {
			t.Fatal(e)
		}
		v := &Mount{Request: Request{Lineage: "l", Ref: "r"}, Fence: refs.Fence{Holder: "a", LeaseEpoch: epoch}, activity: &atomic.Int64{}, fenced: &atomic.Bool{}}
		v.activity.Store(now.UnixNano())
		for i := 0; i < 8; i++ {
			now = now.Add(time.Second)
			if live {
				v.activity.Store(now.UnixNano())
			}
			m.renewOnce(v)
		}
		err := db.Check("l", "r", v.Fence)
		if live && err != nil || !live && err == nil {
			t.Fatalf("live=%v error=%v", live, err)
		}
		if !live {
			if _, e = db.Lease("l", "r", "b"); e != nil {
				t.Fatal(e)
			}
			v.activity.Store(now.UnixNano())
			m.renewOnce(v)
			if !v.fenced.Load() {
				t.Fatal("not fenced")
			}
			db.ReleaseLease("l", "r", refs.Fence{Holder: "b", LeaseEpoch: epoch + 1})
		} else {
			db.ReleaseLease("l", "r", v.Fence)
		}
	}
}
