package api

import (
	"log"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(status int) {
	if w.status != 0 {
		return
	}
	if status >= 200 {
		w.status = status
	}
	w.ResponseWriter.WriteHeader(status)
}
func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.WriteHeader(http.StatusOK)
	}
	return w.ResponseWriter.Write(b)
}
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// Only route templates and a validated, escaped lineage enter the access log.
// Unknown paths, object ids, queries and request bodies are never logged.
func storageLogRoute(path string) (route, lineage string) {
	route, lineage = "/v1/unknown", "-"
	if !strings.HasPrefix(path, "/v1/lineages/") {
		return
	}
	parts := strings.Split(strings.TrimPrefix(path, "/v1/lineages/"), "/")
	if !store.Lineage(parts[0]) {
		return
	}
	lineage = url.PathEscape(parts[0])
	if len(parts) == 2 {
		switch parts[1] {
		case "blobs", "commits", "read", "diff", "merge", "grep":
			route = "/v1/lineages/:lineage/" + parts[1]
		}
	} else if len(parts) == 3 {
		switch parts[1] {
		case "blobs":
			route = "/v1/lineages/:lineage/blobs/:blob"
		case "trees":
			route = "/v1/lineages/:lineage/trees/:tree"
		case "commits":
			route = "/v1/lineages/:lineage/commits/:commit"
		}
	}
	return
}

func (s *StorageServer) loggedStorage(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	route, lineage := storageLogRoute(r.URL.Path)
	rw := &statusWriter{ResponseWriter: w}
	defer func() {
		status := rw.status
		if status == 0 {
			status = http.StatusOK
		}
		log.Printf("op=%s:%s lineage=%s status=%d ms=%.3f", r.Method, route, lineage, status, float64(time.Since(start).Microseconds())/1000)
	}()
	s.storage(rw, r)
}
