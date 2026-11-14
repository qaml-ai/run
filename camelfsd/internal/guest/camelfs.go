package guest

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/qaml-ai/run/camelfsd/internal/wire"
	"golang.org/x/sys/unix"
)

const maxSafeInteger = 1<<53 - 1
const connectBudget = 10 * time.Second

var lowerTree = regexp.MustCompile(`^[a-f0-9]{40}$`)
var checkpointTree = regexp.MustCompile(`^[a-fA-F0-9]{40}$`)

type entry struct {
	Path  string `json:"path"`
	Mode  string `json:"mode"`
	SHA1  string `json:"sha1"`
	Ino   string `json:"ino"`
	Size  string `json:"size"`
	Mtime string `json:"mtimeNs"`
	Ctime string `json:"ctimeNs"`
}
type index struct {
	Tree    string  `json:"tree"`
	Entries []entry `json:"entries"`
}
type operation struct {
	Path   string  `json:"path"`
	Op     string  `json:"op"`
	Mode   string  `json:"mode,omitempty"`
	Size   *int64  `json:"size,omitempty"`
	Target *string `json:"target,omitempty"`
	End    bool    `json:"end,omitempty"`
	Error  string  `json:"error,omitempty"`
}

func checkPath(path string) error {
	switch {
	case path == "" || strings.HasPrefix(path, "/") || strings.ContainsRune(path, 0):
		return errors.New("invalid path: must be relative, nonempty and without NUL")
	case len(path) > 4096:
		return errors.New("path exceeds 4096 bytes")
	case !utf8.ValidString(path):
		return errors.New("path is not UTF-8")
	}
	parts := strings.Split(path, "/")
	for _, part := range parts {
		if part == "" || part == "." || part == ".." {
			return errors.New("invalid path component")
		}
		if len(part) > 255 {
			return errors.New("path component exceeds 255 bytes")
		}
	}
	if parts[0] == ".git" {
		return errors.New("path is under .git")
	}
	return nil
}

func modeBits(mode string) (os.FileMode, error) {
	switch mode {
	case "100644", "120000":
		return 0644, nil
	case "100755":
		return 0755, nil
	default:
		return 0, errors.New("invalid mode")
	}
}

func validSize(size *int64) bool { return size != nil && *size >= 0 && *size <= maxSafeInteger }

func snapshot(path, full, sha string) (entry, os.FileMode, error) {
	st, err := os.Lstat(full)
	if err != nil {
		return entry{}, 0, err
	}
	s := st.Sys().(*syscall.Stat_t)
	mode := "100644"
	switch {
	case st.Mode()&os.ModeSymlink != 0:
		mode = "120000"
	case st.Mode()&0100 != 0:
		mode = "100755"
	}
	return entry{path, mode, sha, strconv.FormatUint(s.Ino, 10), strconv.FormatInt(s.Size, 10),
		strconv.FormatInt(s.Mtim.Nano(), 10), strconv.FormatInt(s.Ctim.Nano(), 10)}, st.Mode(), nil
}

func (g *guest) indexPath() string {
	if g.vsock {
		return "/run/camelfs/index.json"
	}
	return filepath.Join(g.root, ".camelfs", "index.json")
}

func (g *guest) saveIndex(ctx context.Context, idx *index) error {
	b, err := json.Marshal(idx)
	if err != nil {
		return err
	}
	path := g.indexPath()
	if err = os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), ".index-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	_, err = f.Write(b)
	if err = errors.Join(err, f.Close()); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	g.index = idx
	return nil
}

func (g *guest) checkMount() error {
	if !g.vsock {
		return nil
	}
	b, err := os.ReadFile("/proc/self/mountinfo")
	if err != nil {
		return err
	}
	for _, line := range strings.Split(string(b), "\n") {
		parts := strings.Fields(line)
		if len(parts) > 4 && parts[4] == g.repo {
			return nil
		}
	}
	return errors.New("the camelFS repo disk is not mounted")
}

func streamContext(ctx context.Context, ms float64) (context.Context, context.CancelFunc) {
	return context.WithTimeout(ctx, time.Duration(min(max(1, ms), 2147483647)*float64(time.Millisecond)))
}

func interruptRead(ctx context.Context, c transport) func() bool {
	return context.AfterFunc(ctx, func() { c.SetDeadline(time.Now()) })
}

func streamError(ctx context.Context, err error, stage string) error {
	if err == nil {
		return nil
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || !time.Now().Before(deadline(ctx)) {
		return fmt.Errorf("camelFS %s timed out", stage)
	}
	return err
}

func deadline(ctx context.Context) time.Time {
	d, _ := ctx.Deadline()
	return d
}

func applyJSON(r io.Reader, value any) error {
	return readError(wire.JSON(r, value), "unexpected EOF in apply stream")
}

func (g *guest) apply(parent context.Context, req request) (result message, err error) {
	start := time.Now()
	ctx, cancel := streamContext(parent, req.TimeoutMs)
	defer cancel()
	if err = g.checkMount(); err != nil {
		return nil, err
	}
	ready := minTime(start.Add(connectBudget), deadline(ctx))
	c, err := g.dial(ctx, 5201, ready)
	if err != nil {
		return nil, streamError(ctx, err, "apply")
	}
	defer c.Close()
	stop := interruptRead(parent, c)
	defer func() {
		stop()
		err = streamError(ctx, err, "apply")
		if parent.Err() != nil {
			return
		}
		c.SetWriteDeadline(time.Now().Add(time.Second))
		if err != nil {
			wire.Send(c, message{"applied": false, "error": errorText(err)})
		} else {
			wire.Send(c, message{"applied": true, "applyMs": result["applyMs"]})
		}
	}()
	c.SetDeadline(ready)
	var h struct {
		wire.Header
		FromTree *string `json:"fromTree"`
	}
	if err = applyJSON(c, &h); err != nil {
		if !time.Now().Before(ready) {
			return nil, errors.New("apply connect timed out after 10 s")
		}
		return nil, err
	}
	if h.V != 1 || h.Kind != "apply" || h.JobID != req.JobID || h.FromTree == nil ||
		(*h.FromTree != "" && !lowerTree.MatchString(*h.FromTree)) || !lowerTree.MatchString(h.ToTree) {
		return nil, errors.New("invalid apply header or jobId")
	}
	c.SetDeadline(deadline(ctx))
	idx := &index{Tree: h.ToTree, Entries: []entry{}}
	if err = g.readIndex(c, idx); err != nil {
		return nil, err
	}
	if err = g.cleanTemps(ctx); err != nil {
		return nil, err
	}
	files := 0
	for {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		var op operation
		if err = applyJSON(c, &op); err != nil {
			return nil, err
		}
		if op.End {
			if op.Error != "" {
				return nil, errors.New(op.Error)
			}
			break
		}
		if err = g.applyOp(ctx, c, op); err != nil {
			return nil, err
		}
		files++
	}
	for i, e := range idx.Entries {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		path, err := g.target(e.Path)
		if err != nil {
			return nil, err
		}
		indexed, _, err := snapshot(e.Path, path, e.SHA1)
		if err != nil {
			return nil, err
		}
		indexed.Mode = e.Mode
		idx.Entries[i] = indexed
	}
	if err = g.saveIndex(ctx, idx); err != nil {
		return nil, err
	}
	return message{"applyMs": elapsed(start), "files": files, "entries": len(idx.Entries)}, nil
}

func minTime(a, b time.Time) time.Time {
	if a.Before(b) {
		return a
	}
	return b
}

func (g *guest) readIndex(r io.Reader, idx *index) error {
	for {
		var frame struct {
			Index []*struct {
				Path string
				Mode string
				SHA1 string
				Size *int64
			}
			IndexEnd bool
			Count    *int
		}
		if err := applyJSON(r, &frame); err != nil {
			return err
		}
		if frame.IndexEnd {
			if frame.Count == nil || *frame.Count != len(idx.Entries) {
				return errors.New("index count mismatch")
			}
			return nil
		}
		if frame.Index == nil {
			return errors.New("expected index frame")
		}
		for _, item := range frame.Index {
			if item == nil {
				return errors.New("invalid index entry")
			}
			if err := checkPath(item.Path); err != nil {
				return err
			}
			if _, err := modeBits(item.Mode); err != nil {
				return err
			}
			if !validSize(item.Size) {
				return errors.New("invalid size")
			}
			if !lowerTree.MatchString(item.SHA1) {
				return errors.New("invalid index sha1")
			}
			if len(idx.Entries) >= 1_000_000 {
				return errors.New("index exceeds 1000000 entries")
			}
			idx.Entries = append(idx.Entries, entry{Path: item.Path, Mode: item.Mode, SHA1: item.SHA1})
		}
	}
}

func (g *guest) target(path string) (string, error) {
	if err := checkPath(path); err != nil {
		return "", err
	}
	parts := strings.Split(path, "/")
	dir := g.repo
	for _, part := range parts[:len(parts)-1] {
		dir = filepath.Join(dir, part)
		err := os.Mkdir(dir, 0755)
		if err == nil {
			err = os.Chmod(dir, 0755)
		}
		if err != nil && !errors.Is(err, fs.ErrExist) {
			return "", err
		}
		st, err := os.Lstat(dir)
		if err != nil {
			return "", err
		}
		if !st.IsDir() {
			return "", errors.New("parent is a symlink or not a directory")
		}
	}
	return filepath.Join(dir, parts[len(parts)-1]), nil
}

func (g *guest) cleanTemps(ctx context.Context) error {
	return walkRepo(g.repo, func(full, rel string, d fs.DirEntry) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if !d.IsDir() && strings.HasPrefix(d.Name(), ".camelfs-tmp-") {
			return unix.Unlink(full)
		}
		return nil
	})
}

// Resolve the fake disk symlink once. WalkDir never follows descendants' symlinks.
func walkRepo(repo string, visit func(string, string, fs.DirEntry) error) error {
	root, err := filepath.EvalSymlinks(repo)
	if err != nil {
		return err
	}
	return filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil || path == root {
			return err
		}
		return visit(path, path[len(root)+1:], d)
	})
}

func (g *guest) applyOp(ctx context.Context, r io.Reader, op operation) error {
	path, err := g.target(op.Path)
	if err != nil {
		return err
	}
	switch op.Op {
	case "put":
		mode, err := modeBits(op.Mode)
		if err != nil {
			return err
		}
		if op.Mode == "120000" {
			return errors.New("mode 120000 is invalid with put")
		}
		if !validSize(op.Size) {
			return errors.New("invalid size")
		}
		return applyPut(ctx, r, path, mode, *op.Size)
	case "del":
		if err := unix.Unlink(path); err != nil {
			return err
		}
		for dir := filepath.Dir(path); dir != g.repo; dir = filepath.Dir(dir) {
			err := unix.Rmdir(dir)
			if err == unix.ENOTEMPTY || err == unix.EEXIST {
				break
			}
			if err != nil {
				return err
			}
		}
		return nil
	case "link":
		if op.Target == nil || len(*op.Target) > 4096 || strings.ContainsRune(*op.Target, 0) {
			return errors.New("invalid link target")
		}
		if err := unix.Unlink(path); err != nil && err != unix.ENOENT {
			return err
		}
		return os.Symlink(*op.Target, path)
	case "mode":
		mode, err := modeBits(op.Mode)
		if err != nil {
			return err
		}
		if op.Mode == "120000" {
			return errors.New("mode cannot change a symlink")
		}
		st, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return errors.New("mode cannot change a symlink")
		}
		return os.Chmod(path, mode)
	default:
		return errors.New("unknown apply op")
	}
}

func applyPut(ctx context.Context, r io.Reader, path string, mode os.FileMode, size int64) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".camelfs-tmp-")
	if err != nil {
		return err
	}
	defer f.Close()
	defer os.Remove(f.Name())
	for left := size; left > 0; {
		if err := ctx.Err(); err != nil {
			return err
		}
		b, err := wire.Read(r, wire.FrameMax)
		if err != nil {
			if errors.Is(err, wire.ErrEmptyFrame) {
				return errors.New("raw frame crosses declared size or exceeds rawMax")
			}
			return readError(err, "unexpected EOF in apply stream")
		}
		if len(b) > wire.DataMax || int64(len(b)) > left {
			return errors.New("raw frame crosses declared size or exceeds rawMax")
		}
		if _, err = f.Write(b); err != nil {
			return err
		}
		left -= int64(len(b))
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err = f.Sync(); err != nil {
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}
