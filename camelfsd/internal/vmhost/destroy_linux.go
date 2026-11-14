package vmhost

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/unix"
)

// Destroy stops a recorded VM by ID, including after the launcher process has
// exited. It does not reconnect the guest channel.
func (l *Launcher) Destroy(ctx context.Context, id string) error {
	l.mu.Lock()
	v := l.live[id]
	if v == nil {
		r, err := l.readRecord(id)
		if err != nil {
			l.mu.Unlock()
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		v = &VM{host: l, record: r, scopeAttempted: true, tapOwned: true, jailOwned: true}
		if l.live == nil {
			l.live = make(map[string]*VM)
		}
		l.live[id] = v
	}
	l.mu.Unlock()
	return v.Destroy(ctx)
}

func (v *VM) Destroy(ctx context.Context) error {
	v.mu.Lock()
	defer v.mu.Unlock()
	return v.destroyLocked(ctx)
}

func (v *VM) destroyLocked(ctx context.Context) error {
	if v.gone {
		return nil
	}
	l, r := v.host, v.record
	if v.scopeAttempted {
		if err := v.stopScope(ctx); err != nil {
			return err
		}
		v.scopeAttempted = false
	}
	if v.channel != nil {
		v.channel.conn.Close()
		v.channel = nil
	}
	addr, _ := JobAddress(r.Slot)
	if v.tapOwned {
		if err := errors.Join(TapDown(addr), removePolicy(l.PolicyDir, addr.GuestIP)); err != nil {
			return err
		}
		v.tapOwned = false
	}
	if v.jailOwned {
		if err := unmountAssets(r.Jail); err != nil {
			return err
		}
		if err := os.RemoveAll(r.Jail); err != nil {
			return err
		}
		v.jailOwned = false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := removeFile(l.recordPath(r.ID)); err != nil {
		return err
	}
	delete(l.live, r.ID)
	v.gone = true
	return nil
}

func (v *VM) stopScope(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	scope := v.record.Scope
	// Before the guest is ready systemd-run might still be registering the
	// scope. Reap it first so it cannot exec the jailer after the stop.
	if v.cmd != nil && v.channel == nil {
		_ = v.cmd.Process.Kill()
		select {
		case <-v.exited:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	out, err := exec.CommandContext(ctx, "systemctl", "stop", scope).CombinedOutput()
	if err != nil {
		state, showErr := exec.CommandContext(ctx, "systemctl", "show", "--property=LoadState", "--value", scope).Output()
		if showErr != nil || strings.TrimSpace(string(state)) != "not-found" {
			return fmt.Errorf("stop %s: %w: %s", scope, err, out)
		}
	}
	if v.exited != nil {
		select {
		case <-v.exited:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	// A stop job can finish after a kill timeout with processes still in
	// the cgroup. Keep the VM's resources reserved until it is empty.
	events, err := os.ReadFile(filepath.Join("/sys/fs/cgroup/system.slice", scope, "cgroup.events"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(events), "\n") {
		if line == "populated 0" {
			return nil
		}
	}
	return fmt.Errorf("scope %s still has processes", scope)
}

var mountEscapes = strings.NewReplacer(`\040`, " ", `\011`, "\t", `\012`, "\n", `\134`, `\`)

func unmountAssets(jail string) error {
	f, err := os.Open("/proc/self/mountinfo")
	if err != nil {
		return err
	}
	defer f.Close()
	var mounts []string
	scan := bufio.NewScanner(f)
	for scan.Scan() {
		fields := strings.Fields(scan.Text())
		if len(fields) < 6 {
			continue
		}
		point := mountEscapes.Replace(fields[4])
		if strings.HasPrefix(point, jail+string(filepath.Separator)) {
			mounts = append(mounts, point)
		}
	}
	if err := scan.Err(); err != nil {
		return err
	}
	for i := len(mounts) - 1; i >= 0; i-- {
		if err := unix.Unmount(mounts[i], unix.UMOUNT_NOFOLLOW); err != nil {
			return err
		}
	}
	return nil
}
