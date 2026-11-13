package image

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type Checkpoint struct {
	FilesChanged   int     `json:"filesChanged"`
	BytesReceived  int64   `json:"bytesReceived"`
	WalkMs         float64 `json:"walkMs"`
	StreamMs       float64 `json:"streamMs"`
	FreezeMs       float64 `json:"freezeMs"`
	PublishMs      float64 `json:"publishMs"`
	Commit         string  `json:"commit"`
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
	ImageMs        float64 `json:"imageMs"`
	WallMs         float64 `json:"wallMs"`
	CheckpointMs   float64 `json:"checkpointMs"`
}

func (m *Manager) Checkpoint(ctx context.Context, id string) (out Checkpoint, err error) {
	_ = m.Heartbeat(id)
	v := m.lookup(id)
	if v == nil {
		return out, os.ErrNotExist
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	return m.checkpoint(ctx, v, v.Tree)
}
func (m *Manager) checkpoint(ctx context.Context, v *Mount, tree string, metadata ...CheckpointRequest) (out Checkpoint, err error) {
	t := time.Now()
	if v.fenced.Load() || v.Ref == "" {
		return out, refs.ErrFenced
	}
	if e := m.Refs.Check(v.Lineage, v.Ref, v.Fence); e != nil {
		return out, e
	}
	r, e := m.mountRoot(ctx, v.Root)
	if e != nil {
		return out, e
	}
	if v.DM != "" {
		for _, msg := range []string{"hydration_batch_size 256", "hydration_threshold 256", "enable_hydration"} {
			if _, e = run(ctx, "dmsetup", "message", v.DM, "0", msg); e != nil {
				return out, e
			}
		}
		pollStart := time.Now()
		deadline := pollStart.Add(5 * time.Minute)
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
			case <-time.After(hydrationInterval(time.Since(pollStart))):
			}
		}
		if v.early != nil && !v.earlyConsumed {
			select {
			case <-v.early.done:
				if v.early.err != nil {
					return out, v.early.err
				}
			case <-ctx.Done():
				return out, ctx.Err()
			}
		}
	}
	suspended := false
	if v.DM != "" {
		if _, e = run(ctx, "dmsetup", "suspend", v.DM); e != nil {
			return out, e
		}
		suspended = true
	}
	defer func() {
		if suspended {
			_, re := run(context.Background(), "dmsetup", "resume", v.DM)
			if err == nil {
				err = re
			}
		}
	}()

	f, e := os.OpenFile(v.Dest, os.O_RDWR, 0)
	if e != nil {
		return out, e
	}
	defer f.Close()
	if e = f.Sync(); e != nil {
		return out, e
	}
	ft := time.Now()
	ranges, e := changedRanges(f, r.VirtualSize, r.Chunks)
	if e != nil {
		return out, e
	}
	out.FiemapMs = ms(ft)
	v.pendingRanges = append(v.pendingRanges, ranges...)
	if v.early != nil && !v.earlyConsumed {
		v.pendingRanges = append(v.pendingRanges, v.early.ranges...)
	}
	ranges = v.pendingRanges
	rt := time.Now()
	v.Snapshot++
	snap := filepath.Join(filepath.Dir(v.Dest), fmt.Sprintf("snap-%d.img", v.Snapshot))
	if e = clone(v.Dest, snap); e != nil {
		return out, e
	}
	out.ReflinkMs = ms(rt)
	if suspended {
		_, e = run(context.Background(), "dmsetup", "resume", v.DM)
		if e != nil {
			return out, e
		}
		suspended = false
	}
	sf, e := os.Open(snap)
	if e != nil {
		return out, e
	}
	defer sf.Close()
	for _, rg := range ranges {
		out.ChangedBytes += rg.Length
	}
	legacy := r.Locations == nil
	writer := m.writer(ctx, &r)
	defer writer.finish()
	out.ParentRoot = v.Root
	out.Tree = tree
	r.Tree = tree
	r.ParentRoot = v.Root
	ht := time.Now()
	e = (chunk.Chunker{}).Ranges(sf, r.VirtualSize, ranges, func(o int64, h string, b []byte) error {
		k := strconv.FormatInt(o, 10)
		if r.Chunks[k] == h {
			return writer.add(h, b)
		}
		out.ChangedChunks++
		if h == "" {
			delete(r.Chunks, k)
		} else {
			r.Chunks[k] = h
			if e := writer.add(h, b); e != nil {
				return e
			}
		}
		return nil
	})
	out.HashMs = ms(ht)
	if e != nil {
		return out, e
	}
	// Legacy parents may have unchanged chunks outside the FIEMAP delta.
	if legacy {
		for _, h := range r.Chunks {
			if _, ok := r.Locations[h]; !ok && !writer.seen[h] {
				p, e := m.Cache.EnsureContext(ctx, h)
				if e != nil {
					return out, e
				}
				b, e := os.ReadFile(p)
				if e != nil {
					return out, e
				}
				if e = writer.add(h, b); e != nil {
					return out, e
				}
			}
		}
	}
	ut := time.Now()
	e = writer.finish()
	out.UploadedChunks = writer.uploaded
	pruneLocations(&r)
	if e != nil {
		return out, e
	}
	if !legacy && out.ChangedChunks == 0 && tree == v.Tree && v.Root != "" {
		out.Root = v.Root
	} else {
		b, e := root.Encode(r)
		if e != nil {
			return out, e
		}
		out.Root = root.Hash(b)
		if e = m.Store.Put(ctx, "r/"+out.Root, b); e != nil {
			return out, e
		}
	}

	out.UploadMs = ms(ut)
	set := v.Parent
	set.Root = out.Root
	set.Tree = tree
	if tree != "" && len(metadata) == 0 {
		metadata = []CheckpointRequest{{}}
	}
	if len(metadata) > 0 {
		out.Commit, e = m.writeCommit(ctx, v, tree, metadata[0])
		if e != nil {
			return out, e
		}
		set.Commit = out.Commit
	}
	m.protect(v.JobID, r, out.Root)
	if e = m.promote(snap, out.Root); e != nil {
		return out, e
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	if db, ok := m.Refs.(*refs.DB); ok {
		e = db.Publish(ctx, v.Lineage, v.Ref, v.Parent, set, v.Fence)
	} else {
		e = m.Refs.CAS(v.Lineage, v.Ref, v.Parent, set, v.Fence)
	}
	if e != nil {
		return out, e
	}
	v.pendingRanges = nil
	v.earlyConsumed = true
	if v.early != nil {
		v.early.ranges = nil
	}
	v.Parent = set
	v.Root = out.Root
	v.Tree = tree
	v.Promoted = true
	if e = m.save(v); e != nil {
		log.Printf("op=checkpoint-state jobId=%s error=%v", v.JobID, e)
	}
	if v.Snapshot > 1 {
		_ = os.Remove(filepath.Join(filepath.Dir(v.Dest), fmt.Sprintf("snap-%d.img", v.Snapshot-1)))
	}
	out.ImageMs = ms(t)
	return out, nil
}

type ImportRequest struct {
	Lineage string `json:"lineage"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Tree    string `json:"tree"`
}
type ImportResult struct {
	PackMs         float64 `json:"packMs"`
	PackBytes      int64   `json:"packBytes"`
	Root           string  `json:"root"`
	Tree           string  `json:"tree"`
	Chunks         int     `json:"chunks"`
	UploadedChunks int     `json:"uploadedChunks"`
	ImportMs       float64 `json:"importMs"`
}

func (m *Manager) Import(ctx context.Context, q ImportRequest) (out ImportResult, err error) {
	t := time.Now()
	if q.Lineage == "" || q.Name == "" || q.Tree != "" && !root.Hex(q.Tree, 40) || !filepath.IsAbs(q.Path) {
		return out, apierr.Invalid("invalid import request")
	}
	p, e := filepath.EvalSymlinks(q.Path)
	if e != nil {
		return out, e
	}
	// v0-limitation: L22
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
		return out, apierr.Invalid("import path not allowed")
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
		return out, apierr.Invalid("invalid image size or type")
	}
	r := root.Root{V: 1, Tree: q.Tree, FSType: "ext4", VirtualSize: st.Size(), Chunks: map[string]string{}}
	writer := m.writer(ctx, &r)
	defer writer.finish()
	pt := time.Now()
	e = (chunk.Chunker{}).File(f, st.Size(), func(o int64, h string, b []byte) error {
		if h != "" {
			r.Chunks[strconv.FormatInt(o, 10)] = h
		}
		return writer.add(h, b)
	})
	if e != nil {
		return out, e
	}
	if e = writer.finish(); e != nil {
		return out, e
	}
	out.UploadedChunks = writer.uploaded
	out.PackMs = ms(pt)
	out.PackBytes = writer.packBytes
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

func pruneLocations(r *root.Root) {
	ls := map[string]root.Location{}
	for _, h := range r.Chunks {
		if l, ok := r.Locations[h]; ok {
			ls[h] = l
		}
	}
	r.Locations = ls
}
