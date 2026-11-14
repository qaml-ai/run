package store

import (
	"context"
	"fmt"
	"io"
	"strings"
)

// Lineage is one printable path segment. Dot segments are also refused because
// the local store must preserve the same namespace boundary as S3.
func Lineage(l string) bool {
	if len(l) == 0 || len(l) > 128 || l == "." || l == ".." {
		return false
	}
	for _, c := range []byte(l) {
		if c < 32 || c > 126 || c == '/' || c == '\\' {
			return false
		}
	}
	return true
}
func splitKey(k string) (lineage, kind, id string, ok bool) {
	parts := strings.Split(k, "/")
	if len(parts) != 3 || !Lineage(parts[0]) {
		return "", "", "", false
	}
	return parts[0], parts[1], parts[2], true
}

type scoped struct {
	Store
	lineage string
}

func ForLineage(s Store, l string) Store {
	if v, ok := s.(*scoped); ok {
		if v.lineage == l {
			return s
		}
		s = v.Store
	}
	return &scoped{Store: s, lineage: l}
}
func (s *scoped) key(k string) (string, error) {
	if !Lineage(s.lineage) {
		return "", fmt.Errorf("invalid lineage")
	}
	if lineage, _, _, ok := splitKey(k); ok {
		if lineage != s.lineage {
			return "", fmt.Errorf("lineage mismatch")
		}
		if !valid(k) {
			return "", fmt.Errorf("invalid key")
		}
		return k, nil
	}
	full := s.lineage + "/" + k
	if !valid(full) {
		return "", fmt.Errorf("invalid key")
	}
	return full, nil
}
func (s *scoped) Get(ctx context.Context, k string) ([]byte, error) {
	key, e := s.key(k)
	if e != nil {
		return nil, e
	}
	return s.Store.Get(ctx, key)
}
func (s *scoped) Put(ctx context.Context, k string, b []byte) error {
	key, e := s.key(k)
	if e != nil {
		return e
	}
	return s.Store.Put(ctx, key, b)
}
func (s *scoped) Has(ctx context.Context, k string) (bool, error) {
	key, e := s.key(k)
	if e != nil {
		return false, e
	}
	return s.Store.Has(ctx, key)
}
func (s *scoped) Head(ctx context.Context, k string) (Info, error) {
	key, e := s.key(k)
	if e != nil {
		return Info{}, e
	}
	return s.Store.Head(ctx, key)
}
func (s *scoped) Open(ctx context.Context, k string) (io.ReadCloser, error) {
	key, e := s.key(k)
	if e != nil {
		return nil, e
	}
	return OpenReader(ctx, s.Store, key)
}
func fullKey(s Store, k string) string {
	if v, ok := s.(*scoped); ok {
		if _, _, _, ok := splitKey(k); ok {
			return k
		}
		return v.lineage + "/" + k
	}
	return k
}
