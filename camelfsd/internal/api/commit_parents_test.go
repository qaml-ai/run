package api

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestCommitParentsRoundTrip(t *testing.T) {
	s := storageServer(t, store.Local{Dir: t.TempDir()})
	first := commit(t, s, "l", "", []change{{Path: "first", Blob: put(t, s, "l", "first")}})
	second := commit(t, s, "l", "", []change{{Path: "second", Blob: put(t, s, "l", "second")}})
	parents := []string{first["commit"].(string), second["commit"].(string)}
	post := response(t, callStorage(t, s, "l", "POST", "commits", map[string]any{"parents": parents, "author": "agent:test", "message": "merge", "time": 123}, "merge", 201))
	wantParents := []any{parents[0], parents[1]}
	if post["tree"] != first["tree"] || !reflect.DeepEqual(post["parents"], wantParents) || post["time"] != float64(123) || post["changed"] != float64(0) || post["bytes"] != float64(0) {
		t.Fatal(post)
	}
	get := response(t, callStorage(t, s, "l", "GET", "commits/"+post["commit"].(string), nil, "", 200))
	if !reflect.DeepEqual(get["parents"], wantParents) || get["tree"] != first["tree"] || get["time"] != post["time"] {
		t.Fatal(get)
	}
	body := fmt.Sprintf("tree %s\nparent %s\nparent %s\nauthor agent:test <agent:test@camelfs> 123 +0000\ncommitter camelfs <camelfs@camelfs> 123 +0000\n\nmerge\n\n", first["tree"], parents[0], parents[1])
	raw, e := s.repo.ForLineage("l").Object(context.Background(), post["commit"].(string), "commit")
	if e != nil || string(raw) != body || post["commit"] != store.GitHash("commit", []byte(body)) {
		t.Fatalf("git commit mismatch: %q %v", raw, e)
	}
	replay := response(t, callStorage(t, s, "l", "POST", "commits", nil, "merge", 201))
	if !reflect.DeepEqual(post, replay) {
		t.Fatal(replay)
	}
	// Reversing the parent order changes the inherited tree.
	reverse := response(t, callStorage(t, s, "l", "POST", "commits", map[string]any{"parents": []string{parents[1], parents[0]}, "author": "a"}, "", 201))
	if reverse["tree"] != second["tree"] {
		t.Fatal(reverse)
	}
	for _, tc := range []struct {
		name, fields, tree string
		parents            []any
	}{
		{"empty", `"parents":[],`, "4b825dc642cb6eb9a060e54bf8d69288fbee4904", []any{}},
		{"one", fmt.Sprintf(`"parents":[%q],`, parents[0]), first["tree"].(string), []any{parents[0]}},
		{"explicit-base", fmt.Sprintf(`"parents":[%q,%q],"baseTree":%q,`, parents[0], parents[1], second["tree"]), second["tree"].(string), wantParents},
		{"null-base", fmt.Sprintf(`"parents":[%q,%q],"baseTree":null,`, parents[0], parents[1]), "4b825dc642cb6eb9a060e54bf8d69288fbee4904", wantParents},
	} {
		t.Run(tc.name, func(t *testing.T) {
			before := time.Now().Unix()
			v := response(t, callStorage(t, s, "l", "POST", "commits", []byte(`{`+tc.fields+`"author":"a"}`), "", 201))
			if v["tree"] != tc.tree || !reflect.DeepEqual(v["parents"], tc.parents) || v["time"].(float64) < float64(before) || v["time"].(float64) > float64(time.Now().Unix()) {
				t.Fatal(v)
			}
		})
	}
	other := commit(t, s, "other", "", nil)["commit"].(string)
	for _, tc := range []struct{ fields, code string }{
		{`"parents":[],"parent":null`, "invalid_request"},
		{fmt.Sprintf(`"parents":[%q],"parent":%q`, parents[0], parents[0]), "invalid_request"},
		{`"parents":null,"parent":null`, "invalid_request"},
		{`"Parents":[],"Parent":null`, "invalid_request"},
		{fmt.Sprintf(`"parents":[%q,%q,%q]`, parents[0], parents[1], parents[0]), "invalid_request"},
		{fmt.Sprintf(`"parents":[%q]`, strings.Repeat("a", 40)), "unknown_commit"},
		{fmt.Sprintf(`"parents":[%q,%q]`, parents[0], other), "unknown_commit"},
		{`"parents":["bad"]`, "unknown_commit"},
		{`"parents":"bad"`, "invalid_request"},
		{`"message":"absent"`, "invalid_request"},
		{`"parents":null`, "invalid_request"},
		{`"parent":null`, "invalid_request"},
		{`"parent":null,"unexpected":true`, "invalid_request"},
	} {
		v := response(t, callStorage(t, s, "l", "POST", "commits", []byte(`{`+tc.fields+`,"author":"a"}`), "", 400))
		err := v["error"].(map[string]any)
		if tc.code == "invalid_request" && !strings.Contains(strings.ToLower(err["message"].(string)), "parent") {
			t.Fatal(tc.fields, v)
		}
		if err["code"] != tc.code {
			t.Fatal(tc.fields, v)
		}
	}
}
