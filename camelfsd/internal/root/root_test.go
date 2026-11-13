package root

import (
	"reflect"
	"strings"
	"testing"
)

func TestCanonical(t *testing.T) {
	r := Root{V: 1, FSType: "ext4", VirtualSize: 262144, Chunks: map[string]string{}}
	b, e := Encode(r)
	if e != nil {
		t.Fatal(e)
	}
	gold := `{"chunks":{},"fsType":"ext4","parentRoot":"","tree":"","v":1,"virtualSize":262144}`
	if string(b) != gold {
		t.Fatalf("%s", b)
	}
	if Hash(b) != "cd30485f9cef5e4a2468b34d897909afddf023ed225602af3b75c30cc9e1abfe" {
		t.Fatalf("golden id %s", Hash(b))
	}
	rr, e := Decode(b)
	if e != nil || !reflect.DeepEqual(r, rr) {
		t.Fatal(rr, e)
	}
	rr.Chunks = map[string]string{"0": strings.Repeat("a", 64)}
	if got := Diff(r, rr); !reflect.DeepEqual(got, []int64{0}) {
		t.Fatal(got)
	}
	if _, e = Decode([]byte(`{"v":2}`)); e == nil {
		t.Fatal("accepted invalid root")
	}
}

func TestLocationEncoding(t *testing.T) {
	h := strings.Repeat("a", 64)
	p := strings.Repeat("b", 64)
	r := Root{V: 1, FSType: "ext4", VirtualSize: ChunkSize, Chunks: map[string]string{"0": h}, Locations: map[string]Location{h: {Pack: p, Index: 2}}}
	b, e := Encode(r)
	if e != nil {
		t.Fatal(e)
	}
	if !strings.Contains(string(b), `"`+h+`":["`+p+`",2]`) {
		t.Fatal(string(b))
	}
	rr, e := Decode(b)
	if e != nil || !reflect.DeepEqual(r, rr) {
		t.Fatal(rr, e)
	}
	for _, idx := range []int{-1, 64} {
		r.Locations[h] = Location{Pack: p, Index: idx}
		if _, e = Encode(r); e == nil {
			t.Fatal("invalid index", idx)
		}
	}
	r.Locations = map[string]Location{}
	if _, e = Encode(r); e == nil {
		t.Fatal("accepted incomplete locations")
	}
	r.Locations = nil
	if _, e = Encode(r); e != nil {
		t.Fatal("legacy root refused", e)
	}
}
