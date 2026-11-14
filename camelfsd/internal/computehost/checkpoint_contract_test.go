package computehost

import (
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
)

// The runtime's checkpoint body (backends/workers/src/camelfs/bash.ts checkpointBody, pinned to this fixture by
// backends/workers/test/camelfs-bash.test.ts) passes the host's own validation. Smoke run 2 failed here: the runtime
// sent {"Camel-Tool-Call": …} as trailers, which image.Trailers refuses as an unknown key.
func TestRuntimeCheckpointBodyContract(t *testing.T) {
	raw, err := os.ReadFile("testdata/runtime-checkpoint.json")
	if err != nil {
		t.Fatal(err)
	}
	var q hostwire.CheckpointRequest
	if err := json.Unmarshal(raw, &q); err != nil {
		t.Fatal(err)
	}
	meta, err := checkpointMeta(q)
	if err != nil {
		t.Fatalf("host refused the runtime's checkpoint body: %v", err)
	}
	if *meta.Message != "bash: echo hi" || meta.Trailers.Kind != "auto" || meta.Trailers.Agent != "client_b456abcd" ||
		meta.Trailers.Run != "run_01JD7Q2W3E4R5T6Y" || meta.Time == nil || *meta.Time != 1794672935561 {
		t.Fatalf("decoded %+v %+v", meta, *meta.Trailers)
	}
	for name, body := range map[string]string{
		"the old tool-call trailer": `{"message":"m","time":1,"trailers":{"Camel-Tool-Call":"c1"}}`,
		"a job trailer":             `{"message":"m","time":1,"trailers":{"kind":"job","job":"j"}}`,
		"a bad run":                 `{"message":"m","time":1,"trailers":{"kind":"auto","run":"has space"}}`,
	} {
		var bad hostwire.CheckpointRequest
		if err := json.Unmarshal([]byte(body), &bad); err != nil {
			t.Fatal(err)
		}
		if _, err := checkpointMeta(bad); !errors.Is(err, invalidRequest) {
			t.Fatalf("%s: got %v, want invalid_request", name, err)
		}
	}
}
