package api

import (
	"context"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/auth"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
)

type StorageServer struct {
	compute     http.Handler
	repo        func() *objects.Repository
	version     string
	authorize   func(http.ResponseWriter, *http.Request) *http.Request
	idemLocksMu sync.Mutex
	idemLocks   map[idempotencyKey]*idempotencyLock
}

func NewStorageServer(repo *objects.Repository, version string, keys *auth.Keys) *StorageServer {
	return &StorageServer{
		repo:    func() *objects.Repository { return repo },
		version: version,
		authorize: func(w http.ResponseWriter, r *http.Request) *http.Request {
			return authorizeToken(w, r, keys)
		},
	}
}

func (s *StorageServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v0/health":
		jsonReply(w, http.StatusOK, map[string]string{"version": s.version})
	case r.Method == http.MethodGet && r.URL.Path == "/v0/stats":
		r = s.authorize(w, r)
		if r == nil {
			return
		}
		stats := s.repo().DB.DB.Stats()
		jsonReply(w, http.StatusOK, map[string]int{"cacheConnections": stats.OpenConnections, "cacheInUse": stats.InUse})
	case s.compute != nil && (r.URL.Path == "/v1/usage" || r.URL.Path == "/v1/vms" || strings.HasPrefix(r.URL.Path, "/v1/vms/")):
		if r = s.authorize(w, r); r != nil {
			s.compute.ServeHTTP(w, r)
		}
	case strings.HasPrefix(r.URL.Path, "/v1/lineages/"):
		s.loggedStorage(w, r)
	default:
		http.NotFound(w, r)
	}
}

type claimsKey struct{}

func ClaimsFromContext(ctx context.Context) (auth.Claims, bool) {
	claims, ok := ctx.Value(claimsKey{}).(auth.Claims)
	return claims, ok
}

func authFail(w http.ResponseWriter, status int, code, message string) {
	jsonReply(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func authorizeToken(w http.ResponseWriter, r *http.Request, keys *auth.Keys) *http.Request {
	token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || token == "" || len(r.Header.Values("Authorization")) != 1 {
		authFail(w, http.StatusUnauthorized, "unauthorized", "bearer token required")
		return nil
	}
	claims, err := keys.Verify(token, time.Now())
	if err != nil {
		authFail(w, http.StatusUnauthorized, "unauthorized", err.Error())
		return nil
	}
	log.Printf("op=token sub=%q lin=%q acc=%q kid=%q", claims.Subject, claims.Lineage, claims.Access, claims.KeyID)
	return r.WithContext(context.WithValue(r.Context(), claimsKey{}, claims))
}
