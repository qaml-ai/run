package vm

import (
	"os/exec"
	"runtime"
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
