package guest

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/image"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestDaemonStreams(t *testing.T) {
	t.Setenv("CAMELFSD_TEST_NO_REFLINK", "1")
	ctx := context.Background()
	data := t.TempDir()
	s := store.Local{Dir: t.TempDir()}
	db, err := refs.Open(filepath.Join(data, "refs.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	m, err := image.New(image.Config{Data: data, HostID: "test", VirtualSize: 16 << 20}, s, cache.New(filepath.Join(data, "cache"), s, 64), db)
	if err != nil {
		t.Fatal(err)
	}
	defer m.Close()
	dir, err := os.MkdirTemp("/tmp", "k1")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir)
	g := fixture(t)
	g.uds = filepath.Join(dir, "v")
	r := (&objects.Repository{Store: s, DB: db}).ForLineage("l")
	files := map[string]objects.File{}
	for _, name := range []string{"old", "exec", "edit", "oldlink"} {
		mode, body := "100644", "old"
		if name == "oldlink" {
			mode, body = "120000", "edit"
		}
		blob, err := r.Upload(ctx, "l", "", int64(len(body)), strings.NewReader(body))
		if err != nil {
			t.Fatal(err)
		}
		files[name] = objects.File{Mode: mode, SHA256: blob.SHA256}
	}
	imported, err := r.Import(ctx, objects.Request{Lineage: "l", Files: files})
	if err != nil {
		t.Fatal(err)
	}
	_, err = m.Mount(ctx, image.Request{Fence: &refs.Fence{Holder: "runtime", Epoch: 1}, Lineage: "l", Tree: imported.Tree, JobID: "j", Vsock: g.uds})
	if err != nil {
		t.Fatal(err)
	}
	req := request{JobID: "j", TimeoutMs: 5000}
	if reply, err := g.apply(ctx, req); err != nil || reply["files"] != 4 {
		t.Fatal(reply, err)
	}
	if target, err := os.Readlink(filepath.Join(g.repo, "oldlink")); err != nil || target != "edit" {
		t.Fatal(target, err)
	}
	for _, edit := range []func() error{
		func() error { return os.Remove(filepath.Join(g.repo, "old")) },
		func() error { return os.Chmod(filepath.Join(g.repo, "exec"), 0755) },
		func() error { return os.WriteFile(filepath.Join(g.repo, "edit"), []byte("changed"), 0644) },
		func() error { return os.Symlink("exec", filepath.Join(g.repo, "newlink")) },
	} {
		if err := edit(); err != nil {
			t.Fatal(err)
		}
	}

	until := time.Now().Add(time.Second)
	for {
		status, err := m.Status(ctx, "j")
		if err != nil {
			t.Fatal(err)
		}
		if status.Applied {
			break
		}
		if time.Now().After(until) {
			t.Fatal("daemon never accepted apply")
		}
		time.Sleep(time.Millisecond)
	}
	checkpoint := make(chan error, 1)
	var tree string
	go func() {
		result, err := m.StreamCheckpoint(ctx, "j", 5000)
		tree = result.Tree
		checkpoint <- err
	}()
	reply, err := g.checkpoint(ctx, req)
	if err != nil || reply["files"] != 4 || reply["bytes"] != int64(7) {
		t.Fatal(reply, err)
	}
	if err := <-checkpoint; err != nil {
		t.Fatal(err)
	}
	for _, op := range g.pending {
		want := map[string]string{"old": "del", "exec": "mode", "edit": "put", "newlink": "link"}
		if op.Op != want[op.Path] {
			t.Fatal(op)
		}
	}
	if reply, err := g.checkpointed(request{Tree: tree}); err != nil || reply["entries"] != 4 {
		t.Fatal(reply, err)
	}
	if g.index.Tree != tree || g.pending != nil {
		t.Fatal("checkpoint was not recorded")
	}
}
