package api

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
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
		reply(status, map[string]any{"error": code, "detail": e.Error()})
	}
	decode := func(v any) error {
		d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20))
		d.DisallowUnknownFields()
		if e := d.Decode(v); e != nil {
			return e
		}
		var extra any
		if e := d.Decode(&extra); e != io.EOF {
			return fmt.Errorf("extra JSON")
		}
		return nil
	}
	m := s.Manager
	switch {
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
		reply(200, map[string]any{"image": v.Image, "warm": v.Warm, "root": v.Root, "tree": v.Tree, "mountMs": v.MountMs, "hydrating": v.Hydrating})
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
	case r.Method == "POST" && r.URL.Path == "/v0/trees":
		reply(501, map[string]string{"error": "unit 2"})
	case r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/v0/blobs/"):
		if !root.Hex(strings.TrimPrefix(r.URL.Path, "/v0/blobs/"), 64) {
			fail(fmt.Errorf("invalid blob id"))
			return
		}
		reply(501, map[string]string{"error": "unit 2"})
	case strings.HasPrefix(r.URL.Path, "/v0/mounts/"):
		parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/v0/mounts/"), "/")
		id = parts[0]
		if !image.JobID.MatchString(id) || id == "." || id == ".." {
			fail(fmt.Errorf("invalid job id"))
			return
		}
		if len(parts) == 2 && parts[1] == "checkpoint" && r.Method == "POST" {
			var q struct{}
			if e := decode(&q); e != nil {
				fail(e)
				return
			}
			v, e := m.Checkpoint(r.Context(), id)
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
			reply(200, map[string]any{"state": v.State, "image": v.Image, "root": v.Root, "hydratedRegions": v.HydratedRegions, "totalRegions": v.TotalRegions, "leaseEpoch": v.LeaseEpoch})
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
