//go:build linux && kvm

package vmhost

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/wire"
	"golang.org/x/sys/unix"
)

func kvmEnv(t *testing.T) {
	t.Helper()
	if os.Getenv("CAMELFSD_KVM") != "1" {
		t.Skip("set CAMELFSD_KVM=1 on the KVM lane")
	}
	if os.Geteuid() != 0 {
		t.Fatal("KVM tests require root")
	}
	if os.Getenv("GUEST_IMAGE") == "" {
		t.Fatal("set GUEST_IMAGE to the pinned guest image")
	}
}

func kvmLauncher(t *testing.T) (*Launcher, Shape) {
	t.Helper()
	kvmEnv(t)
	workParent := os.Getenv("CAMELFSD_KVM_WORK")
	if workParent == "" {
		workParent = filepath.Dir(os.Getenv("GUEST_IMAGE"))
	}
	work, err := os.MkdirTemp(workParent, "vmhost-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		// Keep logs and any failed cleanup record on the host for inspection.
		if !t.Failed() {
			os.RemoveAll(work)
		} else {
			t.Logf("VM files in %s", work)
		}
	})
	kernel := os.Getenv("GUEST_KERNEL")
	if kernel == "" {
		kernel = "/var/lib/camel/guest/vmlinux"
	}
	l := &Launcher{
		Firecracker: "/usr/local/bin/firecracker", Jailer: "/usr/local/bin/jailer",
		Kernel: kernel, Initrd: os.Getenv("GUEST_INITRD"),
		Image: os.Getenv("GUEST_IMAGE"), Work: work, PolicyDir: filepath.Join(work, "egress"),
		KVM: true, Reflink: "always",
	}
	st, err := os.Stat(l.Image)
	if err != nil {
		t.Fatal(err)
	}
	return l, Shape{1, 1024, max(8192, (st.Size()+mib-1)/mib)}
}

func kvmID(t *testing.T, l *Launcher, name string) string {
	t.Helper()
	id := filepath.Base(l.Work) + "-" + name
	t.Cleanup(func() {
		if err := l.Destroy(context.Background(), id); err != nil {
			t.Error(err)
		}
	})
	return id
}

func kvmBoot(t *testing.T, l *Launcher, name string, shape Shape) *VM {
	t.Helper()
	id := kvmID(t, l, name)
	vm, err := l.Boot(t.Context(), id, shape, Boot{})
	if err != nil {
		t.Fatal(err)
	}
	return vm
}

func kvmRequest(t *testing.T, c *channel, req map[string]any) Reply {
	t.Helper()
	ctx, cancel := context.WithTimeout(t.Context(), 45*time.Second)
	defer cancel()
	r, err := c.request(ctx, req, nil)
	if err != nil || r["ok"] != true {
		t.Fatalf("guest reply: %v, %v", r, err)
	}
	return r
}

func kvmRun(t *testing.T, c *channel, command string, pids int) (int, string) {
	t.Helper()
	r := kvmRequest(t, c, map[string]any{"op": "run", "command": command, "timeoutSeconds": 30, "pids": pids})
	code, ok := r["exitCode"].(float64)
	if !ok || r["timedOut"] == true {
		t.Fatalf("guest command did not exit: %v", r)
	}
	var combined strings.Builder
	for _, key := range []string{"stdout", "stderr"} {
		stream, ok := r[key].(map[string]any)
		if !ok {
			t.Fatalf("missing %s: %v", key, r)
		}
		data, _ := stream["data"].(string)
		text, err := base64.StdEncoding.DecodeString(data)
		if err != nil {
			t.Fatal(err)
		}
		combined.Write(text)
	}
	return int(code), combined.String()
}

func checkClean(t *testing.T, l *Launcher, r VMRecord) {
	t.Helper()
	if _, err := tapIndex(r.Tap); !errors.Is(err, unix.ENODEV) {
		t.Errorf("tap %s remains: %v", r.Tap, err)
	}
	addr, _ := JobAddress(r.Slot)
	for _, path := range []string{r.Jail, l.recordPath(r.ID), filepath.Join(l.PolicyDir, addr.GuestIP.String()+".json")} {
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s remains: %v", path, err)
		}
	}
	state, err := exec.Command("systemctl", "show", "--property=ActiveState", "--value", r.Scope).Output()
	if strings.TrimSpace(string(state)) != "inactive" {
		t.Errorf("scope state after destroy: %q, %v", state, err)
	}
}

func TestKVMBootRunExit(t *testing.T) {
	l, shape := kvmLauncher(t)
	v := kvmBoot(t, l, "first", shape)
	reply, err := v.Request(t.Context(), map[string]string{"op": "free"}, nil)
	if err != nil || reply["ok"] != true {
		t.Fatalf("free: %v, %v", reply, err)
	}
	if code, out := kvmRun(t, v.channel, "printf kvm-ok", 0); code != 0 || out != "kvm-ok" {
		t.Fatalf("run: %d %q", code, out)
	}
	kvmRequest(t, v.channel, map[string]any{"op": "exit"})
	select {
	case <-v.exited:
	case <-time.After(5 * time.Second):
		t.Fatal("guest exit did not stop Firecracker")
	}
	if err := v.Destroy(t.Context()); err != nil {
		t.Fatal(err)
	}
	if err := v.Destroy(t.Context()); err != nil {
		t.Fatal(err)
	}
	checkClean(t, l, v.record)
	next := kvmBoot(t, l, "next", shape)
	if next.record.Slot != v.record.Slot {
		t.Fatal("slot was not freed")
	}
}

func TestKVMDaemonDeath(t *testing.T) {
	l, shape := kvmLauncher(t)
	id := kvmID(t, l, "orphan")
	repo, names := kvmCheckpointRepo(t, l)
	cfg, err := json.Marshal(struct {
		Launcher *Launcher
		Shape    Shape
		ID, Repo string
	}{l, shape, id, repo})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestKVMLaunchHelper$")
	cmd.Env = append(os.Environ(), "CAMELFSD_KVM_HELPER="+string(cfg))
	readyR, readyW, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer readyR.Close()
	defer readyW.Close()
	cmd.ExtraFiles = []*os.File{readyW}
	log, err := os.Create(filepath.Join(l.Work, "launcher.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	readyW.Close()
	defer func() {
		if cmd.ProcessState == nil {
			cmd.Process.Kill()
			cmd.Wait()
		}
	}()
	readyR.SetReadDeadline(time.Now().Add(90 * time.Second))
	var marker struct{ BootMS, StartedUnixNano int64 }
	if err := json.NewDecoder(readyR).Decode(&marker); err != nil {
		t.Fatalf("launcher helper: %v (see %s)", err, log.Name())
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	v, err := l.Adopt(id)
	if err != nil {
		t.Fatal(err)
	}
	sessions, err := v.Reconnect(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	execs, ok := sessions["execs"].([]any)
	if !ok || len(execs) != 1 {
		t.Fatal(sessions)
	}
	active := execs[0].(map[string]any)
	if active["execId"] != "survives" || active["running"] != true {
		t.Fatal(sessions)
	}
	events := make(chan Reply, 10)
	reply, err := v.Request(t.Context(), Reply{"op": "exec_tail", "execId": "survives", "offset": 0}, nil, func(m Reply) { events <- m })
	if err != nil || reply["ok"] != true {
		t.Fatal(reply, err)
	}
	var output strings.Builder
	timer := time.NewTimer(10 * time.Second)
	defer timer.Stop()
collect:
	for {
		select {
		case m := <-events:
			switch m["event"] {
			case "exec_output":
				b, err := base64.StdEncoding.DecodeString(m["data"].(string))
				if err != nil {
					t.Fatal(err)
				}
				output.Write(b)
			case "exec_exit":
				if m["code"] != float64(0) || m["timedOut"] != false || output.String() != "done\n" {
					t.Fatal(m, output.String())
				}
				t.Logf("boot_to_first_exec_ms=%d exec_round_trip_ms=%d guest_exec_ms=%v", marker.BootMS, time.Since(time.Unix(0, marker.StartedUnixNano)).Milliseconds(), m["ms"])
				break collect
			}
		case <-timer.C:
			t.Fatal("exec did not finish")
		}
	}
	kvmSeedIndex(t, v, names)
	wall := time.Now()
	checkpoint := kvmRequest(t, v.channel, Reply{"op": "camelfs_checkpoint", "jobId": id, "timeoutMs": 10_000})
	if checkpoint["changed"] != false || checkpoint["files"] != float64(0) || checkpoint["bytes"] != float64(0) {
		t.Fatal(checkpoint)
	}
	t.Logf("checkpoint_noop_ms=%d freeze_ms=%v walk_ms=%v files=10000", time.Since(wall).Milliseconds(), checkpoint["freezeMs"], checkpoint["walkMs"])
	kvmRequest(t, v.channel, Reply{"op": "exit"})
	until := time.Now().Add(5 * time.Second)
	for exec.Command("systemctl", "is-active", "--quiet", v.record.Scope).Run() == nil {
		if time.Now().After(until) {
			t.Fatal("guest exit did not stop Firecracker")
		}
		time.Sleep(50 * time.Millisecond)
	}
	if err := v.Destroy(t.Context()); err != nil {
		t.Fatal(err)
	}
	checkClean(t, l, v.record)
}

func kvmCheckpointRepo(t *testing.T, l *Launcher) (string, []string) {
	t.Helper()
	dir := filepath.Join(l.Work, "seed")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	var names []string
	for i := range 10_000 {
		name := fmt.Sprintf("file-%05d", i)
		if err := os.WriteFile(filepath.Join(dir, name), nil, 0644); err != nil {
			t.Fatal(err)
		}
		names = append(names, name)
	}
	repo := filepath.Join(l.Work, "repo.ext4")
	out, err := exec.Command("mkfs.ext4", "-q", "-F", "-d", dir, repo, "96M").CombinedOutput()
	if err != nil {
		t.Fatalf("mkfs.ext4: %v: %s", err, out)
	}
	return repo, names
}

func kvmSeedIndex(t *testing.T, v *VM, names []string) {
	t.Helper()
	path := filepath.Join(v.root, "guest.vsock_5201")
	// The Firecracker backend connects to this sibling socket from inside its jail.
	dir, err := os.Open(v.root)
	if err != nil {
		t.Fatal(err)
	}
	defer dir.Close()
	addr := &net.UnixAddr{Name: fmt.Sprintf("/proc/self/fd/%d/%s", dir.Fd(), filepath.Base(path)), Net: "unix"}
	listener, err := net.ListenUnix("unix", addr)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	if err := os.Chmod(path, 0666); err != nil {
		t.Fatal(err)
	}
	peer := make(chan error, 1)
	go func() {
		peer <- func() error {
			listener.SetDeadline(time.Now().Add(10 * time.Second))
			c, err := listener.AcceptUnix()
			if err != nil {
				return err
			}
			defer c.Close()
			c.SetDeadline(time.Now().Add(10 * time.Second))
			tree := strings.Repeat("a", 40)
			if err := wire.Send(c, Reply{"v": 1, "kind": "apply", "jobId": v.ID(), "fromTree": "", "toTree": tree}); err != nil {
				return err
			}
			for i := 0; i < len(names); i += 200 {
				entries := []Reply{}
				for _, name := range names[i:min(i+200, len(names))] {
					entries = append(entries, Reply{"path": name, "mode": "100644", "size": 0, "sha1": tree})
				}
				if err := wire.Send(c, Reply{"index": entries}); err != nil {
					return err
				}
			}
			if err := wire.Send(c, Reply{"indexEnd": true, "count": len(names)}); err != nil {
				return err
			}
			if err := wire.Send(c, Reply{"end": true}); err != nil {
				return err
			}
			var reply Reply
			if err := wire.JSON(c, &reply); err != nil {
				return err
			}
			if reply["applied"] != true {
				return fmt.Errorf("apply: %v", reply)
			}
			return nil
		}()
	}()
	kvmRequest(t, v.channel, Reply{"op": "camelfs_apply", "jobId": v.ID(), "timeoutMs": 10_000})
	if err := <-peer; err != nil {
		t.Fatal(err)
	}
}

func TestKVMLaunchHelper(t *testing.T) {
	input := os.Getenv("CAMELFSD_KVM_HELPER")
	if input == "" {
		t.Skip("launcher subprocess only")
	}
	kvmEnv(t)
	start := time.Now()
	var cfg struct {
		Launcher *Launcher
		Shape    Shape
		ID, Repo string
	}
	if err := json.Unmarshal([]byte(input), &cfg); err != nil {
		t.Fatal(err)
	}
	// Make the regular repo fixture writable to every reserved guest UID.
	if err := os.Chmod(cfg.Repo, 0666); err != nil {
		t.Fatal(err)
	}
	v, err := cfg.Launcher.Boot(t.Context(), cfg.ID, cfg.Shape, Boot{Repo: cfg.Repo})
	if err != nil {
		t.Fatal(err)
	}
	sh := kvmRequest(t, v.channel, Reply{"op": "shell_open"})["shellId"]
	started := time.Now()
	reply := kvmRequest(t, v.channel, Reply{"op": "exec", "execId": "survives", "shell": sh, "command": "sleep 3; echo done", "timeoutS": 10})
	if reply["accepted"] != true {
		t.Fatal(reply)
	}
	ready := os.NewFile(3, "parent-ready")
	if err := json.NewEncoder(ready).Encode(Reply{"bootMS": time.Since(start).Milliseconds(), "startedUnixNano": started.UnixNano()}); err != nil {
		t.Fatal(err)
	}
	ready.Close()
	select {
	case <-v.exited:
		t.Fatalf("Firecracker exited: %v", v.exitErr)
	case <-time.After(2 * time.Minute):
		t.Fatal("launcher helper was not stopped")
	}
}

func TestKVMIsolation(t *testing.T) {
	l, shape := kvmLauncher(t)
	first := kvmBoot(t, l, "first", shape)
	second := kvmBoot(t, l, "second", shape)
	a, _ := JobAddress(first.record.Slot)
	b, _ := JobAddress(second.record.Slot)
	for _, probe := range []struct {
		name, host string
		port       int
	}{
		{"imds", "169.254.169.254", 80},
		{"amazon-dns", "169.254.169.253", 53},
		{"vpc", "10.0.0.2", 53},
		{"other-guest", b.GuestIP.String(), 22},
		{"other-tap", b.HostIP.String(), ProxyPort},
		{"host-ssh", a.HostIP.String(), 22},
		{"host-http", a.HostIP.String(), 80},
		{"host-https", a.HostIP.String(), 443},
		{"host-app", a.HostIP.String(), 8080},
	} {
		t.Run(probe.name, func(t *testing.T) {
			command := fmt.Sprintf("timeout 4 bash -c 'exec 3<>/dev/tcp/%s/%d' 2>/dev/null", probe.host, probe.port)
			if code, _ := kvmRun(t, first.channel, command, 0); code != 1 && code != 124 {
				t.Fatalf("unexpected TCP probe status %d", code)
			}
		})
	}
	t.Run("pid-cap", func(t *testing.T) {
		code, out := kvmRun(t, first.channel, `for i in $(seq 96); do sleep 2 & done; wait`, 64)
		if code == 125 || !strings.Contains(out, "Resource temporarily unavailable") {
			t.Fatalf("pid cap: %d %q", code, out)
		}
	})
	t.Run("full-disk", func(t *testing.T) {
		command := `fallocate -l "$(( $(df --output=avail -B1 / | tail -1) - 4096 ))" /fill || { dd if=/dev/zero of=/fill bs=1M 2>/dev/null; true; }`
		if code, out := kvmRun(t, first.channel, command, 0); code != 0 {
			t.Fatalf("fill: %d %q", code, out)
		}
		reply := kvmRequest(t, first.channel, map[string]any{"op": "free"})
		if free, ok := reply["freeBytes"].(float64); !ok || free >= 64*mib {
			t.Fatalf("free: %v", reply)
		}
	})
}
