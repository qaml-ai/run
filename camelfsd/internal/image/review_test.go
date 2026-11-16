package image

import (
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWorkspaceCacheLeavesLegacyImagesUntouched(t *testing.T) {
	m, tree := unit3(t)
	id := strings.Repeat("a", 64)
	legacy := filepath.Join(m.Data, "images")
	if err := os.Mkdir(legacy, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(legacy, id+".img")
	f, err := os.Create(file)
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Truncate(m.VirtualSize); err != nil {
		f.Close()
		t.Fatal(err)
	}
	if err := f.Close(); err != nil {
		t.Fatal(err)
	}
	if err := m.Refs.RecordTree("l", tree, id); err != nil {
		t.Fatal(err)
	}
	if got, err := m.cachedTree("l", tree); err != nil || got != "" {
		t.Fatalf("new cache selected a legacy image: %q (%v)", got, err)
	}
	if _, err := m.evict(m.VirtualSize, 0); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(file); err != nil {
		t.Fatalf("new cache eviction touched a legacy image: %v", err)
	}
}

func TestMountRequiresFence(t *testing.T) {
	m := &Manager{}
	for _, fence := range []*refs.Fence{nil, {Epoch: 1}, {Holder: "host/vm"}} {
		q := Request{JobID: "vm", Lineage: "l", Tree: strings.Repeat("a", 40), Parent: strings.Repeat("b", 40), Fence: fence}
		if _, err := m.Mount(t.Context(), q); err == nil || !strings.Contains(err.Error(), "mount requires a valid fence") {
			t.Fatalf("mount with fence %+v: %v", fence, err)
		}
	}
}
