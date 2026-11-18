package repo

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/store"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/workdisk"
)

type Engine struct {
	store store.Store
	vm    VMCoordinator
	disks *workdisk.Disks
	nowFn func() time.Time
}

func NewEngine(st store.Store, nowFn func() time.Time) *Engine {
	if nowFn == nil {
		nowFn = time.Now
	}
	return &Engine{
		store: st,
		nowFn: nowFn,
	}
}

func (e *Engine) SetVMCoordinator(vm VMCoordinator) {
	e.vm = vm
}

func (e *Engine) nowMs() int64 {
	return e.nowFn().UnixMilli()
}

func (e *Engine) PutBlob(ctx context.Context, lineage string, data []byte) (string, error) {
	return e.store.PutObject(ctx, lineage, store.KindBlob, data)
}

func (e *Engine) GetBlob(ctx context.Context, hash string) ([]byte, error) {
	kind, data, err := e.store.GetObject(ctx, hash)
	if err != nil {
		return nil, err
	}
	if kind != store.KindBlob {
		return nil, apperr.Internal(fmt.Sprintf("expected blob object for %s, got %s", hash, kind), nil)
	}
	return data, nil
}

func (e *Engine) PutTree(ctx context.Context, lineage string, entries []TreeEntry) (string, error) {
	canonical := make([]TreeEntry, 0, len(entries))
	for _, ent := range entries {
		if ent.Type == "" {
			ent.Type = "file"
		}
		if ent.Mode == 0 {
			ent.Mode = DefaultFileMode
		}
		canonical = append(canonical, ent)
	}
	sort.Slice(canonical, func(i, j int) bool { return canonical[i].Path < canonical[j].Path })
	raw, err := json.Marshal(canonical)
	if err != nil {
		return "", apperr.Internal("marshal tree", err)
	}
	return e.store.PutObject(ctx, lineage, store.KindTree, raw)
}

func (e *Engine) PutTreeMap(ctx context.Context, lineage string, m map[string]TreeEntry) (string, error) {
	entries := make([]TreeEntry, 0, len(m))
	for _, ent := range m {
		entries = append(entries, ent)
	}
	return e.PutTree(ctx, lineage, entries)
}

func (e *Engine) GetTree(ctx context.Context, hash string) ([]TreeEntry, error) {
	kind, data, err := e.store.GetObject(ctx, hash)
	if err != nil {
		return nil, err
	}
	if kind != store.KindTree {
		return nil, apperr.Internal(fmt.Sprintf("expected tree object for %s, got %s", hash, kind), nil)
	}
	var entries []TreeEntry
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, apperr.Internal("unmarshal tree", err)
	}
	if entries == nil {
		entries = []TreeEntry{}
	}
	return entries, nil
}

func (e *Engine) GetTreeMap(ctx context.Context, hash string) (map[string]TreeEntry, error) {
	entries, err := e.GetTree(ctx, hash)
	if err != nil {
		return nil, err
	}
	out := make(map[string]TreeEntry, len(entries))
	for _, ent := range entries {
		out[ent.Path] = ent
	}
	return out, nil
}

func (e *Engine) PutCommit(ctx context.Context, lineage string, c CommitObject) (string, error) {
	if e.disks != nil && c.Disk == "" {
		var err error
		c.Disk, err = e.prepareDisk(ctx, lineage, c)
		if err != nil {
			return "", err
		}
	}
	if c.Parents == nil {
		c.Parents = []string{}
	}
	raw, err := json.Marshal(c)
	if err != nil {
		return "", apperr.Internal("marshal commit", err)
	}
	return e.store.PutObject(ctx, lineage, store.KindCommit, raw)
}

func (e *Engine) GetCommit(ctx context.Context, hash string) (*CommitObject, error) {
	kind, data, err := e.store.GetObject(ctx, hash)
	if err != nil {
		return nil, err
	}
	if kind != store.KindCommit {
		return nil, apperr.NotFoundf("commit %q not found", hash)
	}
	var c CommitObject
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, apperr.Internal("unmarshal commit", err)
	}
	if c.Parents == nil {
		c.Parents = []string{}
	}
	return &c, nil
}

// ResolveCommit resolves a ref name ("refs/heads/main"), short branch ("main"), or commit SHA-256.
func (e *Engine) ResolveCommit(ctx context.Context, lineage, refOrCommit string) (string, *CommitObject, error) {
	if _, err := e.store.GetLineage(ctx, lineage); err != nil {
		return "", nil, err
	}
	target := strings.TrimSpace(refOrCommit)
	if target == "" {
		target = DefaultRef
	}
	now := e.nowMs()

	if r, err := e.store.GetRef(ctx, lineage, target, now); err == nil && r != nil {
		c, err := e.GetCommit(ctx, r.Commit)
		if err != nil {
			return "", nil, err
		}
		return r.Commit, c, nil
	}
	if !strings.HasPrefix(target, "refs/") {
		if r, err := e.store.GetRef(ctx, lineage, "refs/heads/"+target, now); err == nil && r != nil {
			c, err := e.GetCommit(ctx, r.Commit)
			if err != nil {
				return "", nil, err
			}
			return r.Commit, c, nil
		}
	}
	if len(target) == 64 {
		if c, err := e.GetCommit(ctx, target); err == nil && c != nil {
			return target, c, nil
		}
	}
	return "", nil, apperr.NotFoundf("ref or commit %q not found in lineage %q", target, lineage)
}

func (e *Engine) withRefLock(ctx context.Context, lineage, ref, holder string, fn func(vmSession ActiveVMSession) error) error {
	if e.vm != nil {
		return e.vm.WithRefWriteLock(ctx, lineage, ref, holder, fn)
	}
	return fn(nil)
}

// CreateLineage creates or ensures a lineage with an initial empty commit on refs/heads/main.
func (e *Engine) CreateLineage(ctx context.Context, req CreateLineageRequest) (*CreateLineageResponse, error) {
	lineage := strings.TrimSpace(req.Lineage)
	if lineage == "" {
		lineage = store.RandomID("lin")
	}
	if strings.Contains(lineage, "/") {
		return nil, apperr.InvalidRequest("lineage id must not contain '/'")
	}
	tenant := strings.TrimSpace(req.TenantID)
	if tenant == "" {
		tenant = "default"
	}

	// Fast path if lineage already exists.
	if existing, err := e.store.GetLineage(ctx, lineage); err == nil && existing != nil {
		ref, err := e.store.GetRef(ctx, lineage, existing.DefaultRef, e.nowMs())
		if err != nil {
			return nil, err
		}
		return &CreateLineageResponse{
			Lineage:    existing.Lineage,
			DefaultRef: existing.DefaultRef,
			Commit:     ref.Commit,
			Tree:       ref.Tree,
		}, nil
	}

	now := e.nowMs()
	emptyTree, err := e.PutTree(ctx, lineage, nil)
	if err != nil {
		return nil, err
	}
	initCommit, err := e.PutCommit(ctx, lineage, CommitObject{
		Tree:      emptyTree,
		Parents:   []string{},
		Author:    "system",
		Message:   "initial commit",
		CreatedAt: now,
	})
	if err != nil {
		return nil, err
	}

	linRec, refRec, _, err := e.store.CreateLineageIfAbsent(
		ctx,
		store.LineageRecord{
			Lineage:    lineage,
			TenantID:   tenant,
			DefaultRef: DefaultRef,
			CreatedAt:  now,
		},
		store.RefRecord{
			Lineage:   lineage,
			Name:      DefaultRef,
			Commit:    initCommit,
			Tree:      emptyTree,
			UpdatedAt: now,
		},
	)
	if err != nil {
		return nil, err
	}

	return &CreateLineageResponse{
		Lineage:    linRec.Lineage,
		DefaultRef: linRec.DefaultRef,
		Commit:     refRec.Commit,
		Tree:       refRec.Tree,
	}, nil
}

// DeleteLineage stops active VMs on the lineage and purges its refs and unreferenced objects.
func (e *Engine) DeleteLineage(ctx context.Context, lineage string) error {
	if _, err := e.store.GetLineage(ctx, lineage); err != nil {
		return err
	}
	if e.vm != nil {
		if err := e.vm.StopLineageVMs(ctx, lineage); err != nil {
			return err
		}
	}
	return e.store.DeleteLineage(ctx, lineage)
}

func (e *Engine) collectReachableObjects(ctx context.Context, rootCommit string) ([]string, error) {
	seenCommits := map[string]bool{}
	seenObjects := map[string]bool{}
	queue := []string{rootCommit}

	for len(queue) > 0 {
		ch := queue[0]
		queue = queue[1:]
		if ch == "" || seenCommits[ch] {
			continue
		}
		seenCommits[ch] = true
		seenObjects[ch] = true

		c, err := e.GetCommit(ctx, ch)
		if err != nil {
			return nil, err
		}
		if c.Disk != "" && !seenObjects[c.Disk] {
			if e.disks == nil {
				return nil, apperr.Internal("workspace disk storage is disabled", nil)
			}
			hashes, err := e.disks.Reachable(ctx, c.Disk)
			if err != nil {
				return nil, err
			}
			for _, hash := range hashes {
				seenObjects[hash] = true
			}
		}
		if !seenObjects[c.Tree] {
			seenObjects[c.Tree] = true
			entries, err := e.GetTree(ctx, c.Tree)
			if err != nil {
				return nil, err
			}
			for _, ent := range entries {
				if ent.Hash != "" {
					seenObjects[ent.Hash] = true
				}
			}
		}
		for _, p := range c.Parents {
			if !seenCommits[p] {
				queue = append(queue, p)
			}
		}
	}

	out := make([]string, 0, len(seenObjects))
	for h := range seenObjects {
		out = append(out, h)
	}
	return out, nil
}

// ForkLineage initializes targetLineage from sourceRef or atCommit on sourceLineage.
func (e *Engine) ForkLineage(ctx context.Context, sourceLineage string, tenantID string, req ForkRequest) (*ForkResponse, error) {
	srcLin, err := e.store.GetLineage(ctx, sourceLineage)
	if err != nil {
		return nil, err
	}

	targetLineage := strings.TrimSpace(req.TargetLineage)
	if targetLineage == "" {
		targetLineage = store.RandomID("lin")
	}
	if strings.Contains(targetLineage, "/") {
		return nil, apperr.InvalidRequest("targetLineage must not contain '/'")
	}
	if _, err := e.store.GetLineage(ctx, targetLineage); err == nil {
		return nil, apperr.CASConflictf("target lineage %q already exists", targetLineage)
	}

	sourceRef := strings.TrimSpace(req.SourceRef)
	if sourceRef == "" {
		sourceRef = DefaultRef
	}
	targetRef := strings.TrimSpace(req.TargetRef)
	if targetRef == "" {
		targetRef = DefaultRef
	}

	var commitHash string
	var commitObj *CommitObject
	if strings.TrimSpace(req.AtCommit) != "" {
		commitHash, commitObj, err = e.ResolveCommit(ctx, sourceLineage, req.AtCommit)
	} else {
		commitHash, commitObj, err = e.ResolveCommit(ctx, sourceLineage, sourceRef)
	}
	if err != nil {
		return nil, err
	}

	reachable, err := e.collectReachableObjects(ctx, commitHash)
	if err != nil {
		return nil, err
	}

	if tenantID == "" {
		tenantID = srcLin.TenantID
	}
	now := e.nowMs()
	defaultRef := DefaultRef
	if targetRef != "" {
		defaultRef = targetRef
	}

	_, _, created, err := e.store.CreateLineageIfAbsent(
		ctx,
		store.LineageRecord{
			Lineage:    targetLineage,
			TenantID:   tenantID,
			DefaultRef: defaultRef,
			CreatedAt:  now,
		},
		store.RefRecord{
			Lineage:   targetLineage,
			Name:      targetRef,
			Commit:    commitHash,
			Tree:      commitObj.Tree,
			UpdatedAt: now,
		},
	)
	if err != nil {
		return nil, err
	}
	if !created {
		return nil, apperr.CASConflictf("target lineage %q already exists", targetLineage)
	}

	if err := e.store.LinkObjects(ctx, targetLineage, reachable); err != nil {
		return nil, err
	}

	return &ForkResponse{
		Lineage: targetLineage,
		Ref:     targetRef,
		Commit:  commitHash,
		Tree:    commitObj.Tree,
	}, nil
}

func (e *Engine) ListRefs(ctx context.Context, lineage, prefix string) ([]store.RefRecord, error) {
	return e.store.ListRefs(ctx, lineage, prefix, e.nowMs())
}

func (e *Engine) SetRef(ctx context.Context, lineage string, req SetRefRequest) (*SetRefResponse, error) {
	refName := strings.TrimSpace(req.Ref)
	if refName == "" {
		return nil, apperr.InvalidRequest("ref is required")
	}

	var treeHash string
	if !req.Delete {
		if strings.TrimSpace(req.Commit) == "" {
			return nil, apperr.InvalidRequest("commit is required when not deleting ref")
		}
		c, err := e.GetCommit(ctx, req.Commit)
		if err != nil {
			return nil, err
		}
		treeHash = c.Tree
	}

	var res *store.RefRecord
	err := e.withRefLock(ctx, lineage, refName, req.Holder, func(vmSession ActiveVMSession) error {
		var err error
		res, err = e.store.SetRef(ctx, store.SetRefParams{
			Lineage:        lineage,
			Ref:            refName,
			Commit:         req.Commit,
			Tree:           treeHash,
			ExpectedCommit: req.ExpectedCommit,
			Holder:         req.Holder,
			Delete:         req.Delete,
			NowMs:          e.nowMs(),
		})
		if err != nil {
			return err
		}
		if vmSession != nil && !req.Delete {
			files, err := e.loadMaterializedTree(ctx, treeHash)
			if err != nil {
				return err
			}
			if err := vmSession.ReplaceTree(ctx, files, req.Commit); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}

	return &SetRefResponse{
		Ref:    res.Name,
		Commit: res.Commit,
		Tree:   res.Tree,
	}, nil
}

func (e *Engine) LeaseRef(ctx context.Context, lineage string, req LeaseRequest) (*store.LeaseResult, error) {
	refName := strings.TrimSpace(req.Ref)
	if refName == "" {
		refName = DefaultRef
	}
	holder := strings.TrimSpace(req.Holder)
	if holder == "" {
		return nil, apperr.InvalidRequest("holder is required")
	}
	ttl := req.TTLMs
	if ttl <= 0 {
		ttl = 600_000
	}
	return e.store.LeaseRef(ctx, store.LeaseRefParams{
		Lineage: lineage,
		Ref:     refName,
		Holder:  holder,
		TTLMs:   ttl,
		Release: req.Release,
		NowMs:   e.nowMs(),
	})
}

func decodePutPayload(p WritePut) ([]byte, error) {
	if p.Base64 != "" {
		raw := strings.TrimSpace(p.Base64)
		if b, err := base64.StdEncoding.DecodeString(raw); err == nil {
			return b, nil
		}
		if b, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(raw, "=")); err == nil {
			return b, nil
		}
		return nil, apperr.InvalidRequestf("invalid base64 payload for path %q", p.Path)
	}
	return []byte(p.Content), nil
}

// Write applies puts/deletes/moves atomically to ref, syncing any active VM owned by holder.
func (e *Engine) Write(ctx context.Context, lineage string, req WriteRequest) (*WriteResponse, error) {
	refName := strings.TrimSpace(req.Ref)
	if refName == "" {
		refName = DefaultRef
	}
	author := strings.TrimSpace(req.Author)
	if author == "" {
		if req.Holder != "" {
			author = "agent:" + req.Holder
		} else {
			author = "system"
		}
	}
	msg := strings.TrimSpace(req.Message)
	if msg == "" {
		msg = "write"
	}

	// Pre-validate and decode payloads before acquiring locks.
	type decodedPut struct {
		path string
		data []byte
		mode int
	}
	puts := make([]decodedPut, 0, len(req.Puts))
	for _, p := range req.Puts {
		normPath, err := NormalizeRelPath(p.Path, false)
		if err != nil {
			return nil, err
		}
		data, err := decodePutPayload(p)
		if err != nil {
			return nil, err
		}
		mode := p.Mode
		if mode == 0 {
			mode = DefaultFileMode
		}
		puts = append(puts, decodedPut{path: normPath, data: data, mode: mode})
	}

	deletes := make([]string, 0, len(req.Deletes))
	for _, d := range req.Deletes {
		normPath, err := NormalizeRelPath(d, false)
		if err != nil {
			return nil, err
		}
		deletes = append(deletes, normPath)
	}

	type normMove struct {
		from string
		to   string
	}
	moves := make([]normMove, 0, len(req.Moves))
	for _, m := range req.Moves {
		fromPath, err := NormalizeRelPath(m.From, false)
		if err != nil {
			return nil, err
		}
		toPath, err := NormalizeRelPath(m.To, false)
		if err != nil {
			return nil, err
		}
		moves = append(moves, normMove{from: fromPath, to: toPath})
	}

	var out WriteResponse
	err := e.withRefLock(ctx, lineage, refName, req.Holder, func(vmSession ActiveVMSession) error {
		now := e.nowMs()
		curRef, err := e.store.GetRef(ctx, lineage, refName, now)
		if err != nil {
			return err
		}
		if curRef.Lease != nil && curRef.Lease.Holder != req.Holder {
			return apperr.RefLeasedf("ref %q is leased by %q", refName, curRef.Lease.Holder)
		}
		if req.ExpectedCommit != "" && curRef.Commit != req.ExpectedCommit {
			return apperr.CASConflictf("expected commit %q on ref %q, got %q", req.ExpectedCommit, refName, curRef.Commit)
		}

		treeMap, err := e.GetTreeMap(ctx, curRef.Tree)
		if err != nil {
			return err
		}

		var vmOps []WorkspaceFileOp
		for _, mv := range moves {
			srcEnt, ok := treeMap[mv.from]
			if !ok {
				return apperr.NotFoundf("move source %q does not exist", mv.from)
			}
			delete(treeMap, mv.from)
			srcEnt.Path = mv.to
			treeMap[mv.to] = srcEnt
			vmOps = append(vmOps, WorkspaceFileOp{Kind: "move", From: mv.from, Path: mv.to})
		}

		for _, delPath := range deletes {
			delete(treeMap, delPath)
			vmOps = append(vmOps, WorkspaceFileOp{Kind: "delete", Path: delPath})
		}

		var totalBytes int64
		for _, put := range puts {
			blobHash, err := e.PutBlob(ctx, lineage, put.data)
			if err != nil {
				return err
			}
			totalBytes += int64(len(put.data))
			treeMap[put.path] = TreeEntry{
				Path: put.path,
				Type: "file",
				Size: int64(len(put.data)),
				Mode: put.mode,
				Hash: blobHash,
			}
			vmOps = append(vmOps, WorkspaceFileOp{
				Kind: "put",
				Path: put.path,
				Data: put.data,
				Mode: put.mode,
			})
		}

		// Deterministic changed list preserving request order (puts, deletes, moves).
		changed := make([]string, 0, len(puts)+len(deletes)+2*len(moves))
		seenChanged := map[string]bool{}
		addChanged := func(p string) {
			if !seenChanged[p] {
				seenChanged[p] = true
				changed = append(changed, p)
			}
		}
		for _, p := range puts {
			addChanged(p.path)
		}
		for _, d := range deletes {
			addChanged(d)
		}
		for _, m := range moves {
			addChanged(m.from)
			addChanged(m.to)
		}

		newTreeHash, err := e.PutTreeMap(ctx, lineage, treeMap)
		if err != nil {
			return err
		}
		newCommitHash, err := e.PutCommit(ctx, lineage, CommitObject{
			Tree:      newTreeHash,
			Parents:   []string{curRef.Commit},
			Author:    author,
			Message:   msg,
			CreatedAt: now,
		})
		if err != nil {
			return err
		}

		if vmSession != nil {
			if err := vmSession.ApplyOps(ctx, vmOps, newCommitHash); err != nil {
				return err
			}
		}

		_, err = e.store.SetRef(ctx, store.SetRefParams{
			Lineage:        lineage,
			Ref:            refName,
			Commit:         newCommitHash,
			Tree:           newTreeHash,
			ExpectedCommit: curRef.Commit,
			Holder:         req.Holder,
			NowMs:          now,
		})
		if err != nil {
			return err
		}

		out = WriteResponse{
			Commit:     newCommitHash,
			Tree:       newTreeHash,
			Changed:    changed,
			TotalBytes: totalBytes,
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// Read reads a file at a ref or commit with byte offset & limit and binary detection.
func (e *Engine) Read(ctx context.Context, lineage string, p ReadParams) (*ReadResponse, error) {
	normPath, err := NormalizeRelPath(p.Path, false)
	if err != nil {
		return nil, err
	}
	if p.Offset < 0 {
		return nil, apperr.InvalidRequest("offset must be >= 0")
	}

	commitHash, commitObj, err := e.ResolveCommit(ctx, lineage, p.At)
	if err != nil {
		return nil, err
	}
	treeMap, err := e.GetTreeMap(ctx, commitObj.Tree)
	if err != nil {
		return nil, err
	}
	ent, ok := treeMap[normPath]
	if !ok {
		return nil, apperr.NotFoundf("path %q not found at %q", normPath, commitHash)
	}

	data, err := e.GetBlob(ctx, ent.Hash)
	if err != nil {
		return nil, err
	}
	fullSize := int64(len(data))
	binary := IsBinary(data)

	start := p.Offset
	if start > fullSize {
		start = fullSize
	}
	end := fullSize
	if p.Limit > 0 && start+p.Limit < end {
		end = start + p.Limit
	}
	slice := data[start:end]

	resp := &ReadResponse{
		Commit: commitHash,
		Path:   normPath,
		Size:   fullSize,
		Mode:   ent.Mode,
		Binary: binary,
	}
	if binary {
		b64 := base64.StdEncoding.EncodeToString(slice)
		resp.Base64 = &b64
	} else {
		str := string(slice)
		resp.Content = &str
	}
	return resp, nil
}

// ListEntries implements ls with path prefix, recursive flag, and glob filtering.
func (e *Engine) ListEntries(ctx context.Context, lineage string, p ListParams) (*ListResponse, error) {
	normDir, err := NormalizeRelPath(p.Path, true)
	if err != nil {
		return nil, err
	}
	var globRE *regexp.Regexp
	if strings.TrimSpace(p.Glob) != "" {
		globRE, err = CompileGlob(p.Glob)
		if err != nil {
			return nil, apperr.InvalidRequestf("invalid glob %q: %v", p.Glob, err)
		}
	}

	commitHash, commitObj, err := e.ResolveCommit(ctx, lineage, p.At)
	if err != nil {
		return nil, err
	}
	entries, err := e.GetTree(ctx, commitObj.Tree)
	if err != nil {
		return nil, err
	}

	matchesGlob := func(entryPath string) bool {
		if globRE == nil {
			return true
		}
		if globRE.MatchString(entryPath) {
			return true
		}
		if normDir != "" && strings.HasPrefix(entryPath, normDir+"/") {
			rel := strings.TrimPrefix(entryPath, normDir+"/")
			if globRE.MatchString(rel) {
				return true
			}
		}
		return false
	}

	// If path names an exact single file, return it if it matches glob.
	if normDir != "" {
		for _, ent := range entries {
			if ent.Path == normDir {
				out := []TreeEntry{}
				if matchesGlob(ent.Path) {
					out = append(out, ent)
				}
				return &ListResponse{Commit: commitHash, Entries: out}, nil
			}
		}
	}

	prefix := ""
	if normDir != "" {
		prefix = normDir + "/"
	}

	out := make([]TreeEntry, 0)
	if p.Recursive {
		for _, ent := range entries {
			if prefix != "" && !strings.HasPrefix(ent.Path, prefix) {
				continue
			}
			if matchesGlob(ent.Path) {
				out = append(out, ent)
			}
		}
	} else {
		seenDirs := map[string]bool{}
		for _, ent := range entries {
			if prefix != "" && !strings.HasPrefix(ent.Path, prefix) {
				continue
			}
			rel := strings.TrimPrefix(ent.Path, prefix)
			if slash := strings.IndexByte(rel, '/'); slash >= 0 {
				dirName := rel[:slash]
				dirPath := dirName
				if prefix != "" {
					dirPath = prefix + dirName
				}
				if !seenDirs[dirPath] {
					seenDirs[dirPath] = true
					if matchesGlob(dirPath) {
						out = append(out, TreeEntry{
							Path: dirPath,
							Type: "dir",
							Size: 0,
							Mode: ExecFileMode,
							Hash: "",
						})
					}
				}
			} else if matchesGlob(ent.Path) {
				out = append(out, ent)
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	}

	return &ListResponse{
		Commit:  commitHash,
		Entries: out,
	}, nil
}

// Grep searches text blobs at ref/commit using regular expressions.
func (e *Engine) Grep(ctx context.Context, lineage string, req GrepRequest) (*GrepResponse, error) {
	if req.Pattern == "" {
		return nil, apperr.InvalidRequest("pattern is required")
	}
	re, err := regexp.Compile(req.Pattern)
	if err != nil {
		return nil, apperr.InvalidRequestf("invalid regex pattern: %v", err)
	}

	prefix, err := NormalizeRelPath(req.PathPrefix, true)
	if err != nil {
		return nil, err
	}
	// Preserve directory prefix semantics if caller passed "src/".
	rawTrimmed := strings.TrimSpace(req.PathPrefix)
	dirOnly := strings.HasSuffix(rawTrimmed, "/") && prefix != ""

	maxMatches := req.MaxMatches
	if maxMatches <= 0 {
		maxMatches = 100
	}

	commitHash, commitObj, err := e.ResolveCommit(ctx, lineage, req.At)
	if err != nil {
		return nil, err
	}
	entries, err := e.GetTree(ctx, commitObj.Tree)
	if err != nil {
		return nil, err
	}

	matches := make([]GrepMatch, 0)
	for _, ent := range entries {
		if prefix != "" {
			if dirOnly {
				if !strings.HasPrefix(ent.Path, prefix+"/") {
					continue
				}
			} else if ent.Path != prefix && !strings.HasPrefix(ent.Path, prefix+"/") && !strings.HasPrefix(ent.Path, prefix) {
				continue
			}
		}

		data, err := e.GetBlob(ctx, ent.Hash)
		if err != nil {
			return nil, err
		}
		if IsBinary(data) {
			continue
		}

		lines := strings.Split(string(data), "\n")
		// Drop trailing empty element from final newline.
		if len(lines) > 0 && lines[len(lines)-1] == "" && strings.HasSuffix(string(data), "\n") {
			lines = lines[:len(lines)-1]
		}
		for lineIdx, line := range lines {
			cleanLine := strings.TrimSuffix(line, "\r")
			loc := re.FindStringIndex(cleanLine)
			if loc != nil {
				matches = append(matches, GrepMatch{
					Path:   ent.Path,
					Line:   lineIdx + 1,
					Column: loc[0] + 1,
					Text:   cleanLine,
				})
				if len(matches) >= maxMatches {
					return &GrepResponse{Commit: commitHash, Matches: matches}, nil
				}
			}
		}
	}

	return &GrepResponse{
		Commit:  commitHash,
		Matches: matches,
	}, nil
}

// History walks commits reachable from ref up to limit.
func (e *Engine) History(ctx context.Context, lineage, ref string, limit int) (*HistoryResponse, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 1000 {
		limit = 1000
	}
	startHash, _, err := e.ResolveCommit(ctx, lineage, ref)
	if err != nil {
		return nil, err
	}

	commits := make([]HistoryCommit, 0)
	visited := map[string]bool{}
	queue := []string{startHash}

	for len(queue) > 0 && len(commits) < limit {
		// Pick the commit in queue with highest CreatedAt for clean merge history ordering.
		bestIdx := 0
		var bestCommit *CommitObject
		for idx, h := range queue {
			c, err := e.GetCommit(ctx, h)
			if err != nil {
				return nil, err
			}
			if bestCommit == nil || c.CreatedAt > bestCommit.CreatedAt {
				bestIdx = idx
				bestCommit = c
			}
		}
		curHash := queue[bestIdx]
		queue = append(queue[:bestIdx], queue[bestIdx+1:]...)
		if visited[curHash] {
			continue
		}
		visited[curHash] = true

		commits = append(commits, HistoryCommit{
			Commit:    curHash,
			Tree:      bestCommit.Tree,
			Parents:   bestCommit.Parents,
			Author:    bestCommit.Author,
			Message:   bestCommit.Message,
			CreatedAt: bestCommit.CreatedAt,
		})
		for _, p := range bestCommit.Parents {
			if !visited[p] {
				queue = append(queue, p)
			}
		}
	}

	return &HistoryResponse{Commits: commits}, nil
}

// Diff computes file-level and unified line-level diffs between from and to.
func (e *Engine) Diff(ctx context.Context, lineage, fromRef, toRef string) (*DiffResponse, error) {
	if strings.TrimSpace(toRef) == "" {
		toRef = DefaultRef
	}
	toHash, toCommit, err := e.ResolveCommit(ctx, lineage, toRef)
	if err != nil {
		return nil, err
	}

	var fromHash string
	var fromTree map[string]TreeEntry
	if strings.TrimSpace(fromRef) == "" {
		if len(toCommit.Parents) > 0 {
			fromHash = toCommit.Parents[0]
			fc, err := e.GetCommit(ctx, fromHash)
			if err != nil {
				return nil, err
			}
			fromTree, err = e.GetTreeMap(ctx, fc.Tree)
			if err != nil {
				return nil, err
			}
		} else {
			fromHash = ""
			fromTree = map[string]TreeEntry{}
		}
	} else {
		var fc *CommitObject
		fromHash, fc, err = e.ResolveCommit(ctx, lineage, fromRef)
		if err != nil {
			return nil, err
		}
		fromTree, err = e.GetTreeMap(ctx, fc.Tree)
		if err != nil {
			return nil, err
		}
	}

	toTree, err := e.GetTreeMap(ctx, toCommit.Tree)
	if err != nil {
		return nil, err
	}

	pathSet := map[string]bool{}
	for p := range fromTree {
		pathSet[p] = true
	}
	for p := range toTree {
		pathSet[p] = true
	}
	paths := make([]string, 0, len(pathSet))
	for p := range pathSet {
		paths = append(paths, p)
	}
	sort.Strings(paths)

	changes := make([]DiffChange, 0)
	for _, p := range paths {
		oldEnt, inOld := fromTree[p]
		newEnt, inNew := toTree[p]

		switch {
		case !inOld && inNew:
			newBytes, err := e.GetBlob(ctx, newEnt.Hash)
			if err != nil {
				return nil, err
			}
			changes = append(changes, DiffChange{
				Path:    p,
				Kind:    "added",
				OldHash: "",
				NewHash: newEnt.Hash,
				Patch:   UnifiedPatch(nil, newBytes),
			})
		case inOld && !inNew:
			oldBytes, err := e.GetBlob(ctx, oldEnt.Hash)
			if err != nil {
				return nil, err
			}
			changes = append(changes, DiffChange{
				Path:    p,
				Kind:    "deleted",
				OldHash: oldEnt.Hash,
				NewHash: "",
				Patch:   UnifiedPatch(oldBytes, nil),
			})
		case inOld && inNew && (oldEnt.Hash != newEnt.Hash || oldEnt.Mode != newEnt.Mode):
			oldBytes, err := e.GetBlob(ctx, oldEnt.Hash)
			if err != nil {
				return nil, err
			}
			newBytes, err := e.GetBlob(ctx, newEnt.Hash)
			if err != nil {
				return nil, err
			}
			changes = append(changes, DiffChange{
				Path:    p,
				Kind:    "modified",
				OldHash: oldEnt.Hash,
				NewHash: newEnt.Hash,
				Patch:   UnifiedPatch(oldBytes, newBytes),
			})
		}
	}

	return &DiffResponse{
		FromCommit: fromHash,
		ToCommit:   toHash,
		Changes:    changes,
	}, nil
}

// Restore creates a new commit on ref restoring targetCommit's tree, syncing any active VM.
func (e *Engine) Restore(ctx context.Context, lineage string, req RestoreRequest) (*RestoreResponse, error) {
	refName := strings.TrimSpace(req.Ref)
	if refName == "" {
		refName = DefaultRef
	}
	if strings.TrimSpace(req.TargetCommit) == "" {
		return nil, apperr.InvalidRequest("targetCommit is required")
	}
	_, targetObj, err := e.ResolveCommit(ctx, lineage, req.TargetCommit)
	if err != nil {
		return nil, err
	}

	author := strings.TrimSpace(req.Author)
	if author == "" {
		author = "system"
	}
	msg := strings.TrimSpace(req.Message)
	if msg == "" {
		msg = "restore"
	}

	var out RestoreResponse
	err = e.withRefLock(ctx, lineage, refName, req.Holder, func(vmSession ActiveVMSession) error {
		now := e.nowMs()
		curRef, err := e.store.GetRef(ctx, lineage, refName, now)
		if err != nil {
			return err
		}
		if curRef.Lease != nil && curRef.Lease.Holder != req.Holder {
			return apperr.RefLeasedf("ref %q is leased by %q", refName, curRef.Lease.Holder)
		}

		newCommit, err := e.PutCommit(ctx, lineage, CommitObject{
			Tree:      targetObj.Tree,
			Disk:      targetObj.Disk,
			Parents:   []string{curRef.Commit},
			Author:    author,
			Message:   msg,
			CreatedAt: now,
		})
		if err != nil {
			return err
		}

		if vmSession != nil {
			files, err := e.loadMaterializedTree(ctx, targetObj.Tree)
			if err != nil {
				return err
			}
			if err := vmSession.ReplaceTree(ctx, files, newCommit); err != nil {
				return err
			}
		}

		_, err = e.store.SetRef(ctx, store.SetRefParams{
			Lineage:        lineage,
			Ref:            refName,
			Commit:         newCommit,
			Tree:           targetObj.Tree,
			ExpectedCommit: curRef.Commit,
			Holder:         req.Holder,
			NowMs:          now,
		})
		if err != nil {
			return err
		}
		out = RestoreResponse{Commit: newCommit, Tree: targetObj.Tree}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// findLCA finds the nearest common ancestor commit between c1 and c2 via BFS.
func (e *Engine) findLCA(ctx context.Context, c1, c2 string) (string, error) {
	if c1 == c2 {
		return c1, nil
	}
	anc1 := map[string]int{}
	q1 := []string{c1}
	depth := 0
	for len(q1) > 0 {
		next := []string{}
		for _, h := range q1 {
			if _, seen := anc1[h]; seen {
				continue
			}
			anc1[h] = depth
			c, err := e.GetCommit(ctx, h)
			if err != nil {
				return "", err
			}
			next = append(next, c.Parents...)
		}
		q1 = next
		depth++
	}

	visited2 := map[string]bool{}
	q2 := []string{c2}
	for len(q2) > 0 {
		h := q2[0]
		q2 = q2[1:]
		if visited2[h] {
			continue
		}
		visited2[h] = true
		if _, ok := anc1[h]; ok {
			return h, nil
		}
		c, err := e.GetCommit(ctx, h)
		if err != nil {
			return "", err
		}
		q2 = append(q2, c.Parents...)
	}
	return "", nil
}

// Merge merges sourceRef into targetRef using ff-only, squash, or three-way merge.
func (e *Engine) Merge(ctx context.Context, lineage string, req MergeRequest) (*MergeResponse, error) {
	sourceRef := strings.TrimSpace(req.SourceRef)
	if sourceRef == "" {
		return nil, apperr.InvalidRequest("sourceRef is required")
	}
	targetRef := strings.TrimSpace(req.TargetRef)
	if targetRef == "" {
		targetRef = DefaultRef
	}
	strategy := strings.TrimSpace(req.Strategy)
	if strategy == "" {
		strategy = "three-way"
	}
	if strategy != "three-way" && strategy != "ff-only" && strategy != "squash" {
		return nil, apperr.InvalidRequestf("unsupported merge strategy %q", strategy)
	}
	author := strings.TrimSpace(req.Author)
	if author == "" {
		author = "system"
	}
	msg := strings.TrimSpace(req.Message)
	if msg == "" {
		msg = fmt.Sprintf("merge %s into %s", sourceRef, targetRef)
	}

	var out MergeResponse
	err := e.withRefLock(ctx, lineage, targetRef, req.Holder, func(vmSession ActiveVMSession) error {
		now := e.nowMs()
		tgtRefRec, err := e.store.GetRef(ctx, lineage, targetRef, now)
		if err != nil {
			return err
		}
		if tgtRefRec.Lease != nil && tgtRefRec.Lease.Holder != req.Holder {
			return apperr.RefLeasedf("target ref %q is leased by %q", targetRef, tgtRefRec.Lease.Holder)
		}

		srcCommitHash, srcCommitObj, err := e.ResolveCommit(ctx, lineage, sourceRef)
		if err != nil {
			return err
		}
		tgtCommitHash := tgtRefRec.Commit
		tgtCommitObj, err := e.GetCommit(ctx, tgtCommitHash)
		if err != nil {
			return err
		}

		if srcCommitHash == tgtCommitHash {
			out = MergeResponse{Commit: tgtCommitHash, Tree: tgtCommitObj.Tree, Conflicts: []string{}}
			return nil
		}

		lcaHash, err := e.findLCA(ctx, tgtCommitHash, srcCommitHash)
		if err != nil {
			return err
		}
		if lcaHash == srcCommitHash {
			// Target already contains all of source.
			out = MergeResponse{Commit: tgtCommitHash, Tree: tgtCommitObj.Tree, Conflicts: []string{}}
			return nil
		}

		if strategy == "ff-only" {
			if lcaHash != tgtCommitHash {
				return apperr.CASConflict("cannot fast-forward: target has diverged from source")
			}
			if vmSession != nil {
				files, err := e.loadMaterializedTree(ctx, srcCommitObj.Tree)
				if err != nil {
					return err
				}
				if err := vmSession.ReplaceTree(ctx, files, srcCommitHash); err != nil {
					return err
				}
			}
			_, err = e.store.SetRef(ctx, store.SetRefParams{
				Lineage:        lineage,
				Ref:            targetRef,
				Commit:         srcCommitHash,
				Tree:           srcCommitObj.Tree,
				ExpectedCommit: tgtCommitHash,
				Holder:         req.Holder,
				NowMs:          now,
			})
			if err != nil {
				return err
			}
			out = MergeResponse{Commit: srcCommitHash, Tree: srcCommitObj.Tree, Conflicts: []string{}}
			return nil
		}

		// Three-way or squash merge from LCA tree.
		baseTree := map[string]TreeEntry{}
		if lcaHash != "" {
			lcaCommit, err := e.GetCommit(ctx, lcaHash)
			if err != nil {
				return err
			}
			baseTree, err = e.GetTreeMap(ctx, lcaCommit.Tree)
			if err != nil {
				return err
			}
		}
		oursTree, err := e.GetTreeMap(ctx, tgtCommitObj.Tree)
		if err != nil {
			return err
		}
		theirsTree, err := e.GetTreeMap(ctx, srcCommitObj.Tree)
		if err != nil {
			return err
		}

		allPathsSet := map[string]bool{}
		for p := range baseTree {
			allPathsSet[p] = true
		}
		for p := range oursTree {
			allPathsSet[p] = true
		}
		for p := range theirsTree {
			allPathsSet[p] = true
		}
		allPaths := make([]string, 0, len(allPathsSet))
		for p := range allPathsSet {
			allPaths = append(allPaths, p)
		}
		sort.Strings(allPaths)

		mergedTree := map[string]TreeEntry{}
		var conflicts []string

		entryEq := func(a EntryState, b EntryState) bool {
			if !a.exists && !b.exists {
				return true
			}
			if a.exists != b.exists {
				return false
			}
			return a.ent.Hash == b.ent.Hash && a.ent.Mode == b.ent.Mode
		}

		for _, p := range allPaths {
			bEnt, bOk := baseTree[p]
			oEnt, oOk := oursTree[p]
			tEnt, tOk := theirsTree[p]

			bs := EntryState{exists: bOk, ent: bEnt}
			osSt := EntryState{exists: oOk, ent: oEnt}
			ts := EntryState{exists: tOk, ent: tEnt}

			switch {
			case entryEq(osSt, ts):
				if oOk {
					mergedTree[p] = oEnt
				}
			case entryEq(osSt, bs):
				// Only theirs changed (added, modified, or deleted).
				if tOk {
					mergedTree[p] = tEnt
				}
			case entryEq(ts, bs):
				// Only ours changed.
				if oOk {
					mergedTree[p] = oEnt
				}
			default:
				// Both sides changed differently relative to base!
				if !oOk || !tOk {
					// Delete/modify conflict.
					conflicts = append(conflicts, p)
					continue
				}
				var baseBytes []byte
				if bOk {
					baseBytes, err = e.GetBlob(ctx, bEnt.Hash)
					if err != nil {
						return err
					}
				}
				oursBytes, err := e.GetBlob(ctx, oEnt.Hash)
				if err != nil {
					return err
				}
				theirsBytes, err := e.GetBlob(ctx, tEnt.Hash)
				if err != nil {
					return err
				}

				mergedBytes, clean := MergeText3Way(baseBytes, oursBytes, theirsBytes)
				if !clean {
					conflicts = append(conflicts, p)
					continue
				}
				mergedBlobHash, err := e.PutBlob(ctx, lineage, mergedBytes)
				if err != nil {
					return err
				}
				mode := oEnt.Mode
				if tEnt.Mode == ExecFileMode {
					mode = ExecFileMode
				}
				mergedTree[p] = TreeEntry{
					Path: p,
					Type: "file",
					Size: int64(len(mergedBytes)),
					Mode: mode,
					Hash: mergedBlobHash,
				}
			}
		}

		if len(conflicts) > 0 {
			return apperr.MergeConflict(conflicts)
		}

		newTreeHash, err := e.PutTreeMap(ctx, lineage, mergedTree)
		if err != nil {
			return err
		}
		parents := []string{tgtCommitHash, srcCommitHash}
		if strategy == "squash" {
			parents = []string{tgtCommitHash}
		}
		newCommitHash, err := e.PutCommit(ctx, lineage, CommitObject{
			Tree:      newTreeHash,
			Parents:   parents,
			Author:    author,
			Message:   msg,
			CreatedAt: now,
		})
		if err != nil {
			return err
		}

		if vmSession != nil {
			files, err := e.loadMaterializedTree(ctx, newTreeHash)
			if err != nil {
				return err
			}
			if err := vmSession.ReplaceTree(ctx, files, newCommitHash); err != nil {
				return err
			}
		}

		_, err = e.store.SetRef(ctx, store.SetRefParams{
			Lineage:        lineage,
			Ref:            targetRef,
			Commit:         newCommitHash,
			Tree:           newTreeHash,
			ExpectedCommit: tgtCommitHash,
			Holder:         req.Holder,
			NowMs:          now,
		})
		if err != nil {
			return err
		}
		out = MergeResponse{
			Commit:    newCommitHash,
			Tree:      newTreeHash,
			Conflicts: []string{},
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

type EntryState struct {
	exists bool
	ent    TreeEntry
}

func (e *Engine) loadMaterializedTree(ctx context.Context, treeHash string) (map[string]MaterializedFile, error) {
	entries, err := e.GetTree(ctx, treeHash)
	if err != nil {
		return nil, err
	}
	files := make(map[string]MaterializedFile, len(entries))
	for _, ent := range entries {
		data, err := e.GetBlob(ctx, ent.Hash)
		if err != nil {
			return nil, err
		}
		files[ent.Path] = MaterializedFile{
			Path: ent.Path,
			Mode: ent.Mode,
			Data: data,
		}
	}
	return files, nil
}

// LoadCommitFiles returns all files in commitHash's tree for VM materialization.
func (e *Engine) LoadCommitFiles(ctx context.Context, commitHash string) (string, map[string]MaterializedFile, error) {
	c, err := e.GetCommit(ctx, commitHash)
	if err != nil {
		return "", nil, err
	}
	files, err := e.loadMaterializedTree(ctx, c.Tree)
	if err != nil {
		return "", nil, err
	}
	return c.Tree, files, nil
}

// MaterializeCommitToDir writes every file in commitHash's tree cleanly into workspaceDir.
func (e *Engine) MaterializeCommitToDir(ctx context.Context, commitHash, workspaceDir string) (string, error) {
	treeHash, files, err := e.LoadCommitFiles(ctx, commitHash)
	if err != nil {
		return "", err
	}
	if err := WriteMaterializedFilesToDir(workspaceDir, files); err != nil {
		return "", err
	}
	return treeHash, nil
}

// WriteMaterializedFilesToDir replaces workspaceDir contents to match files exactly.
func WriteMaterializedFilesToDir(workspaceDir string, files map[string]MaterializedFile) error {
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		return apperr.Internal("mkdir workspace", err)
	}
	// Remove files/dirs not present in target tree.
	entries, err := os.ReadDir(workspaceDir)
	if err != nil {
		return apperr.Internal("readdir workspace", err)
	}
	for _, de := range entries {
		if err := os.RemoveAll(filepath.Join(workspaceDir, de.Name())); err != nil {
			return apperr.Internal("clear workspace entry", err)
		}
	}
	for relPath, mf := range files {
		dst := filepath.Join(workspaceDir, filepath.FromSlash(relPath))
		if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
			return apperr.Internal("mkdir parent", err)
		}
		perm := fs.FileMode(0o644)
		if mf.Mode == ExecFileMode || (mf.Mode&0o111) != 0 {
			perm = 0o755
		}
		if err := os.WriteFile(dst, mf.Data, perm); err != nil {
			return apperr.Internal("write workspace file", err)
		}
	}
	return nil
}

// ApplyOpsToDir applies direct file puts/deletes/moves into a live workspace directory on disk.
func ApplyOpsToDir(workspaceDir string, ops []WorkspaceFileOp) error {
	for _, op := range ops {
		switch op.Kind {
		case "move":
			src := filepath.Join(workspaceDir, filepath.FromSlash(op.From))
			dst := filepath.Join(workspaceDir, filepath.FromSlash(op.Path))
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return apperr.Internal("mkdir move dst", err)
			}
			if err := os.Rename(src, dst); err != nil && !errors.Is(err, os.ErrNotExist) {
				return apperr.Internal("move workspace file", err)
			}
		case "delete":
			dst := filepath.Join(workspaceDir, filepath.FromSlash(op.Path))
			if err := os.RemoveAll(dst); err != nil {
				return apperr.Internal("delete workspace file", err)
			}
		case "put":
			dst := filepath.Join(workspaceDir, filepath.FromSlash(op.Path))
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				return apperr.Internal("mkdir put dst", err)
			}
			perm := fs.FileMode(0o644)
			if op.Mode == ExecFileMode || (op.Mode&0o111) != 0 {
				perm = 0o755
			}
			if err := os.WriteFile(dst, op.Data, perm); err != nil {
				return apperr.Internal("put workspace file", err)
			}
		}
	}
	return nil
}

type WorkspaceCommitResult struct {
	Changed      bool     `json:"changed"`
	Commit       string   `json:"commit"`
	Tree         string   `json:"tree"`
	FilesChanged []string `json:"filesChanged"`
}

// ScanDirFiles walks workspaceDir and collects all regular files as MaterializedFile entries.
func ScanDirFiles(workspaceDir string) (map[string]MaterializedFile, error) {
	files := make(map[string]MaterializedFile)
	if _, err := os.Stat(workspaceDir); errors.Is(err, os.ErrNotExist) {
		return files, nil
	}
	err := filepath.WalkDir(workspaceDir, func(full string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if full == workspaceDir {
			return nil
		}
		rel, err := filepath.Rel(workspaceDir, full)
		if err != nil {
			return err
		}
		relSlash := filepath.ToSlash(rel)
		if relSlash == ".git" || strings.HasPrefix(relSlash, ".git/") {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		data, err := os.ReadFile(full)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return nil
			}
			return err
		}
		mode := DefaultFileMode
		if info.Mode()&0o111 != 0 {
			mode = ExecFileMode
		}
		normRel := path.Clean(relSlash)
		files[normRel] = MaterializedFile{
			Path: normRel,
			Mode: mode,
			Data: data,
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal("walk workspace dir", err)
	}
	return files, nil
}

// PrepareWorkspaceSnapshot builds immutable objects for a workspace checkpoint.
// The caller publishes the result after any other data it needs is ready.
func (e *Engine) PrepareWorkspaceSnapshot(
	ctx context.Context,
	lineage, baseCommit, author, message string,
	snapshot map[string]MaterializedFile,
) (*WorkspaceCommitResult, error) {
	baseObj, err := e.GetCommit(ctx, baseCommit)
	if err != nil {
		return nil, err
	}
	oldTree, err := e.GetTreeMap(ctx, baseObj.Tree)
	if err != nil {
		return nil, err
	}

	newTree := make(map[string]TreeEntry, len(snapshot))
	var filesChanged []string

	for relPath, mf := range snapshot {
		blobHash := store.HashObject(store.KindBlob, mf.Data)
		oldEnt, existed := oldTree[relPath]
		if !existed || oldEnt.Hash != blobHash || oldEnt.Mode != mf.Mode {
			if _, err := e.PutBlob(ctx, lineage, mf.Data); err != nil {
				return nil, err
			}
			filesChanged = append(filesChanged, relPath)
		}
		newTree[relPath] = TreeEntry{
			Path: relPath,
			Type: "file",
			Size: int64(len(mf.Data)),
			Mode: mf.Mode,
			Hash: blobHash,
		}
	}

	for oldPath := range oldTree {
		if _, stillThere := snapshot[oldPath]; !stillThere {
			filesChanged = append(filesChanged, oldPath)
		}
	}

	if len(filesChanged) == 0 {
		return &WorkspaceCommitResult{
			Changed:      false,
			Commit:       baseCommit,
			Tree:         baseObj.Tree,
			FilesChanged: []string{},
		}, nil
	}

	sort.Strings(filesChanged)
	newTreeHash, err := e.PutTreeMap(ctx, lineage, newTree)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(author) == "" {
		author = "vm"
	}
	if strings.TrimSpace(message) == "" {
		message = "vm workspace commit"
	}

	now := e.nowMs()
	newCommitHash, err := e.PutCommit(ctx, lineage, CommitObject{
		Tree:      newTreeHash,
		Parents:   []string{baseCommit},
		Author:    author,
		Message:   message,
		CreatedAt: now,
	})
	if err != nil {
		return nil, err
	}

	return &WorkspaceCommitResult{
		Changed:      true,
		Commit:       newCommitHash,
		Tree:         newTreeHash,
		FilesChanged: filesChanged,
	}, nil
}
