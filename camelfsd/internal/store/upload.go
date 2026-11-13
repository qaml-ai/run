package store

import (
	"context"
	"database/sql"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"time"
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
	return s.scope + "/" + k
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
	if strings.HasPrefix(k, "r/") {
		var b []byte
		e := s.DB.QueryRowContext(ctx, "SELECT bytes FROM objects WHERE id=? AND kind='root'", strings.TrimPrefix(k, "r/")).Scan(&b)
		if e == nil {
			return b, nil
		}
		if e != sql.ErrNoRows {
			return nil, e
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
	if !strings.HasPrefix(k, "r/") {
		return nil
	}
	_, e := s.DB.ExecContext(ctx, "INSERT OR IGNORE INTO objects VALUES(?,'root',?,?,?)", strings.TrimPrefix(k, "r/"), b, len(b), time.Now().UnixMilli())
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
func (s *Uploaded) putFile(ctx context.Context, k string, f *os.File) error {
	ok, e := s.known(ctx, k)
	if e != nil || ok {
		return e
	}
	exists, e := s.Store.Has(ctx, k)
	if e != nil {
		return e
	}
	if exists {
		return s.record(ctx, k)
	}
	if e = PutBlobFile(ctx, s.Store, k, f); e != nil {
		return e
	}
	return s.record(ctx, k)
}
