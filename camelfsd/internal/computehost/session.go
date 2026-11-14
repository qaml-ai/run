package computehost

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/vmhost"
)

type guestRequester interface {
	Request(context.Context, any, vmhost.LogFunc, ...vmhost.EventFunc) (vmhost.Reply, error)
}

type httpError struct {
	status int
	code   string
}

func (e *httpError) Error() string { return e.code }

var invalidRequest = &httpError{400, "invalid_request"}

func conflict(code string) error { return &httpError{409, code} }

func jsonReply(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

type errorBody struct {
	Code    string          `json:"code"`
	Message string          `json:"message"`
	Details json.RawMessage `json:"details,omitempty"`
}

type errorEnvelope struct {
	Error errorBody `json:"error"`
}

func replyError(w http.ResponseWriter, status int, code, message string, details json.RawMessage) {
	if message == "" {
		message = strings.ReplaceAll(code, "_", " ")
	}
	jsonReply(w, status, errorEnvelope{Error: errorBody{Code: code, Message: message, Details: details}})
}

func report(w http.ResponseWriter, err error) {
	var host *httpError
	var tier *tierError
	switch {
	case errors.As(err, &host):
		replyError(w, host.status, host.code, "", nil)
	case errors.As(err, &tier) && tier.Code != "":
		var envelope errorEnvelope
		if json.Unmarshal(tier.Body, &envelope) == nil && envelope.Error.Code != "" && envelope.Error.Message != "" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(tier.Status)
			_, _ = w.Write(tier.Body)
			return
		}
		// Older tier handlers send a flat error and may attach fields such as current.
		var fields map[string]json.RawMessage
		_ = json.Unmarshal(tier.Body, &fields)
		delete(fields, "error")
		var details json.RawMessage
		if len(fields) > 0 {
			details, _ = json.Marshal(fields)
		}
		replyError(w, tier.Status, tier.Code, "", details)
	default:
		slog.Warn("compute_host_request_failed", "error", err)
		replyError(w, 502, "host_unavailable", "The host could not complete the request", nil)
	}
}

func decode(w http.ResponseWriter, r *http.Request, body any) error {
	d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16<<20))
	d.DisallowUnknownFields()
	if err := d.Decode(body); err != nil {
		return invalidRequest
	}
	var extra any
	if d.Decode(&extra) != io.EOF {
		return invalidRequest
	}
	return nil
}

func (h *Host) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/vms", h.bootRoute)
	mux.HandleFunc("POST /v1/vms/{id}/stop", h.stopRoute)
	mux.HandleFunc("POST /v1/vms/{id}/shells", h.shellRoute)
	mux.HandleFunc("POST /v1/vms/{id}/exec", h.execRoute)
	mux.HandleFunc("GET /v1/vms/{id}/exec/{execId}", h.execRoute)
	mux.HandleFunc("POST /v1/vms/{id}/checkpoint", h.checkpointRoute)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, pattern := mux.Handler(r)
		if pattern == "" {
			replyError(w, 404, "not_found", "No compute route matches this request", nil)
			return
		}
		mux.ServeHTTP(w, r)
	})
}

func (h *Host) bootRoute(w http.ResponseWriter, r *http.Request) {
	var spec hostwire.BootSpec
	if err := decode(w, r, &spec); err != nil {
		report(w, err)
		return
	}
	h.mu.Lock()
	err := h.bootLocked(spec)
	h.mu.Unlock()
	if err != nil {
		report(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (h *Host) stopRoute(w http.ResponseWriter, r *http.Request) {
	var q hostwire.Stop
	if err := decode(w, r, &q); err != nil {
		report(w, err)
		return
	}
	h.mu.Lock()
	var err error
	if s := h.vms[r.PathValue("id")]; s != nil {
		err = h.queueStopLocked(s, q.Checkpoint, endCode(s.row))
	}
	h.mu.Unlock()
	if err != nil {
		report(w, err)
		return
	}
	w.WriteHeader(http.StatusAccepted)
}

func (h *Host) shellRoute(w http.ResponseWriter, r *http.Request) {
	_, vm, err := h.lookup(r.PathValue("id"))
	if err != nil {
		report(w, err)
		return
	}
	reply, err := guestRequest(r.Context(), vm, map[string]string{"op": "shell_open"})
	if err != nil {
		report(w, err)
		return
	}
	id, _ := reply["shellId"].(string)
	jsonReply(w, 201, hostwire.ShellCreated{ShellID: id})
}

func (h *Host) execRoute(w http.ResponseWriter, r *http.Request) {
	var q hostwire.ExecRequest
	op := "exec"
	var offset int64
	tail := r.Method == http.MethodGet
	if tail {
		op, q.ExecID = "exec_tail", r.PathValue("execId")
		if raw := r.URL.Query().Get("offset"); raw != "" {
			n, err := strconv.ParseInt(raw, 10, 64)
			if err != nil || n < 0 {
				report(w, invalidRequest)
				return
			}
			offset = n
		}
	} else if err := decode(w, r, &q); err != nil {
		report(w, err)
		return
	}
	_, vm, err := h.lookup(r.PathValue("id"))
	if err != nil {
		report(w, err)
		return
	}
	input := struct {
		hostwire.ExecRequest
		Op     string `json:"op"`
		Offset int64  `json:"offset"`
	}{q, op, offset}
	events := make(chan vmhost.Reply, 64)
	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()
	// An HTTP writer may stall. The guest reader must remain free to handle
	// other sessions. A disconnected stream can resume at its last offset.
	reply, done, err := vm.Subscribe(ctx, input, func(event vmhost.Reply) {
		select {
		case events <- event:
		default:
			cancel()
		}
	})
	if err != nil {
		report(w, err)
		return
	}
	if reply["ok"] != true {
		code, _ := reply["code"].(string)
		status := 400
		switch code {
		case "exec_unknown", "shell_unknown":
			status = 404
		case "shell_busy", "exec_conflict":
			status = 409
		case "":
			status, code = 502, "guest_error"
		}
		report(w, &httpError{status, code})
		return
	}
	handle := func(e vmhost.Reply) bool {
		event := ""
		var data any
		switch e["event"] {
		case "exec_output":
			event, data = e["stream"].(string), map[string]any{"data": e["data"], "offset": e["offset"]}
		case "tail_truncated":
			event, data = "tail_truncated", map[string]any{"firstOffset": e["firstOffset"]}
		case "exec_exit":
			event, data = "exit", map[string]any{"code": e["code"], "timedOut": e["timedOut"], "ms": e["ms"], "truncated": e["truncated"]}
		}
		raw, err := json.Marshal(data)
		if err != nil {
			return false
		}
		rc := http.NewResponseController(w)
		_ = rc.SetWriteDeadline(time.Now().Add(10 * time.Second))
		_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, raw)
		if err == nil {
			err = rc.Flush()
		}
		return err == nil && event != "exit"
	}
	if tail {
		if first, ok := reply["firstOffset"].(float64); ok && first > float64(offset) {
			replyTruncatedTail(w, int64(first))
			return
		}
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(200)
	if err := http.NewResponseController(w).Flush(); err != nil {
		return
	}

	for {
		select {
		case e := <-events:
			if !handle(e) {
				return
			}
		case <-ctx.Done():
			return
		case <-done:
			for {
				select {
				case e := <-events:
					if !handle(e) {
						return
					}
				default:
					return
				}
			}
		}
	}
}

func replyTruncatedTail(w http.ResponseWriter, firstOffset int64) {
	details, _ := json.Marshal(map[string]int64{"firstOffset": firstOffset})
	replyError(w, http.StatusGone, "tail_truncated", "The requested offset precedes retained output", details)
}

type checkpointIntent struct {
	Commit string `json:"commit"`
	Expect string `json:"expect"`
	Tree   string `json:"tree"`
	Root   string `json:"root"`
}

func (h *Host) checkpointRoute(w http.ResponseWriter, r *http.Request) {
	var q hostwire.CheckpointRequest
	if err := decode(w, r, &q); err != nil {
		report(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(h.ctx, 150*time.Second)
	defer cancel()
	s, _, err := h.lookup(r.PathValue("id"))
	if err != nil {
		report(w, err)
		return
	}
	s.op.Lock()
	defer s.op.Unlock()
	current, vm, err := h.lookup(r.PathValue("id"))
	if err == nil && current != s {
		err = conflict("vm_not_running")
	}
	if err != nil {
		report(w, err)
		return
	}
	result, err := h.checkpoint(ctx, s, vm, q)
	if err != nil {
		report(w, err)
		return
	}
	jsonReply(w, 200, result)
}

func (h *Host) checkpoint(ctx context.Context, s *session, vm guestRequester, q hostwire.CheckpointRequest) (out hostwire.CheckpointReply, err error) {
	h.mu.Lock()
	r := s.row
	h.mu.Unlock()
	id := r.Spec.ID
	var freeze, walk, commit, cas float64
	defer func() {
		slog.Info("compute_checkpoint", "vm", id, "freeze", freeze, "walk", walk, "commit", commit, "cas", cas, "error", err)
	}()
	if r.Pending != nil {
		return h.recoverCheckpoint(ctx, s, vm, r)
	}
	trailers := image.Trailers{Kind: "auto"}
	if len(q.Trailers) != 0 && string(q.Trailers) != "null" {
		if err := json.Unmarshal(q.Trailers, &trailers); err != nil {
			return out, invalidRequest
		}
	}
	if trailers.Kind == "job" || trailers.Job != "" || trailers.ExitCode != nil {
		return out, invalidRequest
	}
	meta := image.CheckpointRequest{Message: &q.Message, Trailers: &trailers, Time: q.Time}
	if err := meta.Validate(); err != nil {
		return out, invalidRequest
	}
	type result struct {
		point image.Checkpoint
		err   error
	}
	resultCh := make(chan result, 1)
	streamCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		point, err := h.Mounts.SessionCheckpoint(streamCtx, id, meta, func(ctx context.Context, point image.Checkpoint) error {
			h.mu.Lock()
			current := s.row
			current.Pending = &checkpointIntent{point.Commit, r.Spec.Version, point.Tree, point.Root}
			err := h.save(s, current)
			if err == nil {
				r.Pending = current.Pending
			}
			h.mu.Unlock()
			if err != nil {
				return err
			}
			start := time.Now()
			out, err = h.cas(ctx, r, false)
			cas = ms(time.Since(start))
			return err
		})
		resultCh <- result{point, err}
	}()
	guest, guestErr := guestRequest(ctx, vm, map[string]any{"op": "camelfs_checkpoint", "jobId": id, "timeoutMs": 120000})
	if guestErr != nil || guest["changed"] == false {
		cancel()
	}
	stream := <-resultCh
	freeze, _ = guest["freezeMs"].(float64)
	walk, _ = guest["walkMs"].(float64)
	if stream.point.FreezeMs > 0 {
		freeze = stream.point.FreezeMs
	}
	if stream.point.WalkMs > 0 {
		walk = stream.point.WalkMs
	}
	commit = stream.point.CommitMs
	if guestErr == nil && guest["changed"] == false {
		return hostwire.CheckpointReply{Version: r.Spec.Version, Tree: r.Spec.Tree, Diff: json.RawMessage("[]")}, nil
	}
	if r.Pending == nil {
		// A stream can have reached the guest even when the control reply was lost.
		clear, stop := context.WithTimeout(h.ctx, 5*time.Second)
		_ = h.checkpointed(clear, vm, "", true)
		stop()
		return out, errors.Join(stream.err, guestErr)
	}
	if stream.err != nil {
		var tier *tierError
		if errors.As(stream.err, &tier) {
			// Clear the pending guest changes for an explicit refusal. Leave
			// the intent on ambiguous transport/server failures for recovery.
			if tier.Status >= 400 && tier.Status < 500 {
				if err := h.checkpointed(ctx, vm, "", true); err == nil {
					_ = h.saveCheckpoint(s, nil)
				}
			}
		}
		return out, stream.err
	}
	if err := h.checkpointed(ctx, vm, out.Tree, false); err != nil {
		return out, err
	}
	return out, h.saveCheckpoint(s, r.Pending)
}

func (h *Host) cas(ctx context.Context, r record, recovering bool) (out hostwire.CheckpointReply, err error) {
	q, p := r.Spec, r.Pending
	body := struct {
		Commit string          `json:"commit"`
		Expect string          `json:"expect"`
		Root   string          `json:"root"`
		Holder hostwire.Holder `json:"holder"`
		Epoch  int64           `json:"epoch"`
	}{p.Commit, p.Expect, p.Root, q.Lease.Holder, q.Lease.Epoch}
	path := "/lineages/" + url.PathEscape(q.Lineage) + "/refs/" + url.PathEscape(q.Ref) + "/cas"
	err = h.Post(ctx, path, body, &out)
	if err != nil && recovering {
		var reply *tierError
		if errors.As(err, &reply) && reply.Status == 412 && reply.Code == "stale" {
			var stale struct {
				Current string
				Error   struct{ Details struct{ Current string } }
			}
			if json.Unmarshal(reply.Body, &stale) == nil && (stale.Current == p.Commit || stale.Error.Details.Current == p.Commit) {
				return hostwire.CheckpointReply{Version: p.Commit, Tree: p.Tree, Diff: json.RawMessage("[]"), Changed: true}, nil
			}
		}
	}
	if err != nil {
		return out, err
	}
	if out.Version != p.Commit || out.Tree != p.Tree || out.Diff == nil {
		return out, errors.New("invalid host CAS reply")
	}
	out.Changed = true
	return out, nil
}

func (h *Host) recoverCheckpoint(ctx context.Context, s *session, vm guestRequester, r record) (hostwire.CheckpointReply, error) {
	out, err := h.cas(ctx, r, true)
	if err != nil {
		var tier *tierError
		if errors.As(err, &tier) && tier.Status >= 400 && tier.Status < 500 {
			if ack := h.checkpointed(ctx, vm, "", true); ack == nil {
				_ = h.saveCheckpoint(s, nil)
			}
		}
		return out, err
	}
	p := r.Pending
	if err := h.Mounts.AdoptCheckpoint(ctx, r.Spec.ID, p.Commit, p.Tree, p.Root); err != nil {
		return out, err
	}
	if err := h.checkpointed(ctx, vm, p.Tree, false); err != nil {
		return out, err
	}
	return out, h.saveCheckpoint(s, p)
}

func (h *Host) checkpointed(ctx context.Context, vm guestRequester, tree string, reject bool) error {
	q := map[string]any{"op": "camelfs_checkpointed", "tree": tree}
	if reject {
		q["error"] = "checkpoint refused"
	}
	_, err := guestRequest(ctx, vm, q)
	return err
}

func (h *Host) saveCheckpoint(s *session, p *checkpointIntent) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	r := s.row
	r.Pending = nil
	if p != nil {
		r.Spec.Version, r.Spec.Tree = p.Commit, p.Tree
	}
	return h.save(s, r)
}
