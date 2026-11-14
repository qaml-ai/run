package guest

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// PID 1 owns wait4 for both commands and adopted descendants. Hold the same lock
// across Start and registration so even an immediately exiting child is accounted for.
type reaper struct {
	mu       sync.Mutex
	children map[int]chan unix.WaitStatus
}

func startReaper() *reaper {
	r := &reaper{children: make(map[int]chan unix.WaitStatus)}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGCHLD)
	go func() {
		for range sig {
			r.mu.Lock()
			for {
				var status unix.WaitStatus
				pid, err := unix.Wait4(-1, &status, unix.WNOHANG, nil)
				if err == unix.EINTR {
					continue
				}
				if pid <= 0 {
					break
				}
				if result := r.children[pid]; result != nil {
					result <- status
					delete(r.children, pid)
				}
			}
			r.mu.Unlock()
		}
	}()
	return r
}

func (r *reaper) start(cmd *exec.Cmd) (<-chan unix.WaitStatus, error) {
	result := make(chan unix.WaitStatus, 1)
	if r != nil {
		r.mu.Lock()
		defer r.mu.Unlock()
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	if r != nil {
		r.children[cmd.Process.Pid] = result
	} else {
		go func() {
			cmd.Wait()
			result <- unix.WaitStatus(cmd.ProcessState.Sys().(syscall.WaitStatus))
		}()
	}
	return result, nil
}

type commandOutput struct {
	reader, writer *os.File
	result         chan stream
}

func (p commandOutput) close() {
	p.reader.Close()
	p.writer.Close()
}

func (g *guest) readOutput(p commandOutput, name string) {
	var kept []byte
	var size int64
	buf := make([]byte, logChunkBytes)
	for {
		n, err := p.reader.Read(buf)
		if n != 0 {
			size += int64(n)
			kept = append(kept, buf[:min(n, streamBytes-len(kept))]...)
			g.send(message{"event": "log", "stream": name, "data": base64.StdEncoding.EncodeToString(buf[:n])})
		}
		if err != nil {
			break
		}
	}
	p.result <- captured(kept, size)
}

func pidLimit(cap float64) string {
	if cap <= 0 || cap != math.Trunc(cap) {
		return ""
	}
	return fmt.Sprintf(`if [ -w /sys/fs/cgroup/cgroup.subtree_control ]; then g=/sys/fs/cgroup/camel-job-$$;
 { grep -q pids /sys/fs/cgroup/cgroup.subtree_control || echo +pids > /sys/fs/cgroup/cgroup.subtree_control; } && mkdir -p $g && echo %.0f > $g/pids.max && echo $$ > $g/cgroup.procs || exit 125;
 else ulimit -u %.0f 2>/dev/null || exit 125; fi; `, cap, cap)
}

func (g *guest) run(ctx context.Context, req request) (message, error) {
	start := time.Now()
	cmd := exec.Command("bash", "-lc", pidLimit(req.Pids)+req.Command)
	cmd.Dir = g.repo
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	path, ok := os.LookupEnv("PATH")
	if !ok {
		path = "/usr/local/bin:/usr/bin:/bin"
	}
	cmd.Env = []string{"PATH=" + path, "HOME=" + g.repo, "JOB_OUT=" + g.out}
	for k, v := range req.Env {
		if strings.ContainsAny(k, "=\x00") || strings.ContainsRune(v, 0) {
			return nil, fmt.Errorf("invalid environment")
		}
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	var pipes [2]commandOutput
	for i := range pipes {
		r, w, err := os.Pipe()
		if err != nil {
			return nil, err
		}
		pipes[i] = commandOutput{r, w, make(chan stream, 1)}
		defer pipes[i].close()
	}
	cmd.Stdout, cmd.Stderr = pipes[0].writer, pipes[1].writer
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	status, err := g.reaper.start(cmd)
	if err != nil {
		return nil, err
	}
	if g.reaper != nil {
		defer cmd.Process.Release()
	}
	group := cmd.Process.Pid
	pgid := filepath.Join(g.root, ".job.pgid")
	os.WriteFile(pgid, []byte(fmt.Sprint(group)), 0666)
	defer os.Remove(pgid)
	for i, name := range []string{"stdout", "stderr"} {
		pipes[i].writer.Close()
		go g.readOutput(pipes[i], name)
	}
	timer := time.NewTimer(time.Duration(min(max(1, req.TimeoutSeconds), 2147483) * float64(time.Second)))
	defer timer.Stop()
	deadline, done := timer.C, ctx.Done()
	out, errOut := pipes[0].result, pipes[1].result
	var stdout, stderr stream
	var exitCode any
	timedOut := false
	for status != nil || out != nil || errOut != nil {
		select {
		case <-deadline:
			timedOut = true
			deadline = nil
			unix.Kill(-group, unix.SIGKILL)
			// A descendant that created its own session can keep pipes open indefinitely.
			for _, p := range pipes {
				p.reader.SetReadDeadline(time.Now().Add(time.Second))
			}
		case <-done:
			done = nil
			unix.Kill(-group, unix.SIGKILL)
			for _, p := range pipes {
				p.reader.Close()
			}
		case s := <-status:
			status = nil
			if s.Exited() {
				exitCode = s.ExitStatus()
			}
		case stdout = <-out:
			out = nil
		case stderr = <-errOut:
			errOut = nil
		}
	}
	if timedOut {
		exitCode = nil
	}
	return message{"exitCode": exitCode, "timedOut": timedOut, "stdout": stdout, "stderr": stderr, "commandMs": elapsed(start)}, nil
}

func readError(err error, eof string) error {
	if errors.Is(err, io.EOF) || errors.Is(err, io.ErrUnexpectedEOF) {
		return errors.New(eof)
	}
	return err
}
