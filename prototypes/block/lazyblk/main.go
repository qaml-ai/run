// lazyblk: the runnable slice of prototypes/block/DESIGN.md.
//
//	lazyblk store   --dir D --listen :9000 --latency 15ms      a stand-in for S3: content-addressed chunks + roots
//	lazyblk import  --from IMG --store URL                     chunk a disk image, upload, print the root hash
//	lazyblk serve   --root H --store URL --cache DIR --listen :10809 [--overlay F]
//	                                                           a lazy NBD block device for one version (read-only, or
//	                                                           with a local copy-on-write overlay when --overlay is set)
//	lazyblk checkpoint --dev /dev/mapper/X --base H --mapped BLOCKS --store URL
//	                                                           hash the mapped (written) chunks of a thin device, upload
//	                                                           the new ones, publish a new root
//	lazyblk index   --mount DIR --out F [--prev F]             file index with extents (the Workers view)
//	lazyblk read    --index F --store URL PATH                 read one file from chunks alone (no mount, no host)
//	lazyblk diff    A B                                        changed chunks between two roots / files between indexes
//	lazyblk fsbench DIR N                                      per-op latency: stat/open/read/write of small files
package main

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/aws-sdk-go-v2/service/s3/types"
)

const chunkSize = 256 << 10 // 256 KiB: the S3 object, the cache unit, and the dm-thin block (512 sectors)

var zeroHash [32]byte

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: lazyblk <store|import|serve|checkpoint|index|read|diff|fsbench> ...")
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "store":
		err = cmdStore(os.Args[2:])
	case "import":
		err = cmdImport(os.Args[2:])
	case "serve":
		err = cmdServe(os.Args[2:])
	case "checkpoint":
		err = cmdCheckpoint(os.Args[2:])
	case "index":
		err = cmdIndex(os.Args[2:])
	case "read":
		err = cmdRead(os.Args[2:])
	case "diff":
		err = cmdDiff(os.Args[2:])
	case "fetch":
		err = cmdFetch(os.Args[2:])
	case "fsbench":
		err = cmdFsbench(os.Args[2:])
	default:
		err = fmt.Errorf("unknown command %q", os.Args[1])
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "lazyblk:", err)
		os.Exit(1)
	}
}

// ---------------------------------------------------------------- block maps

// A block map is one version: a chunk hash per chunkSize of the device, the zero hash meaning a hole.
type blockMap struct {
	chunks [][32]byte
}

func (m *blockMap) size() int64 { return int64(len(m.chunks)) * chunkSize }

func (m *blockMap) encode() []byte {
	b := make([]byte, 0, 16+len(m.chunks)*32)
	b = append(b, "LBM1"...)
	b = binary.LittleEndian.AppendUint32(b, chunkSize)
	b = binary.LittleEndian.AppendUint64(b, uint64(len(m.chunks)))
	for _, c := range m.chunks {
		b = append(b, c[:]...)
	}
	return b
}

func decodeMap(b []byte) (*blockMap, error) {
	if len(b) < 16 || string(b[:4]) != "LBM1" || binary.LittleEndian.Uint32(b[4:8]) != chunkSize {
		return nil, errors.New("bad block map header")
	}
	n := binary.LittleEndian.Uint64(b[8:16])
	if uint64(len(b)-16) != n*32 {
		return nil, errors.New("bad block map length")
	}
	m := &blockMap{chunks: make([][32]byte, n)}
	for i := range m.chunks {
		copy(m.chunks[i][:], b[16+i*32:])
	}
	return m, nil
}

func hashOf(b []byte) [32]byte { return sha256.Sum256(b) }
func hx(h [32]byte) string      { return hex.EncodeToString(h[:]) }

// ---------------------------------------------------------------- the store (client)

type store struct {
	url    string
	client *http.Client
	// real S3 when url is s3://bucket/prefix: the instance role's credentials via the SDK's default chain
	s3     *s3.Client
	bucket string
	prefix string
}

func newStore(url string) *store {
	if strings.HasPrefix(url, "s3://") {
		rest := strings.TrimPrefix(url, "s3://")
		bucket, prefix, _ := strings.Cut(rest, "/")
		cfg, err := config.LoadDefaultConfig(context.Background())
		if err != nil {
			fmt.Fprintln(os.Stderr, "aws config:", err)
			os.Exit(1)
		}
		return &store{url: url, s3: s3.NewFromConfig(cfg), bucket: bucket, prefix: strings.Trim(prefix, "/")}
	}
	tr := &http.Transport{MaxIdleConnsPerHost: 64, MaxConnsPerHost: 64}
	return &store{url: strings.TrimRight(url, "/"), client: &http.Client{Transport: tr}}
}

func (s *store) key(kind, h string) string {
	if s.prefix == "" {
		return kind + "/" + h
	}
	return s.prefix + "/" + kind + "/" + h
}

func (s *store) get(kind, h string) ([]byte, error) {
	if s.s3 != nil {
		out, err := s.s3.GetObject(context.Background(), &s3.GetObjectInput{Bucket: &s.bucket, Key: aws.String(s.key(kind, h))})
		if err != nil {
			return nil, fmt.Errorf("%s %s: %w", kind, h, err)
		}
		defer out.Body.Close()
		return io.ReadAll(out.Body)
	}
	r, err := s.client.Get(s.url + "/" + kind + "/" + h)
	if err != nil {
		return nil, err
	}
	defer r.Body.Close()
	if r.StatusCode != 200 {
		return nil, fmt.Errorf("%s %s: %s", kind, h, r.Status)
	}
	return io.ReadAll(r.Body)
}

func (s *store) has(kind, h string) (bool, error) {
	if s.s3 != nil {
		_, err := s.s3.HeadObject(context.Background(), &s3.HeadObjectInput{Bucket: &s.bucket, Key: aws.String(s.key(kind, h))})
		if err != nil {
			var nf *types.NotFound
			if errors.As(err, &nf) || strings.Contains(err.Error(), "NotFound") || strings.Contains(err.Error(), "404") {
				return false, nil
			}
			return false, err
		}
		return true, nil
	}
	r, err := s.client.Head(s.url + "/" + kind + "/" + h)
	if err != nil {
		return false, err
	}
	r.Body.Close()
	return r.StatusCode == 200, nil
}

func (s *store) put(kind, h string, b []byte) error {
	if s.s3 != nil {
		_, err := s.s3.PutObject(context.Background(), &s3.PutObjectInput{Bucket: &s.bucket, Key: aws.String(s.key(kind, h)), Body: bytes.NewReader(b), ContentLength: aws.Int64(int64(len(b)))})
		return err
	}
	req, _ := http.NewRequest("PUT", s.url+"/"+kind+"/"+h, bytes.NewReader(b))
	r, err := s.client.Do(req)
	if err != nil {
		return err
	}
	r.Body.Close()
	if r.StatusCode/100 != 2 {
		return fmt.Errorf("put %s %s: %s", kind, h, r.Status)
	}
	return nil
}

// putChunks uploads the chunks not yet in the store, 16 at a time; returns how many were new.
func (s *store) putChunks(chunks map[[32]byte][]byte) (int, error) {
	type job struct {
		h [32]byte
		b []byte
	}
	jobs := make(chan job)
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error
	uploaded := 0
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := range jobs {
				ok, err := s.has("chunk", hx(j.h))
				if err == nil && !ok {
					err = s.put("chunk", hx(j.h), j.b)
					if err == nil {
						mu.Lock()
						uploaded++
						mu.Unlock()
					}
				}
				if err != nil {
					mu.Lock()
					if firstErr == nil {
						firstErr = err
					}
					mu.Unlock()
				}
			}
		}()
	}
	for h, b := range chunks {
		jobs <- job{h, b}
	}
	close(jobs)
	wg.Wait()
	return uploaded, firstErr
}

func (s *store) putRoot(m *blockMap) (string, error) {
	b := m.encode()
	h := hx(hashOf(b))
	return h, s.put("root", h, b)
}

func (s *store) getRoot(h string) (*blockMap, error) {
	b, err := s.get("root", h)
	if err != nil {
		return nil, err
	}
	return decodeMap(b)
}

// ---------------------------------------------------------------- store server (stands in for S3)

func cmdStore(args []string) error {
	fl := flag.NewFlagSet("store", flag.ExitOnError)
	dir := fl.String("dir", "", "directory")
	listen := fl.String("listen", ":9000", "address")
	latency := fl.Duration("latency", 15*time.Millisecond, "added first-byte latency per chunk GET (S3-like)")
	fl.Parse(args)
	for _, k := range []string{"chunk", "root"} {
		if err := os.MkdirAll(filepath.Join(*dir, k), 0o755); err != nil {
			return err
		}
	}
	var gets, puts, bytesOut int64
	var mu sync.Mutex
	mux := http.NewServeMux()
	mux.HandleFunc("/stats", func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		fmt.Fprintf(w, "{\"gets\":%d,\"puts\":%d,\"bytes_out\":%d}\n", gets, puts, bytesOut)
	})
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
		if len(parts) != 2 || (parts[0] != "chunk" && parts[0] != "root") || !isHex(parts[1]) {
			http.Error(w, "not found", 404)
			return
		}
		p := filepath.Join(*dir, parts[0], parts[1])
		switch r.Method {
		case "HEAD":
			if _, err := os.Stat(p); err != nil {
				w.WriteHeader(404)
				return
			}
			w.WriteHeader(200)
		case "GET":
			if parts[0] == "chunk" {
				time.Sleep(*latency)
			}
			b, err := os.ReadFile(p)
			if err != nil {
				http.Error(w, "not found", 404)
				return
			}
			mu.Lock()
			gets++
			bytesOut += int64(len(b))
			mu.Unlock()
			w.Header().Set("Content-Length", strconv.Itoa(len(b)))
			w.Write(b)
		case "PUT":
			b, err := io.ReadAll(r.Body)
			if err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			if parts[0] == "chunk" && hx(hashOf(b)) != parts[1] {
				http.Error(w, "hash mismatch", 400)
				return
			}
			tmp := p + ".tmp" + strconv.Itoa(os.Getpid())
			if err := os.WriteFile(tmp, b, 0o644); err != nil {
				http.Error(w, err.Error(), 500)
				return
			}
			os.Rename(tmp, p)
			mu.Lock()
			puts++
			mu.Unlock()
			w.WriteHeader(201)
		default:
			http.Error(w, "method", 405)
		}
	})
	fmt.Fprintf(os.Stderr, "store: %s on %s, +%v per chunk GET\n", *dir, *listen, *latency)
	return http.ListenAndServe(*listen, mux)
}

func isHex(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

// ---------------------------------------------------------------- import

func cmdImport(args []string) error {
	fl := flag.NewFlagSet("import", flag.ExitOnError)
	from := fl.String("from", "", "disk image or block device")
	storeURL := fl.String("store", "http://127.0.0.1:9000", "store")
	fl.Parse(args)
	f, err := os.Open(*from)
	if err != nil {
		return err
	}
	defer f.Close()
	size, err := f.Seek(0, io.SeekEnd)
	if err != nil {
		return err
	}
	if size%chunkSize != 0 {
		return fmt.Errorf("size %d is not a multiple of %d", size, chunkSize)
	}
	st := newStore(*storeURL)
	t0 := time.Now()
	m := &blockMap{chunks: make([][32]byte, size/chunkSize)}
	pending := map[[32]byte][]byte{}
	uploaded, uniq := 0, 0
	buf := make([]byte, chunkSize)
	flush := func() error {
		n, err := st.putChunks(pending)
		uploaded += n
		pending = map[[32]byte][]byte{}
		return err
	}
	for i := range m.chunks {
		if _, err := f.ReadAt(buf, int64(i)*chunkSize); err != nil {
			return err
		}
		if isZero(buf) {
			continue
		}
		h := hashOf(buf)
		m.chunks[i] = h
		if _, seen := pending[h]; !seen {
			pending[h] = append([]byte(nil), buf...)
			uniq++
		}
		if len(pending) >= 256 {
			if err := flush(); err != nil {
				return err
			}
		}
	}
	if err := flush(); err != nil {
		return err
	}
	root, err := st.putRoot(m)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "import: %d chunks, %d non-zero, %d uploaded (new), %v\n", len(m.chunks), uniq, uploaded, time.Since(t0).Round(time.Millisecond))
	fmt.Println(root)
	return nil
}

func isZero(b []byte) bool {
	for _, c := range b {
		if c != 0 {
			return false
		}
	}
	return true
}

// ---------------------------------------------------------------- lazy device

// lazyDevice serves one version's blocks: cache hit from the host-wide chunk cache, else a fetch from the store
// (with a short sequential prefetch), and an optional local copy-on-write overlay for writes.
type lazyDevice struct {
	m        *blockMap
	st       *store
	cacheDir string
	fetching sync.Map // chunk hash -> *sync.WaitGroup (single-flight)
	stats    struct {
		reads, writes, cacheHits, fetches, fetchBytes, prefetches int64
		fetchNanos                                                 int64
		mu                                                        sync.Mutex
	}
	overlay   *os.File
	dirty     []bool // per chunk, overlay mode
	overlayMu sync.Mutex
}

func (d *lazyDevice) chunkPath(h [32]byte) string {
	s := hx(h)
	return filepath.Join(d.cacheDir, s[:2], s)
}

// ensure makes the chunk present in the cache and returns its path.
func (d *lazyDevice) ensure(h [32]byte, prefetch bool) (string, error) {
	p := d.chunkPath(h)
	if _, err := os.Stat(p); err == nil {
		d.stats.mu.Lock()
		d.stats.cacheHits++
		d.stats.mu.Unlock()
		return p, nil
	}
	wg := &sync.WaitGroup{}
	wg.Add(1)
	if actual, loaded := d.fetching.LoadOrStore(h, wg); loaded {
		actual.(*sync.WaitGroup).Wait()
		if _, err := os.Stat(p); err == nil {
			return p, nil
		}
		return "", errors.New("concurrent fetch failed")
	}
	defer d.fetching.Delete(h)
	defer wg.Done()
	t0 := time.Now()
	b, err := d.st.get("chunk", hx(h))
	if err != nil {
		return "", err
	}
	if hashOf(b) != h {
		return "", errors.New("chunk hash mismatch from store")
	}
	os.MkdirAll(filepath.Dir(p), 0o755)
	tmp := p + ".tmp" + strconv.Itoa(os.Getpid()) + strconv.FormatInt(time.Now().UnixNano(), 36)
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return "", err
	}
	if err := os.Rename(tmp, p); err != nil {
		return "", err
	}
	d.stats.mu.Lock()
	d.stats.fetches++
	d.stats.fetchBytes += int64(len(b))
	d.stats.fetchNanos += int64(time.Since(t0))
	if prefetch {
		d.stats.prefetches++
	}
	d.stats.mu.Unlock()
	return p, nil
}

func (d *lazyDevice) readChunkInto(i int, buf []byte, off int64) error {
	h := d.m.chunks[i]
	if h == zeroHash {
		for j := range buf {
			buf[j] = 0
		}
		return nil
	}
	p, err := d.ensure(h, false)
	if err != nil {
		return err
	}
	f, err := os.Open(p)
	if err != nil {
		return err
	}
	defer f.Close()
	_, err = f.ReadAt(buf, off)
	return err
}

func (d *lazyDevice) readAt(buf []byte, offset int64) error {
	d.stats.mu.Lock()
	d.stats.reads++
	d.stats.mu.Unlock()
	for len(buf) > 0 {
		i := int(offset / chunkSize)
		in := offset % chunkSize
		n := int(chunkSize - in)
		if n > len(buf) {
			n = len(buf)
		}
		if d.overlay != nil && d.dirty[i] {
			if _, err := d.overlay.ReadAt(buf[:n], offset); err != nil {
				return err
			}
		} else if err := d.readChunkInto(i, buf[:n], in); err != nil {
			return err
		}
		// sequential prefetch: the next 4 chunks, in the background (what Lambda's block loader does, crudely)
		for k := 1; k <= 4 && i+k < len(d.m.chunks); k++ {
			if h := d.m.chunks[i+k]; h != zeroHash {
				if _, err := os.Stat(d.chunkPath(h)); err != nil {
					go d.ensure(h, true)
				}
			}
		}
		buf = buf[n:]
		offset += int64(n)
	}
	return nil
}

// writeAt: overlay mode only (copy-on-write at chunk granularity into a local sparse file).
func (d *lazyDevice) writeAt(buf []byte, offset int64) error {
	if d.overlay == nil {
		return syscall.EROFS
	}
	d.stats.mu.Lock()
	d.stats.writes++
	d.stats.mu.Unlock()
	for len(buf) > 0 {
		i := int(offset / chunkSize)
		in := offset % chunkSize
		n := int(chunkSize - in)
		if n > len(buf) {
			n = len(buf)
		}
		d.overlayMu.Lock()
		if !d.dirty[i] {
			whole := make([]byte, chunkSize)
			if err := d.readChunkInto(i, whole, 0); err != nil {
				d.overlayMu.Unlock()
				return err
			}
			if _, err := d.overlay.WriteAt(whole, int64(i)*chunkSize); err != nil {
				d.overlayMu.Unlock()
				return err
			}
			d.dirty[i] = true
		}
		d.overlayMu.Unlock()
		if _, err := d.overlay.WriteAt(buf[:n], offset); err != nil {
			return err
		}
		buf = buf[n:]
		offset += int64(n)
	}
	return nil
}

func cmdServe(args []string) error {
	fl := flag.NewFlagSet("serve", flag.ExitOnError)
	root := fl.String("root", "", "root hash")
	storeURL := fl.String("store", "http://127.0.0.1:9000", "store")
	cacheDir := fl.String("cache", "", "host-wide chunk cache")
	listen := fl.String("listen", "127.0.0.1:10809", "NBD listen address")
	overlay := fl.String("overlay", "", "local copy-on-write overlay file (writable device)")
	statsAddr := fl.String("stats", "", "serve /stats here")
	fl.Parse(args)
	st := newStore(*storeURL)
	m, err := st.getRoot(*root)
	if err != nil {
		return err
	}
	d := &lazyDevice{m: m, st: st, cacheDir: *cacheDir}
	if *overlay != "" {
		f, err := os.OpenFile(*overlay, os.O_RDWR|os.O_CREATE, 0o644)
		if err != nil {
			return err
		}
		if err := f.Truncate(m.size()); err != nil {
			return err
		}
		d.overlay = f
		d.dirty = make([]bool, len(m.chunks))
	}
	if *statsAddr != "" {
		go http.ListenAndServe(*statsAddr, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			d.stats.mu.Lock()
			defer d.stats.mu.Unlock()
			fmt.Fprintf(w, "{\"reads\":%d,\"writes\":%d,\"cache_hits\":%d,\"fetches\":%d,\"fetch_bytes\":%d,\"prefetches\":%d,\"fetch_ms_avg\":%.2f}\n",
				d.stats.reads, d.stats.writes, d.stats.cacheHits, d.stats.fetches, d.stats.fetchBytes, d.stats.prefetches,
				float64(d.stats.fetchNanos)/1e6/float64(max(1, d.stats.fetches)))
		}))
	}
	ln, err := net.Listen("tcp", *listen)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "serve: root %s, %d chunks (%d MiB), writable=%v, on %s\n", (*root)[:12], len(m.chunks), m.size()>>20, d.overlay != nil, *listen)
	for {
		c, err := ln.Accept()
		if err != nil {
			return err
		}
		go func() {
			if err := d.serveNBD(c); err != nil && !errors.Is(err, io.EOF) {
				fmt.Fprintln(os.Stderr, "nbd:", err)
			}
		}()
	}
}

// NBD, newstyle fixed handshake, simple replies. Enough for the Linux client and nbd-client.
const (
	nbdMagic       = 0x4e42444d41474943
	nbdOptMagic    = 0x49484156454F5054
	nbdRepMagic    = 0x3e889045565a9
	nbdReqMagic    = 0x25609513
	nbdReplyMagic  = 0x67446698
	optExportName  = 1
	optAbort       = 2
	optGo          = 7
	optInfo        = 6
	repAck         = 1
	repInfo        = 3
	repErrUnsup    = 1<<31 | 1
	flagFixedNew   = 1
	flagNoZeroes   = 2
	txHasFlags     = 1
	txReadOnly     = 2
	txSendFlush    = 4
	txSendTrim     = 32
	txCanMultiConn = 256
	nbdRead        = 0
	nbdWrite       = 1
	nbdDisc        = 2
	nbdFlush       = 3
	nbdTrim        = 4
	nbdWriteZeroes = 6
)

func (d *lazyDevice) serveNBD(c net.Conn) error {
	defer c.Close()
	if tc, ok := c.(*net.TCPConn); ok {
		tc.SetNoDelay(true)
	}
	w := bufio.NewWriterSize(c, 1<<20)
	r := bufio.NewReaderSize(c, 1<<20)
	be := binary.BigEndian
	hdr := make([]byte, 18)
	be.PutUint64(hdr, nbdMagic)
	be.PutUint64(hdr[8:], nbdOptMagic)
	be.PutUint16(hdr[16:], flagFixedNew|flagNoZeroes)
	w.Write(hdr)
	w.Flush()
	var clientFlags uint32
	if err := binary.Read(r, be, &clientFlags); err != nil {
		return err
	}
	noZeroes := clientFlags&flagNoZeroes != 0
	txFlags := uint16(txHasFlags | txSendFlush | txSendTrim | txCanMultiConn)
	if d.overlay == nil {
		txFlags |= txReadOnly
	}
	reply := func(opt, typ uint32, data []byte) {
		b := make([]byte, 20)
		be.PutUint64(b, nbdRepMagic)
		be.PutUint32(b[8:], opt)
		be.PutUint32(b[12:], typ)
		be.PutUint32(b[16:], uint32(len(data)))
		w.Write(b)
		w.Write(data)
		w.Flush()
	}
	for {
		var magic uint64
		var opt, n uint32
		if err := binary.Read(r, be, &magic); err != nil {
			return err
		}
		if magic != nbdOptMagic {
			return errors.New("bad option magic")
		}
		binary.Read(r, be, &opt)
		binary.Read(r, be, &n)
		data := make([]byte, n)
		if _, err := io.ReadFull(r, data); err != nil {
			return err
		}
		switch opt {
		case optExportName:
			b := make([]byte, 10)
			be.PutUint64(b, uint64(d.m.size()))
			be.PutUint16(b[8:], txFlags)
			w.Write(b)
			if !noZeroes {
				w.Write(make([]byte, 124))
			}
			w.Flush()
			return d.transmission(c, r, w)
		case optGo, optInfo:
			info := make([]byte, 12)
			be.PutUint16(info, 0) // NBD_INFO_EXPORT
			be.PutUint64(info[2:], uint64(d.m.size()))
			be.PutUint16(info[10:], txFlags)
			reply(opt, repInfo, info)
			reply(opt, repAck, nil)
			if opt == optGo {
				return d.transmission(c, r, w)
			}
		case optAbort:
			reply(opt, repAck, nil)
			return nil
		default:
			reply(opt, repErrUnsup, nil)
		}
	}
}

func (d *lazyDevice) transmission(c net.Conn, r *bufio.Reader, w *bufio.Writer) error {
	be := binary.BigEndian
	var wmu sync.Mutex
	send := func(cookie uint64, errno uint32, data []byte) {
		wmu.Lock()
		defer wmu.Unlock()
		b := make([]byte, 16)
		be.PutUint32(b, nbdReplyMagic)
		be.PutUint32(b[4:], errno)
		be.PutUint64(b[8:], cookie)
		w.Write(b)
		w.Write(data)
		w.Flush()
	}
	req := make([]byte, 28)
	for {
		if _, err := io.ReadFull(r, req); err != nil {
			return err
		}
		if be.Uint32(req) != nbdReqMagic {
			return errors.New("bad request magic")
		}
		typ := be.Uint16(req[6:])
		cookie := be.Uint64(req[8:])
		offset := int64(be.Uint64(req[16:]))
		length := int(be.Uint32(req[24:]))
		switch typ {
		case nbdRead:
			go func() {
				buf := make([]byte, length)
				if err := d.readAt(buf, offset); err != nil {
					fmt.Fprintln(os.Stderr, "read:", err)
					send(cookie, uint32(syscall.EIO), nil)
					return
				}
				send(cookie, 0, buf)
			}()
		case nbdWrite:
			buf := make([]byte, length)
			if _, err := io.ReadFull(r, buf); err != nil {
				return err
			}
			go func() {
				if err := d.writeAt(buf, offset); err != nil {
					send(cookie, uint32(syscall.EIO), nil)
					return
				}
				send(cookie, 0, nil)
			}()
		case nbdFlush:
			if d.overlay != nil {
				d.overlay.Sync()
			}
			send(cookie, 0, nil)
		case nbdTrim, nbdWriteZeroes:
			if d.overlay == nil {
				send(cookie, uint32(syscall.EROFS), nil)
			} else {
				go func() {
					if err := d.writeAt(make([]byte, length), offset); err != nil {
						send(cookie, uint32(syscall.EIO), nil)
						return
					}
					send(cookie, 0, nil)
				}()
			}
		case nbdDisc:
			return nil
		default:
			send(cookie, uint32(syscall.EINVAL), nil)
		}
	}
}

// ---------------------------------------------------------------- checkpoint

// cmdCheckpoint hashes the thin device's mapped chunks (from `thin_dump` XML, or a plain list of block numbers) and
// publishes a new root: base map + the changed chunks. Only chunks whose hash differs from the base are uploaded.
func cmdCheckpoint(args []string) error {
	fl := flag.NewFlagSet("checkpoint", flag.ExitOnError)
	dev := fl.String("dev", "", "thin device (a snapshot of the volume)")
	base := fl.String("base", "", "base root hash")
	mapped := fl.String("mapped", "", "thin_dump XML (or 'all' to scan the whole device)")
	storeURL := fl.String("store", "http://127.0.0.1:9000", "store")
	fl.Parse(args)
	st := newStore(*storeURL)
	m, err := st.getRoot(*base)
	if err != nil {
		return err
	}
	t0 := time.Now()
	var blocks []int
	if *mapped == "all" {
		for i := range m.chunks {
			blocks = append(blocks, i)
		}
	} else {
		xml, err := os.ReadFile(*mapped)
		if err != nil {
			return err
		}
		blocks = parseThinDump(xml)
	}
	f, err := os.Open(*dev)
	if err != nil {
		return err
	}
	defer f.Close()
	next := &blockMap{chunks: append([][32]byte(nil), m.chunks...)}
	changed, uploaded := 0, 0
	pending := map[[32]byte][]byte{}
	buf := make([]byte, chunkSize)
	for _, i := range blocks {
		if i >= len(next.chunks) {
			continue
		}
		if _, err := f.ReadAt(buf, int64(i)*chunkSize); err != nil {
			return err
		}
		var h [32]byte
		if !isZero(buf) {
			h = hashOf(buf)
		}
		if h == next.chunks[i] {
			continue
		}
		changed++
		next.chunks[i] = h
		if h != zeroHash {
			if _, seen := pending[h]; !seen {
				pending[h] = append([]byte(nil), buf...)
			}
		}
		if len(pending) >= 256 {
			n, err := st.putChunks(pending)
			if err != nil {
				return err
			}
			uploaded += n
			pending = map[[32]byte][]byte{}
		}
	}
	n, err := st.putChunks(pending)
	if err != nil {
		return err
	}
	uploaded += n
	tHash := time.Since(t0)
	root, err := st.putRoot(next)
	if err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "checkpoint: %d mapped chunks scanned, %d changed, %d uploaded (%d MiB), %v\n", len(blocks), changed, uploaded, uploaded*chunkSize>>20, tHash.Round(time.Millisecond))
	fmt.Println(root)
	return nil
}

var reSingle = regexp.MustCompile(`<single_mapping origin_block="(\d+)"`)
var reRange = regexp.MustCompile(`<range_mapping origin_begin="(\d+)" data_begin="\d+" length="(\d+)"`)

func parseThinDump(xml []byte) []int {
	var out []int
	for _, m := range reSingle.FindAllSubmatch(xml, -1) {
		n, _ := strconv.Atoi(string(m[1]))
		out = append(out, n)
	}
	for _, m := range reRange.FindAllSubmatch(xml, -1) {
		b, _ := strconv.Atoi(string(m[1]))
		l, _ := strconv.Atoi(string(m[2]))
		for i := 0; i < l; i++ {
			out = append(out, b+i)
		}
	}
	sort.Ints(out)
	return out
}

// ---------------------------------------------------------------- file index (the Workers view)

type extent struct {
	Logical  int64 `json:"l"`
	Physical int64 `json:"p"` // byte offset in the device = chunk index * chunkSize + offset
	Length   int64 `json:"n"`
}

type indexEntry struct {
	Path    string   `json:"path"`
	Mode    uint32   `json:"mode"`
	Size    int64    `json:"size"`
	Hash    string   `json:"hash"`
	Ino     uint64   `json:"ino"`
	MtimeNs int64    `json:"mtime"`
	CtimeNs int64    `json:"ctime"`
	Extents []extent `json:"ext,omitempty"`
}

type fileIndex struct {
	Root    string       `json:"root"` // block-map root this index describes (when known)
	Tree    string       `json:"tree"` // hash over (path, mode, hash)
	Entries []indexEntry `json:"entries"`
}

func cmdIndex(args []string) error {
	fl := flag.NewFlagSet("index", flag.ExitOnError)
	mount := fl.String("mount", "", "mounted volume")
	out := fl.String("out", "", "index file")
	prev := fl.String("prev", "", "previous index: unchanged stats reuse the hash")
	root := fl.String("root", "", "block-map root to record")
	fl.Parse(args)
	old := map[string]indexEntry{}
	if *prev != "" {
		b, err := os.ReadFile(*prev)
		if err != nil {
			return err
		}
		var pi fileIndex
		if err := json.Unmarshal(b, &pi); err != nil {
			return err
		}
		for _, e := range pi.Entries {
			old[e.Path] = e
		}
	}
	t0 := time.Now()
	var entries []indexEntry
	rehashed := 0
	var mu sync.Mutex
	var wg sync.WaitGroup
	work := make(chan indexEntry, 1024)
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for e := range work {
				full := filepath.Join(*mount, e.Path)
				h, ext, err := hashAndExtents(full)
				if err != nil {
					fmt.Fprintln(os.Stderr, "index:", e.Path, err)
					continue
				}
				e.Hash, e.Extents = h, ext
				mu.Lock()
				entries = append(entries, e)
				rehashed++
				mu.Unlock()
			}
		}()
	}
	err := filepath.WalkDir(*mount, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			if d.Name() == "lost+found" && p != *mount {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		stt := info.Sys().(*syscall.Stat_t)
		rel, _ := filepath.Rel(*mount, p)
		e := indexEntry{Path: rel, Mode: uint32(info.Mode().Perm()), Size: info.Size(), Ino: stt.Ino, MtimeNs: stt.Mtim.Nano(), CtimeNs: stt.Ctim.Nano()}
		if o, ok := old[rel]; ok && o.Size == e.Size && o.Ino == e.Ino && o.MtimeNs == e.MtimeNs && o.CtimeNs == e.CtimeNs {
			e.Hash, e.Extents = o.Hash, o.Extents
			mu.Lock()
			entries = append(entries, e)
			mu.Unlock()
			return nil
		}
		work <- e
		return nil
	})
	close(work)
	wg.Wait()
	if err != nil {
		return err
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Path < entries[j].Path })
	th := sha256.New()
	for _, e := range entries {
		fmt.Fprintf(th, "%s\x00%o\x00%s\n", e.Path, e.Mode, e.Hash)
	}
	idx := fileIndex{Root: *root, Tree: hex.EncodeToString(th.Sum(nil)), Entries: entries}
	b, _ := json.Marshal(idx)
	if err := os.WriteFile(*out, b, 0o644); err != nil {
		return err
	}
	fmt.Fprintf(os.Stderr, "index: %d files, %d rehashed, tree %s, %v\n", len(entries), rehashed, idx.Tree[:12], time.Since(t0).Round(time.Millisecond))
	return nil
}

// hashAndExtents hashes one file and asks ext4 where its bytes live on the device (FS_IOC_FIEMAP).
func hashAndExtents(p string) (string, []extent, error) {
	f, err := os.Open(p)
	if err != nil {
		return "", nil, err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", nil, err
	}
	ext, err := fiemap(f)
	return hex.EncodeToString(h.Sum(nil)), ext, err
}

type fiemapExtent struct {
	Logical, Physical, Length uint64
	Reserved64                [2]uint64
	Flags                     uint32
	Reserved                  [3]uint32
}

func fiemap(f *os.File) ([]extent, error) {
	const fsIocFiemap = 0xC020660B
	const maxExt = 64
	var buf struct {
		Start, Length           uint64
		Flags, MappedExtents    uint32
		ExtentCount, Reserved   uint32
		Extents                 [maxExt]fiemapExtent
	}
	buf.Length = ^uint64(0)
	buf.ExtentCount = maxExt
	buf.Flags = 1 // FIEMAP_FLAG_SYNC
	if _, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), fsIocFiemap, uintptr(unsafe.Pointer(&buf))); e != 0 {
		return nil, e
	}
	var out []extent
	for i := 0; i < int(buf.MappedExtents); i++ {
		x := buf.Extents[i]
		out = append(out, extent{int64(x.Logical), int64(x.Physical), int64(x.Length)})
	}
	return out, nil
}

// cmdRead is the Workers path: index + chunk store, no mount, no host. It reads the chunks covering the file's
// extents and checks the hash.
func cmdRead(args []string) error {
	fl := flag.NewFlagSet("read", flag.ExitOnError)
	index := fl.String("index", "", "index file")
	storeURL := fl.String("store", "http://127.0.0.1:9000", "store")
	fl.Parse(args)
	b, err := os.ReadFile(*index)
	if err != nil {
		return err
	}
	var idx fileIndex
	if err := json.Unmarshal(b, &idx); err != nil {
		return err
	}
	st := newStore(*storeURL)
	m, err := st.getRoot(idx.Root)
	if err != nil {
		return err
	}
	byPath := map[string]indexEntry{}
	for _, e := range idx.Entries {
		byPath[e.Path] = e
	}
	for _, p := range fl.Args() {
		e, ok := byPath[p]
		if !ok {
			return fmt.Errorf("%s: not in index", p)
		}
		t0 := time.Now()
		out := make([]byte, e.Size)
		chunkCache := map[int][]byte{}
		fetches := 0
		for _, x := range e.Extents {
			for off := int64(0); off < x.Length; {
				dev := x.Physical + off
				ci := int(dev / chunkSize)
				in := dev % chunkSize
				n := chunkSize - in
				if n > x.Length-off {
					n = x.Length - off
				}
				c, ok := chunkCache[ci]
				if !ok {
					c, err = st.get("chunk", hx(m.chunks[ci]))
					if err != nil {
						return err
					}
					chunkCache[ci] = c
					fetches++
				}
				lo := x.Logical + off
				if lo < e.Size {
					copy(out[lo:], c[in:in+n])
				}
				off += n
			}
		}
		got := hex.EncodeToString(func() []byte { s := sha256.Sum256(out); return s[:] }())
		fmt.Fprintf(os.Stderr, "read %s: %d bytes, %d chunk fetches, hash %s, %v\n", p, len(out), fetches, map[bool]string{true: "ok", false: "MISMATCH"}[got == e.Hash], time.Since(t0).Round(time.Microsecond))
	}
	return nil
}

// ---------------------------------------------------------------- fetch

// cmdFetch writes one store object (root or chunk) to stdout.
func cmdFetch(args []string) error {
	fl := flag.NewFlagSet("fetch", flag.ExitOnError)
	storeURL := fl.String("store", "http://127.0.0.1:9000", "store")
	fl.Parse(args)
	if fl.NArg() != 2 {
		return errors.New("fetch --store S <root|chunk> <hash>")
	}
	b, err := newStore(*storeURL).get(fl.Arg(0), fl.Arg(1))
	if err != nil {
		return err
	}
	_, err = os.Stdout.Write(b)
	return err
}

// ---------------------------------------------------------------- diff

func cmdDiff(args []string) error {
	if len(args) != 2 {
		return errors.New("diff A B (two block-map files or two index files)")
	}
	a, err := os.ReadFile(args[0])
	if err != nil {
		return err
	}
	b, err := os.ReadFile(args[1])
	if err != nil {
		return err
	}
	t0 := time.Now()
	if bytes.HasPrefix(a, []byte("LBM1")) {
		ma, err := decodeMap(a)
		if err != nil {
			return err
		}
		mb, err := decodeMap(b)
		if err != nil {
			return err
		}
		n := 0
		for i := range mb.chunks {
			if i >= len(ma.chunks) || ma.chunks[i] != mb.chunks[i] {
				n++
			}
		}
		fmt.Printf("block diff: %d of %d chunks differ (%v)\n", n, len(mb.chunks), time.Since(t0).Round(time.Microsecond))
		return nil
	}
	var ia, ib fileIndex
	json.Unmarshal(a, &ia)
	json.Unmarshal(b, &ib)
	ha := map[string]string{}
	for _, e := range ia.Entries {
		ha[e.Path] = e.Hash
	}
	added, modified, deleted := 0, 0, 0
	seen := map[string]bool{}
	for _, e := range ib.Entries {
		seen[e.Path] = true
		if h, ok := ha[e.Path]; !ok {
			added++
		} else if h != e.Hash {
			modified++
		}
	}
	for p := range ha {
		if !seen[p] {
			deleted++
		}
	}
	fmt.Printf("file diff: +%d ~%d -%d of %d (%v)\n", added, modified, deleted, len(ib.Entries), time.Since(t0).Round(time.Microsecond))
	return nil
}

// ---------------------------------------------------------------- fsbench

// fsbench: N small files in DIR; median and p99 of stat, open+read (4 KiB), create+write+close (4 KiB), unlink.
func cmdFsbench(args []string) error {
	if len(args) != 2 {
		return errors.New("fsbench DIR N")
	}
	dir := args[0]
	n, _ := strconv.Atoi(args[1])
	os.MkdirAll(dir, 0o755)
	payload := bytes.Repeat([]byte("x"), 4096)
	paths := make([]string, n)
	for i := range paths {
		paths[i] = filepath.Join(dir, fmt.Sprintf("b%d/f%d", i/100, i))
		os.MkdirAll(filepath.Dir(paths[i]), 0o755)
	}
	measure := func(name string, fn func(i int) error) {
		ds := make([]time.Duration, n)
		for i := 0; i < n; i++ {
			t := time.Now()
			if err := fn(i); err != nil {
				fmt.Fprintln(os.Stderr, name, err)
			}
			ds[i] = time.Since(t)
		}
		sort.Slice(ds, func(a, b int) bool { return ds[a] < ds[b] })
		var sum time.Duration
		for _, d := range ds {
			sum += d
		}
		fmt.Printf("%-14s median %7.1f us  p99 %8.1f us  mean %7.1f us\n", name, us(ds[n/2]), us(ds[n*99/100]), us(sum/time.Duration(n)))
	}
	measure("create+write", func(i int) error { return os.WriteFile(paths[i], payload, 0o644) })
	syncDir(dir)
	dropCaches()
	measure("stat(cold)", func(i int) error { _, err := os.Stat(paths[i]); return err })
	measure("stat(warm)", func(i int) error { _, err := os.Stat(paths[i]); return err })
	dropCaches()
	buf := make([]byte, 8192)
	measure("open+read(cold)", func(i int) error {
		f, err := os.Open(paths[i])
		if err != nil {
			return err
		}
		_, err = f.Read(buf)
		f.Close()
		return err
	})
	measure("open+read(warm)", func(i int) error {
		f, err := os.Open(paths[i])
		if err != nil {
			return err
		}
		_, err = f.Read(buf)
		f.Close()
		return err
	})
	measure("overwrite", func(i int) error { return os.WriteFile(paths[i], payload, 0o644) })
	measure("unlink", func(i int) error { return os.Remove(paths[i]) })
	return nil
}

func us(d time.Duration) float64 { return float64(d.Nanoseconds()) / 1e3 }

func syncDir(dir string) { syscall.Sync() }

func dropCaches() {
	syscall.Sync()
	if err := os.WriteFile("/proc/sys/vm/drop_caches", []byte("3"), 0); err != nil {
		fmt.Fprintln(os.Stderr, "drop_caches:", err, "(run as root for cold numbers)")
	}
}
