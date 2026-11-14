package image

import (
	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"reflect"
	"testing"
)

func TestSparseHolesOnlyReadParentChunks(t *testing.T) {
	const size = int64(4 << 30)
	if got := rangesFromExtents(nil, size, nil); len(got) != 0 {
		t.Fatal(got)
	}
	got := rangesFromExtents(nil, size, map[string]string{"262144": "hash"})
	want := []chunk.Range{{Offset: root.ChunkSize, Length: root.ChunkSize}}
	if !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
	// A hole inside a parent chunk still hashes the chunk and catches a punch.
	got = rangesFromExtents([]extent{{Logical: 0, Length: 4096, Flags: 0x2000}}, size, map[string]string{"0": "hash"})
	want = []chunk.Range{{Offset: 4096, Length: root.ChunkSize - 4096}}
	if !reflect.DeepEqual(got, want) {
		t.Fatal(got)
	}
}
