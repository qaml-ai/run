package main

// A snapshot index is a git tree (its id is the tree sha) plus the list of shards that hold its blobs and a path
// table. Nothing in it is copied from its parent: a child snapshot names the parent's shards and adds one delta shard
// with the blobs the parent did not have. A fork of a snapshot is a ref to the same tree, so it costs nothing.
//
//	store/shards/<id>.{idx,dat,sym}   immutable, shared by every snapshot that names them
//	store/snaps/<tree>.json           manifest: shards, parent, counts
//	store/paths/<tree>.paths          path table: path, mode, blob id (one per tree; equal trees share it)
//	store/refs/<name>                 a volume/fork head: a tree sha (what the FS's refs would hold)

import (
	"bufio"
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Store struct {
	Dir         string
	mu          sync.Mutex
	shards      map[string]*Shard
	snaps       map[string]*Snap
	ShardTarget int64 // content bytes per shard
	Symbols     bool
}

func openStore(dir string) (*Store, error) {
	for _, d := range []string{"shards", "snaps", "paths", "refs"} {
		if err := os.MkdirAll(filepath.Join(dir, d), 0o755); err != nil {
			return nil, err
		}
	}
	return &Store{Dir: dir, shards: map[string]*Shard{}, snaps: map[string]*Snap{}, ShardTarget: 96 << 20}, nil
}

type Manifest struct {
	Tree         string   `json:"tree"`
	Parents      []string `json:"parents,omitempty"`
	Shards       []string `json:"shards"`
	Files        int      `json:"files"`
	NewBlobs     int      `json:"newBlobs"`
	NewShards    []string `json:"newShards"`
	ContentBytes int64    `json:"contentBytes"`
}

type PathEntry struct {
	Path string
	Mode uint32
	Size uint32
	ID   BlobID
}

type Snap struct {
	M      Manifest
	Shards []*Shard
	Paths  []PathEntry
	Lang   []uint8
	// live[s][ord] = first path index holding that blob in this snapshot, or -1 (a superseded blob in a shared shard)
	live  [][]int32
	more  map[int64][]int32 // (s<<32|ord) -> further paths with the same blob
	where map[BlobID]int64  // blob -> s<<32|ord
}

func (st *Store) shard(id string) (*Shard, error) {
	st.mu.Lock()
	defer st.mu.Unlock()
	if s, ok := st.shards[id]; ok {
		return s, nil
	}
	s, err := openShard(filepath.Join(st.Dir, "shards"), id)
	if err != nil {
		return nil, err
	}
	st.shards[id] = s
	return s, nil
}

func (st *Store) readManifest(tree string) (*Manifest, error) {
	b, err := os.ReadFile(filepath.Join(st.Dir, "snaps", tree+".json"))
	if err != nil {
		return nil, err
	}
	var m Manifest
	return &m, json.Unmarshal(b, &m)
}

// Resolve maps a ref name or a tree sha to a tree sha.
func (st *Store) Resolve(name string) (string, error) {
	if b, err := os.ReadFile(filepath.Join(st.Dir, "refs", name)); err == nil {
		return strings.TrimSpace(string(b)), nil
	}
	if _, err := os.Stat(filepath.Join(st.Dir, "snaps", name+".json")); err == nil {
		return name, nil
	}
	return "", fmt.Errorf("no snapshot or ref %q", name)
}

func (st *Store) SetRef(name, tree string) error {
	p := filepath.Join(st.Dir, "refs", name)
	os.MkdirAll(filepath.Dir(p), 0o755)
	return writeAtomic(p, []byte(tree+"\n"))
}

// Fork is a ref to the same tree: no index work at all.
func (st *Store) Fork(from, name string) (string, error) {
	tree, err := st.Resolve(from)
	if err != nil {
		return "", err
	}
	return tree, st.SetRef(name, tree)
}

// Open loads (or returns the cached) query view of a snapshot.
func (st *Store) Open(name string) (*Snap, error) {
	tree, err := st.Resolve(name)
	if err != nil {
		return nil, err
	}
	st.mu.Lock()
	if s, ok := st.snaps[tree]; ok {
		st.mu.Unlock()
		return s, nil
	}
	st.mu.Unlock()
	m, err := st.readManifest(tree)
	if err != nil {
		return nil, err
	}
	sn := &Snap{M: *m, more: map[int64][]int32{}, where: map[BlobID]int64{}}
	for _, id := range m.Shards {
		s, err := st.shard(id)
		if err != nil {
			return nil, err
		}
		sn.Shards = append(sn.Shards, s)
	}
	if sn.Paths, err = readPaths(filepath.Join(st.Dir, "paths", tree+".paths")); err != nil {
		return nil, err
	}
	sn.Lang = make([]uint8, len(sn.Paths))
	for i := range sn.Paths {
		sn.Lang[i] = langOf(sn.Paths[i].Path)
	}
	sn.live = make([][]int32, len(sn.Shards))
	for si, s := range sn.Shards {
		l := make([]int32, s.nBlob)
		for o := range l {
			l[o] = -1
			sn.where[s.blobID(o)] = int64(si)<<32 | int64(o)
		}
		sn.live[si] = l
	}
	for pi, p := range sn.Paths {
		w, ok := sn.where[p.ID]
		if !ok {
			continue // symlink, submodule
		}
		si, o := int(w>>32), int(uint32(w))
		if sn.live[si][o] < 0 {
			sn.live[si][o] = int32(pi)
		} else {
			sn.more[w] = append(sn.more[w], int32(pi))
		}
	}
	st.mu.Lock()
	st.snaps[tree] = sn
	st.mu.Unlock()
	return sn, nil
}

// ---- path table ----

func writePaths(file string, ps []PathEntry) error {
	var b bytes.Buffer
	var tmp [binary.MaxVarintLen64]byte
	b.Write(tmp[:binary.PutUvarint(tmp[:], uint64(len(ps)))])
	for _, p := range ps {
		b.Write(p.ID[:])
		b.Write(tmp[:binary.PutUvarint(tmp[:], uint64(p.Mode))])
		b.Write(tmp[:binary.PutUvarint(tmp[:], uint64(p.Size))])
		b.Write(tmp[:binary.PutUvarint(tmp[:], uint64(len(p.Path)))])
		b.WriteString(p.Path)
	}
	return writeAtomic(file, b.Bytes())
}

func readPaths(file string) ([]PathEntry, error) {
	data, err := os.ReadFile(file)
	if err != nil {
		return nil, err
	}
	r := bytes.NewReader(data)
	n, _ := binary.ReadUvarint(r)
	ps := make([]PathEntry, n)
	for i := range ps {
		io.ReadFull(r, ps[i].ID[:])
		m, _ := binary.ReadUvarint(r)
		sz, _ := binary.ReadUvarint(r)
		l, _ := binary.ReadUvarint(r)
		pb := make([]byte, l)
		io.ReadFull(r, pb)
		ps[i] = PathEntry{Path: string(pb), Mode: uint32(m), Size: uint32(sz), ID: ps[i].ID}
	}
	return ps, nil
}

// ---- ingest from git ----

type IngestStats struct {
	Tree        string  `json:"tree"`
	Files       int     `json:"files"`
	NewBlobs    int     `json:"newBlobs"`
	NewBytes    int64   `json:"newBytes"`
	NewShards   int     `json:"newShards"`
	IdxBytes    int64   `json:"idxBytes"`
	DatBytes    int64   `json:"datBytes"`
	SymBytes    int64   `json:"symBytes"`
	PathsBytes  int64   `json:"pathsBytes"`
	ListMs      float64 `json:"listMs"`
	ReadMs      float64 `json:"readMs"`
	IndexMs     float64 `json:"indexMs"`
	TotalMs     float64 `json:"totalMs"`
	Reused      bool    `json:"reused"`
	TotalShards int     `json:"totalShards"`
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }

func git(repo string, args ...string) ([]byte, error) {
	cmd := exec.Command("git", append([]string{"-C", repo}, args...)...)
	cmd.Stderr = os.Stderr
	return cmd.Output()
}

func lsTree(repo, commit string) ([]PathEntry, error) {
	out, err := git(repo, "ls-tree", "-r", "-z", "--long", commit)
	if err != nil {
		return nil, err
	}
	var ps []PathEntry
	for _, rec := range bytes.Split(out, []byte{0}) {
		if len(rec) == 0 {
			continue
		}
		tab := bytes.IndexByte(rec, '\t')
		f := strings.Fields(string(rec[:tab]))
		if len(f) < 4 || f[1] != "blob" {
			continue // submodules
		}
		mode, _ := strconv.ParseUint(f[0], 8, 32)
		size, _ := strconv.ParseUint(f[3], 10, 32)
		id, err := parseBlobID(f[2])
		if err != nil {
			return nil, err
		}
		ps = append(ps, PathEntry{Path: string(rec[tab+1:]), Mode: uint32(mode), Size: uint32(size), ID: id})
	}
	return ps, nil
}

// catFile streams the contents of ids out of repo's object store with one `git cat-file --batch`.
func catFile(repo string, ids []BlobID, emit func(BlobID, []byte)) error {
	cmd := exec.Command("git", "-C", repo, "cat-file", "--batch")
	in, _ := cmd.StdinPipe()
	outp, _ := cmd.StdoutPipe()
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() {
		w := bufio.NewWriterSize(in, 1<<16)
		for _, id := range ids {
			w.WriteString(id.String())
			w.WriteByte('\n')
		}
		w.Flush()
		in.Close()
	}()
	r := bufio.NewReaderSize(outp, 1<<20)
	for _, id := range ids {
		hdr, err := r.ReadString('\n')
		if err != nil {
			return err
		}
		f := strings.Fields(hdr)
		if len(f) < 3 {
			return fmt.Errorf("cat-file: %q", hdr)
		}
		n, _ := strconv.Atoi(f[2])
		buf := make([]byte, n+1)
		if _, err := io.ReadFull(r, buf); err != nil {
			return err
		}
		emit(id, buf[:n])
	}
	return cmd.Wait()
}

// Ingest indexes the tree of commit in repo. parents name the snapshots it derives from (the previous checkpoint of
// this volume, or both sides of a merge); their shards are reused and only blobs they lack are read and indexed.
func (st *Store) Ingest(repo, commit string, parents []string) (*IngestStats, error) {
	t0 := time.Now()
	treeOut, err := git(repo, "rev-parse", commit+"^{tree}")
	if err != nil {
		return nil, err
	}
	tree := strings.TrimSpace(string(treeOut))
	stats := &IngestStats{Tree: tree}
	if m, err := st.readManifest(tree); err == nil {
		stats.Reused, stats.Files, stats.TotalShards = true, m.Files, len(m.Shards)
		stats.TotalMs = ms(time.Since(t0))
		return stats, nil
	}
	paths, err := lsTree(repo, commit)
	if err != nil {
		return nil, err
	}
	stats.Files = len(paths)
	stats.ListMs = ms(time.Since(t0))

	// Blobs the parents already index.
	known := map[BlobID]bool{}
	var parentTrees, shardIDs []string
	seenShard := map[string]bool{}
	for _, p := range parents {
		pt, err := st.Resolve(p)
		if err != nil {
			return nil, err
		}
		pm, err := st.readManifest(pt)
		if err != nil {
			return nil, err
		}
		parentTrees = append(parentTrees, pt)
		for _, id := range pm.Shards {
			s, err := st.shard(id)
			if err != nil {
				return nil, err
			}
			for o := 0; o < s.nBlob; o++ {
				known[s.blobID(o)] = true
			}
			if !seenShard[id] {
				seenShard[id] = true
				shardIDs = append(shardIDs, id)
			}
		}
	}
	// New blobs, in path order (locality: a directory's files land in the same shard).
	type nb struct {
		id   BlobID
		ext  string
		size uint32
	}
	var fresh []nb
	seen := map[BlobID]bool{}
	live := map[BlobID]bool{}
	for _, p := range paths {
		if p.Mode == 0o120000 {
			continue // symlink target text: not indexed
		}
		live[p.ID] = true
		if known[p.ID] || seen[p.ID] {
			continue
		}
		seen[p.ID] = true
		fresh = append(fresh, nb{p.ID, path.Ext(p.Path), p.Size})
	}
	// Drop parent shards that no longer hold any live blob (a fully superseded delta shard).
	var keep []string
	for _, id := range shardIDs {
		s, _ := st.shard(id)
		for o := 0; o < s.nBlob; o++ {
			if live[s.blobID(o)] {
				keep = append(keep, id)
				break
			}
		}
	}

	// Group into shards by content size, then read + index groups in parallel.
	var groups [][]nb
	var cur []nb
	var curBytes int64
	for _, b := range fresh {
		cur = append(cur, b)
		curBytes += int64(b.size)
		stats.NewBytes += int64(b.size)
		if curBytes >= st.ShardTarget {
			groups = append(groups, cur)
			cur, curBytes = nil, 0
		}
	}
	if len(cur) > 0 {
		groups = append(groups, cur)
	}
	stats.NewBlobs = len(fresh)
	newIDs := make([]string, len(groups))
	var readNs, idxNs int64
	var mu sync.Mutex
	var firstErr error
	sem := make(chan struct{}, runtime.NumCPU())
	var wg sync.WaitGroup
	for gi, g := range groups {
		wg.Add(1)
		sem <- struct{}{}
		go func(gi int, g []nb) {
			defer wg.Done()
			defer func() { <-sem }()
			r0 := time.Now()
			ids := make([]BlobID, len(g))
			ext := map[BlobID]string{}
			for i, b := range g {
				ids[i] = b.id
				ext[b.id] = b.ext
			}
			blobs := make([]pendingBlob, 0, len(g))
			err := catFile(repo, ids, func(id BlobID, c []byte) {
				blobs = append(blobs, pendingBlob{ID: id, Content: c, Ext: ext[id]})
			})
			r1 := time.Now()
			var id string
			var ib, db int64
			if err == nil {
				id, ib, db, err = buildShard(filepath.Join(st.Dir, "shards"), blobs, st.Symbols)
			}
			mu.Lock()
			defer mu.Unlock()
			readNs += int64(r1.Sub(r0))
			idxNs += int64(time.Since(r1))
			if err != nil && firstErr == nil {
				firstErr = err
			}
			newIDs[gi] = id
			stats.IdxBytes += ib
			stats.DatBytes += db
			if fi, e := os.Stat(filepath.Join(st.Dir, "shards", id+".sym")); e == nil {
				stats.SymBytes += fi.Size()
			}
		}(gi, g)
	}
	wg.Wait()
	if firstErr != nil {
		return nil, firstErr
	}
	// read/index times are summed across workers; report them as wall-equivalent shares of the parallel phase.
	stats.ReadMs = float64(readNs) / 1e6
	stats.IndexMs = float64(idxNs) / 1e6
	stats.NewShards = len(newIDs)

	pf := filepath.Join(st.Dir, "paths", tree+".paths")
	if err := writePaths(pf, paths); err != nil {
		return nil, err
	}
	if fi, err := os.Stat(pf); err == nil {
		stats.PathsBytes = fi.Size()
	}
	var content int64
	for _, p := range paths {
		content += int64(p.Size)
	}
	m := Manifest{Tree: tree, Parents: parentTrees, Shards: append(keep, newIDs...), Files: len(paths),
		NewBlobs: len(fresh), NewShards: newIDs, ContentBytes: content}
	b, _ := json.MarshalIndent(m, "", " ")
	if err := writeAtomic(filepath.Join(st.Dir, "snaps", tree+".json"), b); err != nil {
		return nil, err
	}
	stats.TotalShards = len(m.Shards)
	stats.TotalMs = ms(time.Since(t0))
	return stats, nil
}

// Compact rewrites a snapshot's small shards (under limit content bytes) as one, keeping only its live blobs.
// Old shards stay for the snapshots that still name them; GC (reachability from refs) removes them later.
func (st *Store) Compact(name string, limit int64) (map[string]any, error) {
	t0 := time.Now()
	sn, err := st.Open(name)
	if err != nil {
		return nil, err
	}
	var keep []string
	var blobs []pendingBlob
	merged := 0
	for si, s := range sn.Shards {
		if int64(len(s.dat)) >= limit {
			keep = append(keep, s.ID)
			continue
		}
		merged++
		for o := 0; o < s.nBlob; o++ {
			if pi := sn.live[si][o]; pi >= 0 {
				blobs = append(blobs, pendingBlob{ID: s.blobID(o), Content: s.content(o), Ext: path.Ext(sn.Paths[pi].Path)})
			}
		}
	}
	if merged < 2 {
		return map[string]any{"merged": merged, "ms": ms(time.Since(t0))}, nil
	}
	sort.Slice(blobs, func(i, j int) bool { return bytes.Compare(blobs[i].ID[:], blobs[j].ID[:]) < 0 })
	id, ib, db, err := buildShard(filepath.Join(st.Dir, "shards"), blobs, st.Symbols)
	if err != nil {
		return nil, err
	}
	m := sn.M
	m.Shards = append(keep, id)
	b, _ := json.MarshalIndent(m, "", " ")
	if err := writeAtomic(filepath.Join(st.Dir, "snaps", m.Tree+".json"), b); err != nil {
		return nil, err
	}
	st.mu.Lock()
	delete(st.snaps, m.Tree)
	st.mu.Unlock()
	return map[string]any{"merged": merged, "blobs": len(blobs), "idxBytes": ib, "datBytes": db, "shards": len(m.Shards), "ms": ms(time.Since(t0))}, nil
}
