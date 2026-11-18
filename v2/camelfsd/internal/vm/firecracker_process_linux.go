package vm

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"

	"golang.org/x/sys/unix"
)

func launchFirecracker(cmd *exec.Cmd) (chan struct{}, error) {
	started := make(chan error, 1)
	done := make(chan struct{})
	cmd.SysProcAttr = &syscall.SysProcAttr{Pdeathsig: syscall.SIGKILL}
	go func() {
		// Linux binds Pdeathsig to the thread that spawned the child.
		runtime.LockOSThread()
		defer runtime.UnlockOSThread()
		defer close(done)
		err := cmd.Start()
		started <- err
		if err == nil {
			_ = cmd.Wait()
		}
	}()
	if err := <-started; err != nil {
		return nil, err
	}
	return done, nil
}

// Firecracker drops privileges under the jailer, which clears Pdeathsig.
// Keep it in the daemon's systemd service so systemd fences it on restart.
func firecrackerServiceCgroup() (string, error) {
	raw, err := os.ReadFile("/proc/self/cgroup")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(raw), "\n") {
		path, ok := strings.CutPrefix(line, "0::/")
		if !ok || !strings.HasSuffix(path, ".service") {
			continue
		}
		unit := filepath.Base(path)
		out, err := exec.Command("systemctl", "show", "--property=KillMode", "--value", "--", unit).Output()
		if err != nil {
			return "", fmt.Errorf("check Firecracker service %s: %w", unit, err)
		}
		if strings.TrimSpace(string(out)) == "control-group" {
			return path, nil
		}
	}
	return "", fmt.Errorf("the Firecracker jailer requires a cgroup v2 systemd service with KillMode=control-group")
}

func prepareFirecrackerJail(dir, kernel, rootfs, nbd string) (string, error) {
	var disk unix.Stat_t
	if err := unix.Stat(nbd, &disk); err != nil {
		return "", err
	}
	if disk.Mode&unix.S_IFMT != unix.S_IFBLK {
		return "", fmt.Errorf("workspace device %s is not a block device", nbd)
	}
	// Each attached NBD has a distinct minor number on the host.
	uid := 201000 + int(unix.Minor(uint64(disk.Rdev)))
	if err := os.Chown(rootfs, uid, uid); err != nil {
		return "", err
	}
	kernelCopy := filepath.Join(dir, "kernel")
	if err := copyFileReflinkOrCopy(kernel, kernelCopy); err != nil {
		return "", err
	}
	if err := os.Chmod(kernelCopy, 0444); err != nil {
		return "", err
	}
	device := filepath.Join(dir, "workspace.nbd")
	if err := unix.Mknod(device, unix.S_IFBLK|0600, int(disk.Rdev)); err != nil {
		return "", err
	}
	if err := os.Chown(device, uid, uid); err != nil {
		return "", err
	}
	return strconv.Itoa(uid), nil
}
