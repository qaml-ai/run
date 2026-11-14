package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/auth"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestRefsRoutes(t *testing.T) {
	table := func(keys ...string) ddbtest.Schema {
		var schema ddbtest.Schema
		for i, key := range keys {
			kind := types.KeyTypeHash
			if i == 1 {
				kind = types.KeyTypeRange
			}
			schema.Keys = append(schema.Keys, types.KeySchemaElement{AttributeName: aws.String(key), KeyType: kind})
			schema.Attributes = append(schema.Attributes, types.AttributeDefinition{AttributeName: aws.String(key), AttributeType: types.ScalarAttributeTypeS})
		}
		return schema
	}
	client, lineages := ddbtest.Table(t, table("lineage"))
	_, refTable := ddbtest.Table(t, table("lineage", "name"))
	db, err := refs.OpenStorage(filepath.Join(t.TempDir(), "storage.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	repo := &objects.Repository{DB: db, Store: store.Local{Dir: t.TempDir()}, TempDir: t.TempDir()}
	s := NewStorageServer(repo, "test", nil)
	now := time.UnixMilli(1_800_000_000_000)
	s.ConfigureRefs(client, refTable, lineages, func() time.Time { return now })
	const lineage = "t:repo"
	runtime := auth.Claims{Subject: "runtime:test", Lineage: lineage, Access: "w", Refs: []string{"**"}}
	var claims = runtime
	s.authorize = func(_ http.ResponseWriter, r *http.Request) *http.Request {
		return r.WithContext(context.WithValue(r.Context(), claimsKey{}, claims))
	}
	call := func(method, path string, body any, key string, status int, code string) map[string]any {
		t.Helper()
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req := httptest.NewRequest(method, "/v1/lineages/"+lineage+path, strings.NewReader(string(raw)))
		if key != "" {
			req.Header.Set("Idempotency-Key", key)
		}
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		if rec.Code != status {
			t.Fatalf("%s %s: got %d %s, want %d", method, path, rec.Code, rec.Body, status)
		}
		if status == 204 {
			return nil
		}
		var result map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &result); err != nil {
			t.Fatal(err)
		}
		if code != "" && result["error"].(map[string]any)["code"] != code {
			t.Fatalf("%s %s: %v", method, path, result)
		}
		return result
	}
	details := func(body map[string]any) map[string]any {
		return body["error"].(map[string]any)["details"].(map[string]any)
	}
	put := func(tenant string) map[string]string {
		return map[string]string{"tenant": tenant, "kind": "workspace", "defaultBranch": "main"}
	}
	first := call("PUT", "", put("t"), "new-lineage", 201, "")
	if got := call("PUT", "", put("t"), "new-lineage", 201, ""); !reflect.DeepEqual(got, first) {
		t.Fatal(got)
	}
	call("PUT", "", put("t"), "", 200, "")
	call("PUT", "", put("other"), "", 409, "lineage_conflict")
	call("GET", "", nil, "", 200, "")

	blob := call("PUT", "/blobs", map[string]string{"body": "seed"}, "", 201, "")["blob"].(string)
	commit := func(parents []string, paths ...string) (string, string) {
		t.Helper()
		changes := make([]map[string]string, 0, len(paths))
		for _, path := range paths {
			changes = append(changes, map[string]string{"path": path, "blob": blob})
		}
		result := call("POST", "/commits", map[string]any{"parents": parents, "changes": changes, "author": "agent:test", "message": "test", "time": 1000}, "", 201, "")
		return result["commit"].(string), result["tree"].(string)
	}
	base, baseTree := commit([]string{}, "a")
	left, _ := commit([]string{base}, "sub/left")
	right, _ := commit([]string{base}, "right")
	merge, mergeTree := commit([]string{left, right}, "sub/right")
	ref := func(name, version string, expiry *int64) map[string]any {
		body := map[string]any{"name": name, "version": version, "owner": "agent:test"}
		if expiry != nil {
			body["expiresAt"] = *expiry
		}
		return body
	}
	main := call("POST", "/refs", ref("main", base, nil), "create", 201, "")
	if main["createdBy"] != runtime.Subject || main["tree"] != baseTree {
		t.Fatal(main)
	}
	call("POST", "/refs", ref("main", base, nil), "", 409, "ref_exists")
	call("POST", "/refs", ref("unknown", strings.Repeat("a", 40), nil), "", 400, "unknown_commit")
	call("POST", "/refs", ref("../invalid", base, nil), "", 400, "invalid_request")
	call("POST", "/refs", ref("fork/a", right, nil), "", 201, "") // Rule 4.
	cas := func(name, target, expect, key string, status int, code string) map[string]any {
		return call("POST", "/refs/"+name+"/cas", map[string]string{"commit": target, "expect": expect}, key, status, code)
	}
	expectUnchanged := func(name string, old map[string]any) {
		t.Helper()
		if got := call("GET", "/refs/"+name, nil, "", 200, ""); !reflect.DeepEqual(got, old) {
			t.Fatalf("ref changed: %v; before: %v", got, old)
		}
	}
	cas("missing", left, base, "", 404, "ref_not_found")
	cas("main", left, "", "", 400, "invalid_request")
	cas("main", left, right, "", 412, "stale")
	expectUnchanged("main", main)
	moved := cas("main", left, base, "move", 200, "") // Rule 1.
	if moved["bytes"] != float64(0) || moved["files"] != float64(2) || len(moved["diff"].([]any)) != 1 {
		t.Fatal(moved)
	}
	if got := cas("main", left, base, "move", 200, ""); !reflect.DeepEqual(got, moved) {
		t.Fatal(got)
	}
	beforeMerge := call("GET", "/refs/main", nil, "", 200, "")
	if got := details(cas("main", right, left, "", 409, "not_fast_forward")); got["current"] != left {
		t.Fatal(got)
	}
	expectUnchanged("main", beforeMerge)
	result := cas("main", merge, left, "", 200, "") // Rule 1, ordered merge.
	if !reflect.DeepEqual(result["parents"], []any{left, right}) || result["tree"] != mergeTree {
		t.Fatal(result)
	}
	result = cas("fork/a", merge, right, "", 200, "") // Rule 2 follows the second parent.
	if len(result["diff"].([]any)) != 3 {
		t.Fatal(result)
	}
	result = cas("main", merge, merge, "", 200, "") // Rule 3.
	if len(result["diff"].([]any)) != 0 {
		t.Fatal(result)
	}

	// A recorded commit with too many parents is impossible through the commit
	// route. Seed one directly to verify the CAS refusal and ordered details.
	seed := func(tree string, parents ...string) string {
		t.Helper()
		raw := "tree " + tree + "\n"
		for _, p := range parents {
			raw += "parent " + p + "\n"
		}
		raw += "\ntest\n"
		id, err := repo.PutObject(t.Context(), lineage, "commit", []byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	badParent := seed(mergeTree, merge, left, right)
	before := call("GET", "/refs/main", nil, "", 200, "")
	got := details(cas("main", badParent, merge, "", 409, "bad_parent"))
	if !reflect.DeepEqual(got["parents"], []any{merge, left, right}) || got["current"] != merge {
		t.Fatal(got)
	}
	expectUnchanged("main", before)

	// Simulate an imported pre-fork head whose tree is recorded on the ref but
	// whose commit object is absent. Rule 2 must compare the id before loading it.
	preFork := strings.Repeat("b", 40)
	if err := s.refs.Create(t.Context(), lineage, "fork/pre", refstore.Target{Version: preFork, Tree: baseTree}, nil, nil); err != nil {
		t.Fatal(err)
	}
	bridge := seed(baseTree, preFork)
	tip := seed(mergeTree, bridge)
	cas("fork/pre", tip, preFork, "", 200, "")
	deep := seed(mergeTree, strings.Repeat("c", 40))
	deepRefs := refstore.New(client, refTable, func() time.Time { return now }, longHistory{})
	deepRefs.GuardLineages(lineages)
	normal := s.refs
	s.refs = deepRefs
	got = details(cas("main", deep, merge, "", 409, "not_fast_forward"))
	s.refs = normal
	if got["reason"] != "too_deep" || got["current"] != merge {
		t.Fatal(got)
	}
	expectUnchanged("main", before)

	claims.Refs = []string{"fork/*"}
	call("GET", "/refs/main", nil, "", 403, "forbidden")
	call("POST", "/refs", ref("fork/a/b", base, nil), "", 403, "forbidden")
	page := call("GET", "/refs?limit=1", nil, "", 200, "")
	if page["next"] != "fork/a" || len(page["refs"].([]any)) != 1 {
		t.Fatal(page)
	}
	page = call("GET", "/refs?prefix=fork/&after=fork/a", nil, "", 200, "")
	if _, ok := page["next"]; ok || len(page["refs"].([]any)) != 1 {
		t.Fatal(page)
	}
	claims.Access = "r"
	call("DELETE", "/refs/fork/a", nil, "", 403, "forbidden")
	claims = runtime
	call("PUT", "/refs/main/watchers/workflow:w", nil, "", 204, "")
	call("DELETE", "/refs/main/watchers/workflow:w", nil, "", 204, "")
	call("PUT", "/refs/main/watchers/invalid", nil, "", 400, "invalid_request")
	holder := map[string]any{"host": "host", "boot": 1, "mount": "mount"}
	lease := map[string]any{"holder": holder, "ttlMs": 1000}
	claims.Subject = "agent:test"
	call("POST", "/refs/main/lease", lease, "", 403, "forbidden")
	call("DELETE", "", nil, "", 403, "forbidden")
	claims = runtime
	call("POST", "/refs/main/lease", map[string]any{"holder": holder, "ttlMs": 600001}, "", 400, "invalid_request")
	taken := call("POST", "/refs/main/lease", lease, "lease", 200, "")
	if taken["version"] != merge || taken["tree"] != mergeTree {
		t.Fatal(taken)
	}
	if got := call("POST", "/refs/main/lease", lease, "lease", 200, ""); !reflect.DeepEqual(got, taken) {
		t.Fatal(got)
	}
	call("POST", "/refs/main/lease", lease, "", 409, "held")
	leased := call("GET", "/refs/main", nil, "", 200, "")
	if !reflect.DeepEqual(leased["holder"], map[string]any{"host": "host", "boot": float64(1), "mount": "mount"}) {
		t.Fatal(leased)
	}
	call("DELETE", "/refs/main?expect="+left, nil, "", 412, "stale")
	call("DELETE", "/refs/main", nil, "", 409, "held")
	cas("main", merge, merge, "", 409, "fenced")
	if got := details(call("DELETE", "", nil, "", 409, "held")); !reflect.DeepEqual(got["held"], []any{"main"}) {
		t.Fatal(got)
	}
	expectUnchanged("main", leased)
	claims = auth.Claims{Subject: "host:one", Lineage: lineage, Access: "w", Refs: []string{"main"},
		Fence: &auth.Fence{Holder: "host:1:mount", Epoch: int64(taken["epoch"].(float64))}}
	cas("main", merge, merge, "", 200, "")
	renew := call("POST", "/refs/main/lease/renew", map[string]int{"ttlMs": 2000}, "", 200, "")
	now = time.UnixMilli(int64(renew["deadline"].(float64)))
	call("POST", "/refs/main/lease/renew", map[string]int{"ttlMs": 1000}, "", 409, "fenced")
	call("DELETE", "/refs/main/lease", nil, "", 409, "fenced")
	claims = runtime
	next := call("POST", "/refs/main/lease", lease, "", 200, "")
	if next["epoch"] != taken["epoch"].(float64)+1 {
		t.Fatal(next)
	}
	claims.Refs = []string{"main"}
	claims.Fence = &auth.Fence{Holder: "host:1:mount", Epoch: int64(next["epoch"].(float64))}
	call("DELETE", "/refs/main/lease", nil, "release", 204, "")
	call("DELETE", "/refs/main/lease", nil, "release", 204, "")
	claims = runtime
	call("DELETE", "/refs/main?expect="+merge, nil, "", 204, "")
	reborn := call("POST", "/refs", ref("main", base, nil), "", 201, "")
	if reborn["leaseEpoch"] != next["epoch"] {
		t.Fatal(reborn)
	}

	expiry := now.Add(time.Second).UnixMilli()
	call("POST", "/refs", ref("temp", base, &expiry), "", 201, "")
	temp := call("POST", "/refs/temp/lease", lease, "", 200, "")
	now = time.UnixMilli(expiry)
	call("GET", "/refs/temp", nil, "", 404, "ref_not_found")
	page = call("GET", "/refs?prefix=temp", nil, "", 200, "")
	if len(page["refs"].([]any)) != 0 {
		t.Fatal(page)
	}
	reborn = call("POST", "/refs", ref("temp", base, nil), "", 201, "")
	if reborn["leaseEpoch"] != temp["epoch"] {
		t.Fatal(reborn)
	}

	call("POST", "/refs/main/lease", lease, "", 200, "")
	result = call("DELETE", "/refs?owner=agent:test", nil, "", 200, "")
	if !reflect.DeepEqual(result["held"], []any{"main"}) || !reflect.DeepEqual(result["deleted"], []any{"fork/a", "temp"}) {
		t.Fatal(result)
	}
	now = now.Add(time.Second)
	call("DELETE", "", nil, "delete-lineage", 204, "")
	call("DELETE", "", nil, "delete-lineage", 204, "")
	call("GET", "", nil, "", 410, "lineage_deleted")
	call("GET", "/refs", nil, "", 410, "lineage_deleted")
	call("GET", "/commits/"+base, nil, "", 410, "lineage_deleted")
	call("PUT", "", put("t"), "", 410, "lineage_deleted")
	if _, err := s.refs.Get(t.Context(), lineage, "main"); err == nil {
		t.Fatal("lineage refs were left live")
	}
}

type longHistory struct{}

func (longHistory) Parents(_ context.Context, _, id string) ([]string, bool, error) {
	n, _ := strconv.ParseUint(strings.TrimLeft(id, "0"), 16, 64)
	if n > 1_000_000 {
		n = 0
	}
	return []string{fmt.Sprintf("%040x", n+1)}, true, nil
}
