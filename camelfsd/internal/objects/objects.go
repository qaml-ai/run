package objects

import (
	"bytes"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"io"
	"os"
	"sort"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

const MaxBlob = 5 << 30
const InlineTree = 400 << 10

var ErrIgnored = errors.New("ignored-path")
var ErrHash = errors.New("hash-mismatch")

type Repository struct {
	DB      *refs.DB
	Store   store.Store
	TempDir string
	// Query observes repository reads for diagnostics and query-budget tests.
	Query func(string)
}
type File struct {
	SHA256 string `json:"sha256"`
	Mode   string `json:"mode,omitempty"`
}
type Request struct {
	Lineage    string          `json:"lineage"`
	ParentTree string          `json:"parentTree,omitempty"`
	Files      map[string]File `json:"files"`
}
type Result struct {
	Tree     string  `json:"tree"`
	Trees    int     `json:"trees"`
	Blobs    int     `json:"blobs"`
	ImportMs float64 `json:"importMs"`
}
type Blob struct {
	Existing bool   `json:"-"`
	SHA256   string `json:"sha256"`
	SHA1     string `json:"sha1"`
	Size     int64  `json:"size"`
}
type Entry struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
	SHA1 string `json:"sha1"`
	Size int64  `json:"size"`
}
type Missing struct{ Hashes []string }

func (m *Missing) Error() string { return "missing-blobs" }

func Path(p string) error {
	if !utf8.ValidString(p) || len(p) == 0 || len(p) > 4096 || strings.ContainsRune(p, 0) {
		return apierr.Invalid("invalid path")
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".git" {
			return ErrIgnored
		}
		if len(part) > 255 || part == "" || part == "." || part == ".." {
			return apierr.Invalid("invalid path")
		}
	}
	return nil
}

func (r *Repository) Upload(ctx context.Context, lineage, hash string, size int64, body io.Reader) (Blob, error) {
	b := Blob{SHA256: hash, Size: size}
	if lineage == "" || hash != "" && !root.Hex(hash, 64) || size < -1 {
		return b, apierr.Invalid("invalid blob request")
	}
	if size > MaxBlob {
		return b, &apierr.Error{Status: 413, Code: "blob-too-large", Cause: fmt.Errorf("blob exceeds %d bytes", MaxBlob)}
	}
	f, e := os.CreateTemp(r.TempDir, "camelfsd-blob-")
	if e != nil {
		return b, e
	}
	defer os.Remove(f.Name())
	defer f.Close()
	h256, h1 := sha256.New(), sha1.New()
	limit := size
	var dst io.Writer = io.MultiWriter(f, h256)
	if size >= 0 {
		fmt.Fprintf(h1, "blob %d\x00", size)
		dst = io.MultiWriter(dst, h1)
	} else {
		limit = MaxBlob
	}
	n, e := io.Copy(dst, io.LimitReader(body, limit+1))
	if n > MaxBlob {
		return b, &apierr.Error{Status: 413, Code: "blob-too-large", Cause: fmt.Errorf("blob exceeds %d bytes", MaxBlob)}
	}
	if e != nil {
		if size >= 0 && errors.Is(e, io.ErrUnexpectedEOF) {
			return b, apierr.Invalid("invalid content length")
		}
		return b, e
	}
	if size >= 0 && n != size {
		return b, apierr.Invalid("invalid content length")
	}
	if size < 0 {
		size = n
		b.Size = n
		// Git's blob hash prefixes the measured length. Replay the bounded temp file.
		fmt.Fprintf(h1, "blob %d\x00", size)
		if _, e = f.Seek(0, io.SeekStart); e != nil {
			return b, e
		}
		if _, e = io.Copy(h1, f); e != nil {
			return b, e
		}
	}
	if hash != "" && fmt.Sprintf("%x", h256.Sum(nil)) != hash {
		return b, ErrHash
	}
	b.SHA256 = fmt.Sprintf("%x", h256.Sum(nil))
	b.SHA1 = fmt.Sprintf("%x", h1.Sum(nil))
	var exists int
	e = r.DB.DB.QueryRowContext(ctx, "SELECT count(*) FROM lineage_blobs WHERE lineage=? AND sha1=?", lineage, b.SHA1).Scan(&exists)
	b.Existing = exists > 0
	if e == nil && !b.Existing {
		b.Existing, e = r.Reachable(ctx, lineage, b.SHA1, "blob")
	}
	if e != nil {
		return b, e
	}
	key := "o/" + b.SHA1

	if e = store.PutBlobFile(ctx, &store.Uploaded{Store: r.Store, DB: r.DB.DB}, key, f); e != nil {
		return b, e
	}

	_, e = r.DB.DB.ExecContext(ctx, "INSERT OR IGNORE INTO lineage_blobs VALUES(?,?,?,?,?)", lineage, b.SHA256, b.SHA1, size, time.Now().UnixMilli())
	if e == nil {
		e = r.Record(ctx, lineage, b.SHA1, "blob", &b)
	}
	return b, e
}

type node struct {
	dirs  map[string]*node
	files map[string]Entry
}

func newNode() *node { return &node{map[string]*node{}, map[string]Entry{}} }

type treeObject struct {
	id    string
	bytes []byte
}

func (r *Repository) Import(ctx context.Context, q Request) (Result, error) {
	start := time.Now()
	out := Result{}
	if q.Lineage == "" || q.Files == nil || len(q.Files) > 200000 || q.ParentTree != "" && !root.Hex(q.ParentTree, 40) {
		return out, apierr.Invalid("invalid tree request")
	}
	// Validate the complete listing before consulting blob availability.
	for p, f := range q.Files {
		if e := Path(p); e != nil {
			return out, e
		}
		if !root.Hex(f.SHA256, 64) || f.Mode != "" && f.Mode != "100644" && f.Mode != "100755" && f.Mode != "120000" {
			return out, apierr.Invalid("invalid file mode or hash")
		}
	}
	blobs := map[string]Blob{}

	hashes := make([]string, 0, len(q.Files))
	seen := map[string]bool{}
	for _, f := range q.Files {
		if !seen[f.SHA256] {
			hashes = append(hashes, f.SHA256)
			seen[f.SHA256] = true
		}
	}
	var e error
	for start := 0; start < len(hashes); start += 500 {
		batch := hashes[start:min(start+500, len(hashes))]
		args := []any{q.Lineage}
		marks := make([]string, len(batch))
		for i, h := range batch {
			args = append(args, h)
			marks[i] = "?"
		}
		r.observe("import-blobs")
		rows, err := r.DB.DB.QueryContext(ctx, "SELECT sha256,sha1,size FROM lineage_blobs WHERE lineage=? AND sha256 IN ("+strings.Join(marks, ",")+")", args...)
		if err != nil {
			return out, err
		}
		for rows.Next() {
			var b Blob
			if err = rows.Scan(&b.SHA256, &b.SHA1, &b.Size); err != nil {
				rows.Close()
				return out, err
			}
			blobs[b.SHA256] = b
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return out, err
		}
	}

	missing := map[string]bool{}
	top := newNode()
	for p, f := range q.Files {
		b, ok := blobs[f.SHA256]
		if !ok {
			missing[f.SHA256] = true
		}
		if f.Mode == "" {
			f.Mode = "100644"
		}
		parts := strings.Split(p, "/")
		n := top
		for _, part := range parts[:len(parts)-1] {
			if _, ok := n.files[part]; ok {
				return out, apierr.Invalid("invalid path conflict")
			}
			if n.dirs[part] == nil {
				n.dirs[part] = newNode()
			}
			n = n.dirs[part]
		}
		name := parts[len(parts)-1]
		if n.dirs[name] != nil {
			return out, apierr.Invalid("invalid path conflict")
		}
		n.files[name] = Entry{p, f.Mode, b.SHA1, b.Size}
	}
	if len(missing) > 0 {
		hashes := make([]string, 0, len(missing))
		for h := range missing {
			hashes = append(hashes, h)
		}
		sort.Strings(hashes)
		if len(hashes) > 10000 {
			hashes = hashes[:10000]
		}
		return out, &Missing{hashes}
	}
	var pending []treeObject
	var build func(*node, string) (string, error)
	build = func(n *node, parent string) (string, error) {
		// Read only the corresponding parent directory, as it is needed.
		old := map[string]Entry{}
		if parent != "" {
			entries, err := r.read(ctx, parent)
			if err != nil && !errors.Is(err, sql.ErrNoRows) && !errors.Is(err, os.ErrNotExist) {
				return "", err
			}
			if errors.Is(err, sql.ErrNoRows) || errors.Is(err, os.ErrNotExist) {
				parent = ""
			}
			for _, entry := range entries {
				old[entry.Path] = entry
			}
		}
		entries := make([]Entry, 0, len(n.files)+len(n.dirs))
		for name, entry := range n.files {
			entry.Path = name
			entries = append(entries, entry)
		}
		for name, dir := range n.dirs {
			prev := old[name]
			if prev.Mode != "40000" {
				prev.SHA1 = ""
			}
			id, err := build(dir, prev.SHA1)
			if err != nil {
				return "", err
			}
			entries = append(entries, Entry{Path: name, Mode: "40000", SHA1: id})
		}
		sort.Slice(entries, func(i, j int) bool {
			a, b := entries[i].Path, entries[j].Path
			if entries[i].Mode == "40000" {
				a += "/"
			}
			if entries[j].Mode == "40000" {
				b += "/"
			}
			return a < b
		})
		// Identical entries reuse the parent without allocating its encoding.
		same := parent != "" && len(old) == len(entries)
		for _, entry := range entries {
			prev, ok := old[entry.Path]
			if !ok || prev.Mode != entry.Mode || prev.SHA1 != entry.SHA1 {
				same = false
			}
		}
		if same {
			if err := r.Record(ctx, q.Lineage, parent, "tree", nil); err != nil {
				return "", err
			}
			return parent, nil
		}
		var buf bytes.Buffer
		for _, entry := range entries {
			fmt.Fprintf(&buf, "%s %s\x00", entry.Mode, entry.Path)
			raw, _ := hex.DecodeString(entry.SHA1)
			buf.Write(raw)
		}
		b := buf.Bytes()
		if b == nil {
			b = []byte{}
		}
		id := store.GitHash("tree", b)
		pending = append(pending, treeObject{id, b})
		return id, nil
	}
	out.Tree, e = build(top, q.ParentTree)
	if e != nil {
		return out, e
	}
	keys := make([]string, len(pending))
	all := map[string][]byte{}
	for i, obj := range pending {
		keys[i] = obj.id
		all[obj.id] = obj.bytes
	}
	if e = store.Parallel(ctx, 16, keys, func(id string) error {
		if err := (&store.Uploaded{Store: r.Store, DB: r.DB.DB}).Put(ctx, "t/"+id, all[id]); err != nil {
			return err
		}
		return r.Record(ctx, q.Lineage, id, "tree", nil)
	}); e != nil {
		return out, e
	}
	tx, e := r.DB.DB.BeginTx(ctx, nil)
	if e != nil {
		return out, e
	}
	defer tx.Rollback()
	for _, obj := range pending {
		var b any = obj.bytes

		res, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO objects VALUES(?,'tree',?,?,?)", obj.id, b, len(obj.bytes), time.Now().UnixMilli())
		if err != nil {
			return out, err
		}
		count, _ := res.RowsAffected()
		out.Trees += int(count)
	}
	if e = tx.Commit(); e != nil {
		return out, e
	}
	out.Blobs = len(q.Files)
	if q.ParentTree != "" && q.ParentTree != out.Tree {
		_, e = r.DB.DB.ExecContext(ctx, "INSERT OR IGNORE INTO tree_parents(tree,parent) VALUES(?,?)", out.Tree, q.ParentTree)
		if e != nil {
			return out, e
		}
	}
	out.ImportMs = float64(time.Since(start).Microseconds()) / 1000
	return out, nil
}

func (r *Repository) observe(query string) {
	if r.Query != nil {
		r.Query(query)
	}
}

func (r *Repository) read(ctx context.Context, id string) ([]Entry, error) {
	if !root.Hex(id, 40) {
		return nil, apierr.Invalid("invalid tree id")
	}
	r.observe("tree")
	b, e := r.Object(ctx, id, "tree")
	if e != nil {
		return nil, e
	}
	entries := []Entry{}
	for len(b) > 0 {
		end := bytes.IndexByte(b, 0)
		if end < 0 || len(b) < end+21 {
			return nil, fmt.Errorf("corrupt tree")
		}
		mode, name, ok := strings.Cut(string(b[:end]), " ")
		if !ok {
			return nil, fmt.Errorf("corrupt tree")
		}
		entries = append(entries, Entry{Path: name, Mode: mode, SHA1: hex.EncodeToString(b[end+1 : end+21]), Size: -1})
		b = b[end+21:]
	}
	return entries, nil
}

func (r *Repository) TreeEntries(ctx context.Context, id string) ([]Entry, error) {
	out := []Entry{}
	var walk func(string, string) error
	walk = func(tree, prefix string) error {
		entries, e := r.read(ctx, tree)
		if e != nil {
			return e
		}
		for _, entry := range entries {
			entry.Path = prefix + entry.Path
			if entry.Mode == "40000" {
				if e = walk(entry.SHA1, entry.Path+"/"); e != nil {
					return e
				}
				continue
			}

			out = append(out, entry)
		}
		return nil
	}
	e := walk(id, "")
	if e != nil {
		return nil, e
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}
func (r *Repository) Entries(ctx context.Context, id string) ([]Entry, error) {
	out, e := r.TreeEntries(ctx, id)
	if e != nil {
		return nil, e
	}
	// Bounded IN batches avoid one size query per file without depending on
	// SQLite's host-parameter limit for large trees.
	sizes := map[string]int64{}
	for start := 0; start < len(out); start += 500 {
		batch := out[start:min(start+500, len(out))]
		args := make([]any, len(batch))
		marks := make([]string, len(batch))
		for i, f := range batch {
			args[i] = f.SHA1
			marks[i] = "?"
		}
		r.observe("sizes")
		rows, err := r.DB.DB.QueryContext(ctx, "SELECT sha1,size FROM lineage_blobs WHERE sha1 IN ("+strings.Join(marks, ",")+") GROUP BY sha1", args...)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var sha string
			var size int64
			if err = rows.Scan(&sha, &size); err != nil {
				rows.Close()
				return nil, err
			}
			sizes[sha] = size
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	for i := range out {
		out[i].Size = sizes[out[i].SHA1]
	}

	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, e
}
func (r *Repository) File(ctx context.Context, id, path string) (Entry, error) {
	if e := Path(path); e != nil {
		return Entry{}, e
	}
	parts := strings.Split(path, "/")
	for i, part := range parts {
		entries, e := r.read(ctx, id)
		if e != nil {
			return Entry{}, e
		}
		found := false
		for _, entry := range entries {
			if entry.Path == part {
				if i == len(parts)-1 && entry.Mode != "40000" {
					return entry, nil
				}
				if entry.Mode == "40000" {
					id = entry.SHA1
					found = true
				}
				break
			}
		}
		if !found {
			return Entry{}, os.ErrNotExist
		}
	}
	return Entry{}, os.ErrNotExist
}
