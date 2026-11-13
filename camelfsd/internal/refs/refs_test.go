package refs

import (
	"errors"
	"path/filepath"
	"testing"
	"time"
)

func TestFence(t *testing.T) {
	d, e := Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer d.Close()
	now := time.Now()
	d.Now = func() time.Time { return now }
	a := Value{Root: "a"}
	b := Value{Root: "b"}
	if e = d.CAS("l", "n", Value{}, a, Fence{}); e != nil {
		t.Fatal(e)
	}
	epoch, e := d.Lease("l", "n", "host/job")
	if e != nil {
		t.Fatal(e)
	}
	if e = d.CAS("l", "n", a, b, Fence{"host/job", epoch - 1}); !errors.Is(e, ErrFenced) {
		t.Fatal(e)
	}
	if e = d.CAS("l", "n", a, b, Fence{"host/job", epoch}); e != nil {
		t.Fatal(e)
	}
	if _, e = d.Lease("l", "n", "other"); !errors.Is(e, ErrFenced) {
		t.Fatal(e)
	}
	now = now.Add(6 * time.Minute)
	next, e := d.Lease("l", "n", "other")
	if e != nil || next != epoch+1 {
		t.Fatal(next, e)
	}
	if e = d.CAS("l", "n", b, a, Fence{"host/job", epoch}); !errors.Is(e, ErrFenced) {
		t.Fatal(e)
	}
}
