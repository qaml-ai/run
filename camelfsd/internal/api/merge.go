package api

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
)

type mergeRequest struct{ Base, Ours, Theirs, Mode string }
type mergeConflict struct {
	Path   string `json:"path"`
	Base   string `json:"base,omitempty"`
	Ours   string `json:"ours,omitempty"`
	Theirs string `json:"theirs,omitempty"`
	Reason string `json:"reason"`
}

type mergeTook struct {
	Ours   int `json:"ours"`
	Theirs int `json:"theirs"`
}

type treeMergeResult struct {
	Tree   string    `json:"tree"`
	Merged []string  `json:"merged"`
	Took   mergeTook `json:"took"`
}

func stageMerge(ctx context.Context, r *objects.Repository, l string, q mergeRequest, emptyBase bool) (*treeMergeResult, error) {
	if q.Mode != "merge" && q.Mode != "squash" {
		return nil, invalid("mode: must be merge or squash")
	}
	trees := []string{q.Ours, q.Theirs}
	if !emptyBase {
		trees = append(trees, q.Base)
	}
	for _, id := range trees {
		if e := require(ctx, r, l, id, "tree", true, "base/ours/theirs"); e != nil {
			return nil, e
		}
	}
	dir, e := os.MkdirTemp(r.TempDir, "merge-")
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(dir)
	merged := []string{}
	conflicts := []mergeConflict{}
	ours, theirs := 0, 0
	equal := func(a, b objects.Entry) bool { return a.SHA1 == b.SHA1 && a.Mode == b.Mode }
	var walk func(string, string, string, string) (string, error)
	walk = func(base, our, their, prefix string) (string, error) {
		if our == their {
			ours++
			return our, nil
		}
		if base == our {
			theirs++
			return their, nil
		}
		if base == their {
			ours++
			return our, nil
		}
		maps := []map[string]objects.Entry{{}, {}, {}}
		names := map[string]bool{}
		for i, id := range []string{base, our, their} {
			if id == "" {
				continue
			}
			es, e := r.SizedTree(ctx, id)
			if e != nil {
				return "", e
			}
			for _, f := range es {
				maps[i][f.Path] = f
				names[f.Path] = true
			}
		}
		entries := []objects.Entry{}
		for name := range names {
			b, o, t := maps[0][name], maps[1][name], maps[2][name]
			p := prefix + name
			v := o
			reason := ""
			switch {
			case equal(o, t):
				ours++
			case equal(b, o):
				v = t
				theirs++
			case equal(b, t):
				ours++
			case (b.Mode == "" || b.Mode == "40000") && o.Mode == "40000" && t.Mode == "40000":
				id, e := walk(b.SHA1, o.SHA1, t.SHA1, p+"/")
				if e != nil {
					return "", e
				}
				v.SHA1 = id
			case o.SHA1 == "" || t.SHA1 == "":
				reason = "delete_modify"
			case o.Mode == "40000" || t.Mode == "40000" || b.Mode == "40000":
				reason = "both_modified"
			default:
				if o.Mode != t.Mode && b.Mode != o.Mode && b.Mode != t.Mode {
					reason = "mode"
					break
				}
				if o.SHA1 == t.SHA1 {
					v = o
				} else if o.SHA1 == b.SHA1 {
					v = t
				} else if t.SHA1 == b.SHA1 {
					v = o
				} else {
					data := make([][]byte, 3)
					for i, id := range []string{b.SHA1, o.SHA1, t.SHA1} {
						if id == "" {
							continue
						}
						raw, e := blobBytes(ctx, r, l, id)
						if e != nil {
							return "", e
						}
						data[i] = raw
						if bytes.IndexByte(raw[:min(len(raw), 8192)], 0) >= 0 {
							reason = "binary"
						}
					}
					if reason != "" {
						break
					}
					for i, raw := range data {
						if e := os.WriteFile(filepath.Join(dir, fmt.Sprint(i)), raw, 0600); e != nil {
							return "", e
						}
					}
					cmd := exec.CommandContext(ctx, "git", "merge-file", "-p", filepath.Join(dir, "1"), filepath.Join(dir, "0"), filepath.Join(dir, "2"))
					raw, e := cmd.Output()
					if e != nil {
						if exit, ok := e.(*exec.ExitError); ok && exit.ExitCode() >= 1 && exit.ExitCode() <= 127 {
							reason = "both_modified"
							break
						}
						return "", fmt.Errorf("merge-file: %w", e)
					}
					blob := r.StageBlob(raw)
					v.SHA1, v.Size = blob.SHA1, blob.Size
					merged = append(merged, p)
				}
				if o.Mode == t.Mode {
					v.Mode = o.Mode
				} else if o.Mode == b.Mode {
					v.Mode = t.Mode
				} else {
					v.Mode = o.Mode
				}
			}
			if reason != "" {
				conflicts = append(conflicts, mergeConflict{p, b.SHA1, o.SHA1, t.SHA1, reason})
				continue
			}
			if v.SHA1 != "" {
				v.Path = name
				entries = append(entries, v)
			}
		}
		sort.Slice(entries, func(i, j int) bool { return gitLess(entries[i], entries[j]) })
		return r.StageSizedTree(ctx, entries)
	}
	tree, e := walk(q.Base, q.Ours, q.Theirs, "")
	if e != nil {
		return nil, e
	}
	if len(conflicts) > 0 {
		sort.Slice(conflicts, func(i, j int) bool { return conflicts[i].Path < conflicts[j].Path })
		return nil, &storageError{409, "conflict", map[string]any{"conflicts": conflicts}}
	}
	sort.Strings(merged)
	return &treeMergeResult{tree, merged, mergeTook{ours, theirs}}, nil
}
