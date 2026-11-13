package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type change struct {
	Path   string `json:"path"`
	Blob   string `json:"blob,omitempty"`
	Mode   string `json:"mode,omitempty"`
	Delete bool   `json:"delete,omitempty"`
}
type commitRequest struct {
	Parent   *string           `json:"parent"`
	BaseTree *string           `json:"baseTree,omitempty"`
	Changes  []change          `json:"changes"`
	Author   string            `json:"author"`
	Message  string            `json:"message"`
	Trailers map[string]string `json:"trailers"`
	Time     *int64            `json:"time"`
}

func safeLine(s string) bool { return !strings.ContainsAny(s, "\r\n\x00") }
func makeCommit(ctx context.Context, r *objects.Repository, l string, q commitRequest) (any, error) {
	if len(q.Changes) > 10000 {
		return nil, large("")
	}
	if q.Author == "" || !safeLine(q.Author) || strings.ContainsRune(q.Message, 0) {
		return nil, bad("invalid_request")
	}
	base := ""
	if q.Parent != nil {
		if e := require(ctx, r, l, *q.Parent, "commit", true); e != nil {
			return nil, e
		}
		c, e := readCommit(ctx, r, *q.Parent)
		if e != nil {
			return nil, e
		}
		base = c["tree"].(string)
	}
	if q.BaseTree != nil {
		base = *q.BaseTree
	}
	if base != "" {
		if e := require(ctx, r, l, base, "tree", true); e != nil {
			return nil, e
		}
	}
	files := map[string]objects.File{}

	if base != "" {
		es, e := r.TreeEntries(ctx, base)
		if e != nil {
			return nil, e
		}
		ids := make([]string, len(es))
		for i, f := range es {
			ids[i] = f.SHA1
		}
		blobs, e := r.BlobInfos(ctx, l, ids)
		if e != nil {
			return nil, e
		}
		for _, f := range es {
			b := blobs[f.SHA1]
			files[f.Path] = objects.File{SHA256: b.SHA256, Mode: f.Mode}

		}
	}
	changed := 0
	var bytes int64
	for _, c := range q.Changes {
		if objects.Path(c.Path) != nil || c.Mode != "" && c.Mode != "100644" && c.Mode != "100755" && c.Mode != "120000" {
			return nil, bad("invalid_request")
		}
		prev, exists := files[c.Path]
		if c.Delete {
			if c.Blob != "" || c.Mode != "" {
				return nil, bad("invalid_request")
			}
			if exists {
				delete(files, c.Path)
				changed++
			}
			continue
		}
		next := prev
		if c.Blob != "" {
			if e := require(ctx, r, l, c.Blob, "blob", true); e != nil {
				return nil, e
			}
			b, e := r.BlobInfo(ctx, l, c.Blob)
			if e != nil {
				return nil, e
			}
			next.SHA256 = b.SHA256
			bytes += b.Size
		} else if !exists {
			return nil, bad("invalid_request")
		}
		if c.Mode != "" {
			next.Mode = c.Mode
		}
		if next.Mode == "" {
			next.Mode = "100644"
		}
		if next != prev {
			changed++
		}
		files[c.Path] = next
	}
	for k, v := range q.Trailers {
		if k == "" || !safeLine(k) || strings.Contains(k, ":") || !safeLine(v) {
			return nil, bad("invalid_request")
		}
	}
	r = r.BeginPublication()
	tr, e := r.Import(ctx, objects.Request{Lineage: l, ParentTree: base, Files: files})
	if e != nil {
		return nil, e
	}
	now := time.Now().Unix()
	if q.Time != nil {
		now = *q.Time
	}
	body := "tree " + tr.Tree + "\n"
	if q.Parent != nil {
		body += "parent " + *q.Parent + "\n"
	}
	body += fmt.Sprintf("author %s <%s@camelfs> %d +0000\ncommitter camelfs <camelfs@camelfs> %d +0000\n\n%s\n\n", q.Author, q.Author, now, now, q.Message)
	keys := []string{}
	for k := range q.Trailers {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		body += k + ": " + q.Trailers[k] + "\n"
	}
	id, e := r.PutObject(ctx, l, "commit", []byte(body))
	if e != nil {
		return nil, e
	}
	if e = r.Flush(ctx); e != nil {
		return nil, e
	}
	return map[string]any{"tree": tr.Tree, "commit": id, "changed": changed, "bytes": bytes}, nil
}
func readCommit(ctx context.Context, r *objects.Repository, id string) (map[string]any, error) {
	b, e := r.Object(ctx, id, "commit")
	if e != nil {
		return nil, e
	}
	headers, body, _ := strings.Cut(string(b), "\n\n")
	out := map[string]any{}
	parents := []string{}
	for _, line := range strings.Split(headers, "\n") {
		k, v, _ := strings.Cut(line, " ")
		if k == "tree" {
			out[k] = v
		}
		if k == "parent" {
			parents = append(parents, v)
		}
		if k == "author" {
			idx := strings.LastIndex(v, " <")
			if idx < 0 {
				return nil, fmt.Errorf("corrupt author")
			}
			out["author"] = v[:idx]
			fields := strings.Fields(v)
			t, e := strconv.ParseInt(fields[len(fields)-2], 10, 64)
			if e != nil {
				return nil, e
			}
			out["time"] = t
		}
	}
	msg, tr := strings.TrimSuffix(body, "\n"), ""
	if i := strings.LastIndex(body, "\n\n"); i >= 0 {
		msg, tr = body[:i], body[i+2:]
	}
	trailers := map[string]string{}
	for _, line := range strings.Split(tr, "\n") {
		k, v, ok := strings.Cut(line, ": ")
		if ok {
			trailers[k] = v
		}
	}
	out["message"] = msg
	out["trailers"] = trailers
	out["parents"] = parents
	return out, nil
}

type listingEntry struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
	Blob string `json:"blob,omitempty"`
	Tree string `json:"tree,omitempty"`
	Size *int64 `json:"size,omitempty"`
}

func gitLess(a, b objects.Entry) bool {
	x, y := a.Path, b.Path
	if a.Mode == "40000" {
		x += "/"
	}
	if b.Mode == "40000" {
		y += "/"
	}
	return x < y
}
func listTree(ctx context.Context, r *objects.Repository, l, id, dir, after string, recursive bool, lim string) (any, error) {
	limit := 10000
	if lim != "" {
		n, e := strconv.Atoi(lim)
		if e != nil || n < 1 || n > 10000 {
			return nil, bad("invalid_request")
		}
		limit = n
	}
	if dir != "" {
		if objects.Path(dir) != nil {
			return nil, bad("invalid_request")
		}
		for _, p := range strings.Split(dir, "/") {
			es, e := r.ReadTree(ctx, id)
			if e != nil {
				return nil, e
			}
			found := false
			for _, f := range es {
				if f.Path == p && f.Mode == "40000" {
					id = f.SHA1
					found = true
					break
				}
			}
			if !found {
				return nil, missing()
			}
		}
	}
	es := []objects.Entry{}
	var walk func(string, string) error
	walk = func(id, prefix string) error {
		entries, e := r.ReadTree(ctx, id)
		if e != nil {
			return e
		}
		sort.Slice(entries, func(i, j int) bool { return gitLess(entries[i], entries[j]) })
		for _, f := range entries {
			f.Path = prefix + f.Path
			if recursive && f.Mode == "40000" {
				if e = walk(f.SHA1, f.Path+"/"); e != nil {
					return e
				}
			} else {
				es = append(es, f)
			}
		}
		return nil
	}
	prefix := ""
	if dir != "" {
		prefix = dir + "/"
	}
	if e := walk(id, prefix); e != nil {
		return nil, e
	}
	start := 0
	if after != "" {
		found := false
		for i, f := range es {
			if f.Path == after {
				start = i + 1
				found = true
				break
			}
		}
		if !found {
			return nil, bad("invalid_request")
		}
	}
	page := es[start:min(len(es), start+limit)]
	sizes := map[string]int64{}
	// One lineage-scoped size query per page, regardless of its file count.
	rows, e := r.DB.DB.QueryContext(ctx, "SELECT sha1,size FROM lineage_blobs WHERE lineage=?", l)
	if e != nil {
		return nil, e
	}
	for rows.Next() {
		var id string
		var size int64
		if e = rows.Scan(&id, &size); e != nil {
			rows.Close()
			return nil, e
		}
		sizes[id] = size
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return nil, e
	}
	missingIDs := []string{}
	for _, f := range page {
		if f.Mode != "40000" {
			if _, ok := sizes[f.SHA1]; !ok {
				missingIDs = append(missingIDs, f.SHA1)
			}
		}
	}
	if len(missingIDs) > 0 {
		if e := store.Parallel(ctx, 64, missingIDs, func(id string) error {
			ok, e := r.Reachable(ctx, l, id, "blob")
			if e != nil {
				return e
			}
			if !ok {
				return fmt.Errorf("missing lineage blob")
			}
			return nil
		}); e != nil {
			return nil, e
		}
		rows, e := r.DB.DB.QueryContext(ctx, "SELECT sha1,size FROM lineage_blobs WHERE lineage=?", l)
		if e != nil {
			return nil, e
		}
		for rows.Next() {
			var id string
			var n int64
			if e = rows.Scan(&id, &n); e != nil {
				rows.Close()
				return nil, e
			}
			sizes[id] = n
		}
		e = rows.Err()
		rows.Close()
		if e != nil {
			return nil, e
		}
	}
	out := []listingEntry{}
	for _, f := range page {
		v := listingEntry{Path: f.Path, Mode: f.Mode}
		if f.Mode == "40000" {
			v.Mode = "040000"
			v.Tree = f.SHA1
		} else {
			size, ok := sizes[f.SHA1]
			if !ok {
				b, e := r.BlobInfo(ctx, l, f.SHA1)
				if e != nil {
					return nil, e
				}
				size = b.Size
			}
			v.Blob = f.SHA1
			v.Size = &size
		}
		out = append(out, v)
	}
	result := map[string]any{"entries": out}
	if start+len(page) < len(es) {
		result["next"] = page[len(page)-1].Path
	}
	return result, nil
}

type diffChange struct {
	Path    string `json:"path"`
	Status  string `json:"status"`
	OldBlob string `json:"oldBlob,omitempty"`
	NewBlob string `json:"newBlob,omitempty"`
	OldMode string `json:"oldMode,omitempty"`
	NewMode string `json:"newMode,omitempty"`
}

func treeDiff(ctx context.Context, r *objects.Repository, a, b, prefix string) ([]diffChange, error) {
	if prefix != "" && objects.Path(prefix) != nil {
		return nil, bad("invalid_request")
	}
	out := []diffChange{}
	var walk func(string, string, string) error
	walk = func(a, b, dir string) error {
		if a == b {
			return nil
		}
		am, bm := map[string]objects.Entry{}, map[string]objects.Entry{}
		for i, id := range []string{a, b} {
			if id == "" {
				continue
			}
			es, e := r.ReadTree(ctx, id)
			if e != nil {
				return e
			}
			for _, f := range es {
				if i == 0 {
					am[f.Path] = f
				} else {
					bm[f.Path] = f
				}
			}
		}
		names := map[string]bool{}
		for n := range am {
			names[n] = true
		}
		for n := range bm {
			names[n] = true
		}
		keys := []string{}
		for n := range names {
			keys = append(keys, n)
		}
		sort.Strings(keys)
		for _, n := range keys {
			x, y := am[n], bm[n]
			p := dir + n
			if prefix != "" && p != prefix && !strings.HasPrefix(p, prefix+"/") && !strings.HasPrefix(prefix, p+"/") {
				continue
			}
			if x.SHA1 == y.SHA1 && x.Mode == y.Mode {
				continue
			}
			if x.Mode == "40000" || y.Mode == "40000" {
				ax, by := "", ""
				if x.Mode == "40000" {
					ax = x.SHA1
				}
				if y.Mode == "40000" {
					by = y.SHA1
				}
				if e := walk(ax, by, p+"/"); e != nil {
					return e
				}
				if x.Mode == "40000" {
					x = objects.Entry{}
				}
				if y.Mode == "40000" {
					y = objects.Entry{}
				}
				if x.SHA1 == "" && y.SHA1 == "" {
					continue
				}
			}
			status := "modified"
			if x.SHA1 == "" {
				status = "added"
			} else if y.SHA1 == "" {
				status = "deleted"
			} else if x.SHA1 == y.SHA1 {
				status = "mode"
			}
			out = append(out, diffChange{p, status, x.SHA1, y.SHA1, x.Mode, y.Mode})
		}
		return nil
	}
	e := walk(a, b, "")
	return out, e
}

func (q *commitRequest) UnmarshalJSON(raw []byte) error {
	type plain commitRequest
	var v plain
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if e := d.Decode(&v); e != nil {
		return e
	}
	var fields map[string]json.RawMessage
	if e := json.Unmarshal(raw, &fields); e != nil {
		return e
	}
	if b, ok := fields["baseTree"]; ok && string(b) == "null" {
		empty := ""
		v.BaseTree = &empty
	}
	*q = commitRequest(v)
	return nil
}
