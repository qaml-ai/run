package computehost

import (
	"context"
	"errors"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
	"github.com/qaml-ai/run/camelfsd/internal/vmhost"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
)

type guestFunc func(context.Context, map[string]any) (vmhost.Reply, error)

func (f guestFunc) Request(ctx context.Context, q any, _ vmhost.LogFunc, _ ...vmhost.EventFunc) (vmhost.Reply, error) {
	return f(ctx, q.(map[string]any))
}

func TestSessionCheckpointNoChangeAndFenced(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	data := t.TempDir()
	s := store.Local{Dir: t.TempDir()}
	ref, err := refs.Open(filepath.Join(data, "refs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer ref.Close()
	m, err := image.New(image.Config{Data: data, VirtualSize: 16 << 20}, s, cache.New(filepath.Join(data, "cache"), s, 2), ref)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	objs := (&objects.Repository{DB: ref, Store: s, TempDir: data}).ForLineage("l")
	tree, err := objs.Import(t.Context(), objects.Request{Lineage: "l", Files: map[string]objects.File{}})
	if err != nil {
		t.Fatal(err)
	}
	version := strings.Repeat("a", 40)
	holder := hostwire.Holder{Host: "host", Boot: 1, Mount: "vm"}
	_, err = m.Mount(t.Context(), image.Request{JobID: "vm", Session: true, Lineage: "l", Tree: tree.Tree, Parent: version, Fence: &refs.Fence{Holder: holder.String(), Epoch: 3}})
	if err != nil {
		t.Fatal(err)
	}
	vsock := filepath.Join(testutil.SocketDir(t), "guest")
	if err := m.SessionStreams(t.Context(), "vm", vsock, os.Getuid(), true); err != nil {
		t.Fatal(err)
	}
	casCalls := 0
	refusal := &tierError{Status: 409, Code: "fenced", Body: []byte(`{"error":"fenced"}`)}
	h, err := Open(t.Context(), Config{Data: data, Mounts: m, Post: func(ctx context.Context, path string, q, out any) error {
		casCalls++
		if path != "/lineages/l/refs/fork%2Fvm/cas" {
			t.Errorf("CAS path %s", path)
		}
		return refusal
	}})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	session := &session{row: record{Spec: hostwire.BootSpec{ID: "vm", Lineage: "l", Ref: "fork/vm", Version: version, Tree: tree.Tree, Lease: hostwire.Lease{Holder: holder, Epoch: 3}}}}
	noChange := guestFunc(func(_ context.Context, q map[string]any) (vmhost.Reply, error) {
		if q["op"] != "camelfs_checkpoint" {
			t.Errorf("unexpected guest request: %v", q)
		}
		return vmhost.Reply{"ok": true, "changed": false}, nil
	})
	reply, err := h.checkpoint(t.Context(), session, noChange, hostwire.CheckpointRequest{})
	if err != nil || reply.Version != version || reply.Tree != tree.Tree || reply.Changed || string(reply.Diff) != "[]" || casCalls != 0 {
		t.Fatalf("unchanged: %+v, %v, CAS calls %d", reply, err, casCalls)
	}
	var commits int
	if err := ref.DB.QueryRow("SELECT count(*) FROM lineage_objects WHERE kind='commit'").Scan(&commits); err != nil || commits != 0 {
		t.Fatalf("unchanged wrote %d commits: %v", commits, err)
	}
	rejected := false
	changed := guestFunc(func(ctx context.Context, q map[string]any) (vmhost.Reply, error) {
		if q["op"] == "camelfs_checkpointed" {
			rejected = q["error"] != nil
			return vmhost.Reply{"ok": true}, nil
		}
		until := time.Now().Add(time.Second)
		for time.Now().Before(until) {
			c, err := net.Dial("unix", vsock+"_5200")
			if err != nil {
				return nil, err
			}
			c.SetDeadline(until)
			var ready struct{ Ready bool }
			if wire.JSON(c, &ready) == nil && ready.Ready {
				defer c.Close()
				frames := []any{
					map[string]any{"v": 1, "kind": "checkpoint", "jobId": "vm", "baseTree": tree.Tree},
					map[string]any{"path": "x", "op": "link", "target": "y"},
					map[string]any{"end": true, "files": 1, "bytes": 0},
				}
				for _, f := range frames {
					if err := wire.Send(c, f); err != nil {
						return nil, err
					}
				}
				var ack struct{ Ack bool }
				if err := wire.JSON(c, &ack); err != nil || !ack.Ack {
					return nil, errors.New("checkpoint stream refused")
				}
				return vmhost.Reply{"ok": true, "changed": true}, nil
			}
			c.Close()
			time.Sleep(time.Millisecond)
		}
		return nil, errors.New("checkpoint never armed")
	})
	_, err = h.checkpoint(t.Context(), session, changed, hostwire.CheckpointRequest{Message: "turn"})
	w := httptest.NewRecorder()
	report(w, err)
	if err != refusal || w.Code != 409 || w.Body.String() != string(refusal.Body) || !rejected || casCalls != 1 || session.row.Pending != nil || session.row.Spec.Version != version {
		t.Fatalf("CAS rejection: %v HTTP %d %s, rejected=%v calls=%d row=%+v", err, w.Code, w.Body, rejected, casCalls, session.row)
	}
	mount, err := m.Status(t.Context(), "vm")
	if err != nil || mount.Parent.Commit != version || mount.Tree != tree.Tree {
		t.Fatalf("mount advanced on refusal: %+v %v", mount, err)
	}
}
