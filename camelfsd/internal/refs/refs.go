package refs

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	_ "github.com/mattn/go-sqlite3"
	"time"
)

var ErrFenced = errors.New("fenced")

type Value struct{ Commit, Tree, Root, Owner string }
type Ref struct {
	Value
	Holder                    string
	LeaseEpoch, LeaseDeadline int64
}
type Fence struct {
	Holder     string
	LeaseEpoch int64
}
type Repository interface {
	Get(string, string) (Ref, error)
	CAS(string, string, Value, Value, Fence) error
	Lease(string, string, string) (int64, error)
	ReleaseLease(string, string, Fence) error
	Ensure(string, string) error
	Renew(string, string, Fence) error
	Check(string, string, Fence) error
	RecordTree(string, string, string) error
	TreeRoot(string, string) (string, error)
	Mount(string, string, string, string, string, string, string, bool, int64) error
	DropMount(string) error
}
type DB struct {
	DB  *sql.DB
	Now func() time.Time
}

// v0-limitation: L23
func Open(path string) (*DB, error) {
	d, e := sql.Open("sqlite3", path+"?_busy_timeout=5000&_journal_mode=WAL")
	if e != nil {
		return nil, e
	}
	d.SetMaxOpenConns(1)
	_, e = d.Exec(`CREATE TABLE IF NOT EXISTS tree_parents(tree TEXT PRIMARY KEY,parent TEXT); CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,kind TEXT,bytes BLOB,size INT,created_at INTEGER);
 CREATE TABLE IF NOT EXISTS lineage_blobs(lineage TEXT,sha256 TEXT,sha1 TEXT,size INT,created_at INTEGER,PRIMARY KEY(lineage,sha256));
 CREATE INDEX IF NOT EXISTS blob_sha1 ON lineage_blobs(sha1);
 CREATE TABLE IF NOT EXISTS refs(lineage TEXT,name TEXT,"commit" TEXT NOT NULL DEFAULT '',tree TEXT NOT NULL DEFAULT '',root TEXT NOT NULL DEFAULT '',owner TEXT NOT NULL DEFAULT '',holder TEXT,lease_epoch INTEGER NOT NULL DEFAULT 0,lease_deadline INTEGER NOT NULL DEFAULT 0,created_at INTEGER,updated_at INTEGER,PRIMARY KEY(lineage,name)); CREATE TABLE IF NOT EXISTS mounts(job_id TEXT PRIMARY KEY,lineage TEXT,name TEXT,root TEXT,tree TEXT,image TEXT,warm INTEGER,state TEXT,lease_epoch INTEGER,created_at INTEGER); CREATE TABLE IF NOT EXISTS tree_roots(lineage TEXT,tree TEXT,root TEXT,created_at INTEGER); CREATE INDEX IF NOT EXISTS tree_lookup ON tree_roots(lineage,tree,created_at);`)
	if e != nil {
		d.Close()
		return nil, e
	}
	return &DB{d, time.Now}, nil
}
func (d *DB) Close() error { return d.DB.Close() }
func (d *DB) Get(l, n string) (Ref, error) {
	var r Ref
	var h sql.NullString
	e := d.DB.QueryRow(`SELECT "commit",tree,root,owner,holder,lease_epoch,lease_deadline FROM refs WHERE lineage=? AND name=?`, l, n).Scan(&r.Commit, &r.Tree, &r.Root, &r.Owner, &h, &r.LeaseEpoch, &r.LeaseDeadline)
	r.Holder = h.String
	return r, e
}
func (d *DB) Ensure(l, n string) error {
	_, e := d.DB.Exec(`INSERT OR IGNORE INTO refs(lineage,name,created_at,updated_at) VALUES(?,?,?,?)`, l, n, d.Now().UnixMilli(), d.Now().UnixMilli())
	return e
}
func (d *DB) CAS(l, n string, a, b Value, f Fence) error {
	if e := d.Ensure(l, n); e != nil {
		return e
	}
	var holder any
	if f.Holder != "" {
		holder = f.Holder
	}
	r, e := d.DB.Exec(`UPDATE refs SET "commit"=?,tree=?,root=?,owner=?,updated_at=? WHERE lineage=? AND name=? AND "commit"=? AND tree=? AND root=? AND ((holder IS NULL AND ? IS NULL) OR (holder=? AND lease_epoch=? AND lease_deadline>?))`, b.Commit, b.Tree, b.Root, b.Owner, d.Now().UnixMilli(), l, n, a.Commit, a.Tree, a.Root, holder, holder, f.LeaseEpoch, d.Now().UnixMilli())
	if e != nil {
		return e
	}
	nrows, e := r.RowsAffected()
	if e == nil && nrows != 1 {
		return ErrFenced
	}
	return e
}

// v0-limitation: L24
func (d *DB) Lease(l, n, h string) (int64, error) {
	r, e := d.DB.Exec(`UPDATE refs SET holder=?,lease_epoch=lease_epoch+1,lease_deadline=?,updated_at=? WHERE lineage=? AND name=? AND (holder IS NULL OR lease_deadline<=?)`, h, d.Now().Add(5*time.Minute).UnixMilli(), d.Now().UnixMilli(), l, n, d.Now().UnixMilli())
	if e != nil {
		return 0, e
	}
	nrows, _ := r.RowsAffected()
	if nrows != 1 {
		return 0, ErrFenced
	}
	v, e := d.Get(l, n)
	return v.LeaseEpoch, e
}

// v0-limitation: L24
func (d *DB) Renew(l, n string, f Fence) error {
	r, e := d.DB.Exec(`UPDATE refs SET lease_deadline=? WHERE lineage=? AND name=? AND holder=? AND lease_epoch=? AND lease_deadline>?`, d.Now().Add(5*time.Minute).UnixMilli(), l, n, f.Holder, f.LeaseEpoch, d.Now().UnixMilli())
	if e != nil {
		return e
	}
	v, _ := r.RowsAffected()
	if v != 1 {
		return ErrFenced
	}
	return nil
}
func (d *DB) ReleaseLease(l, n string, f Fence) error {
	r, e := d.DB.Exec(`UPDATE refs SET holder=NULL,lease_deadline=0 WHERE lineage=? AND name=? AND holder=? AND lease_epoch=?`, l, n, f.Holder, f.LeaseEpoch)
	if e != nil {
		return e
	}
	v, _ := r.RowsAffected()
	if v != 1 {
		return ErrFenced
	}
	return nil
}
func (d *DB) RecordTree(l, t, r string) error {
	if t == "" {
		return nil
	}
	_, e := d.DB.Exec(`INSERT INTO tree_roots VALUES(?,?,?,?)`, l, t, r, d.Now().UnixNano())
	return e
}
func (d *DB) TreeRoot(l, t string) (string, error) {
	var r string
	e := d.DB.QueryRow(`SELECT root FROM tree_roots WHERE lineage=? AND tree=? ORDER BY created_at DESC,rowid DESC LIMIT 1`, l, t).Scan(&r)
	return r, e
}
func (d *DB) Mount(job, l, n, r, tree, image, state string, warm bool, epoch int64) error {
	_, e := d.DB.Exec(`INSERT OR REPLACE INTO mounts VALUES(?,?,?,?,?,?,?,?,?,?)`, job, l, n, r, tree, image, warm, state, epoch, d.Now().UnixMilli())
	return e
}
func (d *DB) DropMount(job string) error {
	_, e := d.DB.Exec(`DELETE FROM mounts WHERE job_id=?`, job)
	return e
}
func (d *DB) Check(l, n string, f Fence) error {
	r, e := d.Get(l, n)
	if e != nil {
		return e
	}
	if r.Holder != f.Holder || r.LeaseEpoch != f.LeaseEpoch || r.LeaseDeadline <= d.Now().UnixMilli() {
		return fmt.Errorf("%w", ErrFenced)
	}
	return nil
}

// Publish atomically fences the complete ref and records its image mapping.
func (d *DB) Publish(ctx context.Context, l, n string, a, b Value, f Fence) error {
	tx, e := d.DB.BeginTx(ctx, nil)
	if e != nil {
		return e
	}
	defer tx.Rollback()
	r, e := tx.ExecContext(ctx, `UPDATE refs SET "commit"=?,tree=?,root=?,owner=?,updated_at=? WHERE lineage=? AND name=? AND "commit"=? AND tree=? AND root=? AND holder=? AND lease_epoch=? AND lease_deadline>?`, b.Commit, b.Tree, b.Root, b.Owner, d.Now().UnixMilli(), l, n, a.Commit, a.Tree, a.Root, f.Holder, f.LeaseEpoch, d.Now().UnixMilli())
	if e != nil {
		return e
	}
	nr, _ := r.RowsAffected()
	if nr != 1 {
		return ErrFenced
	}
	if b.Tree != "" {
		_, e = tx.ExecContext(ctx, `INSERT INTO tree_roots VALUES(?,?,?,?)`, l, b.Tree, b.Root, d.Now().UnixNano())
		if e != nil {
			return e
		}
	}
	return tx.Commit()
}
