package objects

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// SizedTree supplies the same entries as ReadTree, including stored sizes.
// Its sidecar is required: reads never recover sizes from blob metadata or data.
func (r *Repository) SizedTree(ctx context.Context, id string) ([]Entry, error) {
	if !root.Hex(id, 40) {
		return nil, apierr.Invalid("invalid tree id")
	}
	// Authorize the tree before consulting either shared content cache.
	if r.lineage != "" {
		ok, err := r.Reachable(ctx, r.lineage, id, "tree")
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, os.ErrNotExist
		}
	}
	r.observe("tree")
	var tree []byte
	var treeErr error
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		tree, treeErr = r.objectBytes(ctx, id, "tree")
	}()
	b, cold, err := r.treeSizesBytes(ctx, id)
	wg.Wait()
	if treeErr != nil {
		return nil, treeErr
	}
	es, errTree := decodeTree(tree)
	if errTree != nil {
		return nil, errTree
	}
	if err != nil {
		return nil, err
	}
	var sizes []Entry
	if store.VerifyTreeSizes(id, b) != nil || json.Unmarshal(b, &sizes) != nil || len(es) != len(sizes) {
		return nil, fmt.Errorf("corrupt tree sizes")
	}
	for i := range es {
		if es[i].Path != sizes[i].Path || es[i].Mode != sizes[i].Mode || es[i].SHA1 != sizes[i].SHA1 || sizes[i].Size < 0 {
			return nil, fmt.Errorf("corrupt tree sizes")
		}
		es[i].Size = sizes[i].Size
	}
	if cold {
		if e := cacheTreeSizes(ctx, r.DB.DB, id, b); e != nil {
			return nil, e
		}
	}
	return es, nil
}

func (r *Repository) treeSizesBytes(ctx context.Context, id string) ([]byte, bool, error) {
	var b []byte
	e := r.DB.DB.QueryRowContext(ctx, "SELECT bytes FROM tree_sizes WHERE id=?", id).Scan(&b)
	cold := e == sql.ErrNoRows
	if cold {
		b, e = r.Store.Get(ctx, "ts/"+id)
		if errors.Is(e, os.ErrNotExist) {
			return nil, false, &MissingTreeSizes{Tree: id}
		}
	}
	return b, cold, e
}

func cacheTreeSizes(ctx context.Context, db sqlExecutor, id string, b []byte) error {
	_, e := db.ExecContext(ctx, "INSERT OR IGNORE INTO tree_sizes VALUES(?,?,?)", id, b, time.Now().UnixMilli())
	return e
}

func (r *Repository) fillSizes(ctx context.Context, es []Entry) ([]Entry, error) {
	for i := range es {
		if es[i].Mode == "40000" {
			es[i].Size = 0
			continue
		}
		var size int64
		e := r.DB.DB.QueryRowContext(ctx, "SELECT size FROM lineage_blobs WHERE lineage=? AND sha1=?", r.lineage, es[i].SHA1).Scan(&size)
		if e != nil && e != sql.ErrNoRows {
			return nil, e
		}
		if e == sql.ErrNoRows {
			info, e := r.Store.Head(ctx, "o/"+es[i].SHA1)
			if e != nil {
				return nil, e
			}
			if info.Size < 0 {
				return nil, fmt.Errorf("invalid blob size %s", es[i].SHA1)
			}
			size = info.Size
		}
		es[i].Size = size
	}
	return es, nil
}

// MissingTreeSizes is an invariant failure, not an unavailable object store.
type MissingTreeSizes struct{ Tree string }

func (e *MissingTreeSizes) Error() string { return "missing tree sizes " + e.Tree }
