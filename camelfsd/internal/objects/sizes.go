package objects

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// SizedTree supplies the same entries as ReadTree, including stored sizes.
// New trees publish a sidecar in the same upload wave as their Git bytes.
// Pre-sidecar trees recover sizes from the local blob index, or a verified
// blob GET on a cold cache. Neither path performs a blob HEAD.
func (r *Repository) SizedTree(ctx context.Context, id string) ([]Entry, error) {
	es, e := r.ReadTree(ctx, id)
	if e != nil {
		return nil, e
	}
	b, e := r.Store.Get(ctx, "ts/"+id)
	if e == nil {
		var sizes []Entry
		if e = json.Unmarshal(b, &sizes); e != nil {
			return nil, e
		}
		if len(es) != len(sizes) {
			return nil, fmt.Errorf("corrupt tree sizes")
		}
		for i := range es {
			if es[i].Path != sizes[i].Path || es[i].Mode != sizes[i].Mode || es[i].SHA1 != sizes[i].SHA1 || sizes[i].Size < 0 {
				return nil, fmt.Errorf("corrupt tree sizes")
			}
			es[i].Size = sizes[i].Size
		}
		return es, nil
	}
	if !errors.Is(e, os.ErrNotExist) {
		return nil, e
	}
	return r.fillSizes(ctx, es)
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
			b, e := r.Store.Get(ctx, "o/"+es[i].SHA1)
			if e != nil {
				return nil, e
			}
			if store.GitHash("blob", b) != es[i].SHA1 {
				return nil, fmt.Errorf("corrupt blob")
			}
			size = int64(len(b))
		}
		es[i].Size = size
	}
	return es, nil
}
