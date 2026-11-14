package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

type change struct {
	Path   string `json:"path"`
	Blob   string `json:"blob,omitempty"`
	Mode   string `json:"mode,omitempty"`
	Delete bool   `json:"delete,omitempty"`
}
type commitRequest struct {
	Parents  []string          `json:"parents"`
	BaseTree *string           `json:"baseTree,omitempty"`
	Changes  []change          `json:"changes"`
	Author   string            `json:"author"`
	Message  string            `json:"message"`
	Trailers map[string]string `json:"trailers"`
	Time     *int64            `json:"time"`
}

func safeLine(s string) bool { return !strings.ContainsAny(s, "\r\n\x00") }

type commitTiming struct {
	prechecks, read, build time.Duration
	readWaves              int
	objects.FlushTiming
}

type commitTimingKey struct{}

func makeCommit(ctx context.Context, r *objects.Repository, l string, q commitRequest) (any, error) {
	timing, ok := ctx.Value(commitTimingKey{}).(*commitTiming)
	if !ok {
		timing = &commitTiming{}
	}
	r = r.ForLineage(l)
	if q.Parents == nil {
		return nil, invalid("missing field parents")
	}
	parents := append([]string{}, q.Parents...)
	if len(parents) > 2 {
		return nil, invalid("parents: at most 2")
	}
	if len(q.Changes) > 10000 {
		return nil, large("")
	}
	if q.Author == "" || !safeLine(q.Author) {
		return nil, invalid("author: required single line without NUL")
	}
	if strings.ContainsRune(q.Message, 0) {
		return nil, invalid("message: NUL is forbidden")
	}
	start := time.Now()
	base, blobs, err := commitPrechecks(ctx, r, l, q)
	timing.prechecks = time.Since(start)
	if err != nil {
		return nil, err
	}
	start = time.Now()
	tree, paths := commitPaths(q.Changes, base)
	timing.build = time.Since(start)
	start = time.Now()
	if len(q.Changes) > 0 {
		err = tree.read(ctx, r, timing)
	}
	timing.read = time.Since(start)
	if err != nil {
		return nil, err
	}

	start = time.Now()
	changed := 0
	var bytes int64
	for i, c := range q.Changes {
		if paths[i].dir == nil {
			return nil, invalid("invalid path %s", c.Path)
		}
		if c.Mode != "" && c.Mode != "100644" && c.Mode != "100755" && c.Mode != "120000" {
			return nil, invalid("invalid mode %s", c.Mode)
		}
		dir, name := paths[i].dir, paths[i].name
		prev, exists := dir.files[name]
		if c.Delete {
			if c.Blob != "" || c.Mode != "" {
				return nil, invalid("delete: blob and mode must be absent")
			}
			if exists {
				delete(dir.files, name)
				changed++
			}
			continue
		}
		next := prev
		if c.Blob != "" {
			if !root.Hex(c.Blob, 40) {
				return nil, invalid("blob: expected a 40-character Git id")
			}
			found := blobs[c.Blob]
			if errors.Is(found.Err, sql.ErrNoRows) {
				return nil, bad("unknown_blob")
			}
			if found.Err != nil {
				return nil, found.Err
			}
			next.SHA1, next.Size = found.Blob.SHA1, found.Blob.Size
			bytes += found.Blob.Size
		} else if !exists {
			return nil, invalid("blob: required for new path %q", c.Path)
		}
		next.Path = name
		if c.Mode != "" {
			next.Mode = c.Mode
		}
		if next.Mode == "" {
			next.Mode = "100644"
		}
		if next.SHA1 != prev.SHA1 || next.Mode != prev.Mode {
			changed++
		}
		dir.files[name] = next
	}
	for k, v := range q.Trailers {
		if k == "" || !safeLine(k) || strings.Contains(k, ":") {
			return nil, invalid("invalid trailer key %s", k)
		}
		if !safeLine(v) {
			return nil, invalid("invalid trailer value %s", k)
		}
	}
	r = r.BeginPublication()
	treeID, e := tree.build(ctx, r, true)
	if e == nil && base != "" && treeID != base {
		r.StageTreeParent(treeID, base)
	}
	if e != nil {
		return nil, e
	}
	now := time.Now().Unix()
	if q.Time != nil {
		now = *q.Time
	}
	body := "tree " + treeID + "\n"
	for _, parent := range parents {
		body += "parent " + parent + "\n"
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
	timing.build += time.Since(start)
	if e = r.FlushTimed(ctx, &timing.FlushTiming); e != nil {
		return nil, e
	}
	return map[string]any{"tree": treeID, "commit": id, "changed": changed, "bytes": bytes, "parents": parents, "time": now}, nil
}
func commitPrechecks(ctx context.Context, r *objects.Repository, l string, q commitRequest) (string, map[string]objects.BlobLookup, error) {
	var base string
	var parentErrors [2]error
	var baseErr, blobErr error
	var blobs map[string]objects.BlobLookup
	checkBase := func(id string) {
		base = id
		if id != "" {
			baseErr = require(ctx, r, l, id, "tree", true, "baseTree")
		}
	}

	var wg sync.WaitGroup
	run := func(check func()) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			check()
		}()
	}
	for i, parent := range q.Parents {
		run(func() {
			if !root.Hex(parent, 40) {
				parentErrors[i] = bad("unknown_commit")
				return
			}
			parentErrors[i] = require(ctx, r, l, parent, "commit", true)
			if i != 0 || parentErrors[i] != nil {
				return
			}
			c, err := readCommit(ctx, r, parent)
			if err != nil {
				parentErrors[i] = err
				return
			}
			if q.BaseTree == nil {
				// Only an inferred base depends on reading the first parent.
				checkBase(c["tree"].(string))
			}
		})
	}
	if q.BaseTree != nil {
		run(func() { checkBase(*q.BaseTree) })
	}
	var ids []string
	for _, c := range q.Changes {
		if !c.Delete && root.Hex(c.Blob, 40) {
			ids = append(ids, c.Blob)
		}
	}
	if len(ids) > 0 {
		run(func() { blobs, blobErr = r.BlobInfos(ctx, l, ids) })
	}
	wg.Wait()
	// Report parent failures in parent order, then the baseTree failure.
	// The caller reports per-blob failures in change request order.
	for _, err := range parentErrors {
		if err != nil {
			return "", nil, err
		}
	}
	if baseErr != nil {
		return "", nil, baseErr
	}
	return base, blobs, blobErr
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
			return nil, invalid("limit: must be between 1 and 10000")
		}
		limit = n
	}
	if dir != "" {
		if objects.Path(dir) != nil {
			return nil, invalid("invalid path %s", dir)
		}
		for _, p := range strings.Split(dir, "/") {
			es, e := r.SizedTree(ctx, id)
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
	var es []objects.Entry
	var e error
	if recursive {
		es, e = r.TreeEntries(ctx, id)
	} else {
		es, e = r.SizedTree(ctx, id)
		sort.Slice(es, func(i, j int) bool { return gitLess(es[i], es[j]) })
	}
	if e != nil {
		return nil, e
	}
	if dir != "" {
		for i := range es {
			es[i].Path = dir + "/" + es[i].Path
		}
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
			return nil, invalid("after: must name a path in the tree")
		}
	}
	page := es[start:min(len(es), start+limit)]
	out := []listingEntry{}
	for _, f := range page {
		v := listingEntry{Path: f.Path, Mode: f.Mode}
		if f.Mode == "40000" {
			v.Mode = "040000"
			v.Tree = f.SHA1
		} else {
			size := f.Size
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
	OldSize *int64 `json:"oldSize,omitempty"`
	NewSize *int64 `json:"newSize,omitempty"`
}

func treeDiff(ctx context.Context, r *objects.Repository, a, b, prefix string) ([]diffChange, error) {
	if prefix != "" && objects.Path(prefix) != nil {
		return nil, invalid("invalid path %s", prefix)
	}
	out := []diffChange{}
	type pair struct{ a, b, dir string }
	for level := []pair{{a: a, b: b}}; len(level) > 0; {
		var ids []string
		for _, p := range level {
			if p.a != "" && p.a != p.b {
				ids = append(ids, p.a)
			}
			if p.b != "" && p.a != p.b {
				ids = append(ids, p.b)
			}
		}
		trees, err := r.SizedTrees(ctx, ids)
		if err != nil {
			return nil, err
		}
		var next []pair
		for _, p := range level {
			if p.a == p.b {
				continue
			}
			am, bm := map[string]objects.Entry{}, map[string]objects.Entry{}
			for _, f := range trees[p.a] {
				am[f.Path] = f
			}
			for _, f := range trees[p.b] {
				bm[f.Path] = f
			}
			names := map[string]bool{}
			for n := range am {
				names[n] = true
			}
			for n := range bm {
				names[n] = true
			}
			for n := range names {
				x, y := am[n], bm[n]
				path := p.dir + n
				if prefix != "" && path != prefix && !strings.HasPrefix(path, prefix+"/") && !strings.HasPrefix(prefix, path+"/") {
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
					next = append(next, pair{ax, by, path + "/"})
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
				c := diffChange{Path: path, Status: status, OldBlob: x.SHA1, NewBlob: y.SHA1, OldMode: x.Mode, NewMode: y.Mode}
				if x.SHA1 != "" {
					size := x.Size
					c.OldSize = &size
				}
				if y.SHA1 != "" {
					size := y.Size
					c.NewSize = &size
				}
				out = append(out, c)
			}
		}
		level = next
	}
	sort.Slice(out, func(i, j int) bool { return diffPathLess(out[i].Path, out[j].Path) })
	return out, nil
}

// Diff order compares path components and emits descendants before their parent.
func diffPathLess(a, b string) bool {
	for {
		x, restA, moreA := strings.Cut(a, "/")
		y, restB, moreB := strings.Cut(b, "/")
		if x != y {
			return x < y
		}
		if !moreA || !moreB {
			return moreA
		}
		a, b = restA, restB
	}
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
	for name, b := range fields {
		if strings.EqualFold(name, "baseTree") && string(b) == "null" {
			empty := ""
			v.BaseTree = &empty
		}
	}
	*q = commitRequest(v)
	return nil
}

// treeEntry descends exactly one tree per path component, without listing.
func treeEntry(ctx context.Context, r *objects.Repository, l, id, path string) (listingEntry, error) {
	parts := strings.Split(path, "/")
	for i, p := range parts {
		es, e := r.SizedTree(ctx, id)
		if e != nil {
			return listingEntry{}, e
		}
		found := false
		for _, f := range es {
			if f.Path != p {
				continue
			}
			found = true
			if i == len(parts)-1 {
				v := listingEntry{Path: path, Mode: f.Mode}
				if f.Mode == "40000" {
					v.Mode = "040000"
					v.Tree = f.SHA1
				} else {

					v.Blob = f.SHA1
					v.Size = &f.Size
				}
				return v, nil
			}
			if f.Mode != "40000" {
				return listingEntry{}, missing()
			}
			id = f.SHA1
			break
		}
		if !found {
			return listingEntry{}, missing()
		}
	}
	return listingEntry{}, missing()
}
