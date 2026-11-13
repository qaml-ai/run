package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"io"
	"net/http"
	"strings"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

func (s *Server) objects(w http.ResponseWriter, r *http.Request, reply func(int, any), fail func(error)) {
	db, ok := s.Manager.Refs.(*refs.DB)
	if !ok {
		fail(fmt.Errorf("objects require SQLite"))
		return
	}
	repo := objects.Repository{DB: db, Store: s.Manager.Store, TempDir: s.Manager.Data}
	handle := func(e error) {
		var missing *objects.Missing
		switch {
		case errors.As(e, &missing):
			reply(409, map[string]any{"error": "missing-blobs", "missing": missing.Hashes})
		case errors.Is(e, objects.ErrIgnored):
			reply(400, map[string]string{"error": "ignored-path"})
		case errors.Is(e, objects.ErrHash):
			reply(400, map[string]string{"error": "hash-mismatch"})
		default:
			fail(e)
		}
	}
	send := func(id, mode string) {
		b, e := repo.Store.Get(r.Context(), "o/"+id)
		if e != nil {
			handle(e)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		if mode != "" {
			w.Header().Set("X-Camelfs-Mode", mode)
		}
		w.WriteHeader(200)
		_, _ = w.Write(b)
	}
	switch {
	case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/v0/blobs/"):
		b, e := repo.Upload(r.Context(), r.URL.Query().Get("lineage"), strings.TrimPrefix(r.URL.Path, "/v0/blobs/"), r.ContentLength, r.Body)
		if e != nil {
			handle(e)
			return
		}
		reply(201, b)
	case r.Method == "POST" && r.URL.Path == "/v0/trees":
		var q objects.Request
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 64<<20))
		d.DisallowUnknownFields()
		if e := d.Decode(&q); e != nil {
			reply(400, map[string]string{"error": "invalid-request"})
			return
		}
		var extra any
		if e := d.Decode(&extra); e != io.EOF {
			reply(400, map[string]string{"error": "invalid-request"})
			return
		}
		v, e := repo.Import(r.Context(), q)
		if e != nil {
			handle(e)
			return
		}
		reply(200, v)
	case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/v0/trees/"):
		id, path, hasPath := strings.Cut(strings.TrimPrefix(r.URL.Path, "/v0/trees/"), "/files/")
		if hasPath {
			entry, e := repo.File(r.Context(), id, path)
			if e != nil {
				handle(e)
				return
			}
			send(entry.SHA1, entry.Mode)
			return
		}
		entries, e := repo.Entries(r.Context(), id)
		if e != nil {
			handle(e)
			return
		}
		reply(200, map[string]any{"tree": id, "entries": entries})
	case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/v0/blobs/"):
		id := strings.TrimPrefix(r.URL.Path, "/v0/blobs/")
		if !root.Hex(id, 40) {
			handle(apierr.Invalid("invalid blob id"))
			return
		}
		send(id, "")
	default:
		reply(404, map[string]string{"error": "not-found"})
	}
}
