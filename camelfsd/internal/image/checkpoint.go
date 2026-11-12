package image

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type Checkpoint struct {
	Root           string  `json:"root"`
	Tree           string  `json:"tree"`
	ParentRoot     string  `json:"parentRoot"`
	ChangedChunks  int     `json:"changedChunks"`
	UploadedChunks int     `json:"uploadedChunks"`
	ChangedBytes   int64   `json:"changedBytes"`
	ReflinkMs      float64 `json:"reflinkMs"`
	FiemapMs       float64 `json:"fiemapMs"`
	HashMs         float64 `json:"hashMs"`
	UploadMs       float64 `json:"uploadMs"`
	CheckpointMs   float64 `json:"checkpointMs"`
}

func (m *Manager) Checkpoint(ctx context.Context, id string) (out Checkpoint, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := time.Now()
	v := m.mounts[id]
	if v == nil {
		return out, os.ErrNotExist
	}
	if v.Ref == "" {
		return out, refs.ErrFenced
	}
	if e := m.Refs.Check(v.Lineage, v.Ref, v.Fence); e != nil {
		return out, e
	}
	r, e := m.load(ctx, v.Root)
	if e != nil {
		return out, e
	}
	if v.DM != "" {
		for _, msg := range []string{"hydration_batch_size 64", "hydration_threshold 64", "enable_hydration"} {
			if _, e = run(ctx, "dmsetup", "message", v.DM, "0", msg); e != nil {
				return out, e
			}
		}
		deadline := time.Now().Add(5 * time.Minute)
		for {
			if e = m.status(ctx, v); e != nil {
				return out, e
			}
			if v.State == "hydrated" {
				break
			}
			if time.Now().After(deadline) {
				return out, fmt.Errorf("hydration timeout")
			}
			select {
			case <-ctx.Done():
				return out, ctx.Err()
			case <-time.After(100 * time.Millisecond):
			}
		}
		if _, e = run(ctx, "dmsetup", "suspend", v.DM); e != nil {
			return out, e
		}
		defer func() {
			_, re := run(context.Background(), "dmsetup", "resume", v.DM)
			if err == nil {
				err = re
			}
		}()
	}
	f, e := os.OpenFile(v.Dest, os.O_RDWR, 0)
	if e != nil {
		return out, e
	}
	defer f.Close()
	if e = f.Sync(); e != nil {
		return out, e
	}
	ft := time.Now()
	ranges, e := changedRanges(f, r.VirtualSize)
	if e != nil {
		return out, e
	}
	out.FiemapMs = ms(ft)
	rt := time.Now()
	v.Snapshot++
	snap := filepath.Join(filepath.Dir(v.Dest), fmt.Sprintf("snap-%d.img", v.Snapshot))
	if e = clone(v.Dest, snap); e != nil {
		return out, e
	}
	out.ReflinkMs = ms(rt)
	sf, e := os.Open(snap)
	if e != nil {
		return out, e
	}
	defer sf.Close()
	ft = time.Now()
	if os.Getenv("CAMELFSD_TEST_NO_REFLINK") != "1" {
		if _, e = extents(sf); e != nil {
			return out, e
		}
	}
	out.FiemapMs += ms(ft)
	for _, rg := range ranges {
		out.ChangedBytes += rg.Length
	}
	pending := map[string][]byte{}
	out.ParentRoot = v.Root
	out.Tree = v.Tree
	r.ParentRoot = v.Root
	ht := time.Now()
	e = (chunk.Chunker{}).Ranges(sf, r.VirtualSize, ranges, func(o int64, h string, b []byte) error {
		k := strconv.FormatInt(o, 10)
		if r.Chunks[k] == h {
			return nil
		}
		out.ChangedChunks++
		if h == "" {
			delete(r.Chunks, k)
		} else {
			r.Chunks[k] = h
			pending[h] = append([]byte(nil), b...)
		}
		return nil
	})
	out.HashMs = ms(ht)
	if e != nil {
		return out, e
	}
	ut := time.Now()
	out.UploadedChunks, e = store.PutChunks(ctx, m.Store, pending)
	if e != nil {
		return out, e
	}
	b, e := root.Encode(r)
	if e != nil {
		return out, e
	}
	out.Root = root.Hash(b)
	if e = m.Store.Put(ctx, "r/"+out.Root, b); e != nil {
		return out, e
	}
	out.UploadMs = ms(ut)
	set := v.Parent
	set.Root = out.Root
	set.Tree = v.Tree
	if e = m.Refs.CAS(v.Lineage, v.Ref, v.Parent, set, v.Fence); e != nil {
		return out, e
	}
	v.Parent = set
	v.Root = out.Root
	if e = m.Refs.RecordTree(v.Lineage, v.Tree, out.Root); e != nil {
		return out, e
	}
	if e = m.promote(snap, out.Root); e != nil {
		return out, e
	}
	v.Promoted = true
	if e = m.save(v); e != nil {
		return out, e
	}
	if v.Snapshot > 1 {
		_ = os.Remove(filepath.Join(filepath.Dir(v.Dest), fmt.Sprintf("snap-%d.img", v.Snapshot-1)))
	}
	out.CheckpointMs = ms(t)
	return out, nil
}

type ImportRequest struct {
	Lineage string `json:"lineage"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Tree    string `json:"tree"`
}
type ImportResult struct {
	Root           string  `json:"root"`
	Tree           string  `json:"tree"`
	Chunks         int     `json:"chunks"`
	UploadedChunks int     `json:"uploadedChunks"`
	ImportMs       float64 `json:"importMs"`
}

func (m *Manager) Import(ctx context.Context, q ImportRequest) (out ImportResult, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t := time.Now()
	if q.Lineage == "" || q.Name == "" || q.Tree != "" && !root.Hex(q.Tree, 40) || !filepath.IsAbs(q.Path) {
		return out, fmt.Errorf("invalid import request")
	}
	p, e := filepath.EvalSymlinks(q.Path)
	if e != nil {
		return out, e
	}
	allowed := append([]string{m.Data, "/nvme"}, m.ImportAllow...)
	ok := false
	for _, dir := range allowed {
		d, e := filepath.EvalSymlinks(dir)
		if e != nil {
			continue
		}
		rel, e := filepath.Rel(d, p)
		if e == nil && rel != ".." && !filepath.IsAbs(rel) && !(len(rel) > 3 && rel[:3] == "../") {
			ok = true
		}
	}
	if !ok {
		return out, fmt.Errorf("import path not allowed")
	}
	prev, e := m.Refs.Get(q.Lineage, q.Name)
	if errors.Is(e, sql.ErrNoRows) {
		prev = refs.Ref{}
	} else if e != nil {
		return out, e
	}
	if prev.Holder != "" {
		return out, refs.ErrFenced
	}
	f, e := os.Open(p)
	if e != nil {
		return out, e
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil {
		return out, e
	}
	if !st.Mode().IsRegular() || st.Size() == 0 || st.Size()%512 != 0 {
		return out, fmt.Errorf("invalid image size or type")
	}
	r := root.Root{V: 1, Tree: q.Tree, FSType: "ext4", VirtualSize: st.Size(), Chunks: map[string]string{}}
	pending := map[string][]byte{}
	flush := func() error {
		n, e := store.PutChunks(ctx, m.Store, pending)
		out.UploadedChunks += n
		pending = map[string][]byte{}
		return e
	}
	e = (chunk.Chunker{}).File(f, st.Size(), func(o int64, h string, b []byte) error {
		if h != "" {
			r.Chunks[strconv.FormatInt(o, 10)] = h
			pending[h] = append([]byte(nil), b...)
		}
		if len(pending) >= 64 {
			return flush()
		}
		return nil
	})
	if e != nil {
		return out, e
	}
	if e = flush(); e != nil {
		return out, e
	}
	b, e := root.Encode(r)
	if e != nil {
		return out, e
	}
	out.Root = root.Hash(b)
	out.Tree = q.Tree
	out.Chunks = len(r.Chunks)
	if e = m.Store.Put(ctx, "r/"+out.Root, b); e != nil {
		return out, e
	}
	if e = m.promote(p, out.Root); e != nil {
		return out, e
	}
	if e = m.Refs.CAS(q.Lineage, q.Name, prev.Value, refs.Value{Root: out.Root, Tree: q.Tree}, refs.Fence{}); e != nil {
		return out, e
	}
	if e = m.Refs.RecordTree(q.Lineage, q.Tree, out.Root); e != nil {
		return out, e
	}
	out.ImportMs = ms(t)
	return out, nil
}
