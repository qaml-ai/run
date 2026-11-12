package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
	"unicode/utf8"
)

type Server struct {
	Manager        *image.Manager
	Version, Store string
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	t := time.Now()
	id := ""
	defer func() {
		log.Printf("op=%s:%s jobId=%s ms=%.3f", r.Method, r.URL.Path, id, float64(time.Since(t).Microseconds())/1000)
	}()
	w.Header().Set("Content-Type", "application/json")
	reply := func(status int, v any) { w.WriteHeader(status); _ = json.NewEncoder(w).Encode(v) }
	fail := func(e error) {
		status := 500
		code := "internal"
		if strings.Contains(e.Error(), "invalid") || strings.Contains(e.Error(), "not allowed") || strings.Contains(e.Error(), "already mounted") || strings.Contains(e.Error(), "unknown field") || strings.Contains(e.Error(), "JSON") || errors.Is(e, io.EOF) {
			status = 400
			code = "invalid-request"
		}
		if errors.Is(e, refs.ErrFenced) {
			status = 409
			code = "fenced"
		} else if errors.Is(e, image.ErrNoRoot) {
			status = 404
			code = "no-root-for-tree"
		} else if errors.Is(e, os.ErrNotExist) || errors.Is(e, sql.ErrNoRows) {
			status = 404
			code = "not-found"
		}
		if errors.Is(e, image.ErrBadStream) {
			status = 422
			code = "bad-stream"
		}
		if errors.Is(e, image.ErrStreamTimeout) {
			status = 504
			code = "stream-timeout"
		}
		if errors.Is(e, image.ErrHeld) {
			status = 409
			code = "held"
		}
		reply(status, map[string]any{"error": code, "detail": e.Error()})
	}
	decode := func(v any) error {
		raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if e != nil {
			return e
		}
		if !utf8.Valid(raw) {
			return fmt.Errorf("invalid UTF-8 JSON")
		}
		d := json.NewDecoder(bytes.NewReader(raw))
		d.DisallowUnknownFields()
		if e := d.Decode(v); e != nil {
			return fmt.Errorf("invalid JSON: %w", e)
		}
		var extra any
		if e := d.Decode(&extra); e != io.EOF {
			return fmt.Errorf("extra JSON")
		}
		return nil
	}
	if strings.HasPrefix(r.URL.Path, "/v0/trees") || strings.HasPrefix(r.URL.Path, "/v0/blobs/") {
		s.objects(w, r, reply, fail)
		return
	}
	m := s.Manager
	switch {
	case r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/v0/commits/"):
		v, e := m.Commit(r.Context(), strings.TrimPrefix(r.URL.Path, "/v0/commits/"))
		if e != nil {
			fail(e)
			return
		}
		reply(200, v)
	case r.Method == "GET" && r.URL.Path == "/v0/health":
		reply(200, map[string]any{"ok": true, "version": s.Version, "data": m.Data, "store": s.Store, "hostId": m.HostID})
	case r.Method == "POST" && r.URL.Path == "/v0/mounts":
		var q image.Request
		if e := decode(&q); e != nil {
			fail(e)
			return
		}
		id = q.JobID
		v, e := m.Mount(r.Context(), q)
		if e != nil {
			fail(e)
			return
		}
		reply(200, map[string]any{"image": v.Image, "warm": v.Warm, "root": v.Root, "tree": v.Tree, "mountMs": v.MountMs, "hydrating": v.Hydrating, "apply": v.Apply})
	case r.Method == "POST" && r.URL.Path == "/v0/forks":
		var q image.ForkRequest
		if e := decode(&q); e != nil {
			fail(e)
			return
		}
		v, e := m.Fork(r.Context(), q)
		if e != nil {
			fail(e)
			return
		}
		reply(200, v)
	case r.Method == "POST" && r.URL.Path == "/v0/images":
		var q image.ImportRequest
		if e := decode(&q); e != nil {
			fail(e)
			return
		}
		v, e := m.Import(r.Context(), q)
		if e != nil {
			fail(e)
			return
		}
		reply(200, v)
	case strings.HasPrefix(r.URL.Path, "/v0/mounts/"):
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v0/mounts/"), "/")
		id = parts[0]
		if !image.JobID.MatchString(id) || id == "." || id == ".." {
			fail(fmt.Errorf("invalid job id"))
			return
		}
		if len(parts) == 2 && parts[1] == "checkpoint" && r.Method == "POST" {
			var q image.CheckpointRequest
			if e := decode(&q); e != nil {
				fail(e)
				return
			}
			if e := q.Validate(); e != nil {
				fail(e)
				return
			}
			v, e := m.StreamCheckpoint(r.Context(), id, q.TimeoutMs, q)
			if e != nil {
				fail(e)
				return
			}
			reply(200, v)
		} else if len(parts) == 1 && r.Method == "GET" {
			v, e := m.Status(r.Context(), id)
			if e != nil {
				fail(e)
				return
			}
			reply(200, map[string]any{"applied": v.Applied, "applyMs": v.ApplyMs, "state": v.State, "image": v.Image, "root": v.Root, "hydratedRegions": v.HydratedRegions, "totalRegions": v.TotalRegions, "leaseEpoch": v.LeaseEpoch})
		} else if len(parts) == 1 && r.Method == "DELETE" {
			p, e := m.Release(r.Context(), id)
			if e != nil {
				fail(e)
				return
			}
			reply(200, map[string]any{"released": true, "promoted": p})
		} else {
			reply(404, map[string]string{"error": "not-found"})
		}
	default:
		reply(404, map[string]string{"error": "not-found"})
	}
}
