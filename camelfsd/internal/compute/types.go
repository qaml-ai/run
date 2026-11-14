// Package compute persists the VM lifecycle and host slot accounting.
package compute

import (
	"errors"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
)

type Tables struct{ VMs, Hosts, Deliveries, Usage string }

type Controller struct {
	DB         *dynamodb.Client
	Tables     Tables
	Now        func() time.Time
	RuntimeURL string

	// afterWrite is used by tests to lose a successful write's response.
	afterWrite func() error
}

type Phase string

const (
	Requested Phase = "requested"
	Placed    Phase = "placed"
	Booting   Phase = "booting"
	Running   Phase = "running"
	Stopping  Phase = "stopping"
	Ended     Phase = "ended"
)

type EndCode string

const (
	Exit         EndCode = "exit"
	Stopped      EndCode = "stopped"
	Timeout      EndCode = "timeout"
	HostLost     EndCode = "host_lost"
	StartFailed  EndCode = "start_failed"
	LeaseExpired EndCode = "lease_expired"
)

const (
	JobMode     = "job"
	SessionMode = "session"
	// JobDeadlineGrace allows the host time to report the result after the job timeout.
	JobDeadlineGrace = 30 * time.Second
)

var (
	ErrNotFound  = errors.New("compute item not found")
	ErrConflict  = errors.New("VM id already used by another request")
	ErrNoHost    = errors.New("no host available")
	ErrCondition = errors.New("compute condition lost")
	ErrPhase     = errors.New("invalid VM phase for operation")
	ErrHost      = errors.New("host or boot epoch does not match")
	ErrInvalid   = errors.New("invalid compute request")
	// ErrLeaseExpired: a lapsed lease is final. A renewal that arrives after the deadline never revives it.
	ErrLeaseExpired = errors.New("VM lease has expired")
)

type Shape struct {
	VCPUs     int `json:"vcpus"`
	MemoryMiB int `json:"memoryMiB"`
	DiskGiB   int `json:"diskGiB"`
}

type Job struct {
	Command  string
	TimeoutS int64
	Env      map[string]string
	Outputs  []string
	Commit   bool
}

type Session struct{ IdleStopS int64 }

type CreateRequest struct {
	ID, Lineage, Ref, Version string
	Mode, Image, Pool, Payer  string
	Shape                     Shape
	Job                       *Job
	Session                   *Session
	Network                   map[string]types.AttributeValue
	Deadline                  time.Time
}

// VM timestamps are Unix milliseconds. Pointers distinguish unset timestamps from zero.
type VM struct {
	CreateRequest
	Phase                           Phase
	CreatedAt, LeaseDeadline        int64
	Host                            string
	HostEpoch                       int64
	PlacedAt, BootingAt, DeadlineAt *int64
	StartedAt, LastListedAt         *int64
	StopRequestedAt, EndedAt        *int64
	StopCheckpoint                  bool
	StopReason, Code                EndCode
	Exit                            int
	TimedOut                        bool
	ResultRef, EndVersion           string
	CheckpointError                 string
	BilledTo, UsageSeq              int64
}

type EndRequest struct {
	At                    time.Time
	Code                  EndCode
	Exit                  int
	TimedOut              bool
	ResultRef, EndVersion string
	CheckpointError       string
}

type HostInfo struct {
	Pool, Host, BootID, Addr string
	Shape                    Shape
	Slots                    int
	Features                 []string
	Draining                 bool
}

type Host struct {
	HostInfo
	BootEpoch, LastSeenAt int64
	Free                  int
	VMs                   []string
	Restarting            bool
}

type Waiter struct {
	Pool, Host, VM   string
	CreatedAt        int64
	MemoryMiB, VCPUs int
}
