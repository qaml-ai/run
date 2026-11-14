package refs

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func TestLegacyLineageCacheIsInvalidatedOnce(t *testing.T) {
	path := filepath.Join(t.TempDir(), "refs.db")
	old, e := sql.Open("sqlite3", path)
	if e != nil {
		t.Fatal(e)
	}
	_, e = old.Exec(`CREATE TABLE lineage_objects(lineage TEXT,id TEXT,kind TEXT,created_at INTEGER,PRIMARY KEY(lineage,id,kind)); INSERT INTO lineage_objects VALUES('l','legacy','tree',0);`)
	if e != nil {
		t.Fatal(e)
	}
	old.Close()
	db, e := Open(path)
	if e != nil {
		t.Fatal(e)
	}
	var n int
	if e = db.DB.QueryRow("SELECT count(*) FROM lineage_objects").Scan(&n); e != nil || n != 0 {
		t.Fatal(n, e)
	}
	if _, e = db.DB.Exec("INSERT INTO lineage_objects VALUES('l','current','tree',0)"); e != nil {
		t.Fatal(e)
	}
	db.Close()
	db, e = Open(path)
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	if e = db.DB.QueryRow("SELECT count(*) FROM lineage_objects").Scan(&n); e != nil || n != 1 {
		t.Fatal(n, e)
	}
}
