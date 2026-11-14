package api

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/auth"
	"github.com/qaml-ai/run/camelfsd/internal/compute"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
)

var hostUnreachable = &storageError{502, "host_unreachable", nil}

func (v *vmAPI) sessionHost(r *http.Request, claims auth.Claims, write, runtimeOnly bool) (compute.VM, compute.Host, error) {
	if write && claims.Access != "w" || runtimeOnly && !runtimeSubject(claims) {
		return compute.VM{}, compute.Host{}, vmForbidden
	}
	vm, err := v.read(r, claims, false)
	if err != nil {
		return vm, compute.Host{}, err
	}
	if !vmRefAllowed(claims, vm.Lineage, vm.Ref) {
		return vm, compute.Host{}, vmForbidden
	}
	host, err := v.controller.RunningHost(r.Context(), vm)
	return vm, host, err
}

func vmHostPath(vm compute.VM, suffix string) string {
	return "/v1/vms/" + url.PathEscape(vm.ID) + suffix
}

func relayHostResponse(w http.ResponseWriter, resp *http.Response) {
	if contentType := resp.Header.Get("Content-Type"); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func (v *vmAPI) shell(w http.ResponseWriter, r *http.Request, claims auth.Claims) error {
	vm, host, err := v.sessionHost(r, claims, true, true)
	if err != nil {
		return err
	}
	var q hostwire.ShellRequest
	if keys := r.Header.Values("Idempotency-Key"); len(keys) != 0 {
		if len(keys) != 1 || !hostwire.MountID.MatchString(keys[0]) {
			return invalid("Idempotency-Key: must be a single value matching %s", hostwire.MountID)
		}
		q.ShellKey = keys[0]
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := v.controller.Touch(ctx, vm.ID, v.controller.Time()); err != nil {
		return err
	}
	resp, err := v.host.request(ctx, host, http.MethodPost, vmHostPath(vm, "/shells"), q)
	if err != nil {
		return hostUnreachable
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		relayHostResponse(w, resp)
		return nil
	}
	var shell hostwire.ShellCreated
	if err := json.NewDecoder(resp.Body).Decode(&shell); err != nil || shell.ShellID == "" {
		return hostUnreachable
	}
	jsonReply(w, resp.StatusCode, map[string]string{"shell": shell.ShellID})
	return nil
}

func (v *vmAPI) exec(w http.ResponseWriter, r *http.Request, claims auth.Claims) error {
	vm, host, err := v.sessionHost(r, claims, true, false)
	if err != nil {
		return err
	}
	var q hostwire.ExecRequest
	r.Body = http.MaxBytesReader(w, r.Body, 64<<20)
	if err := decodeStorage(r, &q); err != nil {
		return err
	}
	if !hostwire.MountID.MatchString(q.ExecID) {
		return invalid("execId: required, must match %s", hostwire.MountID)
	}
	if q.TimeoutS < 1 || q.TimeoutS > 600 {
		return invalid("timeoutS: must be between 1 and 600")
	}

	// Once admitted, the stream belongs to this exec even if the HTTP client leaves.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), time.Duration(q.TimeoutS+30)*time.Second)
	defer cancel()
	started, err := v.controller.TrackExecStart(ctx, vm.ID, q.ExecID, v.controller.Time())
	if err != nil {
		return err
	}
	end := func() { v.endExec(ctx, vm.ID, q.ExecID) }
	resp, err := v.host.request(ctx, host, http.MethodPost, vmHostPath(vm, "/exec"), q)
	if err != nil {
		if started {
			end()
		}
		return hostUnreachable
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		if started {
			end()
		}
		relayHostResponse(w, resp)
		return nil
	}
	if !isEventStream(resp) {
		if started {
			end()
		}
		return hostUnreachable
	}
	return streamHostEvents(w, r, resp, end, ctx)
}

func (v *vmAPI) endExec(ctx context.Context, vmID, execID string) {
	// Persist the exit even when it arrives as the host deadline elapses.
	save, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	if err := v.controller.ExecEnded(save, vmID, execID, v.controller.Time()); err != nil {
		slog.Error("vm_exec_end_failed", "vm", vmID, "error", err)
	}
}

func (v *vmAPI) execTail(w http.ResponseWriter, r *http.Request, claims auth.Claims) error {
	vm, host, err := v.sessionHost(r, claims, false, false)
	if err != nil {
		return err
	}
	id := r.PathValue("execId")
	if !hostwire.MountID.MatchString(id) {
		return invalid("execId: must match %s", hostwire.MountID)
	}
	segment := url.PathEscape(id)
	if id == "." || id == ".." {
		// Keep these valid mount-alphabet IDs from being cleaned as path segments.
		segment = strings.ReplaceAll(id, ".", "%2E")
	}
	suffix := "/exec/" + segment
	if offset := r.URL.Query().Get("offset"); offset != "" {
		n, err := strconv.ParseInt(offset, 10, 64)
		if err != nil || n < 0 {
			return invalid("offset: must be a non-negative integer")
		}
		suffix += "?offset=" + strconv.FormatInt(n, 10)
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	if err := v.controller.Touch(ctx, vm.ID, v.controller.Time()); err != nil {
		return err
	}
	resp, err := v.host.request(ctx, host, http.MethodGet, vmHostPath(vm, suffix), nil)
	if err != nil {
		return hostUnreachable
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 == 2 && isEventStream(resp) {
		return streamHostEvents(w, r, resp, func() { v.endExec(ctx, vm.ID, id) }, ctx)
	}
	relayHostResponse(w, resp)
	return nil
}

func (v *vmAPI) checkpoint(w http.ResponseWriter, r *http.Request, claims auth.Claims) error {
	vm, host, err := v.sessionHost(r, claims, true, false)
	if err != nil {
		return err
	}
	var q hostwire.CheckpointRequest
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := decodeStorage(r, &q); err != nil {
		return err
	}

	// The CAS may already have happened when the client disconnects. Finish
	// recording it under the same marker before allowing another checkpoint.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), compute.CheckpointWindow)
	defer cancel()
	owner, err := v.controller.BeginCheckpoint(ctx, vm.ID)
	if err != nil {
		return err
	}
	finished := false
	defer func() {
		if !finished {
			save, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			if err := v.controller.FinishCheckpoint(save, vm.ID, owner, nil); err != nil {
				slog.Error("vm_checkpoint_unlock_failed", "vm", vm.ID, "error", err)
			}
		}
	}()
	resp, err := v.host.request(ctx, host, http.MethodPost, vmHostPath(vm, "/checkpoint"), q)
	if err != nil {
		return hostUnreachable
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		relayHostResponse(w, resp)
		return nil
	}
	var result hostwire.CheckpointReply
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil || result.Version == "" || result.Tree == "" || result.Diff == nil {
		return hostUnreachable
	}
	save, stop := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer stop()
	now := v.controller.Time()
	var saved *compute.Checkpoint
	if result.Changed {
		saved = &compute.Checkpoint{Version: result.Version, Tree: result.Tree, At: now.UnixMilli()}
	}
	touchErr := v.controller.Touch(save, vm.ID, now)
	if err := v.controller.FinishCheckpoint(save, vm.ID, owner, saved); err != nil {
		return err
	}
	finished = true
	if touchErr != nil && !errors.Is(touchErr, compute.ErrPhase) {
		return touchErr
	}
	jsonReply(w, resp.StatusCode, result)
	return nil
}

func isEventStream(resp *http.Response) bool {
	media, _, _ := mime.ParseMediaType(resp.Header.Get("Content-Type"))
	return media == "text/event-stream"
}

// streamHostEvents preserves all wire bytes. A broken downstream becomes a
// drain so the terminal event can still settle activity.
func streamHostEvents(w http.ResponseWriter, r *http.Request, resp *http.Response, onExit func(), ctx context.Context) error {
	control := http.NewResponseController(w)
	if !supportsFlush(w) {
		return errors.New("streaming response writer required")
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = control.SetWriteDeadline(deadline)
	}
	w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
	w.Header().Set("Cache-Control", "no-cache")
	w.WriteHeader(resp.StatusCode)
	copyHostEvents(resp.Body, func(frame []byte) {
		if r.Context().Err() != nil || w == nil {
			return
		}
		if _, err := w.Write(frame); err != nil {
			w = nil
		} else if err := control.Flush(); err != nil {
			w = nil
		}
	}, onExit)
	return nil
}

func supportsFlush(w http.ResponseWriter) bool {
	for {
		switch writer := w.(type) {
		case interface{ FlushError() error }, http.Flusher:
			return true
		case interface{ Unwrap() http.ResponseWriter }:
			w = writer.Unwrap()
		default:
			return false
		}
	}
}

func copyHostEvents(body io.Reader, forward func([]byte), onExit func()) {
	reader := bufio.NewReader(body)
	var frame []byte
	event := ""
	exited := false
	for {
		line, err := reader.ReadString('\n')
		frame = append(frame, line...)
		field := strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r")
		switch {
		case field == "" && line != "":
			if event == "exit" && !exited {
				onExit()
				exited = true
			}
			forward(frame)
			frame, event = frame[:0], ""
		case strings.HasPrefix(field, "event:"):
			event = strings.TrimPrefix(strings.TrimPrefix(field, "event:"), " ")
		}
		if err != nil {
			if len(frame) > 0 {
				forward(frame)
			}
			// Headers are already sent. The client sees a missing exit and
			// can reattach using the retained tail.
			return
		}
	}
}
