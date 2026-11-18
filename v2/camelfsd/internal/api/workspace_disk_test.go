package api_test

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/api"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/auth"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
	localstore "github.com/qaml-ai/camelrun-next/camelfsd/internal/store/local"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/vm"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/workdisk"
)

func TestWorkspaceDiskHTTP(t *testing.T) {
	editor := os.Getenv("CAMELFSD_TEST_WORKSPACE_EDITOR")
	if editor == "" {
		t.Skip("set CAMELFSD_TEST_WORKSPACE_EDITOR to the compiled libext2fs editor")
	}
	ctx := t.Context()
	dir := t.TempDir()
	st, err := localstore.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer st.Close()
	template := filepath.Join(dir, "template.ext4")
	run := func(name string, args ...string) []byte {
		t.Helper()
		out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
		if err != nil {
			t.Fatalf("%s %v: %v: %s", name, args, err, out)
		}
		return out
	}
	run("mkfs.ext4", "-q", "-F", template, "32M")
	disks, err := workdisk.New(ctx, st, template, editor, dir)
	if err != nil {
		t.Fatal(err)
	}
	verifyImage := func(commit string, e *repo.Engine, path string, expected []byte) {
		t.Helper()
		c, err := e.GetCommit(ctx, commit)
		if err != nil {
			t.Fatal(err)
		}
		view, err := disks.Open(ctx, c.Disk)
		if err != nil {
			t.Fatal(err)
		}
		defer view.Close()
		img := filepath.Join(t.TempDir(), "check.ext4")
		file, err := os.Create(img)
		if err != nil {
			t.Fatal(err)
		}
		defer file.Close()
		buf := make([]byte, workdisk.ChunkSize)
		for offset := int64(0); offset < view.Size(); offset += int64(len(buf)) {
			if err := view.Transfer(ctx, false, offset, buf); err != nil {
				t.Fatal(err)
			}
			if _, err := file.Write(buf); err != nil {
				t.Fatal(err)
			}
		}
		run("e2fsck", "-fn", img)
		out := filepath.Join(t.TempDir(), "data")
		run("debugfs", "-R", "dump "+path+" "+out, img)
		if got, err := os.ReadFile(out); err != nil || !bytes.Equal(got, expected) {
			t.Fatalf("disk file %s: %d bytes, want %d: %v", path, len(got), len(expected), err)
		}
	}

	e := repo.NewEngine(st, time.Now)
	e.UseWorkspaceDisks(disks)
	drv, err := vm.NewLocalDriver(dir)
	if err != nil {
		t.Fatal(err)
	}
	m := vm.NewManager(vm.ManagerConfig{Store: st, Repo: e, Driver: drv})
	defer m.Close()
	const token = "workspace-disk-test-secret"
	verifier, err := auth.NewVerifier(auth.Config{DevToken: token})
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(api.NewServer(verifier, e, m))
	defer ts.Close()
	post := func(path string, body, dst any) {
		t.Helper()
		if code := doJSON(t, http.MethodPost, ts.URL+path, token, body, dst); code != 200 {
			t.Fatalf("%s: HTTP %d", path, code)
		}
	}
	const lin = "/v1/lineages/disk-test"
	var created repo.CreateLineageResponse
	post("/v1/lineages", repo.CreateLineageRequest{Lineage: "disk-test"}, &created)
	initial, err := e.GetCommit(ctx, created.Commit)
	if err != nil || initial.Disk != disks.Template() {
		t.Fatalf("initial commit did not use the template: %v", err)
	}
	payload := bytes.Repeat([]byte{0, 1, 2, 3}, 70_001)
	var first, second repo.WriteResponse
	post(lin+"/write", repo.WriteRequest{Puts: []repo.WritePut{{Path: "dir/file", Base64: base64.StdEncoding.EncodeToString(payload)}}}, &first)
	post(lin+"/write", repo.WriteRequest{
		Moves: []repo.WriteMove{{From: "dir/file", To: "moved"}},
		Puts:  []repo.WritePut{{Path: "dir", Content: "directory replaced with a file"}},
	}, &second)
	verifyImage(first.Commit, e, "/dir/file", payload)
	verifyImage(second.Commit, e, "/moved", payload)
	verifyImage(second.Commit, e, "/dir", []byte("directory replaced with a file"))

	// A batch the disk cannot represent must leave the ref pointing at the old
	// commit, even if it already has content-addressed objects in storage.
	if code := doJSON(t, http.MethodPost, ts.URL+lin+"/write", token, repo.WriteRequest{
		ExpectedCommit: second.Commit,
		Puts:           []repo.WritePut{{Path: "dir/invalid", Content: "would cross a regular file"}},
	}, nil); code == 200 {
		t.Fatal("invalid disk edit succeeded")
	}
	ref, err := st.GetRef(ctx, "disk-test", repo.DefaultRef, time.Now().UnixMilli())
	if err != nil || ref.Commit != second.Commit {
		t.Fatalf("failed edit changed the ref: %+v, %v", ref, err)
	}
}
