package image

import (
	"context"

	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/objects"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type Checkpoint struct {
	Timings        map[string]float64 `json:"timings"`
	FilesChanged   int                `json:"filesChanged"`
	BytesReceived  int64              `json:"bytesReceived"`
	WalkMs         float64            `json:"walkMs"`
	StreamMs       float64            `json:"streamMs"`
	FreezeMs       float64            `json:"freezeMs"`
	PublishMs      float64            `json:"publishMs"`
	Commit         string             `json:"commit"`
	Root           string             `json:"root"`
	Tree           string             `json:"tree"`
	ParentRoot     string             `json:"parentRoot"`
	ChangedChunks  int                `json:"changedChunks"`
	UploadedChunks int                `json:"uploadedChunks"`
	ChangedBytes   int64              `json:"changedBytes"`
	ReflinkMs      float64            `json:"reflinkMs"`
	FiemapMs       float64            `json:"fiemapMs"`
	HashMs         float64            `json:"hashMs"`
	UploadMs       float64            `json:"uploadMs"`
	ImageMs        float64            `json:"imageMs"`
	WallMs         float64            `json:"wallMs"`
	CheckpointMs   float64            `json:"checkpointMs"`
}

func (m *Manager) Checkpoint(ctx context.Context, id string) (out Checkpoint, err error) {
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
	defer func() { out.Timings = out.timingFields() }()
	if v.Fence == nil {
		return out, &apierr.Error{Status: 409, Code: "no_fence", Cause: fmt.Errorf("mount has no fence")}
	}
	if tree == "" {
		tr, e := m.objects().Import(ctx, objects.Request{Lineage: v.Lineage, Files: map[string]objects.File{}})
		if e != nil {
			return out, e
		}
		tree = tr.Tree
	}
	r, e := m.mountRoot(ctx, v.Root)
	if e != nil {
		return out, e
	}
	if e = m.awaitHydration(ctx, v); e != nil {
		return out, e
	}
	var ranges []chunk.Range
	snap := v.preparedSnapshot
	if snap != "" {
		ranges = v.preparedRanges
		v.preparedSnapshot = ""
		v.preparedRanges = nil
	} else {
		suspended := false
		if v.DM != "" {
			if _, e = run(ctx, "dmsetup", "suspend", v.DM); e != nil {
				return out, e
			}
			suspended = true
		}
		defer func() {
			if suspended {
				_, re := resumeDM(v.DM)
				if err == nil {
					err = re
				}
			}
		}()

		v.Snapshot++
		snap = filepath.Join(filepath.Dir(v.Dest), fmt.Sprintf("snap-%d.img", v.Snapshot))
		rt := time.Now()
		if v.DM != "" {
			ranges, e = snapshotCopy(ctx, v.Dest, filepath.Join(filepath.Dir(v.Dest), "cow.img"), snap, r.VirtualSize)
		} else {
			f, err := os.OpenFile(v.Dest, os.O_RDWR, 0)
			if err != nil {
				return out, err
			}
			e = f.Sync()
			if e == nil {
				ranges, e = changedRanges(f, r.VirtualSize, r.Chunks)
			}
			f.Close()
			if e == nil {
				e = clone(v.Dest, snap)
			}
		}
		if e != nil {
			os.Remove(snap)
			return out, e
		}
		v.pendingRanges = append(v.pendingRanges, ranges...)
		ranges = v.pendingRanges
		out.ReflinkMs = ms(rt)
		if suspended {
			_, e = resumeDM(v.DM)
			if e != nil {
				return out, e
			}
			suspended = false
		}
	}
	sf, e := os.Open(snap)
	if e != nil {
		return out, e
	}
	defer sf.Close()
	for _, rg := range ranges {
		out.ChangedBytes += rg.Length
	}
	pending := map[string][]byte{}
	out.ParentRoot = v.Root
	out.Tree = tree
	r.Tree = tree
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
	if out.ChangedChunks == 0 && tree == v.Tree && v.Root != "" {
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
	e = m.objects().Record(ctx, v.Lineage, out.Root, "root", nil)
	if e == nil {
		e = m.Refs.RecordTree(v.Lineage, tree, out.Root)
	}
	if e != nil {
		return out, e
	}
	v.pendingRanges = nil
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
	Root           string  `json:"root"`
	Tree           string  `json:"tree"`
	Chunks         int     `json:"chunks"`
	UploadedChunks int     `json:"uploadedChunks"`
	ImportMs       float64 `json:"importMs"`
}

func (m *Manager) Import(ctx context.Context, q ImportRequest) (out ImportResult, err error) {
	t := time.Now()
	if q.Lineage == "" || q.Tree != "" && !root.Hex(q.Tree, 40) || !filepath.IsAbs(q.Path) {
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
	if e = m.objects().Record(ctx, q.Lineage, out.Root, "root", nil); e != nil {
		return out, e
	}
	if e = m.Refs.RecordTree(q.Lineage, q.Tree, out.Root); e != nil {
		return out, e
	}
	out.ImportMs = ms(t)
	return out, nil
}

func (v Checkpoint) timingFields() map[string]float64 {
	return map[string]float64{"walkMs": v.WalkMs, "streamMs": v.StreamMs, "freezeMs": v.FreezeMs, "reflinkMs": v.ReflinkMs, "fiemapMs": v.FiemapMs, "hashMs": v.HashMs, "uploadMs": v.UploadMs, "imageMs": v.ImageMs, "wallMs": v.WallMs, "publishMs": v.PublishMs}
}
func (v *Checkpoint) RefreshTimings() { v.Timings = v.timingFields() }
