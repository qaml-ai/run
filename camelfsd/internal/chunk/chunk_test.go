package chunk

import (
	"os"
	"testing"
)

func TestSparseAndRanges(t *testing.T) {
	f, e := os.CreateTemp(t.TempDir(), "image")
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	if e = f.Truncate(3 * Size); e != nil {
		t.Fatal(e)
	}
	f.WriteAt([]byte("data"), Size+17)
	var nonzero []int64
	e = (Chunker{}).File(f, 3*Size, func(o int64, h string, b []byte) error {
		if h != "" {
			nonzero = append(nonzero, o)
		}
		return nil
	})
	if e != nil || len(nonzero) != 1 || nonzero[0] != Size {
		t.Fatal(nonzero, e)
	}
	n := 0
	e = (Chunker{}).Ranges(f, 3*Size, []Range{{Size + 1, 1}, {Size + 7, 1}}, func(o int64, h string, b []byte) error {
		n++
		if o != Size || h == "" {
			t.Fatal(o, h)
		}
		return nil
	})
	if e != nil || n != 1 {
		t.Fatal(n, e)
	}
}
