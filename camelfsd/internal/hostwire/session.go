package hostwire

import "encoding/json"

// ShellCreated is the response to POST /v1/vms/{id}/shells.
// A persistent bash in the guest (cwd/env/functions survive); shells die with the
// VM and survive a daemon restart. ONE exec at a time per shell: a second → 409 shell_busy.
type ShellCreated struct {
	ShellID string `json:"shellId"`
}

// ExecRequest is the body of POST /v1/vms/{id}/exec.
// Idempotent by execId, recorded in the guest BEFORE the command starts: a replay never re-runs
// (running → re-attach at the current tail; finished → retained tail then exit); the same execId
// with a different command/shell/env → 409 exec_conflict.
// Without shell it is a one-off bash -lc, may run concurrently.
type ExecRequest struct {
	ExecID   string            `json:"execId"`
	Command  string            `json:"command"`
	Shell    string            `json:"shell,omitempty"`
	Cwd      string            `json:"cwd,omitempty"`
	TimeoutS int64             `json:"timeoutS"`
	Env      map[string]string `json:"env,omitempty"`
	Stdin    *string           `json:"stdin,omitempty"`
}

// ExecChunk is the JSON data in a stdout or stderr SSE event.
type ExecChunk struct {
	Data   []byte `json:"data"`
	Offset int64  `json:"offset"`
}

// ExecExit is the JSON data in an exit SSE event.
// GET /v1/vms/{id}/exec/{execId}?offset=N returns the retained tail from N.
// Retention: last 8 execs per VM × 1 MiB each, plus exit records of the last 64
// (truncated: true when the tail is gone). Older than retained → 410 tail_truncated
// { firstOffset }; unknown → 404 exec_unknown.
type ExecExit struct {
	Code      int   `json:"code"`
	TimedOut  bool  `json:"timedOut"`
	MS        int64 `json:"ms"`
	Truncated bool  `json:"truncated,omitempty"`
}

// CheckpointRequest is the body of POST /v1/vms/{id}/checkpoint.
// Synchronous, answered only after the host's cas moved the ref (the host calls
// the tier's host cas route with the VM's lease); a cas failure relays the tier's
// code (stale/fenced/…) and nothing advances. Allowed while an exec runs.
type CheckpointRequest struct {
	Message  string          `json:"message"`
	Trailers json.RawMessage `json:"trailers"`
	Time     *int64          `json:"time"`
}

// CheckpointReply reports the host CAS result. Changed is false for a no-op.
type CheckpointReply struct {
	Version string          `json:"version"`
	Tree    string          `json:"tree"`
	Diff    json.RawMessage `json:"diff"`
	Changed bool            `json:"changed"`
}
