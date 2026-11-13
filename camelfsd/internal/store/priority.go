package store

import (
	"context"
	"sync"
)

type fetchFinishKey struct{}

func OnFetchFinish(ctx context.Context, fn func(int64)) context.Context {
	return context.WithValue(ctx, fetchFinishKey{}, fn)
}

type fetchStartKey struct{}

func OnFetchStart(ctx context.Context, fn func()) context.Context {
	return context.WithValue(ctx, fetchStartKey{}, fn)
}

type backgroundKey struct{}
type lowestKey struct{}

func LowestPriority(ctx context.Context) context.Context {
	return context.WithValue(Background(ctx), lowestKey{}, true)
}

func Background(ctx context.Context) context.Context {
	return context.WithValue(ctx, backgroundKey{}, true)
}
func IsBackground(ctx context.Context) bool { v, _ := ctx.Value(backgroundKey{}).(bool); return v }

type budget struct {
	mu                       sync.Mutex
	changed                  chan struct{}
	active                   map[*permit]bool
	depth, reserved, waiting int
}
type permit struct {
	cancel     context.CancelFunc
	background bool
}

func (b *budget) signal() { close(b.changed); b.changed = make(chan struct{}) }
func (b *budget) acquire(ctx context.Context) (context.Context, func(), error) {
	bg := IsBackground(ctx)
	b.mu.Lock()
	if b.changed == nil {
		b.changed = make(chan struct{})
		b.active = map[*permit]bool{}
	}
	if !bg {
		b.waiting++
	}
	for {
		if ctx.Err() != nil {
			if !bg {
				b.waiting--
				b.signal()
			}
			b.mu.Unlock()
			return nil, nil, ctx.Err()
		}
		demand := 0
		for p := range b.active {
			if !p.background {
				demand++
			}
		}
		limit := b.depth
		if bg && (demand > 0 || b.waiting > 0) {
			limit = b.depth - b.reserved
		}
		lowest, _ := ctx.Value(lowestKey{}).(bool)
		allowed := (!lowest || len(b.active) == 0) && len(b.active) < b.depth && (!bg || (b.waiting == 0 && len(b.active)-demand < limit))
		if allowed {
			if !bg {
				b.waiting--
			}
			child, cancel := context.WithCancel(ctx)
			p := &permit{cancel, bg}
			b.active[p] = true
			b.mu.Unlock()
			return child, func() { b.mu.Lock(); delete(b.active, p); cancel(); b.signal(); b.mu.Unlock() }, nil
		}
		// Borrowed background slots are interruptible. Demand never queues behind them.
		if !bg {
			for p := range b.active {
				if p.background {
					p.cancel()
					break
				}
			}
		}
		changed := b.changed
		b.mu.Unlock()
		select {
		case <-ctx.Done():
		case <-changed:
		}
		b.mu.Lock()
	}
}

// SetDemandSlots configures the shared store budget before the server starts.
func SetDemandSlots(s Store, n int) {
	switch v := s.(type) {
	case *limited:
		v.budget.reserved = n
	case *Uploaded:
		SetDemandSlots(v.Store, n)
	}
}
