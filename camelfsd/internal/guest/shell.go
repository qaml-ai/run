package guest

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

type shell struct {
	id     string
	pid    int
	input  *os.File
	status *os.File
	reader *bufio.Reader
	done   chan struct{}
	exit   unix.WaitStatus
	busy   bool // guarded by the session lock
}

func token() (string, error) {
	var b [16]byte
	_, err := rand.Read(b[:])
	return hex.EncodeToString(b[:]), err
}

func (g *guest) workdir() string {
	if g.session {
		return workspacePath
	}
	if st, err := os.Stat(g.repo); err == nil && st.IsDir() {
		return g.repo
	}
	return g.root
}

func (g *guest) openShell() (*shell, error) {
	id, err := token()
	if err != nil {
		return nil, err
	}
	in, control, err := os.Pipe()
	if err != nil {
		return nil, err
	}
	defer in.Close()
	status, out, err := os.Pipe()
	if err != nil {
		control.Close()
		return nil, err
	}
	defer out.Close()
	cmd := exec.Command("bash")
	cmd.Dir, cmd.Stdin, cmd.ExtraFiles = g.workdir(), in, []*os.File{out}
	cmd.Env = append(os.Environ(), "BASH_ENV=")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	wait, err := g.reaper.start(cmd)
	if err != nil {
		control.Close()
		status.Close()
		return nil, err
	}
	sh := &shell{id: id, pid: cmd.Process.Pid, input: control, status: status, reader: bufio.NewReaderSize(status, 128), done: make(chan struct{})}
	go func() {
		sh.exit = <-wait
		if g.reaper != nil {
			cmd.Process.Release()
		}
		close(sh.done)
		control.Close()
	}()
	return sh, nil
}

func (sh *shell) kill() {
	select {
	case <-sh.done:
	default:
		unix.Kill(-sh.pid, unix.SIGKILL)
	}
}

func quote(s string) string { return "'" + strings.ReplaceAll(s, "'", "'\\''") + "'" }

func (g *guest) sessionCommand(e *execution, sh *shell, req request) (any, bool, error) {
	deadline := time.Now().Add(time.Duration(min(max(1, req.TimeoutS), 2147483) * float64(time.Second)))
	env := make([]string, 0, len(req.Env))
	for k, v := range req.Env {
		if k == "" || strings.ContainsAny(k, "=\x00") || strings.ContainsRune(v, 0) {
			return 125, false, errors.New("invalid environment")
		}
		if sh != nil && !shellName(k) {
			return 125, false, errors.New("invalid shell environment name")
		}
		env = append(env, k+"="+v)
	}
	slices.Sort(env)
	if strings.ContainsRune(req.Command, 0) {
		return 125, false, errors.New("invalid command")
	}
	var pipes [2][2]*os.File
	for i := range pipes {
		r, w, err := os.Pipe()
		if err != nil {
			return 125, false, err
		}
		pipes[i] = [2]*os.File{r, w}
		defer r.Close()
		defer w.Close()
	}
	var drain sync.WaitGroup
	for i, stream := range []string{"stdout", "stderr"} {
		r := pipes[i][0]
		drain.Add(1)
		go func() {
			defer drain.Done()
			buf := make([]byte, logChunkBytes)
			for {
				n, err := r.Read(buf)
				if n > 0 {
					g.sessions.output(e, stream, buf[:n])
				}
				if err != nil {
					return
				}
			}
		}()
	}
	defer func() {
		for _, pair := range pipes {
			pair[1].Close()
			// Background descendants may hold an output fd after the command exits.
			pair[0].SetReadDeadline(time.Now().Add(100 * time.Millisecond))
		}
		drain.Wait()
	}()
	if sh != nil {
		return sh.run(req, env, pipes[0][1], pipes[1][1], deadline)
	}
	cmd := exec.Command("bash", "-lc", req.Command)
	cmd.Dir, cmd.Env = g.workdir(), append(os.Environ(), env...)
	if req.Cwd != "" {
		cmd.Dir = req.Cwd
		if !filepath.IsAbs(cmd.Dir) {
			cmd.Dir = filepath.Join(g.workdir(), cmd.Dir)
		}
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	// Use a file so os/exec does not wait on a stdin copier after the child exits.
	in, err := commandInput(req.Stdin)
	if err != nil {
		return 125, false, err
	}
	defer in.Close()
	cmd.Stdin, cmd.Stdout, cmd.Stderr = in, pipes[0][1], pipes[1][1]
	wait, err := g.reaper.start(cmd)
	if err != nil {
		return 125, false, err
	}
	if g.reaper != nil {
		defer cmd.Process.Release()
	}
	timer := time.NewTimer(time.Until(deadline))
	defer timer.Stop()
	select {
	case status := <-wait:
		return exitCode(status), false, nil
	case <-timer.C:
		unix.Kill(-cmd.Process.Pid, unix.SIGKILL)
		<-wait
		return nil, true, nil
	}
}

func exitCode(status unix.WaitStatus) any {
	if status.Exited() {
		return status.ExitStatus()
	}
	return nil
}

func commandInput(data string) (*os.File, error) {
	if data == "" {
		return os.Open(os.DevNull)
	}
	fd, err := unix.MemfdCreate("exec-stdin", unix.MFD_CLOEXEC)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), "exec-stdin")
	if _, err = f.WriteString(data); err == nil {
		_, err = f.Seek(0, io.SeekStart)
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func procFD(f *os.File) string { return fmt.Sprintf("/proc/%d/fd/%d", os.Getpid(), f.Fd()) }

// Bash reads one wrapper from the control pipe. Eval runs in the shell with
// per-command stdin/stdout/stderr and fd 3 closed. Only the wrapper writes
// <random 128-bit token>:<status> to fd 3, a separate status pipe. Bytes on
// stdout/stderr are never parsed as status, even if they match the sentinel.
func (sh *shell) run(req request, env []string, out, errOut *os.File, deadline time.Time) (any, bool, error) {
	in, err := commandInput(req.Stdin)
	if err != nil {
		return 125, false, err
	}
	defer in.Close()
	nonce, err := token()
	if err != nil {
		return 125, false, err
	}
	var wrapper strings.Builder
	if req.Cwd != "" {
		req.Command = "builtin cd -- " + quote(req.Cwd) + " && " + req.Command
	}
	for _, item := range env {
		k, v, _ := strings.Cut(item, "=")
		fmt.Fprintf(&wrapper, "builtin export %s=%s; ", k, quote(v))
	}
	fmt.Fprintf(&wrapper, "builtin eval -- %s <%s >%s 2>%s 3>&-; builtin printf '%s:%%d\\n' \"$?\" >&3\n",
		quote(req.Command), procFD(in), procFD(out), procFD(errOut), nonce)
	sh.input.SetWriteDeadline(deadline)
	sh.status.SetReadDeadline(deadline)
	_, err = io.WriteString(sh.input, wrapper.String())
	if err == nil {
		var line []byte
		line, err = sh.reader.ReadSlice('\n')
		if err == nil {
			prefix, value, _ := strings.Cut(strings.TrimSuffix(string(line), "\n"), ":")
			code, parseErr := strconv.Atoi(value)
			if prefix == nonce && parseErr == nil && code >= 0 && code <= 255 {
				return code, false, nil
			}
			err = errors.New("invalid shell completion")
		}
	}
	sh.kill()
	<-sh.done
	sh.status.Close()
	if errors.Is(err, os.ErrDeadlineExceeded) {
		return nil, true, nil
	}
	if errors.Is(err, io.EOF) || errors.Is(err, syscall.EPIPE) || errors.Is(err, os.ErrClosed) {
		return exitCode(sh.exit), false, nil
	}
	return nil, false, err
}

func shellName(k string) bool {
	for i, c := range []byte(k) {
		if c != '_' && !(c >= 'a' && c <= 'z') && !(c >= 'A' && c <= 'Z') && !(i > 0 && c >= '0' && c <= '9') {
			return false
		}
	}
	return true
}
