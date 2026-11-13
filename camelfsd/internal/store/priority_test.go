package store

import (
	"context"
	"testing"
	"time"
)

func TestDemandReservationAndBorrow(t *testing.T) {
	b := budget{depth: 64, reserved: 16}
	ctx := context.Background()
	var frees []func()
	for i := 0; i < 64; i++ {
		_, f, e := b.acquire(Background(ctx))
		if e != nil {
			t.Fatal(e)
		}
		frees = append(frees, f)
	}
	defer func() {
		for _, f := range frees {
			f()
		}
	}()
	wait, cancel := context.WithTimeout(Background(ctx), 20*time.Millisecond)
	defer cancel()
	if _, _, e := b.acquire(wait); e == nil {
		t.Fatal("65th background admitted")
	}
	// Separately verify the guaranteed 48-background reservation case.
	for _, f := range frees {
		f()
	}
	frees = nil
	for i := 0; i < 48; i++ {
		_, f, _ := b.acquire(Background(ctx))
		frees = append(frees, f)
	}
	demand, stop := context.WithTimeout(ctx, time.Second)
	defer stop()
	_, release, e := b.acquire(demand)
	if e != nil {
		t.Fatal("demand queued behind background", e)
	}
	release()
}

func TestBorrowedSlotPreemptedForDemand(t *testing.T) {
	b := budget{depth: 2, reserved: 1}
	ctx := context.Background()
	for i := 0; i < 2; i++ {
		child, release, e := b.acquire(Background(ctx))
		if e != nil {
			t.Fatal(e)
		}
		go func() { <-child.Done(); release() }()
	}
	deadline, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	_, release, e := b.acquire(deadline)
	if e != nil {
		t.Fatal(e)
	}
	release()
	b.mu.Lock()
	for p := range b.active {
		p.cancel()
	}
	b.mu.Unlock()
}
