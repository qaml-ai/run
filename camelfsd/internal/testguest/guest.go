// Package testguest is a loop-mount test fixture, never used by the daemon.
package testguest

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
	"golang.org/x/sys/unix"
	"io/fs"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type Index struct {
	Tree  string          `json:"tree"`
	Files []objects.Entry `json:"files"`
}

func dial(path string, ready bool, deadline time.Time) (net.Conn, error) {
	for time.Now().Before(deadline) {
		c, e := net.DialTimeout("unix", path, time.Second)
		if e == nil {
			c.SetDeadline(deadline)
			if !ready {
				return c, nil
			}
			var r struct {
				Ready bool `json:"ready"`
			}
			if wire.JSON(c, &r) == nil && r.Ready {
				return c, nil
			}
			c.Close()
		}
		time.Sleep(50 * time.Millisecond)
	}
	return nil, fmt.Errorf("connect deadline")
}

// parent opens each component without following a symlink, rooted in an open mount fd.
func parent(root int, path string) (int, string, error) {
	if e := objects.Path(path); e != nil {
		return -1, "", e
	}
	parts := strings.Split(path, "/")
	fd, e := unix.Dup(root)
	if e != nil {
		return -1, "", e
	}
	for _, p := range parts[:len(parts)-1] {
		next, e := unix.Openat(fd, p, unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
		if e == unix.ENOENT {
			if e = unix.Mkdirat(fd, p, 0755); e == nil {
				next, e = unix.Openat(fd, p, unix.O_DIRECTORY|unix.O_NOFOLLOW|unix.O_CLOEXEC, 0)
			}
		}
		unix.Close(fd)
		if e != nil {
			return -1, "", e
		}
		fd = next
	}
	return fd, parts[len(parts)-1], nil
}
func Apply(vsock, job, mount, index string) (err error) {
	c, e := dial(vsock+"_5201", false, time.Now().Add(2*time.Minute))
	if e != nil {
		return e
	}
	defer c.Close()
	defer func() {
		if err != nil {
			wire.Send(c, map[string]any{"applied": false, "error": err.Error()})
		}
	}()
	start := time.Now()
	var h wire.Header
	if e = wire.JSON(c, &h); e != nil {
		return e
	}
	if h.Kind != "apply" || h.JobID != job {
		return fmt.Errorf("header mismatch")
	}
	idx := Index{Tree: h.ToTree}
	for {
		var f struct {
			Index    []objects.Entry `json:"index"`
			IndexEnd bool            `json:"indexEnd"`
			Count    int             `json:"count"`
		}
		if e = wire.JSON(c, &f); e != nil {
			return e
		}
		idx.Files = append(idx.Files, f.Index...)
		if f.IndexEnd {
			if f.Count != len(idx.Files) {
				return fmt.Errorf("index count")
			}
			break
		}
	}
	root, e := unix.Open(mount, unix.O_DIRECTORY|unix.O_NOFOLLOW, 0)
	if e != nil {
		return e
	}
	defer unix.Close(root)
	count := 0
	var received int64
	for {
		var o wire.Op
		if e = wire.JSON(c, &o); e != nil {
			return e
		}
		if o.End {
			if o.Files != count || o.Bytes != received {
				return fmt.Errorf("trailer mismatch")
			}
			break
		}
		count++
		fd, name, e := parent(root, o.Path)
		if e != nil {
			return e
		}
		e = func() error {
			defer unix.Close(fd)
			if o.Op == "del" {
				e := unix.Unlinkat(fd, name, 0)
				if e == unix.EISDIR {
					e = unix.Unlinkat(fd, name, unix.AT_REMOVEDIR)
				}
				return e
			}
			if o.Op == "mode" {
				f, e := unix.Openat(fd, name, unix.O_NOFOLLOW|unix.O_RDONLY, 0)
				if e != nil {
					return e
				}
				defer unix.Close(f)
				return unix.Fchmod(f, mode(o.Mode))
			}
			if o.Op != "put" {
				return fmt.Errorf("bad apply op")
			}
			if o.Size < 0 || o.Size > 8<<30 {
				return fmt.Errorf("bad size")
			}
			tmp := fmt.Sprintf(".camelfs-tmp-%d", count)
			defer unix.Unlinkat(fd, tmp, 0)
			if o.Mode == "120000" {
				var b bytes.Buffer
				for left := o.Size; left > 0; {
					p, e := wire.Read(c, wire.DataMax)
					if e != nil {
						return e
					}
					if int64(len(p)) > left || b.Len()+len(p) > 4096 {
						return fmt.Errorf("link size")
					}
					b.Write(p)
					left -= int64(len(p))
				}
				if e := unix.Symlinkat(b.String(), fd, tmp); e != nil {
					return e
				}
			} else {
				f, e := unix.Openat(fd, tmp, unix.O_WRONLY|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW, mode(o.Mode))
				if e != nil {
					return e
				}
				out := os.NewFile(uintptr(f), tmp)
				defer out.Close()
				for left := o.Size; left > 0; {
					b, e := wire.Read(c, wire.DataMax)
					if e != nil {
						return e
					}
					if int64(len(b)) > left {
						return fmt.Errorf("size mismatch")
					}
					if _, e = out.Write(b); e != nil {
						return e
					}
					left -= int64(len(b))
				}
				if e = out.Sync(); e != nil {
					return e
				}
			}
			received += o.Size
			return unix.Renameat(fd, tmp, fd, name)
		}()
		if e != nil {
			return e
		}
		if o.Op == "del" {
			prune(root, o.Path)
		}
	}
	if index != "" {
		b, _ := json.Marshal(idx)
		if e = os.WriteFile(index, b, 0600); e != nil {
			return e
		}
	}
	return wire.Send(c, map[string]any{"applied": true, "applyMs": float64(time.Since(start).Microseconds()) / 1000})
}
func mode(s string) uint32 {
	if s == "100755" {
		return 0755
	}
	return 0644
}
func mountpoint(p string) bool {
	b, e := os.ReadFile("/proc/self/mountinfo")
	if e != nil {
		return false
	}
	p, _ = filepath.Abs(p)
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) > 4 && f[4] == p {
			return true
		}
	}
	return false
}
func freeze(p string, on bool) error {
	flag := "-u"
	if on {
		flag = "-f"
	}
	b, e := exec.Command("fsfreeze", flag, p).CombinedOutput()
	if e != nil {
		return fmt.Errorf("fsfreeze: %w %s", e, b)
	}
	return nil
}
func pending(index string) string { return strings.TrimSuffix(index, ".json") + ".pending.json" }
func Checkpoint(vsock, job, mount, index string) (err error) {
	if !mountpoint(mount) {
		return fmt.Errorf("not a mountpoint")
	}
	b, e := os.ReadFile(index)
	if e != nil {
		return e
	}
	var old Index
	if e = json.Unmarshal(b, &old); e != nil {
		return e
	}
	deadline := time.Now().Add(2 * time.Minute)
	c, e := dial(vsock+"_5200", true, deadline)
	if e != nil {
		return e
	}
	defer c.Close()
	if e = freeze(mount, true); e != nil {
		return e
	}
	defer func() {
		e := freeze(mount, false)
		if err == nil {
			err = e
		}
	}()
	start := time.Now()
	prev := map[string]objects.Entry{}
	for _, f := range old.Files {
		prev[f.Path] = f
	}
	idx := Index{Tree: old.Tree}
	var ops []wire.Op
	data := map[string][]byte{}
	skipped := 0
	e = filepath.WalkDir(mount, func(p string, d fs.DirEntry, e error) error {
		if e != nil {
			return e
		}
		if p == mount {
			return nil
		}
		rel, e := filepath.Rel(mount, p)
		if e != nil {
			return e
		}
		if d.Name() == ".git" || strings.HasPrefix(d.Name(), ".camelfs-tmp-") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		st, e := d.Info()
		if e != nil {
			return e
		}
		var b []byte
		mode := "100644"
		if st.Mode()&os.ModeSymlink != 0 {
			target, e := os.Readlink(p)
			if e != nil {
				return e
			}
			b = []byte(target)
			mode = "120000"
		} else if st.Mode().IsRegular() {
			b, e = os.ReadFile(p)
			if e != nil {
				return e
			}
			if st.Mode()&0111 != 0 {
				mode = "100755"
			}
		} else {
			skipped++
			return nil
		}
		f := objects.Entry{Path: rel, Mode: mode, SHA1: store.GitHash("blob", b), Size: int64(len(b))}
		idx.Files = append(idx.Files, f)
		before, ok := prev[rel]
		if !ok || before.SHA1 != f.SHA1 || before.Mode != f.Mode {
			ops = append(ops, wire.Op{Path: rel, Op: "put", Mode: mode, Size: f.Size})
			data[rel] = b
		}
		delete(prev, rel)
		return nil
	})
	if e != nil {
		return e
	}
	walk := float64(time.Since(start).Microseconds()) / 1000
	for p := range prev {
		ops = append(ops, wire.Op{Path: p, Op: "del"})
	}
	if e = wire.Send(c, wire.Header{V: 1, Kind: "checkpoint", JobID: job, BaseTree: old.Tree, WalkMs: walk}); e != nil {
		return e
	}
	var total int64
	for _, o := range ops {
		if e = wire.Send(c, o); e != nil {
			return e
		}
		b := data[o.Path]
		total += int64(len(b))
		for len(b) > 0 {
			n := min(len(b), wire.DataMax)
			if e = wire.Write(c, b[:n]); e != nil {
				return e
			}
			b = b[n:]
		}
	}
	if e = wire.Send(c, wire.Op{End: true, Files: len(ops), Bytes: total, FreezeMs: float64(time.Since(start).Microseconds()) / 1000, Skipped: skipped}); e != nil {
		return e
	}
	var ack struct {
		Ack   bool   `json:"ack"`
		Error string `json:"error"`
	}
	if e = wire.JSON(c, &ack); e != nil {
		return e
	}
	if !ack.Ack {
		return fmt.Errorf("nack: %s", ack.Error)
	}
	b, e = json.Marshal(idx)
	if e != nil {
		return e
	}
	return os.WriteFile(pending(index), b, 0600)
}
func Run(args []string) error {
	if len(args) == 0 {
		return fmt.Errorf("testguest apply|checkpoint|checkpointed|evil")
	}
	evilCase := ""
	if args[0] == "evil" && len(args) > 1 {
		evilCase = args[1]
		args = append([]string{args[0]}, args[2:]...)
	}
	f := flag.NewFlagSet("testguest", flag.ContinueOnError)
	vsock := f.String("vsock-dir", "", "vsock path")
	job := f.String("job", "", "job")
	mount := f.String("mount", "", "loop mount")
	index := f.String("index", "idx.json", "index")
	tree := f.String("tree", "", "published tree")
	if e := f.Parse(args[1:]); e != nil {
		return e
	}
	switch args[0] {
	case "evil":
		c, e := dial(*vsock+"_5200", false, time.Now().Add(2*time.Minute))
		if e != nil {
			return e
		}
		defer c.Close()
		return Evil(c, evilCase, *job, *tree)
	case "apply":
		return Apply(*vsock, *job, *mount, *index)
	case "checkpoint":
		return Checkpoint(*vsock, *job, *mount, *index)
	case "checkpointed":
		b, e := os.ReadFile(pending(*index))
		if e != nil {
			return e
		}
		var idx Index
		if e = json.Unmarshal(b, &idx); e != nil {
			return e
		}
		idx.Tree = *tree
		b, _ = json.Marshal(idx)
		if e = os.WriteFile(pending(*index), b, 0600); e != nil {
			return e
		}
		return os.Rename(pending(*index), *index)
	default:
		return fmt.Errorf("unknown testguest action")
	}
}

// Remove only empty directories left by deletions, without following parents.
func prune(root int, path string) {
	for p := filepath.Dir(path); p != "."; p = filepath.Dir(p) {
		fd, name, e := parent(root, p)
		if e != nil {
			return
		}
		e = unix.Unlinkat(fd, name, unix.AT_REMOVEDIR)
		unix.Close(fd)
		if e != nil {
			return
		}
	}
}
