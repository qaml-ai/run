package api

import (
	"fmt"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestInvalidRequestNamesFieldOrRule(t *testing.T) {
	s := storageServer(t, store.Local{Dir: t.TempDir()})
	c := commit(t, s, "l", "", nil)
	tree := c["tree"].(string)
	id := c["commit"].(string)
	for _, tc := range []struct{ method, route, body, key, message string }{
		{"POST", "commits", `{"parent":null,"author":"a"}`, "", `unknown field parent`},
		{"POST", "commits", `{"author":"a"}`, "", "missing field parents"},
		{"POST", "commits", `{}`, "", "missing field parents"},
		{"POST", "commits", `{"parents":null,"author":"a"}`, "", "parents"},
		{"POST", "commits", fmt.Sprintf(`{"parents":[%q,%q,%q],"author":"a"}`, id, id, id), "", "parents: at most 2"},
		{"POST", "commits", `{"parents":[],"author":""}`, "", "author"},
		{"POST", "commits", `{"parents":[],"author":"a","message":"\u0000"}`, "", "message"},
		{"POST", "commits", `{"parents":[],"author":"a","changes":[{"path":"../x","blob":"x"}]}`, "", `invalid path ../x`},
		{"POST", "commits", `{"parents":[],"author":"a","changes":[{"path":"x","mode":"abc"}]}`, "", `invalid mode abc`},
		{"POST", "commits", `{"parents":[],"author":"a","changes":[{"path":"x","delete":true,"blob":"x"}]}`, "", "delete"},
		{"POST", "commits", `{"parents":[],"author":"a","changes":[{"path":"x"}]}`, "", "blob"},
		{"POST", "commits", `{"parents":[],"author":"a","trailers":{"bad:key":"x"}}`, "", "invalid trailer key bad:key"},
		{"POST", "commits", `{"parents":[],"author":"a","trailers":{"key":"a\nb"}}`, "", "invalid trailer value key"},
		{"POST", "commits", `{"parents":[],"author":"a","baseTree":"bad"}`, "", "baseTree"},
		{"POST", "commits", `{"parents":[],"author":"a","changes":[{"path":"x","surprise":1}]}`, "", `unknown field surprise`},
		{"POST", "commits", `{"parents":[],"author":"a","time":"bad"}`, "", "time"},
		{"POST", "commits", `{} {}`, "", "JSON body"},
		{"POST", "commits", `{`, "", "JSON body"},
		{"POST", "read", `{"tree":"` + tree + `","paths":[],"extra":true}`, "", `unknown field extra`},
		{"POST", "read", `{"tree":"` + tree + `","paths":[],"maxBytes":-1}`, "", "maxBytes"},
		{"POST", "read", `{"tree":"` + tree + `","paths":["../x"]}`, "", `invalid path ../x`},
		{"POST", "merge", `{"extra":true}`, "", `unknown field extra`},
		{"POST", "merge", `{"mode":"bad"}`, "", "mode"},
		{"POST", "merge", `{"mode":"merge","base":"bad"}`, "", "base/ours/theirs"},
		{"GET", "trees/" + tree + "?limit=0", "", "", "limit"},
		{"GET", "trees/" + tree + "?path=../x", "", "", `invalid path ../x`},
		{"GET", "trees/" + tree + "?after=absent", "", "", "after"},
		{"GET", "trees/bad", "", "", "tree"},
		{"GET", "commits/bad", "", "", "commit"},
		{"GET", "diff?from=bad&to=" + tree, "", "", "from/to"},
		{"GET", "diff?from=" + tree + "&to=" + tree + "&path=../x", "", "", `invalid path ../x`},
		{"GET", "grep?tree=" + tree + "&limit=bad", "", "", "limit"},
		{"GET", "grep?tree=" + tree + "&context=2001", "", "", "context"},
		{"GET", "grep?tree=" + tree + "&q=%5B&regex=1", "", "", "q"},
		{"GET", "grep?tree=" + tree + "&path=%5B", "", "", "path"},
		{"POST", "commits", `{}`, strings.Repeat("x", 257), "Idempotency-Key"},
	} {
		t.Run(tc.route+"/"+tc.message, func(t *testing.T) {
			v := response(t, callStorage(t, s, "l", tc.method, tc.route, []byte(tc.body), tc.key, 400))
			err := v["error"].(map[string]any)
			if err["code"] != "invalid_request" || !strings.Contains(err["message"].(string), tc.message) {
				t.Fatal(v)
			}
		})
	}
	v := response(t, callStorage(t, s, "bad%0Aline", "GET", "commits", nil, "", 400))
	if !strings.Contains(v["error"].(map[string]any)["message"].(string), "lineage") {
		t.Fatal(v)
	}
}
