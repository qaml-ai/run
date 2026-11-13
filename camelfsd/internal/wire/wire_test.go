package wire

import (
	"bytes"
	"reflect"
	"testing"
)

func TestOptionalFieldsOmitted(t *testing.T) {
	for _, tc := range []struct {
		name  string
		value any
		want  map[string]any
	}{
		{"trailer", Op{End: true}, map[string]any{"path": "", "op": "", "end": true}},
		{"header", Header{V: 1, Kind: "apply", JobID: "first"}, map[string]any{"v": float64(1), "kind": "apply", "jobId": "first"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var frame bytes.Buffer
			if e := Send(&frame, tc.value); e != nil {
				t.Fatal(e)
			}
			var got map[string]any
			if e := JSON(&frame, &got); e != nil {
				t.Fatal(e)
			}
			if !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}
func TestOptionalFieldsRoundTripAndEmptyStrings(t *testing.T) {
	op := Op{Path: "file", Op: "put", Mode: "100644", Size: 12, Target: "link", End: true, Files: 3, Bytes: 12, FreezeMs: 1.5, Skipped: 2, Error: "failed"}
	header := Header{V: 1, Kind: "checkpoint", JobID: "job", BaseTree: "base", FromTree: "from", ToTree: "to", WalkMs: 1.5}
	var frame bytes.Buffer
	if e := Send(&frame, op); e != nil {
		t.Fatal(e)
	}
	var got Op
	if e := JSON(&frame, &got); e != nil || got != op {
		t.Fatal(got, e)
	}
	if e := Send(&frame, header); e != nil {
		t.Fatal(e)
	}
	var h Header
	if e := JSON(&frame, &h); e != nil || h != header {
		t.Fatal(h, e)
	}
	for _, v := range []any{&Op{}, &Header{}} {
		if e := Write(&frame, []byte(`{"error":"","mode":"","target":"","baseTree":"","fromTree":"","toTree":""}`)); e != nil {
			t.Fatal(e)
		}
		if e := JSON(&frame, v); e != nil {
			t.Fatal(e)
		}
	}
}
