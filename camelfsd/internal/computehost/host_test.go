package computehost

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/vmhost"
)

func TestHeartbeatEpochAndEndedRetry(t *testing.T) {
	cfg := Config{Data: t.TempDir(), BootID: "boot-a", HostID: "host", Slots: 1}
	var registers, ends int
	var nextEpoch int64 = 17
	var replyEpoch int64 = 16
	var stale bool
	var inflight atomic.Int32
	vm := hostwire.BootSpec{ID: "vm", Lease: hostwire.Lease{Holder: hostwire.Holder{Host: "host", Boot: 17, Mount: "vm"}, Epoch: 2}}
	cfg.Post = func(_ context.Context, path string, body, out any) error {
		switch path {
		case "/register":
			registers++
			if body.(hostwire.Register).BootID != cfg.BootID {
				t.Error("wrong boot ID")
			}
			out.(*hostwire.Registered).BootEpoch = nextEpoch
		case "/heartbeat":
			if inflight.Add(1) != 1 {
				t.Error("overlapping heartbeats")
			}
			defer inflight.Add(-1)
			q := body.(hostwire.Heartbeat)
			if q.BootEpoch != nextEpoch || len(q.Running) != 1 || !q.Running[0].Finished {
				t.Errorf("heartbeat: %+v", q)
			}
			if stale {
				stale = false
				return &tierError{Status: 409, Code: "stale_epoch"}
			}
			// A stale epoch reply carries a different VM (which must not boot).
			spec := vm
			if replyEpoch != nextEpoch {
				spec.ID = "new"
				spec.Lease.Holder.Mount = "new"
			}
			*out.(*hostwire.HeartbeatReply) = hostwire.HeartbeatReply{BootEpoch: replyEpoch, Boot: []hostwire.BootSpec{spec}}
		case "/vms/vm/ended":
			ends++
			if ends < 3 {
				return &tierError{Status: 503}
			}
		default:
			t.Errorf("unexpected callback: %s", path)
		}
		return nil
	}
	h, err := Open(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	s := new(session)
	if err := h.save(s, record{Spec: vm, Ended: &hostwire.Ended{BootEpoch: 17, At: 100, Code: "stopped"}}); err != nil {
		t.Fatal(err)
	}
	h.vms[vm.ID] = s
	if err := h.poll(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(h.vms) != 1 || h.vms[vm.ID] != s || ends != 1 {
		t.Fatal("stale reply changed the inventory")
	}
	replyEpoch = nextEpoch
	stale = true
	if err := h.poll(t.Context()); err != nil {
		t.Fatal(err)
	}
	if registers != 2 || ends != 1 {
		t.Fatalf("registers=%d ended=%d", registers, ends)
	}
	var wg sync.WaitGroup
	for range 2 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := h.poll(t.Context()); err != nil {
				t.Error(err)
			}
		}()
	}
	wg.Wait()
	if ends != 3 || len(h.vms) != 0 {
		t.Fatal("finished VM was not retained until ack")
	}
	h.Close()

	h, err = Open(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	if h.epoch != 17 {
		t.Fatalf("same-boot persisted epoch = %d", h.epoch)
	}
	h.Close()
	cfg.BootID = "boot-b"
	nextEpoch = 41
	h, err = Open(t.Context(), cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if h.epoch != 0 {
		t.Fatalf("reboot reused epoch %d", h.epoch)
	}
	if err := h.Recover(t.Context()); err != nil {
		t.Fatal(err)
	}
	if h.epoch != 41 {
		t.Fatalf("did not use tier epoch: %d", h.epoch)
	}
}

func TestBadImageEndsStartFailed(t *testing.T) {
	zstd, err := exec.LookPath("zstd")
	if err != nil {
		t.Skip("zstd is required for guest image decompression")
	}
	disk := []byte("a compressed disk")
	cmd := exec.Command(zstd, "-q", "-c")
	cmd.Stdin = bytes.NewReader(disk)
	zip, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"compressed", "ext4", "short", "long", "missing size"} {
		t.Run(bad, func(t *testing.T) {
			sha, zsha := fmt.Sprintf("%x", sha256.Sum256(disk)), fmt.Sprintf("%x", sha256.Sum256(zip))
			switch bad {
			case "compressed":
				zsha = strings.Repeat("1", 64)
			case "ext4":
				sha = strings.Repeat("2", 64)
			}
			data, source := t.TempDir(), t.TempDir()
			must := func(err error) {
				t.Helper()
				if err != nil {
					t.Fatal(err)
				}
			}
			must(os.Mkdir(filepath.Join(source, "guest"), 0700))
			must(os.Mkdir(filepath.Join(data, "images"), 0700))
			base := filepath.Join(source, "guest", sha)
			size := len(zip)
			switch bad {
			case "short":
				size++
			case "long":
				size--
			}
			meta := map[string]any{"sha256": sha, "zstdSha256": zsha, "bytes": len(disk)}
			if bad != "missing size" {
				meta["zstdBytes"] = size
			}
			manifest, err := json.Marshal(meta)
			must(err)
			must(os.WriteFile(base+".json", manifest, 0600))
			must(os.WriteFile(base+".ext4.zst", zip, 0600))
			shape := hostwire.Shape{VCPUs: 1, MemoryMiB: 128, DiskMiB: 1}
			h, err := Open(t.Context(), Config{Data: data, HostID: "host", Slots: 1, Shape: shape, Images: store.Local{Dir: source}, Mounts: &image.Manager{}, Launcher: &vmhost.Launcher{Work: data}})
			must(err)
			defer h.Close()
			h.epoch, h.registered = 1, true
			spec := hostwire.BootSpec{ID: "vm", Image: sha, Shape: shape, Session: &hostwire.Session{}, Lease: hostwire.Lease{Holder: hostwire.Holder{Host: "host", Boot: 1, Mount: "vm"}, Epoch: 1}}
			raw, err := json.Marshal(spec)
			must(err)
			w := httptest.NewRecorder()
			h.Handler().ServeHTTP(w, httptest.NewRequest("POST", "/v1/vms", bytes.NewReader(raw)))
			if w.Code != 202 {
				t.Fatalf("boot dispatch HTTP %d: %s", w.Code, w.Body)
			}
			h.work.Wait()
			ended := h.vms["vm"].row.Ended
			if ended == nil || ended.Code != "start_failed" || len(h.images.list()) != 0 {
				t.Fatalf("bad image was retained: %+v", ended)
			}
		})
	}
}
