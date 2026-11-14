package image

import (
	"context"
	"os"
	"strconv"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type Checkpoint struct {
	Timings        map[string]float64 `json:"timings"`
	FilesChanged   int                `json:"filesChanged"`
	BytesReceived  int64              `json:"bytesReceived"`
	WalkMs         float64            `json:"walkMs"`
	StreamMs       float64            `json:"streamMs"`
	FreezeMs       float64            `json:"freezeMs"`
	CommitMs       float64            `json:"-"`
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

func (m *Manager) publishCheckpoint(ctx context.Context, v *Mount, tree string, sf *os.File, ranges []chunk.Range, q CheckpointRequest, publish func(context.Context, Checkpoint) error) (out Checkpoint, err error) {
	t := time.Now()
	r, e := m.mountRoot(ctx, v.Lineage, v.Root)
	if e != nil {
		return out, e
	}
	r, e = m.uploadSnapshot(ctx, v.Lineage, v.Root, r, sf, tree, ranges, &out)
	if e != nil {
		return out, e
	}
	set := v.Parent
	set.Root = out.Root
	set.Tree = tree
	commitStart := time.Now()
	out.Commit, e = m.writeCommit(ctx, v, tree, q)
	if e != nil {
		return out, e
	}
	set.Commit = out.Commit
	out.CommitMs = ms(commitStart)
	if e = m.promote(sf.Name(), out.Root); e != nil {
		return out, e
	}
	if e = ctx.Err(); e != nil {
		return out, e
	}
	e = m.objects(v.Lineage).Record(ctx, v.Lineage, out.Root, "root", nil)
	if e == nil {
		e = m.Refs.RecordTree(v.Lineage, tree, out.Root)
	}
	if e != nil {
		return out, e
	}
	if r.Tree != "" && (out.ChangedChunks != 0 || out.ParentRoot != out.Root) {
		m.shareTreeRoot(ctx, v.Lineage, tree, out.Root)
	}
	if e = publish(ctx, out); e != nil {
		return out, e
	}
	m.protect(v.JobID, r, out.Root)
	v.Parent = set
	v.Root = out.Root
	v.Tree = tree
	v.Promoted = true
	if e = m.save(v); e != nil {
		return out, e
	}
	out.ImageMs = ms(t)
	return out, nil
}

// uploadSnapshot records immutable chunks and the root shared by checkpoints and baselines.
func (m *Manager) uploadSnapshot(ctx context.Context, lineage, parentRoot string, r root.Root, sf *os.File, tree string, ranges []chunk.Range, out *Checkpoint) (root.Root, error) {
	for _, rg := range ranges {
		out.ChangedBytes += rg.Length
	}
	pending := map[string][]byte{}
	out.ParentRoot = parentRoot
	out.Tree = tree
	baseTree := r.Tree
	r.Tree = tree
	r.ParentRoot = parentRoot
	var hashTime, uploadTime time.Duration
	flush := func() error {
		start := time.Now()
		n, err := store.PutChunks(ctx, store.ForLineage(m.Store, lineage), pending)
		out.UploadedChunks += n
		uploadTime += time.Since(start)
		clear(pending)
		return err
	}
	ht := time.Now()
	e := (chunk.Chunker{}).Ranges(sf, r.VirtualSize, ranges, func(o int64, h string, b []byte) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		k := strconv.FormatInt(o, 10)
		if r.Chunks[k] == h {
			return nil
		}
		out.ChangedChunks++
		if h == "" {
			delete(r.Chunks, k)
		} else {
			r.Chunks[k] = h
			if _, ok := pending[h]; !ok {
				pending[h] = append([]byte(nil), b...)
			}
			if len(pending) == 64 {
				return flush()
			}
		}
		return nil
	})
	hashTime = time.Since(ht) - uploadTime
	out.HashMs = float64(hashTime.Microseconds()) / 1000
	if e != nil {
		return r, e
	}
	e = flush()
	if e != nil {
		return r, e
	}
	ut := time.Now()
	if out.ChangedChunks == 0 && tree == baseTree && parentRoot != "" {
		out.Root = parentRoot
	} else {
		b, e := root.Encode(r)
		if e != nil {
			return r, e
		}
		out.Root = root.Hash(b)
		if e = store.ForLineage(m.Store, lineage).Put(ctx, "r/"+out.Root, b); e != nil {
			return r, e
		}
	}

	out.UploadMs = float64(uploadTime.Microseconds())/1000 + ms(ut)
	return r, nil
}

func (v Checkpoint) timingFields() map[string]float64 {
	return map[string]float64{"walkMs": v.WalkMs, "streamMs": v.StreamMs, "freezeMs": v.FreezeMs, "reflinkMs": v.ReflinkMs, "fiemapMs": v.FiemapMs, "hashMs": v.HashMs, "uploadMs": v.UploadMs, "imageMs": v.ImageMs, "wallMs": v.WallMs, "publishMs": v.PublishMs}
}
