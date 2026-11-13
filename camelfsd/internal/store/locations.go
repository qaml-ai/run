package store

import (
	"context"
	"database/sql"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"time"
)

// v0-limitation: L-dedupe-touch
// Re-references need a reachability touch before any v1 collector can run.
func (s *Uploaded) Location(ctx context.Context, h string) (root.Location, bool, error) {
	var l root.Location
	e := s.DB.QueryRowContext(ctx, "SELECT pack,idx FROM chunk_locations WHERE sha256=?", h).Scan(&l.Pack, &l.Index)
	if e == sql.ErrNoRows {
		return l, false, nil
	}
	if e != nil {
		return l, false, e
	}
	// A host may restart against another store namespace. Never reuse its locations.
	ok, e := s.Store.Has(ctx, "p/"+l.Pack)
	return l, ok, e
}
func (s *Uploaded) RememberLocations(ctx context.Context, ls map[string]root.Location) error {
	tx, e := s.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	for h, l := range ls {
		if _, e = tx.ExecContext(ctx, `INSERT INTO chunk_locations VALUES(?,?,?,?) ON CONFLICT(sha256) DO UPDATE SET pack=excluded.pack,idx=excluded.idx,created_at=excluded.created_at`, h, l.Pack, l.Index, time.Now().UnixMilli()); e != nil {
			return e
		}
	}
	return tx.Commit()
}
