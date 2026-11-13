package api

import (
	"context"
	"errors"
	"fmt"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestAncestryRoutes(t *testing.T) {
	st := store.Local{Dir: t.TempDir()}
	s := storageServer(t, st)
	serial := 0
	makeC := func(parents []string, when int64) map[string]any {
		serial++
		return response(t, callStorage(t, s, "l", "POST", "commits", commitRequest{Parents: parents, Author: "x", Message: fmt.Sprint(serial), Time: &when}, "", 201))
	}
	root := makeC([]string{}, 100)
	a := makeC([]string{root["commit"].(string)}, 1)
	b := makeC([]string{root["commit"].(string)}, 2)
	merge := makeC([]string{a["commit"].(string), b["commit"].(string)}, 3)
	disjoint := makeC([]string{}, 4)
	id := func(c map[string]any) string { return c["commit"].(string) }
	for _, tc := range []struct {
		a, b string
		want bool
	}{{id(root), id(a), true}, {id(a), id(b), false}, {id(a), id(merge), true}, {id(b), id(merge), true}, {id(a), id(a), true}, {id(root), id(disjoint), false}} {
		v := response(t, callStorage(t, s, "l", "GET", "commits/"+tc.a+"/is-ancestor?of="+tc.b, nil, "", 200))
		if v["ancestor"] != tc.want {
			t.Fatal(tc, v)
		}
	}
	for _, tc := range []struct{ a, b, base string }{{id(a), id(b), id(root)}, {id(a), id(merge), id(a)}, {id(b), id(merge), id(b)}, {id(a), id(a), id(a)}, {id(root), id(disjoint), ""}} {
		v := response(t, callStorage(t, s, "l", "GET", "merge-base?a="+tc.a+"&b="+tc.b, nil, "", 200))
		if tc.base == "" {
			if v["base"] != nil || v["tree"] != nil {
				t.Fatal(v)
			}
		} else if v["base"] != tc.base || v["tree"] != root["tree"] {
			t.Fatal(tc, v)
		}
	}
	// Criss-cross: two incomparable best bases. A newer dominated ancestor must
	// never win; equal best-base times pick the lexicographically greatest id.
	c := makeC([]string{id(a), id(b)}, 5)
	d := makeC([]string{id(b), id(a)}, 6)
	v := response(t, callStorage(t, s, "l", "GET", "merge-base?a="+id(c)+"&b="+id(d), nil, "", 200))
	if v["base"] != id(b) {
		t.Fatal(v)
	}
	tie := makeC([]string{id(root)}, 1)
	e := makeC([]string{id(a), id(tie)}, 7)
	f := makeC([]string{id(tie), id(a)}, 8)
	v = response(t, callStorage(t, s, "l", "GET", "merge-base?a="+id(e)+"&b="+id(f), nil, "", 200))
	if v["base"] != max(id(a), id(tie)) {
		t.Fatal(v)
	}
	unknown := strings.Repeat("f", 40)
	for _, route := range []string{"commits/" + unknown + "/is-ancestor?of=" + id(a), "commits/" + id(a) + "/is-ancestor?of=" + unknown, "merge-base?a=" + unknown + "&b=" + id(a)} {
		w := callStorage(t, s, "l", "GET", route, nil, "", 404)
		if !strings.Contains(w.Body.String(), "not_found") || !strings.Contains(w.Body.String(), unknown) {
			t.Fatal(w.Body.String())
		}
	}
	callStorage(t, s, "other", "GET", "merge-base?a="+id(a)+"&b="+id(b), nil, "", 404)
	for route, field := range map[string]string{"merge-base": "a", "merge-base?a=" + id(a): "b", "commits/" + id(a) + "/is-ancestor": "of", "merge-base?a=x&b=" + id(a): "invalid commit x"} {
		w := callStorage(t, s, "l", "GET", route, nil, "", 400)
		if !strings.Contains(w.Body.String(), field) {
			t.Fatal(w.Body.String())
		}
	}
	fresh := storageServer(t, st)
	callStorage(t, fresh, "l", "GET", "commits/"+id(a)+"/is-ancestor?of="+id(merge), nil, "", 200)
}

func TestAncestryWalkCapFailsClosed(t *testing.T) {
	// Synthetic commit store: no commit objects or chain are built on disk.
	for _, count := range []int{ancestryLimit, ancestryLimit + 1} {
		load := func(ctx context.Context, id string) (map[string]any, error) {
			var n int
			fmt.Sscanf(id, "%d", &n)
			parents := []string{}
			if n > 0 {
				parents = append(parents, fmt.Sprint(n-1))
			}
			return map[string]any{"tree": "t", "parents": parents, "time": int64(n)}, nil
		}
		nodes, e := walkAncestry(context.Background(), "0", fmt.Sprint(count-1), load)
		if count == ancestryLimit {
			if e != nil || len(nodes) != count {
				t.Fatal(len(nodes), e)
			}
			continue
		}
		if e == nil || nodes != nil {
			t.Fatal("capped walk returned a result", e)
		}
		w := httptest.NewRecorder()
		storageFail(w, e)
		if w.Code != 413 || !strings.Contains(w.Body.String(), `"code":"too_deep"`) || strings.Contains(w.Body.String(), "ancestor") || strings.Contains(w.Body.String(), "base") {
			t.Fatal(w.Code, w.Body.String())
		}
	}
}

func TestEntryAndDiffSizes(t *testing.T) {
	st := store.Local{Dir: t.TempDir()}
	s := storageServer(t, st)
	b := put(t, s, "l", "abc")
	empty := put(t, s, "l", "")
	target := put(t, s, "l", "../a")
	c := commit(t, s, "l", "", []change{{Path: "a/b/file", Blob: b}, {Path: "link", Blob: target, Mode: "120000"}, {Path: "empty", Blob: empty}, {Path: "deleted", Blob: b}})
	tree := c["tree"].(string)
	for path, mode := range map[string]string{"a": "040000", "a/b": "040000", "a/b/file": "100644", "link": "120000", "empty": "100644"} {
		v := response(t, callStorage(t, s, "l", "GET", "trees/"+tree+"/entry?path="+path, nil, "", 200))
		if v["path"] != path || v["mode"] != mode {
			t.Fatal(v)
		}
		if path == "empty" && v["size"] != float64(0) {
			t.Fatal(v)
		}
	}
	for _, path := range []string{"missing", "a/missing", "link/file", "a/b/file/child"} {
		w := callStorage(t, s, "l", "GET", "trees/"+tree+"/entry?path="+path, nil, "", 404)
		if !strings.Contains(w.Body.String(), "not_in_tree") {
			t.Fatal(w.Body.String())
		}
	}
	w := callStorage(t, s, "other", "GET", "trees/"+tree+"/entry?path=a", nil, "", 404)
	if !strings.Contains(w.Body.String(), "not_found") {
		t.Fatal(w.Body.String())
	}
	for _, path := range []string{"", "/a", "a/", ".", "..", "a/./b", "a/../b", "a//b"} {
		w := callStorage(t, s, "l", "GET", "trees/"+tree+"/entry?path="+url.QueryEscape(path), nil, "", 400)
		want := "invalid path"
		if path == "" {
			want = "missing field path"
		}
		if !strings.Contains(w.Body.String(), want) {
			t.Fatal(w.Body.String())
		}
	}
	next := commit(t, s, "l", tree, []change{{Path: "a/b/file", Mode: "100755"}, {Path: "link", Blob: b}, {Path: "deleted", Delete: true}, {Path: "added", Blob: empty}})["tree"].(string)
	// A wiped local index must use the tree size sidecars, never blob HEADs.
	fresh := storageServer(t, treeOnlyStore{st})
	repo := fresh.repository().ForLineage("l")
	changes, e := treeDiff(context.Background(), repo, tree, next, "")
	if e != nil {
		t.Fatal(e)
	}
	if len(changes) != 4 {
		t.Fatal(changes)
	}
	for _, c := range changes {
		switch c.Status {
		case "added":
			if c.OldSize != nil || c.NewSize == nil || *c.NewSize != 0 {
				t.Fatal(c)
			}
		case "deleted":
			if c.NewSize != nil || c.OldSize == nil || *c.OldSize != 3 {
				t.Fatal(c)
			}
		case "mode":
			if c.OldSize == nil || c.NewSize == nil || *c.OldSize != 3 || *c.NewSize != 3 {
				t.Fatal(c)
			}
		case "modified":
			if c.OldSize == nil || c.NewSize == nil || *c.OldSize != 4 || *c.NewSize != 3 {
				t.Fatal(c)
			}
		}
	}
}

// Cold diffs over new trees must not fetch blob data or HEAD blob metadata.
type treeOnlyStore struct{ store.Store }

func (s treeOnlyStore) Head(ctx context.Context, k string) (store.Info, error) {
	if strings.Contains(k, "/o/") {
		return store.Info{}, errors.New("unexpected blob HEAD")
	}
	return s.Store.Head(ctx, k)
}
func (s treeOnlyStore) Get(ctx context.Context, k string) ([]byte, error) {
	if strings.Contains(k, "/o/") {
		return nil, errors.New("unexpected blob GET")
	}
	return s.Store.Get(ctx, k)
}
