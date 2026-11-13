package api

import (
	"bytes"
	"context"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"net/url"
	"path"
	"regexp"
	"strconv"
	"strings"
)

type grepMatch struct {
	Path   string   `json:"path"`
	Line   int      `json:"line"`
	Text   string   `json:"text"`
	Before []string `json:"before,omitempty"`
	After  []string `json:"after,omitempty"`
}

func grepTree(ctx context.Context, r *objects.Repository, l string, q url.Values) (any, error) {
	limit := 2000
	contextLines := 0
	for k, dst := range map[string]*int{"limit": &limit, "context": &contextLines} {
		if q.Get(k) != "" {
			v, e := strconv.Atoi(q.Get(k))
			if e != nil || v < 0 {
				return nil, bad("invalid_request")
			}
			*dst = v
		}
	}
	limit = min(limit, 2000)
	if limit < 1 || contextLines > 2000 {
		return nil, bad("invalid_request")
	}
	pattern := q.Get("q")
	if q.Get("regex") != "1" {
		pattern = regexp.QuoteMeta(pattern)
	}
	if q.Get("ignoreCase") == "1" {
		pattern = "(?i)" + pattern
	}
	re, e := regexp.Compile(pattern)
	if e != nil {
		return nil, bad("invalid_request")
	}
	glob := q.Get("path")
	if glob != "" {
		if _, e = path.Match(glob, ""); e != nil {
			return nil, bad("invalid_request")
		}
	}
	es, e := r.Entries(ctx, q.Get("tree"))
	if e != nil {
		return nil, e
	}
	files := []objects.Entry{}
	for _, f := range es {
		if glob != "" {
			ok, _ := path.Match(glob, f.Path)
			if !ok {
				continue
			}
		}
		files = append(files, f)
	}
	// Bounded windows preserve tree order and stop fetching once the cap is met.
	matches := []grepMatch{}
	scanned := 0
	truncated := false
	for start := 0; start < len(files) && !truncated; start += 64 {
		batch := files[start:min(len(files), start+64)]
		data := make([][]byte, len(batch))
		keys := []string{}
		for i := range batch {
			keys = append(keys, strconv.Itoa(i))
		}
		if e = store.Parallel(ctx, 64, keys, func(k string) error {
			i, _ := strconv.Atoi(k)
			b, e := blobBytes(ctx, r, l, batch[i].SHA1)
			data[i] = b
			return e
		}); e != nil {
			return nil, e
		}
		for i, f := range batch {
			b := data[i]
			scanned++
			if bytes.IndexByte(b[:min(len(b), 8192)], 0) >= 0 {
				continue
			}
			lines := strings.Split(strings.TrimSuffix(string(b), "\n"), "\n")
			for j, line := range lines {
				if re.MatchString(line) {
					if len(matches) == limit {
						truncated = true
						break
					}
					m := grepMatch{Path: f.Path, Line: j + 1, Text: line}
					if contextLines > 0 {
						m.Before = lines[max(0, j-contextLines):j]
						m.After = lines[j+1 : min(len(lines), j+1+contextLines)]
					}
					matches = append(matches, m)
				}
			}
			if truncated {
				break
			}
		}
	}
	return map[string]any{"matches": matches, "files": scanned, "truncated": truncated, "indexed": "scan"}, nil
}
