package vm

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/store"
)

const (
	firecrackerHost  = "firecracker"
	guestBlobPort    = 10001
	maxBlobFetchSize = 512 * 1024 * 1024
)

type FirecrackerConfig struct {
	DataDir         string
	FirecrackerBin  string
	JailerBin       string
	KernelImagePath string
	RootfsImagePath string
	GetBlob         func(ctx context.Context, hash string) ([]byte, error)
	VsockPort       int
}

type fcVMFiles struct {
	kernel string
	rootfs string
	vsock  string
}

type fcVMSession struct {
	mu           sync.Mutex
	vmID         string
	baseDir      string
	apiSockPath  string
	vsockUDSPath string
	blobSockLn   net.Listener
	guestCID     uint32
	cmd          *exec.Cmd
	waitCh       chan struct{}
}

// FirecrackerDriver mounts repo workspaces lazily inside Firecracker guests via FUSE + overlayfs
// over virtio-vsock, with zero host ext4/NBD devices.
type FirecrackerDriver struct {
	cfg      FirecrackerConfig
	rootDir  string
	jailDir  string
	cgroup   string
	lock     *os.File
	mu       sync.RWMutex
	nextCID  uint32
	sessions map[string]*fcVMSession
}

func NewFirecrackerDriver(cfg FirecrackerConfig) (*FirecrackerDriver, error) {
	if cfg.FirecrackerBin == "" {
		cfg.FirecrackerBin = "firecracker"
	}
	if cfg.GetBlob == nil {
		return nil, fmt.Errorf("firecracker driver requires a GetBlob store callback")
	}
	if cfg.VsockPort <= 0 {
		cfg.VsockPort = 10000
	}
	rootDir, err := filepath.Abs(filepath.Join(cfg.DataDir, "firecracker-vms"))
	if err != nil {
		return nil, err
	}
	if err := os.MkdirAll(rootDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir firecracker vms dir: %w", err)
	}
	var jailDir, cgroup string
	if cfg.JailerBin != "" {
		cgroup, err = firecrackerServiceCgroup()
		if err != nil {
			return nil, err
		}
		for _, bin := range []*string{&cfg.FirecrackerBin, &cfg.JailerBin} {
			p, err := exec.LookPath(*bin)
			if err != nil {
				return nil, err
			}
			p, err = filepath.Abs(p)
			if err != nil {
				return nil, err
			}
			// The jailer names its directory after the resolved executable.
			*bin, err = filepath.EvalSymlinks(p)
			if err != nil {
				return nil, err
			}
		}
		jailDir = filepath.Join(rootDir, filepath.Base(cfg.FirecrackerBin))
	}
	lock, err := os.OpenFile(filepath.Join(rootDir, ".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, fmt.Errorf("open Firecracker data directory lock: %w", err)
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = lock.Close()
		return nil, fmt.Errorf("lock Firecracker data directory: %w", err)
	}
	return &FirecrackerDriver{
		cfg:      cfg,
		rootDir:  rootDir,
		jailDir:  jailDir,
		cgroup:   cgroup,
		lock:     lock,
		nextCID:  100,
		sessions: make(map[string]*fcVMSession),
	}, nil
}

// Recover retires orphaned Firecracker sessions owned by a previous daemon.
func (d *FirecrackerDriver) Recover(ctx context.Context, st store.Store) error {
	running, err := st.ListRunningVMs(ctx, true)
	if err != nil {
		return err
	}
	for _, rec := range running {
		if rec.HostID != firecrackerHost {
			continue
		}
		if err := retireLostVM(ctx, st, rec); err != nil {
			return err
		}
		log.Printf("camelfsd: retired lost Firecracker VM %s", rec.VMID)
	}

	if err := removeLostVMDirs(d.rootDir, "vm_"); err != nil {
		return err
	}
	if d.jailDir != "" {
		return removeLostVMDirs(d.jailDir, "vm-")
	}
	return nil
}

func removeLostVMDirs(dir, prefix string) error {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	for _, entry := range entries {
		id, ok := strings.CutPrefix(entry.Name(), prefix)
		if !entry.IsDir() || !ok || len(id) != 24 {
			continue
		}
		if _, err := hex.DecodeString(id); err != nil {
			continue
		}
		if err := os.RemoveAll(filepath.Join(dir, entry.Name())); err != nil {
			return fmt.Errorf("remove scratch directory for lost VM %s: %w", entry.Name(), err)
		}
	}
	return nil
}

func (d *FirecrackerDriver) allocCID() uint32 {
	d.mu.Lock()
	defer d.mu.Unlock()
	d.nextCID++
	return d.nextCID
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
	vmDir := baseDir
	jailID := "vm-" + strings.TrimPrefix(spec.VMID, "vm_")
	if d.jailDir != "" {
		if err := os.MkdirAll(d.jailDir, 0700); err != nil {
			return "", apperr.Internal("mkdir Firecracker jail directory", err)
		}
		baseDir = filepath.Join(d.jailDir, jailID)
		vmDir = filepath.Join(baseDir, "root")
	}
	rootfsCopy := filepath.Join(vmDir, "rootfs.ext4")
	apiSock := filepath.Join(vmDir, "fc.sock")
	vsockUDS := filepath.Join(vmDir, "vsock.sock")
	blobSock := fmt.Sprintf("%s_%d", vsockUDS, guestBlobPort)
	if len(blobSock) >= 108 {
		return "", apperr.InvalidRequest("Firecracker socket path is too long. Use a shorter data directory")
	}

	if err := os.Mkdir(baseDir, 0700); err != nil {
		return "", apperr.Internal("mkdir Firecracker VM", err)
	}
	started := false
	defer func() {
		if !started {
			_ = os.RemoveAll(baseDir)
		}
	}()
	if d.jailDir != "" {
		if err := os.Mkdir(vmDir, 0700); err != nil {
			return "", apperr.Internal("mkdir Firecracker jail root", err)
		}
	}
	if err := copyFileReflinkOrCopy(d.cfg.RootfsImagePath, rootfsCopy); err != nil {
		return "", apperr.Internal("stage rootfs image", err)
	}

	// Listen on <vsockUDS>_10001 so the guest's lazy FUSE layer can fetch blobs on demand.
	blobLn, err := net.Listen("unix", blobSock)
	if err != nil {
		return "", apperr.Internal("listen Firecracker host blob socket", err)
	}
	defer func() {
		if !started {
			_ = blobLn.Close()
		}
	}()
	go d.serveBlobSocket(blobLn, spec.Tree)

	guestCID := d.allocCID()
	files := fcVMFiles{kernel: d.cfg.KernelImagePath, rootfs: rootfsCopy, vsock: vsockUDS}
	cmd := exec.Command(d.cfg.FirecrackerBin, "--api-sock", apiSock)
	cmd.Dir = vmDir
	if d.jailDir != "" {
		uid := 201000 + int(guestCID)
		if err := prepareFirecrackerJail(vmDir, d.cfg.KernelImagePath, rootfsCopy, uid); err != nil {
			return "", apperr.Internal("prepare Firecracker jail", err)
		}
		if err := os.Chown(blobSock, uid, uid); err != nil {
			return "", apperr.Internal("chown Firecracker blob socket", err)
		}
		files = fcVMFiles{kernel: "/kernel", rootfs: "/rootfs.ext4", vsock: "/vsock.sock"}
		uidStr := strconv.Itoa(uid)
		cmd = exec.Command(d.cfg.JailerBin, "--id", jailID, "--exec-file", d.cfg.FirecrackerBin,
			"--uid", uidStr, "--gid", uidStr, "--chroot-base-dir", d.rootDir,
			"--cgroup-version", "2", "--parent-cgroup", d.cgroup, "--", "--api-sock", "/fc.sock")
	}
	cmd.Stderr = os.Stderr
	waitCh, err := launchFirecracker(cmd)
	if err != nil {
		return "", apperr.Internal("launch firecracker", err)
	}

	sess := &fcVMSession{
		vmID:         spec.VMID,
		baseDir:      baseDir,
		apiSockPath:  apiSock,
		vsockUDSPath: vsockUDS,
		blobSockLn:   blobLn,
		guestCID:     guestCID,
		cmd:          cmd,
		waitCh:       waitCh,
	}

	if err := d.configureAndBoot(ctx, sess, files, spec); err != nil {
		sess.kill()
		log.Printf("camelfsd: configure Firecracker VM %s: %v", spec.VMID, err)
		return "", apperr.Internal("configure firecracker microVM", err)
	}

	d.mu.Lock()
	d.sessions[spec.VMID] = sess
	d.mu.Unlock()
	started = true
	return firecrackerHost, nil
}

func (d *FirecrackerDriver) serveBlobSocket(ln net.Listener, tree []repo.TreeEntry) {
	allowed := make(map[string]struct{}, len(tree))
	for _, entry := range tree {
		if entry.Hash != "" {
			allowed[entry.Hash] = struct{}{}
		}
	}
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go serveBlobConn(conn, allowed, d.cfg.GetBlob)
	}
}

func serveBlobConn(conn net.Conn, allowed map[string]struct{}, getBlob func(ctx context.Context, hash string) ([]byte, error)) {
	defer conn.Close()
	requests := bufio.NewScanner(conn)
	requests.Buffer(make([]byte, 128), 128) // A request is a SHA-256 hex digest and a newline.
	var hdr [9]byte
	for requests.Scan() {
		hash := requests.Text()
		var data []byte
		var err error
		if _, ok := allowed[hash]; ok {
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			data, err = getBlob(ctx, hash)
			cancel()
		} else {
			err = os.ErrNotExist
		}
		if err != nil {
			msg := []byte(err.Error())
			hdr[0] = 1
			binary.BigEndian.PutUint64(hdr[1:9], uint64(len(msg)))
			if _, wErr := conn.Write(hdr[:]); wErr != nil {
				return
			}
			if _, wErr := conn.Write(msg); wErr != nil {
				return
			}
			continue
		}
		hdr[0] = 0
		binary.BigEndian.PutUint64(hdr[1:9], uint64(len(data)))
		if _, wErr := conn.Write(hdr[:]); wErr != nil {
			return
		}
		if len(data) > 0 {
			if _, wErr := conn.Write(data); wErr != nil {
				return
			}
		}
	}
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

func (d *FirecrackerDriver) configureAndBoot(ctx context.Context, sess *fcVMSession, files fcVMFiles, spec StartSpec) error {
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(sess.apiSockPath); err == nil {
			break
		}
		select {
		case <-sess.waitCh:
			return fmt.Errorf("Firecracker exited before creating its API socket")
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(15 * time.Millisecond):
		}
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
		"kernel_image_path": files.kernel,
		"boot_args":         "console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw devtmpfs.mount=1 init=/sbin/camelfs-guest-init",
	}); err != nil {
		return err
	}
	if err := fcPutJSON(ctx, hc, "/drives/rootfs", map[string]any{
		"drive_id":       "rootfs",
		"path_on_host":   files.rootfs,
		"is_root_device": true,
		"is_read_only":   false,
	}); err != nil {
		return err
	}
	if err := fcPutJSON(ctx, hc, "/vsock", map[string]any{
		"vsock_id":  "vsock0",
		"guest_cid": sess.guestCID,
		"uds_path":  files.vsock,
	}); err != nil {
		return err
	}
	if err := fcPutJSON(ctx, hc, "/actions", map[string]any{
		"action_type": "InstanceStart",
	}); err != nil {
		return err
	}

	readyCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for {
		conn, reader, err := d.dialGuestVsock(readyCtx, sess)
		if err == nil {
			// Send the metadata on the ready connection. The guest handles requests
			// serially, so it never needs to drain an empty probe before mounting.
			err = exchangeVsockRPC(conn, reader, map[string]any{
				"op":   "mount_fuse",
				"tree": spec.Tree,
			}, nil, nil, nil)
			_ = conn.Close()
			if err != nil {
				return fmt.Errorf("mount lazy workspace in guest: %w", err)
			}
			break
		}
		select {
		case <-readyCtx.Done():
			return fmt.Errorf("workspace guest did not become ready: %w", err)
		case <-sess.waitCh:
			return fmt.Errorf("firecracker exited before workspace was ready")
		case <-time.After(20 * time.Millisecond):
		}
	}

	if len(spec.Env) > 0 {
		return d.vsockRPC(readyCtx, sess, map[string]any{
			"op":  "init_env",
			"env": spec.Env,
		}, nil, nil, nil)
	}
	return nil
}

type guestDeltaPut struct {
	Path   string `json:"path"`
	Mode   int    `json:"mode"`
	Base64 string `json:"base64,omitempty"`
}

type vsockStreamFrame struct {
	Type      string             `json:"type"` // stdout | stderr | result | read | list | grep | delta | ok | error
	Chunk     string             `json:"chunk,omitempty"`
	ExitCode  int                `json:"exitCode,omitempty"`
	Cwd       string             `json:"cwd,omitempty"`
	TimedOut  bool               `json:"timedOut,omitempty"`
	Read      *repo.ReadResponse `json:"read,omitempty"`
	Entries   []repo.TreeEntry   `json:"entries,omitempty"`
	Matches   []repo.GrepMatch   `json:"matches,omitempty"`
	Puts      []guestDeltaPut    `json:"puts,omitempty"`
	Deletes   []string           `json:"deletes,omitempty"`
	ErrorCode string             `json:"errorCode,omitempty"`
	Error     string             `json:"error,omitempty"`
}

func (d *FirecrackerDriver) dialGuestVsock(ctx context.Context, sess *fcVMSession) (net.Conn, *bufio.Reader, error) {
	dialer := &net.Dialer{Timeout: 3 * time.Second}
	conn, err := dialer.DialContext(ctx, "unix", sess.vsockUDSPath)
	if err != nil {
		return nil, nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
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
	return exchangeVsockRPC(conn, br, payload, onStdout, onStderr, outFinal)
}

func exchangeVsockRPC(conn net.Conn, br *bufio.Reader, payload any, onStdout, onStderr func(string), outFinal *vsockStreamFrame) error {
	reqBytes, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	reqBytes = append(reqBytes, '\n')
	if _, err := conn.Write(reqBytes); err != nil {
		return err
	}

	var stdoutBuf strings.Builder
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
					if onStderr != nil {
						onStderr(frame.Chunk)
					}
				case "error":
					switch apperr.Code(frame.ErrorCode) {
					case apperr.CodeNotFound:
						return apperr.NotFound(frame.Error)
					case apperr.CodeInvalidRequest:
						return apperr.InvalidRequest(frame.Error)
					}
					return errors.New(frame.Error)
				case "result", "read", "list", "grep", "delta", "ok":
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
				return io.ErrUnexpectedEOF
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

func (d *FirecrackerDriver) ReadWorkspaceFile(ctx context.Context, vmID, commitHash, path string, offset, limit int64) (*repo.ReadResponse, error) {
	sess, err := d.getSession(vmID)
	if err != nil {
		return nil, err
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()

	var frame vsockStreamFrame
	if err := d.vsockRPC(ctx, sess, map[string]any{
		"op":     "read_file",
		"path":   path,
		"offset": offset,
		"limit":  limit,
	}, nil, nil, &frame); err != nil {
		return nil, err
	}
	if frame.Read == nil {
		return nil, apperr.Internal("missing read response from guest", nil)
	}
	frame.Read.Commit = commitHash
	return frame.Read, nil
}

func (d *FirecrackerDriver) ListWorkspaceEntries(ctx context.Context, vmID, dirPrefix string, recursive bool, glob string) ([]repo.TreeEntry, error) {
	sess, err := d.getSession(vmID)
	if err != nil {
		return nil, err
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()

	var frame vsockStreamFrame
	if err := d.vsockRPC(ctx, sess, map[string]any{
		"op":        "list_files",
		"path":      dirPrefix,
		"recursive": recursive,
		"glob":      glob,
	}, nil, nil, &frame); err != nil {
		return nil, err
	}
	if frame.Entries == nil {
		return []repo.TreeEntry{}, nil
	}
	return frame.Entries, nil
}

func (d *FirecrackerDriver) GrepWorkspace(ctx context.Context, vmID string, req repo.GrepRequest) ([]repo.GrepMatch, error) {
	sess, err := d.getSession(vmID)
	if err != nil {
		return nil, err
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()

	var frame vsockStreamFrame
	if err := d.vsockRPC(ctx, sess, map[string]any{
		"op":         "grep_files",
		"pattern":    req.Pattern,
		"path":       req.PathPrefix,
		"maxMatches": req.MaxMatches,
	}, nil, nil, &frame); err != nil {
		return nil, err
	}
	if frame.Matches == nil {
		return []repo.GrepMatch{}, nil
	}
	return frame.Matches, nil
}

func (d *FirecrackerDriver) CheckpointWorkspace(ctx context.Context, vmID string) (*DriverCheckpoint, error) {
	sess, err := d.getSession(vmID)
	if err != nil {
		return nil, err
	}
	sess.mu.Lock()
	defer sess.mu.Unlock()

	var frame vsockStreamFrame
	if err := d.vsockRPC(ctx, sess, map[string]any{"op": "collect_delta"}, nil, nil, &frame); err != nil {
		return nil, apperr.Internal("collect firecracker overlay delta", err)
	}
	puts := make([]repo.MaterializedFile, 0, len(frame.Puts))
	for _, p := range frame.Puts {
		var data []byte
		if p.Base64 != "" {
			data, err = base64.StdEncoding.DecodeString(p.Base64)
			if err != nil {
				return nil, apperr.Internal("decode guest delta payload", err)
			}
		}
		mode := p.Mode
		if mode == 0 {
			mode = repo.DefaultFileMode
		}
		puts = append(puts, repo.MaterializedFile{Path: p.Path, Mode: mode, Data: data})
	}
	return &DriverCheckpoint{
		Delta:   true,
		Puts:    puts,
		Deletes: frame.Deletes,
	}, nil
}

func (s *fcVMSession) kill() {
	if s.blobSockLn != nil {
		_ = s.blobSockLn.Close()
	}
	if s.cmd != nil && s.cmd.Process != nil {
		_ = s.cmd.Process.Kill()
		<-s.waitCh
	}
}

func (d *FirecrackerDriver) Stop(ctx context.Context, vmID string) error {
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
	umountCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	_ = d.vsockRPC(umountCtx, sess, map[string]any{"op": "unmount"}, nil, nil, nil)
	cancel()
	sess.kill()
	return os.RemoveAll(sess.baseDir)
}

func (d *FirecrackerDriver) Close() error {
	d.mu.Lock()
	ids := make([]string, 0, len(d.sessions))
	for id := range d.sessions {
		ids = append(ids, id)
	}
	d.mu.Unlock()
	var err error
	for _, id := range ids {
		err = errors.Join(err, d.Stop(context.Background(), id))
	}
	return errors.Join(err, d.lock.Close())
}
