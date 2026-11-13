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

func TestPackedRootDoesNotMoveChangedOrLeasedRef(t *testing.T) {
	d, e := Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer d.Close()
	old := Value{Root: "old", Tree: "tree"}
	if e = d.CAS("l", "main", Value{}, old, Fence{}); e != nil {
		t.Fatal(e)
	}
	if e = d.RecordTree("l", "tree", "old"); e != nil {
		t.Fatal(e)
	}
	epoch, e := d.Lease("l", "main", "owner")
	if e != nil {
		t.Fatal(e)
	}
	if e = d.Packed("old", "packed"); e != nil {
		t.Fatal(e)
	}
	ref, e := d.Get("l", "main")
	if e != nil || ref.Root != "old" {
		t.Fatal(ref, e)
	}
	tree, e := d.TreeRoot("l", "tree")
	if e != nil || tree != "packed" {
		t.Fatal(tree, e)
	}
	next := old
	next.Root = "changed"
	if e = d.CAS("l", "main", old, next, Fence{"owner", epoch}); e != nil {
		t.Fatal(e)
	}
	if e = d.Packed("old", "packed"); e != nil {
		t.Fatal(e)
	}
	ref, e = d.Get("l", "main")
	if e != nil || ref.Root != "changed" {
		t.Fatal(ref, e)
	}
}
