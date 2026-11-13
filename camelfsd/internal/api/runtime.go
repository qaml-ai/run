package api

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/qaml-ai/run/camelfsd/internal/root"
)

// RuntimeHandler limits the TCP listener to runtime storage and import calls.
// Host lifecycle operations remain available only on the Unix socket.
func (s *Server) RuntimeHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if strings.HasPrefix(r.URL.Path, "/v1/") {
			s.ServeHTTP(w, r)
			return
		}
		importRoute := r.Method == "POST" && r.URL.Path == "/v0/trees" ||
			r.Method == "PUT" && strings.HasPrefix(r.URL.Path, "/v0/blobs/") && root.Hex(strings.TrimPrefix(r.URL.Path, "/v0/blobs/"), 64)
		if !importRoute {
			http.NotFound(w, r)
			return
		}
		if s.authorize(w, r) {
			s.ServeHTTP(w, r)
		}
	})
}

func (s *Server) authorize(w http.ResponseWriter, r *http.Request) bool {
	if s.APIToken == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+s.APIToken)) != 1 {
		jsonReply(w, 401, map[string]any{"error": map[string]string{"code": "unauthorized", "message": "bearer required"}})
		return false
	}
	return true
}
