package refs

import (
	"context"
	"database/sql"

	_ "github.com/mattn/go-sqlite3"
	"time"
)

type Value struct{ Commit, Tree, Root, Owner string }
type Fence struct {
	Holder string `json:"holder"`
	Epoch  int64  `json:"epoch"`
}
type Repository interface {
	RecordTree(string, string, string) error
	TreeRoot(string, string) (string, error)
	Mount(string, string, string, string, string, string, string, bool, int64) error
	DropMount(string) error
}
type DB struct {
	DB          *sql.DB
	Now         func() time.Time
	storageOnly bool
}

// v0-limitation: L23
func Open(path string) (*DB, error) {
	return open(path, true)
}

// OpenStorage opens just the caches needed by the storage plane.
func OpenStorage(path string) (*DB, error) {
	return open(path, false)
}

func open(path string, host bool) (*DB, error) {
	d, e := sql.Open("sqlite3", path+"?_busy_timeout=5000&_journal_mode=WAL")
	if e != nil {
		return nil, e
	}
	d.SetMaxOpenConns(1)
	_, e = d.Exec(`CREATE TABLE IF NOT EXISTS uploaded(key TEXT PRIMARY KEY,at INTEGER); CREATE TABLE IF NOT EXISTS objects(id TEXT PRIMARY KEY,kind TEXT,bytes BLOB,size INT,created_at INTEGER);
 CREATE TABLE IF NOT EXISTS tree_sizes(id TEXT PRIMARY KEY, bytes BLOB, created_at INTEGER);
 CREATE TABLE IF NOT EXISTS lineage_blobs(lineage TEXT,sha256 TEXT,sha1 TEXT,size INT,created_at INTEGER,PRIMARY KEY(lineage,sha256));
 CREATE INDEX IF NOT EXISTS blob_sha1 ON lineage_blobs(sha1);
 CREATE TABLE IF NOT EXISTS lineage_objects(lineage TEXT,id TEXT,kind TEXT,created_at INTEGER,PRIMARY KEY(lineage,id,kind));
 CREATE TABLE IF NOT EXISTS idempotency(key TEXT,lineage TEXT,route TEXT,status INT,body BLOB,created_at INTEGER,PRIMARY KEY(key,lineage,route));`)
	if e == nil && host {
		_, e = d.Exec(`CREATE TABLE IF NOT EXISTS tree_parents(tree TEXT PRIMARY KEY,parent TEXT);
 DROP TABLE IF EXISTS refs; CREATE TABLE IF NOT EXISTS mounts(job_id TEXT PRIMARY KEY,lineage TEXT,name TEXT,root TEXT,tree TEXT,image TEXT,warm INTEGER,state TEXT,lease_epoch INTEGER,created_at INTEGER); CREATE TABLE IF NOT EXISTS tree_roots(lineage TEXT,tree TEXT,root TEXT,created_at INTEGER); CREATE INDEX IF NOT EXISTS tree_lookup ON tree_roots(lineage,tree,created_at);`)
	}
	if e == nil {
		// Legacy cache rows describe global keys and cannot authorize prefixed
		// objects. Retain content caches, but reset namespace-dependent rows once.
		_, e = d.Exec(`BEGIN;
 CREATE TABLE IF NOT EXISTS cache_formats(name TEXT PRIMARY KEY);
 DELETE FROM lineage_objects WHERE NOT EXISTS (SELECT 1 FROM cache_formats WHERE name='lineage-prefix');
 DELETE FROM lineage_blobs WHERE NOT EXISTS (SELECT 1 FROM cache_formats WHERE name='lineage-prefix');
 DELETE FROM idempotency WHERE NOT EXISTS (SELECT 1 FROM cache_formats WHERE name='lineage-prefix');
 INSERT OR IGNORE INTO cache_formats VALUES('lineage-prefix');
 COMMIT;`)
	}
	if e != nil {
		d.Close()
		return nil, e
	}
	return &DB{DB: d, Now: time.Now, storageOnly: !host}, nil
}
func (d *DB) Close() error { return d.DB.Close() }

// RecordTreeParent records the host's image lookup hint.
func (d *DB) RecordTreeParent(ctx context.Context, tree, parent string) error {
	if d.storageOnly {
		return nil
	}
	_, err := d.DB.ExecContext(ctx, "INSERT OR IGNORE INTO tree_parents(tree,parent) VALUES(?,?)", tree, parent)
	return err
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
