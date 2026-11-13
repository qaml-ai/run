package objects

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// SizedTree supplies the same entries as ReadTree, including stored sizes.
// Its sidecar is required: reads never recover sizes from blob metadata or data.
func (r *Repository) SizedTree(ctx context.Context, id string) ([]Entry, error) {
	es, e := r.ReadTree(ctx, id)
	if e != nil {
		return nil, e
	}
	var b []byte
	e = r.DB.DB.QueryRowContext(ctx, "SELECT bytes FROM tree_sizes WHERE id=?", id).Scan(&b)
	cold := e == sql.ErrNoRows
	if cold {
		b, e = r.Store.Get(ctx, "ts/"+id)
		if errors.Is(e, os.ErrNotExist) {
			return nil, &MissingTreeSizes{Tree: id}
		}
	}
	if e != nil {
		return nil, e
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
		if e = r.cacheTreeSizes(ctx, id, b); e != nil {
			return nil, e
		}
	}
	return es, nil
}

func (r *Repository) cacheTreeSizes(ctx context.Context, id string, b []byte) error {
	_, e := r.DB.DB.ExecContext(ctx, "INSERT OR IGNORE INTO tree_sizes VALUES(?,?,?)", id, b, time.Now().UnixMilli())
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
