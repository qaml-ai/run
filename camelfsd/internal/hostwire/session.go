package hostwire

import (
	"bytes"
	"encoding/json"
	"errors"

	"github.com/qaml-ai/run/camelfsd/internal/root"
)

// ShellRequest is the optional body of POST /v1/vms/{id}/shells.
// The same shellKey on the same VM returns the same shellId and never opens a second shell; the key is recorded in the
// guest before the shell starts. The guest retains the last 64 keys per VM, including keys for exited shells.
// Without a key, the request opens a new shell.
type ShellRequest struct {
	ShellKey string `json:"shellKey,omitempty"`
}

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
	ExecID    string            `json:"execId"`
	Command   string            `json:"command"`
	Shell     string            `json:"shell,omitempty"`
	Cwd       string            `json:"cwd,omitempty"`
	TimeoutS  int64             `json:"timeoutS"`
	Env       map[string]string `json:"env,omitempty"`
	Stdin     *string           `json:"stdin,omitempty"`
	StdinBlob *ExecBlob         `json:"stdinBlob,omitempty"`
}

// UnmarshalJSON checks field presence so null cannot bypass stdinBlob
// validation or the exclusion between the two input fields.
func (q *ExecRequest) UnmarshalJSON(data []byte) error {
	type fields ExecRequest
	body := struct {
		*fields
		Stdin     json.RawMessage `json:"stdin"`
		StdinBlob json.RawMessage `json:"stdinBlob"`
	}{fields: (*fields)(q)}
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&body); err != nil {
		return err
	}
	if body.StdinBlob != nil {
		if body.Stdin != nil || bytes.Equal(body.StdinBlob, []byte("null")) {
			return errors.New("stdinBlob must be an object and cannot be combined with stdin")
		}
		d = json.NewDecoder(bytes.NewReader(body.StdinBlob))
		d.DisallowUnknownFields()
		return d.Decode(&q.StdinBlob)
	}
	if body.Stdin != nil {
		return json.Unmarshal(body.Stdin, &q.Stdin)
	}
	return nil
}

// ExecBlob names the uploaded stdin object and its expected content.
type ExecBlob struct {
	Blob   string `json:"blob"`
	Size   *int64 `json:"size"`
	SHA256 string `json:"sha256"`
}

func (b ExecBlob) Valid() bool {
	return root.Hex(b.Blob, 40) && b.Size != nil && *b.Size >= 0 && *b.Size <= 256<<20 && root.Hex(b.SHA256, 64)
}

// ExecInputPort is a guest-initiated stream, like the apply and checkpoint ports.
const ExecInputPort = 5202

// ExecChunk is the JSON data in a stdout or stderr SSE event.
type ExecChunk struct {
	Data   []byte `json:"data"`
	Offset int64  `json:"offset"`
}

// ExecExit is the JSON data in an exit SSE event.
// GET /v1/vms/{id}/exec/{execId}?offset=N returns the retained tail from N.
// Retention: last 8 execs per VM × 1 MiB each, plus exit records of the last 64
// (truncated: true when the tail is gone). Older than retained → 410 tail_truncated with
// details { firstOffset }; unknown → 404 exec_unknown. Every host error body is the §9.8 shape
// { error: { code, message, details? } }, relayed by the tier unchanged.
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
