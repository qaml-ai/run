package main

// camelfs: the mount-don't-copy prototype in one binary.
//
//   camelfs serve   -dir D -addr A -latency 20ms         fake R2 + Volume DO
//   camelfs gen     -files N -bytes B -out DIR           a bench tree
//   camelfs import  -server U -name V DIR                hash + upload a tree as a manifest
//   camelfs fork    -server U -base V -name F            a fork: the manifest copied, nothing else
//   camelfs mount   -server U -name V -cache C -lower L [-upper U -work W -merged M] [-prefetch N] [-passthrough]
//   camelfs commit  -server U -base V -name N -upper U [-outputs a,b/]   the overlay's upper dir → a new manifest
//   camelfs copy    -server U -name V -dest D -parallel 6                 baseline: today's host-side pull
//   camelfs tarcopy -server U -name V -dest D                             baseline: today's camel-sync tar stream
//   camelfs read    -dir D -pct P -parallel N                             workload: read P% of files
//   camelfs lat     -dir D -n K                                           workload: single-file open+read latency

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"hash/fnv"
	"io"
	"io/fs"
	"log"
	"math/rand"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"
)

func main() {
	if len(os.Args) < 2 {
		log.Fatal("usage: camelfs serve|gen|import|fork|mount|commit|copy|tarcopy|read|lat ...")
	}
	cmd, args := os.Args[1], os.Args[2:]
	switch cmd {
	case "serve":
		serveMain(args)
	case "gen":
		genMain(args)
	case "import":
		importMain(args)
	case "fork":
		forkMain(args)
	case "mount":
		mountMain(args)
	case "commit":
		commitMain(args)
	case "copy":
		copyMain(args)
	case "tarcopy":
		tarcopyMain(args)
	case "read":
		readMain(args)
	case "lat":
		latMain(args)
	default:
		log.Fatalf("unknown command %s", cmd)
	}
}

func out(v any) { b, _ := json.Marshal(v); fmt.Println(string(b)) }

func getManifest(server, name string) (*Manifest, error) {
	resp, err := http.Get(server + "/manifest/" + name)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("manifest %s: %s", name, resp.Status)
	}
	return decodeManifest(resp.Body)
}

func putManifest(server, name string, m *Manifest) error {
	m.Name = name
	m.Sort()
	b, _ := json.Marshal(m)
	req, _ := http.NewRequest(http.MethodPut, server+"/manifest/"+name, bytes.NewReader(b))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return fmt.Errorf("put manifest: %s", resp.Status)
	}
	return nil
}

// parallel runs fn over 0..n-1 on `workers` goroutines; the first error wins.
func parallel(n, workers int, fn func(i int) error) error {
	var next atomic.Int64
	var first error
	var once sync.Once
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for {
				i := int(next.Add(1) - 1)
				if i >= n {
					return
				}
				if err := fn(i); err != nil {
					once.Do(func() { first = err })
					return
				}
			}
		}()
	}
	wg.Wait()
	return first
}

// ---- gen

func genMain(args []string) {
	fl := flag.NewFlagSet("gen", flag.ExitOnError)
	files := fl.Int("files", 200, "")
	total := fl.Int64("bytes", 1<<20, "")
	outDir := fl.String("out", "tree", "")
	seed := fl.Int64("seed", 1, "")
	fl.Parse(args)
	r := rand.New(rand.NewSource(*seed))
	mean := float64(*total) / float64(*files)
	buf := make([]byte, int(mean*64)+1)
	var written int64
	for i := 0; i < *files; i++ {
		d := i / 16
		p := filepath.Join(*outDir, fmt.Sprintf("pkg%03d/sub%02d/f%05d.txt", d/32, d%32, i))
		size := int(r.ExpFloat64() * mean)
		if size < 1 {
			size = 1
		}
		if size > len(buf) {
			size = len(buf)
		}
		r.Read(buf[:size])
		os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, buf[:size], 0o644); err != nil {
			log.Fatal(err)
		}
		written += int64(size)
	}
	out(map[string]any{"files": *files, "bytes": written})
}

// ---- import

func importMain(args []string) {
	fl := flag.NewFlagSet("import", flag.ExitOnError)
	server := fl.String("server", "http://127.0.0.1:9900", "")
	name := fl.String("name", "", "")
	fl.Parse(args)
	root := fl.Arg(0)
	began := time.Now()
	var m Manifest
	var paths []string
	filepath.WalkDir(root, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if p == root || d.IsDir() {
			return nil
		}
		if d.Type().IsRegular() || d.Type()&fs.ModeSymlink != 0 {
			paths = append(paths, p)
		}
		return nil
	})
	m.Files = make([]Entry, len(paths))
	var uploaded, uploadedBytes atomic.Int64
	err := parallel(len(paths), 32, func(i int) error {
		p := paths[i]
		rel, _ := filepath.Rel(root, p)
		st, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if st.Mode()&fs.ModeSymlink != 0 {
			t, _ := os.Readlink(p)
			m.Files[i] = Entry{Path: rel, Link: t, Mode: 0o777}
			return nil
		}
		h, n, err := hashFile(p)
		if err != nil {
			return err
		}
		mode := uint32(0o644)
		if st.Mode()&0o111 != 0 {
			mode = 0o755
		}
		m.Files[i] = Entry{Path: rel, Hash: h, Size: n, Mode: mode}
		did, err := upload(*server, h, p)
		if did {
			uploaded.Add(1)
			uploadedBytes.Add(n)
		}
		return err
	})
	if err != nil {
		log.Fatal(err)
	}
	if err := putManifest(*server, *name, &m); err != nil {
		log.Fatal(err)
	}
	out(map[string]any{"name": *name, "files": len(m.Files), "bytes": m.Bytes(), "uploaded": uploaded.Load(), "uploadedBytes": uploadedBytes.Load(), "ms": time.Since(began).Milliseconds()})
}

// upload PUTs blob h from file p unless the server already has it.
func upload(server, h, p string) (bool, error) {
	resp, err := http.Head(server + "/blob/" + h)
	if err != nil {
		return false, err
	}
	resp.Body.Close()
	if resp.StatusCode == 200 {
		return false, nil
	}
	f, err := os.Open(p)
	if err != nil {
		return false, err
	}
	defer f.Close()
	req, _ := http.NewRequest(http.MethodPut, server+"/blob/"+h, f)
	resp, err = http.DefaultClient.Do(req)
	if err != nil {
		return false, err
	}
	resp.Body.Close()
	if resp.StatusCode != 200 {
		return false, fmt.Errorf("upload %s: %s", p, resp.Status)
	}
	return true, nil
}

// ---- fork

func forkMain(args []string) {
	fl := flag.NewFlagSet("fork", flag.ExitOnError)
	server := fl.String("server", "http://127.0.0.1:9900", "")
	base := fl.String("base", "", "")
	name := fl.String("name", "", "")
	fl.Parse(args)
	began := time.Now()
	m, err := getManifest(*server, *base)
	if err != nil {
		log.Fatal(err)
	}
	m.Base, m.Version = *base, m.Version+1
	if err := putManifest(*server, *name, m); err != nil {
		log.Fatal(err)
	}
	out(map[string]any{"fork": *name, "files": len(m.Files), "ms": time.Since(began).Milliseconds()})
}

// ---- mount

func mountMain(args []string) {
	fl := flag.NewFlagSet("mount", flag.ExitOnError)
	server := fl.String("server", "http://127.0.0.1:9900", "")
	name := fl.String("name", "", "")
	cacheDir := fl.String("cache", "/var/cache/camelfs", "")
	lower := fl.String("lower", "", "FUSE mount point (read-only manifest view)")
	upper := fl.String("upper", "", "overlay upper dir (writes); empty = no overlay")
	work := fl.String("work", "", "overlay work dir")
	merged := fl.String("merged", "", "overlay mount point (what the job sees)")
	prefetch := fl.Int("prefetch", 0, "background fetchers walking the whole manifest (0 = lazy only)")
	passthrough := fl.Bool("passthrough", true, "FUSE passthrough for cached blobs")
	statsFile := fl.String("stats", "", "write cache stats here on exit")
	ready := fl.String("ready", "", "touch this file once mounted")
	uid := fl.Int("uid", 0, "owner the files appear to have (the job user)")
	gid := fl.Int("gid", 0, "")
	fl.Parse(args)

	began := time.Now()
	m, err := getManifest(*server, *name)
	if err != nil {
		log.Fatal(err)
	}
	manifestMs := time.Since(began).Milliseconds()
	cache := NewCache(*cacheDir, *server)
	os.MkdirAll(*lower, 0o755)
	srv, err := mountFS(*lower, m, cache, *passthrough, fuse.Owner{Uid: uint32(*uid), Gid: uint32(*gid)})
	if err != nil {
		log.Fatal(err)
	}
	if err := srv.WaitMount(); err != nil {
		log.Fatal(err)
	}
	if *merged != "" {
		for _, d := range []string{*upper, *work, *merged} {
			os.MkdirAll(d, 0o755)
		}
		os.Chown(*upper, *uid, *gid)
		opts := fmt.Sprintf("lowerdir=%s,upperdir=%s,workdir=%s", *lower, *upper, *work)
		if err := unix.Mount("overlay", *merged, "overlay", 0, opts); err != nil {
			srv.Unmount()
			log.Fatalf("overlay: %v", err)
		}
	}
	mountMs := time.Since(began).Milliseconds()
	pt := srv.KernelSettings().Flags64()&fuse.CAP_PASSTHROUGH != 0
	log.Printf("mounted %s: %d files, manifest %d ms, ready %d ms, kernel passthrough %v", *name, len(m.Files), manifestMs, mountMs, pt)
	if *ready != "" {
		os.WriteFile(*ready, []byte(fmt.Sprintf(`{"manifestMs":%d,"mountMs":%d,"files":%d,"passthroughCap":%v}`, manifestMs, mountMs, len(m.Files), pt)), 0o644)
	}
	var prefetchMs atomic.Int64
	if *prefetch > 0 {
		go func() {
			t := time.Now()
			hashes := make([]string, 0, len(m.Files))
			for _, e := range m.Files {
				if e.Hash != "" {
					hashes = append(hashes, e.Hash)
				}
			}
			parallel(len(hashes), *prefetch, func(i int) error { cache.Ensure(hashes[i], false); return nil })
			prefetchMs.Store(time.Since(t).Milliseconds())
			log.Printf("prefetch done in %d ms", prefetchMs.Load())
		}()
	}
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM, syscall.SIGUSR1)
	for s := range sig {
		st := map[string]any{"cache": cache.Stats(), "prefetchMs": prefetchMs.Load(), "mountMs": mountMs}
		if *statsFile != "" {
			b, _ := json.Marshal(st)
			os.WriteFile(*statsFile, b, 0o644)
		}
		if s == syscall.SIGUSR1 {
			continue
		}
		if *merged != "" {
			unix.Unmount(*merged, unix.MNT_DETACH)
		}
		srv.Unmount()
		return
	}
}

// ---- commit

func commitMain(args []string) {
	fl := flag.NewFlagSet("commit", flag.ExitOnError)
	server := fl.String("server", "http://127.0.0.1:9900", "")
	base := fl.String("base", "", "")
	name := fl.String("name", "", "")
	upper := fl.String("upper", "", "")
	outputs := fl.String("outputs", "", "comma-separated paths or dir/ prefixes to keep (empty = everything)")
	cacheDir := fl.String("cache", "", "host cache to write committed blobs into (so a fork of this commit starts warm)")
	fl.Parse(args)
	began := time.Now()
	m, err := getManifest(*server, *base)
	if err != nil {
		log.Fatal(err)
	}
	var keep []string
	if *outputs != "" {
		keep = strings.Split(*outputs, ",")
	}
	wanted := func(p string) bool {
		if keep == nil {
			return true
		}
		for _, k := range keep {
			if p == k || (strings.HasSuffix(k, "/") && strings.HasPrefix(p, k)) {
				return true
			}
		}
		return false
	}
	files := map[string]Entry{}
	for _, e := range m.Files {
		files[e.Path] = e
	}
	removeUnder := func(dir string) {
		for p := range files {
			if strings.HasPrefix(p, dir+"/") && wanted(p) {
				delete(files, p)
			}
		}
	}
	type change struct{ rel, abs string }
	var adds []change
	var deleted int
	filepath.WalkDir(*upper, func(p string, d fs.DirEntry, err error) error {
		if err != nil || p == *upper {
			return err
		}
		rel, _ := filepath.Rel(*upper, p)
		info, _ := d.Info()
		switch {
		case info.Mode()&fs.ModeCharDevice != 0: // overlay whiteout: the path (and anything under it) is gone
			if st, ok := info.Sys().(*syscall.Stat_t); ok && st.Rdev == 0 {
				if wanted(rel) {
					delete(files, rel)
					deleted++
				}
				removeUnder(rel)
			}
		case d.IsDir():
			if v := make([]byte, 1); true {
				if n, _ := unix.Lgetxattr(p, "trusted.overlay.opaque", v); n == 1 && v[0] == 'y' {
					removeUnder(rel) // a directory removed and made again: nothing below it survives from the base
				}
			}
			// A file replaced by a directory: the file is gone.
			if _, ok := files[rel]; ok && wanted(rel) {
				delete(files, rel)
			}
		default:
			if wanted(rel) {
				adds = append(adds, change{rel, p})
			}
		}
		return nil
	})
	var uploaded, uploadedBytes, changedBytes atomic.Int64
	results := make([]Entry, len(adds))
	err = parallel(len(adds), 16, func(i int) error {
		c := adds[i]
		st, err := os.Lstat(c.abs)
		if err != nil {
			return err
		}
		if st.Mode()&fs.ModeSymlink != 0 {
			t, _ := os.Readlink(c.abs)
			results[i] = Entry{Path: c.rel, Link: t, Mode: 0o777}
			return nil
		}
		h, n, err := hashFile(c.abs)
		if err != nil {
			return err
		}
		changedBytes.Add(n)
		mode := uint32(0o644)
		if st.Mode()&0o111 != 0 {
			mode = 0o755
		}
		results[i] = Entry{Path: c.rel, Hash: h, Size: n, Mode: mode}
		did, err := upload(*server, h, c.abs)
		if did {
			uploaded.Add(1)
			uploadedBytes.Add(n)
		}
		if err == nil && *cacheDir != "" {
			err = cacheInsert(*cacheDir, h, c.abs)
		}
		return err
	})
	if err != nil {
		log.Fatal(err)
	}
	for _, e := range results {
		// A path that was a directory in the base and is a file now drops what was under it.
		removeUnder(e.Path)
		files[e.Path] = e
	}
	next := &Manifest{Base: *base, Version: m.Version + 1}
	for _, e := range files {
		next.Files = append(next.Files, e)
	}
	if err := putManifest(*server, *name, next); err != nil {
		log.Fatal(err)
	}
	out(map[string]any{"name": *name, "changed": len(adds), "deleted": deleted, "changedBytes": changedBytes.Load(), "uploaded": uploaded.Load(), "uploadedBytes": uploadedBytes.Load(), "files": len(next.Files), "ms": time.Since(began).Milliseconds()})
}

// ---- baselines

func copyMain(args []string) {
	fl := flag.NewFlagSet("copy", flag.ExitOnError)
	server := fl.String("server", "http://127.0.0.1:9900", "")
	name := fl.String("name", "", "")
	dest := fl.String("dest", "", "")
	workers := fl.Int("parallel", 6, "files fetched at once (jobhost SYNC_PARALLEL is 6)")
	fl.Parse(args)
	began := time.Now()
	m, err := getManifest(*server, *name)
	if err != nil {
		log.Fatal(err)
	}
	cache := NewCache(filepath.Join(os.TempDir(), "unused"), *server)
	err = parallel(len(m.Files), *workers, func(i int) error {
		e := m.Files[i]
		p := filepath.Join(*dest, e.Path)
		os.MkdirAll(filepath.Dir(p), 0o755)
		if e.Link != "" {
			return os.Symlink(e.Link, p)
		}
		resp, err := cache.client.Get(*server + "/blob/" + e.Hash)
		if err != nil {
			return err
		}
		defer resp.Body.Close()
		f, err := os.OpenFile(p, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fs.FileMode(e.Mode))
		if err != nil {
			return err
		}
		_, err = io.Copy(f, resp.Body)
		f.Close()
		return err
	})
	if err != nil {
		log.Fatal(err)
	}
	out(map[string]any{"files": len(m.Files), "bytes": m.Bytes(), "ms": time.Since(began).Milliseconds()})
}

func tarcopyMain(args []string) {
	fl := flag.NewFlagSet("tarcopy", flag.ExitOnError)
	server := fl.String("server", "http://127.0.0.1:9900", "")
	name := fl.String("name", "", "")
	dest := fl.String("dest", "", "")
	fl.Parse(args)
	began := time.Now()
	os.MkdirAll(*dest, 0o755)
	resp, err := http.Get(*server + "/tar/" + *name)
	if err != nil {
		log.Fatal(err)
	}
	defer resp.Body.Close()
	cmd := exec.Command("tar", "-x", "-f", "-", "-C", *dest, "--no-same-owner")
	cmd.Stdin, cmd.Stderr = resp.Body, os.Stderr
	if err := cmd.Run(); err != nil {
		log.Fatal(err)
	}
	out(map[string]any{"ms": time.Since(began).Milliseconds()})
}

// ---- workloads

func listFiles(dir string) []string {
	var files []string
	filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			files = append(files, p)
		}
		return nil
	})
	sort.Strings(files)
	return files
}

func pick(files []string, pct int) []string {
	var out []string
	for _, f := range files {
		h := fnv.New32a()
		h.Write([]byte(path.Base(f)))
		if int(h.Sum32()%100) < pct {
			out = append(out, f)
		}
	}
	return out
}

func readMain(args []string) {
	fl := flag.NewFlagSet("read", flag.ExitOnError)
	dir := fl.String("dir", "", "")
	pct := fl.Int("pct", 100, "")
	workers := fl.Int("parallel", 8, "")
	fl.Parse(args)
	began := time.Now()
	all := listFiles(*dir)
	listMs := time.Since(began).Milliseconds()
	chosen := pick(all, *pct)
	var n atomic.Int64
	buf := sync.Pool{New: func() any { return make([]byte, 1<<20) }}
	err := parallel(len(chosen), *workers, func(i int) error {
		f, err := os.Open(chosen[i])
		if err != nil {
			return err
		}
		defer f.Close()
		b := buf.Get().([]byte)
		defer buf.Put(b)
		c, err := io.CopyBuffer(io.Discard, f, b)
		n.Add(c)
		return err
	})
	if err != nil {
		log.Fatal(err)
	}
	out(map[string]any{"listed": len(all), "listMs": listMs, "read": len(chosen), "bytes": n.Load(), "ms": time.Since(began).Milliseconds()})
}

func latMain(args []string) {
	fl := flag.NewFlagSet("lat", flag.ExitOnError)
	dir := fl.String("dir", "", "")
	n := fl.Int("n", 50, "")
	fl.Parse(args)
	all := pick(listFiles(*dir), 100)
	r := rand.New(rand.NewSource(7))
	var lats []float64
	for i := 0; i < *n && len(all) > 0; i++ {
		p := all[r.Intn(len(all))]
		t := time.Now()
		b, err := os.ReadFile(p)
		if err != nil {
			log.Fatal(err)
		}
		_ = b
		lats = append(lats, float64(time.Since(t).Microseconds())/1000)
	}
	sort.Float64s(lats)
	q := func(f float64) float64 { return lats[int(f*float64(len(lats)-1))] }
	out(map[string]any{"n": len(lats), "p50ms": q(0.5), "p90ms": q(0.9), "maxMs": lats[len(lats)-1]})
}

// cacheInsert copies a committed file into the host cache under its hash (write-through), unless it is there already.
func cacheInsert(dir, h, src string) error {
	p := filepath.Join(dir, h[:2], h)
	if _, err := os.Stat(p); err == nil {
		return nil
	}
	os.MkdirAll(filepath.Dir(p), 0o755)
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	tmp, err := os.CreateTemp(filepath.Dir(p), ".c-*")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, in); err != nil {
		tmp.Close()
		return err
	}
	tmp.Close()
	os.Chmod(tmp.Name(), 0o444)
	return os.Rename(tmp.Name(), p)
}
