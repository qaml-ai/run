package store

import (
	"bytes"
	"compress/zlib"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"strconv"
)

type ObjectKind string

const (
	KindBlob      ObjectKind = "blob"
	KindTree      ObjectKind = "tree"
	KindCommit    ObjectKind = "commit"
	KindDiskMap   ObjectKind = "disk-map"
	KindDiskChunk ObjectKind = "disk-chunk"
)

type LineageRecord struct {
	Lineage    string `json:"lineage"`
	TenantID   string `json:"tenantId"`
	DefaultRef string `json:"defaultRef"`
	CreatedAt  int64  `json:"createdAt"`
}

type Lease struct {
	Holder    string `json:"holder"`
	Epoch     int64  `json:"epoch"`
	ExpiresAt int64  `json:"expiresAt"`
}

type RefRecord struct {
	Lineage   string `json:"-"`
	Name      string `json:"name"`
	Commit    string `json:"commit"`
	Tree      string `json:"tree"`
	UpdatedAt int64  `json:"updatedAt"`
	Lease     *Lease `json:"lease,omitempty"`
}

type SetRefParams struct {
	Lineage        string
	Ref            string
	Commit         string
	Tree           string
	ExpectedCommit string
	Holder         string
	ExpectedEpoch  int64
	Delete         bool
	NowMs          int64
}

type LeaseRefParams struct {
	Lineage string
	Ref     string
	Holder  string
	TTLMs   int64
	Release bool
	NowMs   int64
}

type LeaseResult struct {
	Ref       string `json:"ref"`
	Commit    string `json:"commit"`
	Tree      string `json:"tree"`
	Holder    string `json:"holder"`
	Epoch     int64  `json:"epoch"`
	ExpiresAt int64  `json:"expiresAt"`
}

type VMRecord struct {
	VMID            string            `json:"vmId"`
	Lineage         string            `json:"lineage"`
	Ref             string            `json:"ref"`
	Holder          string            `json:"holder"`
	LeaseEpoch      int64             `json:"-"`
	State           string            `json:"state"`
	HeadCommit      string            `json:"headCommit"`
	VCPUs           int               `json:"-"`
	MemoryMiB       int               `json:"-"`
	IdleTimeoutS    int               `json:"-"`
	Env             map[string]string `json:"-"`
	HostID          string            `json:"-"`
	CreatedAt       int64             `json:"-"`
	LastActiveAt    int64             `json:"-"`
	LeaseExpiresAt  int64             `json:"leaseExpiresAt"`
	TotalDurationMs int64             `json:"-"`
	BilledMs        int64             `json:"-"`
}

type ExecReceipt struct {
	VMID         string
	ExecID       string
	ResponseJSON []byte
	CreatedAt    int64
}

type HostRecord struct {
	HostID          string            `json:"hostId"`
	Address         string            `json:"address,omitempty"`
	CapacityVMs     int               `json:"capacityVms"`
	RunningVMs      int               `json:"runningVms"`
	Status          string            `json:"status"`
	Labels          map[string]string `json:"labels,omitempty"`
	LastHeartbeatAt int64             `json:"lastHeartbeatAt"`
}

type ObjectStore interface {
	PutObject(ctx context.Context, lineage string, kind ObjectKind, data []byte) (string, error)
	GetObject(ctx context.Context, hash string) (ObjectKind, []byte, error)
	HasObject(ctx context.Context, hash string) (bool, error)
	LinkObjects(ctx context.Context, lineage string, hashes []string) error
}

type RepoStore interface {
	CreateLineageIfAbsent(ctx context.Context, lin LineageRecord, initRef RefRecord) (LineageRecord, RefRecord, bool, error)
	GetLineage(ctx context.Context, lineage string) (*LineageRecord, error)
	DeleteLineage(ctx context.Context, lineage string) error

	GetRef(ctx context.Context, lineage, ref string, nowMs int64) (*RefRecord, error)
	ListRefs(ctx context.Context, lineage, prefix string, nowMs int64) ([]RefRecord, error)
	SetRef(ctx context.Context, p SetRefParams) (*RefRecord, error)
	LeaseRef(ctx context.Context, p LeaseRefParams) (*LeaseResult, error)
}

type VMStore interface {
	GetRunningVMByRef(ctx context.Context, lineage, ref string) (*VMRecord, error)
	ListRunningVMs(ctx context.Context) ([]*VMRecord, error)
	ListRunningVMsByLineage(ctx context.Context, lineage string) ([]*VMRecord, error)
	CreateRunningVM(ctx context.Context, vm *VMRecord) error
	GetVM(ctx context.Context, vmID string) (*VMRecord, error)
	UpdateVM(ctx context.Context, vm *VMRecord) error

	GetExecReceipt(ctx context.Context, vmID, execID string) (*ExecReceipt, error)
	PutExecReceipt(ctx context.Context, r *ExecReceipt) error

	UpsertHost(ctx context.Context, h *HostRecord) error
	GetHost(ctx context.Context, hostID string) (*HostRecord, error)
	ListHosts(ctx context.Context) ([]*HostRecord, error)
}

type Store interface {
	ObjectStore
	RepoStore
	VMStore
	Close() error
}

// HashObject computes the canonical Git-style SHA-256 content hash for (kind, data).
func HashObject(kind ObjectKind, data []byte) string {
	h := sha256.New()
	h.Write([]byte(kind))
	h.Write([]byte(" "))
	h.Write([]byte(strconv.Itoa(len(data))))
	h.Write([]byte{0})
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// PackObject compresses "<kind>\x00<data>" with zlib.
func PackObject(kind ObjectKind, data []byte) ([]byte, error) {
	var buf bytes.Buffer
	zw := zlib.NewWriter(&buf)
	if _, err := zw.Write([]byte(kind)); err != nil {
		_ = zw.Close()
		return nil, err
	}
	if _, err := zw.Write([]byte{0}); err != nil {
		_ = zw.Close()
		return nil, err
	}
	if _, err := zw.Write(data); err != nil {
		_ = zw.Close()
		return nil, err
	}
	if err := zw.Close(); err != nil {
		return nil, err
	}
	return buf.Bytes(), nil
}

// UnpackObject decompresses a zlib-packed object into (kind, data).
func UnpackObject(compressed []byte) (ObjectKind, []byte, error) {
	zr, err := zlib.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return "", nil, fmt.Errorf("zlib open: %w", err)
	}
	defer zr.Close()
	raw, err := io.ReadAll(zr)
	if err != nil {
		return "", nil, fmt.Errorf("zlib read: %w", err)
	}
	idx := bytes.IndexByte(raw, 0)
	if idx <= 0 {
		return "", nil, fmt.Errorf("corrupt object header")
	}
	return ObjectKind(raw[:idx]), raw[idx+1:], nil
}

// RandomID generates "<prefix>_<24-hex-chars>".
func RandomID(prefix string) string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return prefix + "_" + hex.EncodeToString(b[:])
}
