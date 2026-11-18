package vm

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"

	"golang.org/x/sys/unix"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/fuseoverlay"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
)

const guestWorkspace = "/workspace"

type guestRequest struct {
	Op         string            `json:"op"`
	Command    string            `json:"command,omitempty"`
	Cwd        string            `json:"cwd,omitempty"`
	TimeoutS   int               `json:"timeoutS,omitempty"`
	Env        map[string]string `json:"env,omitempty"`
	Tree       []repo.TreeEntry  `json:"tree,omitempty"`
	Path       string            `json:"path,omitempty"`
	Offset     int64             `json:"offset,omitempty"`
	Limit      int64             `json:"limit,omitempty"`
	Recursive  bool              `json:"recursive,omitempty"`
	Glob       string            `json:"glob,omitempty"`
	Pattern    string            `json:"pattern,omitempty"`
	MaxMatches int               `json:"maxMatches,omitempty"`
	Ops        []struct {
		Kind string `json:"kind"`
		Path string `json:"path"`
		From string `json:"from,omitempty"`
		Mode int    `json:"mode,omitempty"`
		Data []byte `json:"base64,omitempty"`
	} `json:"ops,omitempty"`
}

type guestRuntime struct {
	session *localVMSession
	ctrlDir string
	fuse    *fuseoverlay.MountSession
	tracker *fuseoverlay.DeltaTracker
}

type vsockBlobClient struct {
	port uint32
}

func (c *vsockBlobClient) FetchBlob(ctx context.Context, hash string) ([]byte, error) {
	fd, err := unix.Socket(unix.AF_VSOCK, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("vsock blob socket: %w", err)
	}
	f := os.NewFile(uintptr(fd), "vsock-blob")
	defer f.Close()

	if err := unix.Connect(fd, &unix.SockaddrVM{CID: unix.VMADDR_CID_HOST, Port: c.port}); err != nil {
		return nil, fmt.Errorf("connect host blob port %d: %w", c.port, err)
	}
	if dl, ok := ctx.Deadline(); ok {
		_ = f.SetDeadline(dl)
	}
	if _, err := io.WriteString(f, hash+"\n"); err != nil {
		return nil, err
	}
	br := bufio.NewReader(f)
	var hdr [9]byte
	if _, err := io.ReadFull(br, hdr[:]); err != nil {
		return nil, err
	}
	size := binary.BigEndian.Uint64(hdr[1:9])
	if size > maxBlobFetchSize {
		return nil, fmt.Errorf("blob %s exceeds max size (%d)", hash, size)
	}
	buf := make([]byte, int(size))
	if size > 0 {
		if _, err := io.ReadFull(br, buf); err != nil {
			return nil, err
		}
	}
	if hdr[0] != 0 {
		return nil, fmt.Errorf("host blob error for %s: %s", hash, string(buf))
	}
	return buf, nil
}

// ServeFirecrackerGuest mounts /proc and /sys as PID 1 and listens on AF_VSOCK for host commands.
func ServeFirecrackerGuest() error {
	if os.Getpid() != 1 {
		return fmt.Errorf("guest init must run as PID 1")
	}
	if os.Getenv("PATH") == "" {
		if err := os.Setenv("PATH", defaultShellPath); err != nil {
			return err
		}
	}
	if _, err := exec.LookPath("bash"); err != nil {
		return fmt.Errorf("find guest bash: %w", err)
	}
	for _, mount := range []struct {
		source string
		target string
		fs     string
		flags  uintptr
	}{
		{"proc", "/proc", "proc", unix.MS_NOSUID | unix.MS_NOEXEC | unix.MS_NODEV},
		{"sysfs", "/sys", "sysfs", unix.MS_NOSUID | unix.MS_NOEXEC | unix.MS_NODEV},
	} {
		if err := os.MkdirAll(mount.target, 0755); err != nil {
			return err
		}
		if err := unix.Mount(mount.source, mount.target, mount.fs, mount.flags, ""); err != nil {
			return fmt.Errorf("mount %s at %s: %w", mount.source, mount.target, err)
		}
	}

	_ = os.MkdirAll("/run", 0755)
	_ = os.MkdirAll(guestWorkspace, 0755)
	ctrlDir, err := os.MkdirTemp("/run", "camelfs-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(ctrlDir)

	rt := &guestRuntime{
		ctrlDir: ctrlDir,
		session: newLocalSession("guest", ctrlDir, guestWorkspace, ctrlDir, nil),
	}

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
		serveGuestRequest(file, rt)
		_ = file.Close()
	}
}

func serveGuestRequest(conn *os.File, rt *guestRuntime) {
	var req guestRequest
	if err := json.NewDecoder(conn).Decode(&req); err != nil {
		return
	}
	send := json.NewEncoder(conn).Encode
	if err := runGuestRequest(req, rt, send); err != nil {
		frame := vsockStreamFrame{Type: "error", Error: err.Error()}
		if ae, ok := apperr.As(err); ok {
			frame.ErrorCode = string(ae.Code)
		}
		_ = send(frame)
	}
}

func runGuestRequest(req guestRequest, rt *guestRuntime, send func(any) error) error {
	switch req.Op {
	case "mount_fuse":
		if rt.fuse != nil {
			break
		}
		stateDir := filepath.Join(rt.ctrlDir, "overlay")
		if err := os.MkdirAll(stateDir, 0755); err != nil {
			return err
		}
		// Back upperdir/workdir with guest tmpfs for native-RAM write throughput (best-effort fallback to /run).
		_ = unix.Mount("tmpfs", stateDir, "tmpfs", 0, "size=50%")

		manifest := make([]fuseoverlay.TreeEntry, 0, len(req.Tree))
		basePaths := make([]string, 0, len(req.Tree))
		for _, ent := range req.Tree {
			basePaths = append(basePaths, ent.Path)
			mode := fuseoverlay.S_IFREG | uint32(ent.Mode&0o777)
			if ent.Type == "dir" {
				mode = fuseoverlay.S_IFDIR | 0o755
			}
			manifest = append(manifest, fuseoverlay.TreeEntry{
				Path:     ent.Path,
				Mode:     mode,
				Size:     uint64(ent.Size),
				BlobHash: ent.Hash,
			})
		}
		mnt, err := fuseoverlay.Mount(
			context.Background(),
			manifest,
			&vsockBlobClient{port: guestBlobPort},
			fuseoverlay.ServerConfig{},
			stateDir,
			guestWorkspace,
		)
		if err != nil {
			return err
		}
		rt.fuse = mnt
		rt.tracker = fuseoverlay.NewDeltaTracker(mnt.UpperDir, basePaths, nil)
	case "init_env":
		if rt.session.proc != nil {
			return fmt.Errorf("guest shell already initialized")
		}
		rt.session.initEnv = req.Env
	case "exec":
		var writeMu sync.Mutex
		var writeErr error
		stream := func(kind, chunk string) {
			writeMu.Lock()
			defer writeMu.Unlock()
			if writeErr == nil {
				writeErr = send(vsockStreamFrame{Type: kind, Chunk: chunk})
			}
		}
		out, err := rt.session.execLocked(context.Background(), DriverExecRequest{
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
				return apperr.InvalidRequest("invalid workspace operation path")
			}
			switch op.Kind {
			case "put", "move", "delete":
			default:
				return apperr.InvalidRequestf("unknown workspace operation %q", op.Kind)
			}
			ops = append(ops, repo.WorkspaceFileOp{Kind: op.Kind, Path: op.Path, From: op.From, Mode: op.Mode, Data: op.Data})
		}
		if err := repo.ApplyOpsToDir(guestWorkspace, ops); err != nil {
			return err
		}
		if rt.tracker != nil {
			syncOps := make([]fuseoverlay.SyncOp, 0, len(req.Ops))
			for _, op := range req.Ops {
				syncOps = append(syncOps, fuseoverlay.SyncOp{Kind: op.Kind, Path: op.Path, From: op.From})
			}
			if err := rt.tracker.SyncOps(syncOps); err != nil {
				return err
			}
		}
	case "collect_delta":
		if rt.tracker == nil {
			return send(vsockStreamFrame{Type: "delta"})
		}
		delta, err := rt.tracker.Collect()
		if err != nil {
			return err
		}
		puts := make([]guestDeltaPut, 0, len(delta.Puts))
		for _, p := range delta.Puts {
			if p.Mode&fuseoverlay.S_IFMT != fuseoverlay.S_IFREG {
				continue
			}
			mode := repo.DefaultFileMode
			if p.Mode&0o111 != 0 {
				mode = repo.ExecFileMode
			}
			puts = append(puts, guestDeltaPut{
				Path:   p.Path,
				Mode:   mode,
				Base64: base64.StdEncoding.EncodeToString(p.Data),
			})
		}
		return send(vsockStreamFrame{Type: "delta", Puts: puts, Deletes: delta.Deletes})
	case "read_file":
		resp, err := repo.DirReadFile(guestWorkspace, "", req.Path, req.Offset, req.Limit)
		if err != nil {
			return err
		}
		return send(vsockStreamFrame{Type: "read", Read: resp})
	case "list_files":
		entries, err := repo.DirListEntries(guestWorkspace, req.Path, req.Recursive, req.Glob)
		if err != nil {
			return err
		}
		return send(vsockStreamFrame{Type: "list", Entries: entries})
	case "grep_files":
		matches, err := repo.DirGrepFiles(guestWorkspace, repo.GrepRequest{
			Pattern:    req.Pattern,
			PathPrefix: req.Path,
			MaxMatches: req.MaxMatches,
		})
		if err != nil {
			return err
		}
		return send(vsockStreamFrame{Type: "grep", Matches: matches})
	case "unmount":
		if rt.session.proc != nil {
			rt.session.proc.killProcessGroup()
			rt.session.proc = nil
		}
		unix.Sync()
		if rt.fuse != nil {
			err := rt.fuse.Close()
			rt.fuse = nil
			return err
		}
	default:
		return fmt.Errorf("unknown guest operation %q", req.Op)
	}
	return send(vsockStreamFrame{Type: "ok"})
}

func validGuestPath(p string) bool {
	return filepath.IsLocal(p) && p != "." && filepath.Clean(p) == p
}
