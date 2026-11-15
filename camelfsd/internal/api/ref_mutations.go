package api

import (
	"context"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"math"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

type refWriteChange struct {
	change
	Text, Base64, ExpectBlob *string
}

type refWriteRequest struct {
	commitMetadata
	Expect  *string
	Changes []refWriteChange
	Quota   *quotaRequest
}

type refMergeRequest struct {
	commitMetadata
	Theirs, Mode string
	Quota        *quotaRequest
}

type refRestoreRequest struct {
	Author, Version string
	Message         *string
	Time            *int64
	Trailers        map[string]string
	Quota           *quotaRequest
}

type writeDiff struct {
	Path    string `json:"path"`
	Status  string `json:"status"`
	OldBlob string `json:"oldBlob,omitempty"`
	NewBlob string `json:"newBlob,omitempty"`
	OldSize *int64 `json:"oldSize,omitempty"`
	NewSize *int64 `json:"newSize,omitempty"`
	Mode    string `json:"mode"`
}

func (m *commitMetadata) refOperation(op string) error {
	if m.Time == nil {
		return invalid("time is required")
	}
	if m.Trailers == nil {
		m.Trailers = make(map[string]string)
	}
	if _, present := m.Trailers["Camel-Op"]; !present {
		m.Trailers["Camel-Op"] = op
	}
	return m.validate()
}

func (s *StorageServer) writableHead(ctx context.Context, l, name string) (refstore.Ref, error) {
	start := time.Now()
	defer func() { refTimingFrom(ctx).head += time.Since(start) }()
	head, err := s.refs.Get(ctx, l, name)
	if err == nil && head.Holder != nil && head.LeaseDeadline != nil && *head.LeaseDeadline > s.lineages.now().UnixMilli() {
		return head, &storageError{409, "held", nil}
	}
	return head, err
}

// refTiming accumulates the access-log phases across both write attempts.
type refTiming struct {
	objects                            objects.FlushTiming
	build, ddb, head, diff, usage, cas time.Duration
	treeRead                           commitTiming
	retries                            int
}

func (t *refTiming) addFlush(flushed objects.FlushTiming) {
	t.objects.Put += flushed.Put
	t.objects.PutKeys += flushed.PutKeys
	t.objects.UploadCache += flushed.UploadCache
}

type refTimingKey struct{}

func refTimingFrom(ctx context.Context) *refTiming {
	if t, ok := ctx.Value(refTimingKey{}).(*refTiming); ok {
		return t
	}
	return &refTiming{}
}

func (s *StorageServer) moveHead(ctx context.Context, head refstore.Ref, kind, version, tree string, parents []string, q *quotaRequest, snapshot *refstore.Usage) (int64, error) {
	var bytes int64
	timing := refTimingFrom(ctx)
	start := time.Now()
	defer func() { timing.ddb += time.Since(start) }()
	_, err := s.refs.Cas(ctx, head.Lineage, head.Name, refstore.Move{
		Kind: kind, Version: version, Tree: tree, Parents: parents, Expect: &head.Version, RequireExisting: true, APIWrite: true, Known: &head,
		ObserveTransaction: func(elapsed time.Duration) { timing.cas += elapsed },
		Prepare: func(refstore.Ref) error {
			var usage refstore.Usage
			var err error
			if snapshot != nil {
				usage = *snapshot
			} else {
				start := time.Now()
				usage, err = s.refs.ReadUsage(ctx, head.Lineage)
				timing.usage += time.Since(start)
				if err != nil {
					return err
				}
			}
			bytes, err = s.checkQuota(ctx, head.Lineage, q, usage)
			return err
		},
	})
	return bytes, err
}

func parseWriteChanges(edits []refWriteChange) ([]change, [][]byte, []string, error) {
	if edits == nil {
		return nil, nil, nil, invalid("changes is required")
	}
	if len(edits) > 10000 {
		return nil, nil, nil, large("")
	}
	changes := make([]change, len(edits))
	inline := make([][]byte, len(edits))
	var ids []string
	total := 0
	for i, edit := range edits {
		c := edit.change
		if err := objects.Path(c.Path); err != nil {
			return nil, nil, nil, err
		}
		if edit.ExpectBlob != nil && *edit.ExpectBlob != "none" && !root.Hex(*edit.ExpectBlob, 40) {
			return nil, nil, nil, invalid("expectBlob must be a Git id or none")
		}
		hasInline := edit.Text != nil || edit.Base64 != nil
		if (edit.Text != nil && edit.Base64 != nil) || (hasInline && c.Blob != "") ||
			(c.Delete && (hasInline || c.Blob != "" || c.Mode != "")) {
			return nil, nil, nil, invalid("invalid content sources for path %q", c.Path)
		}
		switch {
		case edit.Text != nil:
			inline[i] = []byte(*edit.Text)
		case edit.Base64 != nil:
			var err error
			if strings.ContainsAny(*edit.Base64, "\r\n") {
				return nil, nil, nil, invalid("invalid base64 for path %q", c.Path)
			}
			inline[i], err = base64.StdEncoding.DecodeString(*edit.Base64)
			if err != nil {
				return nil, nil, nil, invalid("invalid base64 for path %q", c.Path)
			}
		case c.Blob != "":
			if !root.Hex(c.Blob, 40) {
				return nil, nil, nil, invalid("blob must be a Git id")
			}
			ids = append(ids, c.Blob)
		}
		total += len(inline[i])
		if total > 8<<20 {
			return nil, nil, nil, large("")
		}
		changes[i] = c
	}
	return changes, inline, ids, nil
}

func (s *StorageServer) refWrite(w http.ResponseWriter, r *http.Request, l, name string, repo *objects.Repository) error {
	ctx := r.Context()
	var q refWriteRequest
	if err := decodeStorage(r, &q); err != nil {
		return err
	}
	if err := q.refOperation("api"); err != nil {
		return err
	}
	if err := q.Quota.validate(); err != nil {
		return err
	}
	if q.Expect != nil && !root.Hex(*q.Expect, 40) {
		return invalid("expect must be a Git id")
	}
	changes, inline, ids, err := parseWriteChanges(q.Changes)
	if err != nil {
		return err
	}
	timing := refTimingFrom(ctx)
	for attempt := range 2 {
		head, err := s.writableHead(ctx, l, name)
		if err != nil {
			return err
		}
		if q.Expect != nil && *q.Expect != head.Version {
			return &storageError{412, "stale", map[string]string{"current": head.Version}}
		}
		dir, paths := commitPaths(changes, head.Tree)
		if len(changes) != 0 {
			if err := dir.read(ctx, repo, &timing.treeRead); err != nil {
				return err
			}
		}
		for i, edit := range q.Changes {
			if edit.ExpectBlob == nil {
				continue
			}
			p := paths[i]
			actual := p.dir.files[p.name].SHA1
			expect := *edit.ExpectBlob
			if expect == "none" {
				expect = ""
			}
			if actual != expect {
				var blob any
				if actual != "" {
					blob = actual
				}
				return &storageError{412, "stale", map[string]any{"current": head.Version, "path": edit.Path, "blob": blob}}
			}
		}
		blobs, err := repo.BlobInfos(ctx, l, ids)
		if err != nil {
			return err
		}
		batch := repo.BeginPublication()
		edits := append([]change(nil), changes...)
		for i, raw := range inline {
			if raw != nil {
				blob := batch.StageBlob(raw)
				edits[i].Blob = blob.SHA1
				// Keep explicit references subject to lineage membership even if
				// the request also contains inline bytes with that hash.
				if found, supplied := blobs[blob.SHA1]; supplied && found.Err != nil {
					if errors.Is(found.Err, sql.ErrNoRows) {
						return bad("unknown_blob")
					}
					return found.Err
				}
				blobs[blob.SHA1] = objects.BlobLookup{Blob: blob}
			}
		}
		if _, _, err := applyCommitChanges(paths, edits, blobs); err != nil {
			return err
		}
		built := time.Now()
		tree, err := dir.build(ctx, batch, true)
		if err != nil {
			return err
		}
		if tree != head.Tree {
			batch.StageTreeParent(tree, head.Tree)
		}
		parents := []string{head.Version}
		version, timestamp, err := q.stage(ctx, batch, l, tree, parents)
		if err != nil {
			return err
		}
		timing.build += time.Since(built)
		var flushed objects.FlushTiming
		usage, err := s.flushRefWrite(ctx, l, batch, &flushed)
		timing.addFlush(flushed)
		if err != nil {
			return err
		}
		diff, err := refTreeDiff(ctx, repo, head.Tree, tree)
		if err != nil {
			return err
		}
		changed := make([]writeDiff, 0, len(diff))
		for _, d := range diff {
			mode := d.NewMode
			if mode == "" {
				mode = d.OldMode
			}
			changed = append(changed, writeDiff{d.Path, d.Status, d.OldBlob, d.NewBlob, d.OldSize, d.NewSize, mode})
		}
		files, err := refTreeFileCount(ctx, repo, tree)
		if err != nil {
			return err
		}
		bytes, err := s.moveHead(ctx, head, "commit", version, tree, parents, q.Quota, &usage)
		var failure *refstore.Error
		if attempt == 0 && q.Expect == nil && errors.As(err, &failure) && failure.Code == "stale" {
			timing.retries++
			continue
		}
		if err != nil {
			return err
		}
		jsonReply(w, 201, map[string]any{"version": version, "tree": tree, "parents": parents, "time": timestamp,
			"changed": changed, "bytes": bytes, "files": files})
		return nil
	}
	panic("unreachable write retry")
}

func (s *StorageServer) flushRefWrite(ctx context.Context, lineage string, batch *objects.Repository, flushed *objects.FlushTiming) (refstore.Usage, error) {
	var usage refstore.Usage
	var usageErr error
	usageDone := make(chan struct{})
	var usageTime time.Duration
	go func() {
		defer close(usageDone)
		start := time.Now()
		usage, usageErr = s.refs.ReadUsage(ctx, lineage)
		usageTime = time.Since(start)
	}()

	var createdBytes atomic.Int64
	batch.OnBlobUpload(func(ctx context.Context, blob objects.Blob) error {
		<-usageDone
		// Account for successful uploads even if the usage read failed.
		if err := s.countUpload(ctx, lineage, blob); err != nil {
			return err
		}
		createdBytes.Add(writtenBytes(blob))
		return nil
	})
	err := batch.FlushTimed(ctx, flushed)
	<-usageDone
	refTimingFrom(ctx).usage += usageTime
	if err != nil {
		return refstore.Usage{}, err
	}
	if usageErr != nil {
		return refstore.Usage{}, usageErr
	}
	// The read precedes every addition for this attempt. Fold those bytes
	// into the snapshot exactly once, after their durable accounting.
	created := createdBytes.Load()
	if usage.WrittenSince > math.MaxInt64-created {
		return refstore.Usage{}, fmt.Errorf("lineage usage overflows int64")
	}
	usage.WrittenSince += created
	return usage, nil
}

func (s *StorageServer) refMerge(w http.ResponseWriter, r *http.Request, l, name string, repo *objects.Repository) error {
	ctx := r.Context()
	var q refMergeRequest
	if err := decodeStorage(r, &q); err != nil {
		return err
	}
	if q.Mode != "merge" && q.Mode != "squash" && q.Mode != "ff-only" {
		return invalid("mode must be merge, squash or ff-only")
	}
	if err := q.refOperation("merge"); err != nil {
		return err
	}
	if err := q.Quota.validate(); err != nil {
		return err
	}
	head, err := s.writableHead(ctx, l, name)
	if err != nil {
		return err
	}
	theirs, err := loadRefCommit(ctx, repo, q.Theirs)
	if err != nil {
		return err
	}
	if q.Mode != "squash" {
		err = s.refs.CheckFastForward(ctx, l, head.Version, q.Theirs)
		if err == nil {
			diff, err := refTreeDiff(ctx, repo, head.Tree, theirs.tree)
			if err != nil {
				return err
			}
			bytes, err := s.moveHead(ctx, head, "move", q.Theirs, theirs.tree, theirs.parents, q.Quota, nil)
			if err != nil {
				return err
			}
			files, err := refTreeFileCount(ctx, repo, theirs.tree)
			if err != nil {
				return err
			}
			jsonReply(w, 201, map[string]any{"version": q.Theirs, "tree": theirs.tree, "ff": true,
				"merged": []string{}, "took": mergeTook{Theirs: len(diff)}, "bytes": bytes, "files": files})
			return nil
		}
		var failure *refstore.Error
		if q.Mode == "ff-only" || !errors.As(err, &failure) || failure.Code != "not_fast_forward" || failure.Details["reason"] == "too_deep" {
			return err
		}
	}
	best, baseTree, err := mergeBase(ctx, repo, head.Version, q.Theirs)
	if err != nil {
		return err
	}
	batch := repo.BeginPublication()
	batch.OnBlobUpload(func(ctx context.Context, blob objects.Blob) error { return s.countUpload(ctx, l, blob) })
	result, err := stageMerge(ctx, batch, l, mergeRequest{Base: baseTree, Ours: head.Tree, Theirs: theirs.tree, Mode: q.Mode}, best == "")
	if err != nil {
		return err
	}
	parents := []string{head.Version}
	if q.Mode == "merge" {
		parents = append(parents, q.Theirs)
	}
	version, _, err := q.stage(ctx, batch, l, result.Tree, parents)
	if err != nil {
		return err
	}
	var flushed objects.FlushTiming
	err = batch.FlushTimed(ctx, &flushed)
	refTimingFrom(ctx).addFlush(flushed)
	if err != nil {
		return err
	}
	bytes, err := s.moveHead(ctx, head, "commit", version, result.Tree, parents, q.Quota, nil)
	if err != nil {
		return err
	}
	files, err := refTreeFileCount(ctx, repo, result.Tree)
	if err != nil {
		return err
	}
	jsonReply(w, 201, map[string]any{"version": version, "tree": result.Tree, "ff": false, "merged": result.Merged, "took": result.Took,
		"bytes": bytes, "files": files})
	return nil
}

func (s *StorageServer) refRestore(w http.ResponseWriter, r *http.Request, l, name string, repo *objects.Repository) error {
	ctx := r.Context()
	var q refRestoreRequest
	if err := decodeStorage(r, &q); err != nil {
		return err
	}
	metadata := commitMetadata{Author: q.Author, Message: q.Message, Time: q.Time, Trailers: q.Trailers}
	if err := metadata.refOperation("restore"); err != nil {
		return err
	}
	if err := q.Quota.validate(); err != nil {
		return err
	}
	head, err := s.writableHead(ctx, l, name)
	if err != nil {
		return err
	}
	target, err := loadRefCommit(ctx, repo, q.Version)
	if err != nil {
		return err
	}
	parents := []string{head.Version}
	version, _, err := metadata.stage(ctx, repo, l, target.tree, parents)
	if err != nil {
		return err
	}
	bytes, err := s.moveHead(ctx, head, "commit", version, target.tree, parents, q.Quota, nil)
	if err != nil {
		return err
	}
	files, err := refTreeFileCount(ctx, repo, target.tree)
	if err != nil {
		return err
	}
	jsonReply(w, 201, map[string]any{"version": version, "tree": target.tree, "bytes": bytes, "files": files})
	return nil
}

func refTreeDiff(ctx context.Context, repo *objects.Repository, from, to string) ([]diffChange, error) {
	start := time.Now()
	defer func() { refTimingFrom(ctx).diff += time.Since(start) }()
	return treeDiff(ctx, repo, from, to, "")
}

func refTreeFileCount(ctx context.Context, repo *objects.Repository, tree string) (int64, error) {
	start := time.Now()
	defer func() { refTimingFrom(ctx).diff += time.Since(start) }()
	return repo.TreeFileCount(ctx, tree)
}
