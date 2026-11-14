package compute

import (
	"errors"
	"io"
	"path/filepath"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestUnitResultIntegrity(t *testing.T) {
	objects := store.Local{Dir: t.TempDir()}
	want := []byte(`{"exit":0}`)
	v := VM{CreateRequest: CreateRequest{ID: "vm", Lineage: "tenant"}, Phase: Ended, ResultRef: "results/tenant/vm",
		ResultBytes: int64(len(want)), ResultSha256: root.Hash(want)}
	for _, tc := range []struct {
		name, body string
		err        error
	}{
		{"valid", string(want), nil},
		{"tampered", `{"exit":1}`, ErrResultCorrupt},
		{"long", string(want) + " ", ErrResultCorrupt},
		{"short", "{}", ErrResultCorrupt},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := store.Atomic(filepath.Join(objects.Dir, v.ResultRef), []byte(tc.body)); err != nil {
				t.Fatal(err)
			}
			r, size, err := openResult(t.Context(), objects, v)
			if err != nil || size != v.ResultBytes {
				t.Fatalf("open: %d, %v", size, err)
			}
			defer r.Close()
			got, err := io.ReadAll(r)
			if !errors.Is(err, tc.err) || tc.err == nil && string(got) != tc.body {
				t.Fatalf("read: %q, %v", got, err)
			}
		})
	}
}
