package store

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestTouchUsedBounded(t *testing.T) {
	p := filepath.Join(t.TempDir(), "image")
	os.WriteFile(p, nil, 0600)
	now := time.Now().Truncate(time.Second)
	old := now.Add(-time.Hour)
	os.Chtimes(p, old, old)
	TouchUsed(p, now)
	info, _ := os.Stat(p)
	if !info.ModTime().Equal(now) {
		t.Fatal(info.ModTime())
	}
	TouchUsed(p, now.Add(59*time.Second))
	info, _ = os.Stat(p)
	if !info.ModTime().Equal(now) {
		t.Fatal("unbounded touch")
	}
	TouchUsed(p, now.Add(time.Minute))
	info, _ = os.Stat(p)
	if !info.ModTime().Equal(now.Add(time.Minute)) {
		t.Fatal("stale use time")
	}
}
