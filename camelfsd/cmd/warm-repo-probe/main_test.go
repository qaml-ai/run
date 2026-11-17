package main

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestCanonicalGitServiceRoundtrip(t *testing.T) {
	ctx := t.Context()
	parent := t.TempDir()
	source := filepath.Join(parent, "source")
	db, err := refs.OpenStorage(filepath.Join(parent, "source.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	repo := &objects.Repository{DB: db, Store: store.Local{Dir: source}, TempDir: parent}
	files := map[string]objects.File{}
	contents := map[string][]byte{
		"src/d000/f00000.ts":          []byte("first"),
		"bin/run":                     []byte("#!/bin/sh\n"),
		"sym":                         []byte("bin/run"),
		"control/escape\x1b-and-\x01": []byte("control bytes"),
		"control/new\nline\tfile":     []byte("newline and tab"),
		"unicode/naïve-資料-🙂.txt":      []byte("Unicode path"),
		"unicode/zero\u200bwidth.txt": []byte("nonprinting Unicode"),
		"quotes/a\"b\\c.txt":          []byte("quote and backslash"),
	}
	for path, raw := range contents {
		blob, err := repo.Upload(ctx, "l", root.Hash(raw), int64(len(raw)), bytes.NewReader(raw))
		if err != nil {
			t.Fatal(err)
		}
		mode := "100644"
		if path == "bin/run" {
			mode = "100755"
		}
		if path == "sym" {
			mode = "120000"
		}
		files[path] = objects.File{SHA256: blob.SHA256, Mode: mode}
	}
	tree, err := repo.Import(ctx, objects.Request{Lineage: "l", Files: files})
	if err != nil {
		t.Fatal(err)
	}
	commit, err := repo.PutObject(ctx, "l", "commit", []byte("tree "+tree.Tree+"\nauthor p <p@p> 1 +0000\ncommitter p <p@p> 1 +0000\n\nfixture\n"))
	if err != nil {
		t.Fatal(err)
	}
	entries, err := repo.ForLineage("l").TreeEntries(ctx, tree.Tree)
	if err != nil {
		t.Fatal(err)
	}
	m := manifest{Lineage: "l", Commit: commit, Tree: tree.Tree, Entries: entries}
	for _, e := range entries {
		m.Bytes += e.Size
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	manifestPath := filepath.Join(parent, "manifest.json")
	if err = os.WriteFile(manifestPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(parent, "warm")
	if err = fill(ctx, dest, manifestPath, source, "", ""); err != nil {
		t.Fatal(err)
	}
	s, err := newService(ctx, filepath.Join(dest, "repo.git"), m, "fixture")
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(s)
	defer server.Close()
	for path, want := range contents {
		response, err := request(ctx, http.DefaultClient, server.URL, "/repos/"+m.Commit+"/files/"+url.PathEscape(path), "fixture")
		if err != nil {
			t.Fatalf("read path %q: %v", path, err)
		}
		got, err := io.ReadAll(response.Body)
		closeErr := response.Body.Close()
		if err != nil || closeErr != nil || !bytes.Equal(got, want) || response.Header.Get("ETag") != `"`+store.GitHash("blob", want)+`"` {
			t.Fatalf("read path %q: bytes=%q read=%v close=%v", path, got, err, closeErr)
		}
	}
	if err = client(ctx, server.URL, m, "fixture", 1); err != nil {
		t.Fatal(err)
	}
	if _, err = request(ctx, http.DefaultClient, server.URL, "/manifest", "wrong"); err == nil {
		t.Fatal("accepted unauthorized request")
	}
	if _, err = request(ctx, http.DefaultClient, server.URL, "/repos/"+m.Commit+"/files/missing", "fixture"); err == nil {
		t.Fatal("missing path succeeded")
	}
	if err = fill(ctx, dest, manifestPath, source, "", ""); err == nil {
		t.Fatal("reused a nonempty hydration directory")
	}
	// Delete all stored pack bytes after readiness. Both selected warm read
	// paths must report failure, without reading the canonical source.
	if err = os.Rename(filepath.Join(dest, "repo.git", "objects"), filepath.Join(dest, "missing-objects")); err != nil {
		t.Fatal(err)
	}
	if err = client(ctx, server.URL, m, "fixture", 1); err == nil {
		t.Fatal("corrupt warm repository silently succeeded")
	}
}

func TestSnapshotRejectsTruncationAndWrongHash(t *testing.T) {
	data := []byte("hello")
	e := objects.Entry{Path: "a", Mode: "100644", SHA1: store.GitHash("blob", data), Size: int64(len(data))}
	m := manifest{Entries: []objects.Entry{e}, Bytes: e.Size}
	var encoded bytes.Buffer
	w := tar.NewWriter(&encoded)
	if err := w.WriteHeader(&tar.Header{Name: e.Path, Mode: 0644, Size: e.Size, Format: tar.FormatPAX, PAXRecords: map[string]string{"camelfs.mode": e.Mode}}); err != nil {
		t.Fatal(err)
	}
	if _, err := w.Write(data); err != nil {
		t.Fatal(err)
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := verifySnapshot(bytes.NewReader(encoded.Bytes()), m, time.Now()); err != nil {
		t.Fatal(err)
	}
	bad := m
	bad.Entries = []objects.Entry{e}
	bad.Entries[0].SHA1 = store.GitHash("blob", []byte("wrong"))
	if _, err := verifySnapshot(bytes.NewReader(encoded.Bytes()), bad, time.Now()); err == nil {
		t.Fatal("bad hash succeeded")
	}
	if _, err := verifySnapshot(io.LimitReader(bytes.NewReader(encoded.Bytes()), 1200), m, time.Now()); err == nil {
		t.Fatal("truncated tar succeeded")
	}
	canceled, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := request(canceled, http.DefaultClient, "http://127.0.0.1:1", "/manifest", "fixture"); err == nil {
		t.Fatal("cancellation ignored")
	}
}
