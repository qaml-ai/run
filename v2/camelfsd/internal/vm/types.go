package vm

import (
	"context"
	"encoding/json"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
)

type StartSpec struct {
	VMID      string                           `json:"vmId"`
	VCPUs     int                              `json:"vcpus"`
	MemoryMiB int                              `json:"memoryMiB"`
	Env       map[string]string                `json:"env,omitempty"`
	Files     map[string]repo.MaterializedFile `json:"files,omitempty"`
	Disk      string                           `json:"disk,omitempty"`
}

type DriverExecRequest struct {
	VMID     string             `json:"vmId"`
	ExecID   string             `json:"execId"`
	Command  string             `json:"command"`
	Cwd      string             `json:"cwd,omitempty"`
	Env      map[string]string  `json:"env,omitempty"`
	TimeoutS int                `json:"timeoutS,omitempty"`
	OnStdout func(chunk string) `json:"-"`
	OnStderr func(chunk string) `json:"-"`
}

type DriverExecResult struct {
	ExitCode int    `json:"exitCode"`
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	Cwd      string `json:"cwd"`
	TimedOut bool   `json:"timedOut"`
}

// Driver abstracts VM execution backends: local persistent bash, Firecracker microVM,
// and outbound remote compute hosts.
type Driver interface {
	Start(ctx context.Context, spec StartSpec) (hostID string, err error)
	Exec(ctx context.Context, req DriverExecRequest) (*DriverExecResult, error)
	ApplyWorkspaceOps(ctx context.Context, vmID string, ops []repo.WorkspaceFileOp) error
	ReplaceWorkspace(ctx context.Context, vmID string, files map[string]repo.MaterializedFile) error
	SnapshotWorkspace(ctx context.Context, vmID string) (map[string]repo.MaterializedFile, error)
	Stop(ctx context.Context, vmID string) error
	Close() error
}

type BootVMRequest struct {
	Lineage      string            `json:"lineage"`
	Ref          string            `json:"ref"`
	Holder       string            `json:"holder"`
	VCPUs        int               `json:"vcpus"`
	MemoryMiB    int               `json:"memoryMiB"`
	IdleTimeoutS int               `json:"idleTimeoutS"`
	LeaseS       int               `json:"leaseS"`
	Env          map[string]string `json:"env,omitempty"`
}

type BootVMResponse struct {
	VMID           string `json:"vmId"`
	Lineage        string `json:"lineage"`
	Ref            string `json:"ref"`
	Holder         string `json:"holder"`
	State          string `json:"state"`
	HeadCommit     string `json:"headCommit"`
	Reused         bool   `json:"reused"`
	LeaseExpiresAt int64  `json:"leaseExpiresAt"`
}

type ExecCommitOptions struct {
	Author  string `json:"author,omitempty"`
	Message string `json:"message,omitempty"`
	Skip    bool   `json:"skip,omitempty"`
}

type ExecRequest struct {
	ExecID   string             `json:"execId"`
	Command  string             `json:"command"`
	Cwd      string             `json:"cwd,omitempty"`
	Env      map[string]string  `json:"env,omitempty"`
	TimeoutS int                `json:"timeoutS,omitempty"`
	Commit   *ExecCommitOptions `json:"commit,omitempty"`
}

type ExecResponse struct {
	ExecID     string                     `json:"execId"`
	ExitCode   int                        `json:"exitCode"`
	Stdout     string                     `json:"stdout"`
	Stderr     string                     `json:"stderr"`
	Cwd        string                     `json:"cwd"`
	TimedOut   bool                       `json:"timedOut"`
	DurationMs int64                      `json:"durationMs"`
	BillableMs int64                      `json:"billableMs"`
	Commit     repo.WorkspaceCommitResult `json:"commit"`
}

type RenewLeaseRequest struct {
	LeaseS int `json:"leaseS"`
}

type RenewLeaseResponse struct {
	VMID           string `json:"vmId"`
	State          string `json:"state"`
	LeaseExpiresAt int64  `json:"leaseExpiresAt"`
}

type StopVMResponse struct {
	VMID       string `json:"vmId"`
	State      string `json:"state"`
	Commit     string `json:"commit"`
	UnbilledMs int64  `json:"unbilledMs"`
}

type GetVMResponse struct {
	VMID           string `json:"vmId"`
	Lineage        string `json:"lineage"`
	Ref            string `json:"ref"`
	Holder         string `json:"holder"`
	State          string `json:"state"`
	HeadCommit     string `json:"headCommit"`
	LeaseExpiresAt int64  `json:"leaseExpiresAt"`
}

// Outbound Compute Host Multiplexing wire messages (/v1/hosts/*)

type HostHeartbeatRequest struct {
	HostID      string            `json:"hostId"`
	Address     string            `json:"address,omitempty"`
	CapacityVMs int               `json:"capacityVms"`
	RunningVMs  int               `json:"runningVms"`
	Status      string            `json:"status,omitempty"`
	Labels      map[string]string `json:"labels,omitempty"`
}

type HostHeartbeatResponse struct {
	OK         bool   `json:"ok"`
	HostID     string `json:"hostId"`
	ServerTime int64  `json:"serverTime"`
}

type HostCommand struct {
	CommandID string          `json:"commandId"`
	Type      string          `json:"type"` // vm.start | vm.exec | vm.sync | vm.replace | vm.snapshot | vm.stop
	VMID      string          `json:"vmId"`
	Payload   json.RawMessage `json:"payload"`
}

type HostCommandsResponse struct {
	Commands []HostCommand `json:"commands"`
}

type HostResultRequest struct {
	CommandID   string          `json:"commandId"`
	VMID        string          `json:"vmId"`
	OK          bool            `json:"ok"`
	Error       string          `json:"error,omitempty"`
	StdoutChunk string          `json:"stdoutChunk,omitempty"`
	StderrChunk string          `json:"stderrChunk,omitempty"`
	Done        bool            `json:"done"`
	Result      json.RawMessage `json:"result,omitempty"`
}

type HostResultResponse struct {
	OK bool `json:"ok"`
}
