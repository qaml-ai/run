// Package compute persists the VM lifecycle and host capacity accounting.
package compute

import (
	"context"
	"errors"
	"time"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type Tables struct{ VMs, Hosts, Deliveries, Usage string }

type Controller struct {
	DB         *dynamodb.Client
	Tables     Tables
	Now        func() time.Time
	RuntimeURL string
	Pusher     Pusher
	Refs       *refstore.Store
	Objects    store.Store
	CommitTree func(ctx context.Context, lineage, version string) (string, error)
	Log        func(event string, fields map[string]any)
	HostFresh  time.Duration
	clock      clockObservation

	// afterWrite is used by tests to lose a successful write's response.
	afterWrite func() error
}

type Pusher interface {
	Boot(ctx context.Context, h Host, spec hostwire.BootSpec) error
	Stop(ctx context.Context, h Host, id string, checkpoint bool) error
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
	Stopped      EndCode = "stopped"
	Idle         EndCode = "idle"
	HostLost     EndCode = "host_lost"
	StartFailed  EndCode = "start_failed"
	LeaseExpired EndCode = "lease_expired"
)

var (
	ErrNotFound     = errors.New("compute item not found")
	ErrConflict     = errors.New("VM id already used by another request")
	ErrTooManyExecs = errors.New("too many in-flight execs")
	ErrNoHost       = errors.New("no host available")
	ErrCondition    = errors.New("compute condition lost")
	ErrPhase        = errors.New("invalid VM phase for operation")
	ErrHost         = errors.New("host or boot epoch does not match")
	ErrInvalid      = errors.New("invalid compute request")
	// ErrLeaseExpired: a lapsed lease is final. A renewal that arrives after the deadline never revives it.
	ErrLeaseExpired = errors.New("VM lease has expired")
)

type Shape struct {
	VCPUs     int `json:"vcpus"`
	MemoryMiB int `json:"memoryMiB"`
	DiskGiB   int `json:"diskGiB"`
	DiskMiB   int `json:"diskMiB,omitempty"`
}

const DefaultIdleStopS = 10

func ValidIdleStop(seconds int64) bool { return seconds > 0 && seconds <= 3600 }

type Session struct{ IdleStopS int64 }

const maxExecsInFlight = 64

type Checkpoint struct {
	Version string `json:"version"`
	Tree    string `json:"tree"`
	At      int64  `json:"at"`
}

type CreateRequest struct {
	ID, Lineage, Ref, Version string
	Image, Pool, Payer        string
	Shape                     Shape
	Session                   *Session
	Internet                  bool
	Deadline                  time.Time
}

// VM timestamps are Unix milliseconds. Pointers distinguish unset timestamps from zero.
type VM struct {
	CreateRequest
	Phase                                   Phase
	CreatedAt, LeaseDeadline                int64
	Host                                    string
	HostEpoch                               int64
	PlacedAt, BootingAt                     *int64
	StartedAt, LastListedAt, LastActivityAt *int64
	StopRequestedAt, EndedAt                *int64
	StopCheckpoint                          bool
	StopReason, Code                        EndCode
	FirstExecAt                             *int64
	execs                                   []string
	LastCheckpoint                          *Checkpoint
	RequestedVersion                        string
	RequestedDeadline                       int64
	ResultRef, EndVersion                   string
	CheckpointError                         string
	Tree, RefLeaseHolder                    string
	RefLeaseEpoch, RefLeaseDeadline         int64
	RefLeaseReleased                        bool
	ResultSha256                            string
	ResultBytes                             int64
	BilledTo, UsageSeq                      int64
}

type EndRequest struct {
	At              time.Time
	Code            EndCode
	EndVersion      string
	CheckpointError string
}

type HostInfo struct {
	Pool, Host, BootID, Addr string
	Shape                    Shape
	Slots                    int
	Features                 []string
	Images                   []string
	Draining                 bool
}

type Host struct {
	HostInfo
	BootEpoch, LastSeenAt int64
	Free                  int
	MemoryMiB, FreeMiB    int
	VMs                   []string
	Restarting            bool
	Lost                  bool
}

type Waiter struct {
	Pool, Host, VM   string
	CreatedAt        int64
	MemoryMiB, VCPUs int
}

// Time is the tier clock used for VM deadlines and the usage watermark.
func (c *Controller) Time() time.Time { return c.now() }
