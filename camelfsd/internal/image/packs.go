package image

import (
	"context"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"log"
	"os"
	"strconv"
)

func (m *Manager) buildPacks(ctx context.Context, r root.Root, f *os.File) (root.Root, error) {
	r.Packs = map[string]string{}
	r.PackWindow = m.PackWindow
	for _, window := range packWindows(r, r.Window()) {
		if len(window) < 2 {
			continue
		}
		var b []byte
		var hashes []string
		for _, key := range window {
			off, _ := strconv.ParseInt(key, 10, 64)
			chunk := make([]byte, root.ChunkSize)
			n, e := f.ReadAt(chunk, off)
			if e != nil && off+int64(n) != r.VirtualSize {
				return r, e
			}
			if root.Hash(chunk) != r.Chunks[key] {
				return r, fmt.Errorf("image changed during pack build")
			}
			b = append(b, chunk...)
			hashes = append(hashes, r.Chunks[key])
		}
		id := root.PackID(hashes)
		if e := m.Store.Put(ctx, "p/"+id, b); e != nil {
			return r, e
		}
		off, _ := strconv.ParseInt(window[0], 10, 64)
		r.Packs[strconv.FormatInt(off/r.Window()*r.Window(), 10)] = id
	}
	return r, nil
}

// Promotions coalesce by root. A single worker builds packs after foreground work.
func (m *Manager) queuePack(id string) {
	if !m.Packs {
		return
	}
	m.packMu.Lock()
	defer m.packMu.Unlock()
	if m.packPending == nil {
		m.packPending = map[string]bool{}
	}
	if m.packClosed || m.packPending[id] {
		return
	}
	m.packPending[id] = true
	m.packWG.Add(1)
	go func() {
		defer m.packWG.Done()
		m.packSerial.Lock()
		defer m.packSerial.Unlock()
		defer func() { m.packMu.Lock(); delete(m.packPending, id); m.packMu.Unlock() }()
		select {
		case <-m.stop:
			return
		default:
		}
		if e := m.packRoot(id); e != nil {
			log.Printf("op=pack root=%s error=%v", id, e)
		}
	}()
}
func (m *Manager) packRoot(id string) error {
	ctx := store.Background(context.Background())
	b, e := m.Store.Get(ctx, "r/"+id)
	if e != nil {
		return e
	}
	r, e := root.Decode(b)
	if e != nil {
		return e
	}
	if len(r.Packs) > 0 {
		return nil
	}
	f, e := os.Open(m.image(id))
	if e != nil {
		return e
	}
	defer f.Close()
	packed, e := m.buildPacks(ctx, r, f)
	if e != nil {
		return e
	}
	b, e = root.Encode(packed)
	if e != nil {
		return e
	}
	next := root.Hash(b)
	if next == id {
		return nil
	}
	if e = m.Store.Put(ctx, "r/"+next, b); e != nil {
		return e
	}
	if e = clone(m.image(id), m.image(next)); e != nil && !os.IsExist(e) {
		return e
	}
	if db, ok := m.Refs.(interface{ Packed(string, string) error }); ok {
		return db.Packed(id, next)
	}
	return nil
}
