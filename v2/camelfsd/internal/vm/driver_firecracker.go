package vm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
)

type FirecrackerConfig struct {
	DataDir          string
	FirecrackerBin   string
	KernelImagePath  string
	RootfsImagePath  string
	WorkspaceSizeMiB int
	VsockPort        int
}

type fcVMSession struct {
	mu           sync.Mutex
	vmID         string
	baseDir      string
	workspaceDir string
	ext4Path     string
	apiSockPath  string
	vsockUDSPath string
	guestCID     uint32
	cmd          *exec.Cmd
	waitCh       chan struct{}
}

// FirecrackerDriver boots isolated Firecracker microVMs on Linux with a host-materialized
// ext4 /workspace block device and communicates with the guest's persistent bash agent over vsock.
type FirecrackerDriver struct {
	cfg      FirecrackerConfig
	rootDir  string
	mu       sync.RWMutex
	nextCID  uint32
	sessions map[string]*fcVMSession
}

func NewFirecrackerDriver(cfg FirecrackerConfig) (*FirecrackerDriver, error) {
	if cfg.FirecrackerBin == "" {
		cfg.FirecrackerBin = "firecracker"
	}
	if cfg.WorkspaceSizeMiB <= 0 {
		cfg.WorkspaceSizeMiB = 512
	}
	if cfg.VsockPort <= 0 {
		cfg.VsockPort = 10000
	}
	rootDir := filepath.Join(cfg.DataDir, "firecracker-vms")
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir firecracker vms dir: %w", err)
	}
	return &FirecrackerDriver{
		cfg:      cfg,
		rootDir:  rootDir,
		nextCID:  100,
		sessions: make(map[string]*fcVMSession),
	}, nil
}

func (d *FirecrackerDriver) allocCID() uint32 {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.nextCID++
	return d.nextCID
}

func buildExt4FromDir(ctx context.Context, srcDir, imgPath string, sizeMiB int) error {
	sizeSpec := fmt.Sprintf("%dM", sizeMiB)
	cmd := exec.CommandContext(ctx, "mkfs.ext4", "-F", "-q", "-d", srcDir, imgPath, sizeSpec)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("mkfs.ext4 failed: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func fcPutJSON(ctx context.Context, hc *http.Client, path string, body any) error {
	raw, err := json.Marshal(body)
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPut, "http://localhost"+path, bytes.NewReader(raw))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := hc.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		msg, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("firecracker PUT %s status %d: %s", path, resp.StatusCode, strings.TrimSpace(string(msg)))
	}
	return nil
}

func newUnixHTTPClient(sockPath string) *http.Client {
	dialer := &net.Dialer{Timeout: 2 * time.Second}
	return &http.Client{
		Timeout: 10 * time.Second,
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
				return dialer.DialContext(ctx, "unix", sockPath)
			},
		},
	}
}

func (d *FirecrackerDriver) Start(ctx context.Context, spec StartSpec) (string, error) {
	if d.cfg.KernelImagePath == "" || d.cfg.RootfsImagePath == "" {
		return "", apperr.InvalidRequest("firecracker driver requires --firecracker-kernel and --firecracker-rootfs")
	}

	baseDir := filepath.Join(d.rootDir, spec.VMID)
	workspaceDir := filepath.Join(baseDir, "workspace")
	ext4Path := filepath.Join(baseDir, "workspace.ext4")
	rootfsCopy := filepath.Join(baseDir, "rootfs.ext4")
	apiSock := filepath.Join(baseDir, "fc.sock")
	vsockUDS := filepath.Join(baseDir, "vsock.sock")

	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		return "", apperr.Internal("mkdir fc workspace", err)
	}
	// Materialize /workspace on the host BEFORE building the ext4 image and booting Firecracker.
	if err := repo.WriteMaterializedFilesToDir(workspaceDir, spec.Files); err != nil {
		_ = os.RemoveAll(baseDir)
		return "", err
	}
	if err := buildExt4FromDir(ctx, workspaceDir, ext4Path, d.cfg.WorkspaceSizeMiB); err != nil {
		_ = os.RemoveAll(baseDir)
		return "", apperr.Internal("build workspace ext4 image", err)
	}
	if err := copyFileReflinkOrCopy(d.cfg.RootfsImagePath, rootfsCopy); err != nil {
		_ = os.RemoveAll(baseDir)
		return "", apperr.Internal("stage rootfs image", err)
	}

	cid := d.allocCID()
	cmd := exec.Command(d.cfg.FirecrackerBin, "--api-sock", apiSock)
	cmd.Dir = baseDir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	waitCh := make(chan struct{})
	if err := cmd.Start(); err != nil {
		_ = os.RemoveAll(baseDir)
		return "", apperr.Internal("launch firecracker", err)
	}
	go func() {
		_ = cmd.Wait()
		close(waitCh)
	}()

	sess := &fcVMSession{
		vmID:         spec.VMID,
		baseDir:      baseDir,
		workspaceDir: workspaceDir,
		ext4Path:     ext4Path,
		apiSockPath:  apiSock,
		vsockUDSPath: vsockUDS,
		guestCID:     cid,
		cmd:          cmd,
		waitCh:       waitCh,
	}

	if err := d.configureAndBoot(ctx, sess, rootfsCopy, spec); err != nil {
		sess.kill()
		_ = os.RemoveAll(baseDir)
		return "", apperr.Internal("configure firecracker microVM", err)
	}

	d.mu.Lock()
	d.sessions[spec.VMID] = sess
	d.mu.Unlock()
	return "firecracker", nil
}

func copyFileReflinkOrCopy(src, dst string) error {
	if out, err := exec.Command("cp", "--reflink=auto", src, dst).CombinedOutput(); err == nil {
		_ = out
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	_, err = io.Copy(out, in)
	return err
}

func (d *FirecrackerDriver) configureAndBoot(ctx context.Context, sess *fcVMSession, rootfsPath string, spec StartSpec) error {
	// Wait up to 3s for Firecracker API socket to appear.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(sess.apiSockPath); err == nil {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}

	hc := newUnixHTTPClient(sess.apiSockPath)
	vcpus := spec.VCPUs
	if vcpus <= 0 {
		vcpus = 2
	}
	memMiB := spec.MemoryMiB
	if memMiB <= 0 {
		memMiB = 2048
	}

	if err := fcPutJSON(ctx, hc, "/machine-config", map[string]any{
		"vcpu_count":   vcpus,
		"mem_size_mib": memMiB,
		"smt":          false,
	}); err != nil {
		return err
	}
	if err := fcPutJSON(ctx, hc, "/boot-source", map[string]any{
		"kernel_image_path": d.cfg.KernelImagePath,
		"boot_args":         "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw init=/sbin/camelfs-guest-init",
	}); err != nil {
		return err
	}
	if err := fcPutJSON(ctx, hc, "/drives/rootfs", map[string]any{
		"drive_id":       "rootfs",
		"path_on_host":   rootfsPath,
		"is_root_device": true,
		"is_read_only":   false,
	}); err != nil {
		return err
	}
	if err := fcPutJSON(ctx, hc, "/drives/workspace", map[string]any{
		"drive_id":       "workspace",
		"path_on_host":   sess.ext4Path,
		"is_root_device": false,
		"is_read_only":   false,
	}); err != nil {
		return err
	}
	if err := fcPutJSON(ctx, hc, "/vsock", map[string]any{
		"vsock_id":  "vsock0",
		"guest_cid": sess.guestCID,
		"uds_path":  sess.vsockUDSPath,
	}); err != nil {
		return err
	}
	if err := fcPutJSON(ctx, hc, "/actions", map[string]any{
		"action_type": "InstanceStart",
	}); err != nil {
		return err
	}

	if len(spec.Env) > 0 {
		_ = d.vsockRPC(ctx, sess, map[string]any{
			"op":  "init_env",
			"env": spec.Env,
		}, nil, nil, nil)
	}
	return nil
}

type vsockStreamFrame struct {
	Type     string                        `json:"type"` // stdout | stderr | result | snapshot | error
	Chunk    string                        `json:"chunk,omitempty"`
	ExitCode int                           `json:"exitCode,omitempty"`
	Cwd      string                        `json:"cwd,omitempty"`
	TimedOut bool                          `json:"timedOut,omitempty"`
	Files    map[string]vsockWireFileEntry `json:"files,omitempty"`
	Error    string                        `json:"error,omitempty"`
}

type vsockWireFileEntry struct {
	Mode   int    `json:"mode"`
	Base64 string `json:"base64"`
}

func (d *FirecrackerDriver) dialGuestVsock(ctx context.Context, sess *fcVMSession) (net.Conn, *bufio.Reader, error) {
	dialer := &net.Dialer{Timeout: 3 * time.Second}
	conn, err := dialer.DialContext(ctx, "unix", sess.vsockUDSPath)
	if err != nil {
		return nil, nil, err
	}
	connectCmd := fmt.Sprintf("CONNECT %d\n", d.cfg.VsockPort)
	if _, err := io.WriteString(conn, connectCmd); err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	br := bufio.NewReader(conn)
	ack, err := br.ReadString('\n')
	if err != nil || !strings.HasPrefix(ack, "OK ") {
		_ = conn.Close()
		return nil, nil, fmt.Errorf("vsock handshake failed: %q (%v)", strings.TrimSpace(ack), err)
	}
	return conn, br, nil
}

func (d *FirecrackerDriver) vsockRPC(
	ctx context.Context,
	sess *fcVMSession,
	payload any,
	onStdout func(string),
	onStderr func(string),
	outFinal *vsockStreamFrame,
) error {
	conn, br, err := d.dialGuestVsock(ctx, sess)
	if err != nil {
		return err
	}
	defer conn.Close()

	if dl, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(dl)
	}
	reqBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	reqBytes = append(reqBytes, '\n')
	if _, err := conn.Write(reqBytes); err != nil {
		return err
	}

	var stdoutBuf, stderrBuf strings.Builder
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			var frame vsockStreamFrame
			if uErr := json.Unmarshal(line, &frame); uErr == nil {
				switch frame.Type {
				case "stdout":
					stdoutBuf.WriteString(frame.Chunk)
					if onStdout != nil {
						onStdout(frame.Chunk)
					}
				case "stderr":
					stderrBuf.WriteString(frame.Chunk)
					if onStderr != nil {
						onStderr(frame.Chunk)
					}
				case "error":
					return errors.New(frame.Error)
				case "result", "snapshot", "ok":
					if outFinal != nil {
						*outFinal = frame
						if outFinal.Chunk == "" {
							outFinal.Chunk = stdoutBuf.String()
						}
					}
					return nil
				}
			}
		}
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
	}
}

func (d *FirecrackerDriver) getSession(vmID string) (*fcVMSession, error) {
	d.mu.RLock()
	sess, ok := d.sessions[vmID]
	d.mu.RUnlock()
	if !ok {
		return nil, apperr.NotFoundf("firecracker VM session %q not found", vmID)
	}
	return sess, nil
}

func (d *FirecrackerDriver) Exec(ctx context.Context, req DriverExecRequest) (*DriverExecResult, error) {
	sess, err := d.getSession(req.VMID)
	if err != nil {
		return nil, err
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()

	timeout := time.Duration(req.TimeoutS) * time.Second
	if req.TimeoutS <= 0 {
		timeout = 60 * time.Second
	}
	execCtx, cancel := context.WithTimeout(ctx, timeout+5*time.Second)
	defer cancel()

	var stdoutAcc, stderrAcc strings.Builder
	var final vsockStreamFrame
	err = d.vsockRPC(
		execCtx,
		sess,
		map[string]any{
			"op":       "exec",
			"execId":   req.ExecID,
			"command":  req.Command,
			"cwd":      req.Cwd,
			"env":      req.Env,
			"timeoutS": req.TimeoutS,
		},
		func(ch string) {
			stdoutAcc.WriteString(ch)
			if req.OnStdout != nil {
				req.OnStdout(ch)
			}
		},
		func(ch string) {
			stderrAcc.WriteString(ch)
			if req.OnStderr != nil {
				req.OnStderr(ch)
			}
		},
		&final,
	)
	if err != nil {
		if errors.Is(execCtx.Err(), context.DeadlineExceeded) {
			return &DriverExecResult{
				ExitCode: 124,
				Stdout:   stdoutAcc.String(),
				Stderr:   stderrAcc.String(),
				Cwd:      "/workspace",
				TimedOut: true,
			}, nil
		}
		return nil, apperr.Internal("firecracker vsock exec", err)
	}
	cwd := final.Cwd
	if cwd == "" {
		cwd = "/workspace"
	}
	return &DriverExecResult{
		ExitCode: final.ExitCode,
		Stdout:   stdoutAcc.String(),
		Stderr:   stderrAcc.String(),
		Cwd:      cwd,
		TimedOut: final.TimedOut,
	}, nil
}

func (d *FirecrackerDriver) ApplyWorkspaceOps(ctx context.Context, vmID string, ops []repo.WorkspaceFileOp) error {
	sess, err := d.getSession(vmID)
	if err != nil {
		return err
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()

	if err := repo.ApplyOpsToDir(sess.workspaceDir, ops); err != nil {
		return err
	}
	type wireOp struct {
		Kind   string `json:"kind"`
		Path   string `json:"path"`
		From   string `json:"from,omitempty"`
		Mode   int    `json:"mode,omitempty"`
		Base64 string `json:"base64,omitempty"`
	}
	wOps := make([]wireOp, 0, len(ops))
	for _, op := range ops {
		wo := wireOp{Kind: op.Kind, Path: op.Path, From: op.From, Mode: op.Mode}
		if len(op.Data) > 0 {
			wo.Base64 = base64.StdEncoding.EncodeToString(op.Data)
		}
		wOps = append(wOps, wo)
	}
	return d.vsockRPC(ctx, sess, map[string]any{"op": "apply_ops", "ops": wOps}, nil, nil, nil)
}

func (d *FirecrackerDriver) ReplaceWorkspace(ctx context.Context, vmID string, files map[string]repo.MaterializedFile) error {
	sess, err := d.getSession(vmID)
	if err != nil {
		return err
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()

	if err := repo.WriteMaterializedFilesToDir(sess.workspaceDir, files); err != nil {
		return err
	}
	wireFiles := make(map[string]vsockWireFileEntry, len(files))
	for p, mf := range files {
		wireFiles[p] = vsockWireFileEntry{
			Mode:   mf.Mode,
			Base64: base64.StdEncoding.EncodeToString(mf.Data),
		}
	}
	return d.vsockRPC(ctx, sess, map[string]any{"op": "replace_workspace", "files": wireFiles}, nil, nil, nil)
}

func (d *FirecrackerDriver) SnapshotWorkspace(ctx context.Context, vmID string) (map[string]repo.MaterializedFile, error) {
	sess, err := d.getSession(vmID)
	if err != nil {
		return nil, err
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()

	var frame vsockStreamFrame
	if err := d.vsockRPC(ctx, sess, map[string]any{"op": "snapshot_workspace"}, nil, nil, &frame); err != nil {
		return nil, apperr.Internal("firecracker snapshot workspace", err)
	}
	out := make(map[string]repo.MaterializedFile, len(frame.Files))
	for p, wf := range frame.Files {
		raw, err := base64.StdEncoding.DecodeString(wf.Base64)
		if err != nil {
			return nil, apperr.Internal("decode guest file base64", err)
		}
		mode := wf.Mode
		if mode == 0 {
			mode = repo.DefaultFileMode
		}
		out[p] = repo.MaterializedFile{Path: p, Mode: mode, Data: raw}
	}
	// Mirror guest state back to host workspace dir.
	_ = repo.WriteMaterializedFilesToDir(sess.workspaceDir, out)
	return out, nil
}

func (s *fcVMSession) kill() {
	if s.cmd != nil && s.cmd.Process != nil {
		pgid, err := syscall.Getpgid(s.cmd.Process.Pid)
		if err == nil && pgid > 0 {
			_ = syscall.Kill(-pgid, syscall.SIGKILL)
		} else {
			_ = s.cmd.Process.Kill()
		}
		<-s.waitCh
	}
}

func (d *FirecrackerDriver) Stop(_ context.Context, vmID string) error {
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
	sess.kill()
	_ = os.RemoveAll(sess.baseDir)
	return nil
}

func (d *FirecrackerDriver) Close() error {
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
