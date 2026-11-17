package vm

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/store"
)

type pendingCommand struct {
	cmd      HostCommand
	onStdout func(string)
	onStderr func(string)
	doneCh   chan HostResultRequest
}

type hostQueue struct {
	queue  []HostCommand
	notify chan struct{}
}

// HostMux multiplexes VM commands outbound to compute hosts that poll
// GET /v1/hosts/{hostId}/commands and report results to POST /v1/hosts/{hostId}/results.
type HostMux struct {
	store store.VMStore
	nowFn func() time.Time

	mu       sync.Mutex
	queues   map[string]*hostQueue
	inflight map[string]*pendingCommand
	vmHost   map[string]string
}

func NewHostMux(st store.VMStore, nowFn func() time.Time) *HostMux {
	if nowFn == nil {
		nowFn = time.Now
	}
	return &HostMux{
		store:    st,
		nowFn:    nowFn,
		queues:   make(map[string]*hostQueue),
		inflight: make(map[string]*pendingCommand),
		vmHost:   make(map[string]string),
	}
}

func (m *HostMux) getOrCreateQueueLocked(hostID string) *hostQueue {
	hq, ok := m.queues[hostID]
	if !ok {
		hq = &hostQueue{notify: make(chan struct{}, 1)}
		m.queues[hostID] = hq
	}
	return hq
}

func (m *HostMux) Heartbeat(ctx context.Context, req HostHeartbeatRequest) (*HostHeartbeatResponse, error) {
	hostID := strings.TrimSpace(req.HostID)
	if hostID == "" {
		return nil, apperr.InvalidRequest("hostId is required")
	}
	status := strings.TrimSpace(req.Status)
	if status == "" {
		status = "ready"
	}
	capVMs := req.CapacityVMs
	if capVMs <= 0 {
		capVMs = 16
	}
	nowMs := m.nowFn().UnixMilli()
	rec := &store.HostRecord{
		HostID:          hostID,
		Address:         req.Address,
		CapacityVMs:     capVMs,
		RunningVMs:      req.RunningVMs,
		Status:          status,
		Labels:          req.Labels,
		LastHeartbeatAt: nowMs,
	}
	if err := m.store.UpsertHost(ctx, rec); err != nil {
		return nil, err
	}

	m.mu.Lock()
	m.getOrCreateQueueLocked(hostID)
	m.mu.Unlock()

	return &HostHeartbeatResponse{
		OK:         true,
		HostID:     hostID,
		ServerTime: nowMs,
	}, nil
}

func (m *HostMux) PollCommands(ctx context.Context, hostID string, wait time.Duration) (*HostCommandsResponse, error) {
	hostID = strings.TrimSpace(hostID)
	if hostID == "" {
		return nil, apperr.InvalidRequest("hostId is required")
	}

	m.mu.Lock()
	hq := m.getOrCreateQueueLocked(hostID)
	if len(hq.queue) > 0 {
		cmds := hq.queue
		hq.queue = nil
		m.mu.Unlock()
		return &HostCommandsResponse{Commands: cmds}, nil
	}
	notifyCh := hq.notify
	m.mu.Unlock()

	if wait <= 0 {
		return &HostCommandsResponse{Commands: []HostCommand{}}, nil
	}

	timer := time.NewTimer(wait)
	defer timer.Stop()

	select {
	case <-notifyCh:
		m.mu.Lock()
		cmds := hq.queue
		hq.queue = nil
		m.mu.Unlock()
		if cmds == nil {
			cmds = []HostCommand{}
		}
		return &HostCommandsResponse{Commands: cmds}, nil
	case <-timer.C:
		return &HostCommandsResponse{Commands: []HostCommand{}}, nil
	case <-ctx.Done():
		return &HostCommandsResponse{Commands: []HostCommand{}}, nil
	}
}

func (m *HostMux) SubmitResult(_ context.Context, hostID string, req HostResultRequest) (*HostResultResponse, error) {
	if strings.TrimSpace(req.CommandID) == "" {
		return nil, apperr.InvalidRequest("commandId is required")
	}

	m.mu.Lock()
	pend, ok := m.inflight[req.CommandID]
	if ok && req.Done {
		delete(m.inflight, req.CommandID)
	}
	m.mu.Unlock()

	if !ok {
		return nil, apperr.NotFoundf("command %q not found on host %q", req.CommandID, hostID)
	}

	if req.StdoutChunk != "" && pend.onStdout != nil {
		pend.onStdout(req.StdoutChunk)
	}
	if req.StderrChunk != "" && pend.onStderr != nil {
		pend.onStderr(req.StderrChunk)
	}
	if req.Done {
		select {
		case pend.doneCh <- req:
		default:
		}
	}
	return &HostResultResponse{OK: true}, nil
}

func (m *HostMux) SelectHealthyHost(ctx context.Context) (string, error) {
	hosts, err := m.store.ListHosts(ctx)
	if err != nil {
		return "", err
	}
	cutoff := m.nowFn().Add(-60 * time.Second).UnixMilli()
	bestHost := ""
	bestFree := -1
	for _, h := range hosts {
		if h.Status != "ready" || h.LastHeartbeatAt < cutoff {
			continue
		}
		free := h.CapacityVMs - h.RunningVMs
		if free > bestFree {
			bestFree = free
			bestHost = h.HostID
		}
	}
	if bestHost == "" {
		return "", apperr.Internal("no healthy compute hosts available", nil)
	}
	return bestHost, nil
}

func (m *HostMux) Dispatch(
	ctx context.Context,
	hostID string,
	cmdType string,
	vmID string,
	payload any,
	onStdout func(string),
	onStderr func(string),
) (*HostResultRequest, error) {
	raw, err := json.Marshal(payload)
	if err != nil {
		return nil, apperr.Internal("marshal host command", err)
	}
	cmdID := store.RandomID("cmd")
	cmd := HostCommand{
		CommandID: cmdID,
		Type:      cmdType,
		VMID:      vmID,
		Payload:   raw,
	}
	pend := &pendingCommand{
		cmd:      cmd,
		onStdout: onStdout,
		onStderr: onStderr,
		doneCh:   make(chan HostResultRequest, 1),
	}

	m.mu.Lock()
	hq := m.getOrCreateQueueLocked(hostID)
	hq.queue = append(hq.queue, cmd)
	m.inflight[cmdID] = pend
	select {
	case hq.notify <- struct{}{}:
	default:
	}
	m.mu.Unlock()

	select {
	case res := <-pend.doneCh:
		if !res.OK {
			msg := res.Error
			if msg == "" {
				msg = fmt.Sprintf("host %s failed command %s", hostID, cmdType)
			}
			return nil, apperr.Internal(msg, nil)
		}
		return &res, nil
	case <-ctx.Done():
		m.mu.Lock()
		delete(m.inflight, cmdID)
		m.mu.Unlock()
		return nil, apperr.Timeout(fmt.Sprintf("timed out waiting for compute host %q on %s", hostID, cmdType))
	}
}

func (m *HostMux) BindVMHost(vmID, hostID string) {
	m.mu.Lock()
	m.vmHost[vmID] = hostID
	m.mu.Unlock()
}

func (m *HostMux) HostForVM(vmID string) (string, bool) {
	m.mu.Lock()
	h, ok := m.vmHost[vmID]
	m.mu.Unlock()
	return h, ok
}

// RemoteDriver implements Driver by dispatching VM lifecycle & exec operations through HostMux.
type RemoteDriver struct {
	mux *HostMux
}

func NewRemoteDriver(mux *HostMux) *RemoteDriver {
	return &RemoteDriver{mux: mux}
}

type remoteWireFile struct {
	Mode   int    `json:"mode"`
	Base64 string `json:"base64"`
}

func encodeWireFiles(files map[string]repo.MaterializedFile) map[string]remoteWireFile {
	out := make(map[string]remoteWireFile, len(files))
	for p, mf := range files {
		out[p] = remoteWireFile{
			Mode:   mf.Mode,
			Base64: base64.StdEncoding.EncodeToString(mf.Data),
		}
	}
	return out
}

func decodeWireFiles(in map[string]remoteWireFile) (map[string]repo.MaterializedFile, error) {
	out := make(map[string]repo.MaterializedFile, len(in))
	for p, wf := range in {
		raw, err := base64.StdEncoding.DecodeString(wf.Base64)
		if err != nil {
			return nil, apperr.Internal("decode remote workspace file", err)
		}
		mode := wf.Mode
		if mode == 0 {
			mode = repo.DefaultFileMode
		}
		out[p] = repo.MaterializedFile{Path: p, Mode: mode, Data: raw}
	}
	return out, nil
}

func (d *RemoteDriver) Start(ctx context.Context, spec StartSpec) (string, error) {
	hostID, err := d.mux.SelectHealthyHost(ctx)
	if err != nil {
		return "", err
	}
	_, err = d.mux.Dispatch(ctx, hostID, "vm.start", spec.VMID, map[string]any{
		"vmId":      spec.VMID,
		"vcpus":     spec.VCPUs,
		"memoryMiB": spec.MemoryMiB,
		"env":       spec.Env,
		"files":     encodeWireFiles(spec.Files),
	}, nil, nil)
	if err != nil {
		return "", err
	}
	d.mux.BindVMHost(spec.VMID, hostID)
	return hostID, nil
}

func (d *RemoteDriver) Exec(ctx context.Context, req DriverExecRequest) (*DriverExecResult, error) {
	hostID, ok := d.mux.HostForVM(req.VMID)
	if !ok {
		return nil, apperr.NotFoundf("remote host binding for VM %q not found", req.VMID)
	}
	res, err := d.mux.Dispatch(ctx, hostID, "vm.exec", req.VMID, map[string]any{
		"execId":   req.ExecID,
		"command":  req.Command,
		"cwd":      req.Cwd,
		"env":      req.Env,
		"timeoutS": req.TimeoutS,
	}, req.OnStdout, req.OnStderr)
	if err != nil {
		return nil, err
	}
	var out DriverExecResult
	if len(res.Result) > 0 {
		if err := json.Unmarshal(res.Result, &out); err != nil {
			return nil, apperr.Internal("unmarshal remote exec result", err)
		}
	}
	if out.Cwd == "" {
		out.Cwd = "/workspace"
	}
	return &out, nil
}

func (d *RemoteDriver) ApplyWorkspaceOps(ctx context.Context, vmID string, ops []repo.WorkspaceFileOp) error {
	hostID, ok := d.mux.HostForVM(vmID)
	if !ok {
		return apperr.NotFoundf("remote host binding for VM %q not found", vmID)
	}
	_, err := d.mux.Dispatch(ctx, hostID, "vm.sync", vmID, map[string]any{"ops": ops}, nil, nil)
	return err
}

func (d *RemoteDriver) ReplaceWorkspace(ctx context.Context, vmID string, files map[string]repo.MaterializedFile) error {
	hostID, ok := d.mux.HostForVM(vmID)
	if !ok {
		return apperr.NotFoundf("remote host binding for VM %q not found", vmID)
	}
	_, err := d.mux.Dispatch(ctx, hostID, "vm.replace", vmID, map[string]any{
		"files": encodeWireFiles(files),
	}, nil, nil)
	return err
}

func (d *RemoteDriver) SnapshotWorkspace(ctx context.Context, vmID string) (map[string]repo.MaterializedFile, error) {
	hostID, ok := d.mux.HostForVM(vmID)
	if !ok {
		return nil, apperr.NotFoundf("remote host binding for VM %q not found", vmID)
	}
	res, err := d.mux.Dispatch(ctx, hostID, "vm.snapshot", vmID, map[string]any{}, nil, nil)
	if err != nil {
		return nil, err
	}
	var payload struct {
		Files map[string]remoteWireFile `json:"files"`
	}
	if len(res.Result) > 0 {
		if err := json.Unmarshal(res.Result, &payload); err != nil {
			return nil, apperr.Internal("unmarshal remote snapshot", err)
		}
	}
	return decodeWireFiles(payload.Files)
}

func (d *RemoteDriver) Stop(ctx context.Context, vmID string) error {
	hostID, ok := d.mux.HostForVM(vmID)
	if !ok {
		return nil
	}
	_, _ = d.mux.Dispatch(ctx, hostID, "vm.stop", vmID, map[string]any{}, nil, nil)
	return nil
}

func (d *RemoteDriver) Close() error { return nil }
