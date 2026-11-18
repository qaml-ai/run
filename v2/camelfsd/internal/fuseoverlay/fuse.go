package fuseoverlay

import (
	"context"
	"encoding/binary"
	"errors"
	"io"
	"os"
	"path"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
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
	opOpen        uint32 = 14
	opRead        uint32 = 15
	opStatfs      uint32 = 17
	opRelease     uint32 = 18
	opGetxattr    uint32 = 22
	opListxattr   uint32 = 23
	opFlush       uint32 = 25
	opInit        uint32 = 26
	opOpendir     uint32 = 27
	opReaddir     uint32 = 28
	opReleasedir  uint32 = 29
	opAccess      uint32 = 34
	opDestroy     uint32 = 38
	opBatchForget uint32 = 42
	opReaddirplus uint32 = 44
)

const (
	fopenKeepCache uint32 = 1 << 1
	fopenCacheDir  uint32 = 1 << 3
)

const (
	capAsyncRead      uint32 = 1 << 0
	capDoReaddirplus  uint32 = 1 << 13
	capReaddirplusAut uint32 = 1 << 14
	capNoOpenSupport  uint32 = 1 << 17
	capParallelDirops uint32 = 1 << 18
	capMaxPages       uint32 = 1 << 22
	capCacheSymlinks  uint32 = 1 << 23
	capNoOpendirSupp  uint32 = 1 << 24
)

// TreeEntry describes one immutable file, directory, or symlink in a snapshot manifest.
type TreeEntry struct {
	Path       string
	Mode       uint32
	Size       uint64
	BlobHash   string
	LinkTarget string
	ModTime    time.Time
}

// BlobFetcher fetches immutable blob bytes lazily by content hash.
type BlobFetcher interface {
	FetchBlob(ctx context.Context, hash string) ([]byte, error)
}

// BlobFetcherFunc adapts a plain function to BlobFetcher.
type BlobFetcherFunc func(ctx context.Context, hash string) ([]byte, error)

// FetchBlob invokes f(ctx, hash).
func (f BlobFetcherFunc) FetchBlob(ctx context.Context, hash string) ([]byte, error) {
	return f(ctx, hash)
}

// ServerConfig configures the read-only cached-manifest FUSE server.
type ServerConfig struct {
	DisableNoOpen   bool
	CacheTTLSeconds uint64
	Workers         int
}

type fuseNode struct {
	ino        uint64
	name       string
	fullPath   string
	parent     uint64
	mode       uint32
	size       uint64
	mtimeSec   uint64
	mtimeNsec  uint32
	nlink      uint32
	blobHash   string
	linkTarget string

	children   []*fuseNode
	childByNam map[string]*fuseNode

	dataOnce sync.Once
	data     []byte
	dataErr  error
}

// ReadOnlyFuseServer serves an immutable repo snapshot over the Linux /dev/fuse wire ABI.
// Metadata (LOOKUP, GETATTR, READLINK, READDIR/READDIRPLUS) is answered from RAM with zero RPCs;
// file contents are fetched lazily once per blob via BlobFetcher and cached for subsequent reads.
type ReadOnlyFuseServer struct {
	fetcher BlobFetcher
	cfg     ServerConfig
	nodes   []*fuseNode

	blobCacheMu sync.RWMutex
	blobCache   map[string][]byte

	sfMu     sync.Mutex
	inFlight map[string]*inFlightCall

	noOpenNegotiated atomic.Bool
	fuseRequests     atomic.Int64
	metadataCalls    atomic.Int64
	readCalls        atomic.Int64
}

type inFlightCall struct {
	done chan struct{}
	data []byte
	err  error
}

func normalizeMode(e TreeEntry) uint32 {
	m := e.Mode
	if e.LinkTarget != "" {
		if m&S_IFMT == 0 {
			perm := m & 0o777
			if perm == 0 {
				perm = 0o777
			}
			return S_IFLNK | perm
		}
		return m
	}
	if m&S_IFMT == 0 {
		perm := m & 0o777
		if perm == 0 {
			perm = 0o644
		}
		return S_IFREG | perm
	}
	return m
}

// NewReadOnlyFuseServer builds the immutable inode tree from manifest in O(N).
func NewReadOnlyFuseServer(manifest []TreeEntry, fetcher BlobFetcher, cfg ServerConfig) *ReadOnlyFuseServer {
	if cfg.CacheTTLSeconds == 0 {
		cfg.CacheTTLSeconds = 1 << 30
	}
	if cfg.Workers <= 0 {
		cfg.Workers = 4
	}
	now := time.Now()
	root := &fuseNode{
		ino:        fuseRootID,
		name:       "",
		fullPath:   "",
		parent:     fuseRootID,
		mode:       S_IFDIR | 0o755,
		nlink:      2,
		mtimeSec:   uint64(now.Unix()),
		childByNam: make(map[string]*fuseNode),
	}
	s := &ReadOnlyFuseServer{
		fetcher:   fetcher,
		cfg:       cfg,
		nodes:     []*fuseNode{nil, root},
		blobCache: make(map[string][]byte),
		inFlight:  make(map[string]*inFlightCall),
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
			if child, ok := cur.childByNam[part]; ok {
				if isLast {
					child.mode = normalizeMode(e)
					child.size = e.Size
					child.blobHash = e.BlobHash
					child.linkTarget = e.LinkTarget
					if !e.ModTime.IsZero() {
						child.mtimeSec = uint64(e.ModTime.Unix())
						child.mtimeNsec = uint32(e.ModTime.Nanosecond())
					}
				}
				cur = child
				continue
			}

			ino := uint64(len(s.nodes))
			node := &fuseNode{
				ino:      ino,
				name:     part,
				fullPath: strings.Join(parts[:i+1], "/"),
				parent:   cur.ino,
				mode:     S_IFDIR | 0o755,
				nlink:    1,
				mtimeSec: uint64(now.Unix()),
			}
			if isLast {
				node.mode = normalizeMode(e)
				node.size = e.Size
				node.blobHash = e.BlobHash
				node.linkTarget = e.LinkTarget
				if !e.ModTime.IsZero() {
					node.mtimeSec = uint64(e.ModTime.Unix())
					node.mtimeNsec = uint32(e.ModTime.Nanosecond())
				}
			}
			if node.isDir() {
				node.nlink = 2
				node.childByNam = make(map[string]*fuseNode)
				cur.nlink++
			}
			cur.childByNam[part] = node
			cur.children = append(cur.children, node)
			s.nodes = append(s.nodes, node)
			cur = node
		}
	}
	return s
}

func (n *fuseNode) isDir() bool { return n.mode&S_IFMT == S_IFDIR }

// Stats returns (fuseRequests, metadataCalls, readCalls, inodeCount).
func (s *ReadOnlyFuseServer) Stats() (int64, int64, int64, int) {
	return s.fuseRequests.Load(), s.metadataCalls.Load(), s.readCalls.Load(), len(s.nodes) - 1
}

// Serve reads raw FUSE request packets from dev and writes replies until EOF, ENODEV, or ctx cancellation.
func (s *ReadOnlyFuseServer) Serve(ctx context.Context, dev io.ReadWriter) error {
	buf := make([]byte, 128*1024+4096)
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		n, err := dev.Read(buf)
		if err != nil {
			if errors.Is(err, syscall.EINTR) {
				continue
			}
			if errors.Is(err, io.EOF) || errors.Is(err, syscall.ENODEV) || errors.Is(err, os.ErrClosed) {
				return nil
			}
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
			return err
		}
	}
}

// ServeConcurrent spawns cfg.Workers goroutines reading /dev/fuse concurrently.
func (s *ReadOnlyFuseServer) ServeConcurrent(ctx context.Context, dev *os.File) error {
	var wg sync.WaitGroup
	errCh := make(chan error, s.cfg.Workers)
	for i := 0; i < s.cfg.Workers; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.Serve(ctx, dev); err != nil {
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

// HandlePacket decodes one FUSE kernel request packet and returns the serialized reply.
func (s *ReadOnlyFuseServer) HandlePacket(ctx context.Context, req []byte) []byte {
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
	case opReadlink:
		s.metadataCalls.Add(1)
		return s.handleReadlink(unique, nodeid)
	case opOpen:
		if s.noOpenNegotiated.Load() {
			return makeErrorReply(unique, -int32(syscall.ENOSYS))
		}
		return s.handleOpen(unique, nodeid, false)
	case opOpendir:
		if s.noOpenNegotiated.Load() {
			return makeErrorReply(unique, -int32(syscall.ENOSYS))
		}
		return s.handleOpen(unique, nodeid, true)
	case opRelease, opReleasedir:
		return makeErrorReply(unique, 0)
	case opFlush:
		// Read-only mount: returning ENOSYS sets fc->no_flush=1 in Linux kernel
		// so subsequent close(2) syscalls skip FUSE_FLUSH roundtrips completely.
		return makeErrorReply(unique, -int32(syscall.ENOSYS))
	case opRead:
		s.readCalls.Add(1)
		return s.handleRead(ctx, unique, nodeid, body)
	case opReaddir:
		s.metadataCalls.Add(1)
		return s.handleReaddir(unique, nodeid, body, false)
	case opReaddirplus:
		s.metadataCalls.Add(1)
		return s.handleReaddir(unique, nodeid, body, true)
	case opStatfs:
		s.metadataCalls.Add(1)
		return s.handleStatfs(unique)
	case opAccess:
		s.metadataCalls.Add(1)
		if s.node(nodeid) == nil {
			return makeErrorReply(unique, -int32(syscall.ENOENT))
		}
		return makeErrorReply(unique, 0)
	case opGetxattr:
		if len(body) >= 4 && binary.LittleEndian.Uint32(body[0:4]) == 0 {
			return makeErrorReply(unique, -int32(syscall.ENODATA))
		}
		return makeErrorReply(unique, -int32(syscall.ENODATA))
	case opListxattr:
		if len(body) >= 4 && binary.LittleEndian.Uint32(body[0:4]) == 0 {
			out := make([]byte, fuseOutHeaderSize+8)
			return finishReply(out, unique, 0)
		}
		return makeErrorReply(unique, 0)
	case opSetattr:
		return makeErrorReply(unique, -int32(syscall.EROFS))
	default:
		return makeErrorReply(unique, -int32(syscall.ENOSYS))
	}
}

func (s *ReadOnlyFuseServer) node(ino uint64) *fuseNode {
	if ino == 0 || ino >= uint64(len(s.nodes)) {
		return nil
	}
	return s.nodes[ino]
}

func (s *ReadOnlyFuseServer) handleInit(unique uint64, body []byte) []byte {
	if len(body) < 16 {
		return makeErrorReply(unique, -int32(syscall.EIO))
	}
	le := binary.LittleEndian
	inMajor := le.Uint32(body[0:4])
	inMinor := le.Uint32(body[4:8])
	inReadahead := le.Uint32(body[8:12])
	inFlags := le.Uint32(body[12:16])

	if inMajor != fuseKernelVersion {
		out := make([]byte, fuseOutHeaderSize+fuseInitOutSize)
		le.PutUint32(out[fuseOutHeaderSize:], fuseKernelVersion)
		le.PutUint32(out[fuseOutHeaderSize+4:], fuseKernelMinorVersion)
		return finishReply(out, unique, 0)
	}

	wantFlags := capAsyncRead | capDoReaddirplus | capReaddirplusAut | capParallelDirops | capMaxPages | capCacheSymlinks
	if !s.cfg.DisableNoOpen {
		wantFlags |= capNoOpenSupport | capNoOpendirSupp
	}
	outFlags := inFlags & wantFlags
	if outFlags&capNoOpenSupport != 0 {
		s.noOpenNegotiated.Store(true)
	}

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
	le.PutUint32(b[0:4], fuseKernelVersion)
	le.PutUint32(b[4:8], uint32(minor))
	le.PutUint32(b[8:12], readahead)
	le.PutUint32(b[12:16], outFlags)
	le.PutUint16(b[16:18], 64)
	le.PutUint16(b[18:20], 48)
	le.PutUint32(b[20:24], 65536)
	le.PutUint32(b[24:28], 1)
	le.PutUint16(b[28:30], 32)
	return finishReply(out, unique, 0)
}

func (s *ReadOnlyFuseServer) handleLookup(unique uint64, parentIno uint64, body []byte) []byte {
	parent := s.node(parentIno)
	if parent == nil || !parent.isDir() {
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	name := cString(body)
	child, ok := parent.childByNam[name]
	if !ok {
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	out := make([]byte, fuseOutHeaderSize+fuseEntryOutSize)
	s.encodeEntryOut(out[fuseOutHeaderSize:], child)
	return finishReply(out, unique, 0)
}

func (s *ReadOnlyFuseServer) handleGetattr(unique uint64, nodeid uint64) []byte {
	n := s.node(nodeid)
	if n == nil {
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	out := make([]byte, fuseOutHeaderSize+fuseAttrOutSize)
	le := binary.LittleEndian
	b := out[fuseOutHeaderSize:]
	le.PutUint64(b[0:8], s.cfg.CacheTTLSeconds)
	encodeAttr(b[16:], n)
	return finishReply(out, unique, 0)
}

func (s *ReadOnlyFuseServer) handleReadlink(unique uint64, nodeid uint64) []byte {
	n := s.node(nodeid)
	if n == nil {
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	if n.mode&S_IFMT != S_IFLNK {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	out := make([]byte, fuseOutHeaderSize+len(n.linkTarget))
	copy(out[fuseOutHeaderSize:], n.linkTarget)
	return finishReply(out, unique, 0)
}

func (s *ReadOnlyFuseServer) handleOpen(unique uint64, nodeid uint64, dir bool) []byte {
	n := s.node(nodeid)
	if n == nil {
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	if dir && !n.isDir() {
		return makeErrorReply(unique, -int32(syscall.ENOTDIR))
	}
	if !dir && n.isDir() {
		return makeErrorReply(unique, -int32(syscall.EISDIR))
	}
	out := make([]byte, fuseOutHeaderSize+fuseOpenOutSize)
	flags := fopenKeepCache
	if dir {
		flags |= fopenCacheDir
	}
	binary.LittleEndian.PutUint64(out[fuseOutHeaderSize:], n.ino)
	binary.LittleEndian.PutUint32(out[fuseOutHeaderSize+8:], flags)
	return finishReply(out, unique, 0)
}

func (s *ReadOnlyFuseServer) handleRead(ctx context.Context, unique uint64, nodeid uint64, body []byte) []byte {
	if len(body) < 20 {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	n := s.node(nodeid)
	if n == nil {
		return makeErrorReply(unique, -int32(syscall.ENOENT))
	}
	if n.isDir() {
		return makeErrorReply(unique, -int32(syscall.EISDIR))
	}
	le := binary.LittleEndian
	offset := le.Uint64(body[8:16])
	size := le.Uint32(body[16:20])

	if offset >= n.size || size == 0 {
		return makeErrorReply(unique, 0)
	}
	data, err := s.loadNodeData(ctx, n)
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

func (s *ReadOnlyFuseServer) fetchBlobSingleFlight(ctx context.Context, hash string) ([]byte, error) {
	s.blobCacheMu.RLock()
	if cached, ok := s.blobCache[hash]; ok {
		s.blobCacheMu.RUnlock()
		return cached, nil
	}
	s.blobCacheMu.RUnlock()

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
		s.blobCacheMu.Lock()
		s.blobCache[hash] = fetched
		s.blobCacheMu.Unlock()
	}
	call.data = fetched
	call.err = err
	close(call.done)

	s.sfMu.Lock()
	delete(s.inFlight, hash)
	s.sfMu.Unlock()
	return fetched, err
}

func (s *ReadOnlyFuseServer) loadNodeData(ctx context.Context, n *fuseNode) ([]byte, error) {
	n.dataOnce.Do(func() {
		if n.size == 0 || n.blobHash == "" {
			n.data = nil
			return
		}
		fetched, err := s.fetchBlobSingleFlight(ctx, n.blobHash)
		if err != nil {
			n.dataErr = err
			return
		}
		n.data = fetched
	})
	return n.data, n.dataErr
}

func (s *ReadOnlyFuseServer) handleReaddir(unique uint64, nodeid uint64, body []byte, plus bool) []byte {
	if len(body) < 20 {
		return makeErrorReply(unique, -int32(syscall.EINVAL))
	}
	n := s.node(nodeid)
	if n == nil || !n.isDir() {
		return makeErrorReply(unique, -int32(syscall.ENOTDIR))
	}
	le := binary.LittleEndian
	offset := le.Uint64(body[8:16])
	maxSize := int(le.Uint32(body[16:20]))
	if maxSize <= 0 {
		return makeErrorReply(unique, 0)
	}

	parentNode := s.node(n.parent)
	if parentNode == nil {
		parentNode = n
	}
	total := 2 + len(n.children)
	outCap := fuseOutHeaderSize + minInt(maxSize, 64*1024)
	out := make([]byte, fuseOutHeaderSize, outCap)

	for idx := int(offset); idx < total; idx++ {
		var entryName string
		var target *fuseNode
		switch idx {
		case 0:
			entryName = "."
			target = n
		case 1:
			entryName = ".."
			target = parentNode
		default:
			target = n.children[idx-2]
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
	return finishReply(out, unique, 0)
}

func (s *ReadOnlyFuseServer) handleStatfs(unique uint64) []byte {
	out := make([]byte, fuseOutHeaderSize+fuseKstatfsSize)
	le := binary.LittleEndian
	b := out[fuseOutHeaderSize:]
	le.PutUint64(b[0:8], 1<<20)
	le.PutUint64(b[8:16], 1<<19)
	le.PutUint64(b[16:24], 1<<19)
	le.PutUint64(b[24:32], uint64(len(s.nodes)))
	le.PutUint64(b[32:40], 1<<20)
	le.PutUint32(b[40:44], 4096)
	le.PutUint32(b[44:48], 255)
	le.PutUint32(b[48:52], 4096)
	return finishReply(out, unique, 0)
}

func (s *ReadOnlyFuseServer) encodeEntryOut(dst []byte, n *fuseNode) {
	le := binary.LittleEndian
	le.PutUint64(dst[0:8], n.ino)
	le.PutUint64(dst[8:16], 1)
	le.PutUint64(dst[16:24], s.cfg.CacheTTLSeconds)
	le.PutUint64(dst[24:32], s.cfg.CacheTTLSeconds)
	encodeAttr(dst[40:40+fuseAttrSize], n)
}

func encodeAttr(dst []byte, n *fuseNode) {
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

var _ = unsafe.Sizeof(uint64(0))
