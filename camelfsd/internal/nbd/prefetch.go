package nbd

import (
	"context"
	"encoding/json"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"sync"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

const patternLimit = 64 << 10

type origin struct {
	lineage  string
	mu       sync.Mutex
	cond     *sync.Cond
	ctx      context.Context
	cancel   context.CancelFunc
	wg       sync.WaitGroup
	server   *Server
	root     root.Root
	refs     int
	queue    []int64
	pending  map[int64]bool
	seen     map[int64]bool
	touches  []int64
	lineages map[string]bool
}

func (s *Server) pattern(lineage string) string {
	return filepath.Join(s.Patterns, url.PathEscape(lineage)+".json")
}

// Register shares one bounded pool across every NBD connection to a root.
// Its owner releases it after disconnecting the mount's NBD device.
func (s *Server) Register(id, lineage string, r root.Root) func() {
	id = lineage + "/" + id
	s.mu.Lock()
	if s.origins == nil {
		s.origins = map[string]*origin{}
	}
	p := s.origins[id]
	if p == nil {
		ctx, cancel := context.WithCancel(store.Background(context.Background()))
		p = &origin{lineage: lineage, ctx: ctx, cancel: cancel, server: s, root: r, pending: map[int64]bool{}, seen: map[int64]bool{}, lineages: map[string]bool{}}
		p.cond = sync.NewCond(&p.mu)
		if s.Patterns != "" && lineage != "" {
			if b, e := os.ReadFile(s.pattern(lineage)); e == nil && len(b) <= 2<<20 {
				var seq []int64
				if json.Unmarshal(b, &seq) == nil {
					for _, o := range seq[:min(len(seq), patternLimit)] {
						p.enqueue(o)
					}
				}
			}
		}
		s.origins[id] = p
		for i := 0; i < max(1, s.Prefetch); i++ {
			p.wg.Add(1)
			go p.worker()
		}
	}
	p.refs++
	if lineage != "" {
		p.lineages[lineage] = true
	}
	s.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			p.refs--
			if p.refs != 0 {
				return
			}
			delete(s.origins, id)
			p.cancel()
			p.mu.Lock()
			p.cond.Broadcast()
			p.mu.Unlock()
			p.wg.Wait()
			if s.Patterns != "" {
				b, _ := json.Marshal(p.touches)
				for l := range p.lineages {
					_ = store.Atomic(s.pattern(l), b)
				}
			}
		})
	}
}
func (p *origin) enqueue(o int64) {
	// Caller holds mu, except while constructing the pool before publication.
	if o < 0 || o >= p.root.VirtualSize || o%root.ChunkSize != 0 || p.root.Chunks[strconv.FormatInt(o, 10)] == "" || p.pending[o] || len(p.queue) >= patternLimit {
		return
	}
	p.pending[o] = true
	p.queue = append(p.queue, o)
}
func (p *origin) touch(o int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !p.seen[o] && len(p.touches) < patternLimit {
		p.seen[o] = true
		p.touches = append(p.touches, o)
	}
}
func (p *origin) ahead(o int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for k := 1; k <= p.server.Prefetch; k++ {
		p.enqueue(o + int64(k)*root.ChunkSize)
	}
	p.cond.Broadcast()
}
func (p *origin) worker() {
	defer p.wg.Done()
	for {
		p.mu.Lock()
		for len(p.queue) == 0 && p.ctx.Err() == nil {
			p.cond.Wait()
		}
		if p.ctx.Err() != nil {
			p.mu.Unlock()
			return
		}
		o := p.queue[0]
		p.queue = p.queue[1:]
		p.mu.Unlock()
		_, _ = p.server.Cache.EnsureLineage(p.ctx, p.lineage, p.root.Chunks[strconv.FormatInt(o, 10)])
		p.mu.Lock()
		delete(p.pending, o)
		p.mu.Unlock()
	}
}
