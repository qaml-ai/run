// fuse-loop: a FUSE loopback mount (go-fuse) as the FUSE baseline, with and without kernel passthrough (Linux 6.9+).
//   fuse-loop -passthrough=true|false ORIGIN MOUNTPOINT
package main

import (
	"context"
	"flag"
	"log"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
)

var passthrough = flag.Bool("passthrough", true, "let the kernel read/write the backing file directly (FUSE passthrough)")

// noPassthroughFile hides the backing fd, so every read and write goes through the daemon.
type noPassthroughFile struct{ *fs.LoopbackFile }

func (noPassthroughFile) PassthroughFd() (int, bool) { return 0, false }

type node struct{ fs.LoopbackNode }

func (n *node) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	fh, fl, errno := n.LoopbackNode.Open(ctx, flags)
	if errno == 0 && !*passthrough {
		if lf, ok := fh.(*fs.LoopbackFile); ok {
			fh = noPassthroughFile{lf}
		}
	}
	return fh, fl, errno
}

func (n *node) Create(ctx context.Context, name string, flags uint32, mode uint32, out *fuse.EntryOut) (*fs.Inode, fs.FileHandle, uint32, syscall.Errno) {
	ino, fh, fl, errno := n.LoopbackNode.Create(ctx, name, flags, mode, out)
	if errno == 0 && !*passthrough {
		if lf, ok := fh.(*fs.LoopbackFile); ok {
			fh = noPassthroughFile{lf}
		}
	}
	return ino, fh, fl, errno
}

func main() {
	flag.Parse()
	if flag.NArg() != 2 {
		log.Fatal("fuse-loop [-passthrough=bool] ORIGIN MOUNTPOINT")
	}
	var st syscall.Stat_t
	if err := syscall.Stat(flag.Arg(0), &st); err != nil {
		log.Fatal(err)
	}
	// As fs.NewLoopbackRoot does, but every node (the root included) is our type, so Open/Create wrap the handle;
	// RootNode must be the root we mount, since paths are computed relative to it.
	rd := &fs.LoopbackRoot{Path: flag.Arg(0), Dev: uint64(st.Dev)}
	rd.NewNode = func(rootData *fs.LoopbackRoot, parent *fs.Inode, name string, st *syscall.Stat_t) fs.InodeEmbedder {
		return &node{fs.LoopbackNode{RootData: rootData}}
	}
	rootNode := &node{fs.LoopbackNode{RootData: rd}}
	rd.RootNode = rootNode
	sec := time.Second
	server, err := fs.Mount(flag.Arg(1), rootNode, &fs.Options{
		AttrTimeout:  &sec,
		EntryTimeout: &sec,
		MountOptions: fuse.MountOptions{Name: "fuse-loop", FsName: flag.Arg(0), AllowOther: false, MaxWrite: 1 << 20, DirectMount: true},
	})
	if err != nil {
		log.Fatal(err)
	}
	log.Printf("mounted %s on %s passthrough=%v", flag.Arg(0), flag.Arg(1), *passthrough)
	server.Wait()
}
