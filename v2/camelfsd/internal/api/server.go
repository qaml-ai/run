package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/auth"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/vm"
)

type Server struct {
	auth *auth.Verifier
	repo *repo.Engine
	vm   *vm.Manager
	mux  *http.ServeMux
}

func NewServer(verifier *auth.Verifier, repoEngine *repo.Engine, vmManager *vm.Manager) *Server {
	s := &Server{
		auth: verifier,
		repo: repoEngine,
		vm:   vmManager,
		mux:  http.NewServeMux(),
	}
	s.registerRoutes()
	return s
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.mux.ServeHTTP(w, r)
}

func (s *Server) registerRoutes() {
	s.mux.HandleFunc("GET /healthz", s.handleHealthz)

	// Repository / Lineage endpoints
	s.mux.HandleFunc("POST /v1/lineages", s.handleCreateLineage)
	s.mux.HandleFunc("DELETE /v1/lineages/{lineage}", s.handleDeleteLineage)
	s.mux.HandleFunc("POST /v1/lineages/{lineage}/fork", s.handleForkLineage)
	s.mux.HandleFunc("GET /v1/lineages/{lineage}/refs", s.handleListRefs)
	s.mux.HandleFunc("POST /v1/lineages/{lineage}/refs", s.handleSetRef)
	s.mux.HandleFunc("POST /v1/lineages/{lineage}/lease", s.handleLeaseRef)
	s.mux.HandleFunc("POST /v1/lineages/{lineage}/write", s.handleWrite)
	s.mux.HandleFunc("GET /v1/lineages/{lineage}/read", s.handleRead)
	s.mux.HandleFunc("GET /v1/lineages/{lineage}/ls", s.handleLs)
	s.mux.HandleFunc("POST /v1/lineages/{lineage}/grep", s.handleGrep)
	s.mux.HandleFunc("GET /v1/lineages/{lineage}/history", s.handleHistory)
	s.mux.HandleFunc("POST /v1/lineages/{lineage}/restore", s.handleRestore)

	// Session VM endpoints
	s.mux.HandleFunc("POST /v1/vms", s.handleBootVM)
	s.mux.HandleFunc("GET /v1/vms/{vmId}", s.handleGetVM)
	s.mux.HandleFunc("POST /v1/vms/{vmId}/exec", s.handleExecVM)
	s.mux.HandleFunc("POST /v1/vms/{vmId}/lease", s.handleRenewVMLease)
	s.mux.HandleFunc("POST /v1/vms/{vmId}/stop", s.handleStopVM)

	// Outbound Compute Host Multiplexing endpoints
	s.mux.HandleFunc("POST /v1/hosts/heartbeat", s.handleHostHeartbeat)
	s.mux.HandleFunc("GET /v1/hosts/{hostId}/commands", s.handleHostCommands)
	s.mux.HandleFunc("POST /v1/hosts/{hostId}/results", s.handleHostResults)
}

type errorBody struct {
	Code    apperr.Code `json:"code"`
	Message string      `json:"message"`
}

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	raw, err := json.Marshal(v)
	if err != nil {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":{"code":"internal","message":"failed to encode response"}}`))
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}

func writeError(w http.ResponseWriter, err error) {
	if ae, ok := apperr.As(err); ok {
		writeJSON(w, ae.Status, errorEnvelope{
			Error: errorBody{
				Code:    ae.Code,
				Message: ae.Message,
			},
		})
		return
	}
	writeJSON(w, http.StatusInternalServerError, errorEnvelope{
		Error: errorBody{
			Code:    apperr.CodeInternal,
			Message: err.Error(),
		},
	})
}

func decodeJSONBody(r *http.Request, dst any, allowEmpty bool) error {
	if r.Body == nil {
		if allowEmpty {
			return nil
		}
		return apperr.InvalidRequest("request body is required")
	}
	defer r.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(r.Body, 64<<20)) // 64 MiB max payload
	if err != nil {
		return apperr.InvalidRequest("failed reading request body")
	}
	if len(strings.TrimSpace(string(raw))) == 0 {
		if allowEmpty {
			return nil
		}
		return apperr.InvalidRequest("request body is empty")
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		return apperr.InvalidRequestf("invalid JSON body: %v", err)
	}
	return nil
}

func (s *Server) authenticate(r *http.Request, scope string, lineage string) (*auth.Principal, error) {
	p, err := s.auth.VerifyRequest(r)
	if err != nil {
		return nil, err
	}
	if scope != "" {
		if err := p.Authorize(scope, lineage); err != nil {
			return nil, err
		}
	}
	return p, nil
}

func (s *Server) handleHealthz(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleCreateLineage(w http.ResponseWriter, r *http.Request) {
	var req repo.CreateLineageRequest
	if err := decodeJSONBody(r, &req, true); err != nil {
		writeError(w, err)
		return
	}
	p, err := s.authenticate(r, auth.ScopeRepoWrite, req.Lineage)
	if err != nil {
		writeError(w, err)
		return
	}
	if req.Lineage == "" && p.Lineage != "*" {
		req.Lineage = p.Lineage
	}
	if req.TenantID == "" {
		req.TenantID = p.TenantID
	}
	res, err := s.repo.CreateLineage(r.Context(), req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleDeleteLineage(w http.ResponseWriter, r *http.Request) {
	lineage := r.PathValue("lineage")
	if _, err := s.authenticate(r, auth.ScopeRepoWrite, lineage); err != nil {
		writeError(w, err)
		return
	}
	if err := s.repo.DeleteLineage(r.Context(), lineage); err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"deleted": true})
}

func (s *Server) handleForkLineage(w http.ResponseWriter, r *http.Request) {
	lineage := r.PathValue("lineage")
	var req repo.ForkRequest
	if err := decodeJSONBody(r, &req, true); err != nil {
		writeError(w, err)
		return
	}
	p, err := s.authenticate(r, auth.ScopeRepoRead, lineage)
	if err != nil {
		writeError(w, err)
		return
	}
	if err := p.Authorize(auth.ScopeRepoWrite, req.TargetLineage); err != nil {
		writeError(w, err)
		return
	}
	if req.TargetLineage == "" && p.Lineage != "*" {
		writeError(w, apperr.Forbidden("forking into a new lineage requires wildcard lineage authorization"))
		return
	}
	res, err := s.repo.ForkLineage(r.Context(), lineage, p.TenantID, req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleListRefs(w http.ResponseWriter, r *http.Request) {
	lineage := r.PathValue("lineage")
	if _, err := s.authenticate(r, auth.ScopeRepoRead, lineage); err != nil {
		writeError(w, err)
		return
	}
	prefix := r.URL.Query().Get("prefix")
	refs, err := s.repo.ListRefs(r.Context(), lineage, prefix)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"refs": refs})
}

func (s *Server) handleSetRef(w http.ResponseWriter, r *http.Request) {
	lineage := r.PathValue("lineage")
	if _, err := s.authenticate(r, auth.ScopeRepoWrite, lineage); err != nil {
		writeError(w, err)
		return
	}
	var req repo.SetRefRequest
	if err := decodeJSONBody(r, &req, false); err != nil {
		writeError(w, err)
		return
	}
	res, err := s.repo.SetRef(r.Context(), lineage, req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleLeaseRef(w http.ResponseWriter, r *http.Request) {
	lineage := r.PathValue("lineage")
	if _, err := s.authenticate(r, auth.ScopeRepoWrite, lineage); err != nil {
		writeError(w, err)
		return
	}
	var req repo.LeaseRequest
	if err := decodeJSONBody(r, &req, false); err != nil {
		writeError(w, err)
		return
	}
	res, err := s.repo.LeaseRef(r.Context(), lineage, req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleWrite(w http.ResponseWriter, r *http.Request) {
	lineage := r.PathValue("lineage")
	if _, err := s.authenticate(r, auth.ScopeRepoWrite, lineage); err != nil {
		writeError(w, err)
		return
	}
	var req repo.WriteRequest
	if err := decodeJSONBody(r, &req, false); err != nil {
		writeError(w, err)
		return
	}
	res, err := s.repo.Write(r.Context(), lineage, req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleRead(w http.ResponseWriter, r *http.Request) {
	lineage := r.PathValue("lineage")
	if _, err := s.authenticate(r, auth.ScopeRepoRead, lineage); err != nil {
		writeError(w, err)
		return
	}
	q := r.URL.Query()
	var offset, limit int64
	if rawOff := q.Get("offset"); rawOff != "" {
		v, err := strconv.ParseInt(rawOff, 10, 64)
		if err != nil {
			writeError(w, apperr.InvalidRequest("invalid offset query parameter"))
			return
		}
		offset = v
	}
	if rawLim := q.Get("limit"); rawLim != "" {
		v, err := strconv.ParseInt(rawLim, 10, 64)
		if err != nil {
			writeError(w, apperr.InvalidRequest("invalid limit query parameter"))
			return
		}
		limit = v
	}
	res, err := s.repo.Read(r.Context(), lineage, repo.ReadParams{
		At:     q.Get("at"),
		Path:   q.Get("path"),
		Offset: offset,
		Limit:  limit,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleLs(w http.ResponseWriter, r *http.Request) {
	lineage := r.PathValue("lineage")
	if _, err := s.authenticate(r, auth.ScopeRepoRead, lineage); err != nil {
		writeError(w, err)
		return
	}
	q := r.URL.Query()
	recRaw := strings.ToLower(strings.TrimSpace(q.Get("recursive")))
	glob := q.Get("glob")
	recursive := recRaw == "1" || recRaw == "true" || (recRaw == "" && strings.Contains(glob, "**"))
	res, err := s.repo.ListEntries(r.Context(), lineage, repo.ListParams{
		At:        q.Get("at"),
		Path:      q.Get("path"),
		Recursive: recursive,
		Glob:      glob,
	})
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleGrep(w http.ResponseWriter, r *http.Request) {
	lineage := r.PathValue("lineage")
	if _, err := s.authenticate(r, auth.ScopeRepoRead, lineage); err != nil {
		writeError(w, err)
		return
	}
	var req repo.GrepRequest
	if err := decodeJSONBody(r, &req, false); err != nil {
		writeError(w, err)
		return
	}
	res, err := s.repo.Grep(r.Context(), lineage, req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleHistory(w http.ResponseWriter, r *http.Request) {
	lineage := r.PathValue("lineage")
	if _, err := s.authenticate(r, auth.ScopeRepoRead, lineage); err != nil {
		writeError(w, err)
		return
	}
	q := r.URL.Query()
	ref := q.Get("ref")
	if ref == "" {
		ref = q.Get("at")
	}
	limit := 20
	if rawLim := q.Get("limit"); rawLim != "" {
		v, err := strconv.Atoi(rawLim)
		if err != nil {
			writeError(w, apperr.InvalidRequest("invalid limit query parameter"))
			return
		}
		limit = v
	}
	res, err := s.repo.History(r.Context(), lineage, ref, limit)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleRestore(w http.ResponseWriter, r *http.Request) {
	lineage := r.PathValue("lineage")
	if _, err := s.authenticate(r, auth.ScopeRepoWrite, lineage); err != nil {
		writeError(w, err)
		return
	}
	var req repo.RestoreRequest
	if err := decodeJSONBody(r, &req, false); err != nil {
		writeError(w, err)
		return
	}
	res, err := s.repo.Restore(r.Context(), lineage, req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleBootVM(w http.ResponseWriter, r *http.Request) {
	var req vm.BootVMRequest
	if err := decodeJSONBody(r, &req, false); err != nil {
		writeError(w, err)
		return
	}
	if _, err := s.authenticate(r, auth.ScopeVMExec, req.Lineage); err != nil {
		writeError(w, err)
		return
	}
	res, err := s.vm.BootOrReuse(r.Context(), req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) authorizeExistingVM(r *http.Request, vmID string, allowRepoRead bool) (*vm.GetVMResponse, error) {
	p, err := s.auth.VerifyRequest(r)
	if err != nil {
		return nil, err
	}
	vmInfo, err := s.vm.Get(r.Context(), vmID)
	if err != nil {
		return nil, err
	}
	if err := p.Authorize(auth.ScopeVMExec, vmInfo.Lineage); err != nil {
		if allowRepoRead && p.Authorize(auth.ScopeRepoRead, vmInfo.Lineage) == nil {
			return vmInfo, nil
		}
		return nil, err
	}
	return vmInfo, nil
}

func (s *Server) handleGetVM(w http.ResponseWriter, r *http.Request) {
	vmID := r.PathValue("vmId")
	vmInfo, err := s.authorizeExistingVM(r, vmID, true)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vmInfo)
}

func writeSSEEvent(w io.Writer, flusher http.Flusher, event string, payload any) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return
	}
	_, _ = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw)
	if flusher != nil {
		flusher.Flush()
	}
}

func (s *Server) handleExecVM(w http.ResponseWriter, r *http.Request) {
	vmID := r.PathValue("vmId")
	_, err := s.authorizeExistingVM(r, vmID, false)
	if err != nil {
		writeError(w, err)
		return
	}
	var req vm.ExecRequest
	if err := decodeJSONBody(r, &req, false); err != nil {
		writeError(w, err)
		return
	}
	if strings.TrimSpace(req.Command) == "" {
		writeError(w, apperr.InvalidRequest("command is required"))
		return
	}

	wantsSSE := strings.Contains(strings.ToLower(r.Header.Get("Accept")), "text/event-stream")
	if !wantsSSE {
		res, _, err := s.vm.Exec(r.Context(), vmID, req, nil, nil)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
		return
	}

	flusher, _ := w.(http.Flusher)
	var sseMu sync.Mutex
	headersSent := false
	ensureSSEHeaders := func() {
		if !headersSent {
			headersSent = true
			w.Header().Set("Content-Type", "text/event-stream")
			w.Header().Set("Cache-Control", "no-cache")
			w.Header().Set("Connection", "keep-alive")
			w.WriteHeader(http.StatusOK)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}

	res, fromCache, err := s.vm.Exec(
		r.Context(),
		vmID,
		req,
		func(chunk string) {
			sseMu.Lock()
			defer sseMu.Unlock()
			ensureSSEHeaders()
			writeSSEEvent(w, flusher, "stdout", map[string]string{"chunk": chunk})
		},
		func(chunk string) {
			sseMu.Lock()
			defer sseMu.Unlock()
			ensureSSEHeaders()
			writeSSEEvent(w, flusher, "stderr", map[string]string{"chunk": chunk})
		},
	)
	if err != nil {
		sseMu.Lock()
		alreadyStreaming := headersSent
		sseMu.Unlock()
		if !alreadyStreaming {
			writeError(w, err)
			return
		}
		sseMu.Lock()
		code := apperr.CodeInternal
		msg := err.Error()
		if ae, ok := apperr.As(err); ok {
			code = ae.Code
			msg = ae.Message
		}
		writeSSEEvent(w, flusher, "error", errorEnvelope{Error: errorBody{Code: code, Message: msg}})
		sseMu.Unlock()
		return
	}

	sseMu.Lock()
	defer sseMu.Unlock()
	ensureSSEHeaders()
	if fromCache {
		if res.Stdout != "" {
			writeSSEEvent(w, flusher, "stdout", map[string]string{"chunk": res.Stdout})
		}
		if res.Stderr != "" {
			writeSSEEvent(w, flusher, "stderr", map[string]string{"chunk": res.Stderr})
		}
	}
	writeSSEEvent(w, flusher, "result", res)
}

func (s *Server) handleRenewVMLease(w http.ResponseWriter, r *http.Request) {
	vmID := r.PathValue("vmId")
	if _, err := s.authorizeExistingVM(r, vmID, false); err != nil {
		writeError(w, err)
		return
	}
	var req vm.RenewLeaseRequest
	if err := decodeJSONBody(r, &req, true); err != nil {
		writeError(w, err)
		return
	}
	res, err := s.vm.RenewLease(r.Context(), vmID, req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleStopVM(w http.ResponseWriter, r *http.Request) {
	vmID := r.PathValue("vmId")
	if _, err := s.authorizeExistingVM(r, vmID, false); err != nil {
		writeError(w, err)
		return
	}
	res, err := s.vm.Stop(r.Context(), vmID)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleHostHeartbeat(w http.ResponseWriter, r *http.Request) {
	if err := s.auth.VerifyHostRequest(r); err != nil {
		writeError(w, err)
		return
	}
	var req vm.HostHeartbeatRequest
	if err := decodeJSONBody(r, &req, false); err != nil {
		writeError(w, err)
		return
	}
	res, err := s.vm.HostMux().Heartbeat(r.Context(), req)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleHostCommands(w http.ResponseWriter, r *http.Request) {
	if err := s.auth.VerifyHostRequest(r); err != nil {
		writeError(w, err)
		return
	}
	hostID := r.PathValue("hostId")
	waitMs := 0
	if raw := r.URL.Query().Get("waitMs"); raw != "" {
		if v, err := strconv.Atoi(raw); err == nil && v > 0 {
			if v > 30_000 {
				v = 30_000
			}
			waitMs = v
		}
	}
	res, err := s.vm.HostMux().PollCommands(r.Context(), hostID, time.Duration(waitMs)*time.Millisecond)
	if err != nil {
		writeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleHostResults(w http.ResponseWriter, r *http.Request) {
	if err := s.auth.VerifyHostRequest(r); err != nil {
		writeError(w, err)
		return
	}
	hostID := r.PathValue("hostId")
	var req vm.HostResultRequest
	if err := decodeJSONBody(r, &req, false); err != nil {
		writeError(w, err)
		return
	}
	if errors.Is(r.Context().Err(), nil) || r.Context().Err() == nil {
		res, err := s.vm.HostMux().SubmitResult(r.Context(), hostID, req)
		if err != nil {
			writeError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, res)
		return
	}
}
