package api

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/root"
)

const ancestryLimit = 50000

type ancestryNode struct {
	parents     []string
	tree        string
	time        int64
	generations [2]int
}

// walkAncestry alternates BFS generations from both tips. Each distinct commit
// is loaded once, through the lineage-scoped loader, and counts once to the cap.
func walkAncestry(ctx context.Context, a, b string, load func(context.Context, string) (map[string]any, error)) (map[string]*ancestryNode, error) {
	nodes := map[string]*ancestryNode{}
	queues := [2][]string{{a}, {b}}
	seen := [2]map[string]bool{{a: true}, {b: true}}
	for generation := 0; len(queues[0])+len(queues[1]) > 0; generation++ {
		for side := range 2 {
			next := []string{}
			for _, id := range queues[side] {
				if e := ctx.Err(); e != nil {
					return nil, e
				}
				n := nodes[id]
				if n == nil {
					if len(nodes) == ancestryLimit {
						return nil, &storageError{413, "too_deep", nil}
					}
					c, e := load(ctx, id)
					if e != nil {
						return nil, e
					}
					n = &ancestryNode{parents: c["parents"].([]string), tree: c["tree"].(string), time: c["time"].(int64), generations: [2]int{-1, -1}}
					nodes[id] = n
				}
				n.generations[side] = generation
				for _, p := range n.parents {
					if !seen[side][p] {
						seen[side][p] = true
						next = append(next, p)
					}
				}
			}
			queues[side] = next
		}
	}
	return nodes, nil
}

// walkIsAncestor follows only b's parents and stops before loading a or its
// history. Lineage membership of a is checked by the caller, without loading it.
func walkIsAncestor(ctx context.Context, a, b string, load func(context.Context, string) (map[string]any, error)) (bool, error) {
	seen := map[string]bool{}
	queue := []string{b}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		if seen[id] {
			continue
		}
		if e := ctx.Err(); e != nil {
			return false, e
		}
		if len(seen) == ancestryLimit {
			return false, &storageError{413, "too_deep", nil}
		}
		seen[id] = true
		if id == a {
			return true, nil
		}
		c, e := load(ctx, id)
		if e != nil {
			return false, e
		}
		queue = append(queue, c["parents"].([]string)...)
	}
	return false, nil
}

func ancestryCommit(ctx context.Context, repo *objects.Repository, id string) (map[string]any, error) {
	c, e := readCommit(ctx, repo, id)
	if errors.Is(e, os.ErrNotExist) {
		return nil, &storageError{404, "not_found", map[string]string{"commit": id}}
	}
	return c, e
}

func serveAncestry(w http.ResponseWriter, r *http.Request, repo *objects.Repository, lineage, a, b string) {
	for _, id := range []string{a, b} {
		if !root.Hex(id, 40) {
			storageFail(w, invalid("invalid commit %s", id))
			return
		}
	}
	load := func(ctx context.Context, id string) (map[string]any, error) { return ancestryCommit(ctx, repo, id) }
	if strings.HasSuffix(r.URL.Path, "/is-ancestor") {
		ok, e := repo.Reachable(r.Context(), lineage, a, "commit")
		if e != nil {
			storageFail(w, e)
			return
		}
		if !ok {
			storageFail(w, &storageError{404, "not_found", map[string]string{"commit": a}})
			return
		}
		ancestor, e := walkIsAncestor(r.Context(), a, b, load)
		if e != nil {
			storageFail(w, e)
			return
		}
		jsonReply(w, 200, map[string]bool{"ancestor": ancestor})
		return
	}
	best, tree, err := mergeBase(r.Context(), repo, a, b)
	if err != nil {
		storageFail(w, err)
		return
	}
	if best == "" {
		jsonReply(w, 200, map[string]any{"base": nil, "tree": nil})
		return
	}
	jsonReply(w, 200, map[string]string{"base": best, "tree": tree})
}

func mergeBase(ctx context.Context, repo *objects.Repository, a, b string) (string, string, error) {
	load := func(ctx context.Context, id string) (map[string]any, error) { return ancestryCommit(ctx, repo, id) }
	nodes, err := walkAncestry(ctx, a, b, load)
	if err != nil {
		return "", "", err
	}
	// Any parent of a common ancestor is dominated, as are all its ancestors.
	// A single propagation pass visits each dominated edge at most once.
	dominated := map[string]bool{}
	queue := []string{}
	for _, n := range nodes {
		if n.generations[0] >= 0 && n.generations[1] >= 0 {
			queue = append(queue, n.parents...)
		}
	}
	for len(queue) > 0 {
		id := queue[0]
		queue = queue[1:]
		if dominated[id] {
			continue
		}
		dominated[id] = true
		queue = append(queue, nodes[id].parents...)
	}
	best := ""
	for id, n := range nodes {
		if n.generations[0] < 0 || n.generations[1] < 0 || dominated[id] {
			continue
		}
		if best == "" || n.time > nodes[best].time || n.time == nodes[best].time && id > best {
			best = id
		}
	}
	if best == "" {
		return "", "", nil
	}
	return best, nodes[best].tree, nil
}
