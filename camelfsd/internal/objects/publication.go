package objects

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type cachedObject struct {
	kind  string
	bytes []byte
}
type publication struct {
	puts         map[string][]byte
	blobs        map[string][]byte
	onBlob       func(context.Context, Blob) error
	objects      map[string]cachedObject
	memberships  []membership
	tree, parent string
}

// BeginPublication shares one upload wave across tree construction and commit
// encoding. Cache authorization is published only after every PUT succeeds.
func (r *Repository) BeginPublication() *Repository {
	if r.publication != nil {
		return r
	}
	batch := *r
	batch.publication = &publication{puts: map[string][]byte{}, objects: map[string]cachedObject{}}
	return &batch
}

// StageSizedTree queues a Git-ordered tree and its already sized entries.
func (r *Repository) StageSizedTree(ctx context.Context, entries []Entry) (string, error) {
	var buf bytes.Buffer
	for _, entry := range entries {
		fmt.Fprintf(&buf, "%s %s\x00", entry.Mode, entry.Path)
		raw, _ := hex.DecodeString(entry.SHA1)
		buf.Write(raw)
	}
	b := buf.Bytes()
	if b == nil {
		b = []byte{}
	}
	id := store.GitHash("tree", b)
	sizes, err := json.Marshal(entries)
	if err != nil {
		return "", err
	}
	r.publication.puts["t/"+id] = b
	r.publication.puts["ts/"+id] = sizes
	r.publication.objects[id] = cachedObject{"tree", b}
	return id, r.Record(ctx, r.lineage, id, "tree", nil)
}

// StageBlob provides the builder with a size and ID before publication.
func (r *Repository) StageBlob(raw []byte) Blob {
	id := store.GitHash("blob", raw)
	if r.publication.blobs == nil {
		r.publication.blobs = make(map[string][]byte)
	}
	r.publication.blobs[id] = raw
	return Blob{SHA1: id, Size: int64(len(raw))}
}

func (r *Repository) OnBlobUpload(callback func(context.Context, Blob) error) {
	r.publication.onBlob = callback
}

func (r *Repository) flushBlobs(ctx context.Context) error {
	p := r.publication
	ids := make([]string, 0, len(p.blobs))
	for id := range p.blobs {
		ids = append(ids, id)
	}
	repo := *r
	repo.publication = nil
	return store.Parallel(ctx, min(16, len(ids)), ids, func(id string) error {
		raw := p.blobs[id]
		blob, err := repo.Upload(ctx, repo.lineage, root.Hash(raw), int64(len(raw)), bytes.NewReader(raw))
		if err == nil && p.onBlob != nil {
			err = p.onBlob(ctx, blob)
		}
		return err
	})
}

func (r *Repository) StageTreeParent(tree, parent string) {
	r.publication.tree, r.publication.parent = tree, parent
}

type FlushTiming struct {
	Put, Cache time.Duration
	PutKeys    int
}

func (r *Repository) Flush(ctx context.Context) error {
	return r.FlushTimed(ctx, &FlushTiming{})
}

func (r *Repository) FlushTimed(ctx context.Context, timing *FlushTiming) error {
	p := r.publication
	if p == nil {
		return nil
	}
	for key := range p.puts {
		if id, ok := strings.CutPrefix(key, "t/"); ok {
			if _, ok := p.puts["ts/"+id]; !ok {
				return fmt.Errorf("missing tree sizes %s", id)
			}
		}
	}
	start := time.Now()
	uploaded := &store.Uploaded{Store: r.Store, DB: r.DB.DB}
	var wg sync.WaitGroup
	var blobErr error
	if len(p.blobs) != 0 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			blobErr = r.flushBlobs(ctx)
		}()
	}
	written, err := uploaded.PutBatch(ctx, p.puts)
	wg.Wait()
	err = errors.Join(err, blobErr)
	timing.Put = time.Since(start)
	timing.PutKeys = len(written)
	if err != nil {
		return err
	}

	start = time.Now()
	defer func() { timing.Cache = time.Since(start) }()
	// Import can queue reused trees. Resolve those before opening the
	// transaction, and include any recovered membership in that transaction.
	var memberships []membership
	for _, v := range p.memberships {
		if _, written := p.puts[kindKey(v.Kind, v.ID)]; written {
			memberships = append(memberships, v)
			continue
		}
		ok, found, err := r.checkMembership(ctx, v.Lineage, v.ID, v.Kind)
		if err != nil {
			return err
		}
		if !ok {
			return os.ErrNotExist
		}
		if found != nil {
			memberships = append(memberships, *found)
		}
	}
	tx, err := r.DB.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	at := time.Now().UnixMilli()
	for id, obj := range p.objects {
		if _, err := tx.ExecContext(ctx, "INSERT OR REPLACE INTO objects VALUES(?,?,?,?,?)", id, obj.kind, obj.bytes, len(obj.bytes), at); err != nil {
			return err
		}
	}
	for key, b := range p.puts {
		if id, ok := strings.CutPrefix(key, "ts/"); ok {
			if err := cacheTreeSizes(ctx, tx, id, b); err != nil {
				return err
			}
		}
	}
	for _, v := range memberships {
		if err := cacheMembership(ctx, tx, v); err != nil {
			return err
		}
	}
	for _, key := range written {
		if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO uploaded VALUES(?,?)", key, at); err != nil {
			return err
		}
	}
	if p.parent != "" {
		if err := r.DB.RecordTreeParentTx(ctx, tx, p.tree, p.parent); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	*p = publication{puts: map[string][]byte{}, objects: map[string]cachedObject{}}
	return nil
}
