package vm

import (
	"bufio"
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
)

type pipeCapture struct {
	marker  []byte
	pending []byte
	buf     bytes.Buffer
	onChunk func(string)
	done    chan struct{}
	closed  bool
}

type ctrlMsg struct {
	token    string
	exitCode int
	pwd      string
	eof      bool
}

type localShellProc struct {
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	ctrlCh chan ctrlMsg
	waitCh chan int

	capMu     sync.Mutex
	stdoutCap *pipeCapture
	stderrCap *pipeCapture
}

type localVMSession struct {
	mu           sync.Mutex
	vmID         string
	baseDir      string
	workspaceDir string
	ctrlDir      string
	envFile      string
	initEnv      map[string]string
	lastHostCwd  string
	seq          uint64
	proc         *localShellProc
}

// LocalDriver runs each VM session in an isolated host workspace directory backed by
// a persistent bash subprocess that preserves cwd and exported environment variables across exec calls.
type LocalDriver struct {
	rootDir  string
	mu       sync.RWMutex
	sessions map[string]*localVMSession
}

func NewLocalDriver(dataDir string) (*LocalDriver, error) {
	rootDir := filepath.Join(dataDir, "vms")
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir vms dir: %w", err)
	}
	return &LocalDriver{
		rootDir:  rootDir,
		sessions: make(map[string]*localVMSession),
	}, nil
}

func (d *LocalDriver) Start(_ context.Context, spec StartSpec) (string, error) {
	baseDir := filepath.Join(d.rootDir, spec.VMID)
	workspaceDir := filepath.Join(baseDir, "workspace")
	ctrlDir := filepath.Join(baseDir, "ctrl")
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		return "", apperr.Internal("mkdir vm workspace", err)
	}
	if err := os.MkdirAll(ctrlDir, 0o700); err != nil {
		return "", apperr.Internal("mkdir vm ctrl", err)
	}
	if err := repo.WriteMaterializedFilesToDir(workspaceDir, spec.Files); err != nil {
		return "", err
	}

	sess := newLocalSession(spec.VMID, baseDir, workspaceDir, ctrlDir, spec.Env)
	if err := sess.ensureShellLocked(); err != nil {
		_ = os.RemoveAll(baseDir)
		return "", err
	}

	d.mu.Lock()
	d.sessions[spec.VMID] = sess
	d.mu.Unlock()

	return "local", nil
}

func newLocalSession(vmID, baseDir, workspaceDir, ctrlDir string, env map[string]string) *localVMSession {
	initEnv := make(map[string]string, len(env))
	for k, v := range env {
		initEnv[k] = v
	}
	return &localVMSession{
		vmID:         vmID,
		baseDir:      baseDir,
		workspaceDir: workspaceDir,
		ctrlDir:      ctrlDir,
		envFile:      filepath.Join(ctrlDir, "env.snapshot"),
		initEnv:      initEnv,
		lastHostCwd:  workspaceDir,
	}
}

func (d *LocalDriver) getSession(vmID string) (*localVMSession, error) {
	d.mu.RLock()
	sess, ok := d.sessions[vmID]
	d.mu.RUnlock()
	if !ok {
		return nil, apperr.NotFoundf("active local VM session %q not found", vmID)
	}
	return sess, nil
}

func shellSingleQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func longestMarkerPrefixSuffix(buf, marker []byte) int {
	maxCheck := len(marker) - 1
	if len(buf) < maxCheck {
		maxCheck = len(buf)
	}
	for k := maxCheck; k >= 1; k-- {
		if bytes.Equal(buf[len(buf)-k:], marker[:k]) {
			return k
		}
	}
	return 0
}

func (p *localShellProc) readPipeLoop(r io.ReadCloser, isStderr bool) {
	defer r.Close()
	tmp := make([]byte, 4096)
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			chunk := tmp[:n]
			var toEmit []byte
			var onChunk func(string)
			var doneCh chan struct{}
			var buf *bytes.Buffer

			p.capMu.Lock()
			capPtr := p.stdoutCap
			if isStderr {
				capPtr = p.stderrCap
			}
			if capPtr != nil && !capPtr.closed {
				buf = &capPtr.buf
				onChunk = capPtr.onChunk
				capPtr.pending = append(capPtr.pending, chunk...)
				if idx := bytes.Index(capPtr.pending, capPtr.marker); idx >= 0 {
					toEmit = append([]byte(nil), capPtr.pending[:idx]...)
					capPtr.pending = nil
					capPtr.closed = true
					doneCh = capPtr.done
				} else {
					hold := longestMarkerPrefixSuffix(capPtr.pending, capPtr.marker)
					flushN := len(capPtr.pending) - hold
					if flushN > 0 {
						toEmit = append([]byte(nil), capPtr.pending[:flushN]...)
						capPtr.pending = append([]byte(nil), capPtr.pending[flushN:]...)
					}
				}
			}
			p.capMu.Unlock()

			if buf != nil && len(toEmit) > 0 {
				buf.Write(toEmit)
				if onChunk != nil {
					onChunk(string(toEmit))
				}
			}
			if doneCh != nil {
				close(doneCh)
			}
		}
		if err != nil {
			p.capMu.Lock()
			capPtr := p.stdoutCap
			if isStderr {
				capPtr = p.stderrCap
			}
			var leftover []byte
			var onChunk func(string)
			var doneCh chan struct{}
			var buf *bytes.Buffer
			if capPtr != nil && !capPtr.closed {
				buf = &capPtr.buf
				onChunk = capPtr.onChunk
				if len(capPtr.pending) > 0 {
					leftover = append([]byte(nil), capPtr.pending...)
					capPtr.pending = nil
				}
				capPtr.closed = true
				doneCh = capPtr.done
			}
			p.capMu.Unlock()

			if buf != nil && len(leftover) > 0 {
				buf.Write(leftover)
				if onChunk != nil {
					onChunk(string(leftover))
				}
			}
			if doneCh != nil {
				close(doneCh)
			}
			return
		}
	}
}

func (p *localShellProc) readCtrlLoop(r *os.File) {
	defer r.Close()
	br := bufio.NewReader(r)
	for {
		line, err := br.ReadString('\n')
		if len(line) > 0 {
			trimmed := strings.TrimRight(line, "\r\n")
			parts := strings.SplitN(trimmed, "|", 3)
			if len(parts) == 3 {
				ec, _ := strconv.Atoi(parts[1])
				p.ctrlCh <- ctrlMsg{
					token:    parts[0],
					exitCode: ec,
					pwd:      parts[2],
				}
			}
		}
		if err != nil {
			p.ctrlCh <- ctrlMsg{eof: true}
			close(p.ctrlCh)
			return
		}
	}
}

func (p *localShellProc) killProcessGroup() {
	if p == nil || p.cmd == nil || p.cmd.Process == nil {
		return
	}
	_ = p.stdin.Close()
	pgid, err := syscall.Getpgid(p.cmd.Process.Pid)
	if err == nil && pgid > 0 {
		_ = syscall.Kill(-pgid, syscall.SIGKILL)
	} else {
		_ = p.cmd.Process.Kill()
	}
	<-p.waitCh
}

const defaultShellPath = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

const persistentBashLoop = `
if [ -f "$__CAMELFS_ENV_FILE" ]; then
  source "$__CAMELFS_ENV_FILE" >/dev/null 2>&1 || true
fi
while IFS='|' read -r __camelfs_tok __camelfs_script; do
  if [ -z "$__camelfs_tok" ]; then
    continue
  fi
  source "$__camelfs_script" </dev/null 3>&-
  __camelfs_ec=$?
  export -p > "$__CAMELFS_ENV_FILE" 2>/dev/null || true
  printf '__CAMELFS_EOF_%s__\n' "$__camelfs_tok"
  printf '__CAMELFS_EOF_%s__\n' "$__camelfs_tok" >&2
  printf '%s|%d|%s\n' "$__camelfs_tok" "$__camelfs_ec" "$PWD" >&3
done
`

func (s *localVMSession) ensureShellLocked() error {
	if s.proc != nil {
		select {
		case <-s.proc.waitCh:
			s.proc = nil
		default:
			return nil
		}
	}

	if _, err := os.Stat(s.lastHostCwd); err != nil {
		s.lastHostCwd = s.workspaceDir
	}

	ctrlR, ctrlW, err := os.Pipe()
	if err != nil {
		return apperr.Internal("create shell ctrl pipe", err)
	}

	cmd := exec.Command("bash", "--norc", "--noprofile", "-c", persistentBashLoop)
	cmd.Dir = s.lastHostCwd
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.ExtraFiles = []*os.File{ctrlW} // FD 3 in child

	envMap := map[string]string{
		"PATH":               os.Getenv("PATH"),
		"LANG":               "C.UTF-8",
		"TERM":               "dumb",
		"HOME":               s.workspaceDir,
		"WORKSPACE":          s.workspaceDir,
		"__CAMELFS_ENV_FILE": s.envFile,
	}
	if envMap["PATH"] == "" {
		envMap["PATH"] = defaultShellPath
	}
	for k, v := range s.initEnv {
		envMap[k] = v
	}
	envSlice := make([]string, 0, len(envMap))
	for k, v := range envMap {
		envSlice = append(envSlice, k+"="+v)
	}
	sort.Strings(envSlice)
	cmd.Env = envSlice

	stdinPipe, err := cmd.StdinPipe()
	if err != nil {
		_ = ctrlR.Close()
		_ = ctrlW.Close()
		return apperr.Internal("shell stdin pipe", err)
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		_ = stdinPipe.Close()
		_ = ctrlR.Close()
		_ = ctrlW.Close()
		return apperr.Internal("shell stdout pipe", err)
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		_ = stdinPipe.Close()
		_ = stdoutPipe.Close()
		_ = ctrlR.Close()
		_ = ctrlW.Close()
		return apperr.Internal("shell stderr pipe", err)
	}

	if err := cmd.Start(); err != nil {
		_ = stdinPipe.Close()
		_ = stdoutPipe.Close()
		_ = stderrPipe.Close()
		_ = ctrlR.Close()
		_ = ctrlW.Close()
		return apperr.Internal("start bash subprocess", err)
	}
	// Parent closes write end of FD 3 so EOF triggers cleanly when bash exits.
	_ = ctrlW.Close()

	proc := &localShellProc{
		cmd:    cmd,
		stdin:  stdinPipe,
		ctrlCh: make(chan ctrlMsg, 8),
		waitCh: make(chan int, 1),
	}
	go func() {
		err := cmd.Wait()
		code := 0
		if err != nil {
			var exitErr *exec.ExitError
			if errors.As(err, &exitErr) {
				code = exitErr.ExitCode()
			} else {
				code = 1
			}
		}
		proc.waitCh <- code
		close(proc.waitCh)
	}()
	go proc.readPipeLoop(stdoutPipe, false)
	go proc.readPipeLoop(stderrPipe, true)
	go proc.readCtrlLoop(ctrlR)

	s.proc = proc
	return nil
}

func (s *localVMSession) mapRequestCwd(reqCwd string) string {
	reqCwd = strings.TrimSpace(reqCwd)
	if reqCwd == "" {
		return ""
	}
	if reqCwd == "/workspace" {
		return s.workspaceDir
	}
	if strings.HasPrefix(reqCwd, "/workspace/") {
		rel := strings.TrimPrefix(reqCwd, "/workspace/")
		return filepath.Join(s.workspaceDir, filepath.FromSlash(rel))
	}
	if !filepath.IsAbs(reqCwd) {
		return filepath.Join(s.lastHostCwd, reqCwd)
	}
	return reqCwd
}

func (s *localVMSession) toVirtualCwd(hostCwd string) string {
	cleaned := filepath.Clean(hostCwd)
	wsClean := filepath.Clean(s.workspaceDir)
	if cleaned == wsClean {
		return "/workspace"
	}
	if strings.HasPrefix(cleaned, wsClean+string(filepath.Separator)) {
		rel, err := filepath.Rel(wsClean, cleaned)
		if err == nil {
			return "/workspace/" + filepath.ToSlash(rel)
		}
	}
	return hostCwd
}

func randomHexToken() string {
	var b [16]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func (d *LocalDriver) Exec(ctx context.Context, req DriverExecRequest) (*DriverExecResult, error) {
	sess, err := d.getSession(req.VMID)
	if err != nil {
		return nil, err
	}

	sess.mu.Lock()
	defer sess.mu.Unlock()

	return sess.execLocked(ctx, req)
}

func (sess *localVMSession) execLocked(ctx context.Context, req DriverExecRequest) (*DriverExecResult, error) {
	if err := sess.ensureShellLocked(); err != nil {
		return nil, err
	}

	sess.seq++
	seq := sess.seq
	tok := randomHexToken()
	marker := []byte("__CAMELFS_EOF_" + tok + "__\n")

	userScriptPath := filepath.Join(sess.ctrlDir, fmt.Sprintf("user_%d.sh", seq))
	wrapScriptPath := filepath.Join(sess.ctrlDir, fmt.Sprintf("wrap_%d.sh", seq))
	defer func() {
		_ = os.Remove(userScriptPath)
		_ = os.Remove(wrapScriptPath)
	}()

	if err := os.WriteFile(userScriptPath, []byte(req.Command+"\n"), 0o600); err != nil {
		return nil, apperr.Internal("write user command script", err)
	}

	var wrap strings.Builder
	if len(req.Env) > 0 {
		keys := make([]string, 0, len(req.Env))
		for k := range req.Env {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			wrap.WriteString("export ")
			wrap.WriteString(k)
			wrap.WriteByte('=')
			wrap.WriteString(shellSingleQuote(req.Env[k]))
			wrap.WriteByte('\n')
		}
	}
	if mappedCwd := sess.mapRequestCwd(req.Cwd); mappedCwd != "" {
		wrap.WriteString("cd -- ")
		wrap.WriteString(shellSingleQuote(mappedCwd))
		wrap.WriteString(" || return $?\n")
	}
	wrap.WriteString("source ")
	wrap.WriteString(shellSingleQuote(userScriptPath))
	wrap.WriteByte('\n')

	if err := os.WriteFile(wrapScriptPath, []byte(wrap.String()), 0o600); err != nil {
		return nil, apperr.Internal("write wrapper command script", err)
	}

	proc := sess.proc
	outCap := &pipeCapture{
		marker:  marker,
		onChunk: req.OnStdout,
		done:    make(chan struct{}),
	}
	errCap := &pipeCapture{
		marker:  marker,
		onChunk: req.OnStderr,
		done:    make(chan struct{}),
	}
	proc.capMu.Lock()
	proc.stdoutCap = outCap
	proc.stderrCap = errCap
	proc.capMu.Unlock()

	timeout := time.Duration(req.TimeoutS) * time.Second
	if req.TimeoutS <= 0 {
		timeout = 60 * time.Second
	}
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	dispatchLine := fmt.Sprintf("%s|%s\n", tok, wrapScriptPath)
	if _, err := io.WriteString(proc.stdin, dispatchLine); err != nil {
		proc.killProcessGroup()
		sess.proc = nil
		return nil, apperr.Internal("write to bash stdin", err)
	}

	var exitCode int
	var timedOut bool

	for {
		select {
		case msg, ok := <-proc.ctrlCh:
			if !ok || msg.eof {
				// Shell exited explicitly (e.g. user ran `exit N`).
				waitCode := <-proc.waitCh
				<-outCap.done
				<-errCap.done
				sess.proc = nil
				_ = sess.ensureShellLocked()
				return &DriverExecResult{
					ExitCode: waitCode,
					Stdout:   outCap.buf.String(),
					Stderr:   errCap.buf.String(),
					Cwd:      sess.toVirtualCwd(sess.lastHostCwd),
					TimedOut: false,
				}, nil
			}
			if msg.token != tok {
				continue
			}
			exitCode = msg.exitCode
			if msg.pwd != "" {
				sess.lastHostCwd = msg.pwd
			}
			<-outCap.done
			<-errCap.done

			proc.capMu.Lock()
			proc.stdoutCap = nil
			proc.stderrCap = nil
			proc.capMu.Unlock()

			return &DriverExecResult{
				ExitCode: exitCode,
				Stdout:   outCap.buf.String(),
				Stderr:   errCap.buf.String(),
				Cwd:      sess.toVirtualCwd(sess.lastHostCwd),
				TimedOut: false,
			}, nil

		case <-execCtx.Done():
			timedOut = errors.Is(execCtx.Err(), context.DeadlineExceeded)
			proc.killProcessGroup()
			<-outCap.done
			<-errCap.done
			sess.proc = nil
			_ = sess.ensureShellLocked()
			return &DriverExecResult{
				ExitCode: 124,
				Stdout:   outCap.buf.String(),
				Stderr:   errCap.buf.String(),
				Cwd:      sess.toVirtualCwd(sess.lastHostCwd),
				TimedOut: timedOut,
			}, nil
		}
	}
}

func (d *LocalDriver) ApplyWorkspaceOps(_ context.Context, vmID string, ops []repo.WorkspaceFileOp) error {
	sess, err := d.getSession(vmID)
	if err != nil {
		return err
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return repo.ApplyOpsToDir(sess.workspaceDir, ops)
}

func (d *LocalDriver) ReplaceWorkspace(_ context.Context, vmID string, files map[string]repo.MaterializedFile) error {
	sess, err := d.getSession(vmID)
	if err != nil {
		return err
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return repo.WriteMaterializedFilesToDir(sess.workspaceDir, files)
}

func (d *LocalDriver) SnapshotWorkspace(_ context.Context, vmID string) (map[string]repo.MaterializedFile, error) {
	sess, err := d.getSession(vmID)
	if err != nil {
		return nil, err
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()
	return repo.ScanDirFiles(sess.workspaceDir)
}

func (d *LocalDriver) Stop(_ context.Context, vmID string) error {
	d.mu.Lock()
	sess, ok := d.sessions[vmID]
	if ok {
		delete(d.sessions, vmID)
	}
	d.mu.Unlock()
	if !ok {
		return nil
	}

	sess.mu.Lock()
	defer sess.mu.Unlock()
	if sess.proc != nil {
		sess.proc.killProcessGroup()
		sess.proc = nil
	}
	_ = os.RemoveAll(sess.baseDir)
	return nil
}

func (d *LocalDriver) Close() error {
	d.mu.Lock()
	ids := make([]string, 0, len(d.sessions))
	for id := range d.sessions {
		ids = append(ids, id)
	}
	d.mu.Unlock()

	for _, id := range ids {
		_ = d.Stop(context.Background(), id)
	}
	return nil
}
