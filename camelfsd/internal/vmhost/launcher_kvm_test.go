//go:build linux && kvm

package vmhost

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

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

// The guest serves one connection and reboots on EOF. Keep that connection in
// the parent so this test isolates scope lifetime from guest reconnect behavior.
func TestKVMDaemonDeath(t *testing.T) {
	l, shape := kvmLauncher(t)
	id := kvmID(t, l, "orphan")
	cfg, err := json.Marshal(struct {
		Launcher *Launcher
		Shape    Shape
		ID       string
	}{l, shape, id})
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(os.Args[0], "-test.run=^TestKVMLaunchHelper$")
	cmd.Env = append(os.Environ(), "CAMELFSD_KVM_HELPER="+string(cfg))
	log, err := os.Create(filepath.Join(l.Work, "launcher.log"))
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	cmd.Stdout, cmd.Stderr = log, log
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	waited := false
	defer func() {
		if !waited {
			cmd.Process.Kill()
			cmd.Wait()
		}
	}()
	r := VMRecord{ID: id, Jail: l.jailPath(id)}
	c, err := connectGuest(t.Context(), filepath.Join(r.Jail, "firecracker", id, "root", "guest.vsock"), 90*time.Second)
	if err != nil {
		t.Fatalf("launcher helper: %v", err)
	}
	defer c.conn.Close()
	kvmRequest(t, c, map[string]any{"op": "free"})
	r, err = l.readRecord(id)
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = cmd.Wait()
	waited = true
	if out, err := exec.Command("systemctl", "is-active", r.Scope).CombinedOutput(); err != nil {
		t.Fatalf("scope after launcher SIGKILL: %s: %v", out, err)
	}
	if code, out := kvmRun(t, c, "printf survived", 0); code != 0 || out != "survived" {
		t.Fatalf("run: %d %q", code, out)
	}
	if err := l.Destroy(t.Context(), id); err != nil {
		t.Fatal(err)
	}
	checkClean(t, l, r)
}

func TestKVMLaunchHelper(t *testing.T) {
	input := os.Getenv("CAMELFSD_KVM_HELPER")
	if input == "" {
		t.Skip("launcher subprocess only")
	}
	kvmEnv(t)
	var cfg struct {
		Launcher *Launcher
		Shape    Shape
		ID       string
	}
	if err := json.Unmarshal([]byte(input), &cfg); err != nil {
		t.Fatal(err)
	}
	v, err := cfg.Launcher.start(t.Context(), cfg.ID, cfg.Shape, Boot{})
	if err != nil {
		t.Fatal(err)
	}
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
