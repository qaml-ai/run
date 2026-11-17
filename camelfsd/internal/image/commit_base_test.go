package image

import (
	"bytes"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
)

func TestMountReusesCachedCommitAncestor(t *testing.T) {
	m, _ := unit3(t)
	ctx := t.Context()
	const lineage = "l"
	const missing = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	storageDB, err := refs.OpenStorage(filepath.Join(t.TempDir(), "storage.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { storageDB.Close() })
	tier := (&objects.Repository{DB: storageDB, Store: m.Store, TempDir: t.TempDir()}).ForLineage(lineage)
	commit := func(tree, parent string, n int) string {
		t.Helper()
		raw := "tree " + tree + "\n"
		if parent != "" {
			raw += "parent " + parent + "\n"
		}
		raw += fmt.Sprintf("author Agent <agent@example.com> 1 +0000\ncommitter camelfs <camelfs@camelfs> 1 +0000\n\nedit %d\n", n)
		id, err := tier.PutObject(ctx, lineage, "commit", []byte(raw))
		if err != nil {
			t.Fatal(err)
		}
		return id
	}
	mount := func(job, tree, version string) (*Mount, error) {
		t.Helper()
		return m.Mount(ctx, Request{JobID: job, Lineage: lineage, Tree: tree, Parent: version,
			Fence: &refs.Fence{Holder: "host:1:" + job, Epoch: 1}})
	}
	var versions, trees []string
	var parentTree, parentVersion string
	for n := 0; n <= cachedCommitHops+1; n++ {
		raw := fmt.Appendf(nil, "file edit %d", n)
		sha := sha256Hex(raw)
		if _, err := tier.Upload(ctx, lineage, sha, int64(len(raw)), bytes.NewReader(raw)); err != nil {
			t.Fatal(err)
		}
		edit, err := tier.Import(ctx, objects.Request{Lineage: lineage, ParentTree: parentTree, Files: map[string]objects.File{"file": {SHA256: sha}}})
		if err != nil {
			t.Fatal(err)
		}
		parentTree, parentVersion = edit.Tree, commit(edit.Tree, parentVersion, n)
		trees, versions = append(trees, parentTree), append(versions, parentVersion)
	}
	baseTree := trees[0]

	// The tier cannot populate the host's derived tree-parent index.
	cold, err := mount("cold", trees[1], versions[1])
	if err != nil || cold.Warm || cold.BaseTree != "" {
		t.Fatalf("cold mount = %+v, err = %v", cold, err)
	}
	const imageID = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	if err := clone(blankImage(m.Data, m.VirtualSize), m.image(imageID)); err != nil {
		t.Fatal(err)
	}
	if err := m.Refs.RecordTree(lineage, baseTree, imageID); err != nil {
		t.Fatal(err)
	}
	if tree, id, err := m.cachedAncestor(ctx, lineage, trees[1]); err != nil || tree != "" || id != "" {
		t.Fatalf("host acquired tier-local hint: %q, %q, %v", tree, id, err)
	}

	for _, tc := range []struct {
		name    string
		n       int
		version string
		base    string
	}{
		{"exact", 0, missing, baseTree},
		{"one-edit", 1, versions[1], baseTree},
		{"short-burst", cachedCommitHops, versions[cachedCommitHops], baseTree},
		{"beyond-budget", cachedCommitHops + 1, versions[cachedCommitHops+1], ""},
		{"parent-outside-lineage", 1, commit(trees[1], missing, 100), ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			v, err := mount(tc.name, trees[tc.n], tc.version)
			if err != nil {
				t.Fatal(err)
			}
			if v.BaseTree != tc.base || v.Warm != (tc.base != "") || v.Parent.Tree != trees[tc.n] || v.Parent.Commit != tc.version {
				t.Fatalf("wrong base or target: %+v", v)
			}
			if v.Warm && v.CachedImage != imageID {
				t.Fatalf("unexpected cache image %q", v.CachedImage)
			}
		})
	}
	if v, err := mount("mismatched", trees[1], versions[0]); v != nil || err == nil || !strings.Contains(err.Error(), "does not name tree") {
		t.Fatalf("inconsistent commit and tree: %v, %v", v, err)
	}
	if v, err := mount("missing-commit", trees[1], missing); v != nil || err == nil || !strings.Contains(err.Error(), "is missing") {
		t.Fatalf("missing target commit: %v, %v", v, err)
	}
	badCommit, err := tier.PutObject(ctx, lineage, "commit", []byte("tree bad\n\ninvalid commit\n"))
	if err != nil {
		t.Fatal(err)
	}
	if v, err := mount("malformed", trees[1], badCommit); v != nil || err == nil || !strings.Contains(err.Error(), "invalid tree") {
		t.Fatalf("malformed commit: %v, %v", v, err)
	}

	// A tracked temporary leaf may disappear before apply, and a tracked
	// descendant of a temporary directory may be omitted by checkpoints.
	for i, tc := range []struct {
		path string
		keep bool
	}{
		{".camelfs-tmp-leaf", true},
		{"dir/.camelfs-tmp-leaf", false},
		{"dir/.camelfs-tmp-dir/leaf", true},
	} {
		oldFile := objects.File{SHA256: sha256Hex([]byte("file edit 0"))}
		newFile := objects.File{SHA256: sha256Hex([]byte("file edit 1"))}
		base, err := tier.Import(ctx, objects.Request{Lineage: lineage,
			Files: map[string]objects.File{"file": oldFile, tc.path: oldFile}})
		if err != nil {
			t.Fatal(err)
		}
		files := map[string]objects.File{"file": newFile}
		if tc.keep {
			files[tc.path] = oldFile
		}
		target, err := tier.Import(ctx, objects.Request{Lineage: lineage, Files: files})
		if err != nil {
			t.Fatal(err)
		}
		if err := m.Refs.RecordTree(lineage, base.Tree, imageID); err != nil {
			t.Fatal(err)
		}
		version := commit(target.Tree, commit(base.Tree, "", 200), 201)
		job := fmt.Sprintf("temp-%d", i)
		v, err := mount(job, target.Tree, version)
		if err != nil || v.Warm || v.BaseTree != "" {
			t.Fatalf("temporary path %q selected a cached image: %+v, %v", tc.path, v, err)
		}
	}
}
