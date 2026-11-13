package objects

import (
	"context"
	"os"
	"sort"
	"strings"
	"sync"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type treeRead struct {
	entries []Entry
	err     error
}

// readTreeLevel reads each distinct tree at this depth once.
func (r *Repository) readTreeLevel(ctx context.Context, ids []string) (map[string]*treeRead, error) {
	results := make(map[string]*treeRead, len(ids))
	keys := make([]string, 0, len(ids))
	for _, id := range ids {
		if results[id] == nil {
			results[id] = &treeRead{}
			keys = append(keys, id)
		}
	}
	// Keep query observers serial while the object and sidecar reads run concurrently.
	reader := *r
	if r.Query != nil {
		var mu sync.Mutex
		reader.Query = func(query string) {
			mu.Lock()
			defer mu.Unlock()
			r.Query(query)
		}
	}
	err := store.Parallel(ctx, min(64, len(keys)), keys, func(id string) error {
		result := results[id]
		result.entries, result.err = reader.SizedTree(ctx, id)
		return nil
	})
	return results, err
}

// SizedTrees reads one depth level, returning results keyed by tree id.
func (r *Repository) SizedTrees(ctx context.Context, ids []string) (map[string][]Entry, error) {
	results, err := r.readTreeLevel(ctx, ids)
	if err != nil {
		return nil, err
	}
	entries := make(map[string][]Entry, len(results))
	for _, id := range ids {
		result := results[id]
		if result.err != nil {
			return nil, result.err
		}
		entries[id] = result.entries
	}
	return entries, nil
}

func (r *Repository) TreeEntries(ctx context.Context, id string) ([]Entry, error) {
	type subtree struct{ id, prefix string }
	out := []Entry{}
	for level := []subtree{{id: id}}; len(level) > 0; {
		ids := make([]string, len(level))
		for i, dir := range level {
			ids[i] = dir.id
		}
		trees, err := r.SizedTrees(ctx, ids)
		if err != nil {
			return nil, err
		}
		var next []subtree
		for _, dir := range level {
			for _, entry := range trees[dir.id] {
				entry.Path = dir.prefix + entry.Path
				if entry.Mode == "40000" {
					next = append(next, subtree{entry.SHA1, entry.Path + "/"})
				} else {
					out = append(out, entry)
				}
			}
		}
		level = next
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// FileResult holds the entry or lookup error for one requested path.
type FileResult struct {
	Entry Entry
	Err   error
}

// Files resolves paths in depth order and returns results in request order.
func (r *Repository) Files(ctx context.Context, id string, paths []string) ([]FileResult, error) {
	type lookup struct {
		index int
		id    string
		path  string
	}
	results := make([]FileResult, len(paths))
	var level []lookup
	for i, path := range paths {
		if err := Path(path); err != nil {
			results[i].Err = err
		} else {
			level = append(level, lookup{i, id, path})
		}
	}
	for len(level) > 0 {
		ids := make([]string, len(level))
		for i, item := range level {
			ids[i] = item.id
		}
		trees, err := r.readTreeLevel(ctx, ids)
		if err != nil {
			return nil, err
		}
		var next []lookup
		for _, item := range level {
			tree := trees[item.id]
			result := &results[item.index]
			if tree.err != nil {
				result.Err = tree.err
				continue
			}
			part, rest, more := strings.Cut(item.path, "/")
			result.Err = os.ErrNotExist
			for _, entry := range tree.entries {
				if entry.Path != part {
					continue
				}
				if !more && entry.Mode != "40000" {
					*result = FileResult{Entry: entry}
				} else if more && entry.Mode == "40000" {
					next = append(next, lookup{item.index, entry.SHA1, rest})
				}
				break
			}
		}
		level = next
	}
	return results, nil
}
