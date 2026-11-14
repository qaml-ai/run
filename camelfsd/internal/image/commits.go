package image

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/store"

	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

type Trailers struct {
	Agent    string `json:"agent,omitempty"`
	Run      string `json:"run,omitempty"`
	Turn     string `json:"turn,omitempty"`
	Job      string `json:"job,omitempty"`
	Kind     string `json:"kind"`
	ExitCode *int   `json:"exitCode,omitempty"`
}
type CheckpointRequest struct {
	Time      *int64    `json:"-"`
	TimeoutMs int       `json:"timeoutMs"`
	Message   *string   `json:"message,omitempty"`
	Trailers  *Trailers `json:"trailers,omitempty"`
}

func (q CheckpointRequest) Validate() error {
	if q.TimeoutMs < 0 || q.TimeoutMs > 600000 {
		return apierr.Invalid("invalid timeoutMs")
	}
	if q.Message != nil && (!utf8.ValidString(*q.Message) || len(*q.Message) > 4096 || strings.ContainsRune(*q.Message, 0)) {
		return apierr.Invalid("invalid message")
	}
	if t := q.Trailers; t != nil {
		if t.Kind != "auto" && t.Kind != "manual" && t.Kind != "job" {
			return apierr.Invalid("invalid trailer kind")
		}
		re := regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
		for _, s := range []string{t.Agent, t.Run, t.Turn, t.Job} {
			if s != "" && !re.MatchString(s) {
				return apierr.Invalid("invalid trailer")
			}
		}
	}
	return nil
}
func (m *Manager) writeCommit(ctx context.Context, v *Mount, tree string, q CheckpointRequest) (string, error) {
	who := "job:" + v.JobID
	msg := "checkpoint"
	if q.Message != nil {
		msg = *q.Message
	}
	var trailers strings.Builder
	if t := q.Trailers; t != nil {
		if t.Agent != "" {
			who = "agent:" + t.Agent
		} else if t.Job != "" {
			who = "job:" + t.Job
		}
		for _, p := range [][2]string{{"Camel-Agent", t.Agent}, {"Camel-Run", t.Run}, {"Camel-Turn", t.Turn}, {"Camel-Job", t.Job}, {"Camel-Checkpoint", t.Kind}} {
			if p[1] != "" {
				fmt.Fprintf(&trailers, "%s: %s\n", p[0], p[1])
			}
		}
		if t.ExitCode != nil {
			fmt.Fprintf(&trailers, "Camel-Exit: %d\n", *t.ExitCode)
		}
		// Camel-Op names why a commit exists in the repo log (#993). The kind is validated above, so
		// every checkpoint with trailers has exactly one op: a job's, or an agent turn's (auto or manual).
		if op := map[string]string{"job": "job", "auto": "turn", "manual": "turn"}[t.Kind]; op != "" {
			fmt.Fprintf(&trailers, "Camel-Op: %s\n", op)
		}
	}
	body := "tree " + tree + "\n"
	if v.Parent.Commit != "" {
		body += "parent " + v.Parent.Commit + "\n"
	}
	now := time.Now().Unix()
	if q.Time != nil {
		now = time.UnixMilli(*q.Time).Unix()
	}
	body += fmt.Sprintf("author %s <%s@camelfs> %d +0000\ncommitter camelfs <camelfs@camelfs> %d +0000\n\n%s\n\n%s", who, who, now, now, msg, trailers.String())
	return m.objects(v.Lineage).PutObject(ctx, v.Lineage, "commit", []byte(body))
}
func (m *Manager) Commit(ctx context.Context, id string, lineages ...string) (map[string]any, error) {
	if len(lineages) != 1 || !store.Lineage(lineages[0]) {
		return nil, apierr.Invalid("lineage required")
	}
	b, e := m.objects(lineages...).Object(ctx, id, "commit")
	if e != nil {
		return nil, e
	}
	headers, body, _ := strings.Cut(string(b), "\n\n")
	out := map[string]any{"commit": id}
	parents := []string{}
	for _, line := range strings.Split(headers, "\n") {
		k, v, _ := strings.Cut(line, " ")
		if k == "parent" {
			parents = append(parents, v)
		} else {
			out[k] = v
		}
	}
	out["parents"] = parents
	msg, tr := body, ""
	if split := strings.LastIndex(body, "\n\n"); split >= 0 {
		msg = body[:split]
		tr = body[split+2:]
	}
	out["message"] = msg
	trailers := map[string]string{}
	for _, line := range strings.Split(strings.TrimSuffix(tr, "\n"), "\n") {
		k, v, ok := strings.Cut(line, ": ")
		if ok {
			trailers[k] = v
		}
	}
	out["trailers"] = trailers
	return out, nil
}

func (t *Trailers) UnmarshalJSON(b []byte) error {
	type plain Trailers
	var v plain
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if e := d.Decode(&v); e != nil {
		return e
	}
	var fields map[string]json.RawMessage
	if e := json.Unmarshal(b, &fields); e != nil {
		return e
	}
	for k, raw := range fields {
		if k == "exitCode" {
			if string(raw) == "null" {
				return apierr.Invalid("invalid exitCode")
			}
			continue
		}
		var value string
		if e := json.Unmarshal(raw, &value); e != nil || value == "" {
			return apierr.Invalid("invalid trailer %s", k)
		}
	}
	*t = Trailers(v)
	return nil
}

func (q *CheckpointRequest) UnmarshalJSON(b []byte) error {
	type plain CheckpointRequest
	var v plain
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if e := d.Decode(&v); e != nil {
		return e
	}
	var fields map[string]json.RawMessage
	if e := json.Unmarshal(b, &fields); e != nil {
		return e
	}
	for k, raw := range fields {
		if string(raw) == "null" {
			return apierr.Invalid("invalid null %s", k)
		}
	}
	*q = CheckpointRequest(v)
	return nil
}
