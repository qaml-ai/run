package api

import (
	"context"
	"fmt"
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
func storageLogRoute(method, path string) (route, lineage string) {
	route, lineage = "/v1/unknown", "-"
	if !strings.HasPrefix(path, "/v1/lineages/") {
		return
	}
	parts := strings.Split(strings.TrimPrefix(path, "/v1/lineages/"), "/")
	if !store.Lineage(parts[0]) {
		return
	}
	lineage = url.PathEscape(parts[0])
	if len(parts) == 1 {
		return "/v1/lineages/:lineage", lineage
	}
	if parts[1] == "refs" {
		if len(parts) == 2 {
			return "/v1/lineages/:lineage/refs", lineage
		}
		return "/v1/lineages/:lineage/refs/:name" + refLogAction(method, path), lineage
	}
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

// refLogAction names the action of a single-ref route for the log template, the same way parseRefRequest
// derives it (method + escaped-path suffix), so the ref's name never reaches the log.
func refLogAction(method, path string) string {
	switch {
	case (method == http.MethodPut || method == http.MethodDelete) && strings.Contains(path, "/watchers/"):
		return "/watchers/:watcher"
	case method == http.MethodPost && strings.HasSuffix(path, "/lease/renew"):
		return "/lease/renew"
	case (method == http.MethodPost || method == http.MethodDelete) && strings.HasSuffix(path, "/lease"):
		return "/lease"
	case method == http.MethodPost:
		switch path[strings.LastIndex(path, "/")+1:] {
		case "cas", "write", "merge", "restore":
			return "/" + path[strings.LastIndex(path, "/")+1:]
		}
	}
	return ""
}

func (s *StorageServer) loggedStorage(w http.ResponseWriter, r *http.Request) {
	start := time.Now()
	route, lineage := storageLogRoute(r.Method, r.URL.EscapedPath())
	rw := &statusWriter{ResponseWriter: w}
	var timing *commitTiming
	if r.Method == http.MethodPost && route == "/v1/lineages/:lineage/commits" {
		timing = &commitTiming{}
		r = r.WithContext(context.WithValue(r.Context(), commitTimingKey{}, timing))
	}
	var moves *refTiming
	switch route {
	case "/v1/lineages/:lineage/refs/:name/write", "/v1/lineages/:lineage/refs/:name/merge", "/v1/lineages/:lineage/refs/:name/restore":
		moves = &refTiming{}
		r = r.WithContext(context.WithValue(r.Context(), refTimingKey{}, moves))
	}
	defer func() {
		status := rw.status
		if status == 0 {
			status = http.StatusOK
		}
		phases := ""
		ms := func(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
		if timing != nil {
			phases = fmt.Sprintf(" prechecksMs=%.3f readMs=%.3f readWaves=%d buildMs=%.3f putMs=%.3f putKeys=%d cacheMs=%.3f",
				ms(timing.prechecks), ms(timing.read), timing.readWaves, ms(timing.build), ms(timing.Put), timing.PutKeys, ms(timing.Cache))
		}
		if moves != nil {
			phases = fmt.Sprintf(" objectsMs=%.3f putKeys=%d buildMs=%.3f ddbMs=%.3f ddbRetries=%d",
				ms(moves.objects.Put), moves.objects.PutKeys, ms(moves.build), ms(moves.ddb), moves.retries)
		}
		log.Printf("op=%s:%s lineage=%s status=%d ms=%.3f%s", r.Method, route, lineage, status, ms(time.Since(start)), phases)
	}()
	s.storage(rw, r)
}
