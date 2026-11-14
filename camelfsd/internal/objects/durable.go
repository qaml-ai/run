package objects

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
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

type sqlExecutor interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}

func cacheMembership(ctx context.Context, db sqlExecutor, v membership) error {
	if v.Blob != nil {
		b := v.Blob
		if _, e := db.ExecContext(ctx, "INSERT OR IGNORE INTO lineage_blobs VALUES(?,?,?,?,?)", v.Lineage, b.SHA256, b.SHA1, b.Size, time.Now().UnixMilli()); e != nil {
			return e
		}
	}
	_, e := db.ExecContext(ctx, "INSERT OR IGNORE INTO lineage_objects VALUES(?,?,?,?)", v.Lineage, v.ID, v.Kind, time.Now().UnixMilli())
	return e
}
func (r *Repository) Reachable(ctx context.Context, l, id, kind string) (bool, error) {
	ok, found, err := r.checkMembership(ctx, l, id, kind)
	if err == nil && found != nil {
		err = cacheMembership(ctx, r.DB.DB, *found)
	}
	return ok, err
}

// checkMembership returns a row to cache only when durable storage proved it.
func (r *Repository) checkMembership(ctx context.Context, l, id, kind string) (bool, *membership, error) {
	var n int
	query := "SELECT 1 FROM lineage_objects WHERE lineage=? AND id=? AND kind=?"
	if kind == "blob" {
		query += " AND EXISTS (SELECT 1 FROM lineage_blobs WHERE lineage=lineage_objects.lineage AND sha1=lineage_objects.id)"
	}
	e := r.DB.DB.QueryRowContext(ctx, query, l, id, kind).Scan(&n)
	if e == nil {
		return true, nil, nil
	}
	if e != sql.ErrNoRows {
		return false, nil, e
	}
	r = r.ForLineage(l)
	info, e := r.Store.Head(ctx, kindKey(kind, id))
	if errors.Is(e, os.ErrNotExist) {
		return false, nil, nil
	}
	if e != nil {
		return false, nil, e
	}
	v := membership{Lineage: l, ID: id, Kind: kind}
	if kind == "blob" {
		if !root.Hex(info.SHA256, 64) {
			return false, nil, fmt.Errorf("invalid blob metadata")
		}
		v.Blob = &Blob{SHA1: id, SHA256: info.SHA256, Size: info.Size}
	}
	return true, &v, nil
}
func (r *Repository) PutObject(ctx context.Context, l, kind string, b []byte) (string, error) {
	r = r.ForLineage(l)
	batch := r.BeginPublication()
	id := store.GitHash(kind, b)
	key := "t/"
	if kind == "commit" {
		key = "k/"
	}
	if kind == "tree" {
		es, e := decodeTree(b)
		if e != nil {
			return "", e
		}
		es, e = r.fillSizes(ctx, es)
		if e != nil {
			return "", e
		}
		sizes, e := json.Marshal(es)
		if e != nil {
			return "", e
		}
		batch.publication.puts["ts/"+id] = sizes
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
	return r.objectBytes(ctx, id, kind)
}

// objectBytes reads and verifies immutable content after lineage authorization.
func (r *Repository) objectBytes(ctx context.Context, id, kind string) ([]byte, error) {
	var b []byte
	e := r.DB.DB.QueryRowContext(ctx, "SELECT bytes FROM objects WHERE id=? AND kind=?", id, kind).Scan(&b)
	if e != nil && e != sql.ErrNoRows {
		return nil, e
	}
	cold := e == sql.ErrNoRows
	if cold {
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
	if cold {
		_, e = r.DB.DB.ExecContext(ctx, "INSERT OR IGNORE INTO objects VALUES(?,?,?,?,?)", id, kind, b, len(b), time.Now().UnixMilli())
	}
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

type BlobLookup struct {
	Blob Blob
	Err  error
}

// BlobInfos resolves each distinct blob once, preserving per-blob failures so
// callers can apply their own error order after the concurrent HEADs.
func (r *Repository) BlobInfos(ctx context.Context, l string, ids []string) (map[string]BlobLookup, error) {
	out := make(map[string]BlobLookup, len(ids))
	var unique []string
	for _, id := range ids {
		if _, ok := out[id]; !ok {
			unique = append(unique, id)
			out[id] = BlobLookup{}
		}
	}
	var missing []string
	for start := 0; start < len(unique); start += 500 {
		batch := unique[start:min(start+500, len(unique))]
		if e := r.queryBlobInfos(ctx, l, batch, out); e != nil {
			return nil, e
		}
		for _, id := range batch {
			if out[id].Blob.SHA1 == "" {
				missing = append(missing, id)
			}
		}
	}
	if len(missing) == 0 {
		return out, nil
	}

	type lookup struct {
		membership *membership
		err        error
	}
	results := make([]lookup, len(missing))
	indices := make(map[string]int, len(missing))
	for i, id := range missing {
		indices[id] = i
	}
	if e := store.Parallel(ctx, min(64, len(missing)), missing, func(id string) error {
		ok, found, err := r.checkMembership(ctx, l, id, "blob")
		if err == nil && !ok {
			err = sql.ErrNoRows
		}
		results[indices[id]] = lookup{found, err}
		return nil
	}); e != nil {
		return nil, e
	}

	// A concurrent request may already have cached a blob since the first
	// lookup. Re-query those ids together, and cache newly recovered rows.
	var recheck []string
	var recovered []membership
	for i, id := range missing {
		result := results[i]
		switch {
		case result.err != nil:
			out[id] = BlobLookup{Err: result.err}
		case result.membership != nil:
			recovered = append(recovered, *result.membership)
			out[id] = BlobLookup{Blob: *result.membership.Blob}
		default:
			out[id] = BlobLookup{Err: sql.ErrNoRows}
			recheck = append(recheck, id)
		}
	}
	if len(recovered) > 0 {
		tx, err := r.DB.DB.BeginTx(ctx, nil)
		if err != nil {
			return nil, err
		}
		defer tx.Rollback()
		for _, found := range recovered {
			if err := cacheMembership(ctx, tx, found); err != nil {
				return nil, err
			}
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}
	}
	for start := 0; start < len(recheck); start += 500 {
		if err := r.queryBlobInfos(ctx, l, recheck[start:min(start+500, len(recheck))], out); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (r *Repository) queryBlobInfos(ctx context.Context, l string, batch []string, out map[string]BlobLookup) error {
	args := []any{l}
	marks := make([]string, len(batch))
	for i, id := range batch {
		args = append(args, id)
		marks[i] = "?"
	}
	r.observe("lineage-blobs")
	rows, e := r.DB.DB.QueryContext(ctx, `SELECT b.sha256,b.sha1,b.size FROM lineage_blobs b
JOIN lineage_objects o ON o.lineage=b.lineage AND o.id=b.sha1 AND o.kind='blob'
WHERE b.lineage=? AND b.sha1 IN (`+strings.Join(marks, ",")+")", args...)
	if e != nil {
		return e
	}
	defer rows.Close()
	for rows.Next() {
		var b Blob
		if e = rows.Scan(&b.SHA256, &b.SHA1, &b.Size); e != nil {
			return e
		}
		out[b.SHA1] = BlobLookup{Blob: b}
	}
	return rows.Err()
}
