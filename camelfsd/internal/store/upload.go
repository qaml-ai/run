package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/root"
)

var opaqueUploadEpoch = time.Now().UnixNano()

// Uploaded remembers durable content-addressed writes in this host's refs.db.
type Uploaded struct {
	Store
	DB        *sql.DB
	scopeOnce sync.Once
	scope     string
}

// Namespace upload inventory by its durable destination. Legacy unscoped rows
// cannot prove an object exists after changing a bucket, prefix or local store.
func uploadNamespace(s Store) string {
	switch v := s.(type) {
	case *scoped:
		return uploadNamespace(v.Store)
	case Local:
		p, _ := filepath.Abs(v.Dir)
		return "local\x00" + filepath.Clean(p)
	case *S3:
		return "s3\x00" + v.Bucket + "\x00" + v.Prefix
	case *limited:
		return uploadNamespace(v.Store)
	case *Uploaded:
		return uploadNamespace(v.Store)
	default:
		return ""
	}
}
func (s *Uploaded) inventoryKey(k string) string {
	s.scopeOnce.Do(func() {
		scope := uploadNamespace(s.Store)
		if scope == "" {
			scope = fmt.Sprintf("opaque:%p:%d", s, time.Now().UnixNano())
			if reflect.ValueOf(s.Store).Kind() == reflect.Pointer {
				scope = fmt.Sprintf("opaque:%T:%p:%d", s.Store, s.Store, opaqueUploadEpoch)
			}
		}
		s.scope = root.Hash([]byte(scope))
	})
	return s.scope + "/" + fullKey(s.Store, k)
}

// Keep lineage scoping and the shared concurrency limiter while bypassing
// any inner upload inventory, whose writes belong to the batch transaction.
func withoutUploadInventory(s Store) Store {
	switch v := s.(type) {
	case *scoped:
		return ForLineage(withoutUploadInventory(v.Store), v.lineage)
	case *limited:
		return &limited{Store: withoutUploadInventory(v.Store), slots: v.slots, background: v.background}
	case *Uploaded:
		return withoutUploadInventory(v.Store)
	default:
		return s
	}
}

func (s *Uploaded) known(ctx context.Context, k string) (bool, error) {
	var n int
	e := s.DB.QueryRowContext(ctx, "SELECT 1 FROM uploaded WHERE key=?", s.inventoryKey(k)).Scan(&n)
	if e == sql.ErrNoRows {
		return false, nil
	}
	return e == nil, e
}
func (s *Uploaded) record(ctx context.Context, k string) error {
	_, e := s.DB.ExecContext(ctx, "INSERT OR IGNORE INTO uploaded VALUES(?,?)", s.inventoryKey(k), time.Now().UnixMilli())
	return e
}
func (s *Uploaded) Get(ctx context.Context, k string) ([]byte, error) {
	_, kind, id, _ := splitKey(fullKey(s.Store, k))
	if kind == "r" {
		// A shared hash cache alone cannot prove existence in this lineage.
		known, e := s.known(ctx, k)
		if e != nil {
			return nil, e
		}
		if known {
			var b []byte
			e = s.DB.QueryRowContext(ctx, "SELECT bytes FROM objects WHERE id=? AND kind='root'", id).Scan(&b)
			if e == nil {
				return b, nil
			}
			if e != sql.ErrNoRows {
				return nil, e
			}
		}
	}
	b, e := s.Store.Get(ctx, k)
	if e != nil {
		return nil, e
	}
	if e = s.rememberRoot(ctx, k, b); e != nil {
		return nil, e
	}
	return b, s.record(ctx, k)
}
func (s *Uploaded) rememberRoot(ctx context.Context, k string, b []byte) error {
	_, kind, id, _ := splitKey(fullKey(s.Store, k))
	if kind != "r" {
		return nil
	}
	_, e := s.DB.ExecContext(ctx, "INSERT OR IGNORE INTO objects VALUES(?,'root',?,?,?)", id, b, len(b), time.Now().UnixMilli())
	return e
}
func (s *Uploaded) Put(ctx context.Context, k string, b []byte) error {
	ok, e := s.known(ctx, k)
	if e != nil || ok {
		return e
	}
	if e = s.Store.Put(ctx, k, b); e != nil {
		return e
	}
	if e = s.rememberRoot(ctx, k, b); e != nil {
		return e
	}
	return s.record(ctx, k)
}

// PutBatch writes unknown keys in one wave and returns their inventory keys
// for the caller to record in the same transaction as its publication.
func (s *Uploaded) PutBatch(ctx context.Context, puts map[string][]byte) ([]string, error) {
	if len(puts) == 0 {
		return nil, nil
	}
	keys := make([]string, 0, len(puts))
	inventory := make([]string, 0, len(puts))
	for key := range puts {
		keys = append(keys, key)
		inventory = append(inventory, s.inventoryKey(key))
	}
	encoded, err := json.Marshal(inventory)
	if err != nil {
		return nil, err
	}
	rows, err := s.DB.QueryContext(ctx, "SELECT key FROM uploaded WHERE key IN (SELECT value FROM json_each(?))", string(encoded))
	if err != nil {
		return nil, err
	}
	known := make(map[string]bool)
	for rows.Next() {
		var key string
		if err := rows.Scan(&key); err != nil {
			rows.Close()
			return nil, err
		}
		known[key] = true
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	var pending []string
	var written []string
	for i, key := range keys {
		if !known[inventory[i]] {
			pending = append(pending, key)
			written = append(written, inventory[i])
		}
	}
	destination := withoutUploadInventory(s.Store)
	err = Parallel(ctx, min(64, len(pending)), pending, func(key string) error {
		return destination.Put(ctx, key, puts[key])
	})
	return written, err
}

func (s *Uploaded) putFile(ctx context.Context, k string, f *os.File, metadata ...string) (bool, error) {
	created, err := PutBlobFileIfAbsent(ctx, s.Store, k, f, metadata...)
	if err != nil {
		return false, err
	}
	return created, s.record(ctx, k)
}
