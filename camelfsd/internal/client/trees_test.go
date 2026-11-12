package client_test

import (
	"bytes"
	"encoding/json"
	"github.com/qaml-ai/run/camelfsd/internal/testutil"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/api"
	"github.com/qaml-ai/run/camelfsd/internal/client"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestImportTreeClient(t *testing.T) {
	db, e := refs.Open(filepath.Join(t.TempDir(), "refs.db"))
	if e != nil {
		t.Fatal(e)
	}
	defer db.Close()
	socket := filepath.Join(testutil.SocketDir(t), "s")
	ln, e := net.Listen("unix", socket)
	if e != nil {
		t.Fatal(e)
	}
	server := &http.Server{Handler: &api.Server{Manager: &image.Manager{Refs: db, Store: store.Local{Dir: t.TempDir()}}}}
	go server.Serve(ln)
	defer server.Close()
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "empty"), nil, 0600)
	os.WriteFile(filepath.Join(dir, "file"), []byte("hello"), 0755)
	os.Symlink("file", filepath.Join(dir, "link"))
	os.Mkdir(filepath.Join(dir, ".git"), 0700)
	os.WriteFile(filepath.Join(dir, ".git", "ignored"), []byte("skip"), 0600)
	run := func(args ...string) []byte {
		t.Helper()
		var out bytes.Buffer
		if e := client.Run(append([]string{"--socket", socket}, args...), &out); e != nil {
			t.Fatal(e)
		}
		return out.Bytes()
	}
	var first, second map[string]any
	json.Unmarshal(run("import-tree", "--lineage", "l", "--dir", dir), &first)
	tree := first["tree"].(string)
	json.Unmarshal(run("import-tree", "--lineage", "l", "--dir", dir, "--parent", tree), &second)
	if first["uploadedBlobs"] != float64(3) || second["uploadedBlobs"] != float64(0) || second["tree"] != tree {
		t.Fatal(first, second)
	}
	if string(run("cat", tree, "link")) != "file" {
		t.Fatal("symlink target")
	}
	var listing struct{ Entries []any }
	if e = json.Unmarshal(run("tree", tree), &listing); e != nil || len(listing.Entries) != 3 {
		t.Fatal(listing, e)
	}
}
