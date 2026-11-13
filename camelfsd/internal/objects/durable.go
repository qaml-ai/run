package objects

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"strings"
	"time"
)

// Lineage rows cache successful writes or HEADs under the lineage prefix.
// Store existence is authoritative; SQLite is never a second durable catalog.
type membership struct {
	Lineage, ID, Kind string
	Blob              *Blob
}

func kindKey(kind, id string) string {
	prefix := map[string]string{"blob": "o", "tree": "t", "commit": "k", "root": "r", "chunk": "c"}[kind]
	return prefix + "/" + id
}
func (r *Repository) ForLineage(l string) *Repository {
	scoped := *r
	scoped.lineage = l
	scoped.Store = store.ForLineage(r.Store, l)
	return &scoped
}
func (r *Repository) Record(ctx context.Context, l, id, kind string, b *Blob) error {
	r = r.ForLineage(l)
	if r.publication != nil {
		r.publication.memberships = append(r.publication.memberships, membership{l, id, kind, b})
		return nil
	}
	ok, e := r.Reachable(ctx, l, id, kind)
	if e == nil && !ok {
		return os.ErrNotExist
	}
	return e
}
func (r *Repository) cacheMembership(ctx context.Context, v membership) error {
	if v.Blob != nil {
		b := v.Blob
		if _, e := r.DB.DB.ExecContext(ctx, "INSERT OR IGNORE INTO lineage_blobs VALUES(?,?,?,?,?)", v.Lineage, b.SHA256, b.SHA1, b.Size, time.Now().UnixMilli()); e != nil {
			return e
		}
	}
	_, e := r.DB.DB.ExecContext(ctx, "INSERT OR IGNORE INTO lineage_objects VALUES(?,?,?,?)", v.Lineage, v.ID, v.Kind, time.Now().UnixMilli())
	return e
}
func (r *Repository) Reachable(ctx context.Context, l, id, kind string) (bool, error) {
	var n int
	query := "SELECT 1 FROM lineage_objects WHERE lineage=? AND id=? AND kind=?"
	if kind == "blob" {
		query += " AND EXISTS (SELECT 1 FROM lineage_blobs WHERE lineage=lineage_objects.lineage AND sha1=lineage_objects.id)"
	}
	e := r.DB.DB.QueryRowContext(ctx, query, l, id, kind).Scan(&n)
	if e == nil {
		return true, nil
	}
	if e != sql.ErrNoRows {
		return false, e
	}
	r = r.ForLineage(l)
	info, e := r.Store.Head(ctx, kindKey(kind, id))
	if errors.Is(e, os.ErrNotExist) {
		return false, nil
	}
	if e != nil {
		return false, e
	}
	v := membership{Lineage: l, ID: id, Kind: kind}
	if kind == "blob" {
		if !root.Hex(info.SHA256, 64) {
			return false, fmt.Errorf("invalid blob metadata")
		}
		v.Blob = &Blob{SHA1: id, SHA256: info.SHA256, Size: info.Size}
	}
	return true, r.cacheMembership(ctx, v)
}
func (r *Repository) PutObject(ctx context.Context, l, kind string, b []byte) (string, error) {
	r = r.ForLineage(l)
	batch := r.BeginPublication()
	id := store.GitHash(kind, b)
	key := "t/"
	if kind == "commit" {
		key = "k/"
	}
	batch.publication.puts[key+id] = b
	batch.publication.objects[id] = cachedObject{kind, b}
	if e := batch.Record(ctx, l, id, kind, nil); e != nil {
		return "", e
	}
	if r.publication == nil {
		if e := batch.Flush(ctx); e != nil {
			return "", e
		}
	}
	return id, nil
}
func (r *Repository) Object(ctx context.Context, id, kind string) ([]byte, error) {
	if r.lineage != "" {
		ok, e := r.Reachable(ctx, r.lineage, id, kind)
		if e != nil {
			return nil, e
		}
		if !ok {
			return nil, os.ErrNotExist
		}
	}
	var b []byte
	e := r.DB.DB.QueryRowContext(ctx, "SELECT bytes FROM objects WHERE id=? AND kind=?", id, kind).Scan(&b)
	if e != nil && e != sql.ErrNoRows {
		return nil, e
	}
	if b == nil {
		key := "t/"
		if kind == "commit" {
			key = "k/"
		}
		b, e = r.Store.Get(ctx, key+id)
		if e != nil {
			return nil, e
		}
	}
	if store.GitHash(kind, b) != id {
		return nil, fmt.Errorf("corrupt %s", kind)
	}
	_, e = r.DB.DB.ExecContext(ctx, "INSERT OR REPLACE INTO objects VALUES(?,?,?,?,?)", id, kind, b, len(b), time.Now().UnixMilli())
	return b, e
}
func (r *Repository) ReadTree(ctx context.Context, id string) ([]Entry, error) {
	return r.read(ctx, id)
}
func (r *Repository) BlobInfo(ctx context.Context, l, id string) (Blob, error) {
	ok, e := r.Reachable(ctx, l, id, "blob")
	if e != nil {
		return Blob{}, e
	}
	if !ok {
		return Blob{}, sql.ErrNoRows
	}
	var b Blob
	e = r.DB.DB.QueryRowContext(ctx, "SELECT sha256,sha1,size FROM lineage_blobs WHERE lineage=? AND sha1=?", l, id).Scan(&b.SHA256, &b.SHA1, &b.Size)
	return b, e
}

// BlobInfos reads lineage metadata in bounded batches rather than per file.
// Missing rows are recovered from durable membership before a single re-query.
func (r *Repository) BlobInfos(ctx context.Context, l string, ids []string) (map[string]Blob, error) {
	unique := []string{}
	seen := map[string]bool{}
	for _, id := range ids {
		if !seen[id] {
			unique = append(unique, id)
			seen[id] = true
		}
	}
	out := map[string]Blob{}
	query := func(batch []string) error {
		args := []any{l}
		marks := make([]string, len(batch))
		for i, id := range batch {
			args = append(args, id)
			marks[i] = "?"
		}
		r.observe("lineage-blobs")
		rows, e := r.DB.DB.QueryContext(ctx, "SELECT sha256,sha1,size FROM lineage_blobs WHERE lineage=? AND sha1 IN ("+strings.Join(marks, ",")+")", args...)
		if e != nil {
			return e
		}
		defer rows.Close()
		for rows.Next() {
			var b Blob
			if e = rows.Scan(&b.SHA256, &b.SHA1, &b.Size); e != nil {
				return e
			}
			out[b.SHA1] = b
		}
		return rows.Err()
	}
	for start := 0; start < len(unique); start += 500 {
		batch := unique[start:min(start+500, len(unique))]
		if e := query(batch); e != nil {
			return nil, e
		}
		missing := []string{}
		for _, id := range batch {
			if _, ok := out[id]; !ok {
				missing = append(missing, id)
			}
		}
		if len(missing) > 0 {
			if e := store.Parallel(ctx, 64, missing, func(id string) error {
				ok, e := r.Reachable(ctx, l, id, "blob")
				if e != nil {
					return e
				}
				if !ok {
					return sql.ErrNoRows
				}
				return nil
			}); e != nil {
				return nil, e
			}
			if e := query(missing); e != nil {
				return nil, e
			}
		}
	}
	return out, nil
}
