package image

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
	"io"
	"net"
	"os"
	"path/filepath"
	"sort"
	"sync"
	"time"
)

var ErrBadStream = errors.New("bad-stream")
var ErrStreamTimeout = errors.New("stream-timeout")

type Apply struct {
	FromTree string `json:"fromTree"`
	ToTree   string `json:"toTree"`
	Files    int    `json:"files"`
	Bytes    int64  `json:"bytes"`
}
type arm struct {
	ctx  context.Context
	conn chan net.Conn
}
type streams struct {
	mu        sync.Mutex
	listeners []net.Listener
	conns     map[net.Conn]bool
	armed     *arm
	used      bool
	closed    bool
}

func (s *streams) close() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closed = true
	for _, l := range s.listeners {
		l.Close()
	}
	for c := range s.conns {
		c.Close()
	}
}
func (m *Manager) entries(ctx context.Context, t string) ([]objects.Entry, error) {
	if t == "" {
		return []objects.Entry{}, nil
	}
	return m.objects().Entries(ctx, t)
}

// v0-limitation: L53
func (m *Manager) startStreams(ctx context.Context, v *Mount, from string) error {
	old, e := m.entries(ctx, from)
	if e != nil {
		return e
	}
	next, e := m.entries(ctx, v.Tree)
	if e != nil {
		return e
	}
	prev := map[string]objects.Entry{}
	for _, f := range old {
		prev[f.Path] = f
	}
	var ops []wire.Op
	for _, f := range next {
		p, ok := prev[f.Path]
		if !ok || p.SHA1 != f.SHA1 || p.Mode != f.Mode {
			ops = append(ops, wire.Op{Path: f.Path, Op: "put", Mode: f.Mode, Size: f.Size})
		}
		delete(prev, f.Path)
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
	a := Apply{FromTree: from, ToTree: v.Tree, Files: len(ops)}
	for _, o := range ops {
		a.Bytes += o.Size
	}
	if from != v.Tree {
		v.Apply = &a
	}
	if v.Vsock == "" {
		return nil
	}
	s := &streams{conns: map[net.Conn]bool{}}
	v.streams = s
	for _, port := range []string{"5200", "5201"} {
		l, e := net.Listen("unix", v.Vsock+"_"+port)
		if e != nil {
			s.close()
			return e
		}
		if e = os.Chmod(v.Vsock+"_"+port, 0600); e != nil {
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
					}
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
					defer c.Close()
					defer func() { s.mu.Lock(); delete(s.conns, c); s.mu.Unlock() }()
					c.SetDeadline(time.Now().Add(10 * time.Minute))
					if e := m.sendApply(c, v.JobID, a, next, ops); e != nil {
						wire.Send(c, wire.Op{End: true, Error: e.Error()})
						return
					}
					var reply struct {
						Applied bool    `json:"applied"`
						ApplyMs float64 `json:"applyMs"`
					}
					if wire.JSON(c, &reply) == nil && reply.Applied {
						v.mu.Lock()
						v.Applied = true
						v.ApplyMs = reply.ApplyMs
						v.mu.Unlock()
					}
				}()
			}
		}(port, l)
	}
	return nil
}
func (m *Manager) sendApply(c net.Conn, job string, a Apply, entries []objects.Entry, ops []wire.Op) error {
	// v0-limitation: L52
	ctx, cancel := context.WithDeadline(context.Background(), time.Now().Add(10*time.Minute))
	defer cancel()
	if e := wire.Send(c, wire.Header{V: 1, Kind: "apply", JobID: job, FromTree: a.FromTree, ToTree: a.ToTree}); e != nil {
		return e
	}
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

	// Each batch has both a count and a byte bound. Completed fetches stream
	// immediately, releasing their buffer without waiting for slower peers.
	for start := 0; start < len(ops); {
		end := applyBatchEnd(ops, start, store.Depth(m.Store))
		var writeMu sync.Mutex
		keys := make([]string, end-start)
		byKey := map[string]wire.Op{}
		for i, op := range ops[start:end] {
			keys[i] = op.Path
			byKey[op.Path] = op
		}
		e := store.Parallel(ctx, store.Depth(m.Store), keys, func(p string) error {
			op := byKey[p]
			var b []byte
			if op.Op == "put" {
				f := byPath[p]
				if f.Size > applyByteLimit {
					return fmt.Errorf("apply blob exceeds byte limit")
				}
				var e error
				b, e = m.Store.Get(ctx, "o/"+f.SHA1)
				if e != nil {
					return e
				}
				if int64(len(b)) != f.Size || store.GitHash("blob", b) != f.SHA1 {
					return fmt.Errorf("corrupt blob")
				}
			}
			writeMu.Lock()
			defer writeMu.Unlock()
			if e := wire.Send(c, op); e != nil {
				return e
			}
			for len(b) > 0 {
				n := min(len(b), wire.DataMax)
				if e := wire.Write(c, b[:n]); e != nil {
					return e
				}
				b = b[n:]
			}
			return nil
		})
		if e != nil {
			return e
		}
		start = end
	}

	return wire.Send(c, wire.Op{End: true, Files: a.Files, Bytes: a.Bytes})
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

func (m *Manager) receive(ctx context.Context, v *Mount, c net.Conn, prepared receiveBase) (out received, err error) {
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
	var h wire.Header
	if e = wire.JSON(c, &h); e != nil {
		return out, e
	}
	if h.V != 1 || h.Kind != "checkpoint" || h.JobID != v.JobID || h.BaseTree != v.Tree {
		return out, fmt.Errorf("header mismatch")
	}
	out.walk = h.WalkMs
	seen := map[string]bool{}
	var pathsBytes int64
	for {
		var o wire.Op
		if e = wire.JSON(c, &o); e != nil {
			return out, e
		}
		if o.End {
			if o.Error != "" || o.Files != out.count || o.Bytes != out.bytes {
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
func (m *Manager) StreamCheckpoint(ctx context.Context, id string, timeout int, metadata ...CheckpointRequest) (out Checkpoint, err error) {
	if timeout == 0 {
		timeout = 120000
	}
	if timeout < 1 || timeout > 600000 {
		return out, fmt.Errorf("invalid timeoutMs")
	}
	// v0-limitation: L52
	ctx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Millisecond)
	defer cancel()
	for _, q := range metadata {
		if e := q.Validate(); e != nil {
			return out, e
		}
	}
	if len(metadata) == 0 {
		metadata = []CheckpointRequest{{}}
	}
	v := m.lookup(id)
	if v == nil {
		return out, os.ErrNotExist
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.Ref == "" {
		return out, refs.ErrFenced
	}
	if v.streams == nil {
		return out, fmt.Errorf("invalid missing vsock")
	}
	if err = m.Refs.Check(v.Lineage, v.Ref, v.Fence); err != nil {
		return
	}
	s := v.streams
	a := &arm{ctx: ctx, conn: make(chan net.Conn)}
	s.mu.Lock()
	s.armed = a
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		if s.armed == a {
			s.armed = nil
		}
		s.mu.Unlock()
	}()
	var c net.Conn
	select {
	case c = <-a.conn:
	case <-ctx.Done():
		return out, ErrStreamTimeout
	}
	defer c.Close()
	defer func() { s.mu.Lock(); delete(s.conns, c); s.mu.Unlock() }()
	stopCancel := context.AfterFunc(ctx, func() { c.Close() })
	defer stopCancel()
	deadline, _ := ctx.Deadline()
	c.SetDeadline(deadline.Add(-time.Millisecond))
	prepared, e := m.prepareReceive(ctx, v)
	if e != nil {
		return out, e
	}
	if err = wire.Send(c, map[string]bool{"ready": true}); err != nil {
		return out, ErrStreamTimeout
	}
	r, e := m.receive(ctx, v, c, prepared)
	if e != nil {
		wire.Send(c, map[string]any{"ack": false, "error": e.Error()})
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
	if err = wire.Send(c, map[string]bool{"ack": true}); err != nil {
		return out, ErrStreamTimeout
	}
	c.Close()
	publish := time.Now()
	repo := m.objects()
	keys := make([]string, len(r.blobs))
	blobs := map[string]staged{}
	for i, b := range r.blobs {
		keys[i] = b.path
		blobs[b.path] = b
	}
	e = store.Parallel(ctx, store.Depth(m.Store), keys, func(key string) error {
		b := blobs[key]
		f, e := os.Open(b.path)
		if e != nil {
			return e
		}
		defer f.Close()
		if e = store.PutBlobFile(ctx, m.Store, "o/"+b.sha1, f); e != nil {
			return e
		}
		_, e = repo.DB.DB.ExecContext(ctx, "INSERT OR IGNORE INTO lineage_blobs VALUES(?,?,?,?,?)", v.Lineage, b.sha256, b.sha1, b.size, time.Now().UnixMilli())
		return e
	})
	if e != nil {
		return out, e
	}
	// v0-limitation: L51
	tree, e := repo.Import(ctx, objects.Request{Lineage: v.Lineage, ParentTree: v.Tree, Files: r.files})
	if e != nil {
		return out, e
	}
	out, err = m.checkpoint(ctx, v, tree.Tree, metadata...)
	out.FilesChanged = r.count
	out.BytesReceived = r.bytes
	out.WalkMs = r.walk
	out.StreamMs = r.stream
	out.FreezeMs = r.freeze
	out.PublishMs = ms(publish)
	return
}

const applyByteLimit int64 = 256 << 20

func applyBatchEnd(ops []wire.Op, start, depth int) int {
	var bytes int64
	end := start
	for end < len(ops) && end-start < depth {
		if end > start && (ops[end].Op == "del") != (ops[start].Op == "del") {
			break
		}
		size := ops[end].Size
		if end > start && size > applyByteLimit-bytes {
			break
		}
		bytes += size
		end++
	}
	return end
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
	r, err := m.mountRoot(ctx, v.Root)
	if err != nil {
		return out, err
	}
	out.quota = r.VirtualSize
	// v0-limitation: L53
	entries, err := m.entries(ctx, v.Tree)
	if err != nil {
		return out, err
	}
	out.files = map[string]objects.File{}
	out.sizes = map[string]int64{}
	hashes := map[string]string{}
	rows, err := m.objects().DB.DB.QueryContext(ctx, "SELECT sha1,sha256,size FROM lineage_blobs WHERE lineage=?", v.Lineage)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	for rows.Next() {
		var sha1, sha256 string
		var size int64
		if err = rows.Scan(&sha1, &sha256, &size); err != nil {
			return out, err
		}
		hashes[sha1] = sha256
		out.sizes[sha256] = size
	}
	if err = rows.Err(); err != nil {
		return out, err
	}
	for _, f := range entries {
		sha, ok := hashes[f.SHA1]
		if !ok {
			return out, fmt.Errorf("missing lineage blob")
		}
		out.files[f.Path] = objects.File{SHA256: sha, Mode: f.Mode}
	}
	return out, nil
}
