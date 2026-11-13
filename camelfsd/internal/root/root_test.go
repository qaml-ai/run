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
