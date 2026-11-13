package store

import (
	"context"
	"testing"
	"time"
)

func TestDemandReserveAcrossBackgroundCallers(t *testing.T) {
	s := WithDepth(Local{Dir: t.TempDir()}, 8).(*limited)
	bg := Background(context.Background())
	for i := 0; i < cap(s.background); i++ {
		if e := s.acquire(bg); e != nil {
			t.Fatal(e)
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	// A second speculative caller cannot take the reserved slots.
	blocked, cancelBlocked := context.WithCancel(bg)
	cancelBlocked()
	if e := s.acquire(blocked); e == nil {
		t.Fatal("speculative budget exceeded")
	}
	if e := s.acquire(ctx); e != nil {
		t.Fatal("demand starved", e)
	}
	s.release(ctx)
	for i := 0; i < cap(s.background); i++ {
		s.release(bg)
	}
}
