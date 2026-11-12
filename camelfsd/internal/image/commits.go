package image

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
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
	TimeoutMs int       `json:"timeoutMs"`
	Message   *string   `json:"message,omitempty"`
	Trailers  *Trailers `json:"trailers,omitempty"`
}

func (q CheckpointRequest) Validate() error {
	if q.TimeoutMs < 0 || q.TimeoutMs > 600000 {
		return fmt.Errorf("invalid timeoutMs")
	}
	if q.Message != nil && (!utf8.ValidString(*q.Message) || len(*q.Message) > 4096 || strings.ContainsRune(*q.Message, 0)) {
		return fmt.Errorf("invalid message")
	}
	if t := q.Trailers; t != nil {
		if t.Kind != "auto" && t.Kind != "manual" && t.Kind != "job" {
			return fmt.Errorf("invalid trailer kind")
		}
		re := regexp.MustCompile(`^[A-Za-z0-9._:-]{1,128}$`)
		for _, s := range []string{t.Agent, t.Run, t.Turn, t.Job} {
			if s != "" && !re.MatchString(s) {
				return fmt.Errorf("invalid trailer")
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
	}
	body := "tree " + tree + "\n"
	if v.Parent.Commit != "" {
		body += "parent " + v.Parent.Commit + "\n"
	}
	now := time.Now().Unix()
	body += fmt.Sprintf("author %s <%s@camelfs> %d +0000\ncommitter camelfs <camelfs@camelfs> %d +0000\n\n%s\n\n%s", who, who, now, now, msg, trailers.String())
	id := store.GitHash("commit", []byte(body))
	_, e := m.objects().DB.DB.ExecContext(ctx, "INSERT OR IGNORE INTO objects VALUES(?,'commit',?,?,?)", id, []byte(body), len(body), time.Now().UnixMilli())
	return id, e
}
func (m *Manager) Commit(ctx context.Context, id string) (map[string]any, error) {
	var b []byte
	e := m.objects().DB.DB.QueryRowContext(ctx, "SELECT bytes FROM objects WHERE id=? AND kind='commit'", id).Scan(&b)
	if e != nil {
		return nil, e
	}
	if store.GitHash("commit", b) != id {
		return nil, fmt.Errorf("corrupt commit")
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
				return fmt.Errorf("invalid exitCode")
			}
			continue
		}
		var value string
		if e := json.Unmarshal(raw, &value); e != nil || value == "" {
			return fmt.Errorf("invalid trailer %s", k)
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
			return fmt.Errorf("invalid null %s", k)
		}
	}
	*q = CheckpointRequest(v)
	return nil
}
