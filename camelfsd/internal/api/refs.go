package api

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/aws/smithy-go"
	"github.com/qaml-ai/run/camelfsd/internal/auth"
	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

type commitParents struct{ repo *objects.Repository }

func (p commitParents) Parents(ctx context.Context, l, id string) ([]string, bool, error) {
	c, err := refCommit(ctx, p.repo.ForLineage(l), id)
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	return c.parents, err == nil, err
}

type refCommitInfo struct {
	tree    string
	parents []string
}

func refCommit(ctx context.Context, repo *objects.Repository, id string) (refCommitInfo, error) {
	c, err := readCommit(ctx, repo, id)
	if err != nil {
		return refCommitInfo{}, err
	}
	tree, _ := c["tree"].(string)
	if !root.Hex(tree, 40) {
		return refCommitInfo{}, errors.New("commit has an invalid tree")
	}
	return refCommitInfo{tree, c["parents"].([]string)}, nil
}

type refReply struct {
	Name          string           `json:"name"`
	Version       string           `json:"version"`
	Tree          string           `json:"tree"`
	Root          string           `json:"root,omitempty"`
	Owner         *string          `json:"owner"`
	ExpiresAt     *int64           `json:"expiresAt,omitempty"`
	Holder        *hostwire.Holder `json:"holder,omitempty"`
	LeaseEpoch    int64            `json:"leaseEpoch"`
	LeaseDeadline *int64           `json:"leaseDeadline,omitempty"`
	CreatedAt     int64            `json:"createdAt"`
	CreatedBy     string           `json:"createdBy"`
	UpdatedAt     int64            `json:"updatedAt"`
}

func replyRef(r refstore.Ref) (refReply, error) {
	out := refReply{Name: r.Name, Version: r.Version, Tree: r.Tree, Root: r.Root, Owner: r.Owner,
		ExpiresAt: r.ExpiresAt, LeaseEpoch: r.LeaseEpoch, LeaseDeadline: r.LeaseDeadline,
		CreatedAt: r.CreatedAt, CreatedBy: r.CreatedBy, UpdatedAt: r.UpdatedAt}
	if r.Holder != nil {
		h, err := hostwire.ParseHolder(*r.Holder)
		if err != nil {
			return refReply{}, err
		}
		out.Holder = &h
	}
	return out, nil
}

func refMatcher(globs []string) func(string) bool {
	patterns := make([]*regexp.Regexp, 0, len(globs))
	for _, glob := range globs {
		pattern := strings.ReplaceAll(regexp.QuoteMeta(glob), `\*`, `[^/]*`)
		patterns = append(patterns, regexp.MustCompile("^"+pattern+"$"))
	}
	return func(name string) bool {
		for _, pattern := range patterns {
			if pattern.MatchString(name) {
				return true
			}
		}
		return false
	}
}

type refRequest struct {
	action, name, watcher string
	create                struct {
		Name, Version, Owner string
		ExpiresAt            *int64
	}
	matches func(string) bool
}

// Ref names may contain slashes. The method disambiguates route suffixes.
func parseRefRequest(r *http.Request, route string, claims auth.Claims) (refRequest, error) {
	var q refRequest
	switch {
	case route == "refs":
		switch r.Method {
		case "GET":
			q.action = "list"
		case "POST":
			q.action = "create"
			if err := decodeStorage(r, &q.create); err != nil {
				return q, err
			}
			q.name = q.create.Name
		case "DELETE":
			q.action = "deleteOwned"
		}
	default:
		// Match suffixes on the escaped path so an encoded slash in a
		// ref name cannot be mistaken for an operation separator.
		raw := strings.SplitN(r.URL.EscapedPath(), "/", 6)
		if len(raw) != 6 || raw[4] != "refs" {
			return q, invalid("invalid refs path")
		}
		q.name = raw[5]
		switch {
		case (r.Method == "PUT" || r.Method == "DELETE") && strings.Contains(q.name, "/watchers/"):
			idx := strings.LastIndex(q.name, "/watchers/")
			q.name, q.watcher, q.action = q.name[:idx], q.name[idx+len("/watchers/"):], "watch"
		case r.Method == "POST" && strings.HasSuffix(q.name, "/lease/renew"):
			q.name, q.action = strings.TrimSuffix(q.name, "/lease/renew"), "renew"
		case (r.Method == "POST" || r.Method == "DELETE") && strings.HasSuffix(q.name, "/lease"):
			q.name, q.action = strings.TrimSuffix(q.name, "/lease"), "lease"
		case r.Method == "POST":
			idx := strings.LastIndex(q.name, "/")
			if idx >= 0 {
				switch action := q.name[idx+1:]; action {
				case "cas", "write", "merge", "restore":
					q.name, q.action = q.name[:idx], action
				}
			}
		case r.Method == "GET":
			q.action = "get"
		case r.Method == "DELETE":
			q.action = "delete"
		}
	}
	if route != "refs" {
		var err error
		q.name, err = url.PathUnescape(q.name)
		if err != nil {
			return q, invalid("invalid ref name")
		}
		q.watcher, err = url.PathUnescape(q.watcher)
		if err != nil {
			return q, invalid("invalid watcher")
		}
	}
	if q.action != "" && q.action != "list" && q.action != "deleteOwned" {
		if !refstore.ValidName(q.name) {
			return q, invalid("invalid ref name")
		}
		if r.Method != http.MethodGet {
			q.matches = refMatcher(claims.Refs)
			if !q.matches(q.name) {
				return q, refOutsideScope(q.name)
			}
		}
	}
	if (q.action == "watch" || q.action == "lease" || q.action == "renew") && !runtimeSubject(claims) {
		return q, forbidden("runtime token required")
	}
	release := q.action == "lease" && r.Method == http.MethodDelete
	if r.Method != http.MethodGet && claims.Fence != nil {
		if len(claims.Refs) != 1 || claims.Refs[0] != q.name {
			return q, forbidden("fence requires one exact ref")
		}
		if q.action != "cas" && q.action != "renew" && !release {
			return q, forbidden("fence token cannot be used on this route")
		}
	}
	if q.action == "watch" || release {
		if r.Body != nil {
			var first [1]byte
			if _, err := io.ReadFull(r.Body, first[:]); err != io.EOF {
				return q, invalid("request body must be empty")
			}
		}
	}
	return q, nil
}

func refOutsideScope(name string) error {
	return forbidden("ref " + name + " is outside the token's refs")
}

func runtimeSubject(c auth.Claims) bool { return strings.HasPrefix(c.Subject, "runtime:") }

func (s *StorageServer) refRoute(w http.ResponseWriter, r *http.Request, l string, q refRequest, repo *objects.Repository) error {
	ctx := r.Context()
	claims, _ := ClaimsFromContext(ctx)
	query := r.URL.Query()
	name := q.name
	switch q.action {
	case "get":
		row, err := s.refs.Get(ctx, l, name)
		if err != nil {
			return err
		}
		body, err := replyRef(row)
		if err != nil {
			return err
		}
		jsonReply(w, 200, body)
	case "list":
		limit := 1000
		if query.Has("limit") {
			var err error
			limit, err = strconv.Atoi(query.Get("limit"))
			if err != nil || limit < 1 || limit > 1000 {
				return invalid("limit must be between 1 and 1000")
			}
		}
		rows, next, err := s.refs.List(ctx, l, query.Get("prefix"), query.Get("after"), limit)
		if err != nil {
			return err
		}
		out := make([]refReply, 0, len(rows))
		for _, row := range rows {
			body, err := replyRef(row)
			if err != nil {
				return err
			}
			out = append(out, body)
		}
		jsonReply(w, 200, struct {
			Refs []refReply `json:"refs"`
			Next string     `json:"next,omitempty"`
		}{out, next})
	case "create":
		if !refstore.ValidOwner(q.create.Owner) {
			return invalid("invalid owner")
		}
		c, err := loadRefCommit(ctx, repo, q.create.Version)
		if err != nil {
			return err
		}
		row, err := s.refs.CreateBy(ctx, l, name, refstore.Target{Version: q.create.Version, Tree: c.tree}, &q.create.Owner, q.create.ExpiresAt, claims.Subject)
		if err != nil {
			return err
		}
		body, err := replyRef(row)
		if err != nil {
			return err
		}
		jsonReply(w, 201, body)
	case "deleteOwned":
		deleted, held, err := s.refs.DeleteOwned(ctx, l, query.Get("owner"))
		if err != nil {
			return err
		}
		jsonReply(w, 200, map[string][]string{"deleted": append([]string{}, deleted...), "held": append([]string{}, held...)})
	case "delete":
		var expect *string
		if query.Has("expect") {
			version := query.Get("expect")
			if !root.Hex(version, 40) {
				return invalid("expect: expected a 40-character Git id")
			}
			expect = &version
		}
		if err := s.refs.Delete(ctx, l, name, expect); err != nil {
			return err
		}
		w.WriteHeader(204)
	case "watch":
		if !refstore.ValidOwner(q.watcher) {
			return invalid("invalid watcher")
		}
		change := s.refs.Watch
		if r.Method == "DELETE" {
			change = s.refs.Unwatch
		}
		if err := change(ctx, l, name, q.watcher); err != nil {
			return err
		}
		w.WriteHeader(204)
	case "lease", "renew":
		return s.leaseRoute(w, r, l, name, q.action, claims.Fence)
	case "cas":
		return s.refCAS(w, r, l, name, claims.Fence, repo)
	case "write":
		return s.refWrite(w, r, l, name, repo)
	case "merge":
		return s.refMerge(w, r, l, name, repo)
	case "restore":
		return s.refRestore(w, r, l, name, repo)
	default:
		http.NotFound(w, r)
	}
	return nil
}

func loadRefCommit(ctx context.Context, repo *objects.Repository, id string) (refCommitInfo, error) {
	if !root.Hex(id, 40) {
		return refCommitInfo{}, invalid("commit: expected a 40-character Git id")
	}
	c, err := refCommit(ctx, repo, id)
	if errors.Is(err, os.ErrNotExist) {
		err = bad("unknown_commit")
	}
	return c, err
}

func (s *StorageServer) refCAS(w http.ResponseWriter, r *http.Request, l, name string, fence *auth.Fence, repo *objects.Repository) error {
	ctx := r.Context()
	var body struct {
		Commit, Expect, Root string
		Quota                *quotaRequest
	}
	if err := decodeStorage(r, &body); err != nil {
		return err
	}
	if !root.Hex(body.Expect, 40) || (body.Root != "" && !root.Hex(body.Root, 64)) {
		return invalid("expect must be a Git id and root, when supplied, must be a SHA-256")
	}
	if err := body.Quota.validate(); err != nil {
		return err
	}
	commit, err := loadRefCommit(ctx, repo, body.Commit)
	if err != nil {
		return err
	}
	// cas moves the ref to a commit the lineage already has, so it is always a fast-forward check (rule 2):
	// the commit must reach expect. bad_parent (rule 1) belongs to the moves the tier builds itself (write,
	// merge, restore), whose parents it chooses; cas still refuses a commit with more than two parents.
	kind := "move"
	if len(commit.parents) > 2 {
		// refstore's rule 1 refuses it as bad_parent, after the stale and fence checks.
		kind = "commit"
	}
	var diff []diffChange
	var files, bytes int64
	move := refstore.Move{Kind: kind, Version: body.Commit, Tree: commit.tree, Root: body.Root, Parents: commit.parents,
		Expect: &body.Expect, RequireExisting: true,
		Prepare: func(previous refstore.Ref) error {
			var err error
			diff, err = treeDiff(ctx, repo, previous.Tree, commit.tree, "")
			if err != nil {
				return err
			}
			files, err = repo.TreeFileCount(ctx, commit.tree)
			if err != nil {
				return err
			}
			bytes, err = s.checkQuota(ctx, l, body.Quota)
			return err
		}}
	if fence != nil {
		move.Fence = &refstore.Fence{Holder: fence.Holder, Epoch: fence.Epoch}
	}
	if _, err := s.refs.Cas(ctx, l, name, move); err != nil {
		return err
	}
	jsonReply(w, 200, map[string]any{"version": body.Commit, "tree": commit.tree, "parents": commit.parents,
		"diff": diff, "bytes": bytes, "files": files})
	return nil
}

func (s *StorageServer) leaseRoute(w http.ResponseWriter, r *http.Request, l, name, action string, claim *auth.Fence) error {
	ctx := r.Context()
	if action == "lease" && r.Method == "POST" {
		var body struct {
			Holder hostwire.Holder
			TTLms  int64
		}
		if err := decodeStorage(r, &body); err != nil {
			return err
		}
		holder := body.Holder.String()
		if _, err := hostwire.ParseHolder(holder); err != nil {
			return invalid("invalid lease holder")
		}
		lease, err := s.refs.Acquire(ctx, l, name, holder, body.TTLms)
		if err != nil {
			return err
		}
		jsonReply(w, 200, map[string]any{"epoch": lease.Epoch, "deadline": lease.Deadline, "version": lease.Version, "tree": lease.Tree})
		return nil
	}
	if action == "renew" {
		var body struct{ TTLms int64 }
		if err := decodeStorage(r, &body); err != nil {
			return err
		}
		if body.TTLms <= 0 || body.TTLms > 600000 {
			return invalid("ttlMs must be between 1 and 600000")
		}
		if claim != nil {
			fence := refstore.Fence{Holder: claim.Holder, Epoch: claim.Epoch}
			lease, err := s.refs.Renew(ctx, l, name, fence, body.TTLms)
			if err != nil {
				return err
			}
			jsonReply(w, 200, map[string]int64{"deadline": lease.Deadline})
			return nil
		}
	}
	if claim == nil {
		if _, err := s.refs.Get(ctx, l, name); err != nil {
			return err
		}
		return &storageError{409, "fenced", nil}
	}
	fence := refstore.Fence{Holder: claim.Holder, Epoch: claim.Epoch}
	if err := s.refs.Release(ctx, l, name, fence); err != nil {
		return err
	}
	w.WriteHeader(204)
	return nil
}

func ddbUnavailable(err error) error {
	var operation *smithy.OperationError
	if errors.As(err, &operation) && operation.Service() == "DynamoDB" {
		return &storageError{503, "unavailable", nil}
	}
	return err
}

func (s *StorageServer) refRouteError(w http.ResponseWriter, r *http.Request, l string, err error) {
	var refErr *refstore.Error
	if errors.As(err, &refErr) && refErr.Code == "lineage_blocked" {
		item, readErr := s.lineages.get(r.Context(), l)
		switch {
		case readErr != nil:
			err = readErr
		case item.DeletedAt != nil:
			err = lineageDeleted()
		case item.Lineage == "":
			err = lineageMissing()
		default:
			err = &storageError{503, "unavailable", nil}
		}
	}
	storageFail(w, ddbUnavailable(err))
}
