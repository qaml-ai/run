package image

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type fakeDevices struct{ calls []string }

func (f *fakeDevices) Run(_ context.Context, n string, a ...string) error {
	f.calls = append(f.calls, n+" "+strings.Join(a, " "))
	return nil
}
func TestCleanupScoped(t *testing.T) {
	a, b := t.TempDir(), t.TempDir()
	if dmPrefix(a) == dmPrefix(b) || len(dmPrefix(a)) != 17 {
		t.Fatal("prefix")
	}
	for i, d := range []string{a, b} {
		p := filepath.Join(d, "mounts", "j")
		os.MkdirAll(p, 0700)
		v := struct{ DM, OriginDM, CowLoop, NBD, DestLoop string }{DM: dmPrefix(d) + "j", OriginDM: dmPrefix(d) + "j-o", CowLoop: "/dev/loop2", NBD: "/dev/nbd" + string(rune('0'+i)), DestLoop: "/dev/loop" + string(rune('0'+i))}
		bytes, _ := json.Marshal(v)
		os.WriteFile(filepath.Join(p, "state.json"), bytes, 0600)
	}
	f := &fakeDevices{}
	if e := Cleanup(context.Background(), a, f); e != nil {
		t.Fatal(e)
	}
	if len(f.calls) != 5 {
		t.Fatal(f.calls)
	}
	if f.calls[0] != "dmsetup remove "+dmPrefix(a)+"j" || f.calls[1] != "dmsetup remove "+dmPrefix(a)+"j-o" {
		t.Fatal(f.calls)
	}
	for _, c := range f.calls {
		if strings.Contains(c, dmPrefix(b)) || strings.Contains(c, "/dev/nbd1") || strings.Contains(c, "/dev/loop1") {
			t.Fatal(c)
		}
	}
	if _, e := os.Stat(filepath.Join(b, "mounts", "j", "state.json")); e != nil {
		t.Fatal(e)
	}
	entries, _ := os.ReadDir(filepath.Join(a, "mounts"))
	if len(entries) != 0 {
		t.Fatal(entries)
	}
}
