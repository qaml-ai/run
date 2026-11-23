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
)

type Engine struct {
	store store.Store
	vm    VMCoordinator
	nowFn func() time.Time
}

func NewEngine(st store.Store, nowFn func() time.Time) *Engine {
	if nowFn == nil {
		nowFn = time.Now
	}
	return &Engine{store: st, nowFn: nowFn}
}

func (e *Engine) SetVMCoordinator(vm VMCoordinator) { e.vm = vm }

func (e *Engine) nowMs() int64 { return e.nowFn().UnixMilli() }

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
	if hash == "" {
		return []TreeEntry{}, nil
	}
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

// resolveRefName returns the canonical ref name when at targets a branch/ref rather than a raw commit SHA.
func (e *Engine) resolveRefName(ctx context.Context, lineage, at string) string {
	target := strings.TrimSpace(at)
	if target == "" {
		return DefaultRef
	}
	now := e.nowMs()
	if r, err := e.store.GetRef(ctx, lineage, target, now); err == nil && r != nil {
		return r.Name
	}
	if !strings.HasPrefix(target, "refs/") && len(target) != 64 {
		if r, err := e.store.GetRef(ctx, lineage, "refs/heads/"+target, now); err == nil && r != nil {
			return r.Name
		}
	}
	return ""
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

	names := []string{target}
	if !strings.HasPrefix(target, "refs/") {
		names = append(names, "refs/heads/"+target)
	}
	for _, name := range names {
		r, err := e.store.GetRef(ctx, lineage, name, now)
		if err == nil {
			c, err := e.GetCommit(ctx, r.Commit)
			return r.Commit, c, err
		}
		if !apperr.IsCode(err, apperr.CodeNotFound) {
			return "", nil, err
		}
	}
	if len(target) == 64 {
		c, err := e.resolveLineageCommit(ctx, lineage, target)
		return target, c, err
	}
	return "", nil, apperr.NotFoundf("ref or commit %q not found in lineage %q", target, lineage)
}

// Object hashes are global. Only commits reachable from this lineage's refs are visible.
func (e *Engine) resolveLineageCommit(ctx context.Context, lineage, target string) (*CommitObject, error) {
	refs, err := e.ListRefs(ctx, lineage, "")
	if err != nil {
		return nil, err
	}

	pending := make([]string, 0, len(refs))
	for _, ref := range refs {
		pending = append(pending, ref.Commit)
	}
	seen := make(map[string]bool)
	for len(pending) > 0 {
		hash := pending[0]
		pending = pending[1:]
		if seen[hash] {
			continue
		}
		seen[hash] = true
		commit, err := e.GetCommit(ctx, hash)
		if err != nil {
			return nil, err
		}
		if hash == target {
			return commit, nil
		}
		pending = append(pending, commit.Parents...)
	}
	return nil, apperr.NotFoundf("commit %q not found in lineage %q", target, lineage)
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
	initTree, err := e.PutTree(ctx, lineage, nil)
	if err != nil {
		return nil, err
	}
	initCommit, err := e.PutCommit(ctx, lineage, CommitObject{
		Tree:      initTree,
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
			Tree:      initTree,
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
		if c.Tree != "" && !seenObjects[c.Tree] {
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
	_, _, created, err := e.store.CreateLineageIfAbsent(
		ctx,
		store.LineageRecord{
			Lineage:    targetLineage,
			TenantID:   tenantID,
			DefaultRef: targetRef,
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
		c, err := e.resolveLineageCommit(ctx, lineage, req.Commit)
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
			return vmSession.StopForRestore(ctx)
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
		b, err := base64.StdEncoding.DecodeString(p.Base64)
		if err != nil {
			return nil, apperr.InvalidRequestf("invalid base64 payload for %q: %v", p.Path, err)
		}
		return b, nil
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

	var totalBytes int64
	changed := make([]string, 0, len(puts)+len(deletes)+2*len(moves))
	seenChanged := map[string]bool{}
	addChanged := func(p string) {
		if !seenChanged[p] {
			seenChanged[p] = true
			changed = append(changed, p)
		}
	}
	for _, p := range puts {
		totalBytes += int64(len(p.data))
		addChanged(p.path)
	}
	for _, d := range deletes {
		addChanged(d)
	}
	for _, m := range moves {
		addChanged(m.from)
		addChanged(m.to)
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

		vmOps := make([]WorkspaceFileOp, 0, len(moves)+len(deletes)+len(puts))
		for _, mv := range moves {
			vmOps = append(vmOps, WorkspaceFileOp{Kind: "move", From: mv.from, Path: mv.to})
		}
		for _, delPath := range deletes {
			vmOps = append(vmOps, WorkspaceFileOp{Kind: "delete", Path: delPath})
		}
		for _, put := range puts {
			vmOps = append(vmOps, WorkspaceFileOp{Kind: "put", Path: put.path, Data: put.data, Mode: put.mode})
		}

		treeMap, err := e.GetTreeMap(ctx, curRef.Tree)
		if err != nil {
			return err
		}
		for _, mv := range moves {
			srcEnt, ok := treeMap[mv.from]
			if !ok {
				return apperr.NotFoundf("move source %q does not exist", mv.from)
			}
			delete(treeMap, mv.from)
			srcEnt.Path = mv.to
			treeMap[mv.to] = srcEnt
		}
		for _, delPath := range deletes {
			delete(treeMap, delPath)
		}
		for _, put := range puts {
			blobHash, err := e.PutBlob(ctx, lineage, put.data)
			if err != nil {
				return err
			}
			treeMap[put.path] = TreeEntry{
				Path: put.path,
				Type: "file",
				Size: int64(len(put.data)),
				Mode: put.mode,
				Hash: blobHash,
			}
		}
		newTreeHash, err := e.PutTreeMap(ctx, lineage, treeMap)
		if err != nil {
			return err
		}
		if vmSession != nil {
			if err := vmSession.ApplyOps(ctx, vmOps); err != nil {
				return err
			}
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
			if err := vmSession.UpdateHead(ctx, newCommitHash); err != nil {
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

// BuildReadResponse slices data and detects binary payloads uniformly across live VM and committed tree reads.
func BuildReadResponse(commitHash, relPath string, data []byte, mode int, offset, limit int64) *ReadResponse {
	fullSize := int64(len(data))
	binary := IsBinary(data)
	start := min(offset, fullSize)
	end := fullSize
	if limit > 0 && start+limit < end {
		end = start + limit
	}
	slice := data[start:end]

	resp := &ReadResponse{
		Commit: commitHash,
		Path:   relPath,
		Size:   fullSize,
		Mode:   mode,
		Binary: binary,
	}
	if binary {
		b64 := base64.StdEncoding.EncodeToString(slice)
		resp.Base64 = &b64
	} else {
		str := string(slice)
		resp.Content = &str
	}
	return resp
}

// Read reads a file from the active VM (when reading a ref head) or from the committed disk/tree.
func (e *Engine) Read(ctx context.Context, lineage string, p ReadParams) (*ReadResponse, error) {
	normPath, err := NormalizeRelPath(p.Path, false)
	if err != nil {
		return nil, err
	}
	if p.Offset < 0 {
		return nil, apperr.InvalidRequest("offset must be >= 0")
	}
	if _, err := e.store.GetLineage(ctx, lineage); err != nil {
		return nil, err
	}

	if e.vm != nil {
		if refName := e.resolveRefName(ctx, lineage, p.At); refName != "" {
			var liveResp *ReadResponse
			handled, err := e.vm.WithRefReadVM(ctx, lineage, refName, func(reader LiveVMReader) error {
				var rErr error
				liveResp, rErr = reader.ReadFile(ctx, normPath, p.Offset, p.Limit)
				return rErr
			})
			if err != nil {
				return nil, err
			}
			if handled {
				return liveResp, nil
			}
		}
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
	return BuildReadResponse(commitHash, normPath, data, ent.Mode, p.Offset, p.Limit), nil
}

// FilterListEntries filters sorted directory/file entries by directory prefix, recursion, and glob.
func FilterListEntries(entries []TreeEntry, normDir string, recursive bool, glob string) ([]TreeEntry, error) {
	var globRE *regexp.Regexp
	if strings.TrimSpace(glob) != "" {
		var err error
		globRE, err = CompileGlob(glob)
		if err != nil {
			return nil, apperr.InvalidRequestf("invalid glob %q: %v", glob, err)
		}
	}

	matchesGlob := func(entryPath string) bool {
		if globRE == nil {
			return true
		}
		if globRE.MatchString(entryPath) {
			return true
		}
		if normDir != "" && strings.HasPrefix(entryPath, normDir+"/") {
			if globRE.MatchString(strings.TrimPrefix(entryPath, normDir+"/")) {
				return true
			}
		}
		return false
	}

	if normDir != "" {
		for _, ent := range entries {
			if ent.Path == normDir && ent.Type != "dir" {
				out := []TreeEntry{}
				if matchesGlob(ent.Path) {
					out = append(out, ent)
				}
				return out, nil
			}
		}
	}

	prefix := ""
	if normDir != "" {
		prefix = normDir + "/"
	}
	out := make([]TreeEntry, 0)
	if recursive {
		for _, ent := range entries {
			if prefix != "" && !strings.HasPrefix(ent.Path, prefix) {
				continue
			}
			if ent.Type == "dir" {
				continue
			}
			if matchesGlob(ent.Path) {
				out = append(out, ent)
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
		return out, nil
	}

	seenDirs := map[string]bool{}
	for _, ent := range entries {
		if prefix != "" && !strings.HasPrefix(ent.Path, prefix) {
			continue
		}
		rel := strings.TrimPrefix(ent.Path, prefix)
		if rel == "" {
			continue
		}
		if slash := strings.IndexByte(rel, '/'); slash >= 0 {
			dirPath := prefix + rel[:slash]
			if !seenDirs[dirPath] {
				seenDirs[dirPath] = true
				if matchesGlob(dirPath) {
					out = append(out, TreeEntry{Path: dirPath, Type: "dir", Size: 0, Mode: ExecFileMode})
				}
			}
		} else if ent.Type == "dir" {
			if !seenDirs[ent.Path] {
				seenDirs[ent.Path] = true
				if matchesGlob(ent.Path) {
					out = append(out, ent)
				}
			}
		} else if matchesGlob(ent.Path) {
			out = append(out, ent)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	return out, nil
}

// ListEntries implements ls against the active VM or committed tree.
func (e *Engine) ListEntries(ctx context.Context, lineage string, p ListParams) (*ListResponse, error) {
	normDir, err := NormalizeRelPath(p.Path, true)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(p.Glob) != "" {
		if _, err := CompileGlob(p.Glob); err != nil {
			return nil, apperr.InvalidRequestf("invalid glob %q: %v", p.Glob, err)
		}
	}
	if _, err := e.store.GetLineage(ctx, lineage); err != nil {
		return nil, err
	}

	if e.vm != nil {
		if refName := e.resolveRefName(ctx, lineage, p.At); refName != "" {
			var commitHash string
			var entries []TreeEntry
			handled, err := e.vm.WithRefReadVM(ctx, lineage, refName, func(reader LiveVMReader) error {
				commitHash = reader.HeadCommit()
				var lErr error
				entries, lErr = reader.ListEntries(ctx, normDir, p.Recursive, p.Glob)
				return lErr
			})
			if err != nil {
				return nil, err
			}
			if handled {
				return &ListResponse{Commit: commitHash, Entries: entries}, nil
			}
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
	filtered, err := FilterListEntries(entries, normDir, p.Recursive, p.Glob)
	if err != nil {
		return nil, err
	}
	return &ListResponse{Commit: commitHash, Entries: filtered}, nil
}

// GrepTextLines matches re over text file content, stopping at maxMatches.
func GrepTextLines(re *regexp.Regexp, filePath string, data []byte, maxMatches int, out *[]GrepMatch) bool {
	if IsBinary(data) {
		return false
	}
	lines := strings.Split(string(data), "\n")
	if len(lines) > 0 && lines[len(lines)-1] == "" && strings.HasSuffix(string(data), "\n") {
		lines = lines[:len(lines)-1]
	}
	for lineIdx, line := range lines {
		cleanLine := strings.TrimSuffix(line, "\r")
		if loc := re.FindStringIndex(cleanLine); loc != nil {
			*out = append(*out, GrepMatch{
				Path:   filePath,
				Line:   lineIdx + 1,
				Column: loc[0] + 1,
				Text:   cleanLine,
			})
			if len(*out) >= maxMatches {
				return true
			}
		}
	}
	return false
}

func matchGrepPrefix(filePath, prefix string, dirOnly bool) bool {
	if prefix == "" {
		return true
	}
	if dirOnly {
		return strings.HasPrefix(filePath, prefix+"/")
	}
	return filePath == prefix || strings.HasPrefix(filePath, prefix+"/") || strings.HasPrefix(filePath, prefix)
}

// Grep searches text files in the active VM or committed tree.
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
	dirOnly := strings.HasSuffix(strings.TrimSpace(req.PathPrefix), "/") && prefix != ""
	maxMatches := req.MaxMatches
	if maxMatches <= 0 {
		maxMatches = 100
	}
	if _, err := e.store.GetLineage(ctx, lineage); err != nil {
		return nil, err
	}

	if e.vm != nil {
		if refName := e.resolveRefName(ctx, lineage, req.At); refName != "" {
			var commitHash string
			var matches []GrepMatch
			handled, err := e.vm.WithRefReadVM(ctx, lineage, refName, func(reader LiveVMReader) error {
				commitHash = reader.HeadCommit()
				var gErr error
				matches, gErr = reader.Grep(ctx, GrepRequest{
					Pattern:    req.Pattern,
					PathPrefix: req.PathPrefix,
					MaxMatches: maxMatches,
				})
				return gErr
			})
			if err != nil {
				return nil, err
			}
			if handled {
				return &GrepResponse{Commit: commitHash, Matches: matches}, nil
			}
		}
	}

	commitHash, commitObj, err := e.ResolveCommit(ctx, lineage, req.At)
	if err != nil {
		return nil, err
	}
	matches := make([]GrepMatch, 0)

	entries, err := e.GetTree(ctx, commitObj.Tree)
	if err != nil {
		return nil, err
	}
	for _, ent := range entries {
		if !matchGrepPrefix(ent.Path, prefix, dirOnly) {
			continue
		}
		data, err := e.GetBlob(ctx, ent.Hash)
		if err != nil {
			return nil, err
		}
		if GrepTextLines(re, ent.Path, data, maxMatches, &matches) {
			return &GrepResponse{Commit: commitHash, Matches: matches}, nil
		}
	}
	return &GrepResponse{Commit: commitHash, Matches: matches}, nil
}

// History walks commits reachable from ref up to limit.
func (e *Engine) History(ctx context.Context, lineage, ref string, limit int) (*HistoryResponse, error) {
	if limit <= 0 {
		limit = 20
	}
	if limit > 1000 {
		limit = 1000
	}
	headHash, _, err := e.ResolveCommit(ctx, lineage, ref)
	if err != nil {
		return nil, err
	}

	seen := map[string]bool{}
	queue := []string{headHash}
	commits := make([]HistoryCommit, 0)
	for len(queue) > 0 && len(commits) < limit {
		h := queue[0]
		queue = queue[1:]
		if h == "" || seen[h] {
			continue
		}
		seen[h] = true

		c, err := e.GetCommit(ctx, h)
		if err != nil {
			return nil, err
		}
		commits = append(commits, HistoryCommit{
			Commit:    h,
			Tree:      c.Tree,
			Parents:   c.Parents,
			Author:    c.Author,
			Message:   c.Message,
			CreatedAt: c.CreatedAt,
		})
		for _, p := range c.Parents {
			if !seen[p] {
				queue = append(queue, p)
			}
		}
	}
	return &HistoryResponse{Commits: commits}, nil
}

// Restore creates a new commit on ref pointing to targetCommit's disk/tree, stopping any active VM first.
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
		if req.ExpectedCommit != "" && curRef.Commit != req.ExpectedCommit {
			return apperr.CASConflictf("expected commit %q on ref %q, got %q", req.ExpectedCommit, refName, curRef.Commit)
		}

		if vmSession != nil {
			if err := vmSession.StopForRestore(ctx); err != nil {
				return err
			}
		}

		newCommit, err := e.PutCommit(ctx, lineage, CommitObject{
			Tree:      targetObj.Tree,
			Parents:   []string{curRef.Commit},
			Author:    author,
			Message:   msg,
			CreatedAt: now,
		})
		if err != nil {
			return err
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

// LoadCommitTree returns only the tree metadata entries for lazy FUSE VM mounts (zero blob reads).
func (e *Engine) LoadCommitTree(ctx context.Context, commitHash string) (string, []TreeEntry, error) {
	c, err := e.GetCommit(ctx, commitHash)
	if err != nil {
		return "", nil, err
	}
	entries, err := e.GetTree(ctx, c.Tree)
	if err != nil {
		return "", nil, err
	}
	return c.Tree, entries, nil
}

// LoadCommitFiles returns all files in commitHash's tree for local/remote VM materialization.
func (e *Engine) LoadCommitFiles(ctx context.Context, commitHash string) (string, map[string]MaterializedFile, error) {
	treeHash, entries, err := e.LoadCommitTree(ctx, commitHash)
	if err != nil {
		return "", nil, err
	}
	files := make(map[string]MaterializedFile, len(entries))
	for _, ent := range entries {
		data, err := e.GetBlob(ctx, ent.Hash)
		if err != nil {
			return "", nil, err
		}
		files[ent.Path] = MaterializedFile{Path: ent.Path, Mode: ent.Mode, Data: data}
	}
	return treeHash, files, nil
}

// ApplyWorkspaceDelta applies an O(delta) set of puts and deletes (from overlayfs upperdir) onto baseCommit.
func (e *Engine) ApplyWorkspaceDelta(
	ctx context.Context,
	lineage, baseCommit, author, message string,
	puts []MaterializedFile,
	deletes []string,
) (*WorkspaceCommitResult, error) {
	baseObj, err := e.GetCommit(ctx, baseCommit)
	if err != nil {
		return nil, err
	}
	if len(puts) == 0 && len(deletes) == 0 {
		return &WorkspaceCommitResult{
			Changed:      false,
			Commit:       baseCommit,
			Tree:         baseObj.Tree,
			FilesChanged: []string{},
		}, nil
	}
	treeMap, err := e.GetTreeMap(ctx, baseObj.Tree)
	if err != nil {
		return nil, err
	}
	changedSet := make(map[string]struct{})
	for _, delPath := range deletes {
		if _, existed := treeMap[delPath]; existed {
			delete(treeMap, delPath)
			changedSet[delPath] = struct{}{}
		}
	}
	for _, mf := range puts {
		blobHash := store.HashObject(store.KindBlob, mf.Data)
		oldEnt, existed := treeMap[mf.Path]
		if !existed || oldEnt.Hash != blobHash || oldEnt.Mode != mf.Mode {
			if _, err := e.PutBlob(ctx, lineage, mf.Data); err != nil {
				return nil, err
			}
			changedSet[mf.Path] = struct{}{}
		}
		treeMap[mf.Path] = TreeEntry{
			Path: mf.Path,
			Type: "file",
			Size: int64(len(mf.Data)),
			Mode: mf.Mode,
			Hash: blobHash,
		}
	}
	if len(changedSet) == 0 {
		return &WorkspaceCommitResult{
			Changed:      false,
			Commit:       baseCommit,
			Tree:         baseObj.Tree,
			FilesChanged: []string{},
		}, nil
	}
	return e.commitNewTree(ctx, lineage, baseCommit, author, message, treeMap, sortedKeys(changedSet))
}

// PrepareWorkspaceSnapshot builds tree/blob objects from a full workspace directory snapshot.
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
	changedSet := make(map[string]struct{})
	for relPath, mf := range snapshot {
		blobHash := store.HashObject(store.KindBlob, mf.Data)
		oldEnt, existed := oldTree[relPath]
		if !existed || oldEnt.Hash != blobHash || oldEnt.Mode != mf.Mode {
			if _, err := e.PutBlob(ctx, lineage, mf.Data); err != nil {
				return nil, err
			}
			changedSet[relPath] = struct{}{}
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
			changedSet[oldPath] = struct{}{}
		}
	}
	if len(changedSet) == 0 {
		return &WorkspaceCommitResult{
			Changed:      false,
			Commit:       baseCommit,
			Tree:         baseObj.Tree,
			FilesChanged: []string{},
		}, nil
	}
	return e.commitNewTree(ctx, lineage, baseCommit, author, message, newTree, sortedKeys(changedSet))
}

func sortedKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func (e *Engine) commitNewTree(
	ctx context.Context,
	lineage, baseCommit, author, message string,
	treeMap map[string]TreeEntry,
	filesChanged []string,
) (*WorkspaceCommitResult, error) {
	newTreeHash, err := e.PutTreeMap(ctx, lineage, treeMap)
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(author) == "" {
		author = "vm"
	}
	if strings.TrimSpace(message) == "" {
		message = "vm workspace commit"
	}
	newCommitHash, err := e.PutCommit(ctx, lineage, CommitObject{
		Tree:      newTreeHash,
		Parents:   []string{baseCommit},
		Author:    author,
		Message:   message,
		CreatedAt: e.nowMs(),
	})
	if err != nil {
		return nil, err
	}
	if filesChanged == nil {
		filesChanged = []string{}
	}
	return &WorkspaceCommitResult{
		Changed:      true,
		Commit:       newCommitHash,
		Tree:         newTreeHash,
		FilesChanged: filesChanged,
	}, nil
}

// WriteMaterializedFilesToDir replaces workspaceDir contents to match files exactly.
func WriteMaterializedFilesToDir(workspaceDir string, files map[string]MaterializedFile) error {
	if err := os.MkdirAll(workspaceDir, 0o755); err != nil {
		return apperr.Internal("mkdir workspace", err)
	}
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
			if err := os.Rename(src, dst); err != nil {
				if errors.Is(err, os.ErrNotExist) {
					return apperr.NotFoundf("move source %q does not exist", op.From)
				}
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
		files[normRel] = MaterializedFile{Path: normRel, Mode: mode, Data: data}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal("walk workspace dir", err)
	}
	return files, nil
}

// DirReadFile reads a single file from a live workspace directory on disk.
func DirReadFile(workspaceDir, commitHash, rawPath string, offset, limit int64) (*ReadResponse, error) {
	normPath, err := NormalizeRelPath(rawPath, false)
	if err != nil {
		return nil, err
	}
	full := filepath.Join(workspaceDir, filepath.FromSlash(normPath))
	info, err := os.Lstat(full)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, apperr.NotFoundf("path %q not found", normPath)
		}
		return nil, apperr.Internal("stat workspace file", err)
	}
	if info.IsDir() || !info.Mode().IsRegular() {
		return nil, apperr.InvalidRequestf("path %q is not a regular file", normPath)
	}
	data, err := os.ReadFile(full)
	if err != nil {
		return nil, apperr.Internal("read workspace file", err)
	}
	mode := DefaultFileMode
	if info.Mode()&0o111 != 0 {
		mode = ExecFileMode
	}
	return BuildReadResponse(commitHash, normPath, data, mode, offset, limit), nil
}

// DirListEntries lists files and directories inside a live workspace directory on disk.
func DirListEntries(workspaceDir, dirPrefix string, recursive bool, glob string) ([]TreeEntry, error) {
	normDir, err := NormalizeRelPath(dirPrefix, true)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(workspaceDir); errors.Is(err, os.ErrNotExist) {
		return []TreeEntry{}, nil
	}
	var entries []TreeEntry
	root := workspaceDir
	if normDir != "" {
		target := filepath.Join(workspaceDir, filepath.FromSlash(normDir))
		info, err := os.Lstat(target)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				return []TreeEntry{}, nil
			}
			return nil, apperr.Internal("stat workspace list path", err)
		}
		if !info.IsDir() {
			t := "file"
			if info.Mode()&os.ModeSymlink != 0 {
				t = "symlink"
			}
			mode := DefaultFileMode
			if info.Mode()&0o111 != 0 {
				mode = ExecFileMode
			}
			return FilterListEntries([]TreeEntry{{Path: normDir, Type: t, Size: info.Size(), Mode: mode}}, normDir, recursive, glob)
		}
		root = target
	}

	err = filepath.WalkDir(root, func(full string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if full == root {
			return nil
		}
		rel, err := filepath.Rel(workspaceDir, full)
		if err != nil {
			return err
		}
		relSlash := path.Clean(filepath.ToSlash(rel))
		if filepath.Base(relSlash) == "lost+found" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() {
			entries = append(entries, TreeEntry{Path: relSlash, Type: "dir", Mode: ExecFileMode})
			if !recursive {
				return filepath.SkipDir
			}
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		t := "file"
		if info.Mode()&os.ModeSymlink != 0 {
			t = "symlink"
		}
		mode := DefaultFileMode
		if info.Mode()&0o111 != 0 {
			mode = ExecFileMode
		}
		entries = append(entries, TreeEntry{Path: relSlash, Type: t, Size: info.Size(), Mode: mode})
		return nil
	})
	if err != nil {
		return nil, apperr.Internal("list workspace dir", err)
	}
	return FilterListEntries(entries, normDir, recursive, glob)
}

// DirGrepFiles searches text files inside a live workspace directory on disk.
func DirGrepFiles(workspaceDir string, req GrepRequest) ([]GrepMatch, error) {
	re, err := regexp.Compile(req.Pattern)
	if err != nil {
		return nil, apperr.InvalidRequestf("invalid regex pattern: %v", err)
	}
	prefix, err := NormalizeRelPath(req.PathPrefix, true)
	if err != nil {
		return nil, err
	}
	dirOnly := strings.HasSuffix(strings.TrimSpace(req.PathPrefix), "/") && prefix != ""
	maxMatches := req.MaxMatches
	if maxMatches <= 0 {
		maxMatches = 100
	}

	matches := make([]GrepMatch, 0)
	if _, err := os.Stat(workspaceDir); errors.Is(err, os.ErrNotExist) {
		return matches, nil
	}
	var allPaths []string
	err = filepath.WalkDir(workspaceDir, func(full string, d fs.DirEntry, walkErr error) error {
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
		relSlash := path.Clean(filepath.ToSlash(rel))
		if relSlash == ".git" || strings.HasPrefix(relSlash, ".git/") || relSlash == "lost+found" {
			if d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if d.IsDir() || d.Type()&os.ModeSymlink != 0 {
			return nil
		}
		if matchGrepPrefix(relSlash, prefix, dirOnly) {
			allPaths = append(allPaths, relSlash)
		}
		return nil
	})
	if err != nil {
		return nil, apperr.Internal("grep workspace dir", err)
	}
	sort.Strings(allPaths)
	for _, relSlash := range allPaths {
		data, err := os.ReadFile(filepath.Join(workspaceDir, filepath.FromSlash(relSlash)))
		if err != nil {
			continue
		}
		if GrepTextLines(re, relSlash, data, maxMatches, &matches) {
			break
		}
	}
	return matches, nil
}
