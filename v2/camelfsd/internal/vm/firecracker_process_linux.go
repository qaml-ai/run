package vm

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
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
		out, err := exec.Command("systemctl", "show", "--property=ControlGroup,KillMode", "--", unit).Output()
		if err != nil {
			return "", fmt.Errorf("check Firecracker service %s: %w", unit, err)
		}
		props := "\n" + string(out)
		if strings.Contains(props, "\nControlGroup=/"+path+"\n") && strings.Contains(props, "\nKillMode=control-group\n") {
			return path, nil
		}
	}
	return "", fmt.Errorf("the Firecracker jailer requires a cgroup v2 systemd service with KillMode=control-group")
}

func prepareFirecrackerJail(dir, kernel, rootfs string, uid int) error {
	if err := os.Chown(rootfs, uid, uid); err != nil {
		return err
	}
	kernelCopy := filepath.Join(dir, "kernel")
	if err := copyFileReflinkOrCopy(kernel, kernelCopy); err != nil {
		return err
	}
	if err := os.Chmod(kernelCopy, 0444); err != nil {
		return err
	}
	return os.Chown(kernelCopy, uid, uid)
}
