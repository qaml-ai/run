package main

// camelfs: a read-only FUSE view of one manifest. The tree (names, sizes, modes, links) is built in memory from the
// manifest at mount, so listing and stat never touch the network; a file's bytes are fetched into the host cache on
// first open and then served from the cached blob (with FUSE passthrough, by the kernel itself). Writes are not this
// filesystem's job: the job sees it through an overlay (kernel overlayfs, upper dir on local disk), and a commit is the
// overlay's upper dir turned into a new manifest.

import (
	"context"
	"log"
	"strings"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

type camelFS struct {
	cache       *Cache
	passthrough bool
	mtime       uint64
	owner       fuse.Owner
}

type dirNode struct{ fs.Inode }

var mountTime = uint64(time.Now().Unix())
var dirOwner fuse.Owner

func (d *dirNode) Getattr(ctx context.Context, fh fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = syscall.S_IFDIR | 0o755
	out.Nlink = 2
	out.Owner = dirOwner
	out.Mtime, out.Ctime, out.Atime = mountTime, mountTime, mountTime
	out.SetTimeout(time.Hour)
	return 0
}

type fileNode struct {
	fs.Inode
	fsys *camelFS
	e    Entry
}

var _ = (fs.NodeGetattrer)((*fileNode)(nil))
var _ = (fs.NodeOpener)((*fileNode)(nil))

func (f *fileNode) Getattr(ctx context.Context, fh fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	out.Mode = syscall.S_IFREG | f.e.Mode
	out.Size = uint64(f.e.Size)
	out.Blocks = (out.Size + 511) / 512
	out.Mtime, out.Ctime, out.Atime = f.fsys.mtime, f.fsys.mtime, f.fsys.mtime
	out.Nlink = 1
	out.Owner = f.fsys.owner
	out.SetTimeout(time.Hour)
	return 0
}

// noPassthrough hides LoopbackFile's backing fd, so reads go through this daemon (the comparison case).
type noPassthrough struct{ *fs.LoopbackFile }

func (f *fileNode) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if flags&(syscall.O_WRONLY|syscall.O_RDWR|syscall.O_TRUNC|syscall.O_APPEND) != 0 {
		return nil, 0, syscall.EROFS
	}
	p, err := f.fsys.cache.Ensure(f.e.Hash, true)
	if err != nil {
		log.Printf("open %s: %v", f.e.Path, err)
		return nil, 0, syscall.EIO
	}
	fd, err := syscall.Open(p, syscall.O_RDONLY, 0)
	if err != nil {
		return nil, 0, fs.ToErrno(err)
	}
	lf := fs.NewLoopbackFile(fd).(*fs.LoopbackFile)
	if f.fsys.passthrough {
		return lf, fuse.FOPEN_KEEP_CACHE, 0
	}
	return noPassthrough{lf}, fuse.FOPEN_KEEP_CACHE, 0
}

type rootNode struct {
	dirNode
	fsys *camelFS
	m    *Manifest
}

func (r *rootNode) OnAdd(ctx context.Context) {
	dirs := map[string]*fs.Inode{"": &r.Inode}
	var dir func(p string) *fs.Inode
	dir = func(p string) *fs.Inode {
		if n, ok := dirs[p]; ok {
			return n
		}
		parent, name := "", p
		if i := strings.LastIndexByte(p, '/'); i >= 0 {
			parent, name = p[:i], p[i+1:]
		}
		pn := dir(parent)
		n := pn.NewPersistentInode(ctx, &dirNode{}, fs.StableAttr{Mode: syscall.S_IFDIR})
		pn.AddChild(name, n, false)
		dirs[p] = n
		return n
	}
	for _, e := range r.m.Files {
		parent, name := "", e.Path
		if i := strings.LastIndexByte(e.Path, '/'); i >= 0 {
			parent, name = e.Path[:i], e.Path[i+1:]
		}
		pn := dir(parent)
		var child *fs.Inode
		if e.Link != "" {
			child = pn.NewPersistentInode(ctx, &fs.MemSymlink{Data: []byte(e.Link)}, fs.StableAttr{Mode: syscall.S_IFLNK})
		} else {
			child = pn.NewPersistentInode(ctx, &fileNode{fsys: r.fsys, e: e}, fs.StableAttr{Mode: syscall.S_IFREG})
		}
		pn.AddChild(name, child, false)
	}
}

func mountFS(mnt string, m *Manifest, cache *Cache, passthrough bool, owner fuse.Owner) (*fuse.Server, error) {
	dirOwner = owner
	hour := time.Hour
	root := &rootNode{fsys: &camelFS{cache: cache, passthrough: passthrough, mtime: uint64(time.Now().Unix()), owner: owner}, m: m}
	return fs.Mount(mnt, root, &fs.Options{
		AttrTimeout: &hour, EntryTimeout: &hour, NegativeTimeout: &hour,
		MountOptions: fuse.MountOptions{AllowOther: true, FsName: "camelfs", Name: "camelfs", MaxReadAhead: 1 << 20, DirectMount: true},
	})
}
