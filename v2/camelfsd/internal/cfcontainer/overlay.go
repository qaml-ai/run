package cfcontainer

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
	"sync"
	"syscall"

	"golang.org/x/sys/unix"
)

// MountBest mounts the optimal lazy FUSE workspace for the current environment:
//   - On root + CAP_SYS_ADMIN microVMs (e.g. Cloudflare Containers Linux 6.18 or EC2 Firecracker):
//     mounts Read-Only Lazy FUSE as lowerdir + tmpfs upperdir + native kernel overlayfs at mountDir!
//     This matches production EC2 camelfs and gives 100% native RAM write speed (~45ms vs ~415ms for writable FUSE).
//   - On unprivileged hosts (e.g. local Linux dev UID 1000 without CAP_SYS_ADMIN):
//     falls back to single-layer unprivileged CowFuse via fusermount3.
func MountBest(ctx context.Context, manifest []TreeEntry, fetcher BlobFetcher, stateDir, mountDir string) (*MountSession, error) {
	if os.Geteuid() == 0 {
		sess, err := MountOverlay(ctx, manifest, fetcher, stateDir, mountDir)
		if err == nil {
			return sess, nil
		}
	}
	// Unprivileged fallback (local dev without CAP_SYS_ADMIN): use direct I/O (CacheTTLSec=0)
	// so out-of-band ApplyOps mutations from Worker file tools are immediately visible to bash.
	return MountWithConfig(ctx, manifest, fetcher, stateDir, mountDir, MountConfig{
		WritebackCache: false,
		CacheTTLSec:    0,
	})
}

// MountOverlay mounts Read-Only Lazy FUSE at stateDir/lower, a RAM tmpfs at stateDir/ovstate
// (holding upper/ and work/), and native kernel overlayfs at mountDir.
func MountOverlay(ctx context.Context, manifest []TreeEntry, fetcher BlobFetcher, stateDir, mountDir string) (*MountSession, error) {
	lowerDir := filepath.Join(stateDir, "lower")
	ovState := filepath.Join(stateDir, "ovstate")
	for _, p := range []string{lowerDir, ovState, mountDir} {
		if err := os.MkdirAll(p, 0o755); err != nil {
			return nil, fmt.Errorf("mkdir %s: %w", p, err)
		}
	}
	onTmpfs := unix.Mount("tmpfs", ovState, "tmpfs", 0, "size=512m") == nil
	upperDir := filepath.Join(ovState, "upper")
	workDir := filepath.Join(ovState, "work")
	if err := os.MkdirAll(upperDir, 0o755); err != nil {
		if onTmpfs {
			_ = unix.Unmount(ovState, unix.MNT_DETACH)
		}
		return nil, err
	}
	if err := os.MkdirAll(workDir, 0o755); err != nil {
		if onTmpfs {
			_ = unix.Unmount(ovState, unix.MNT_DETACH)
		}
		return nil, err
	}

	// Mount Read-Only Lazy FUSE as lowerdir with long dentry/attr TTL.
	roSess, err := MountWithConfig(ctx, manifest, fetcher, filepath.Join(stateDir, "ro-state"), lowerDir, MountConfig{
		CacheTTLSec: 3600,
		ReadOnly:    true,
	})
	if err != nil {
		if onTmpfs {
			_ = unix.Unmount(ovState, unix.MNT_DETACH)
		}
		return nil, fmt.Errorf("mount ro fuse lowerdir: %w", err)
	}

	ovOpts := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s", lowerDir, upperDir, workDir)
	if err := unix.Mount("overlay", mountDir, "overlay", 0, ovOpts); err != nil {
		_ = roSess.Close()
		if onTmpfs {
			_ = unix.Unmount(ovState, unix.MNT_DETACH)
		}
		return nil, fmt.Errorf("mount kernel overlayfs: %w", err)
	}

	// Wrap the RO lower session into an overlay-backed MountSession.
	roSess.overlayMode = true
	roSess.lowerDir = lowerDir
	roSess.ovStateDir = ovState
	roSess.ovOnTmpfs = onTmpfs
	roSess.UpperDir = upperDir
	roSess.MountDir = mountDir
	roSess.ovMu = &sync.Mutex{}
	roSess.ovBaseline = make(map[string]commitSig)
	for _, e := range manifest {
		clean := strings.Trim(path.Clean(e.Path), "/")
		if clean == "" || clean == "." || e.Type == "dir" {
			continue
		}
		roSess.ovBaseline[clean] = commitSig{
			mode:       normalizeEntryMode(e),
			linkTarget: e.LinkTarget,
			isSymlink:  e.Type == "symlink" || e.LinkTarget != "",
		}
	}
	return roSess, nil
}

// CollectDelta returns O(changed files) puts and deletes since the last CollectDelta or ApplyOps.
func (s *MountSession) CollectDelta() (*WorkspaceDelta, error) {
	if !s.overlayMode {
		return s.Server.CollectDelta()
	}
	s.ovMu.Lock()
	defer s.ovMu.Unlock()

	delta := &WorkspaceDelta{}
	seenDel := make(map[string]struct{})
	addDel := func(rel string) {
		rel = strings.Trim(path.Clean(rel), "/")
		if rel == "" || rel == "." || rel == ".git" || strings.HasPrefix(rel, ".git/") {
			return
		}
		if _, ok := seenDel[rel]; !ok {
			seenDel[rel] = struct{}{}
			delta.Deletes = append(delta.Deletes, rel)
		}
	}

	err := filepath.WalkDir(s.UpperDir, func(full string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return nil
		}
		if full == s.UpperDir {
			return nil
		}
		rel, err := filepath.Rel(s.UpperDir, full)
		if err != nil {
			return nil
		}
		rel = filepath.ToSlash(rel)
		if rel == ".git" || strings.HasPrefix(rel, ".git/") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}

		info, err := os.Lstat(full)
		if err != nil {
			return nil
		}
		mode := info.Mode()

		// OverlayFS whiteout: character device with major=0, minor=0.
		if mode&os.ModeCharDevice != 0 {
			if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Rdev == 0 {
				if _, existed := s.ovBaseline[rel]; existed {
					addDel(rel)
					delete(s.ovBaseline, rel)
				}
				return nil
			}
		}

		if mode.IsDir() {
			return nil
		}

		if mode&os.ModeSymlink != 0 {
			target, err := os.Readlink(full)
			if err != nil {
				return err
			}
			sig := commitSig{mode: S_IFLNK | 0o777, linkTarget: target, isSymlink: true}
			if prev, ok := s.ovBaseline[rel]; !ok || prev != sig {
				delta.Puts = append(delta.Puts, DeltaPut{
					Path:       rel,
					Mode:       S_IFLNK | 0o777,
					LinkTarget: target,
				})
				s.ovBaseline[rel] = sig
			}
			return nil
		}

		if mode.IsRegular() {
			data, err := os.ReadFile(full)
			if err != nil {
				return err
			}
			perm := uint32(mode.Perm())
			if perm == 0 {
				perm = 0o644
			}
			fullMode := S_IFREG | perm
			sig := commitSig{hash: sha256.Sum256(data), mode: fullMode}
			if prev, ok := s.ovBaseline[rel]; !ok || prev != sig {
				delta.Puts = append(delta.Puts, DeltaPut{
					Path: rel,
					Mode: fullMode,
					Data: data,
				})
				s.ovBaseline[rel] = sig
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Strings(delta.Deletes)
	sort.Slice(delta.Puts, func(i, j int) bool { return delta.Puts[i].Path < delta.Puts[j].Path })
	return delta, nil
}

// ApplyOps applies Worker API writes/deletes/moves directly into the live mounted workspace
// and updates the baseline so CollectDelta does not double-commit them.
func (s *MountSession) ApplyOps(ops []LiveOp) error {
	if !s.overlayMode {
		return s.Server.ApplyOps(ops)
	}
	s.ovMu.Lock()
	defer s.ovMu.Unlock()

	for _, op := range ops {
		switch op.Kind {
		case "put":
			clean := strings.Trim(path.Clean(op.Path), "/")
			if clean == "" || clean == "." {
				continue
			}
			dst := filepath.Join(s.MountDir, filepath.FromSlash(clean))
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return err
			}
			perm := os.FileMode(op.Mode & 0o777)
			if perm == 0 {
				perm = 0o644
			}
			if err := os.WriteFile(dst, op.Data, perm); err != nil {
				return err
			}
			s.ovBaseline[clean] = commitSig{hash: sha256.Sum256(op.Data), mode: S_IFREG | uint32(perm)}
		case "delete":
			clean := strings.Trim(path.Clean(op.Path), "/")
			if clean == "" || clean == "." {
				continue
			}
			dst := filepath.Join(s.MountDir, filepath.FromSlash(clean))
			_ = os.RemoveAll(dst)
			delete(s.ovBaseline, clean)
		case "move":
			fromClean := strings.Trim(path.Clean(op.From), "/")
			toClean := strings.Trim(path.Clean(op.Path), "/")
			if fromClean == "" || toClean == "" || fromClean == toClean {
				continue
			}
			src := filepath.Join(s.MountDir, filepath.FromSlash(fromClean))
			dst := filepath.Join(s.MountDir, filepath.FromSlash(toClean))
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return err
			}
			if err := os.Rename(src, dst); err != nil {
				return err
			}
			if sig, ok := s.ovBaseline[fromClean]; ok {
				delete(s.ovBaseline, fromClean)
				s.ovBaseline[toClean] = sig
			}
		}
	}
	return nil
}

// ModeName returns the active mount mode ("rofuse_kernel_overlay_tmpfs", "rofuse_kernel_overlay_disk", or "cowfuse").
func (s *MountSession) ModeName() string {
	if s.overlayMode {
		if s.ovOnTmpfs {
			return "rofuse_kernel_overlay_tmpfs"
		}
		return "rofuse_kernel_overlay_disk"
	}
	return "cowfuse"
}
