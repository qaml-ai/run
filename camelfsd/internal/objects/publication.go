package objects

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type cachedObject struct {
	kind  string
	bytes []byte
}
type publication struct {
	puts         map[string][]byte
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
	written, err := uploaded.PutBatch(ctx, p.puts)
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
