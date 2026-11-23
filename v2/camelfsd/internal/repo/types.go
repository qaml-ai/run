package repo

import (
	"bytes"
	"context"
	"path"
	"strings"
	"unicode/utf8"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/store"
)

const (
	DefaultRef      = "refs/heads/main"
	DefaultFileMode = 420 // 0644
	ExecFileMode    = 493 // 0755
)

type TreeEntry struct {
	Path string `json:"path"`
	Type string `json:"type"`
	Size int64  `json:"size"`
	Mode int    `json:"mode"`
	Hash string `json:"hash,omitempty"`
}

type CommitObject struct {
	Tree      string   `json:"tree,omitempty"`
	Parents   []string `json:"parents"`
	Author    string   `json:"author"`
	Message   string   `json:"message"`
	CreatedAt int64    `json:"createdAt"`
}

type HistoryCommit struct {
	Commit    string   `json:"commit"`
	Tree      string   `json:"tree,omitempty"`
	Parents   []string `json:"parents"`
	Author    string   `json:"author"`
	Message   string   `json:"message"`
	CreatedAt int64    `json:"createdAt"`
}

type CreateLineageRequest struct {
	Lineage  string `json:"lineage,omitempty"`
	TenantID string `json:"tenantId,omitempty"`
}

type CreateLineageResponse struct {
	Lineage    string `json:"lineage"`
	DefaultRef string `json:"defaultRef"`
	Commit     string `json:"commit"`
	Tree       string `json:"tree,omitempty"`
}

type ForkRequest struct {
	TargetLineage string `json:"targetLineage,omitempty"`
	SourceRef     string `json:"sourceRef,omitempty"`
	TargetRef     string `json:"targetRef,omitempty"`
	AtCommit      string `json:"atCommit,omitempty"`
}

type ForkResponse struct {
	Lineage string `json:"lineage"`
	Ref     string `json:"ref"`
	Commit  string `json:"commit"`
	Tree    string `json:"tree,omitempty"`
}

type SetRefRequest struct {
	Ref            string `json:"ref"`
	Commit         string `json:"commit"`
	ExpectedCommit string `json:"expectedCommit,omitempty"`
	Holder         string `json:"holder,omitempty"`
	Delete         bool   `json:"delete,omitempty"`
}

type SetRefResponse struct {
	Ref    string `json:"ref"`
	Commit string `json:"commit"`
	Tree   string `json:"tree,omitempty"`
}

type LeaseRequest struct {
	Ref     string `json:"ref"`
	Holder  string `json:"holder"`
	TTLMs   int64  `json:"ttlMs"`
	Release bool   `json:"release,omitempty"`
}

type WritePut struct {
	Path    string `json:"path"`
	Content string `json:"content,omitempty"`
	Base64  string `json:"base64,omitempty"`
	Mode    int    `json:"mode,omitempty"`
}

type WriteMove struct {
	From string `json:"from"`
	To   string `json:"to"`
}

type WriteRequest struct {
	Ref            string      `json:"ref"`
	ExpectedCommit string      `json:"expectedCommit,omitempty"`
	Holder         string      `json:"holder,omitempty"`
	Author         string      `json:"author,omitempty"`
	Message        string      `json:"message,omitempty"`
	Puts           []WritePut  `json:"puts,omitempty"`
	Deletes        []string    `json:"deletes,omitempty"`
	Moves          []WriteMove `json:"moves,omitempty"`
}

type WriteResponse struct {
	Commit     string   `json:"commit"`
	Tree       string   `json:"tree,omitempty"`
	Changed    []string `json:"changed"`
	TotalBytes int64    `json:"totalBytes"`
}

type ReadParams struct {
	At     string
	Path   string
	Offset int64
	Limit  int64
}

type ReadResponse struct {
	Commit  string  `json:"commit"`
	Path    string  `json:"path"`
	Size    int64   `json:"size"`
	Mode    int     `json:"mode"`
	Binary  bool    `json:"binary"`
	Content *string `json:"content"`
	Base64  *string `json:"base64"`
}

type ListParams struct {
	At        string
	Path      string
	Recursive bool
	Glob      string
}

type ListResponse struct {
	Commit  string      `json:"commit"`
	Entries []TreeEntry `json:"entries"`
}

type GrepRequest struct {
	At         string `json:"at"`
	Pattern    string `json:"pattern"`
	PathPrefix string `json:"pathPrefix,omitempty"`
	MaxMatches int    `json:"maxMatches,omitempty"`
}

type GrepMatch struct {
	Path   string `json:"path"`
	Line   int    `json:"line"`
	Column int    `json:"column"`
	Text   string `json:"text"`
}

type GrepResponse struct {
	Commit  string      `json:"commit"`
	Matches []GrepMatch `json:"matches"`
}

type HistoryResponse struct {
	Commits []HistoryCommit `json:"commits"`
}

type RestoreRequest struct {
	Ref            string `json:"ref"`
	TargetCommit   string `json:"targetCommit"`
	ExpectedCommit string `json:"expectedCommit,omitempty"`
	Holder         string `json:"holder,omitempty"`
	Author         string `json:"author,omitempty"`
	Message        string `json:"message,omitempty"`
}

type RestoreResponse struct {
	Commit string `json:"commit"`
	Tree   string `json:"tree,omitempty"`
}

// WorkspaceFileOp represents a direct file mutation to apply to a live VM's /workspace.
type WorkspaceFileOp struct {
	Kind string // "put" | "delete" | "move"
	Path string
	From string
	Data []byte
	Mode int
}

type MaterializedFile struct {
	Path string
	Mode int
	Data []byte
}

type WorkspaceCommitResult struct {
	Changed      bool     `json:"changed"`
	Commit       string   `json:"commit"`
	Tree         string   `json:"tree,omitempty"`
	FilesChanged []string `json:"filesChanged"`
}

// ActiveVMSession synchronizes repo mutations with an active running VM held by the same holder.
type ActiveVMSession interface {
	ApplyOps(ctx context.Context, ops []WorkspaceFileOp) error
	UpdateHead(ctx context.Context, newHeadCommit string) error
	StopForRestore(ctx context.Context) error
}

// LiveVMReader reads directly from an active running VM on (lineage, ref).
type LiveVMReader interface {
	HeadCommit() string
	ReadFile(ctx context.Context, path string, offset, limit int64) (*ReadResponse, error)
	ListEntries(ctx context.Context, dirPrefix string, recursive bool, glob string) ([]TreeEntry, error)
	Grep(ctx context.Context, req GrepRequest) ([]GrepMatch, error)
}

// VMCoordinator coordinates ref reads, writes, and lineage deletions with active VM sessions.
type VMCoordinator interface {
	WithRefWriteLock(ctx context.Context, lineage, ref, holder string, fn func(vmSession ActiveVMSession) error) error
	WithRefReadVM(ctx context.Context, lineage, ref string, fn func(reader LiveVMReader) error) (handled bool, err error)
	StopLineageVMs(ctx context.Context, lineage string) error
}

// NormalizeRelPath validates and normalizes a repository-relative path.
func NormalizeRelPath(raw string, allowEmpty bool) (string, error) {
	if strings.IndexByte(raw, 0) >= 0 {
		return "", apperr.InvalidRequest("path must not contain NUL bytes")
	}
	s := strings.ReplaceAll(strings.TrimSpace(raw), "\\", "/")
	if s == "/workspace" {
		s = ""
	} else if strings.HasPrefix(s, "/workspace/") {
		s = strings.TrimPrefix(s, "/workspace/")
	}
	s = strings.TrimPrefix(s, "/")
	s = strings.TrimSuffix(s, "/")
	if s == "" || s == "." {
		if allowEmpty {
			return "", nil
		}
		return "", apperr.InvalidRequest("file path must not be empty")
	}
	cleaned := path.Clean(s)
	if cleaned == "." || cleaned == "/" {
		if allowEmpty {
			return "", nil
		}
		return "", apperr.InvalidRequest("file path must not be empty")
	}
	if cleaned == ".." || strings.HasPrefix(cleaned, "../") || strings.Contains(cleaned, "/../") {
		return "", apperr.InvalidRequestf("path traversal is not allowed: %q", raw)
	}
	return cleaned, nil
}

// IsBinary reports whether data looks like binary content rather than valid UTF-8 text.
func IsBinary(data []byte) bool {
	if len(data) == 0 {
		return false
	}
	check := data
	if len(check) > 8192 {
		check = check[:8192]
	}
	if bytes.IndexByte(check, 0) >= 0 {
		return true
	}
	return !utf8.Valid(data)
}

var _ = store.KindBlob
