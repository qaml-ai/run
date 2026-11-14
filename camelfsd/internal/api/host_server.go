package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"slices"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type HostServer struct {
	controller *compute.Controller
	pools      []string
	grace      time.Duration
	routes     *http.ServeMux
	headResult func(context.Context, string) (store.Info, error)
	findHost   func(context.Context, []string, string) (compute.Host, error)
}

func NewHostServer(c *compute.Controller, pools []string, grace time.Duration) *HostServer {
	s := &HostServer{controller: c, pools: slices.Clone(pools), grace: grace, routes: http.NewServeMux(),
		headResult: c.Objects.Head, findHost: c.FindHost}
	s.routes.HandleFunc("POST /v1/hosts/{host}/register", s.authenticated(s.register))
	s.routes.HandleFunc("POST /v1/hosts/{host}/heartbeat", s.authenticated(s.heartbeat))
	s.routes.HandleFunc("POST /v1/hosts/{host}/vms/{id}/started", s.authenticated(s.started))
	s.routes.HandleFunc("POST /v1/hosts/{host}/vms/{id}/ended", s.authenticated(s.ended))
	return s
}

func (s *HostServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	s.routes.ServeHTTP(w, r)
}

type hostError struct {
	status int
	code   string
}

func (e hostError) Error() string { return e.code }

func (s *HostServer) authenticated(handler func(http.ResponseWriter, *http.Request, string) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := hostIdentity(r)
		if err == nil {
			err = handler(w, r, id)
		}
		var reply hostError
		switch {
		case err == nil:
			return
		case errors.As(err, &reply):
		case errors.Is(err, errHostForbidden):
			reply = hostError{403, "forbidden"}
		case errors.Is(err, compute.ErrHost), errors.Is(err, compute.ErrNotFound):
			reply = hostError{409, "stale_epoch"}
		case errors.Is(err, compute.ErrCondition), errors.Is(err, compute.ErrPhase):
			reply = hostError{409, "conflict"}
		case errors.Is(err, compute.ErrInvalid):
			reply = hostError{400, "invalid_request"}
		default:
			slog.Warn("host_request_failed", "host", id, "error", err)
			reply = hostError{500, "internal"}
		}
		jsonReply(w, reply.status, map[string]string{"error": reply.code})
	}
}

func readHostRequest(w http.ResponseWriter, r *http.Request, body any) error {
	return readHostBody(w, r, body, 64<<20)
}

func readHostBody(w http.ResponseWriter, r *http.Request, body any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(body); err != nil {
		return compute.ErrInvalid
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return compute.ErrInvalid
	}
	return nil
}

func (s *HostServer) register(w http.ResponseWriter, r *http.Request, id string) error {
	var q hostwire.Register
	if err := readHostRequest(w, r, &q); err != nil {
		return err
	}
	if !slices.Contains(s.pools, q.Pool) || !validHostAddr(q.Addr) || q.Shape.DiskMiB < 0 || q.Shape.VCPUs < 0 {
		return compute.ErrInvalid
	}
	for _, image := range q.Images {
		if !root.Hex(image, 64) {
			return compute.ErrInvalid
		}
	}
	current, err := s.findHost(r.Context(), s.pools, id)
	if err == nil && current.Pool != q.Pool {
		return errHostForbidden
	}
	if err != nil && !errors.Is(err, compute.ErrHost) {
		return err
	}
	epoch, err := s.controller.Register(r.Context(), compute.HostInfo{Host: id, BootID: q.BootID, Pool: q.Pool, Addr: q.Addr,
		Shape: compute.Shape{VCPUs: q.Shape.VCPUs, MemoryMiB: q.Shape.MemoryMiB, DiskMiB: q.Shape.DiskMiB},
		Slots: q.Slots, Features: uniqueStrings(q.Features), Images: uniqueStrings(q.Images)})
	if err == nil {
		jsonReply(w, http.StatusOK, hostwire.Registered{BootEpoch: epoch})
	}
	return err
}

func uniqueStrings(values []string) []string {
	values = slices.Clone(values)
	slices.Sort(values)
	return slices.Compact(values)
}

func (s *HostServer) heartbeat(w http.ResponseWriter, r *http.Request, id string) error {
	var q hostwire.Heartbeat
	if err := readHostRequest(w, r, &q); err != nil {
		return err
	}
	ctx := r.Context()
	h, err := s.findHost(ctx, s.pools, id)
	if err != nil {
		return err
	}
	listed := make([]compute.Listed, len(q.Running))
	for i, vm := range q.Running {
		if vm.ID == "" {
			return compute.ErrInvalid
		}
		listed[i] = compute.Listed{ID: vm.ID, Finished: vm.Finished}
		if vm.StartedAt != nil {
			at := time.UnixMilli(*vm.StartedAt)
			listed[i].StartedAt = &at
		}
	}
	reply, err := s.controller.Reconcile(ctx, h.Pool, id, q.BootEpoch, q.Free, time.UnixMilli(q.At), listed, s.grace)
	if err != nil {
		return err
	}
	out := hostwire.HeartbeatReply{BootEpoch: q.BootEpoch, Stop: append([]string{}, reply.Stop...), Boot: make([]hostwire.BootSpec, 0, len(reply.Boot))}
	for _, vm := range reply.Boot {
		spec, err := vm.BootSpec()
		if err != nil {
			return err
		}
		out.Boot = append(out.Boot, spec)
	}
	jsonReply(w, http.StatusOK, out)
	return nil
}

func (s *HostServer) currentHost(ctx context.Context, id string, epoch int64) (compute.Host, error) {
	h, err := s.findHost(ctx, s.pools, id)
	if err == nil && (h.BootEpoch != epoch || h.Restarting || h.Lost) {
		err = compute.ErrHost
	}
	return h, err
}

// checkHolder binds the body of a host CAS to the authenticated host and its current boot.
// C4 must call it before performing a host CAS.
func (s *HostServer) checkHolder(ctx context.Context, hostID string, holder hostwire.Holder) error {
	if _, err := hostwire.ParseHolder(holder.String()); err != nil || holder.Host != hostID {
		return errHostForbidden
	}
	_, err := s.currentHost(ctx, hostID, holder.Boot)
	if errors.Is(err, compute.ErrHost) {
		return errHostForbidden
	}
	return err
}

func (s *HostServer) started(w http.ResponseWriter, r *http.Request, id string) error {
	var q hostwire.Started
	if err := readHostRequest(w, r, &q); err != nil {
		return err
	}
	ctx := r.Context()
	h, err := s.currentHost(ctx, id, q.BootEpoch)
	if err != nil {
		return err
	}
	if _, err := s.controller.StartedFromHost(ctx, r.PathValue("id"), h, time.UnixMilli(q.At)); err != nil {
		return err
	}
	w.WriteHeader(http.StatusNoContent)
	return nil
}

func (s *HostServer) ended(w http.ResponseWriter, r *http.Request, hostID string) error {
	var q hostwire.Ended
	if err := readHostRequest(w, r, &q); err != nil {
		return err
	}
	ctx, id := r.Context(), r.PathValue("id")
	h, err := s.currentHost(ctx, hostID, q.BootEpoch)
	if err != nil {
		return err
	}
	v, err := s.controller.Get(ctx, id)
	if err != nil {
		return err
	}
	if v.Host != hostID || v.Pool != h.Pool || v.HostEpoch != q.BootEpoch {
		return compute.ErrHost
	}
	if v.Phase == compute.Ended {
		w.WriteHeader(http.StatusNoContent)
		return nil
	}
	switch compute.EndCode(q.Code) {
	case compute.Exit, compute.Stopped, compute.Timeout, compute.StartFailed:
	default:
		return compute.ErrInvalid
	}
	if v.BootingAt == nil {
		return compute.ErrPhase
	}
	if err := s.checkResult(ctx, v, q); err != nil {
		return err
	}
	_, err = s.controller.EndFromHost(ctx, id, h, compute.EndRequest{At: time.UnixMilli(q.At), Code: compute.EndCode(q.Code),
		Exit: q.Exit, TimedOut: q.TimedOut, ResultRef: q.ResultKey, ResultSha256: q.ResultSha256, ResultBytes: q.ResultBytes,
		EndVersion: q.Version, CheckpointError: q.CheckpointError})
	if err == nil {
		w.WriteHeader(http.StatusNoContent)
	}
	return err
}

func (s *HostServer) checkResult(ctx context.Context, v compute.VM, q hostwire.Ended) error {
	key, ok := store.ResultKey(v.Lineage, v.ID)
	if !ok || q.ResultKey != key || q.ResultBytes < 0 || !root.Hex(q.ResultSha256, 64) {
		return compute.ErrInvalid
	}
	info, err := s.headResult(ctx, key)
	if errors.Is(err, os.ErrNotExist) {
		return hostError{409, "result not found"}
	}
	if err == nil && info.Size != q.ResultBytes {
		return hostError{409, "result size mismatch"}
	}
	return err
}

// CommitTreeResolver resolves an explicitly pinned version within its lineage.
func CommitTreeResolver(repo *objects.Repository) func(context.Context, string, string) (string, error) {
	return func(ctx context.Context, lineage, version string) (string, error) {
		if !root.Hex(version, 40) {
			return "", compute.ErrInvalid
		}
		commit, err := readCommit(ctx, repo.ForLineage(lineage), version)
		if err != nil {
			return "", err
		}
		tree, _ := commit["tree"].(string)
		if !root.Hex(tree, 40) {
			return "", compute.ErrInvalid
		}
		return tree, nil
	}
}
