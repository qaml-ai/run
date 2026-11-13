package objects

import (
	"context"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"strings"
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
	for key := range p.puts {
		if strings.HasPrefix(key, "t/") {
			if _, ok := p.puts["ts/"+strings.TrimPrefix(key, "t/")]; !ok {
				return fmt.Errorf("missing tree sizes %s", strings.TrimPrefix(key, "t/"))
			}
		}
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
	for key, b := range p.puts {
		if id, ok := strings.CutPrefix(key, "ts/"); ok {
			if e := r.cacheTreeSizes(ctx, id, b); e != nil {
				return e
			}
		}
	}
	for _, v := range p.memberships {
		key := kindKey(v.Kind, v.ID)
		var e error
		if _, written := p.puts[key]; written {
			e = r.cacheMembership(ctx, v)
		} else {
			plain := *r
			plain.publication = nil
			e = plain.Record(ctx, v.Lineage, v.ID, v.Kind, v.Blob)
		}
		if e != nil {
			return e
		}
	}
	p.puts = map[string][]byte{}
	p.objects = map[string]cachedObject{}
	p.memberships = nil
	return nil
}
