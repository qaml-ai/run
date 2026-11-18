package vm

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
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

func (a *liveVMSessionAdapter) ApplyOps(ctx context.Context, ops []repo.WorkspaceFileOp) error {
	return a.mgr.driver.ApplyWorkspaceOps(ctx, a.vmRec.VMID, ops)
}

func (a *liveVMSessionAdapter) UpdateHead(ctx context.Context, newHeadCommit string) error {
	a.vmRec.HeadCommit = newHeadCommit
	a.vmRec.LastActiveAt = a.mgr.nowMs()
	return a.mgr.store.UpdateVM(ctx, a.vmRec)
}

func (a *liveVMSessionAdapter) StopForRestore(ctx context.Context) error {
	return a.mgr.stopWithoutCommitLocked(ctx, a.vmRec.VMID)
}

type liveVMReaderAdapter struct {
	mgr   *Manager
	vmRec *store.VMRecord
}

func (a *liveVMReaderAdapter) HeadCommit() string {
	return a.vmRec.HeadCommit
}

func (a *liveVMReaderAdapter) ReadFile(ctx context.Context, path string, offset, limit int64) (*repo.ReadResponse, error) {
	return a.mgr.driver.ReadWorkspaceFile(ctx, a.vmRec.VMID, a.vmRec.HeadCommit, path, offset, limit)
}

func (a *liveVMReaderAdapter) ListEntries(ctx context.Context, dirPrefix string, recursive bool, glob string) ([]repo.TreeEntry, error) {
	return a.mgr.driver.ListWorkspaceEntries(ctx, a.vmRec.VMID, dirPrefix, recursive, glob)
}

func (a *liveVMReaderAdapter) Grep(ctx context.Context, req repo.GrepRequest) ([]repo.GrepMatch, error) {
	return a.mgr.driver.GrepWorkspace(ctx, a.vmRec.VMID, req)
}

// WithRefReadVM routes read-only API calls directly to the running VM on (lineage, ref) if active.
func (m *Manager) WithRefReadVM(ctx context.Context, lineage, ref string, fn func(reader repo.LiveVMReader) error) (bool, error) {
	refLk := m.getRefLock(lineage, ref)
	refLk.Lock()
	defer refLk.Unlock()

	running, err := m.store.GetRunningVMByRef(ctx, lineage, ref)
	if err != nil {
		return false, err
	}
	if running == nil {
		return false, nil
	}

	vmLk := m.getVMLock(running.VMID)
	vmLk.Lock()
	defer vmLk.Unlock()

	fresh, err := m.store.GetVM(ctx, running.VMID)
	if err != nil {
		return false, err
	}
	if fresh.State != "running" {
		return false, nil
	}
	return true, fn(&liveVMReaderAdapter{mgr: m, vmRec: fresh})
}

// WithRefWriteLock implements repo.VMCoordinator so /write, /restore, and /refs
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
		_, err := m.stopLocked(ctx, running.VMID)
		vmLk.Unlock()
		if err != nil {
			return err
		}
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
	if err != nil {
		return err
	}
	if fresh.State != "running" {
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
			_, err := m.stopLocked(ctx, existing.VMID)
			vmLk.Unlock()
			if err != nil {
				return nil, err
			}
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

	vmID := store.RandomID("vm")
	spec := StartSpec{VMID: vmID, VCPUs: vcpus, MemoryMiB: memMiB, Env: req.Env}
	if _, firecracker := m.driver.(*FirecrackerDriver); firecracker {
		_, spec.Tree, err = m.repo.LoadCommitTree(ctx, leaseRes.Commit)
	} else {
		_, spec.Files, err = m.repo.LoadCommitFiles(ctx, leaseRes.Commit)
	}
	var hostID string
	if err == nil {
		hostID, err = m.driver.Start(ctx, spec)
	}
	if err != nil {
		_, _ = m.repo.LeaseRef(ctx, lineage, repo.LeaseRequest{Ref: ref, Holder: holder, Release: true})
		return nil, err
	}
	if hostID != "" && hostID != "local" && hostID != firecrackerHost {
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
	if vmRec.State == store.VMStateLost {
		return nil, false, apperr.VMLost(vmID)
	}
	if vmRec.State != "running" {
		return nil, false, apperr.VMStopped(vmID)
	}
	if strings.TrimSpace(req.Command) == "" {
		return nil, false, apperr.InvalidRequest("command is required")
	}

	startTime := time.Now()
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

	resp, err := m.completeExec(ctx, vmRec, execID, req, drvRes, time.Since(startTime))
	if err != nil {
		// The guest may have changed its disk. Discard that VM so a later
		// command or clean stop cannot publish an unfinished checkpoint.
		cleanup, cancel := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
		defer cancel()
		return nil, false, apperr.Internal("finalize exec", errors.Join(err, m.discardExecVM(cleanup, vmID)))
	}
	return resp, false, nil
}

func (m *Manager) checkpointWorkspaceLocked(ctx context.Context, vmRec *store.VMRecord, baseCommit, author, message string) (*repo.WorkspaceCommitResult, error) {
	cp, err := m.driver.CheckpointWorkspace(ctx, vmRec.VMID)
	if err != nil {
		return nil, err
	}
	if cp.Delta {
		return m.repo.ApplyWorkspaceDelta(ctx, vmRec.Lineage, baseCommit, author, message, cp.Puts, cp.Deletes)
	}
	return m.repo.PrepareWorkspaceSnapshot(ctx, vmRec.Lineage, baseCommit, author, message, cp.Snapshot)
}

func (m *Manager) completeExec(
	ctx context.Context, vmRec *store.VMRecord, execID string, req ExecRequest,
	drvRes *DriverExecResult, elapsed time.Duration,
) (*ExecResponse, error) {
	durationMs := max(elapsed.Milliseconds(), 1)
	baseCommit := vmRec.HeadCommit

	var commitRes repo.WorkspaceCommitResult
	skipCommit := req.Commit != nil && req.Commit.Skip
	if skipCommit {
		headObj, err := m.repo.GetCommit(ctx, vmRec.HeadCommit)
		if err != nil {
			return nil, err
		}
		commitRes = repo.WorkspaceCommitResult{
			Changed:      false,
			Commit:       vmRec.HeadCommit,
			Tree:         headObj.Tree,
			FilesChanged: []string{},
		}
	} else {
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
		cr, err := m.checkpointWorkspaceLocked(ctx, vmRec, baseCommit, author, msg)
		if err != nil {
			return nil, err
		}
		commitRes = *cr
	}

	now := m.nowMs()
	vmRec.HeadCommit = commitRes.Commit
	vmRec.LastActiveAt = now
	vmRec.TotalDurationMs += durationMs
	vmRec.BilledMs += durationMs

	resp := &ExecResponse{
		ExecID:     execID,
		ExitCode:   drvRes.ExitCode,
		Stdout:     drvRes.Stdout,
		Stderr:     drvRes.Stderr,
		Cwd:        drvRes.Cwd,
		TimedOut:   drvRes.TimedOut,
		DurationMs: durationMs,
		BillableMs: durationMs,
		Commit:     commitRes,
	}
	raw, err := json.Marshal(resp)
	if err != nil {
		return nil, apperr.Internal("marshal exec receipt", err)
	}
	if err := m.store.CompleteExec(ctx, store.CompleteExecParams{
		VM: vmRec, BaseCommit: baseCommit, Tree: commitRes.Tree,
		Receipt: store.ExecReceipt{VMID: vmRec.VMID, ExecID: execID, ResponseJSON: raw, CreatedAt: now},
	}); err != nil {
		return nil, err
	}
	return resp, nil
}

func (m *Manager) discardExecVM(ctx context.Context, vmID string) error {
	stopErr := m.driver.Stop(ctx, vmID)
	rec, err := m.store.GetVM(ctx, vmID)
	if err != nil {
		return errors.Join(stopErr, err)
	}
	if rec.State != "running" {
		return stopErr
	}
	return errors.Join(stopErr, retireLostVM(ctx, m.store, rec))
}

func retireLostVM(ctx context.Context, st store.Store, rec *store.VMRecord) error {
	lease, err := st.LeaseRef(ctx, store.LeaseRefParams{
		Lineage: rec.Lineage, Ref: rec.Ref, Holder: rec.Holder,
		Release: true, ExpectedEpoch: rec.LeaseEpoch, NowMs: time.Now().UnixMilli(),
	})
	if err != nil && !apperr.IsCode(err, apperr.CodeNotFound) {
		return fmt.Errorf("release lease for lost VM %s: %w", rec.VMID, err)
	}
	// Completion checks the same ref lease, so any in-flight transaction
	// has either won by now or cannot commit. Reload the VM after releasing
	// the lease to retain the winning transaction's accounting and head.
	fresh, err := st.GetVM(ctx, rec.VMID)
	if err != nil {
		return fmt.Errorf("read lost VM %s: %w", rec.VMID, err)
	}
	if lease != nil && fresh.HeadCommit == rec.HeadCommit {
		fresh.HeadCommit = lease.Commit
	}
	fresh.LeaseExpiresAt = 0
	fresh.State = store.VMStateLost
	if err := st.UpdateVM(ctx, fresh); err != nil {
		return fmt.Errorf("retire lost VM %s: %w", rec.VMID, err)
	}
	return nil
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
	return m.stopInternalLocked(ctx, vmID, true)
}

func (m *Manager) stopWithoutCommitLocked(ctx context.Context, vmID string) error {
	_, err := m.stopInternalLocked(ctx, vmID, false)
	return err
}

func (m *Manager) stopInternalLocked(ctx context.Context, vmID string, commitWorkspace bool) (*StopVMResponse, error) {
	vmRec, err := m.store.GetVM(ctx, vmID)
	if err != nil {
		return nil, err
	}
	if vmRec.State != "running" {
		return &StopVMResponse{
			VMID:       vmRec.VMID,
			State:      vmRec.State,
			Commit:     vmRec.HeadCommit,
			UnbilledMs: 0,
		}, nil
	}

	if commitWorkspace {
		cr, err := m.checkpointWorkspaceLocked(ctx, vmRec, vmRec.HeadCommit,
			"agent:"+vmRec.Holder, "vm stop: final workspace sync")
		if err != nil {
			return nil, err
		}
		if cr.Changed {
			_, err := m.store.SetRef(ctx, store.SetRefParams{
				Lineage: vmRec.Lineage, Ref: vmRec.Ref, Holder: vmRec.Holder,
				ExpectedEpoch: vmRec.LeaseEpoch, ExpectedCommit: vmRec.HeadCommit,
				Commit: cr.Commit, Tree: cr.Tree, NowMs: m.nowMs(),
			})
			if err != nil {
				return nil, err
			}
			vmRec.HeadCommit = cr.Commit
			if err := m.store.UpdateVM(ctx, vmRec); err != nil {
				return nil, err
			}
		}
	}
	if err := m.driver.Stop(ctx, vmID); err != nil {
		return nil, err
	}
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
	running, err := m.store.ListRunningVMs(ctx, false)
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
