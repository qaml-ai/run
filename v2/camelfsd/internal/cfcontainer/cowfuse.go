package cfcontainer

import (
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"golang.org/x/sys/unix"
)

// Linux POSIX S_IFMT constants.
const (
	S_IFMT  uint32 = 0o170000
	S_IFDIR uint32 = 0o040000
	S_IFREG uint32 = 0o100000
	S_IFLNK uint32 = 0o120000
)

// Linux /usr/include/linux/fuse.h protocol constants.
const (
	fuseKernelVersion      = 7
	fuseKernelMinorVersion = 39
	fuseRootID             = 1
	fuseInHeaderSize       = 40
	fuseOutHeaderSize      = 16
	fuseAttrSize           = 88
	fuseEntryOutSize       = 128
	fuseAttrOutSize        = 104
	fuseInitOutSize        = 64
	fuseOpenOutSize        = 16
	fuseWriteOutSize       = 8
	fuseKstatfsSize        = 80
	fuseDirentHdrSize      = 24
	fuseDirentPlusHdrSize  = fuseEntryOutSize + fuseDirentHdrSize
)

const (
	opLookup      uint32 = 1
	opForget      uint32 = 2
	opGetattr     uint32 = 3
	opSetattr     uint32 = 4
	opReadlink    uint32 = 5
	opSymlink     uint32 = 6
	opMknod       uint32 = 8
	opMkdir       uint32 = 9
	opUnlink      uint32 = 10
	opRmdir       uint32 = 11
	opRename      uint32 = 12
	opOpen        uint32 = 14
	opRead        uint32 = 15
	opWrite       uint32 = 16
	opStatfs      uint32 = 17
	opRelease     uint32 = 18
	opFsync       uint32 = 20
	opGetxattr    uint32 = 22
	opListxattr   uint32 = 23
	opFlush       uint32 = 25
	opInit        uint32 = 26
	opOpendir     uint32 = 27
	opReaddir     uint32 = 28
	opReleasedir  uint32 = 29
	opFsyncdir    uint32 = 30
	opAccess      uint32 = 34
	opCreate      uint32 = 35
	opDestroy     uint32 = 38
	opBatchForget uint32 = 42
	opReaddirplus uint32 = 44
	opRename2     uint32 = 45
)

const (
	fattrMode     uint32 = 1 << 0
	fattrUID      uint32 = 1 << 1
	fattrGID      uint32 = 1 << 2
	fattrSize     uint32 = 1 << 3
	fattrAtime    uint32 = 1 << 4
	fattrMtime    uint32 = 1 << 5
	fattrAtimeNow uint32 = 1 << 7
	fattrMtimeNow uint32 = 1 << 8
)

const (
	fopenDirectIO  uint32 = 1 << 0
	fopenKeepCache uint32 = 1 << 1
)

const (
	capAsyncRead      uint32 = 1 << 0
	capAtomicOTrunc   uint32 = 1 << 3
	capBigWrites      uint32 = 1 << 5
	capDoReaddirplus  uint32 = 1 << 13
	capReaddirplusAut uint32 = 1 << 14
	capWritebackCache uint32 = 1 << 16
	capParallelDirops uint32 = 1 << 18
	capMaxPages       uint32 = 1 << 22
	capInitExt        uint32 = 1 << 30
)

// MountConfig tunes FUSE caching behavior (direct vs writeback+dentry cache).
type MountConfig struct {
	WritebackCache  bool
	CacheTTLSec     uint64
	ForceFusermount bool
	ReadOnly        bool
}

// TreeEntry describes one immutable file, directory, or symlink in a snapshot manifest.
type TreeEntry struct {
	Path       string `json:"path"`
	Type       string `json:"type"`
	Mode       uint32 `json:"mode"`
	Size       uint64 `json:"size"`
	BlobHash   string `json:"hash"`
	LinkTarget string `json:"linkTarget,omitempty"`
}

// BlobFetcher fetches immutable blob bytes lazily by content hash (e.g. from Cloudflare Worker / R2).
type BlobFetcher interface {
	FetchBlob(ctx context.Context, hash string) ([]byte, error)
}

type BlobFetcherFunc func(ctx context.Context, hash string) ([]byte, error)

func (f BlobFetcherFunc) FetchBlob(ctx context.Context, hash string) ([]byte, error) {
	return f(ctx, hash)
}

// DeltaPut records a created or modified file/symlink since the last checkpoint.
type DeltaPut struct {
	Path       string
	Mode       uint32
	Data       []byte
	LinkTarget string
}

// WorkspaceDelta is the O(changed files) diff returned at checkpoint.
type WorkspaceDelta struct {
	Puts    []DeltaPut
	Deletes []string
}

// LiveOp is an external API write applied directly to the live FUSE workspace.
type LiveOp struct {
	Kind string
	Path string
	From string
	Mode uint32
	Data []byte
}

// Stats exposes counters proving lazy blob hydration and metadata locality.
type Stats struct {
	FuseRequests     int64 `json:"fuseRequests"`
	MetadataCalls    int64 `json:"metadataCalls"`
	ReadCalls        int64 `json:"readCalls"`
	WriteCalls       int64 `json:"writeCalls"`
	BlobFetches      int64 `json:"blobFetches"`
	BlobBytesFetched int64 `json:"blobBytesFetched"`
	InodeCount       int   `json:"inodeCount"`
	DirtyCount       int   `json:"dirtyCount"`
	DeletedCount     int   `json:"deletedCount"`
}

type cowNode struct {
	ino        uint64
	parent     uint64
	name       string
	mode       uint32
	size       uint64
	mtimeSec   uint64
	mtimeNsec  uint32
	nlink      uint32
	uid        uint32
	gid        uint32
	blobHash   string
	linkTarget string
	upperPath  string // non-empty once created or copied-up on local scratch disk
	dirty      bool
	children   map[string]*cowNode
}

func (n *cowNode) isDir() bool     { return n.mode&S_IFMT == S_IFDIR }
func (n *cowNode) isSymlink() bool { return n.mode&S_IFMT == S_IFLNK }

type commitSig struct {
	hash       [32]byte
	mode       uint32
	linkTarget string
	isSymlink  bool
}

type inFlightCall struct {
	done chan struct{}
	data []byte
	err  error
}

// CowFuseServer is a single-layer writable Copy-on-Write lazy FUSE filesystem.
// It requires ZERO kernel overlayfs, ZERO tmpfs mounts, ZERO CAP_SYS_ADMIN, and ZERO CAP_MKNOD,
// and mounts unprivileged via fusermount3 — making it directly compatible with Cloudflare Containers.
type CowFuseServer struct {
	fetcher  BlobFetcher
	upperDir string
	uid      uint32
	gid      uint32
	workers  int
	cfg      MountConfig

	mu           sync.RWMutex
	nextIno      uint64
	nodes        map[uint64]*cowNode
	root         *cowNode
	dirtyPaths   map[string]struct{}
	deletedPaths map[string]struct{}
	knownPaths   map[string]commitSig // baseline paths as of last checkpoint / ApplyOps
	blobCache    map[string][]byte
	sfMu         sync.Mutex
	inFlight     map[string]*inFlightCall

	negotiatedFlags  atomic.Uint32
	negotiatedFlags2 atomic.Uint32
	fuseRequests     atomic.Int64
	metadataCalls    atomic.Int64
	readCalls        atomic.Int64
	writeCalls       atomic.Int64
	blobFetches      atomic.Int64
	blobBytesFetched atomic.Int64
}

func (s *CowFuseServer) NegotiatedFlags() (uint32, uint32) {
	return s.negotiatedFlags.Load(), s.negotiatedFlags2.Load()
}

func normalizeEntryMode(e TreeEntry) uint32 {
	if e.Type == "dir" {
		perm := e.Mode & 0o777
		if perm == 0 {
			perm = 0o755
		}
		return S_IFDIR | perm
	}
	if e.Type == "symlink" || e.LinkTarget != "" {
		return S_IFLNK | 0o777
	}
	perm := e.Mode & 0o777
	if perm == 0 {
		perm = 0o644
	}
	return S_IFREG | perm
}

// NewCowFuseServer initializes the in-memory inode tree from a commit manifest (zero blob RPCs).
func NewCowFuseServer(manifest []TreeEntry, fetcher BlobFetcher, upperDir string) (*CowFuseServer, error) {
	return NewCowFuseServerWithConfig(manifest, fetcher, upperDir, MountConfig{})
}

func NewCowFuseServerWithConfig(manifest []TreeEntry, fetcher BlobFetcher, upperDir string, cfg MountConfig) (*CowFuseServer, error) {
	if err := os.MkdirAll(upperDir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir upperDir: %w", err)
	}
	now := time.Now()
	uid := uint32(os.Getuid())
	gid := uint32(os.Getgid())
	root := &cowNode{
		ino:       fuseRootID,
		parent:    fuseRootID,
		name:      "",
		mode:      S_IFDIR | 0o755,
		nlink:     2,
		uid:       uid,
		gid:       gid,
		mtimeSec:  uint64(now.Unix()),
		mtimeNsec: uint32(now.Nanosecond()),
		children:  make(map[string]*cowNode),
	}
	s := &CowFuseServer{
		fetcher:      fetcher,
		upperDir:     upperDir,
		uid:          uid,
		gid:          gid,
		workers:      4,
		cfg:          cfg,
		nextIno:      fuseRootID + 1,
		nodes:        map[uint64]*cowNode{fuseRootID: root},
		root:         root,
		dirtyPaths:   make(map[string]struct{}),
		deletedPaths: make(map[string]struct{}),
		knownPaths:   make(map[string]commitSig),
		blobCache:    make(map[string][]byte),
		inFlight:     make(map[string]*inFlightCall),
	}

	sorted := append([]TreeEntry(nil), manifest...)
	sort.Slice(sorted, func(i, j int) bool {
		di := strings.Count(sorted[i].Path, "/")
		dj := strings.Count(sorted[j].Path, "/")
		if di != dj {
			return di < dj
		}
		return sorted[i].Path < sorted[j].Path
	})

	for _, e := range sorted {
		clean := strings.Trim(path.Clean(e.Path), "/")
		if clean == "" || clean == "." {
			continue
		}
		parts := strings.Split(clean, "/")
		cur := root
		for i, part := range parts {
			if part == "" || part == "." || part == ".." {
				continue
			}
			isLast := i == len(parts)-1
			if existing, ok := cur.children[part]; ok {
				if isLast {
					existing.mode = normalizeEntryMode(e)
					existing.size = e.Size
					existing.blobHash = e.BlobHash
					existing.linkTarget = e.LinkTarget
				}
				cur = existing
				continue
			}
			ino := s.nextIno
			s.nextIno++
			n := &cowNode{
				ino:       ino,
				parent:    cur.ino,
				name:      part,
				mode:      S_IFDIR | 0o755,
				nlink:     1,
				uid:       uid,
				gid:       gid,
				mtimeSec:  uint64(now.Unix()),
				mtimeNsec: uint32(now.Nanosecond()),
			}
			if isLast {
				n.mode = normalizeEntryMode(e)
				n.size = e.Size
				n.blobHash = e.BlobHash
				n.linkTarget = e.LinkTarget
			}
			if n.isDir() {
				n.nlink = 2
				n.children = make(map[string]*cowNode)
				cur.nlink++
			}
			cur.children[part] = n
			s.nodes[ino] = n
			cur = n
		}
		if cur != nil && !cur.isDir() {
			s.knownPaths[clean] = commitSig{
				mode:       cur.mode,
				linkTarget: cur.linkTarget,
				isSymlink:  cur.isSymlink(),
			}
		}
	}
	return s, nil
}

// MountSession manages an active FUSE (or RO FUSE + kernel overlayfs) mount.
type MountSession struct {
	MountDir  string
	UpperDir  string
	Server    *CowFuseServer
	fuseDev   *os.File
	cancel    context.CancelFunc
	serveDone chan error
	usedFuser bool

	overlayMode bool
	lowerDir    string
	ovStateDir  string
	ovOnTmpfs   bool
	ovMu        *sync.Mutex
	ovBaseline  map[string]commitSig
}

// Mount mounts CowFuseServer at mountDir using unprivileged fusermount3 (no CAP_SYS_ADMIN!).
// Falls back to raw unix.Mount when running as root without fusermount3.
func Mount(ctx context.Context, manifest []TreeEntry, fetcher BlobFetcher, stateDir, mountDir string) (*MountSession, error) {
	return MountWithConfig(ctx, manifest, fetcher, stateDir, mountDir, MountConfig{})
}

func MountWithConfig(ctx context.Context, manifest []TreeEntry, fetcher BlobFetcher, stateDir, mountDir string, cfg MountConfig) (*MountSession, error) {
	upperDir := filepath.Join(stateDir, "upper")
	if err := os.MkdirAll(mountDir, 0o755); err != nil {
		return nil, err
	}
	srv, err := NewCowFuseServerWithConfig(manifest, fetcher, upperDir, cfg)
	if err != nil {
		return nil, err
	}

	var dev *os.File
	usedFuser := false
	if cfg.ForceFusermount {
		if fmPath, lkErr := exec.LookPath("fusermount3"); lkErr == nil {
			dev, err = mountViaFusermount(fmPath, mountDir)
			usedFuser = true
		} else {
			dev, err = mountDirect(mountDir, cfg.ReadOnly)
		}
	} else if os.Geteuid() == 0 {
		// When running as root with CAP_SYS_ADMIN (e.g. Cloudflare Containers microVM),
		// direct /dev/fuse + mount(2) avoids fusermount3 subprocess overhead and socketpair quirks.
		dev, err = mountDirect(mountDir, cfg.ReadOnly)
		if err != nil {
			if fmPath, lkErr := exec.LookPath("fusermount3"); lkErr == nil {
				dev, err = mountViaFusermount(fmPath, mountDir)
				usedFuser = true
			}
		}
	} else if fmPath, lkErr := exec.LookPath("fusermount3"); lkErr == nil {
		dev, err = mountViaFusermount(fmPath, mountDir)
		usedFuser = true
	} else if fmPath, lkErr := exec.LookPath("fusermount"); lkErr == nil {
		dev, err = mountViaFusermount(fmPath, mountDir)
		usedFuser = true
	} else {
		dev, err = mountDirect(mountDir, cfg.ReadOnly)
	}
	if err != nil {
		return nil, err
	}

	// Ensure blocking fd mode before serving raw read(2)/write(2) syscalls.
	_ = unix.SetNonblock(int(dev.Fd()), false)

	sCtx, cancel := context.WithCancel(ctx)
	sess := &MountSession{
		MountDir:  mountDir,
		UpperDir:  upperDir,
		Server:    srv,
		fuseDev:   dev,
		cancel:    cancel,
		serveDone: make(chan error, 1),
		usedFuser: usedFuser,
	}
	go func() {
		sess.serveDone <- srv.ServeConcurrent(sCtx, dev)
	}()
	return sess, nil
}

func mountViaFusermount(fmPath, mountDir string) (*os.File, error) {
	fds, err := unix.Socketpair(unix.AF_UNIX, unix.SOCK_SEQPACKET|unix.SOCK_CLOEXEC, 0)
	if err != nil {
		fds, err = unix.Socketpair(unix.AF_UNIX, unix.SOCK_STREAM|unix.SOCK_CLOEXEC, 0)
		if err != nil {
			return nil, fmt.Errorf("socketpair: %w", err)
		}
	}
	parentSock := os.NewFile(uintptr(fds[0]), "fuse-comm-parent")
	childSock := os.NewFile(uintptr(fds[1]), "fuse-comm-child")
	defer parentSock.Close()
	defer childSock.Close()

	// Clear CLOEXEC on childSock passed via ExtraFiles (fd 3 in child).
	cmd := exec.Command(fmPath, "-o", "fsname=camelfs-cow,subtype=camelfs,default_permissions", mountDir)
	cmd.Env = append(os.Environ(), "_FUSE_COMMFD=3")
	cmd.ExtraFiles = []*os.File{childSock}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return nil, fmt.Errorf("%s failed: %w: %s", fmPath, err, strings.TrimSpace(string(out)))
	}

	buf := make([]byte, 32)
	oob := make([]byte, unix.CmsgSpace(4))
	_, oobn, _, _, err := unix.Recvmsg(int(parentSock.Fd()), buf, oob, 0)
	if err != nil {
		return nil, fmt.Errorf("recvmsg fuse fd: %w", err)
	}
	cmsgs, err := unix.ParseSocketControlMessage(oob[:oobn])
	if err != nil || len(cmsgs) == 0 {
		return nil, fmt.Errorf("parse fuse fd control message: %v", err)
	}
	rxFds, err := unix.ParseUnixRights(&cmsgs[0])
	if err != nil || len(rxFds) == 0 {
		return nil, fmt.Errorf("parse fuse unix rights: %v", err)
	}
	return os.NewFile(uintptr(rxFds[0]), "/dev/fuse"), nil
}

func mountDirect(mountDir string, readOnly bool) (*os.File, error) {
	// Open /dev/fuse with raw unix.Open so Go's runtime netpoller does not register
	// an unbound /dev/fuse fd in epoll before mount(2) binds the FUSE connection.
	fd, err := unix.Open("/dev/fuse", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return nil, fmt.Errorf("open /dev/fuse: %w", err)
	}
	opts := fmt.Sprintf("fd=%d,rootmode=040755,user_id=%d,group_id=%d,default_permissions", fd, os.Getuid(), os.Getgid())
	if os.Geteuid() == 0 {
		opts += ",allow_other"
	}
	var flags uintptr = unix.MS_NOSUID | unix.MS_NODEV
	if readOnly {
		flags |= unix.MS_RDONLY
	}
	if err := unix.Mount("camelfs-cow", mountDir, "fuse", flags, opts); err != nil {
		_ = unix.Close(fd)
		return nil, fmt.Errorf("mount fuse: %w", err)
	}
	return os.NewFile(uintptr(fd), "/dev/fuse"), nil
}

// Close unmounts the overlayfs (if active) and FUSE mountpoint and stops worker goroutines cleanly.
func (s *MountSession) Close() error {
	var firstErr error
	fuseTarget := s.MountDir
	if s.overlayMode {
		if err := unix.Unmount(s.MountDir, 0); err != nil {
			if err2 := unix.Unmount(s.MountDir, unix.MNT_DETACH); err2 != nil {
				firstErr = err2
			}
		}
		fuseTarget = s.lowerDir
	}
	if s.usedFuser {
		fm := "fusermount3"
		if _, err := exec.LookPath(fm); err != nil {
			fm = "fusermount"
		}
		if out, err := exec.Command(fm, "-u", fuseTarget).CombinedOutput(); err != nil {
			if out2, err2 := exec.Command(fm, "-uz", fuseTarget).CombinedOutput(); err2 != nil {
				firstErr = fmt.Errorf("unmount %s: %w (%s / %s)", fuseTarget, err2, strings.TrimSpace(string(out)), strings.TrimSpace(string(out2)))
			}
		}
	} else {
		if err := unix.Unmount(fuseTarget, 0); err != nil {
			if err2 := unix.Unmount(fuseTarget, unix.MNT_DETACH); err2 != nil && firstErr == nil {
				firstErr = err2
			}
		}
	}
	s.cancel()
	if s.fuseDev != nil {
		_ = s.fuseDev.Close()
	}
	select {
	case err := <-s.serveDone:
		if err != nil && !errors.Is(err, context.Canceled) && firstErr == nil {
			firstErr = err
		}
	case <-time.After(2 * time.Second):
	}
	if s.overlayMode && s.ovOnTmpfs && s.ovStateDir != "" {
		_ = unix.Unmount(s.ovStateDir, unix.MNT_DETACH)
	}
	return firstErr
}

// Stats returns current lazy-hydration and operation telemetry.
func (s *CowFuseServer) Stats() Stats {
	s.mu.RLock()
	inodes := len(s.nodes)
	dirty := len(s.dirtyPaths)
	deleted := len(s.deletedPaths)
	s.mu.RUnlock()
	return Stats{
		FuseRequests:     s.fuseRequests.Load(),
		MetadataCalls:    s.metadataCalls.Load(),
		ReadCalls:        s.readCalls.Load(),
		WriteCalls:       s.writeCalls.Load(),
		BlobFetches:      s.blobFetches.Load(),
		BlobBytesFetched: s.blobBytesFetched.Load(),
		InodeCount:       inodes,
		DirtyCount:       dirty,
		DeletedCount:     deleted,
	}
}

func (s *CowFuseServer) nodePathLocked(n *cowNode) string {
	if n == nil || n.ino == fuseRootID {
		return ""
	}
	var parts []string
	cur := n
	for cur != nil && cur.ino != fuseRootID {
		parts = append(parts, cur.name)
		cur = s.nodes[cur.parent]
	}
	for i, j := 0, len(parts)-1; i < j; i, j = i+1, j-1 {
		parts[i], parts[j] = parts[j], parts[i]
	}
	return strings.Join(parts, "/")
}

func (s *CowFuseServer) lookupPathLocked(relPath string) *cowNode {
	clean := strings.Trim(path.Clean(relPath), "/")
	if clean == "" || clean == "." {
		return s.root
	}
	cur := s.root
	for _, part := range strings.Split(clean, "/") {
		if !cur.isDir() {
			return nil
		}
		next, ok := cur.children[part]
		if !ok {
			return nil
		}
		cur = next
	}
	return cur
}

func (s *CowFuseServer) ensureDirPathLocked(relDir string) *cowNode {
	clean := strings.Trim(path.Clean(relDir), "/")
	if clean == "" || clean == "." {
		return s.root
	}
	now := time.Now()
	cur := s.root
	for _, part := range strings.Split(clean, "/") {
		if existing, ok := cur.children[part]; ok && existing.isDir() {
			cur = existing
			continue
		}
		ino := s.nextIno
		s.nextIno++
		dir := &cowNode{
			ino:       ino,
			parent:    cur.ino,
			name:      part,
			mode:      S_IFDIR | 0o755,
			nlink:     2,
			uid:       s.uid,
			gid:       s.gid,
			mtimeSec:  uint64(now.Unix()),
			mtimeNsec: uint32(now.Nanosecond()),
			children:  make(map[string]*cowNode),
		}
		cur.children[part] = dir
		cur.nlink++
		s.nodes[ino] = dir
		cur = dir
	}
	return cur
}

// CollectDelta returns O(changed files) puts and deletes since the last CollectDelta or ApplyOps.
func (s *CowFuseServer) CollectDelta() (*WorkspaceDelta, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	delta := &WorkspaceDelta{}
	delSet := make(map[string]struct{})
	addDel := func(p string) {
		p = strings.Trim(path.Clean(p), "/")
		if p == "" || p == "." || p == ".git" || strings.HasPrefix(p, ".git/") {
			return
		}
		if _, ok := delSet[p]; !ok {
			delSet[p] = struct{}{}
			delta.Deletes = append(delta.Deletes, p)
		}
	}

	for dp := range s.deletedPaths {
		if _, wasKnown := s.knownPaths[dp]; wasKnown {
			addDel(dp)
			delete(s.knownPaths, dp)
		}
	}
	s.deletedPaths = make(map[string]struct{})

	for p := range s.dirtyPaths {
		if p == "" || p == "." || p == ".git" || strings.HasPrefix(p, ".git/") {
			continue
		}
		n := s.lookupPathLocked(p)
		if n == nil || n.isDir() {
			continue
		}
		if n.isSymlink() {
			sig := commitSig{mode: S_IFLNK | 0o777, linkTarget: n.linkTarget, isSymlink: true}
			prev, existed := s.knownPaths[p]
			if !existed || prev != sig {
				delta.Puts = append(delta.Puts, DeltaPut{
					Path:       p,
					Mode:       S_IFLNK | 0o777,
					LinkTarget: n.linkTarget,
				})
				s.knownPaths[p] = sig
			}
			n.dirty = false
			continue
		}
		var data []byte
		var err error
		if n.upperPath != "" {
			data, err = os.ReadFile(n.upperPath)
			if err != nil {
				return nil, fmt.Errorf("read dirty upper file %s: %w", p, err)
			}
		}
		sig := commitSig{hash: sha256.Sum256(data), mode: n.mode}
		prev, existed := s.knownPaths[p]
		if !existed || prev != sig || n.dirty {
			delta.Puts = append(delta.Puts, DeltaPut{
				Path: p,
				Mode: n.mode,
				Data: data,
			})
			s.knownPaths[p] = sig
		}
		n.dirty = false
	}
	s.dirtyPaths = make(map[string]struct{})

	sort.Strings(delta.Deletes)
	sort.Slice(delta.Puts, func(i, j int) bool { return delta.Puts[i].Path < delta.Puts[j].Path })
	return delta, nil
}

// ApplyOps applies Worker API writes/deletes/moves directly into the live mounted FUSE workspace
// and updates the committed baseline so CollectDelta does not double-commit them.
func (s *CowFuseServer) ApplyOps(ops []LiveOp) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now()

	for _, op := range ops {
		switch op.Kind {
		case "put":
			clean := strings.Trim(path.Clean(op.Path), "/")
			if clean == "" || clean == "." {
				continue
			}
			dirPart := path.Dir(clean)
			base := path.Base(clean)
			parent := s.root
			if dirPart != "." && dirPart != "" {
				parent = s.ensureDirPathLocked(dirPart)
			}
			mode := op.Mode
			if mode == 0 {
				mode = 0o644
			}
			if mode&S_IFMT == 0 {
				mode |= S_IFREG
			}
			n, exists := parent.children[base]
			if !exists || n.isDir() {
				ino := s.nextIno
				s.nextIno++
				n = &cowNode{
					ino:    ino,
					parent: parent.ino,
					name:   base,
					nlink:  1,
					uid:    s.uid,
					gid:    s.gid,
				}
				parent.children[base] = n
				s.nodes[ino] = n
			}
			up := filepath.Join(s.upperDir, fmt.Sprintf("%d.blob", n.ino))
			if err := os.WriteFile(up, op.Data, 0o644); err != nil {
				return err
			}
			n.upperPath = up
			n.blobHash = ""
			n.mode = mode
			n.size = uint64(len(op.Data))
			n.mtimeSec = uint64(now.Unix())
			n.mtimeNsec = uint32(now.Nanosecond())
			n.dirty = false
			delete(s.dirtyPaths, clean)
			delete(s.deletedPaths, clean)
			s.knownPaths[clean] = commitSig{hash: sha256.Sum256(op.Data), mode: mode}

		case "delete":
			clean := strings.Trim(path.Clean(op.Path), "/")
			if clean == "" || clean == "." {
				continue
			}
			dirPart := path.Dir(clean)
			base := path.Base(clean)
			parent := s.root
			if dirPart != "." && dirPart != "" {
				parent = s.lookupPathLocked(dirPart)
			}
			if parent != nil && parent.isDir() {
				if target, ok := parent.children[base]; ok {
					delete(parent.children, base)
					if target.isDir() && parent.nlink > 2 {
						parent.nlink--
					}
					if target.upperPath != "" {
						_ = os.Remove(target.upperPath)
					}
				}
			}
			delete(s.dirtyPaths, clean)
			delete(s.deletedPaths, clean)
			delete(s.knownPaths, clean)

		case "move":
			fromClean := strings.Trim(path.Clean(op.From), "/")
			toClean := strings.Trim(path.Clean(op.Path), "/")
			if fromClean == "" || toClean == "" || fromClean == toClean {
				continue
			}
			oldParent := s.root
			if d := path.Dir(fromClean); d != "." && d != "" {
				oldParent = s.lookupPathLocked(d)
			}
			if oldParent == nil || !oldParent.isDir() {
				continue
			}
			node, ok := oldParent.children[path.Base(fromClean)]
			if !ok {
				continue
			}
			delete(oldParent.children, path.Base(fromClean))
			newParent := s.root
			if d := path.Dir(toClean); d != "." && d != "" {
				newParent = s.ensureDirPathLocked(d)
			}
			node.parent = newParent.ino
			node.name = path.Base(toClean)
			newParent.children[node.name] = node
			if sig, ok := s.knownPaths[fromClean]; ok {
				delete(s.knownPaths, fromClean)
				s.knownPaths[toClean] = sig
			}
			delete(s.dirtyPaths, fromClean)
			delete(s.dirtyPaths, toClean)
			delete(s.deletedPaths, fromClean)
			delete(s.deletedPaths, toClean)
		}
	}
	return nil
}

type rawFuseFD struct {
	fd int
}

func (r rawFuseFD) Read(p []byte) (int, error) {
	return unix.Read(r.fd, p)
}

func (r rawFuseFD) Write(p []byte) (int, error) {
	return unix.Write(r.fd, p)
}

// ServeConcurrent spawns worker goroutines reading /dev/fuse concurrently via raw blocking syscalls.
func (s *CowFuseServer) ServeConcurrent(ctx context.Context, dev *os.File) error {
	raw := rawFuseFD{fd: int(dev.Fd())}
	var wg sync.WaitGroup
	errCh := make(chan error, s.workers)
	for i := 0; i < s.workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.Serve(ctx, raw); err != nil {
				select {
				case errCh <- err:
				default:
				}
			}
		}()
	}
	wg.Wait()
	select {
	case err := <-errCh:
		return err
	default:
		return nil
	}
}

func (s *CowFuseServer) Serve(ctx context.Context, dev io.ReadWriter) error {
	// Linux 6.18+ can use larger FUSE request buffers; allocate 1 MiB + 8 KiB.
	buf := make([]byte, 1024*1024+8192)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		n, err := dev.Read(buf)
		if err != nil {
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			if errors.Is(err, io.EOF) || errors.Is(err, syscall.ENODEV) || errors.Is(err, syscall.EBADF) || errors.Is(err, os.ErrClosed) {
				return nil
			}
			log.Printf("cowfuse: dev.Read error: %v", err)
			return err
		}
		if n < fuseInHeaderSize {
			continue
		}
		reply := s.HandlePacket(ctx, buf[:n])
		if len(reply) == 0 {
			continue
		}
		if _, err := dev.Write(reply); err != nil {
			if errors.Is(err, syscall.ENOENT) || errors.Is(err, syscall.EINTR) {
				continue
			}
			if errors.Is(err, syscall.ENODEV) || errors.Is(err, os.ErrClosed) {
				return nil
			}
			log.Printf("cowfuse: dev.Write error (len=%d): %v", len(reply), err)
			return err
		}
	}
}

func (s *CowFuseServer) HandlePacket(ctx context.Context, req []byte) []byte {
	if len(req) < fuseInHeaderSize {
		return nil
	}
	le := binary.LittleEndian
	opcode := le.Uint32(req[4:8])
	unique := le.Uint64(req[8:16])
	nodeid := le.Uint64(req[16:24])
	body := req[fuseInHeaderSize:]

	s.fuseRequests.Add(1)

	switch opcode {
	case opForget, opBatchForget:
		return nil
	case opDestroy:
		return makeErrorReply(unique, 0)
	case opInit:
		return s.handleInit(unique, body)
	case opLookup:
		s.metadataCalls.Add(1)
		return s.handleLookup(unique, nodeid, body)
	case opGetattr:
		s.metadataCalls.Add(1)
		return s.handleGetattr(unique, nodeid)
	case opSetattr:
		s.writeCalls.Add(1)
		return s.handleSetattr(ctx, unique, nodeid, body)
	case opReadlink:
		s.metadataCalls.Add(1)
		return s.handleReadlink(unique, nodeid)
	case opSymlink:
		s.writeCalls.Add(1)
		return s.handleSymlink(unique, nodeid, body)
	case opMknod:
		s.writeCalls.Add(1)
		return s.handleMknod(unique, nodeid, body)
	case opMkdir:
		s.writeCalls.Add(1)
		return s.handleMkdir(unique, nodeid, body)
	case opUnlink:
		s.writeCalls.Add(1)
		return s.handleUnlink(unique, nodeid, body, false)
	case opRmdir:
		s.writeCalls.Add(1)
		return s.handleUnlink(unique, nodeid, body, true)
	case opRename:
		s.writeCalls.Add(1)
		return s.handleRename(unique, nodeid, body, false)
	case opRename2:
		s.writeCalls.Add(1)
		return s.handleRename(unique, nodeid, body, true)
	case opOpen:
		return s.handleOpen(ctx, unique, nodeid, body, false)
	case opOpendir:
		return s.handleOpen(ctx, unique, nodeid, body, true)
	case opCreate:
		s.writeCalls.Add(1)
		return s.handleCreate(unique, nodeid, body)
	case opRead:
		s.readCalls.Add(1)
		return s.handleRead(ctx, unique, nodeid, body)
	case opWrite:
		s.writeCalls.Add(1)
		return s.handleWrite(ctx, unique, nodeid, body)
	case opReaddir:
		s.metadataCalls.Add(1)
		return s.handleReaddir(unique, nodeid, body, false)
	case opReaddirplus:
		s.metadataCalls.Add(1)
		return s.handleReaddir(unique, nodeid, body, true)
	case opStatfs:
		s.metadataCalls.Add(1)
		return s.handleStatfs(unique)
	case opRelease, opReleasedir, opFlush, opFsync, opFsyncdir:
		return makeErrorReply(unique, 0)
	case opAccess:
		s.metadataCalls.Add(1)
		s.mu.RLock()
		_, ok := s.nodes[nodeid]
		s.mu.RUnlock()
		if !ok {
			return makeErrorReply(unique, -int32(syscall.ENOENT))
		}
		return makeErrorReply(unique, 0)
	case opGetxattr:
		return makeErrorReply(unique, -int32(syscall.ENODATA))
	case opListxattr:
		if len(body) >= 4 && le.Uint32(body[0:4]) == 0 {
			out := make([]byte, fuseOutHeaderSize+8)
			return finishReply(out, unique, 0)
		}
		return makeErrorReply(unique, 0)
	default:
		return makeErrorReply(unique, -int32(syscall.ENOSYS))
	}
}

func (s *CowFuseServer) handleInit(unique uint64, body []byte) []byte {
	if len(body) < 16 {
		return makeErrorReply(unique, -int32(syscall.EIO))
	}
	le := binary.LittleEndian
	inMajor := le.Uint32(body[0:4])
	inMinor := le.Uint32(body[4:8])
	inReadahead := le.Uint32(body[8:12])
	inFlags := le.Uint32(body[12:16])
	var inFlags2 uint32
	if len(body) >= 20 && inFlags&capInitExt != 0 {
		inFlags2 = le.Uint32(body[16:20])
	}
	s.negotiatedFlags.Store(inFlags)
	s.negotiatedFlags2.Store(inFlags2)
	log.Printf("cowfuse: FUSE_INIT in=%d.%d flags=0x%08x flags2=0x%08x bodyLen=%d", inMajor, inMinor, inFlags, inFlags2, len(body))

	wantFlags := capAsyncRead | capAtomicOTrunc | capBigWrites | capDoReaddirplus | capReaddirplusAut | capParallelDirops | capMaxPages
	if s.cfg.WritebackCache {
		wantFlags |= capWritebackCache
	}
	outFlags := inFlags & wantFlags
	minor := fuseKernelMinorVersion
	if inMinor < uint32(minor) {
		minor = int(inMinor)
	}
	readahead := inReadahead
	if readahead == 0 || readahead > 128*1024 {
		readahead = 128 * 1024
	}

	out := make([]byte, fuseOutHeaderSize+fuseInitOutSize)
	b := out[fuseOutHeaderSize:]
	le.PutUint32(b[0:4], minUint32(inMajor, fuseKernelVersion))
	le.PutUint32(b[4:8], uint32(minor))
	le.PutUint32(b[8:12], readahead)
	le.PutUint32(b[12:16], outFlags)
	le.PutUint16(b[16:18], 64)
	le.PutUint16(b[18:20], 48)
	le.PutUint32(b[20:24], 128*1024)
	le.PutUint32(b[24:28], 1)
	le.PutUint16(b[28:30], 32)
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) handleLookup(unique, parentIno uint64, body []byte) []byte {
	name := cString(body)
	s.mu.RLock()
	parent := s.nodes[parentIno]
	if parent == nil || !parent.isDir() {
		s.mu.RUnlock()
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	child, ok := parent.children[name]
	if !ok {
		s.mu.RUnlock()
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	out := make([]byte, fuseOutHeaderSize+fuseEntryOutSize)
	s.encodeEntryOut(out[fuseOutHeaderSize:], child)
	s.mu.RUnlock()
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) handleGetattr(unique, nodeid uint64) []byte {
	s.mu.RLock()
	n := s.nodes[nodeid]
	if n == nil {
		s.mu.RUnlock()
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	out := make([]byte, fuseOutHeaderSize+fuseAttrOutSize)
	binary.LittleEndian.PutUint64(out[fuseOutHeaderSize:fuseOutHeaderSize+8], s.cfg.CacheTTLSec)
	encodeAttr(out[fuseOutHeaderSize+16:], n)
	s.mu.RUnlock()
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) handleReadlink(unique, nodeid uint64) []byte {
	s.mu.RLock()
	n := s.nodes[nodeid]
	if n == nil {
		s.mu.RUnlock()
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	if !n.isSymlink() {
		s.mu.RUnlock()
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	target := n.linkTarget
	s.mu.RUnlock()
	out := make([]byte, fuseOutHeaderSize+len(target))
	copy(out[fuseOutHeaderSize:], target)
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) handleSymlink(unique, parentIno uint64, body []byte) []byte {
	idx := 0
	for idx < len(body) && body[idx] != 0 {
		idx++
	}
	if idx >= len(body) {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	name := string(body[:idx])
	linkTarget := cString(body[idx+1:])
	now := time.Now()

	s.mu.Lock()
	parent := s.nodes[parentIno]
	if parent == nil || !parent.isDir() {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.ENOTDIR))
	}
	if _, exists := parent.children[name]; exists {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.EEXIST))
	}
	ino := s.nextIno
	s.nextIno++
	n := &cowNode{
		ino:        ino,
		parent:     parent.ino,
		name:       name,
		mode:       S_IFLNK | 0o777,
		size:       uint64(len(linkTarget)),
		nlink:      1,
		uid:        s.uid,
		gid:        s.gid,
		mtimeSec:   uint64(now.Unix()),
		mtimeNsec:  uint32(now.Nanosecond()),
		linkTarget: linkTarget,
		dirty:      true,
	}
	parent.children[name] = n
	s.nodes[ino] = n
	rel := s.nodePathLocked(n)
	s.dirtyPaths[rel] = struct{}{}
	delete(s.deletedPaths, rel)

	out := make([]byte, fuseOutHeaderSize+fuseEntryOutSize)
	s.encodeEntryOut(out[fuseOutHeaderSize:], n)
	s.mu.Unlock()
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) handleMkdir(unique, parentIno uint64, body []byte) []byte {
	if len(body) < 9 {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	mode := binary.LittleEndian.Uint32(body[0:4])
	name := cString(body[8:])
	now := time.Now()

	s.mu.Lock()
	parent := s.nodes[parentIno]
	if parent == nil || !parent.isDir() {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.ENOTDIR))
	}
	if _, exists := parent.children[name]; exists {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.EEXIST))
	}
	ino := s.nextIno
	s.nextIno++
	n := &cowNode{
		ino:       ino,
		parent:    parent.ino,
		name:      name,
		mode:      S_IFDIR | (mode & 0o777),
		nlink:     2,
		uid:       s.uid,
		gid:       s.gid,
		mtimeSec:  uint64(now.Unix()),
		mtimeNsec: uint32(now.Nanosecond()),
		children:  make(map[string]*cowNode),
	}
	parent.children[name] = n
	parent.nlink++
	s.nodes[ino] = n

	out := make([]byte, fuseOutHeaderSize+fuseEntryOutSize)
	s.encodeEntryOut(out[fuseOutHeaderSize:], n)
	s.mu.Unlock()
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) createFileLocked(parent *cowNode, name string, mode uint32) (*cowNode, error) {
	now := time.Now()
	ino := s.nextIno
	s.nextIno++
	up := filepath.Join(s.upperDir, fmt.Sprintf("%d.blob", ino))
	f, err := os.OpenFile(up, os.O_CREATE|os.O_RDWR|os.O_TRUNC, 0o644)
	if err != nil {
		return nil, err
	}
	_ = f.Close()
	perm := mode & 0o777
	if perm == 0 {
		perm = 0o644
	}
	n := &cowNode{
		ino:       ino,
		parent:    parent.ino,
		name:      name,
		mode:      S_IFREG | perm,
		size:      0,
		nlink:     1,
		uid:       s.uid,
		gid:       s.gid,
		mtimeSec:  uint64(now.Unix()),
		mtimeNsec: uint32(now.Nanosecond()),
		upperPath: up,
		dirty:     true,
	}
	parent.children[name] = n
	s.nodes[ino] = n
	rel := s.nodePathLocked(n)
	s.dirtyPaths[rel] = struct{}{}
	delete(s.deletedPaths, rel)
	return n, nil
}

func (s *CowFuseServer) handleMknod(unique, parentIno uint64, body []byte) []byte {
	if len(body) < 17 {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	mode := binary.LittleEndian.Uint32(body[0:4])
	name := cString(body[16:])
	s.mu.Lock()
	parent := s.nodes[parentIno]
	if parent == nil || !parent.isDir() {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.ENOTDIR))
	}
	if _, exists := parent.children[name]; exists {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.EEXIST))
	}
	n, err := s.createFileLocked(parent, name, mode)
	if err != nil {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.EIO))
	}
	out := make([]byte, fuseOutHeaderSize+fuseEntryOutSize)
	s.encodeEntryOut(out[fuseOutHeaderSize:], n)
	s.mu.Unlock()
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) handleCreate(unique, parentIno uint64, body []byte) []byte {
	if len(body) < 17 {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	mode := binary.LittleEndian.Uint32(body[4:8])
	name := cString(body[16:])
	s.mu.Lock()
	parent := s.nodes[parentIno]
	if parent == nil || !parent.isDir() {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.ENOTDIR))
	}
	n, exists := parent.children[name]
	if !exists {
		var err error
		n, err = s.createFileLocked(parent, name, mode)
		if err != nil {
			s.mu.Unlock()
			return makeErrorReply(unique, -int32(syscall.EIO))
		}
	}
	out := make([]byte, fuseOutHeaderSize+fuseEntryOutSize+fuseOpenOutSize)
	s.encodeEntryOut(out[fuseOutHeaderSize:fuseOutHeaderSize+fuseEntryOutSize], n)
	le := binary.LittleEndian
	openOff := fuseOutHeaderSize + fuseEntryOutSize
	le.PutUint64(out[openOff:openOff+8], n.ino)
	openFlags := fopenDirectIO
	if s.cfg.WritebackCache {
		openFlags = fopenKeepCache
	}
	le.PutUint32(out[openOff+8:openOff+12], openFlags)
	s.mu.Unlock()
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) handleUnlink(unique, parentIno uint64, body []byte, isDir bool) []byte {
	name := cString(body)
	s.mu.Lock()
	parent := s.nodes[parentIno]
	if parent == nil || !parent.isDir() {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.ENOTDIR))
	}
	child, ok := parent.children[name]
	if !ok {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	if isDir {
		if !child.isDir() {
			s.mu.Unlock()
			return makeErrorReply(unique, -int32(syscall.ENOTDIR))
		}
		if len(child.children) > 0 {
			s.mu.Unlock()
			return makeErrorReply(unique, -int32(syscall.ENOTEMPTY))
		}
		delete(parent.children, name)
		if parent.nlink > 2 {
			parent.nlink--
		}
		s.mu.Unlock()
		return makeErrorReply(unique, 0)
	}
	if child.isDir() {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.EISDIR))
	}
	rel := s.nodePathLocked(child)
	delete(parent.children, name)
	delete(s.dirtyPaths, rel)
	s.deletedPaths[rel] = struct{}{}
	if child.upperPath != "" {
		_ = os.Remove(child.upperPath)
		child.upperPath = ""
	}
	s.mu.Unlock()
	return makeErrorReply(unique, 0)
}

func (s *CowFuseServer) collectLeafPathsLocked(n *cowNode, prefix string, out *[]string) {
	if !n.isDir() {
		*out = append(*out, prefix)
		return
	}
	for name, ch := range n.children {
		sub := name
		if prefix != "" {
			sub = prefix + "/" + name
		}
		s.collectLeafPathsLocked(ch, sub, out)
	}
}

func (s *CowFuseServer) handleRename(unique, oldParentIno uint64, body []byte, v2 bool) []byte {
	hdrLen := 8
	if v2 {
		hdrLen = 16
	}
	if len(body) <= hdrLen {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	newParentIno := binary.LittleEndian.Uint64(body[0:8])
	rest := body[hdrLen:]
	idx := 0
	for idx < len(rest) && rest[idx] != 0 {
		idx++
	}
	if idx >= len(rest) {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	oldName := string(rest[:idx])
	newName := cString(rest[idx+1:])

	s.mu.Lock()
	oldParent := s.nodes[oldParentIno]
	newParent := s.nodes[newParentIno]
	if oldParent == nil || newParent == nil || !oldParent.isDir() || !newParent.isDir() {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	node, ok := oldParent.children[oldName]
	if !ok {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}

	oldRel := s.nodePathLocked(node)
	var oldLeaves []string
	s.collectLeafPathsLocked(node, oldRel, &oldLeaves)

	if replaced, exists := newParent.children[newName]; exists {
		if replaced.isDir() && len(replaced.children) > 0 {
			s.mu.Unlock()
			return makeErrorReply(unique, -int32(syscall.ENOTEMPTY))
		}
		repRel := s.nodePathLocked(replaced)
		delete(s.dirtyPaths, repRel)
		s.deletedPaths[repRel] = struct{}{}
	}

	delete(oldParent.children, oldName)
	if node.isDir() && oldParent != newParent {
		if oldParent.nlink > 2 {
			oldParent.nlink--
		}
		newParent.nlink++
	}
	node.parent = newParent.ino
	node.name = newName
	newParent.children[newName] = node

	for _, ol := range oldLeaves {
		delete(s.dirtyPaths, ol)
		s.deletedPaths[ol] = struct{}{}
	}

	newRel := s.nodePathLocked(node)
	var newLeaves []string
	s.collectLeafPathsLocked(node, newRel, &newLeaves)
	for _, nl := range newLeaves {
		leaf := s.lookupPathLocked(nl)
		if leaf != nil && !leaf.isDir() {
			// Ensure untouched lower blobs moved to a new path get copied up before CollectDelta.
			if leaf.upperPath == "" && !leaf.isSymlink() && leaf.blobHash != "" {
				hash := leaf.blobHash
				s.mu.Unlock()
				data, err := s.fetchBlobSingleFlight(context.Background(), hash)
				s.mu.Lock()
				if err == nil && leaf.upperPath == "" {
					up := filepath.Join(s.upperDir, fmt.Sprintf("%d.blob", leaf.ino))
					if wErr := os.WriteFile(up, data, 0o644); wErr == nil {
						leaf.upperPath = up
					}
				}
			}
			leaf.dirty = true
			s.dirtyPaths[nl] = struct{}{}
			delete(s.deletedPaths, nl)
		}
	}

	s.mu.Unlock()
	return makeErrorReply(unique, 0)
}

func (s *CowFuseServer) ensureUpperFile(ctx context.Context, nodeid uint64, truncateToZero bool) (string, error) {
	s.mu.RLock()
	n := s.nodes[nodeid]
	if n == nil {
		s.mu.RUnlock()
		return "", syscall.ENOENT
	}
	if n.upperPath != "" {
		up := n.upperPath
		s.mu.RUnlock()
		return up, nil
	}
	hash := n.blobHash
	size := n.size
	s.mu.RUnlock()

	var initial []byte
	if !truncateToZero && size > 0 && hash != "" {
		var err error
		initial, err = s.fetchBlobSingleFlight(ctx, hash)
		if err != nil {
			return "", err
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	n = s.nodes[nodeid]
	if n == nil {
		return "", syscall.ENOENT
	}
	if n.upperPath == "" {
		up := filepath.Join(s.upperDir, fmt.Sprintf("%d.blob", n.ino))
		if err := os.WriteFile(up, initial, 0o644); err != nil {
			return "", err
		}
		n.upperPath = up
	}
	return n.upperPath, nil
}

func (s *CowFuseServer) handleSetattr(ctx context.Context, unique, nodeid uint64, body []byte) []byte {
	if len(body) < 88 {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	le := binary.LittleEndian
	valid := le.Uint32(body[0:4])
	newSize := le.Uint64(body[16:24])
	newMtime := le.Uint64(body[40:48])
	newMtimeNsec := le.Uint32(body[60:64])
	newMode := le.Uint32(body[68:72])

	if valid&(fattrSize|fattrMode) != 0 {
		s.mu.RLock()
		n := s.nodes[nodeid]
		isReg := n != nil && !n.isDir() && !n.isSymlink()
		s.mu.RUnlock()
		if isReg {
			up, err := s.ensureUpperFile(ctx, nodeid, valid&fattrSize != 0 && newSize == 0)
			if err != nil {
				return makeErrorReply(unique, -int32(syscall.EIO))
			}
			if valid&fattrSize != 0 {
				if err := os.Truncate(up, int64(newSize)); err != nil {
					return makeErrorReply(unique, -int32(syscall.EIO))
				}
			}
		}
	}

	now := time.Now()
	s.mu.Lock()
	n := s.nodes[nodeid]
	if n == nil {
		s.mu.Unlock()
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	mutated := false
	if valid&fattrSize != 0 && !n.isDir() {
		n.size = newSize
		mutated = true
	}
	if valid&fattrMode != 0 {
		n.mode = (n.mode & S_IFMT) | (newMode & 0o7777)
		mutated = true
	}
	if valid&fattrMtimeNow != 0 {
		n.mtimeSec = uint64(now.Unix())
		n.mtimeNsec = uint32(now.Nanosecond())
	} else if valid&fattrMtime != 0 {
		n.mtimeSec = newMtime
		n.mtimeNsec = newMtimeNsec
	}
	if mutated && !n.isDir() {
		n.dirty = true
		rel := s.nodePathLocked(n)
		s.dirtyPaths[rel] = struct{}{}
		delete(s.deletedPaths, rel)
	}
	out := make([]byte, fuseOutHeaderSize+fuseAttrOutSize)
	binary.LittleEndian.PutUint64(out[fuseOutHeaderSize:fuseOutHeaderSize+8], s.cfg.CacheTTLSec)
	encodeAttr(out[fuseOutHeaderSize+16:], n)
	s.mu.Unlock()
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) handleOpen(ctx context.Context, unique, nodeid uint64, body []byte, dir bool) []byte {
	flags := uint32(0)
	if len(body) >= 4 {
		flags = binary.LittleEndian.Uint32(body[0:4])
	}
	s.mu.RLock()
	n := s.nodes[nodeid]
	if n == nil {
		s.mu.RUnlock()
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	if dir && !n.isDir() {
		s.mu.RUnlock()
		return makeErrorReply(unique, -int32(syscall.ENOTDIR))
	}
	if !dir && n.isDir() {
		s.mu.RUnlock()
		return makeErrorReply(unique, -int32(syscall.EISDIR))
	}
	s.mu.RUnlock()

	if !dir && flags&uint32(syscall.O_TRUNC) != 0 {
		up, err := s.ensureUpperFile(ctx, nodeid, true)
		if err != nil {
			return makeErrorReply(unique, -int32(syscall.EIO))
		}
		if err := os.Truncate(up, 0); err != nil {
			return makeErrorReply(unique, -int32(syscall.EIO))
		}
		s.mu.Lock()
		if n := s.nodes[nodeid]; n != nil {
			n.size = 0
			n.dirty = true
			rel := s.nodePathLocked(n)
			s.dirtyPaths[rel] = struct{}{}
			delete(s.deletedPaths, rel)
		}
		s.mu.Unlock()
	}

	out := make([]byte, fuseOutHeaderSize+fuseOpenOutSize)
	binary.LittleEndian.PutUint64(out[fuseOutHeaderSize:], nodeid)
	if !dir {
		openFlags := fopenDirectIO
		if s.cfg.WritebackCache {
			openFlags = fopenKeepCache
		}
		binary.LittleEndian.PutUint32(out[fuseOutHeaderSize+8:], openFlags)
	}
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) handleRead(ctx context.Context, unique, nodeid uint64, body []byte) []byte {
	if len(body) < 20 {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	le := binary.LittleEndian
	offset := le.Uint64(body[8:16])
	size := le.Uint32(body[16:20])

	s.mu.RLock()
	n := s.nodes[nodeid]
	if n == nil {
		s.mu.RUnlock()
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	if n.isDir() {
		s.mu.RUnlock()
		return makeErrorReply(unique, -int32(syscall.EISDIR))
	}
	up := n.upperPath
	hash := n.blobHash
	fileSize := n.size
	s.mu.RUnlock()

	if offset >= fileSize || size == 0 {
		return makeErrorReply(unique, 0)
	}

	if up != "" {
		f, err := os.Open(up)
		if err != nil {
			return makeErrorReply(unique, -int32(syscall.EIO))
		}
		buf := make([]byte, size)
		nr, rErr := f.ReadAt(buf, int64(offset))
		_ = f.Close()
		if rErr != nil && !errors.Is(rErr, io.EOF) {
			return makeErrorReply(unique, -int32(syscall.EIO))
		}
		out := make([]byte, fuseOutHeaderSize+nr)
		copy(out[fuseOutHeaderSize:], buf[:nr])
		return finishReply(out, unique, 0)
	}

	data, err := s.fetchBlobSingleFlight(ctx, hash)
	if err != nil {
		return makeErrorReply(unique, -int32(syscall.EIO))
	}
	if offset >= uint64(len(data)) {
		return makeErrorReply(unique, 0)
	}
	end := offset + uint64(size)
	if end > uint64(len(data)) {
		end = uint64(len(data))
	}
	slice := data[offset:end]
	out := make([]byte, fuseOutHeaderSize+len(slice))
	copy(out[fuseOutHeaderSize:], slice)
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) handleWrite(ctx context.Context, unique, nodeid uint64, body []byte) []byte {
	if len(body) < 40 {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	le := binary.LittleEndian
	offset := le.Uint64(body[8:16])
	size := le.Uint32(body[16:20])
	payload := body[40:]
	if uint32(len(payload)) > size {
		payload = payload[:size]
	}

	up, err := s.ensureUpperFile(ctx, nodeid, false)
	if err != nil {
		return makeErrorReply(unique, -int32(syscall.EIO))
	}
	f, err := os.OpenFile(up, os.O_RDWR, 0o644)
	if err != nil {
		return makeErrorReply(unique, -int32(syscall.EIO))
	}
	nw, wErr := f.WriteAt(payload, int64(offset))
	_ = f.Close()
	if wErr != nil {
		return makeErrorReply(unique, -int32(syscall.EIO))
	}

	now := time.Now()
	s.mu.Lock()
	if n := s.nodes[nodeid]; n != nil {
		end := offset + uint64(nw)
		if end > n.size {
			n.size = end
		}
		n.mtimeSec = uint64(now.Unix())
		n.mtimeNsec = uint32(now.Nanosecond())
		n.dirty = true
		rel := s.nodePathLocked(n)
		s.dirtyPaths[rel] = struct{}{}
		delete(s.deletedPaths, rel)
	}
	s.mu.Unlock()

	out := make([]byte, fuseOutHeaderSize+fuseWriteOutSize)
	le.PutUint32(out[fuseOutHeaderSize:fuseOutHeaderSize+4], uint32(nw))
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) fetchBlobSingleFlight(ctx context.Context, hash string) ([]byte, error) {
	if hash == "" {
		return nil, nil
	}
	s.mu.RLock()
	if cached, ok := s.blobCache[hash]; ok {
		s.mu.RUnlock()
		return cached, nil
	}
	s.mu.RUnlock()

	s.sfMu.Lock()
	if call, ok := s.inFlight[hash]; ok {
		s.sfMu.Unlock()
		select {
		case <-call.done:
			return call.data, call.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	call := &inFlightCall{done: make(chan struct{})}
	s.inFlight[hash] = call
	s.sfMu.Unlock()

	fetched, err := s.fetcher.FetchBlob(ctx, hash)
	if err == nil {
		s.blobFetches.Add(1)
		s.blobBytesFetched.Add(int64(len(fetched)))
		s.mu.Lock()
		s.blobCache[hash] = fetched
		s.mu.Unlock()
	}
	call.data = fetched
	call.err = err
	close(call.done)

	s.sfMu.Lock()
	delete(s.inFlight, hash)
	s.sfMu.Unlock()
	return fetched, err
}

func (s *CowFuseServer) handleReaddir(unique, nodeid uint64, body []byte, plus bool) []byte {
	if len(body) < 20 {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	le := binary.LittleEndian
	offset := le.Uint64(body[8:16])
	maxSize := int(le.Uint32(body[16:20]))
	if maxSize <= 0 {
		return makeErrorReply(unique, 0)
	}

	s.mu.RLock()
	n := s.nodes[nodeid]
	if n == nil || !n.isDir() {
		s.mu.RUnlock()
		return makeErrorReply(unique, -int32(syscall.ENOTDIR))
	}
	parentNode := s.nodes[n.parent]
	if parentNode == nil {
		parentNode = n
	}
	children := make([]*cowNode, 0, len(n.children))
	for _, ch := range n.children {
		children = append(children, ch)
	}
	sort.Slice(children, func(i, j int) bool { return children[i].name < children[j].name })

	total := 2 + len(children)
	outCap := fuseOutHeaderSize + minInt(maxSize, 64*1024)
	out := make([]byte, fuseOutHeaderSize, outCap)

	for idx := int(offset); idx < total; idx++ {
		var entryName string
		var target *cowNode
		switch idx {
		case 0:
			entryName = "."
			target = n
		case 1:
			entryName = ".."
			target = parentNode
		default:
			target = children[idx-2]
			entryName = target.name
		}
		nextOff := uint64(idx + 1)
		nameLen := len(entryName)
		hdrSize := fuseDirentHdrSize
		if plus {
			hdrSize = fuseDirentPlusHdrSize
		}
		recLen := align8(hdrSize + nameLen)
		if len(out)-fuseOutHeaderSize+recLen > maxSize {
			break
		}
		start := len(out)
		out = append(out, make([]byte, recLen)...)
		dOff := start
		if plus {
			s.encodeEntryOut(out[start:start+fuseEntryOutSize], target)
			dOff = start + fuseEntryOutSize
		}
		le.PutUint64(out[dOff:dOff+8], target.ino)
		le.PutUint64(out[dOff+8:dOff+16], nextOff)
		le.PutUint32(out[dOff+16:dOff+20], uint32(nameLen))
		le.PutUint32(out[dOff+20:dOff+24], direntType(target.mode))
		copy(out[dOff+24:], entryName)
	}
	s.mu.RUnlock()
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) handleStatfs(unique uint64) []byte {
	out := make([]byte, fuseOutHeaderSize+fuseKstatfsSize)
	le := binary.LittleEndian
	b := out[fuseOutHeaderSize:]
	le.PutUint64(b[0:8], 1<<20)
	le.PutUint64(b[8:16], 1<<19)
	le.PutUint64(b[16:24], 1<<19)
	le.PutUint64(b[24:32], 1<<16)
	le.PutUint64(b[32:40], 1<<15)
	le.PutUint32(b[40:44], 4096)
	le.PutUint32(b[44:48], 255)
	le.PutUint32(b[48:52], 4096)
	return finishReply(out, unique, 0)
}

func (s *CowFuseServer) encodeEntryOut(dst []byte, n *cowNode) {
	le := binary.LittleEndian
	le.PutUint64(dst[0:8], n.ino)
	le.PutUint64(dst[8:16], 1)
	le.PutUint64(dst[16:24], s.cfg.CacheTTLSec)
	le.PutUint64(dst[24:32], s.cfg.CacheTTLSec)
	encodeAttr(dst[40:40+fuseAttrSize], n)
}

func encodeAttr(dst []byte, n *cowNode) {
	le := binary.LittleEndian
	blocks := (n.size + 511) / 512
	le.PutUint64(dst[0:8], n.ino)
	le.PutUint64(dst[8:16], n.size)
	le.PutUint64(dst[16:24], blocks)
	le.PutUint64(dst[24:32], n.mtimeSec)
	le.PutUint64(dst[32:40], n.mtimeSec)
	le.PutUint64(dst[40:48], n.mtimeSec)
	le.PutUint32(dst[48:52], n.mtimeNsec)
	le.PutUint32(dst[52:56], n.mtimeNsec)
	le.PutUint32(dst[56:60], n.mtimeNsec)
	le.PutUint32(dst[60:64], n.mode)
	le.PutUint32(dst[64:68], n.nlink)
	le.PutUint32(dst[68:72], n.uid)
	le.PutUint32(dst[72:76], n.gid)
	le.PutUint32(dst[80:84], 4096)
}

func makeErrorReply(unique uint64, errno int32) []byte {
	out := make([]byte, fuseOutHeaderSize)
	return finishReply(out, unique, errno)
}

func finishReply(pkt []byte, unique uint64, errno int32) []byte {
	binary.LittleEndian.PutUint32(pkt[0:4], uint32(len(pkt)))
	binary.LittleEndian.PutUint32(pkt[4:8], uint32(errno))
	binary.LittleEndian.PutUint64(pkt[8:16], unique)
	return pkt
}

func cString(b []byte) string {
	for i, c := range b {
		if c == 0 {
			return string(b[:i])
		}
	}
	return string(b)
}

func align8(n int) int { return (n + 7) &^ 7 }

func direntType(mode uint32) uint32 {
	switch mode & S_IFMT {
	case S_IFDIR:
		return 4
	case S_IFLNK:
		return 10
	default:
		return 8
	}
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func minUint32(a, b uint32) uint32 {
	if a < b {
		return a
	}
	return b
}
