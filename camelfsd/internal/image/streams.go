package image

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"sync"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
)

var ErrBadStream = errors.New("bad-stream")
var ErrStreamTimeout = errors.New("stream-timeout")

type applyTrees struct {
	FromTree, ToTree string
	Files            int
	Bytes            int64
}
type arm struct {
	ctx  context.Context
	conn chan net.Conn
}
type streams struct {
	mu         sync.Mutex
	listeners  []net.Listener
	paths      []string
	conns      map[net.Conn]bool
	armed      *arm
	execInputs map[string]io.Reader
	used       bool
	closed     bool
}

func (s *streams) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for _, l := range s.listeners {
		l.Close()
	}
	for _, path := range s.paths {
		_ = os.Remove(path)
	}
	for c := range s.conns {
		c.Close()
	}
}

// acceptCheckpoint shares the checkpoint listener with the baseline handshake.
func (s *streams) acceptCheckpoint(ctx context.Context, armed chan<- struct{}) (net.Conn, func(), error) {
	a := &arm{ctx: ctx, conn: make(chan net.Conn)}
	s.mu.Lock()
	s.armed = a
	s.mu.Unlock()
	if armed != nil {
		close(armed)
	}
	defer func() {
		s.mu.Lock()
		if s.armed == a {
			s.armed = nil
		}
		s.mu.Unlock()
	}()
	select {
	case c := <-a.conn:
		return c, func() {
			c.Close()
			s.mu.Lock()
			delete(s.conns, c)
			s.mu.Unlock()
		}, nil
	case <-ctx.Done():
		return nil, nil, ErrStreamTimeout
	}
}

func (m *Manager) entries(ctx context.Context, lineage, t string) ([]objects.Entry, error) {
	if t == "" {
		return []objects.Entry{}, nil
	}
	return m.objects(lineage).Entries(ctx, t)
}

// v0-limitation: L53
func (m *Manager) listenStreams(ctx context.Context, v *Mount, vsock, from string, workspaceBytes int64, apply bool, uid int) error {
	var old, next []objects.Entry
	if apply && m.PackedApply != nil {
		if err := m.validatePackedApply(ctx, v); err != nil {
			return err
		}
	}
	if apply && m.PackedApply == nil {
		var e error
		if from != v.Tree {
			old, e = m.entries(ctx, v.Lineage, from)
			if e != nil {
				return e
			}
		}
		next, e = m.entries(ctx, v.Lineage, v.Tree)
		if e != nil {
			return e
		}
	}
	prev := map[string]objects.Entry{}
	for _, f := range old {
		prev[f.Path] = f
	}
	var ops []wire.Op
	if from != v.Tree {
		for _, f := range next {
			p, ok := prev[f.Path]
			if !ok || p.SHA1 != f.SHA1 || p.Mode != f.Mode {
				if f.Size > workspaceBytes || f.Mode == "120000" && f.Size > 4096 {
					return fmt.Errorf("apply blob exceeds workspace or symlink size")
				}
				ops = append(ops, wire.Op{Path: f.Path, Op: "put", Mode: f.Mode, Size: f.Size})
			}
			delete(prev, f.Path)
		}
	}
	for p := range prev {
		ops = append(ops, wire.Op{Path: p, Op: "del"})
	}
	sort.Slice(ops, func(i, j int) bool {
		if (ops[i].Op == "del") != (ops[j].Op == "del") {
			return ops[i].Op == "del"
		}
		return ops[i].Path < ops[j].Path
	})
	a := applyTrees{FromTree: from, ToTree: v.Tree, Files: len(ops)}
	for _, op := range ops {
		a.Bytes += op.Size
	}
	if apply && m.PackedApply != nil {
		a.Files, a.Bytes = m.PackedApply.Files, m.PackedApply.Bytes
	}
	if apply {
		v.needsBaseline = a.Files > 0
	}
	s := &streams{conns: map[net.Conn]bool{}}
	v.streams = s
	execPort := strconv.Itoa(hostwire.ExecInputPort)
	ports := []string{"5200"}
	if apply {
		ports = append(ports, "5201")
	}
	ports = append(ports, execPort)
	for _, port := range ports {
		path := vsock + "_" + port
		dir, e := os.Open(filepath.Dir(path))
		if e != nil {
			s.close()
			return e
		}
		bind := fmt.Sprintf("/proc/self/fd/%d/%s", dir.Fd(), filepath.Base(path))
		if e = os.Remove(path); e != nil && !os.IsNotExist(e) {
			dir.Close()
			s.close()
			return e
		}
		l, e := net.ListenUnix("unix", &net.UnixAddr{Name: bind, Net: "unix"})
		dir.Close()
		if e != nil {
			s.close()
			return e
		}
		l.SetUnlinkOnClose(false)
		s.paths = append(s.paths, path)
		e = os.Chown(path, uid, uid)
		if e == nil {
			e = os.Chmod(path, 0600)
		}
		if e != nil {
			s.close()
			l.Close()
			return e
		}
		s.listeners = append(s.listeners, l)
		go func(port string, l net.Listener) {
			for {
				c, e := l.Accept()
				if e != nil {
					return
				}
				s.mu.Lock()
				if s.closed {
					s.mu.Unlock()
					c.Close()
					return
				}
				if port == "5200" {
					armed := s.armed
					if armed == nil || armed.ctx.Err() != nil {
						s.mu.Unlock()
						c.Close()
						continue
					}
					s.armed = nil
					s.conns[c] = true
					s.mu.Unlock()
					select {
					case armed.conn <- c:
					case <-armed.ctx.Done():
						c.Close()
						s.mu.Lock()
						delete(s.conns, c)
						s.mu.Unlock()
					}
					continue
				}
				if port == execPort {
					s.conns[c] = true
					s.mu.Unlock()
					go s.sendExecInput(c, m.StreamIdle, m.ApplyMax)
					continue
				}
				if s.used {
					s.mu.Unlock()
					c.Close()
					continue
				}
				s.used = true
				s.conns[c] = true
				s.mu.Unlock()
				go func() {
					raw := c
					defer raw.Close()
					defer func() { s.mu.Lock(); delete(s.conns, raw); s.mu.Unlock() }()
					c = &wire.DeadlineConn{Conn: c, Idle: m.StreamIdle, Overall: time.Now().Add(m.ApplyMax)}
					if e := m.sendApply(c, v.Lineage, v.JobID, a, next, ops); e != nil {
						c.(*wire.DeadlineConn).Final()
						if ne, ok := e.(net.Error); ok && ne.Timeout() {
							e = ErrStreamTimeout
						}
						wire.Send(raw, wire.Op{End: true, Error: e.Error()})
						return
					}

					var reply struct {
						Applied bool `json:"applied"`
					}
					if e := wire.JSON(c, &reply); e != nil {
						raw.SetWriteDeadline(time.Now().Add(time.Second))
						code := ErrBadStream.Error()
						var ne net.Error
						if errors.As(e, &ne) && ne.Timeout() {
							code = ErrStreamTimeout.Error()
						}
						wire.Send(raw, wire.Op{End: true, Error: code})
					}
				}()
			}
		}(port, l)
	}
	return nil
}
func (m *Manager) sendApply(c net.Conn, lineage, job string, a applyTrees, entries []objects.Entry, ops []wire.Op) error {
	ctx, cancel := context.WithTimeout(context.Background(), m.ApplyMax)
	defer cancel()
	if e := wire.Send(c, wire.Header{V: 1, Kind: "apply", JobID: job, FromTree: a.FromTree, ToTree: a.ToTree}); e != nil {
		return e
	}
	if m.PackedApply != nil {
		return m.replayPackedApply(ctx, c, lineage, a.ToTree)
	}
	return m.sendApplyBody(ctx, c, lineage, job, a, entries, ops)
}

func (m *Manager) sendApplyBody(ctx context.Context, c io.Writer, lineage, job string, a applyTrees, entries []objects.Entry, ops []wire.Op) error {
	if e := sendIndex(c, entries); e != nil {
		return e
	}
	if e := wire.Send(c, map[string]any{"indexEnd": true, "count": len(entries)}); e != nil {
		return e
	}
	byPath := map[string]objects.Entry{}
	for _, f := range entries {
		byPath[f.Path] = f
	}

	var reads applyReads
	if err := sendApplyOps(ctx, c, store.ForLineage(m.Store, lineage), byPath, ops, m.Data, applyInflightBytes, &reads); err != nil {
		return err
	}
	if reads.loose+reads.packs+reads.ranges > 0 {
		slog.Info("compute_apply_reads", "vm", job, "locatorMs", reads.lookup.Milliseconds(), "looseReads", reads.loose,
			"packGets", reads.packs, "rangeGets", reads.ranges, "bundleBytes", reads.bytes)
	}
	return wire.Send(c, wire.Op{End: true, Files: a.Files, Bytes: a.Bytes})
}

// Reserve before fetching and release after sending. Each apply stream holds
// at most 256 MiB of blob data, including reads and writes in progress.
const applyInflightBytes int64 = 256 << 20

type applyFetch struct {
	op     wire.Op
	size   int64
	data   chan []byte
	packed []byte
}

type applyReads struct {
	lookup               time.Duration
	loose, packs, ranges int
	bytes                int64
}

func sendApplyOps(ctx context.Context, w io.Writer, source store.Store, byPath map[string]objects.Entry, ops []wire.Op, tempDir string, budget int64, reads *applyReads) error {
	var ids []string
	for _, op := range ops {
		if op.Op == "put" && op.Size <= store.BundleMaxBlob && (op.Mode == "120000" || op.Size <= budget) {
			ids = append(ids, byPath[op.Path].SHA1)
		}
	}
	lookupStart := time.Now()
	locations, err := store.LocateBundlesForRestore(ctx, source, ids)
	reads.lookup = time.Since(lookupStart)
	if err != nil {
		return err
	}

	start := 0
	for i, op := range ops {
		if op.Op != "put" {
			continue
		}
		if _, packed := locations[byPath[op.Path].SHA1]; !packed {
			reads.loose++
		}
		if op.Mode == "120000" || op.Size <= budget {
			continue
		}
		// Drain the prefetched operations on either side of a large blob
		// separately so only one large download is staged at a time.
		if err := sendApplyWindows(ctx, w, source, byPath, ops[start:i], locations, budget, reads); err != nil {
			return err
		}
		if err := sendLargeApplyOp(ctx, w, source, byPath[op.Path].SHA1, op, tempDir); err != nil {
			return err
		}
		start = i + 1
	}
	return sendApplyWindows(ctx, w, source, byPath, ops[start:], locations, budget, reads)
}

type applyBundle struct {
	id   string
	ref  store.BundleRef
	full bool
	data []byte
}

func sendApplyWindows(ctx context.Context, w io.Writer, source store.Store, byPath map[string]objects.Entry, ops []wire.Op, locations map[string]store.BundleRef, budget int64, reads *applyReads) error {
	if len(locations) == 0 {
		return sendBufferedApplyOps(ctx, w, source, byPath, ops, nil, nil, budget)
	}
	for start := 0; start < len(ops); {
		var packBytes, maxLoose int64
		var keys []string
		packs := make(map[string]*applyBundle)
		end := start
		for ; end < len(ops); end++ {
			op := ops[end]
			if op.Op != "put" {
				continue
			}
			entry := byPath[op.Path]
			ref, packed := locations[entry.SHA1]
			if !packed {
				if entry.Size > budget-packBytes {
					break
				}
				maxLoose = max(maxLoose, entry.Size)
				continue
			}
			if ref.Size != entry.Size || !store.ValidateBundleRef(ref) {
				return fmt.Errorf("corrupt blob bundle locator")
			}
			need := ref.Size
			pack := packs[ref.Key]
			if pack != nil {
				if pack.ref.PackSize != ref.PackSize {
					return fmt.Errorf("inconsistent blob bundle size")
				}
				if pack.full || pack.id == entry.SHA1 {
					continue
				}
				need = ref.PackSize - pack.ref.Size
			}
			if need > budget-maxLoose-packBytes {
				break
			}
			packBytes += need
			if pack == nil {
				keys = append(keys, ref.Key)
				packs[ref.Key] = &applyBundle{id: entry.SHA1, ref: ref}
			} else {
				pack.full = true
			}
		}
		if end == start {
			return fmt.Errorf("apply blob exceeds byte limit")
		}

		// Share each fetched pack (or just one member for a sparse lookup).
		// Leave the reserved remainder for loose reads and their ordered writes.
		if len(keys) != 0 {
			fetchCtx, cancel := context.WithCancelCause(ctx)
			_ = store.Parallel(fetchCtx, min(store.Depth(source), len(keys)), keys, func(key string) error {
				pack := packs[key]
				var err error
				if pack.full {
					pack.data, err = store.ReadBundle(fetchCtx, source, key, pack.ref.PackSize)
				} else {
					pack.data, err = store.ReadBundleMember(fetchCtx, source, pack.id, pack.ref)
				}
				if err != nil {
					cancel(err)
				}
				return err
			})
			err := context.Cause(fetchCtx)
			cancel(nil)
			if err != nil {
				return err
			}
			for _, pack := range packs {
				if pack.full {
					reads.packs++
				} else if pack.ref.Size > 0 {
					reads.ranges++
				}
			}
			reads.bytes += packBytes
		}
		if err := sendBufferedApplyOps(ctx, w, source, byPath, ops[start:end], locations, packs, budget-packBytes); err != nil {
			return err
		}
		start = end
	}
	return context.Cause(ctx)
}

func sendLargeApplyOp(ctx context.Context, w io.Writer, source store.Store, sha1 string, op wire.Op, tempDir string) error {
	file, err := store.OpenVerifiedBlobFile(ctx, source, tempDir, sha1, op.Size)
	if err != nil {
		return err
	}
	defer file.Close()
	if err := wire.Send(w, op); err != nil {
		return err
	}
	buf := make([]byte, wire.DataMax)
	for left := op.Size; left > 0; {
		if err := ctx.Err(); err != nil {
			return err
		}
		data := buf[:min(int64(len(buf)), left)]
		if _, err := io.ReadFull(file, data); err != nil {
			return err
		}
		if err := wire.Write(w, data); err != nil {
			return err
		}
		left -= int64(len(data))
	}
	return nil
}

func sendBufferedApplyOps(parent context.Context, w io.Writer, source store.Store, byPath map[string]objects.Entry, ops []wire.Op, locations map[string]store.BundleRef, packs map[string]*applyBundle, budget int64) error {
	if len(ops) == 0 {
		return context.Cause(parent)
	}
	ctx, cancel := context.WithCancelCause(parent)
	depth := store.Depth(source)
	slots := make(chan struct{}, depth)
	queue := make(chan applyFetch, depth)
	released := make(chan struct{}, 1)
	var mu sync.Mutex
	var reserved int64
	var work sync.WaitGroup
	defer func() {
		cancel(nil)
		work.Wait()
	}()

	work.Add(1)
	go func() {
		defer work.Done()
		defer close(queue)
		for _, op := range ops {
			item := applyFetch{op: op}
			entry := byPath[op.Path]
			ref, packed := locations[entry.SHA1]
			switch {
			case op.Op != "put":
			case packed:
				pack := packs[ref.Key]
				item.packed = pack.data
				if pack.full {
					item.packed = pack.data[ref.Offset : ref.Offset+ref.Size]
					if store.GitHash("blob", item.packed) != entry.SHA1 || fmt.Sprintf("%x", sha256.Sum256(item.packed)) != ref.SHA256 {
						cancel(fmt.Errorf("corrupt packed blob"))
						return
					}
				}
			default:
				if entry.Size > budget {
					cancel(fmt.Errorf("apply blob exceeds byte limit"))
					return
				}
				if entry.Size < 0 {
					cancel(fmt.Errorf("corrupt blob"))
					return
				}
				item.size = entry.Size
				item.data = make(chan []byte, 1)
				// Reserve in stream order so a later fetch can never starve the head.
				for {
					mu.Lock()
					if item.size <= budget-reserved {
						reserved += item.size
						mu.Unlock()
						break
					}
					mu.Unlock()
					select {
					case <-released:
					case <-ctx.Done():
						return
					}
				}
				select {
				case slots <- struct{}{}:
				case <-ctx.Done():
					return
				}
				work.Add(1)
				go func() {
					defer work.Done()
					defer func() { <-slots }()
					data, err := fetchApplyBlob(ctx, source, entry)
					if err != nil {
						cancel(err)
						return
					}
					item.data <- data
				}()
			}
			select {
			case queue <- item:
			case <-ctx.Done():
				return
			}
		}
	}()

	for item := range queue {
		data := item.packed
		if item.data != nil {
			select {
			case data = <-item.data:
			case <-ctx.Done():
				return context.Cause(ctx)
			}
		}
		if err := context.Cause(ctx); err != nil {
			return err
		}
		if err := writeApplyOp(w, item.op, data); err != nil {
			return err
		}
		if item.size > 0 {
			mu.Lock()
			reserved -= item.size
			mu.Unlock()
			select {
			case released <- struct{}{}:
			default:
			}
		}
	}
	return context.Cause(ctx)
}

func fetchApplyBlob(ctx context.Context, source store.Store, entry objects.Entry) ([]byte, error) {
	r, err := store.OpenLooseBlob(ctx, source, entry.SHA1)
	if err != nil {
		return nil, err
	}
	defer r.Close()
	// Read into the reservation directly so even a corrupt oversized blob
	// cannot make us buffer more than its declared size.
	data := make([]byte, entry.Size)
	if _, err := io.ReadFull(r, data); err != nil {
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			return nil, fmt.Errorf("corrupt blob")
		}
		return nil, err
	}
	var extra [1]byte
	if _, err := io.ReadFull(r, extra[:]); err != io.EOF {
		if err != nil {
			return nil, err
		}
		return nil, fmt.Errorf("corrupt blob")
	}
	if store.GitHash("blob", data) != entry.SHA1 {
		return nil, fmt.Errorf("corrupt blob")
	}
	return data, nil
}

func writeApplyOp(w io.Writer, op wire.Op, data []byte) error {
	// Both production guests use a link operation, with the target in JSON.
	if op.Op == "put" && op.Mode == "120000" {
		if len(data) > wire.JSONMax {
			return fmt.Errorf("JSON frame too large")
		}
		op.Op, op.Mode, op.Size, op.Target = "link", "", 0, string(data)
		data = nil
	}
	if err := wire.Send(w, op); err != nil {
		return err
	}
	for len(data) > 0 {
		n := min(len(data), wire.DataMax)
		if err := wire.Write(w, data[:n]); err != nil {
			return err
		}
		data = data[n:]
	}
	return nil
}

type staged struct {
	path, sha256, sha1 string
	size               int64
}
type received struct {
	files                map[string]objects.File
	blobs                []staged
	count                int
	bytes                int64
	walk, freeze, stream float64
	dir                  string
}

func (m *Manager) receive(ctx context.Context, v *Mount, c net.Conn, prepared receiveBase) (received, error) {
	var h wire.Header
	if err := wire.JSON(c, &h); err != nil {
		return received{}, err
	}
	return m.receiveCheckpoint(ctx, v, c, prepared, h)
}

func (m *Manager) receiveCheckpoint(ctx context.Context, v *Mount, c net.Conn, prepared receiveBase, h wire.Header) (out received, err error) {
	start := time.Now()
	out.dir, err = os.MkdirTemp(m.Data, "checkpoint-")
	if err != nil {
		return
	}
	defer func() {
		if err != nil {
			os.RemoveAll(out.dir)
		}
	}()
	// v0-limitation: L50
	quota := prepared.quota
	out.files = prepared.files
	var e error
	if h.V != 1 || h.Kind != "checkpoint" || h.JobID != v.JobID || h.BaseTree != v.Tree {
		return out, fmt.Errorf("header mismatch")
	}
	out.walk = h.WalkMs
	seen := map[string]bool{}
	var pathsBytes, linkBytes int64
	for {
		var o wire.Op
		if e = wire.JSON(c, &o); e != nil {
			return out, e
		}
		if o.End {
			// One convention: the trailer counts the raw payload bytes streamed after
			// put ops. A link op's target travels in its JSON, so it is not in the
			// trailer, while the receiver still charges it against quota and byte caps.
			if o.Error != "" || o.Files != out.count || o.Bytes != out.bytes-linkBytes {
				return out, fmt.Errorf("trailer mismatch")
			}
			out.freeze = o.FreezeMs
			break
		}
		if e = objects.Path(o.Path); e != nil {
			return out, e
		}
		if seen[o.Path] {
			return out, fmt.Errorf("duplicate path")
		}
		seen[o.Path] = true
		out.count++
		pathsBytes += int64(len(o.Path))
		if out.count > m.MaxFiles || pathsBytes > m.MaxPathsBytes {
			return out, fmt.Errorf("stream caps exceeded")
		}
		if o.Op == "del" {
			delete(out.files, o.Path)
			continue
		}
		if o.Mode != "100644" && o.Mode != "100755" && o.Mode != "120000" && o.Op != "link" {
			return out, fmt.Errorf("bad mode")
		}
		if o.Op == "mode" {
			f, ok := out.files[o.Path]
			if !ok {
				return out, fmt.Errorf("missing mode path")
			}
			f.Mode = o.Mode
			out.files[o.Path] = f
			continue
		}
		if o.Op != "put" && o.Op != "link" {
			return out, fmt.Errorf("bad op")
		}
		if o.Op == "link" {
			o.Size = int64(len(o.Target))
			o.Mode = "120000"
			linkBytes += o.Size
		}
		if o.Size < 0 || o.Mode == "120000" && o.Size > 4096 || o.Size > m.MaxBytes-out.bytes || o.Size > quota-out.bytes {
			return out, fmt.Errorf("size cap exceeded")
		}
		out.bytes += o.Size
		f, e := os.CreateTemp(out.dir, "blob-")
		if e != nil {
			return out, e
		}
		h1, h256 := sha1.New(), sha256.New()
		fmt.Fprintf(h1, "blob %d\x00", o.Size)
		w := io.MultiWriter(f, h1, h256)
		if o.Op == "link" {
			_, e = io.WriteString(w, o.Target)
		} else {
			for left := o.Size; left > 0; {
				var b []byte
				b, e = wire.Read(c, wire.DataMax)
				if e != nil {
					break
				}
				if int64(len(b)) > left {
					e = fmt.Errorf("size mismatch")
					break
				}
				_, e = w.Write(b)
				if e != nil {
					break
				}
				left -= int64(len(b))
			}
		}
		ce := f.Close()
		if e == nil {
			e = ce
		}
		if e != nil {
			return out, e
		}
		sha := fmt.Sprintf("%x", h256.Sum(nil))
		out.blobs = append(out.blobs, staged{path: f.Name(), sha256: sha, sha1: fmt.Sprintf("%x", h1.Sum(nil)), size: o.Size})
		out.files[o.Path] = objects.File{SHA256: sha, Mode: o.Mode}
	}
	// Enforce the mount quota on the final listing as well as incoming bytes.
	var total int64
	sizes := prepared.sizes
	for _, b := range out.blobs {
		sizes[b.sha256] = b.size
	}
	for _, f := range out.files {
		size, found := sizes[f.SHA256]
		if !found {
			return out, fmt.Errorf("missing blob size")
		}
		if f.Mode == "120000" && size > 4096 {
			return out, fmt.Errorf("link size cap")
		}
		if size > quota-total {
			return out, fmt.Errorf("mount quota exceeded")
		}
		total += size
	}

	if len(out.files) > m.MaxFiles {
		return out, fmt.Errorf("file cap exceeded")
	}
	// Detect file/directory conflicts before ack or any publish.
	paths := make([]string, 0, len(out.files))
	for p := range out.files {
		paths = append(paths, p)
	}
	sort.Strings(paths)
	for _, p := range paths {
		for parent := filepath.Dir(p); parent != "."; parent = filepath.Dir(parent) {
			if _, ok := out.files[parent]; ok {
				return out, fmt.Errorf("file/directory conflict")
			}
		}
	}
	out.stream = ms(start)
	return out, nil
}
func (m *Manager) SessionCheckpoint(ctx context.Context, id string, baseline bool, q CheckpointRequest, publish func(context.Context, Checkpoint) error) (out Checkpoint, err error) {
	defer func() { out.Timings = out.timingFields() }()
	if err := q.Validate(); err != nil {
		return out, err
	}
	if publish == nil {
		return out, apierr.Invalid("session checkpoint requires a publisher")
	}
	timeout := q.TimeoutMs
	if timeout == 0 {
		timeout = 120000
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
	defer cancel()
	v := m.lookup(id)
	if v == nil {
		return out, os.ErrNotExist
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if !validMountFence(v.Fence) {
		return out, &apierr.Error{Status: 409, Code: "no_fence", Cause: fmt.Errorf("mount has no fence")}
	}
	if v.streams == nil {
		return out, apierr.Invalid("invalid missing vsock")
	}
	raw, closeStream, e := v.streams.acceptCheckpoint(ctx, nil)
	if e != nil {
		return out, e
	}
	defer closeStream()
	c := net.Conn(raw)
	cancelDone := make(chan struct{})
	stopCancel := context.AfterFunc(ctx, func() { raw.SetDeadline(time.Now()); close(cancelDone) })
	defer stopCancel()
	deadline, _ := ctx.Deadline()
	c = &wire.DeadlineConn{Conn: raw, Idle: m.StreamIdle, Overall: deadline}
	streamStart := time.Now()
	prepared, e := m.prepareReceive(ctx, v)
	if e != nil {
		return out, e
	}
	if err = wire.Send(c, map[string]bool{"ready": true}); err != nil {
		return out, ErrStreamTimeout
	}
	var header wire.Header
	e = wire.JSON(c, &header)
	if e == nil && baseline && header.Kind == "baseline" {
		start := time.Now()
		snap, err := m.reserveBaseline(v)
		if err == nil {
			err = snap.capture(v, c, header)
			if err == nil {
				go m.publishCapturedBaseline(v, snap, start, ms(start))
				return out, nil
			}
			m.discardBaseline(snap)
		}
		logBaseline(v.JobID, v.Tree, start, ms(start), err)
		wire.Send(c, map[string]any{"ack": false, "error": err.Error()})
		return out, nil
	}
	var r received
	if e == nil {
		r, e = m.receiveCheckpoint(ctx, v, c, prepared, header)
	}
	if e != nil {
		if !stopCancel() {
			<-cancelDone
		}
		raw.SetWriteDeadline(time.Now().Add(time.Second))
		finalCode := e.Error()
		var timeoutErr net.Error
		if ctx.Err() != nil || errors.As(e, &timeoutErr) && timeoutErr.Timeout() {
			finalCode = ErrStreamTimeout.Error()
		}
		wire.Send(raw, map[string]any{"ack": false, "error": finalCode})
		if ctx.Err() != nil || time.Until(deadline) < 2*time.Millisecond {
			return out, ErrStreamTimeout
		}
		var ne net.Error
		if errors.As(e, &ne) && ne.Timeout() {
			return out, ErrStreamTimeout
		}
		return out, fmt.Errorf("%w: %v", ErrBadStream, e)
	}
	defer os.RemoveAll(r.dir)
	snap := filepath.Join(filepath.Dir(v.Dest), checkpointSnapshot)
	defer os.Remove(snap)
	if err := clone(v.Dest, snap); err != nil {
		slog.Warn("checkpoint_image_capture_failed", "job", v.JobID, "error", err)
		snap = ""
	}
	if err = wire.Send(c, map[string]bool{"ack": true}); err != nil {
		return out, ErrStreamTimeout
	}
	c.Close()
	publishing := time.Now()
	repo := m.objects(v.Lineage)
	if e = publishCheckpointBlobs(ctx, repo, r.blobs); e != nil {
		return out, e
	}
	tree, e := repo.Import(ctx, objects.Request{Lineage: v.Lineage, ParentTree: v.Tree, Files: r.files})
	if e != nil {
		return out, e
	}
	out, err = m.publishCheckpoint(ctx, v, tree.Tree, snap, q, publish)
	out.FilesChanged = r.count
	out.BytesReceived = r.bytes
	out.WalkMs = r.walk
	out.StreamMs = float64(publishing.Sub(streamStart).Microseconds()) / 1000
	out.FreezeMs = r.freeze
	out.PublishMs = ms(publishing)
	return
}

func publishCheckpointBlobs(ctx context.Context, repo *objects.Repository, blobs []staged) error {
	byID := make(map[string]staged, len(blobs))
	var loose []string
	var small []staged
	bundle := store.BundlesEnabled(repo.Store)
	for _, blob := range blobs {
		if prior, ok := byID[blob.sha1]; ok {
			if prior.sha256 != blob.sha256 || prior.size != blob.size {
				return fmt.Errorf("conflicting checkpoint blob %s", blob.sha1)
			}
			continue
		}
		byID[blob.sha1] = blob
		if bundle && blob.size <= store.BundleMaxBlob {
			small = append(small, blob)
		} else {
			loose = append(loose, blob.sha1)
		}
	}
	var smallDone chan error
	if len(small) != 0 {
		smallDone = make(chan error, 1)
		go func() { smallDone <- publishCheckpointSmallBlobs(ctx, repo, small) }()
	}
	err := store.Parallel(ctx, min(store.Depth(repo.Store), len(loose)), loose, func(id string) error {
		blob := byID[id]
		f, err := os.Open(blob.path)
		if err != nil {
			return err
		}
		defer f.Close()
		_, err = repo.PublishBlobFile(ctx, f, objects.Blob{SHA1: id, SHA256: blob.sha256, Size: blob.size})
		return err
	})
	if smallDone != nil {
		err = errors.Join(err, <-smallDone)
	}
	return err
}

func publishCheckpointSmallBlobs(ctx context.Context, repo *objects.Repository, blobs []staged) error {
	// Keep both the byte buffers and the member metadata bounded while reading
	// from the checkpoint spool. A pack corresponds to at most one window.
	const maxMembers = 2048
	for len(blobs) > 0 {
		var size int64
		count := 0
		for count < min(len(blobs), maxMembers) && size+blobs[count].size <= store.BundleTargetBytes {
			size += blobs[count].size
			count++
		}
		items := make([]store.SmallBlob, 0, count)
		for _, blob := range blobs[:count] {
			if err := ctx.Err(); err != nil {
				return err
			}
			raw, err := os.ReadFile(blob.path)
			if err != nil {
				return err
			}
			if int64(len(raw)) != blob.size {
				return fmt.Errorf("checkpoint blob size changed")
			}
			items = append(items, store.SmallBlob{Key: "o/" + blob.sha1, SHA256: blob.sha256, Data: raw})
		}
		if err := repo.PublishSmallBlobs(ctx, items, nil); err != nil {
			return err
		}
		blobs = blobs[count:]
	}
	return nil
}

func sendIndex(w io.Writer, entries []objects.Entry) error {
	batch := []objects.Entry{}
	size := len(`{"index":[]}`)
	flush := func() error {
		if len(batch) == 0 {
			return nil
		}
		e := wire.Send(w, map[string]any{"index": batch})
		batch = nil
		size = len(`{"index":[]}`)
		return e
	}
	for _, f := range entries {
		b, e := json.Marshal(f)
		if e != nil {
			return e
		}
		extra := len(b)
		if len(batch) > 0 {
			extra++
		}
		if size+extra > wire.JSONMax {
			if e := flush(); e != nil {
				return e
			}
			extra = len(b)
		}
		batch = append(batch, f)
		size += extra
	}
	return flush()
}

type receiveBase struct {
	quota int64
	files map[string]objects.File
	sizes map[string]int64
}

func (m *Manager) prepareReceive(ctx context.Context, v *Mount) (out receiveBase, err error) {
	info, err := os.Stat(v.Dest)
	if err != nil {
		return out, err
	}
	out.quota = info.Size()
	// v0-limitation: L53
	entries, err := m.entries(ctx, v.Lineage, v.Tree)
	if err != nil {
		return out, err
	}
	out.files = map[string]objects.File{}
	out.sizes = map[string]int64{}
	// Resolve the base tree's blobs through the repository: rows this host already has, else a durable HEAD
	// that records membership. A host serves trees whose blobs another writer (the tier) uploaded.
	ids := make([]string, len(entries))
	for i, f := range entries {
		ids[i] = f.SHA1
	}
	blobs, err := m.objects(v.Lineage).BlobInfos(ctx, v.Lineage, ids)
	if err != nil {
		return out, err
	}
	for _, f := range entries {
		found := blobs[f.SHA1]
		if found.Err != nil {
			return out, fmt.Errorf("lineage blob %s: %w", f.SHA1, found.Err)
		}
		out.files[f.Path] = objects.File{SHA256: found.Blob.SHA256, Mode: f.Mode}
		out.sizes[found.Blob.SHA256] = found.Blob.Size
	}
	return out, nil
}
