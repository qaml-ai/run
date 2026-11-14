package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net/http"
	"os"
	"path"
	"slices"
	"strconv"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/qaml-ai/run/camelfsd/internal/auth"
	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type vmAPI struct {
	controller *compute.Controller
	host       HostPusher
	images     []string
	pools      []string
	idle       map[string]int64
	heartbeat  time.Duration
	mu         sync.Mutex
	imageBytes map[string]int64
}

func (s *StorageServer) EnableCompute(c *compute.Controller, images, pools []string, idle map[string]int64, heartbeat time.Duration) {
	v := &vmAPI{controller: c, images: images, pools: pools, idle: idle, heartbeat: heartbeat,
		imageBytes: make(map[string]int64)}
	// The production controller already carries the pusher with the tier's rotating TLS credentials.
	v.host, _ = c.Pusher.(HostPusher)
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/vms", v.handle(v.create))
	mux.HandleFunc("GET /v1/vms/{id}", v.handle(v.get))
	mux.HandleFunc("POST /v1/vms/{id}/stop", v.handle(v.stop))
	mux.HandleFunc("POST /v1/vms/{id}/deadline", v.handle(v.deadline))
	mux.HandleFunc("POST /v1/vms/{id}/shells", v.handle(v.shell))
	mux.HandleFunc("POST /v1/vms/{id}/exec", v.handle(v.exec))
	mux.HandleFunc("GET /v1/vms/{id}/exec/{execId}", v.handle(v.execTail))
	mux.HandleFunc("POST /v1/vms/{id}/checkpoint", v.handle(v.checkpoint))
	mux.HandleFunc("GET /v1/usage", v.handle(v.usage))
	s.compute = mux
}

var vmForbidden = &storageError{403, "forbidden", nil}

func (v *vmAPI) handle(fn func(http.ResponseWriter, *http.Request, auth.Claims) error) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		claims, ok := ClaimsFromContext(r.Context())
		if !ok {
			authFail(w, 401, "unauthorized", "bearer token required")
			return
		}
		err := fn(w, r, claims)
		switch {
		case err == nil:
			return
		case errors.Is(err, compute.ErrNotFound):
			err = &storageError{404, "not_found", nil}
		case errors.Is(err, compute.ErrConflict), errors.Is(err, compute.ErrCondition):
			err = &storageError{409, "conflict", nil}
		case errors.Is(err, compute.ErrPhase):
			err = &storageError{409, "not_running", nil}
		case errors.Is(err, compute.ErrCheckpointInProgress):
			err = &storageError{409, "checkpoint_in_progress", nil}
		case errors.Is(err, compute.ErrTooManyExecs):
			err = &storageError{429, "too_many_execs", nil}
		case errors.Is(err, compute.ErrLeaseExpired):
			err = &storageError{409, "lease_expired", nil}
		}
		storageFail(w, err)
	}
}

func vmWriteAllowed(claims auth.Claims, lineage, ref string) bool {
	return runtimeSubject(claims) && claims.Access == "w" && vmRefAllowed(claims, lineage, ref)
}

func vmRefAllowed(claims auth.Claims, lineage, ref string) bool {
	return claims.Lineage == lineage && slices.ContainsFunc(claims.Refs, func(glob string) bool {
		matches, _ := path.Match(glob, ref)
		return matches
	})
}

type vmCreate struct {
	ID      string `json:"id"`
	Lineage string `json:"lineage"`
	Ref     string `json:"ref"`
	Version string `json:"version"`
	Image   string `json:"image"`
	Shape   struct {
		VCPUs     int `json:"vcpus"`
		MemoryMiB int `json:"memoryMiB"`
		DiskGiB   int `json:"diskGiB"`
	} `json:"shape"`
	Pool      string          `json:"pool"`
	IdleStopS json.RawMessage `json:"idleStopS"`
	Network   struct {
		Internet bool `json:"internet"`
	} `json:"network"`
	Usage struct {
		Payer string `json:"payer"`
	} `json:"usage"`
	Deadline int64 `json:"deadline"`
}

func (v *vmAPI) create(w http.ResponseWriter, r *http.Request, claims auth.Claims) error {
	if !runtimeSubject(claims) || claims.Access != "w" {
		return vmForbidden
	}
	var q vmCreate
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := decodeStorage(r, &q); err != nil {
		return err
	}
	if !vmWriteAllowed(claims, q.Lineage, q.Ref) {
		return vmForbidden
	}
	bytes, err := v.guestImage(r, q.Image)
	if err != nil {
		return err
	}
	const gib = 1 << 30
	if q.Shape.DiskGiB > math.MaxInt/1024 {
		return invalid("shape.diskGiB: too large to represent in MiB")
	}
	if q.Shape.DiskGiB <= 0 || int64(q.Shape.DiskGiB) < 1+(bytes-1)/gib {
		tenths := (bytes/gib)*10 + ((bytes%gib)*10+gib-1)/gib
		return invalid("shape.diskGiB (%d.0 GiB) is smaller than image %s (%d.%d GiB)", q.Shape.DiskGiB, q.Image, tenths/10, tenths%10)
	}
	now := v.controller.Time()
	if q.Deadline <= 0 || q.Deadline > now.Add(24*time.Hour).UnixMilli() {
		return invalid("deadline: must be in the next 24 hours")
	}
	idle := v.idle[q.Pool]
	if idle == 0 {
		idle = compute.DefaultIdleStopS
	}
	if q.IdleStopS != nil {
		idle = 0
		if err := json.Unmarshal(q.IdleStopS, &idle); err != nil {
			return invalid("idleStopS: must be an integer between 1 and 3600")
		}
	}
	switch {
	case !compute.ValidIdleStop(idle):
		return invalid("idleStopS: must be between 1 and 3600")
	case !hostwire.MountID.MatchString(q.ID) || q.ID == "." || q.ID == "..":
		return invalid("id: invalid mount id")
	case !store.Lineage(q.Lineage):
		return invalid("lineage: invalid lineage")
	case !refstore.ValidName(q.Ref):
		return invalid("ref: invalid ref")
	case q.Version != "" && !root.Hex(q.Version, 40):
		return invalid("version: expected a 40-character Git id")
	case !slices.Contains(v.pools, q.Pool):
		return invalid("pool: unknown pool")
	case q.Usage.Payer == "" || utf8.RuneCountInString(q.Usage.Payer) > 256:
		return invalid("usage.payer: must contain 1 to 256 characters")
	case q.Shape.VCPUs <= 0:
		return invalid("shape.vcpus: must be positive")
	case q.Shape.MemoryMiB <= 0:
		return invalid("shape.memoryMiB: must be positive")
	}
	vm, err := v.controller.Create(r.Context(), compute.CreateRequest{
		ID: q.ID, Lineage: q.Lineage, Ref: q.Ref, Version: q.Version,
		Image: q.Image, Pool: q.Pool, Payer: q.Usage.Payer, Internet: q.Network.Internet,
		Shape:   compute.Shape{VCPUs: q.Shape.VCPUs, MemoryMiB: q.Shape.MemoryMiB, DiskGiB: q.Shape.DiskGiB},
		Session: &compute.Session{IdleStopS: idle}, Deadline: time.UnixMilli(q.Deadline),
	})
	if errors.Is(err, compute.ErrInvalid) {
		return invalid("deadline: must be in the next 24 hours")
	}
	if err == nil {
		vmAccepted(w, vm)
	}
	return err
}

func (v *vmAPI) guestImage(r *http.Request, sha string) (int64, error) {
	if !slices.Contains(v.images, sha) {
		return 0, invalid("image %s is not allowed", sha)
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if size, ok := v.imageBytes[sha]; ok {
		return size, nil
	}
	body, err := v.controller.Objects.Get(r.Context(), "guest/"+sha+".json")
	if errors.Is(err, os.ErrNotExist) {
		return 0, invalid("unknown image %s", sha)
	}
	if err != nil {
		return 0, err
	}
	var image struct {
		SHA256 string `json:"sha256"`
		Bytes  int64  `json:"bytes"`
	}
	if err := json.Unmarshal(body, &image); err != nil {
		return 0, fmt.Errorf("guest image %s manifest: %w", sha, err)
	}
	if image.SHA256 != sha || image.Bytes <= 0 {
		return 0, fmt.Errorf("guest image %s manifest contains an invalid sha256 or byte count", sha)
	}
	v.imageBytes[sha] = image.Bytes
	return image.Bytes, nil
}

func vmAccepted(w http.ResponseWriter, vm compute.VM) {
	jsonReply(w, 202, map[string]any{"id": vm.ID, "phase": vm.Phase})
}

func (v *vmAPI) read(r *http.Request, claims auth.Claims, write bool) (compute.VM, error) {
	if write && (!runtimeSubject(claims) || claims.Access != "w") {
		return compute.VM{}, vmForbidden
	}
	vm, err := v.controller.Get(r.Context(), r.PathValue("id"))
	if err != nil {
		return vm, err
	}
	if vm.Lineage != claims.Lineage || write && !vmWriteAllowed(claims, vm.Lineage, vm.Ref) {
		return vm, vmForbidden
	}
	return vm, nil
}

func (v *vmAPI) get(w http.ResponseWriter, r *http.Request, claims auth.Claims) error {
	vm, err := v.read(r, claims, false)
	if err != nil {
		return err
	}
	jsonReply(w, 200, vmStatus(vm))
	return nil
}

func vmStatus(vm compute.VM) map[string]any {
	body := map[string]any{
		"id": vm.ID, "phase": vm.Phase, "host": vm.Host, "ref": vm.Ref, "version": vm.Version,
		"lease": map[string]int64{"epoch": vm.RefLeaseEpoch, "deadline": vm.RefLeaseDeadline},
	}
	for key, at := range map[string]*int64{
		"startedAt": vm.StartedAt, "endedAt": vm.EndedAt,
	} {
		if at != nil {
			body[key] = *at
		}
	}
	if vm.Code != "" {
		body["code"] = vm.Code
	}
	if vm.LastCheckpoint != nil {
		body["lastCheckpoint"] = vm.LastCheckpoint
	}
	return body
}

func (v *vmAPI) stop(w http.ResponseWriter, r *http.Request, claims auth.Claims) error {
	vm, err := v.read(r, claims, true)
	if err != nil {
		return err
	}
	var q struct {
		Checkpoint *bool `json:"checkpoint"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := decodeStorage(r, &q); err != nil {
		return err
	}
	if q.Checkpoint == nil {
		return invalid("checkpoint: required")
	}
	vm, err = v.controller.RequestStop(r.Context(), vm.ID, *q.Checkpoint)
	if err == nil {
		vmAccepted(w, vm)
	}
	return err
}

func (v *vmAPI) deadline(w http.ResponseWriter, r *http.Request, claims auth.Claims) error {
	vm, err := v.read(r, claims, true)
	if err != nil {
		return err
	}
	var q struct {
		Deadline int64 `json:"deadline"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := decodeStorage(r, &q); err != nil {
		return err
	}
	if q.Deadline <= 0 {
		return invalid("deadline: expected Unix milliseconds")
	}
	vm, err = v.controller.ExtendDeadline(r.Context(), vm.ID, time.UnixMilli(q.Deadline))
	if err != nil {
		return err
	}
	if vm.Phase == compute.Ended {
		return &storageError{409, "ended", nil}
	}
	jsonReply(w, 200, map[string]int64{"deadline": vm.LeaseDeadline})
	return nil
}

// Only the runtime's leased usage poller has this subject. Its verified
// lineage and ref claims do not scope this cross-lineage ledger.
func (v *vmAPI) usage(w http.ResponseWriter, r *http.Request, claims auth.Claims) error {
	if claims.Subject != "runtime:usage" {
		return vmForbidden
	}
	query := r.URL.Query()
	limit := 500
	if query.Has("limit") {
		var err error
		limit, err = strconv.Atoi(query.Get("limit"))
		if err != nil || limit < 1 || limit > 1000 {
			return invalid("limit: must be between 1 and 1000")
		}
	}
	watermark := v.controller.Time().Add(-2 * v.heartbeat)
	events, cursor, err := v.controller.ListUsage(r.Context(), query.Get("after"), limit, watermark)
	if errors.Is(err, compute.ErrInvalid) {
		return invalid("after: invalid cursor")
	}
	if err != nil {
		return err
	}
	// Encode the envelope separately so the stored event JSON bytes pass through intact.
	tail, err := json.Marshal(struct {
		Cursor    string `json:"cursor"`
		Watermark int64  `json:"watermark"`
	}{cursor, watermark.UnixMilli()})
	if err != nil {
		return err
	}
	var out bytes.Buffer
	out.WriteString(`{"events":[`)
	for i, event := range events {
		if i > 0 {
			out.WriteByte(',')
		}
		out.Write(event)
	}
	out.WriteString("],")
	out.Write(tail[1:])
	w.Header().Set("Content-Type", "application/json")
	_, _ = w.Write(out.Bytes())
	return nil
}
