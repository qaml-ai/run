package api

import (
	"context"
	"sort"
	"strings"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
)

type commitDir struct {
	id       string
	original []objects.Entry
	touched  map[string]*commitDir
	files    map[string]objects.Entry
	dirs     map[string]objects.Entry
}

type commitPath struct {
	dir  *commitDir
	name string
}

func commitPaths(changes []change, base string) (*commitDir, []commitPath) {
	top := &commitDir{id: base}
	paths := make([]commitPath, len(changes))
	for i, c := range changes {
		if objects.Path(c.Path) != nil {
			continue
		}
		dir := top
		rest := c.Path
		for {
			part, tail, more := strings.Cut(rest, "/")
			if !more {
				paths[i] = commitPath{dir, part}
				break
			}
			if dir.touched == nil {
				dir.touched = make(map[string]*commitDir)
			}
			if dir.touched[part] == nil {
				dir.touched[part] = &commitDir{}
			}
			dir = dir.touched[part]
			rest = tail
		}
	}
	return top, paths
}

func (d *commitDir) read(ctx context.Context, r *objects.Repository, timing *commitTiming) error {
	for level := []*commitDir{d}; len(level) > 0; {
		var ids []string
		for _, dir := range level {
			if dir.id != "" {
				ids = append(ids, dir.id)
			}
		}
		var trees map[string][]objects.Entry
		if len(ids) > 0 {
			timing.readWaves++
			var err error
			trees, err = r.SizedTrees(ctx, ids)
			if err != nil {
				return err
			}
		}
		var next []*commitDir
		for _, dir := range level {
			dir.original = trees[dir.id]
			dir.files = make(map[string]objects.Entry)
			dir.dirs = make(map[string]objects.Entry)
			for _, entry := range dir.original {
				if entry.Mode == "40000" {
					dir.dirs[entry.Path] = entry
				} else {
					dir.files[entry.Path] = entry
				}
			}
			for name, child := range dir.touched {
				child.id = dir.dirs[name].SHA1
				next = append(next, child)
			}
		}
		level = next
	}
	return nil
}

func (d *commitDir) build(ctx context.Context, r *objects.Repository, root bool) (string, error) {
	if d.files == nil && d.id != "" {
		return d.id, nil // No changes were requested.
	}
	for name, child := range d.touched {
		id, err := child.build(ctx, r, false)
		if err != nil {
			return "", err
		}
		if id == "" {
			delete(d.dirs, name)
		} else if id != child.id {
			d.dirs[name] = objects.Entry{Path: name, Mode: "40000", SHA1: id}
		}
	}
	// Like a flat listing, files and directories can overlap temporarily.
	// Only the final state determines whether they conflict.
	for name := range d.dirs {
		if _, exists := d.files[name]; exists {
			return "", invalid("invalid path conflict")
		}
	}
	if d.id != "" && len(d.files)+len(d.dirs) == len(d.original) {
		same := true
		for _, entry := range d.original {
			current := d.files[entry.Path]
			if entry.Mode == "40000" {
				current = d.dirs[entry.Path]
			}
			if current.SHA1 != entry.SHA1 || current.Mode != entry.Mode {
				same = false
				break
			}
		}
		if same {
			return d.id, nil
		}
	}
	if !root && len(d.files)+len(d.dirs) == 0 {
		return "", nil
	}
	entries := make([]objects.Entry, 0, len(d.files)+len(d.dirs))
	for _, entry := range d.files {
		entries = append(entries, entry)
	}
	for _, entry := range d.dirs {
		entries = append(entries, entry)
	}
	sort.Slice(entries, func(i, j int) bool { return gitLess(entries[i], entries[j]) })
	return r.StageSizedTree(ctx, entries)
}
