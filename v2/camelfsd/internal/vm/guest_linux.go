package vm

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sync"

	"golang.org/x/sys/unix"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
)

const guestWorkspace = "/workspace"

type guestFile struct {
	Mode int    `json:"mode"`
	Data []byte `json:"base64"`
}

type guestRequest struct {
	Op       string
	Command  string
	Cwd      string
	TimeoutS int
	Env      map[string]string
	Ops      []struct {
		Kind string
		Path string
		From string
		Mode int
		// JSON decodes byte slices from the existing base64 wire field.
		Data []byte `json:"base64"`
	}
	Files map[string]guestFile
}

// ServeFirecrackerGuest mounts the workspace before listening for host commands.
// Only the Firecracker host can reach the listener. Commands run inside the VM.
func ServeFirecrackerGuest() error {
	if os.Getpid() != 1 {
		return fmt.Errorf("guest init must run as PID 1")
	}
	for _, mount := range []struct {
		source string
		target string
		fs     string
		flags  uintptr
	}{
		{"devtmpfs", "/dev", "devtmpfs", unix.MS_NOSUID},
		{"proc", "/proc", "proc", unix.MS_NOSUID | unix.MS_NOEXEC | unix.MS_NODEV},
		{"sysfs", "/sys", "sysfs", unix.MS_NOSUID | unix.MS_NOEXEC | unix.MS_NODEV},
		{"/dev/vdb", guestWorkspace, "ext4", unix.MS_NOSUID | unix.MS_NODEV},
	} {
		if err := os.MkdirAll(mount.target, 0755); err != nil {
			return err
		}
		if err := unix.Mount(mount.source, mount.target, mount.fs, mount.flags, ""); err != nil {
			return fmt.Errorf("mount %s at %s: %w", mount.source, mount.target, err)
		}
	}

	ctrlDir, err := os.MkdirTemp("/run", "camelfs-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(ctrlDir)
	session := newLocalSession("guest", ctrlDir, guestWorkspace, ctrlDir, nil)

	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(fd)
	if err := unix.Bind(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_ANY, Port: 10000}); err != nil {
		return err
	}
	if err := unix.Listen(fd, 8); err != nil {
		return err
	}
	for {
		conn, peer, err := unix.Accept4(fd, unix.SOCK_CLOEXEC)
		if err == unix.EINTR {
			continue
		}
		if err != nil {
			return err
		}
		if peer, ok := peer.(*unix.SockaddrVM); !ok || peer.CID != unix.VMADDR_CID_HOST {
			_ = unix.Close(conn)
			continue
		}
		file := os.NewFile(uintptr(conn), "vsock")
		serveGuestRequest(file, session)
		_ = file.Close()
	}
}

func serveGuestRequest(conn *os.File, session *localVMSession) {
	var req guestRequest
	if err := json.NewDecoder(conn).Decode(&req); err != nil {
		return
	}
	send := json.NewEncoder(conn).Encode
	if err := runGuestRequest(req, session, send); err != nil {
		_ = send(vsockStreamFrame{Type: "error", Error: err.Error()})
	}
}

func runGuestRequest(req guestRequest, session *localVMSession, send func(any) error) error {
	switch req.Op {
	case "init_env":
		if session.proc != nil {
			return fmt.Errorf("guest shell already initialized")
		}
		session.initEnv = req.Env
	case "exec":
		// The shell drains stdout and stderr on separate goroutines.
		var writeMu sync.Mutex
		var writeErr error
		stream := func(kind, chunk string) {
			writeMu.Lock()
			defer writeMu.Unlock()
			if writeErr == nil {
				writeErr = send(vsockStreamFrame{Type: kind, Chunk: chunk})
			}
		}
		out, err := session.execLocked(context.Background(), DriverExecRequest{
			Command: req.Command, Cwd: req.Cwd, TimeoutS: req.TimeoutS, Env: req.Env,
			OnStdout: func(chunk string) { stream("stdout", chunk) },
			OnStderr: func(chunk string) { stream("stderr", chunk) },
		})
		if err != nil {
			return err
		}
		if writeErr != nil {
			return writeErr
		}
		return send(vsockStreamFrame{Type: "result", Cwd: out.Cwd, ExitCode: out.ExitCode, TimedOut: out.TimedOut})
	case "apply_ops":
		ops := make([]repo.WorkspaceFileOp, 0, len(req.Ops))
		for _, op := range req.Ops {
			if !validGuestPath(op.Path) || (op.Kind == "move" && !validGuestPath(op.From)) {
				return fmt.Errorf("invalid workspace operation path")
			}
			switch op.Kind {
			case "put", "move", "delete":
			default:
				return fmt.Errorf("unknown workspace operation %q", op.Kind)
			}
			ops = append(ops, repo.WorkspaceFileOp{Kind: op.Kind, Path: op.Path, From: op.From, Mode: op.Mode, Data: op.Data})
		}
		if err := repo.ApplyOpsToDir(guestWorkspace, ops); err != nil {
			return err
		}
	case "replace_workspace":
		files := make(map[string]repo.MaterializedFile, len(req.Files))
		for p, f := range req.Files {
			if !validGuestPath(p) {
				return fmt.Errorf("invalid workspace file path")
			}
			files[p] = repo.MaterializedFile{Path: p, Mode: f.Mode, Data: f.Data}
		}
		if err := repo.WriteMaterializedFilesToDir(guestWorkspace, files); err != nil {
			return err
		}
	case "snapshot_workspace":
		files, err := repo.ScanDirFiles(guestWorkspace)
		if err != nil {
			return err
		}
		wireFiles := make(map[string]guestFile, len(files))
		for p, f := range files {
			wireFiles[p] = guestFile{Mode: f.Mode, Data: f.Data}
		}
		return send(struct {
			Type  string               `json:"type"`
			Files map[string]guestFile `json:"files"`
		}{Type: "snapshot", Files: wireFiles})
	default:
		return fmt.Errorf("unknown guest operation %q", req.Op)
	}
	return send(vsockStreamFrame{Type: "ok"})
}

func validGuestPath(p string) bool {
	return filepath.IsLocal(p) && p != "." && filepath.Clean(p) == p
}
