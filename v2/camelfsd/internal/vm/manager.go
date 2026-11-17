package vm

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/store"
)

type ManagerConfig struct {
	Store          store.Store
	Repo           *repo.Engine
	Driver         Driver
	HostMux        *HostMux
	NowFn          func() time.Time
	ReaperInterval time.Duration
}

type Manager struct {
	store   store.Store
	repo    *repo.Engine
	driver  Driver
	hostMux *HostMux
	nowFn   func() time.Time

	locksMu  sync.Mutex
	refLocks map[string]*sync.Mutex
	vmLocks  map[string]*sync.Mutex

	reaperCancel context.CancelFunc
	reaperDone   chan struct{}
}

func NewManager(cfg ManagerConfig) *Manager {
	nowFn := cfg.NowFn
	if nowFn == nil {
		nowFn = time.Now
	}
	mux := cfg.HostMux
	if mux == nil {
		mux = NewHostMux(cfg.Store, nowFn)
	}
	m := &Manager{
		store:    cfg.Store,
		repo:     cfg.Repo,
		driver:   cfg.Driver,
		hostMux:  mux,
		nowFn:    nowFn,
		refLocks: make(map[string]*sync.Mutex),
		vmLocks:  make(map[string]*sync.Mutex),
	}
	if cfg.Repo != nil {
		cfg.Repo.SetVMCoordinator(m)
	}
	interval := cfg.ReaperInterval
	if interval <= 0 {
		interval = time.Second
	}
	rCtx, cancel := context.WithCancel(context.Background())
	m.reaperCancel = cancel
	m.reaperDone = make(chan struct{})
	go m.reaperLoop(rCtx, interval)
	return m
}

func (m *Manager) HostMux() *HostMux {
	return m.hostMux
}

func (m *Manager) Close() error {
	if m.reaperCancel != nil {
		m.reaperCancel()
		<-m.reaperDone
	}
	if m.driver != nil {
		return m.driver.Close()
	}
	return nil
}

func (m *Manager) nowMs() int64 {
	return m.nowFn().UnixMilli()
}

func (m *Manager) getRefLock(lineage, ref string) *sync.Mutex {
	key := lineage + "\x00" + ref
	m.locksMu.Lock()
	defer m.locksMu.Unlock()
	lk, ok := m.refLocks[key]
	if !ok {
		lk = &sync.Mutex{}
		m.refLocks[key] = lk
	}
	return lk
}

func (m *Manager) getVMLock(vmID string) *sync.Mutex {
	m.locksMu.Lock()
	defer m.locksMu.Unlock()
	lk, ok := m.vmLocks[vmID]
	if !ok {
		lk = &sync.Mutex{}
		m.vmLocks[vmID] = lk
	}
	return lk
}

type liveVMSessionAdapter struct {
	mgr   *Manager
	vmRec *store.VMRecord
}

func (a *liveVMSessionAdapter) ApplyOps(ctx context.Context, ops []repo.WorkspaceFileOp, newHeadCommit string) error {
	if err := a.mgr.driver.ApplyWorkspaceOps(ctx, a.vmRec.VMID, ops); err != nil {
		return err
	}
	a.vmRec.HeadCommit = newHeadCommit
	a.vmRec.LastActiveAt = a.mgr.nowMs()
	return a.mgr.store.UpdateVM(ctx, a.vmRec)
}

func (a *liveVMSessionAdapter) ReplaceTree(ctx context.Context, files map[string]repo.MaterializedFile, newHeadCommit string) error {
	if err := a.mgr.driver.ReplaceWorkspace(ctx, a.vmRec.VMID, files); err != nil {
		return err
	}
	a.vmRec.HeadCommit = newHeadCommit
	a.vmRec.LastActiveAt = a.mgr.nowMs()
	return a.mgr.store.UpdateVM(ctx, a.vmRec)
}

// WithRefWriteLock implements repo.VMCoordinator so /write, /restore, /merge, and /refs
// serialize cleanly with active VM sessions on (lineage, ref) and synchronize /workspace directly
// when held by the same holder.
func (m *Manager) WithRefWriteLock(
	ctx context.Context,
	lineage, ref, holder string,
	fn func(vmSession repo.ActiveVMSession) error,
) error {
	refLk := m.getRefLock(lineage, ref)
	refLk.Lock()
	defer refLk.Unlock()

	running, err := m.store.GetRunningVMByRef(ctx, lineage, ref)
	if err != nil {
		return err
	}
	if running == nil {
		return fn(nil)
	}

	now := m.nowMs()
	// If the existing VM's lease already expired, reap it first so the ref isn't stuck.
	if running.LeaseExpiresAt <= now && running.Holder != holder {
		vmLk := m.getVMLock(running.VMID)
		vmLk.Lock()
		_, _ = m.stopLocked(ctx, running.VMID)
		vmLk.Unlock()
		return fn(nil)
	}

	if running.Holder != holder {
		return apperr.RefLeasedf("ref %q has an active VM (%s) leased by %q", ref, running.VMID, running.Holder)
	}

	vmLk := m.getVMLock(running.VMID)
	vmLk.Lock()
	defer vmLk.Unlock()

	// Re-read VM record under vmLk in case state or headCommit changed.
	fresh, err := m.store.GetVM(ctx, running.VMID)
	if err != nil || fresh.State != "running" {
		return fn(nil)
	}
	return fn(&liveVMSessionAdapter{mgr: m, vmRec: fresh})
}

// StopLineageVMs stops all active VMs on lineage before lineage deletion.
func (m *Manager) StopLineageVMs(ctx context.Context, lineage string) error {
	vms, err := m.store.ListRunningVMsByLineage(ctx, lineage)
	if err != nil {
		return err
	}
	for _, v := range vms {
		refLk := m.getRefLock(v.Lineage, v.Ref)
		refLk.Lock()
		vmLk := m.getVMLock(v.VMID)
		vmLk.Lock()
		_ = m.driver.Stop(ctx, v.VMID)
		v.State = "stopped"
		_ = m.store.UpdateVM(ctx, v)
		vmLk.Unlock()
		refLk.Unlock()
	}
	return nil
}

// BootOrReuse finds the running VM for (lineage, ref) if holder matches, or boots a new one
// with /workspace materialized from ref's head commit.
func (m *Manager) BootOrReuse(ctx context.Context, req BootVMRequest) (*BootVMResponse, error) {
	lineage := strings.TrimSpace(req.Lineage)
	if lineage == "" {
		return nil, apperr.InvalidRequest("lineage is required")
	}
	ref := strings.TrimSpace(req.Ref)
	if ref == "" {
		ref = repo.DefaultRef
	}
	holder := strings.TrimSpace(req.Holder)
	if holder == "" {
		holder = "default"
	}
	vcpus := req.VCPUs
	if vcpus <= 0 {
		vcpus = 2
	}
	memMiB := req.MemoryMiB
	if memMiB <= 0 {
		memMiB = 2048
	}
	idleTimeoutS := req.IdleTimeoutS
	if idleTimeoutS <= 0 {
		idleTimeoutS = 300
	}
	leaseS := req.LeaseS
	if leaseS <= 0 {
		leaseS = 600
	}

	refLk := m.getRefLock(lineage, ref)
	refLk.Lock()
	defer refLk.Unlock()

	now := m.nowMs()
	existing, err := m.store.GetRunningVMByRef(ctx, lineage, ref)
	if err != nil {
		return nil, err
	}
	if existing != nil {
		if existing.Holder == holder {
			vmLk := m.getVMLock(existing.VMID)
			vmLk.Lock()
			defer vmLk.Unlock()

			fresh, err := m.store.GetVM(ctx, existing.VMID)
			if err == nil && fresh.State == "running" {
				leaseRes, err := m.repo.LeaseRef(ctx, lineage, repo.LeaseRequest{
					Ref:    ref,
					Holder: holder,
					TTLMs:  int64(leaseS) * 1000,
				})
				if err != nil {
					return nil, err
				}
				fresh.LeaseEpoch = leaseRes.Epoch
				fresh.LeaseExpiresAt = leaseRes.ExpiresAt
				fresh.LastActiveAt = now
				if req.IdleTimeoutS > 0 {
					fresh.IdleTimeoutS = req.IdleTimeoutS
				}
				if err := m.store.UpdateVM(ctx, fresh); err != nil {
					return nil, err
				}
				return &BootVMResponse{
					VMID:           fresh.VMID,
					Lineage:        fresh.Lineage,
					Ref:            fresh.Ref,
					Holder:         fresh.Holder,
					State:          fresh.State,
					HeadCommit:     fresh.HeadCommit,
					Reused:         true,
					LeaseExpiresAt: fresh.LeaseExpiresAt,
				}, nil
			}
		} else {
			if existing.LeaseExpiresAt > now {
				return nil, apperr.RefLeasedf("running VM %q on (%s, %s) is leased by %q", existing.VMID, lineage, ref, existing.Holder)
			}
			// Expired VM held by previous holder: stop & reap cleanly first.
			vmLk := m.getVMLock(existing.VMID)
			vmLk.Lock()
			_, _ = m.stopLocked(ctx, existing.VMID)
			vmLk.Unlock()
		}
	}

	// Acquire fenced ref lease on (lineage, ref).
	leaseRes, err := m.repo.LeaseRef(ctx, lineage, repo.LeaseRequest{
		Ref:    ref,
		Holder: holder,
		TTLMs:  int64(leaseS) * 1000,
	})
	if err != nil {
		return nil, err
	}

	// Load files from head commit to materialize /workspace BEFORE starting VM session.
	_, files, err := m.repo.LoadCommitFiles(ctx, leaseRes.Commit)
	if err != nil {
		_, _ = m.repo.LeaseRef(ctx, lineage, repo.LeaseRequest{Ref: ref, Holder: holder, Release: true})
		return nil, err
	}

	vmID := store.RandomID("vm")
	hostID, err := m.driver.Start(ctx, StartSpec{
		VMID:      vmID,
		VCPUs:     vcpus,
		MemoryMiB: memMiB,
		Env:       req.Env,
		Files:     files,
	})
	if err != nil {
		_, _ = m.repo.LeaseRef(ctx, lineage, repo.LeaseRequest{Ref: ref, Holder: holder, Release: true})
		return nil, err
	}
	if hostID != "" && hostID != "local" && hostID != "firecracker" {
		m.hostMux.BindVMHost(vmID, hostID)
	}

	rec := &store.VMRecord{
		VMID:           vmID,
		Lineage:        lineage,
		Ref:            ref,
		Holder:         holder,
		LeaseEpoch:     leaseRes.Epoch,
		State:          "running",
		HeadCommit:     leaseRes.Commit,
		VCPUs:          vcpus,
		MemoryMiB:      memMiB,
		IdleTimeoutS:   idleTimeoutS,
		Env:            req.Env,
		HostID:         hostID,
		CreatedAt:      now,
		LastActiveAt:   now,
		LeaseExpiresAt: leaseRes.ExpiresAt,
	}
	if err := m.store.CreateRunningVM(ctx, rec); err != nil {
		_ = m.driver.Stop(ctx, vmID)
		_, _ = m.repo.LeaseRef(ctx, lineage, repo.LeaseRequest{Ref: ref, Holder: holder, Release: true})
		return nil, err
	}

	return &BootVMResponse{
		VMID:           rec.VMID,
		Lineage:        rec.Lineage,
		Ref:            rec.Ref,
		Holder:         rec.Holder,
		State:          rec.State,
		HeadCommit:     rec.HeadCommit,
		Reused:         false,
		LeaseExpiresAt: rec.LeaseExpiresAt,
	}, nil
}

func truncateCmd(cmd string, maxLen int) string {
	s := strings.TrimSpace(strings.ReplaceAll(cmd, "\n", "; "))
	if len(s) <= maxLen {
		return s
	}
	return s[:maxLen]
}

// Exec runs a bash command inside vmID's persistent shell, streams stdout/stderr chunks via
// callbacks if provided, and atomically commits any /workspace changes to (lineage, ref).
// Idempotent by execId.
func (m *Manager) Exec(
	ctx context.Context,
	vmID string,
	req ExecRequest,
	onStdout func(chunk string),
	onStderr func(chunk string),
) (*ExecResponse, bool, error) {
	execID := strings.TrimSpace(req.ExecID)
	if execID == "" {
		execID = store.RandomID("exec")
	}

	// Fast path idempotency lookup before taking VM lock.
	if receipt, err := m.store.GetExecReceipt(ctx, vmID, execID); err != nil {
		return nil, false, err
	} else if receipt != nil {
		var cached ExecResponse
		if err := json.Unmarshal(receipt.ResponseJSON, &cached); err != nil {
			return nil, false, apperr.Internal("unmarshal cached exec receipt", err)
		}
		return &cached, true, nil
	}

	vmLk := m.getVMLock(vmID)
	vmLk.Lock()
	defer vmLk.Unlock()

	// Re-check receipt under VM lock to avoid duplicate concurrent executions of same execId.
	if receipt, err := m.store.GetExecReceipt(ctx, vmID, execID); err != nil {
		return nil, false, err
	} else if receipt != nil {
		var cached ExecResponse
		if err := json.Unmarshal(receipt.ResponseJSON, &cached); err != nil {
			return nil, false, apperr.Internal("unmarshal cached exec receipt", err)
		}
		return &cached, true, nil
	}

	vmRec, err := m.store.GetVM(ctx, vmID)
	if err != nil {
		return nil, false, err
	}
	if vmRec.State != "running" {
		return nil, false, apperr.InvalidRequestf("vm %q is not running (state=%s)", vmID, vmRec.State)
	}
	if strings.TrimSpace(req.Command) == "" {
		return nil, false, apperr.InvalidRequest("command is required")
	}

	startTime := time.Now()
	vmRec.LastActiveAt = m.nowMs()
	_ = m.store.UpdateVM(ctx, vmRec)

	drvRes, err := m.driver.Exec(ctx, DriverExecRequest{
		VMID:     vmID,
		ExecID:   execID,
		Command:  req.Command,
		Cwd:      req.Cwd,
		Env:      req.Env,
		TimeoutS: req.TimeoutS,
		OnStdout: onStdout,
		OnStderr: onStderr,
	})
	if err != nil {
		return nil, false, err
	}

	durationMs := time.Since(startTime).Milliseconds()
	if durationMs < 1 {
		durationMs = 1
	}

	var commitRes repo.WorkspaceCommitResult
	skipCommit := req.Commit != nil && req.Commit.Skip
	if skipCommit {
		headObj, err := m.repo.GetCommit(ctx, vmRec.HeadCommit)
		if err != nil {
			return nil, false, err
		}
		commitRes = repo.WorkspaceCommitResult{
			Changed:      false,
			Commit:       vmRec.HeadCommit,
			Tree:         headObj.Tree,
			FilesChanged: []string{},
		}
	} else {
		snapshot, err := m.driver.SnapshotWorkspace(ctx, vmID)
		if err != nil {
			return nil, false, err
		}
		author := "agent:" + vmRec.Holder
		msg := "bash: " + truncateCmd(req.Command, 72)
		if req.Commit != nil {
			if strings.TrimSpace(req.Commit.Author) != "" {
				author = req.Commit.Author
			}
			if strings.TrimSpace(req.Commit.Message) != "" {
				msg = req.Commit.Message
			}
		}
		cr, err := m.repo.CommitSnapshotIfChanged(
			ctx,
			vmRec.Lineage,
			vmRec.Ref,
			vmRec.Holder,
			vmRec.LeaseEpoch,
			vmRec.HeadCommit,
			author,
			msg,
			snapshot,
		)
		if err != nil {
			return nil, false, err
		}
		commitRes = *cr
		if commitRes.Changed {
			vmRec.HeadCommit = commitRes.Commit
		}
	}

	now := m.nowMs()
	billableMs := durationMs
	vmRec.LastActiveAt = now
	vmRec.TotalDurationMs += durationMs
	vmRec.BilledMs += billableMs
	if err := m.store.UpdateVM(ctx, vmRec); err != nil {
		return nil, false, err
	}

	resp := &ExecResponse{
		ExecID:     execID,
		ExitCode:   drvRes.ExitCode,
		Stdout:     drvRes.Stdout,
		Stderr:     drvRes.Stderr,
		Cwd:        drvRes.Cwd,
		TimedOut:   drvRes.TimedOut,
		DurationMs: durationMs,
		BillableMs: billableMs,
		Commit:     commitRes,
	}
	if raw, err := json.Marshal(resp); err == nil {
		_ = m.store.PutExecReceipt(ctx, &store.ExecReceipt{
			VMID:         vmID,
			ExecID:       execID,
			ResponseJSON: raw,
			CreatedAt:    now,
		})
	}
	return resp, false, nil
}

func (m *Manager) RenewLease(ctx context.Context, vmID string, req RenewLeaseRequest) (*RenewLeaseResponse, error) {
	vmLk := m.getVMLock(vmID)
	vmLk.Lock()
	defer vmLk.Unlock()

	vmRec, err := m.store.GetVM(ctx, vmID)
	if err != nil {
		return nil, err
	}
	if vmRec.State != "running" {
		return nil, apperr.InvalidRequestf("vm %q is not running", vmID)
	}
	leaseS := req.LeaseS
	if leaseS <= 0 {
		leaseS = 600
	}
	leaseRes, err := m.repo.LeaseRef(ctx, vmRec.Lineage, repo.LeaseRequest{
		Ref:    vmRec.Ref,
		Holder: vmRec.Holder,
		TTLMs:  int64(leaseS) * 1000,
	})
	if err != nil {
		return nil, err
	}
	vmRec.LeaseEpoch = leaseRes.Epoch
	vmRec.LeaseExpiresAt = leaseRes.ExpiresAt
	vmRec.LastActiveAt = m.nowMs()
	if err := m.store.UpdateVM(ctx, vmRec); err != nil {
		return nil, err
	}
	return &RenewLeaseResponse{
		VMID:           vmRec.VMID,
		State:          vmRec.State,
		LeaseExpiresAt: vmRec.LeaseExpiresAt,
	}, nil
}

func (m *Manager) Stop(ctx context.Context, vmID string) (*StopVMResponse, error) {
	vmRec, err := m.store.GetVM(ctx, vmID)
	if err != nil {
		return nil, err
	}
	refLk := m.getRefLock(vmRec.Lineage, vmRec.Ref)
	refLk.Lock()
	defer refLk.Unlock()

	vmLk := m.getVMLock(vmID)
	vmLk.Lock()
	defer vmLk.Unlock()

	return m.stopLocked(ctx, vmID)
}

func (m *Manager) stopLocked(ctx context.Context, vmID string) (*StopVMResponse, error) {
	vmRec, err := m.store.GetVM(ctx, vmID)
	if err != nil {
		return nil, err
	}
	if vmRec.State != "running" {
		return &StopVMResponse{
			VMID:       vmRec.VMID,
			State:      "stopped",
			Commit:     vmRec.HeadCommit,
			UnbilledMs: 0,
		}, nil
	}

	// Commit any dirty uncommitted /workspace files before stopping the VM.
	if snapshot, snapErr := m.driver.SnapshotWorkspace(ctx, vmID); snapErr == nil {
		if cr, commitErr := m.repo.CommitSnapshotIfChanged(
			ctx,
			vmRec.Lineage,
			vmRec.Ref,
			vmRec.Holder,
			vmRec.LeaseEpoch,
			vmRec.HeadCommit,
			"agent:"+vmRec.Holder,
			"vm stop: final workspace sync",
			snapshot,
		); commitErr == nil && cr.Changed {
			vmRec.HeadCommit = cr.Commit
		}
	}

	_ = m.driver.Stop(ctx, vmID)
	_, _ = m.repo.LeaseRef(ctx, vmRec.Lineage, repo.LeaseRequest{
		Ref:     vmRec.Ref,
		Holder:  vmRec.Holder,
		Release: true,
	})

	now := m.nowMs()
	aliveMs := now - vmRec.CreatedAt
	if aliveMs < 0 {
		aliveMs = 0
	}
	unbilledMs := aliveMs - vmRec.BilledMs
	if unbilledMs < 0 {
		unbilledMs = 0
	}
	vmRec.BilledMs += unbilledMs
	vmRec.State = "stopped"
	vmRec.LastActiveAt = now
	if err := m.store.UpdateVM(ctx, vmRec); err != nil {
		return nil, err
	}

	return &StopVMResponse{
		VMID:       vmRec.VMID,
		State:      "stopped",
		Commit:     vmRec.HeadCommit,
		UnbilledMs: unbilledMs,
	}, nil
}

func (m *Manager) Get(ctx context.Context, vmID string) (*GetVMResponse, error) {
	vmRec, err := m.store.GetVM(ctx, vmID)
	if err != nil {
		return nil, err
	}
	return &GetVMResponse{
		VMID:           vmRec.VMID,
		Lineage:        vmRec.Lineage,
		Ref:            vmRec.Ref,
		Holder:         vmRec.Holder,
		State:          vmRec.State,
		HeadCommit:     vmRec.HeadCommit,
		LeaseExpiresAt: vmRec.LeaseExpiresAt,
	}, nil
}

func (m *Manager) reaperLoop(ctx context.Context, interval time.Duration) {
	defer close(m.reaperDone)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			m.reapOnce(ctx)
		}
	}
}

func (m *Manager) reapOnce(ctx context.Context) {
	running, err := m.store.ListRunningVMs(ctx)
	if err != nil {
		return
	}
	now := m.nowMs()
	for _, vmRec := range running {
		leaseExpired := vmRec.LeaseExpiresAt > 0 && now >= vmRec.LeaseExpiresAt
		idleExpired := vmRec.IdleTimeoutS > 0 && (now-vmRec.LastActiveAt) >= int64(vmRec.IdleTimeoutS)*1000
		if !leaseExpired && !idleExpired {
			continue
		}

		refLk := m.getRefLock(vmRec.Lineage, vmRec.Ref)
		if !refLk.TryLock() {
			continue
		}
		vmLk := m.getVMLock(vmRec.VMID)
		if !vmLk.TryLock() {
			refLk.Unlock()
			continue
		}

		// Re-verify freshness under lock so we never reap an actively executing VM.
		fresh, err := m.store.GetVM(ctx, vmRec.VMID)
		if err == nil && fresh.State == "running" {
			nowAfterLock := m.nowMs()
			stillLeaseExpired := fresh.LeaseExpiresAt > 0 && nowAfterLock >= fresh.LeaseExpiresAt
			stillIdleExpired := fresh.IdleTimeoutS > 0 && (nowAfterLock-fresh.LastActiveAt) >= int64(fresh.IdleTimeoutS)*1000
			if stillLeaseExpired || stillIdleExpired {
				_, _ = m.stopLocked(ctx, fresh.VMID)
			}
		}
		vmLk.Unlock()
		refLk.Unlock()
	}
}
