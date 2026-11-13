package api

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/image"

	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type Server struct {
	APIToken       string
	storageOnce    sync.Once
	storageServer  *StorageServer
	Manager        *image.Manager
	Version, Store string
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path == "/v1" || strings.HasPrefix(r.URL.Path, "/v1/") {
		s.storageOnce.Do(func() {
			s.storageServer = &StorageServer{
				repo: s.repository,
				authorize: func(w http.ResponseWriter, r *http.Request) *http.Request {
					if !s.authorize(w, r) {
						return nil
					}
					return r
				},
			}
		})
		s.storageServer.loggedStorage(w, r)
		return
	}
	t := time.Now()
	id := ""
	defer func() {
		log.Printf("op=%s:%s jobId=%s ms=%.3f", r.Method, r.URL.Path, id, float64(time.Since(t).Microseconds())/1000)
	}()
	w.Header().Set("Content-Type", "application/json")
	reply := func(status int, v any) { w.WriteHeader(status); _ = json.NewEncoder(w).Encode(v) }
	fail := func(e error) {
		status, code := errorStatus(e)
		reply(status, map[string]any{"error": code, "detail": e.Error()})
	}
	decode := func(v any) error {
		raw, e := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if e != nil {
			return e
		}
		if !utf8.Valid(raw) {
			return apierr.Invalid("invalid UTF-8 JSON")
		}
		d := json.NewDecoder(bytes.NewReader(raw))
		d.DisallowUnknownFields()
		if e := d.Decode(v); e != nil {
			var typed *apierr.Error
			if errors.As(e, &typed) {
				return e
			}
			return apierr.Invalid("invalid JSON: %w", e)
		}
		var extra any
		if e := d.Decode(&extra); e != io.EOF {
			return apierr.Invalid("extra JSON")
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
		v, e := m.Commit(r.Context(), strings.TrimPrefix(r.URL.Path, "/v0/commits/"), r.URL.Query().Get("lineage"))
		if e != nil {
			fail(e)
			return
		}
		reply(200, v)
	case r.Method == "GET" && r.URL.Path == "/v0/stats":
		reply(200, map[string]any{"prehydrateBytes": m.PrehydrateBytes.Load(), "reflinkedChunks": m.Cache.ReflinkedChunks.Load()})
	case r.Method == "GET" && r.URL.Path == "/v0/health":
		// TEMPORARY: removed with jobhost phase 2
		reply(200, map[string]any{"api": "127.0.0.1:8790", "dmPrefix": image.DMPrefix(m.Data), "ok": true, "version": s.Version, "data": m.Data, "store": s.Store, "hostId": m.HostID, "legacyMounts": image.LegacyMounts()})
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
			fail(apierr.Invalid("invalid job id"))
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
			v.WallMs = float64(time.Since(t).Microseconds()) / 1000
			v.CheckpointMs = v.WallMs
			v.RefreshTimings()
			reply(200, v)
		} else if len(parts) == 2 && parts[1] == "heartbeat" && r.Method == "POST" {
			// TEMPORARY: removed with jobhost phase 2
			reply(200, map[string]bool{"ok": true, "deprecated": true})
		} else if len(parts) == 1 && r.Method == "GET" {
			v, e := m.Status(r.Context(), id)
			if e != nil {
				fail(e)
				return
			}
			reply(200, map[string]any{"applied": v.Applied, "applyMs": v.ApplyMs, "state": v.State, "image": v.Image, "root": v.Root, "hydratedBytes": v.HydratedBytes, "hydrationMBps": v.HydrationMBps, "totalBytes": v.TotalBytes, "swapMs": v.SwapMs, "hydrating": v.Hydrating, "hydrationError": v.HydrationError, "fence": v.Fence})
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

func errorStatus(e error) (int, string) {
	status := 500
	code := "internal"
	var typed *apierr.Error
	if errors.As(e, &typed) {
		status = typed.Status
		code = typed.Code
	}

	if errors.Is(e, image.ErrNoRoot) {
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
	return status, code
}
