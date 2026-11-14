package computehost

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/vmhost"
)

type execInputStore struct {
	store.Store
	data string
	keys []string
}

func (s *execInputStore) Open(_ context.Context, key string) (io.ReadCloser, error) {
	s.keys = append(s.keys, key)
	return io.NopCloser(strings.NewReader(s.data)), nil
}

func TestExecBlobStaging(t *testing.T) {
	const data = "stdin bytes"
	const lineage = "boot-lineage"
	size := int64(len(data))
	blob := hostwire.ExecBlob{
		Blob: store.GitHash("blob", []byte(data)), Size: &size,
		SHA256: fmt.Sprintf("%x", sha256.Sum256([]byte(data))),
	}
	fake := &execInputStore{data: data}
	dir := t.TempDir()
	f, err := stageExecInput(t.Context(), fake, dir, lineage, blob)
	if err != nil {
		t.Fatal(err)
	}
	got, err := io.ReadAll(f)
	f.Close()
	if err != nil || string(got) != data || len(fake.keys) != 1 || fake.keys[0] != lineage+"/o/"+blob.Blob {
		t.Fatalf("staged %q with %v, fetched %v", got, err, fake.keys)
	}

	startedAt := int64(1)
	// A VM without a control channel can pass lookup but cannot dispatch an exec.
	// These cases must return before reaching its subscription.
	h := &Host{Config: Config{Mounts: &image.Manager{Store: fake, Config: image.Config{Data: dir}}},
		vms: map[string]*session{"vm": {row: record{Spec: hostwire.BootSpec{ID: "vm", Lineage: lineage}, StartedAt: &startedAt}, vm: new(vmhost.VM)}},
	}
	short, long := size-1, size+1
	for _, tc := range []struct {
		name, id, sha, code string
		size                *int64
		status, fetches     int
	}{
		{"wrong hash", blob.Blob, strings.Repeat("0", 64), "blob_mismatch", &size, 502, 1},
		{"too few bytes", blob.Blob, blob.SHA256, "blob_mismatch", &long, 502, 1},
		{"too many bytes", blob.Blob, blob.SHA256, "blob_mismatch", &short, 502, 1},
		{"non-hex key", strings.Repeat("z", 40), blob.SHA256, "invalid_request", &size, 400, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fake.keys = nil
			q := hostwire.ExecRequest{ExecID: "exec", Command: "true", TimeoutS: 10,
				StdinBlob: &hostwire.ExecBlob{Blob: tc.id, Size: tc.size, SHA256: tc.sha}}
			body, err := json.Marshal(q)
			if err != nil {
				t.Fatal(err)
			}
			w := httptest.NewRecorder()
			h.Handler().ServeHTTP(w, httptest.NewRequest(http.MethodPost, "/v1/vms/vm/exec", strings.NewReader(string(body))))
			var out errorEnvelope
			if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil || w.Code != tc.status || out.Error.Code != tc.code {
				t.Fatalf("HTTP %d %s, want %d %s", w.Code, w.Body, tc.status, tc.code)
			}
			if len(fake.keys) != tc.fetches || tc.fetches != 0 && fake.keys[0] != lineage+"/o/"+blob.Blob {
				t.Fatalf("unexpected store requests: %v", fake.keys)
			}
		})
	}
}
