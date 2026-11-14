package image

import (
	"testing"
	"time"
)

func TestHydrationThroughput(t *testing.T) {
	h := &hydration{started: time.Now().Add(-time.Second)}
	h.bytes.Store(250_000_000)
	if n := h.mbps(); n < 200 || n > 260 {
		t.Fatal(n)
	}
	h.elapsed.Store(int64(2 * time.Second))
	h.started = time.Now().Add(-time.Hour)
	if n := h.mbps(); n != 125 {
		t.Fatal("completed average decayed", n)
	}
}
