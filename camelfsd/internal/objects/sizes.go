package objects

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
)

// SizedTree supplies the same entries as ReadTree, including stored sizes.
// Its sidecar is required: reads never recover sizes from blob metadata or data.
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
	return nil, &MissingTreeSizes{Tree: id}
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
