package api

import (
	"bytes"
	"context"
	"crypto/sha1"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"net/textproto"
	"os"
	"strconv"
	"strings"
	"sync"

	"time"

	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type invalidRequest string

func (e invalidRequest) Error() string         { return string(e) }
func invalid(format string, args ...any) error { return invalidRequest(fmt.Sprintf(format, args...)) }

type storageError struct {
	status  int
	code    string
	details any
}

func (e *storageError) Error() string { return e.code }
func bad(code string) error           { return &storageError{400, code, nil} }
func missing() error                  { return &storageError{404, "not_in_tree", nil} }
func large(path string) error {
	return &storageError{413, "too_large", map[string]string{"path": path}}
}
func jsonReply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func storageFail(w http.ResponseWriter, e error) {
	status, code, details := 500, "internal", any(nil)
	var se *storageError
	var ae *apierr.Error
	var validation invalidRequest
	message := ""
	if errors.As(e, &validation) {
		status, code, message = 400, "invalid_request", validation.Error()
	} else if errors.As(e, &se) {
		status, code, details = se.status, se.code, se.details
	} else if errors.As(e, &ae) {
		status, code = ae.Status, "invalid_request"
		if status == 413 {
			code = "too_large"
		}
	} else if errors.Is(e, objects.ErrHash) {
		status, code = 400, "blob_mismatch"
	} else if errors.Is(e, store.ErrUnavailable) {
		status, code = 503, "unavailable"
	} else if errors.Is(e, objects.ErrIgnored) {
		status, code = 400, "invalid_request"
	}
	if status == 500 {
		log.Printf("op=storage error=%v", e)
	}
	if message == "" {
		message = code
	}
	v := map[string]any{"code": code, "message": message}
	if details != nil {
		v["details"] = details
	}
	jsonReply(w, status, map[string]any{"error": v})
}
func decodeStorage(r *http.Request, v any) error {
	d := json.NewDecoder(io.LimitReader(r.Body, 64<<20))
	d.DisallowUnknownFields()
	if e := d.Decode(v); e != nil {
		return invalid("%s", strings.TrimPrefix(e.Error(), "json: "))
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return bad("invalid_request")
	}
	return nil
}
func (s *Server) repository() *objects.Repository {
	return &objects.Repository{DB: s.Manager.Refs.(*refs.DB), Store: s.Manager.Store, TempDir: s.Manager.Data}
}
func require(ctx context.Context, repo *objects.Repository, l, id, kind string, write bool) error {
	if !root.Hex(id, 40) {
		return bad("invalid_request")
	}
	ok, e := repo.Reachable(ctx, l, id, kind)
	if e != nil {
		return e
	}
	if !ok {
		if write {
			return bad("unknown_" + kind)
		}
		return missing()
	}
	return nil
}
func (s *Server) storage(w http.ResponseWriter, r *http.Request) {
	if !s.authorize(w, r) {
		return
	}
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v1/lineages/"), "/")
	if len(parts) < 2 || !store.Lineage(parts[0]) {
		storageFail(w, bad("invalid_request"))
		return
	}
	l := parts[0]
	route := strings.Join(parts[1:], "/")
	repo := s.repository().ForLineage(l)
	// Serialize keyed mutations through response publication. A failed request is
	// retryable; only successful results enter the 24-hour response cache.
	write := r.Method == "PUT" || r.Method == "POST" && route != "read"
	if write && r.Header.Get("Idempotency-Key") != "" {
		key := r.Header.Get("Idempotency-Key")
		if len(key) > 256 {
			storageFail(w, bad("invalid_request"))
			return
		}
		unlock := s.lockIdempotency(l, key)
		defer unlock()
		var status int
		var body []byte
		e := repo.DB.DB.QueryRowContext(r.Context(), "SELECT status,body FROM idempotency WHERE key=? AND lineage=? AND route=? AND created_at>?", key, l, route, time.Now().Add(-24*time.Hour).UnixMilli()).Scan(&status, &body)
		if e == nil {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(status)
			_, _ = w.Write(body)
			return
		}
		if e != sql.ErrNoRows {
			storageFail(w, e)
			return
		}
		rec := httptest.NewRecorder()
		s.storageRoute(rec, r, l, route, repo)
		if rec.Code >= 200 && rec.Code < 300 {
			_, e = repo.DB.DB.ExecContext(r.Context(), "INSERT OR REPLACE INTO idempotency VALUES(?,?,?,?,?,?)", key, l, route, rec.Code, rec.Body.Bytes(), time.Now().UnixMilli())
			if e != nil {
				storageFail(w, e)
				return
			}
		}
		for k, v := range rec.Header() {
			w.Header()[k] = v
		}
		w.WriteHeader(rec.Code)
		_, _ = w.Write(rec.Body.Bytes())
		return
	}
	s.storageRoute(w, r, l, route, repo)
}
func (s *Server) storageRoute(w http.ResponseWriter, r *http.Request, l, route string, repo *objects.Repository) {
	ctx := r.Context()
	q := r.URL.Query()
	fail := func(e error) { storageFail(w, e) }
	switch {
	case route == "blobs" && r.Method == "PUT":
		expected := r.Header.Get("X-Camel-Sha256")
		if expected != "" && !root.Hex(expected, 64) {
			fail(bad("blob_mismatch"))
			return
		}
		b, e := repo.Upload(ctx, l, expected, r.ContentLength, r.Body)
		if e != nil {
			fail(e)
			return
		}
		status := 201
		if b.Existing {
			status = 200
		}
		jsonReply(w, status, map[string]any{"blob": b.SHA1, "sha256": b.SHA256, "size": b.Size})
	case strings.HasPrefix(route, "blobs/") && r.Method == "GET":
		tree := q.Get("tree")
		if e := require(ctx, repo, l, tree, "tree", false); e != nil {
			if _, ok := e.(*storageError); ok {
				e = missing()
			}
			fail(e)
			return
		}
		f, e := repo.File(ctx, tree, q.Get("path"))
		if e != nil && !errors.Is(e, os.ErrNotExist) {
			fail(e)
			return
		}
		if e != nil || f.SHA1 != strings.TrimPrefix(route, "blobs/") {
			fail(missing())
			return
		}
		info, e := repo.BlobInfo(ctx, l, f.SHA1)
		if e != nil {
			fail(e)
			return
		}
		if info.Size > 8<<20 {
			file, e := blobFile(ctx, repo, info)
			if e != nil {
				fail(e)
				return
			}
			defer os.Remove(file.Name())
			defer file.Close()
			head := make([]byte, 512)
			n, e := file.Read(head)
			if e != nil && e != io.EOF {
				fail(e)
				return
			}
			if _, e = file.Seek(0, io.SeekStart); e != nil {
				fail(e)
				return
			}
			w.Header().Set("X-Camel-Blob", f.SHA1)
			w.Header().Set("X-Camel-Size", strconv.FormatInt(info.Size, 10))
			w.Header().Set("Content-Type", http.DetectContentType(head[:n]))
			http.ServeContent(w, r, "", time.Time{}, file)
			return
		}
		b, e := blobBytes(ctx, repo, l, f.SHA1)
		if e != nil {
			fail(e)
			return
		}
		w.Header().Set("X-Camel-Blob", f.SHA1)
		w.Header().Set("X-Camel-Size", strconv.Itoa(len(b)))
		w.Header().Set("Content-Type", http.DetectContentType(b[:min(512, len(b))]))
		http.ServeContent(w, r, "", time.Time{}, bytes.NewReader(b))
	case route == "commits" && r.Method == "POST":
		var v commitRequest
		if e := decodeStorage(r, &v); e != nil {
			fail(e)
			return
		}
		out, e := makeCommit(ctx, repo, l, v)
		if e != nil {
			fail(e)
			return
		}
		jsonReply(w, 201, out)
	case strings.HasPrefix(route, "commits/") && r.Method == "GET":
		id := strings.TrimPrefix(route, "commits/")
		if e := require(ctx, repo, l, id, "commit", false); e != nil {
			fail(e)
			return
		}
		v, e := readCommit(ctx, repo, id)
		if e != nil {
			fail(e)
			return
		}
		jsonReply(w, 200, v)
	case strings.HasPrefix(route, "trees/") && r.Method == "GET":
		id := strings.TrimPrefix(route, "trees/")
		if e := require(ctx, repo, l, id, "tree", false); e != nil {
			fail(e)
			return
		}
		v, e := listTree(ctx, repo, l, id, q.Get("path"), q.Get("after"), q.Get("recursive") == "1", q.Get("limit"))
		if e != nil {
			fail(e)
			return
		}
		jsonReply(w, 200, v)
	case route == "diff" && r.Method == "GET":
		for _, id := range []string{q.Get("from"), q.Get("to")} {
			if e := require(ctx, repo, l, id, "tree", false); e != nil {
				fail(e)
				return
			}
		}
		v, e := treeDiff(ctx, repo, q.Get("from"), q.Get("to"), q.Get("path"))
		if e != nil {
			fail(e)
			return
		}
		jsonReply(w, 200, map[string]any{"changes": v})
	case route == "read" && r.Method == "POST":
		var v struct {
			Tree     string
			Paths    []string
			MaxBytes *int64
		}
		if e := decodeStorage(r, &v); e != nil {
			fail(e)
			return
		}
		if e := require(ctx, repo, l, v.Tree, "tree", false); e != nil {
			fail(e)
			return
		}
		if len(v.Paths) > 256 {
			fail(large(v.Paths[256]))
			return
		}
		cap := int64(64 << 20)
		if v.MaxBytes != nil {
			if *v.MaxBytes < 0 {
				fail(bad("invalid_request"))
				return
			}
			cap = min(cap, *v.MaxBytes)
		}
		entries := make([]objects.Entry, len(v.Paths))
		data := make([][]byte, len(v.Paths))
		keys := []string{}
		var size int64
		for i, p := range v.Paths {
			if objects.Path(p) != nil || !safeLine(p) {
				fail(bad("invalid_request"))
				return
			}
			f, e := repo.File(ctx, v.Tree, p)
			if errors.Is(e, os.ErrNotExist) {
				continue
			}
			if e != nil {
				fail(e)
				return
			}
			b, e := repo.BlobInfo(ctx, l, f.SHA1)
			if e != nil {
				fail(e)
				return
			}
			size += b.Size
			if size > cap {
				fail(large(p))
				return
			}
			entries[i] = f
			keys = append(keys, strconv.Itoa(i))
		}
		e := store.Parallel(ctx, 64, keys, func(k string) error {
			i, _ := strconv.Atoi(k)
			b, e := blobBytes(ctx, repo, l, entries[i].SHA1)
			data[i] = b
			return e
		})
		if e != nil {
			fail(e)
			return
		}
		mw := multipart.NewWriter(w)
		w.Header().Set("Content-Type", "multipart/mixed; boundary="+mw.Boundary())
		for i, p := range v.Paths {
			h := textproto.MIMEHeader{"X-Camel-Path": []string{p}}
			if entries[i].SHA1 == "" {
				h.Set("X-Camel-Error", "not_in_tree")
			} else {
				h.Set("X-Camel-Blob", entries[i].SHA1)
				h.Set("X-Camel-Mode", entries[i].Mode)
				h.Set("X-Camel-Size", strconv.Itoa(len(data[i])))
			}
			part, e := mw.CreatePart(h)
			if e != nil {
				return
			}
			_, _ = part.Write(data[i])
		}
		_ = mw.Close()
	case route == "merge" && r.Method == "POST":
		var v mergeRequest
		if e := decodeStorage(r, &v); e != nil {
			fail(e)
			return
		}
		out, e := mergeTrees(ctx, repo, l, v)
		if e != nil {
			fail(e)
			return
		}
		jsonReply(w, 200, out)
	case route == "grep" && r.Method == "GET":
		if e := require(ctx, repo, l, q.Get("tree"), "tree", false); e != nil {
			fail(e)
			return
		}
		out, e := grepTree(ctx, repo, l, q)
		if e != nil {
			fail(e)
			return
		}
		jsonReply(w, 200, out)
	default:
		fail(missing())
	}
}
func blobBytes(ctx context.Context, r *objects.Repository, l, id string) ([]byte, error) {
	if _, e := r.BlobInfo(ctx, l, id); e != nil {
		return nil, e
	}
	// objects is also the read cache for small blobs.
	var b []byte
	e := r.DB.DB.QueryRowContext(ctx, "SELECT bytes FROM objects WHERE id=? AND kind='blob'", id).Scan(&b)
	if e != nil && e != sql.ErrNoRows {
		return nil, e
	}
	if b == nil {
		b, e = r.Store.Get(ctx, "o/"+id)
		if e != nil {
			return nil, e
		}
	}
	if store.GitHash("blob", b) != id {
		return nil, fmt.Errorf("corrupt blob")
	}
	if len(b) <= objects.InlineTree {
		_, e = r.DB.DB.ExecContext(ctx, "INSERT OR IGNORE INTO objects VALUES(?,'blob',?,?,?)", id, b, len(b), time.Now().UnixMilli())
	}
	return b, e
}

type idempotencyKey struct{ lineage, key string }
type idempotencyLock struct {
	mu    sync.Mutex
	users int
}

// The map mutex protects bookkeeping only, never request bodies or store I/O.
// References include waiters so a lock cannot be replaced while still in use.
func (s *Server) lockIdempotency(lineage, key string) func() {
	k := idempotencyKey{lineage, key}
	s.idemLocksMu.Lock()
	if s.idemLocks == nil {
		s.idemLocks = map[idempotencyKey]*idempotencyLock{}
	}
	lock := s.idemLocks[k]
	if lock == nil {
		lock = &idempotencyLock{}
		s.idemLocks[k] = lock
	}
	lock.users++
	s.idemLocksMu.Unlock()
	lock.mu.Lock()
	return func() {
		lock.mu.Unlock()
		s.idemLocksMu.Lock()
		lock.users--
		if lock.users == 0 {
			delete(s.idemLocks, k)
		}
		s.idemLocksMu.Unlock()
	}
}

// Verify the complete download before emitting headers, so store failures or
// corruption cannot turn into a successful partial response.
func blobFile(ctx context.Context, r *objects.Repository, b objects.Blob) (out *os.File, err error) {
	src, e := store.OpenReader(ctx, r.Store, "o/"+b.SHA1)
	if e != nil {
		return nil, e
	}
	defer src.Close()
	file, e := os.CreateTemp(r.TempDir, "camelfsd-read-")
	if e != nil {
		return nil, e
	}
	defer func() {
		if err != nil {
			file.Close()
			os.Remove(file.Name())
		}
	}()
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", b.Size)
	n, e := io.Copy(io.MultiWriter(file, h), io.LimitReader(src, b.Size+1))
	if e != nil {
		return nil, e
	}
	if n != b.Size || fmt.Sprintf("%x", h.Sum(nil)) != b.SHA1 {
		return nil, fmt.Errorf("corrupt blob")
	}
	if _, e = file.Seek(0, io.SeekStart); e != nil {
		return nil, e
	}
	return file, nil
}
