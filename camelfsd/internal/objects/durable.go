package objects

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"time"
)

// Membership records make the lineage cache recoverable without granting
// access based only on the existence of a global content hash.
type membership struct {
	Lineage string
	ID      string
	Kind    string
	Blob    *Blob
}

func membershipKey(l, id, kind string) string {
	return "l/" + root.Hash([]byte(l+"\x00"+kind+"\x00"+id))
}
func (r *Repository) Record(ctx context.Context, l, id, kind string, b *Blob) error {
	v := membership{l, id, kind, b}
	raw, e := json.Marshal(v)
	if e != nil {
		return e
	}
	if e = (&store.Uploaded{Store: r.Store, DB: r.DB.DB}).Put(ctx, membershipKey(l, id, kind), raw); e != nil {
		return e
	}
	return r.cacheMembership(ctx, v)
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
	e := r.DB.DB.QueryRowContext(ctx, "SELECT 1 FROM lineage_objects WHERE lineage=? AND id=? AND kind=?", l, id, kind).Scan(&n)
	if e == nil {
		return true, nil
	}
	if e != sql.ErrNoRows {
		return false, e
	}
	ok, e := r.Store.Has(ctx, membershipKey(l, id, kind))
	if e != nil || !ok {
		return false, e
	}
	raw, e := r.Store.Get(ctx, membershipKey(l, id, kind))
	if e != nil {
		return false, e
	}
	var v membership
	if e = json.Unmarshal(raw, &v); e != nil {
		return false, e
	}
	if v.Lineage != l || v.ID != id || v.Kind != kind {
		return false, fmt.Errorf("corrupt membership")
	}
	return true, r.cacheMembership(ctx, v)
}
func (r *Repository) PutObject(ctx context.Context, l, kind string, b []byte) (string, error) {
	id := store.GitHash(kind, b)
	key := "t/"
	if kind == "commit" {
		key = "k/"
	}
	if e := (&store.Uploaded{Store: r.Store, DB: r.DB.DB}).Put(ctx, key+id, b); e != nil {
		return "", e
	}
	if _, e := r.DB.DB.ExecContext(ctx, "INSERT OR REPLACE INTO objects VALUES(?,?,?,?,?)", id, kind, b, len(b), time.Now().UnixMilli()); e != nil {
		return "", e
	}
	return id, r.Record(ctx, l, id, kind, nil)
}
func (r *Repository) Object(ctx context.Context, id, kind string) ([]byte, error) {
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
