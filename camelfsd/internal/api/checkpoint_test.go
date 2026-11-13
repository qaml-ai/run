package api

import (
	"bytes"
	"context"
	"encoding/json"
	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/testguest"
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
	"io"
	"net"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCheckpointMetadataBeforeArm(t *testing.T) {
	s := &Server{}
	bad := []string{`{"message":"\u0000"}`, `{"message":"` + strings.Repeat("x", 4097) + `"}`, `{"message":"` + string([]byte{0xff}) + `"}`, `{"trailers":{}}`, `{"trailers":{"kind":"other"}}`, `{"trailers":{"kind":"auto","agent":""}}`, `{"trailers":{"kind":"auto","agent":"a b"}}`, `{"trailers":{"kind":"auto","agent":"` + strings.Repeat("x", 129) + `"}}`, `{"trailers":{"kind":"auto","exitCode":1.2}}`, `{"trailers":{"kind":"auto","exitCode":null}}`, `{"trailers":{"kind":"auto","unknown":"x"}}`, `{"timeoutMs":600001}`}
	for _, body := range bad {
		w := httptest.NewRecorder()
		s.ServeHTTP(w, httptest.NewRequest("POST", "/v0/mounts/j/checkpoint", strings.NewReader(body)))
		if w.Code != 400 {
			t.Fatalf("%s: %d %s", body, w.Code, w.Body.String())
		}
	}
}
func TestStreamErrorRoutes(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	for _, evil := range []string{"oversized-frame", "oversized-json", "size-more", "size-less", "dotdot", "git", "duplicate", "file-dir", "bad-mode", "long-link", "wrong-job", "wrong-base", "stall"} {
		t.Run(evil, func(t *testing.T) {
			d := t.TempDir()
			db, e := refs.Open(filepath.Join(d, "r.db"))
			if e != nil {
				t.Fatal(e)
			}
			defer db.Close()
			st := store.Local{Dir: t.TempDir()}
			m, e := image.New(image.Config{Data: d, Cold: "prehydrate", VirtualSize: 16 << 20}, st, cache.New(filepath.Join(d, "cache"), st, 64), db)
			if e != nil {
				t.Fatal(e)
			}
			defer m.Close()
			repo := objects.Repository{DB: db, Store: st}
			tr, e := repo.Import(context.Background(), objects.Request{Lineage: "l", Files: map[string]objects.File{}})
			if e != nil {
				t.Fatal(e)
			}
			v, e := m.Mount(context.Background(), image.Request{Fence: &refs.Fence{Holder: "runtime", Epoch: 1}, JobID: "j", Lineage: "l", Tree: tr.Tree, Vsock: filepath.Join(testutil.SocketDir(t), "v")})
			if e != nil {
				t.Fatal(e)
			}

			guest := make(chan struct{})
			go func() {
				defer close(guest)
				for {
					c, e := net.Dial("unix", v.Vsock+"_5200")
					if e != nil {
						return
					}
					c.SetDeadline(time.Now().Add(time.Second))
					var ready struct {
						Ready bool `json:"ready"`
					}
					if wire.JSON(c, &ready) == nil && ready.Ready { // Evil expects the ready frame: replay it through a local pipe.
						a, b := net.Pipe()
						go func() { wire.Send(b, map[string]bool{"ready": true}); io.Copy(c, b); b.Close() }()
						testguest.Evil(a, evil, "j", tr.Tree)
						a.Close()
						c.Close()
						return
					}
					c.Close()
					time.Sleep(time.Millisecond)
				}
			}()
			w := httptest.NewRecorder()
			(&Server{Manager: m}).ServeHTTP(w, httptest.NewRequest("POST", "/v0/mounts/j/checkpoint", bytes.NewBufferString(`{"timeoutMs":150}`)))
			want := 422
			if evil == "stall" {
				want = 504
			}
			if w.Code != want {
				t.Fatalf("%d %s", w.Code, w.Body.String())
			}
			var n int
			db.DB.QueryRow("SELECT count(*) FROM tree_roots").Scan(&n)
			if n != 0 {
				t.Fatal("partial mapping")
			}
		})
	}
}

func TestCheckpointTimingNesting(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	d := t.TempDir()
	db, e := refs.Open(filepath.Join(d, "r.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	st := store.Local{Dir: t.TempDir()}
	m, e := image.New(image.Config{Data: d, Cold: "prehydrate", VirtualSize: 16 << 20}, st, cache.New(filepath.Join(d, "cache"), st, 4), db)
	if e != nil {
		t.Fatal(e)
	}
	defer m.Close()
	tr, e := (&objects.Repository{DB: db, Store: st}).Import(context.Background(), objects.Request{Lineage: "l", Files: map[string]objects.File{}})
	if e != nil {
		t.Fatal(e)
	}
	v, e := m.Mount(context.Background(), image.Request{Fence: &refs.Fence{Holder: "runtime", Epoch: 1}, JobID: "j", Lineage: "l", Tree: tr.Tree, Vsock: filepath.Join(testutil.SocketDir(t), "v")})
	if e != nil {
		t.Fatal(e)
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		time.Sleep(30 * time.Millisecond)
		for {
			c, e := net.Dial("unix", v.Vsock+"_5200")
			if e != nil {
				return
			}
			var ready map[string]bool
			if wire.JSON(c, &ready) != nil || !ready["ready"] {
				c.Close()
				time.Sleep(time.Millisecond)
				continue
			}
			time.Sleep(20 * time.Millisecond)
			wire.Send(c, wire.Header{V: 1, Kind: "checkpoint", JobID: "j", BaseTree: tr.Tree, WalkMs: 7})
			wire.Send(c, wire.Op{End: true, FreezeMs: 9})
			var ack map[string]bool
			wire.JSON(c, &ack)
			c.Close()
			return
		}
	}()
	w := httptest.NewRecorder()
	(&Server{Manager: m}).ServeHTTP(w, httptest.NewRequest("POST", "/v0/mounts/j/checkpoint", strings.NewReader("{}")))
	<-done
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var out image.Checkpoint
	if e = json.Unmarshal(w.Body.Bytes(), &out); e != nil {
		t.Fatal(e)
	}
	if out.CheckpointMs != out.WallMs || out.WallMs < out.StreamMs+out.PublishMs || out.StreamMs < 20 || out.ImageMs > out.PublishMs || out.WalkMs != 7 || out.FreezeMs != 9 {
		t.Fatalf("%+v", out)
	}
}
