package api

import (
	"bytes"
	"context"
	"encoding/hex"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type mergeRequest struct{ Base, Ours, Theirs, Mode string }
type mergeConflict struct {
	Path   string `json:"path"`
	Base   string `json:"base,omitempty"`
	Ours   string `json:"ours,omitempty"`
	Theirs string `json:"theirs,omitempty"`
	Reason string `json:"reason"`
}

func mergeTrees(ctx context.Context, r *objects.Repository, l string, q mergeRequest) (any, error) {
	r = r.ForLineage(l)
	if q.Mode != "merge" && q.Mode != "squash" {
		return nil, invalid("mode: must be merge or squash")
	}
	for _, id := range []string{q.Base, q.Ours, q.Theirs} {
		if e := require(ctx, r, l, id, "tree", true, "base/ours/theirs"); e != nil {
			return nil, e
		}
	}
	dir, e := os.MkdirTemp(r.TempDir, "merge-")
	if e != nil {
		return nil, e
	}
	defer os.RemoveAll(dir)
	pending := map[string][]byte{}
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
			es, e := r.ReadTree(ctx, id)
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
						if exit, ok := e.(*exec.ExitError); ok && exit.ExitCode() == 1 {
							reason = "both_modified"
							break
						}
						return "", fmt.Errorf("merge-file: %w", e)
					}
					v.SHA1 = store.GitHash("blob", raw)
					pending["o/"+v.SHA1] = raw
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
		var buf bytes.Buffer
		for _, f := range entries {
			fmt.Fprintf(&buf, "%s %s\x00", f.Mode, f.Path)
			raw, _ := hex.DecodeString(f.SHA1)
			buf.Write(raw)
		}
		raw := buf.Bytes()
		if raw == nil {
			raw = []byte{}
		}
		id := store.GitHash("tree", raw)
		pending["t/"+id] = raw
		return id, nil
	}
	tree, e := walk(q.Base, q.Ours, q.Theirs, "")
	if e != nil {
		return nil, e
	}
	if len(conflicts) > 0 {
		sort.Slice(conflicts, func(i, j int) bool { return conflicts[i].Path < conflicts[j].Path })
		return nil, &storageError{409, "conflict", map[string]any{"conflicts": conflicts}}
	}
	// No durable writes occur until all files are known to merge cleanly.
	keys := []string{}
	for k := range pending {
		keys = append(keys, k)
	}
	e = store.Parallel(ctx, 16, keys, func(k string) error {
		raw := pending[k]
		if strings.HasPrefix(k, "t/") {
			_, e := r.PutObject(ctx, l, "tree", raw)
			return e
		}
		_, e := r.Upload(ctx, l, "", int64(len(raw)), bytes.NewReader(raw))
		return e
	})
	if e != nil {
		return nil, e
	}
	sort.Strings(merged)
	return map[string]any{"tree": tree, "merged": merged, "took": map[string]int{"ours": ours, "theirs": theirs}}, nil
}
