package objects

import (
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"time"
)

type cachedObject struct {
	kind  string
	bytes []byte
}
type publication struct {
	puts        map[string][]byte
	objects     map[string]cachedObject
	memberships []membership
}

// BeginPublication shares one upload wave across tree construction and commit
// encoding. Cache authorization is published only after every PUT succeeds.
func (r *Repository) BeginPublication() *Repository {
	if r.publication != nil {
		return r
	}
	batch := *r
	batch.publication = &publication{puts: map[string][]byte{}, objects: map[string]cachedObject{}}
	return &batch
}
func (r *Repository) Flush(ctx context.Context) error {
	p := r.publication
	if p == nil {
		return nil
	}
	keys := make([]string, 0, len(p.puts))
	for key := range p.puts {
		keys = append(keys, key)
	}
	uploaded := &store.Uploaded{Store: r.Store, DB: r.DB.DB}
	if e := store.Parallel(ctx, 64, keys, func(key string) error { return uploaded.Put(ctx, key, p.puts[key]) }); e != nil {
		return e
	}
	for id, obj := range p.objects {
		if _, e := r.DB.DB.ExecContext(ctx, "INSERT OR REPLACE INTO objects VALUES(?,?,?,?,?)", id, obj.kind, obj.bytes, len(obj.bytes), time.Now().UnixMilli()); e != nil {
			return e
		}
	}
	for _, v := range p.memberships {
		if e := r.cacheMembership(ctx, v); e != nil {
			return e
		}
	}
	p.puts = map[string][]byte{}
	p.objects = map[string]cachedObject{}
	p.memberships = nil
	return nil
}
