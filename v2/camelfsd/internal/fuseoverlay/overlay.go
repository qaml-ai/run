package fuseoverlay

import (
	"context"
	"crypto/sha256"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// DeltaPut records a created or modified file/symlink in overlayfs upperdir.
type DeltaPut struct {
	Path       string
	Mode       uint32
	Data       []byte
	LinkTarget string
}

// UpperDelta represents the O(delta) changes collected from overlayfs upperdir.
type UpperDelta struct {
	Puts    []DeltaPut
	Deletes []string
	Elapsed time.Duration
}

// MountSession holds an active Lazy-RO FUSE + overlayfs mount pair.
type MountSession struct {
	LowerDir  string
	UpperDir  string
	WorkDir   string
	MountDir  string
	Server    *ReadOnlyFuseServer
	fuseDev   *os.File
	cancel    context.CancelFunc
	serveDone chan error
}

// Mount mounts a ReadOnlyFuseServer at lowerDir and a writable overlayfs at mountDir.
func Mount(ctx context.Context, manifest []TreeEntry, fetcher BlobFetcher, cfg ServerConfig, stateDir, mountDir string) (*MountSession, error) {
	lowerDir := filepath.Join(stateDir, "lower")
	upperDir := filepath.Join(stateDir, "upper")
	workDir := filepath.Join(stateDir, "work")
	for _, d := range []string{lowerDir, upperDir, workDir, mountDir} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return nil, err
		}
	}

	srv := NewReadOnlyFuseServer(manifest, fetcher, cfg)
	// Use blocking I/O. Before mount binds the fd, poll reports /dev/fuse as
	// disconnected, which can make Go's poller reject subsequent reads.
	fd, err := unix.Open("/dev/fuse", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open /dev/fuse: %w", err)
	}
	dev := os.NewFile(uintptr(fd), "/dev/fuse")

	sCtx, cancel := context.WithCancel(ctx)
	s := &MountSession{
		LowerDir:  lowerDir,
		UpperDir:  upperDir,
		WorkDir:   workDir,
		MountDir:  mountDir,
		Server:    srv,
		fuseDev:   dev,
		cancel:    cancel,
		serveDone: make(chan error, 1),
	}

	opts := fmt.Sprintf("fd=%d,rootmode=040755,user_id=%d,group_id=%d,default_permissions", fd, os.Getuid(), os.Getgid())
	if os.Geteuid() == 0 {
		opts += ",allow_other"
	}

	if err := unix.Mount("camelfs-ro", lowerDir, "fuse", unix.MS_RDONLY|unix.MS_NOSUID|unix.MS_NODEV, opts); err != nil {
		cancel()
		_ = dev.Close()
		return nil, fmt.Errorf("mount fuse lowerdir: %w", err)
	}

	// Start serving /dev/fuse only after mount(2) binds the fd to the FUSE connection,
	// because reading an unbound /dev/fuse fd returns -EPERM on Linux.
	go func() {
		s.serveDone <- srv.ServeConcurrent(sCtx, dev)
	}()

	ovOpts := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s", lowerDir, upperDir, workDir)
	if err := unix.Mount("overlay", mountDir, "overlay", 0, ovOpts); err != nil {
		_ = unix.Unmount(lowerDir, unix.MNT_DETACH)
		cancel()
		_ = dev.Close()
		<-s.serveDone
		return nil, fmt.Errorf("mount overlayfs: %w", err)
	}
	return s, nil
}

// Close unmounts overlayfs and the underlying FUSE mount and waits for worker exit.
func (s *MountSession) Close() error {
	var firstErr error
	if err := unix.Unmount(s.MountDir, 0); err != nil {
		_ = unix.Unmount(s.MountDir, unix.MNT_DETACH)
		firstErr = err
	}
	if err := unix.Unmount(s.LowerDir, 0); err != nil {
		_ = unix.Unmount(s.LowerDir, unix.MNT_DETACH)
		if firstErr == nil {
			firstErr = err
		}
	}
	s.cancel()
	if s.fuseDev != nil {
		_ = s.fuseDev.Close()
	}
	if err := <-s.serveDone; err != nil && firstErr == nil {
		firstErr = err
	}
	return firstErr
}

// UpperInspect hooks low-level overlayfs markers so unit tests can exercise whiteouts/opaque dirs
// without CAP_MKNOD.
type UpperInspect struct {
	IsWhiteout func(fullPath string, info fs.FileInfo) bool
	IsOpaque   func(fullPath string) bool
}

func defaultInspect() UpperInspect {
	return UpperInspect{
		IsWhiteout: func(_ string, info fs.FileInfo) bool {
			if info.Mode()&os.ModeCharDevice == 0 {
				return false
			}
			st, ok := info.Sys().(*syscall.Stat_t)
			return ok && st.Rdev == 0
		},
		IsOpaque: func(fullPath string) bool {
			buf := make([]byte, 8)
			for _, attr := range []string{"trusted.overlay.opaque", "user.overlay.opaque"} {
				n, err := unix.Lgetxattr(fullPath, attr, buf)
				if err == nil && n > 0 && buf[0] == 'y' {
					return true
				}
			}
			return false
		},
	}
}

func resolveInspect(inspect *UpperInspect) UpperInspect {
	insp := defaultInspect()
	if inspect != nil {
		if inspect.IsWhiteout != nil {
			insp.IsWhiteout = inspect.IsWhiteout
		}
		if inspect.IsOpaque != nil {
			insp.IsOpaque = inspect.IsOpaque
		}
	}
	return insp
}

// CollectUpperDelta walks ONLY overlayfs's upperDir (O(changed paths)).
func CollectUpperDelta(upperDir string, basePaths []string, inspect *UpperInspect) (*UpperDelta, error) {
	start := time.Now()
	insp := resolveInspect(inspect)

	delta := &UpperDelta{}
	delSet := make(map[string]struct{})
	addDelete := func(p string) {
		p = strings.Trim(path.Clean(p), "/")
		if p == "" || p == "." {
			return
		}
		if _, ok := delSet[p]; !ok {
			delSet[p] = struct{}{}
			delta.Deletes = append(delta.Deletes, p)
		}
	}

	err := filepath.WalkDir(upperDir, func(fp string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if fp == upperDir {
			return nil
		}
		rel, err := filepath.Rel(upperDir, fp)
		if err != nil {
			return err
		}
		rel = strings.Trim(path.Clean(filepath.ToSlash(rel)), "/")
		if rel == "" || rel == "." {
			return nil
		}
		if rel == ".git" || strings.HasPrefix(rel, ".git/") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := os.Lstat(fp)
		if err != nil {
			return err
		}

		if insp.IsWhiteout(fp, info) {
			addDelete(rel)
			prefix := rel + "/"
			for _, bp := range basePaths {
				if strings.HasPrefix(bp, prefix) {
					addDelete(bp)
				}
			}
			return nil
		}

		if info.IsDir() {
			if insp.IsOpaque(fp) {
				prefix := rel + "/"
				for _, bp := range basePaths {
					if strings.HasPrefix(bp, prefix) {
						addDelete(bp)
					}
				}
			}
			return nil
		}

		if info.Mode()&os.ModeSymlink != 0 {
			target, err := os.Readlink(fp)
			if err != nil {
				return err
			}
			delta.Puts = append(delta.Puts, DeltaPut{
				Path:       rel,
				Mode:       S_IFLNK | 0o777,
				LinkTarget: target,
			})
			return nil
		}

		if info.Mode().IsRegular() {
			data, err := os.ReadFile(fp)
			if err != nil {
				return err
			}
			delta.Puts = append(delta.Puts, DeltaPut{
				Path: rel,
				Mode: S_IFREG | uint32(info.Mode().Perm()),
				Data: data,
			})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	sort.Strings(delta.Deletes)
	sort.Slice(delta.Puts, func(i, j int) bool { return delta.Puts[i].Path < delta.Puts[j].Path })
	delta.Elapsed = time.Since(start)
	return delta, nil
}

type putSig struct {
	hash       [32]byte
	mode       uint32
	linkTarget string
}

// SyncOp identifies a host-driven mutation (put, delete, move) already written to the workspace.
type SyncOp struct {
	Kind string
	Path string
	From string
}

// DeltaTracker computes incremental puts/deletes across multiple exec checkpoints
// on a single mounted overlayfs session without unmounting or resetting upperDir.
type DeltaTracker struct {
	upperDir  string
	basePaths []string
	baseSet   map[string]struct{}
	inspect   *UpperInspect
	lastPuts  map[string]putSig
	lastDels  map[string]struct{}
}

// NewDeltaTracker initializes incremental tracking over upperDir.
func NewDeltaTracker(upperDir string, basePaths []string, inspect *UpperInspect) *DeltaTracker {
	baseSet := make(map[string]struct{}, len(basePaths))
	for _, bp := range basePaths {
		baseSet[bp] = struct{}{}
	}
	return &DeltaTracker{
		upperDir:  upperDir,
		basePaths: append([]string(nil), basePaths...),
		baseSet:   baseSet,
		inspect:   inspect,
		lastPuts:  make(map[string]putSig),
		lastDels:  make(map[string]struct{}),
	}
}

// Collect returns only the changes since the previous Collect or SyncOps call,
// and advances the baseline.
func (t *DeltaTracker) Collect() (*UpperDelta, error) {
	cur, err := CollectUpperDelta(t.upperDir, t.basePaths, t.inspect)
	if err != nil {
		return nil, err
	}

	curPuts := make(map[string]putSig, len(cur.Puts))
	curPutByPath := make(map[string]DeltaPut, len(cur.Puts))
	for _, p := range cur.Puts {
		curPuts[p.Path] = putSig{
			hash:       sha256.Sum256(p.Data),
			mode:       p.Mode,
			linkTarget: p.LinkTarget,
		}
		curPutByPath[p.Path] = p
	}
	curDels := make(map[string]struct{}, len(cur.Deletes))
	for _, d := range cur.Deletes {
		curDels[d] = struct{}{}
	}

	out := &UpperDelta{Elapsed: cur.Elapsed}
	delSet := make(map[string]struct{})
	addDel := func(p string) {
		if _, ok := delSet[p]; !ok {
			delSet[p] = struct{}{}
			out.Deletes = append(out.Deletes, p)
		}
	}

	for pathKey, sig := range curPuts {
		prev, existed := t.lastPuts[pathKey]
		if !existed || prev != sig {
			out.Puts = append(out.Puts, curPutByPath[pathKey])
		}
	}
	for delPath := range curDels {
		if _, alreadyDeleted := t.lastDels[delPath]; !alreadyDeleted {
			addDel(delPath)
		}
	}
	// If a file was created during an earlier exec (so it wasn't in lowerDir) and then
	// deleted in a later exec, overlayfs removes it from upperDir without a whiteout.
	for prevPath := range t.lastPuts {
		if _, stillPut := curPuts[prevPath]; !stillPut {
			if _, inBase := t.baseSet[prevPath]; !inBase {
				addDel(prevPath)
			}
		}
	}

	sort.Strings(out.Deletes)
	sort.Slice(out.Puts, func(i, j int) bool { return out.Puts[i].Path < out.Puts[j].Path })
	t.lastPuts = curPuts
	t.lastDels = curDels
	return out, nil
}

// SyncOps advances the tracker baseline only for paths touched by host-driven ApplyOps
// so unrelated uncommitted edits sitting in upperDir are not lost.
func (t *DeltaTracker) SyncOps(ops []SyncOp) error {
	insp := resolveInspect(t.inspect)
	cleanRel := func(p string) string {
		p = strings.Trim(path.Clean(filepath.ToSlash(p)), "/")
		if p == "" || p == "." || p == ".git" || strings.HasPrefix(p, ".git/") {
			return ""
		}
		return p
	}

	recordEntry := func(rel, fp string, info fs.FileInfo) error {
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(fp)
			if err != nil {
				return err
			}
			t.lastPuts[rel] = putSig{mode: S_IFLNK | 0o777, linkTarget: target}
			delete(t.lastDels, rel)
		case info.Mode().IsRegular():
			data, err := os.ReadFile(fp)
			if err != nil {
				return err
			}
			t.lastPuts[rel] = putSig{
				hash: sha256.Sum256(data),
				mode: S_IFREG | uint32(info.Mode().Perm()),
			}
			delete(t.lastDels, rel)
		}
		return nil
	}

	syncPut := func(p string) error {
		rel := cleanRel(p)
		if rel == "" {
			return nil
		}
		rootFP := filepath.Join(t.upperDir, filepath.FromSlash(rel))
		info, err := os.Lstat(rootFP)
		if err != nil {
			if os.IsNotExist(err) {
				delete(t.lastPuts, rel)
				return nil
			}
			return err
		}
		if !info.IsDir() {
			return recordEntry(rel, rootFP, info)
		}
		return filepath.WalkDir(rootFP, func(fp string, d fs.DirEntry, wErr error) error {
			if wErr != nil {
				return wErr
			}
			sub, err := filepath.Rel(t.upperDir, fp)
			if err != nil {
				return err
			}
			subRel := cleanRel(sub)
			if subRel == "" {
				if d.IsDir() {
					return filepath.SkipDir
				}
				return nil
			}
			subInfo, err := os.Lstat(fp)
			if err != nil {
				return err
			}
			if subInfo.IsDir() {
				return nil
			}
			return recordEntry(subRel, fp, subInfo)
		})
	}

	syncDelete := func(p string) error {
		rel := cleanRel(p)
		if rel == "" {
			return nil
		}
		prefix := rel + "/"
		delete(t.lastPuts, rel)
		for k := range t.lastPuts {
			if strings.HasPrefix(k, prefix) {
				delete(t.lastPuts, k)
			}
		}
		fp := filepath.Join(t.upperDir, filepath.FromSlash(rel))
		info, err := os.Lstat(fp)
		if err != nil {
			if os.IsNotExist(err) {
				return nil
			}
			return err
		}
		if insp.IsWhiteout(fp, info) {
			t.lastDels[rel] = struct{}{}
			for _, bp := range t.basePaths {
				if strings.HasPrefix(bp, prefix) {
					t.lastDels[bp] = struct{}{}
				}
			}
		}
		return nil
	}

	for _, op := range ops {
		switch op.Kind {
		case "put":
			if err := syncPut(op.Path); err != nil {
				return err
			}
		case "delete":
			if err := syncDelete(op.Path); err != nil {
				return err
			}
		case "move":
			if err := syncDelete(op.From); err != nil {
				return err
			}
			if err := syncPut(op.Path); err != nil {
				return err
			}
		}
	}
	return nil
}
