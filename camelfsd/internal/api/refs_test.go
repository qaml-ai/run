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
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/auth"
	"github.com/qaml-ai/run/camelfsd/internal/ddb/ddbtest"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func refTableSchema(keys ...string) ddbtest.Schema {
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

func TestRefsRoutes(t *testing.T) {
	client, lineages := ddbtest.Table(t, refTableSchema("lineage"))
	_, refTable := ddbtest.Table(t, refTableSchema("lineage", "name"))
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

	seedBlob := map[string]string{"body": "seed"}
	blob := call("PUT", "/blobs", seedBlob, "", 201, "")["blob"].(string)
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
	if moved["bytes"] != float64(len(`{"body":"seed"}`)) || moved["files"] != float64(2) || len(moved["diff"].([]any)) != 1 {
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
	// The same holder re-acquiring keeps its epoch (a lost reply is retried safely); another holder is refused.
	again := call("POST", "/refs/main/lease", lease, "", 200, "")
	if again["epoch"] != taken["epoch"] {
		t.Fatal(again)
	}
	call("POST", "/refs/main/lease", map[string]any{"holder": map[string]any{"host": "other", "boot": 1, "mount": "mount"}, "ttlMs": 1000}, "", 409, "held")
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

type beforeRefUpdate struct {
	*dynamodb.Client
	before func()
}

func (c *beforeRefUpdate) TransactWriteItems(ctx context.Context, input *dynamodb.TransactWriteItemsInput, opts ...func(*dynamodb.Options)) (*dynamodb.TransactWriteItemsOutput, error) {
	if c.before != nil {
		before := c.before
		c.before = nil
		before()
	}
	return c.Client.TransactWriteItems(ctx, input, opts...)
}

type longHistory struct{}

func (longHistory) Parents(_ context.Context, _, id string) ([]string, bool, error) {
	n, _ := strconv.ParseUint(strings.TrimLeft(id, "0"), 16, 64)
	if n > 1_000_000 {
		n = 0
	}
	return []string{fmt.Sprintf("%040x", n+1)}, true, nil
}

func TestRefMutationRoutes(t *testing.T) {
	client, lineages := ddbtest.Table(t, refTableSchema("lineage"))
	_, refTable := ddbtest.Table(t, refTableSchema("lineage", "name"))
	_, marks := ddbtest.Table(t, refTableSchema("lineage"))
	db, err := refs.OpenStorage(filepath.Join(t.TempDir(), "storage.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	repo := &objects.Repository{DB: db, Store: store.Local{Dir: t.TempDir()}, TempDir: t.TempDir()}
	s := NewStorageServer(repo, "test", nil)
	s.ConfigureRefs(client, refTable, lineages, nil, marks)
	normal := s.refs
	raced := &beforeRefUpdate{Client: client}
	s.refs = refstore.New(raced, refTable, nil, commitParents{repo})
	s.refs.GuardLineages(lineages)
	const l = "test:mutations"
	s.authorize = func(_ http.ResponseWriter, r *http.Request) *http.Request {
		claims := auth.Claims{Subject: "runtime:test", Lineage: l, Access: "w", Refs: []string{"**"}}
		return r.WithContext(context.WithValue(r.Context(), claimsKey{}, claims))
	}
	call := func(method, path string, body any, status int, code string) map[string]any {
		t.Helper()
		var raw string
		switch b := body.(type) {
		case string:
			raw = b
		case nil:
		default:
			data, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			raw = string(data)
		}
		req := httptest.NewRequest(method, "/v1/lineages/"+l+path, strings.NewReader(raw))
		rec := httptest.NewRecorder()
		s.ServeHTTP(rec, req)
		var response map[string]any
		if rec.Code == 204 && status == 204 {
			return nil
		}
		if rec.Code != status || json.Unmarshal(rec.Body.Bytes(), &response) != nil {
			t.Fatalf("%s %s: want %d, got %d %s", method, path, status, rec.Code, rec.Body)
		}
		if code == "" {
			return response
		}
		failure := response["error"].(map[string]any)
		if failure["code"] != code {
			t.Fatalf("%s %s: want %s, got %s", method, path, code, rec.Body)
		}
		details, _ := failure["details"].(map[string]any)
		return details
	}
	meta := func(extra map[string]any) map[string]any {
		body := map[string]any{"author": "agent:test", "message": "mutate", "time": 123}
		for k, v := range extra {
			body[k] = v
		}
		return body
	}
	write := func(name string, edits []map[string]any, extra map[string]any, status int, code string) map[string]any {
		t.Helper()
		body := meta(extra)
		body["changes"] = edits
		return call("POST", "/refs/"+name+"/write", body, status, code)
	}
	create := func(name, version string) {
		t.Helper()
		call("POST", "/refs", map[string]string{"name": name, "version": version, "owner": "agent:test"}, 201, "")
	}
	get := func(name string) map[string]any { return call("GET", "/refs/"+name, nil, 200, "") }
	history := func(version string) map[string]any { return call("GET", "/commits/"+version, nil, 200, "") }
	check := func(got, want any) {
		t.Helper()
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("got %#v, want %#v", got, want)
		}
	}
	version := func(body map[string]any) string { return body["version"].(string) }

	call("PUT", "", map[string]string{"tenant": "test", "kind": "workspace", "defaultBranch": "main"}, 201, "")
	base := call("POST", "/commits", meta(map[string]any{"parents": []string{}, "changes": []any{}}), 201, "")
	baseID := base["commit"].(string)
	create("main", baseID)
	seed := call("PUT", "/blobs", "seed", 201, "")
	call("PUT", "/blobs", "seed", 200, "")
	created := write("main", []map[string]any{{"path": "a", "text": "one", "expectBlob": "none"},
		{"path": "b", "base64": "eA=="}, {"path": "c", "blob": seed["blob"]}}, nil, 201, "")
	check(created["parents"], []any{baseID})
	check(created["files"], float64(3))
	check(created["bytes"], float64(8))
	check(history(version(created))["trailers"], map[string]any{"Camel-Op": "api"})
	old := created["changed"].([]any)[0].(map[string]any)["newBlob"]
	check(write("main", []map[string]any{{"path": "a", "text": "no", "expectBlob": "none"}}, nil, 412, "stale"),
		map[string]any{"current": version(created), "path": "a", "blob": old})
	check(write("main", []map[string]any{}, map[string]any{"expect": baseID}, 412, "stale"),
		map[string]any{"current": version(created)})
	write("main", []map[string]any{{"path": "unknown", "blob": strings.Repeat("f", 40)}}, nil, 400, "unknown_blob")
	write("main", []map[string]any{{"path": "big", "text": strings.Repeat("x", (8<<20)+1)}}, nil, 413, "too_large")
	next := write("main", []map[string]any{{"path": "a", "text": "two", "expectBlob": old},
		{"path": "b", "delete": true}, {"path": "c", "mode": "100755"}},
		map[string]any{"expect": version(created), "trailers": map[string]string{"Camel-Op": "turn"}}, 201, "")
	check(history(version(next))["trailers"], map[string]any{"Camel-Op": "turn"})
	changed := next["changed"].([]any)
	check(changed[0].(map[string]any)["oldSize"], float64(3))
	check(changed[0].(map[string]any)["newSize"], float64(3))
	check(changed[1].(map[string]any)["status"], "deleted")
	check(changed[1].(map[string]any)["mode"], "100644")
	check(changed[2].(map[string]any)["status"], "mode")
	check(changed[2].(map[string]any)["mode"], "100755")

	quota := func(limit int) map[string]any {
		return map[string]any{"limitBytes": limit, "otherBytes": 2}
	}
	checkpoint := write("main", []map[string]any{}, map[string]any{"quota": quota(13)}, 201, "")
	check(checkpoint["bytes"], float64(11))
	check(checkpoint["changed"], []any{})
	before := get("main")
	beforeHistory := history(version(before))
	details := write("main", []map[string]any{{"path": "extra", "text": "z"}}, map[string]any{"quota": quota(13)}, 507, "storage_limit")
	check(details, map[string]any{"limit": float64(13)})
	check(get("main"), before)
	check(history(version(get("main"))), beforeHistory)
	call("POST", "/refs/main/cas", map[string]any{"commit": version(before), "expect": version(before), "quota": quota(13)}, 507, "storage_limit")
	mark, err := client.GetItem(t.Context(), &dynamodb.GetItemInput{TableName: aws.String(marks), ConsistentRead: aws.Bool(true), Key: lineageKey(l)})
	if err != nil || mark.Item["lineage"] == nil {
		t.Fatalf("mark was not enqueued: %v %v", mark, err)
	}
	usage, err := s.refs.ReadUsage(t.Context(), l)
	if err != nil || usage.WrittenSince != 12 {
		t.Fatalf("uncommitted upload must count: %+v %v", usage, err)
	}

	// Change the head after CAS validation, before the DynamoDB condition runs.
	create("race", baseID)
	create("other", baseID)
	unrelated := write("other", []map[string]any{{"path": "other", "text": "side"}}, nil, 201, "")
	moveDuringCAS := func(result map[string]any) {
		t.Helper()
		raced.before = func() {
			_, err := normal.Cas(t.Context(), l, "race", refstore.Move{Kind: "move", Version: version(result), Tree: result["tree"].(string)})
			if err != nil {
				t.Fatal(err)
			}
		}
	}
	moveDuringCAS(unrelated)
	retried := write("race", []map[string]any{{"path": "edit", "text": "win", "expectBlob": "none"}}, nil, 201, "")
	check(retried["parents"], []any{version(unrelated)})
	check(retried["files"], float64(2))
	conflicting := write("race", []map[string]any{{"path": "x", "text": "rival"}}, nil, 201, "")
	// Recreate the ref at the checkpoint before the conflicting change.
	call("DELETE", "/refs/race", nil, 204, "")
	create("race", version(retried))
	moveDuringCAS(conflicting)
	details = write("race", []map[string]any{{"path": "x", "text": "lose", "expectBlob": "none"}}, nil, 412, "stale")
	check(details["current"], version(conflicting))
	check(details["path"], "x")
	check(details["blob"], conflicting["changed"].([]any)[0].(map[string]any)["newBlob"])
	check(version(get("race")), version(conflicting))

	mergeRef := func(name, theirs, mode string, status int, code string) map[string]any {
		t.Helper()
		return call("POST", "/refs/"+name+"/merge", meta(map[string]any{"theirs": theirs, "mode": mode}), status, code)
	}
	create("ff", baseID)
	ff := mergeRef("ff", version(created), "merge", 201, "")
	check(ff, map[string]any{"version": version(created), "tree": created["tree"], "ff": true, "merged": []any{},
		"took": map[string]any{"ours": float64(0), "theirs": float64(3)}})
	mergeRef("ff", version(unrelated), "ff-only", 409, "not_fast_forward")
	check(version(get("ff")), version(created))
	merged := mergeRef("ff", version(unrelated), "merge", 201, "")
	check(merged["ff"], false)
	check(history(version(merged))["parents"], []any{version(created), version(unrelated)})
	create("squash", baseID)
	squash := mergeRef("squash", version(unrelated), "squash", 201, "")
	check(squash["ff"], false)
	check(history(version(squash))["parents"], []any{baseID})
	create("conflict", version(created))
	theirs := write("conflict", []map[string]any{{"path": "a", "text": "different"}}, nil, 201, "")
	before = get("main")
	details = mergeRef("main", version(theirs), "merge", 409, "conflict")
	check(details["conflicts"].([]any)[0].(map[string]any)["path"], "a")
	check(get("main"), before)
	restored := call("POST", "/refs/main/restore", meta(map[string]any{"version": baseID}), 201, "")
	check(restored["tree"], base["tree"])
	check(history(version(restored))["parents"], []any{version(checkpoint)})
	check(history(version(restored))["trailers"], map[string]any{"Camel-Op": "restore"})
	call("POST", "/refs/main/lease", map[string]any{"holder": map[string]any{"host": "h", "boot": 1, "mount": "m"}, "ttlMs": 60000}, 200, "")
	write("main", []map[string]any{}, nil, 409, "held")
}
