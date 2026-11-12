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
	"io"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

const MaxBlob = 256 << 20
const InlineTree = 400 << 10

var ErrIgnored = errors.New("ignored-path")
var ErrHash = errors.New("hash-mismatch")

type Repository struct {
	DB      *refs.DB
	Store   store.Store
	TempDir string
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
	SHA256 string `json:"sha256"`
	SHA1   string `json:"sha1"`
	Size   int64  `json:"size"`
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
	if len(p) == 0 || len(p) > 4096 || strings.ContainsRune(p, 0) {
		return fmt.Errorf("invalid path")
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".git" {
			return ErrIgnored
		}
		if part == "" || part == "." || part == ".." {
			return fmt.Errorf("invalid path")
		}
	}
	return nil
}

func (r *Repository) Upload(ctx context.Context, lineage, hash string, size int64, body io.Reader) (Blob, error) {
	b := Blob{SHA256: hash, Size: size}
	if lineage == "" || !root.Hex(hash, 64) || size < 0 || size > MaxBlob {
		return b, fmt.Errorf("invalid blob request")
	}
	f, e := os.CreateTemp(r.TempDir, "camelfsd-blob-")
	if e != nil {
		return b, e
	}
	defer os.Remove(f.Name())
	defer f.Close()
	h256, h1 := sha256.New(), sha1.New()
	fmt.Fprintf(h1, "blob %d\x00", size)
	n, e := io.Copy(io.MultiWriter(f, h256, h1), io.LimitReader(body, size+1))
	if e != nil {
		return b, e
	}
	if n != size {
		return b, fmt.Errorf("invalid content length")
	}
	if fmt.Sprintf("%x", h256.Sum(nil)) != hash {
		return b, ErrHash
	}
	b.SHA1 = fmt.Sprintf("%x", h1.Sum(nil))
	key := "o/" + b.SHA1
	has, e := r.Store.Has(ctx, key)
	if e != nil {
		return b, e
	}
	if !has {
		if e = store.PutBlobFile(ctx, r.Store, key, f); e != nil {
			return b, e
		}
	}
	_, e = r.DB.DB.ExecContext(ctx, "INSERT OR IGNORE INTO lineage_blobs VALUES(?,?,?,?,?)", lineage, hash, b.SHA1, size, time.Now().UnixMilli())
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
		return out, fmt.Errorf("invalid tree request")
	}
	// Validate the complete listing before consulting blob availability.
	for p, f := range q.Files {
		if e := Path(p); e != nil {
			return out, e
		}
		if !root.Hex(f.SHA256, 64) || f.Mode != "" && f.Mode != "100644" && f.Mode != "100755" && f.Mode != "120000" {
			return out, fmt.Errorf("invalid file mode or hash")
		}
	}
	blobs := map[string]Blob{}
	rows, e := r.DB.DB.QueryContext(ctx, "SELECT sha256,sha1,size FROM lineage_blobs WHERE lineage=?", q.Lineage)
	if e != nil {
		return out, e
	}
	for rows.Next() {
		var b Blob
		if e = rows.Scan(&b.SHA256, &b.SHA1, &b.Size); e != nil {
			rows.Close()
			return out, e
		}
		blobs[b.SHA256] = b
	}
	e = rows.Err()
	rows.Close()
	if e != nil {
		return out, e
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
				return out, fmt.Errorf("invalid path conflict")
			}
			if n.dirs[part] == nil {
				n.dirs[part] = newNode()
			}
			n = n.dirs[part]
		}
		name := parts[len(parts)-1]
		if n.dirs[name] != nil {
			return out, fmt.Errorf("invalid path conflict")
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
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return "", err
			}
			if errors.Is(err, sql.ErrNoRows) {
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
	// Store large trees before the transaction. Failed transactions can leave only
	// harmless content-addressed objects, never a row referring to absent bytes.
	for _, obj := range pending {
		if len(obj.bytes) > InlineTree {
			has, err := r.Store.Has(ctx, "t/"+obj.id)
			if err != nil {
				return out, err
			}
			if !has {
				if err = r.Store.Put(ctx, "t/"+obj.id, obj.bytes); err != nil {
					return out, err
				}
			}
		}
	}
	tx, e := r.DB.DB.BeginTx(ctx, nil)
	if e != nil {
		return out, e
	}
	defer tx.Rollback()
	for _, obj := range pending {
		var b any = obj.bytes
		if len(obj.bytes) > InlineTree {
			b = nil
		}
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
	out.ImportMs = float64(time.Since(start).Microseconds()) / 1000
	return out, nil
}

func (r *Repository) read(ctx context.Context, id string) ([]Entry, error) {
	var b []byte
	if !root.Hex(id, 40) {
		return nil, fmt.Errorf("invalid tree id")
	}
	e := r.DB.DB.QueryRowContext(ctx, "SELECT bytes FROM objects WHERE id=? AND kind='tree'", id).Scan(&b)
	if e != nil {
		return nil, e
	}
	if b == nil {
		b, e = r.Store.Get(ctx, "t/"+id)
		if e != nil {
			return nil, e
		}
	}
	if store.GitHash("tree", b) != id {
		return nil, fmt.Errorf("corrupt tree")
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

func (r *Repository) Entries(ctx context.Context, id string) ([]Entry, error) {
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
			e = r.DB.DB.QueryRowContext(ctx, "SELECT size FROM lineage_blobs WHERE sha1=? LIMIT 1", entry.SHA1).Scan(&entry.Size)
			if e != nil && !errors.Is(e, sql.ErrNoRows) {
				return e
			}
			out = append(out, entry)
		}
		return nil
	}
	e := walk(id, "")
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
