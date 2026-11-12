package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"
	"testing"
)

func run(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@x", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@x")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func write(t *testing.T, dir string, files map[string]string) {
	for p, c := range files {
		full := filepath.Join(dir, p)
		os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte(c), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

// brute is the oracle: every file of the tree scanned with the verification regexp.
func brute(t *testing.T, dir string, q Query) []string {
	src := q.Pattern
	if !q.Regex {
		src = regexp.QuoteMeta(src)
	}
	if q.IgnoreCase {
		src = "(?i)" + src
	}
	re := regexp.MustCompile("(?m)" + src)
	pf, _ := newPathFilter(&q)
	var out []string
	filepath.Walk(dir, func(p string, fi os.FileInfo, err error) error {
		if fi.IsDir() && fi.Name() == ".git" {
			return filepath.SkipDir
		}
		if fi.IsDir() {
			return nil
		}
		rel, _ := filepath.Rel(dir, p)
		sn := &Snap{Paths: []PathEntry{{Path: rel}}, Lang: []uint8{langOf(rel)}}
		if !pf.ok(sn, 0) {
			return nil
		}
		b, _ := os.ReadFile(p)
		if re.Match(b) {
			out = append(out, rel)
		}
		return nil
	})
	sort.Strings(out)
	return out
}

func got(t *testing.T, sn *Snap, q Query) []string {
	q.Limit = 1 << 20
	r, err := Search(sn, q)
	if err != nil {
		t.Fatal(err)
	}
	var out []string
	for _, f := range r.Files {
		out = append(out, f.Path)
	}
	sort.Strings(out)
	return out
}

func TestSearchMatchesBruteForceAcrossCheckpointsAndForks(t *testing.T) {
	repo := t.TempDir()
	run(t, repo, "init", "-q")
	files := map[string]string{
		"src/a.go":            "package a\n\nfunc OpenVolume(ctx context.Context) error {\n\treturn nil\n}\n",
		"src/b.go":            "package a\n// TODO: fix\nfunc closeVolume() {}\n",
		"src/same.go":         "package a\n// TODO: fix\nfunc closeVolume() {}\n", // same blob at two paths
		"lib/x.c":             "static int foo_probe(struct device *dev)\n{\n\tspin_lock(&dev->lock);\n}\n",
		"lib/x.h":             "#define FOO_BAR 1\n",
		"docs/README.md":      "Open the VOLUME with OpenVolume.\n",
		"bin/blob.bin":        "abc\x00OpenVolume\x00",
		"deep/a/b/c/types.go": "type Volume struct{ Name string }\n",
	}
	for i := 0; i < 50; i++ {
		files[fmt.Sprintf("gen/f%02d.ts", i)] = fmt.Sprintf("export const v%d = %d; // volume %d\n", i, i*7, i%5)
	}
	write(t, repo, files)
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "-qm", "base")
	st, _ := openStore(t.TempDir())
	st.ShardTarget = 512 // many tiny shards: exercises the multi-shard paths
	baseStats, err := st.Ingest(repo, "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	checkPaths(t, st, repo, "HEAD", baseStats, "ls-tree")
	base := run(t, repo, "rev-parse", "HEAD^{tree}")
	st.SetRef("base", base)

	queries := []Query{
		{Pattern: "OpenVolume"},
		{Pattern: "openvolume", IgnoreCase: true},
		{Pattern: "volume", IgnoreCase: true},
		{Pattern: `func \w+Volume\(`, Regex: true},
		{Pattern: `(?i)todo|fixme`, Regex: true},
		{Pattern: `^static int \w+_probe\(`, Regex: true},
		{Pattern: `[A-Z]{3}_[A-Z]{3}`, Regex: true},
		{Pattern: `v[0-9]`, Regex: true},
		{Pattern: "volume 3"},
		{Pattern: "Volume", Lang: "go"},
		{Pattern: "Volume", PathGlob: "src/**"},
		{Pattern: "Volume", FileGlob: "*.go"},
		{Pattern: "Name", PathGlob: "deep/**/types.go"},
		{Pattern: "xy"}, // shorter than a trigram: full scan
		{Pattern: `(?i)OPENvolume`, Regex: true},
		{Pattern: `close(Volume|Thing)\(`, Regex: true},
		{Pattern: `(TODO|later)\b`, Regex: true},
		{Pattern: "volume", PathGlob: "gen/f0?.ts"},
		{Pattern: "Volume", PathGlob: "/src/*.go"},
		{Pattern: "Volume", PathGlob: "**/c/*"},
	}
	check := func(label string, sn *Snap) {
		for _, q := range queries {
			want, have := brute(t, repo, q), got(t, sn, q)
			// the binary file is excluded by design
			want = slicesDelete(want, "bin/blob.bin")
			if strings.Join(want, ",") != strings.Join(have, ",") {
				t.Errorf("%s %+v:\n want %v\n have %v", label, q, want, have)
			}
		}
	}
	sn, err := st.Open("base")
	if err != nil {
		t.Fatal(err)
	}
	check("base", sn)

	// A checkpoint that edits one file, deletes one and adds one: one delta shard, parent shards reused.
	write(t, repo, map[string]string{"src/a.go": "package a\nfunc OpenVolumeV2() {}\n", "new/n.go": "// TODO later\nfunc newVolume() {}\n"})
	os.Remove(filepath.Join(repo, "src/b.go"))
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "-qm", "v1")
	s1, err := st.Ingest(repo, "HEAD", []string{"base"})
	if err != nil {
		t.Fatal(err)
	}
	if s1.NewBlobs != 2 || s1.NewShards != 1 {
		t.Fatalf("delta: %+v", s1)
	}
	checkPaths(t, st, repo, "HEAD", s1, "diff")
	st.SetRef("v1", s1.Tree)
	sn1, _ := st.Open("v1")
	check("v1", sn1)

	// A fork is a ref; a change on the fork does not leak into the base.
	if _, err := st.Fork("v1", "fork"); err != nil {
		t.Fatal(err)
	}
	write(t, repo, map[string]string{"fork.go": "func ForkOnlyVolume() {}\n"})
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "-qm", "fork")
	sf, err := st.Ingest(repo, "HEAD", []string{"fork"})
	if err != nil || sf.NewBlobs != 1 {
		t.Fatalf("fork ingest %+v %v", sf, err)
	}
	checkPaths(t, st, repo, "HEAD", sf, "diff")
	st.SetRef("fork", sf.Tree)
	snf, _ := st.Open("fork")
	check("fork", snf)
	if hits := got(t, sn1, Query{Pattern: "ForkOnlyVolume"}); len(hits) != 0 {
		t.Fatalf("fork content visible in parent: %v", hits)
	}

	// A merge names both parents' shards: v1 + a side branch from base.
	run(t, repo, "checkout", "-q", "-b", "side", "HEAD~2")
	write(t, repo, map[string]string{"side/s.go": "func SideVolume() {}\n"})
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "-qm", "side")
	ss, err := st.Ingest(repo, "HEAD", []string{"base"})
	if err != nil {
		t.Fatal(err)
	}
	checkPaths(t, st, repo, "HEAD", ss, "diff")
	st.SetRef("side", ss.Tree)
	run(t, repo, "checkout", "-q", "-")
	run(t, repo, "merge", "-q", "--no-edit", "side")
	sm, err := st.Ingest(repo, "HEAD", []string{"fork", "side"})
	if err != nil || sm.NewBlobs != 0 {
		t.Fatalf("merge ingest %+v %v", sm, err)
	}
	checkPaths(t, st, repo, "HEAD", sm, "ls-tree")
	st.SetRef("merged", sm.Tree)
	snm, _ := st.Open("merged")
	check("merged", snm)

	// Compaction keeps answers identical.
	if _, err := st.Compact("merged", 1<<30); err != nil {
		t.Fatal(err)
	}
	snc, _ := st.Open("merged")
	if len(snc.Shards) != 1 {
		t.Fatalf("compacted shards: %d", len(snc.Shards))
	}
	check("compacted", snc)
}

func slicesDelete(xs []string, v string) []string {
	var out []string
	for _, x := range xs {
		if x != v {
			out = append(out, x)
		}
	}
	return out
}

func TestMatchGlob(t *testing.T) {
	cases := []struct {
		pat, name string
		want      bool
	}{
		{"*.go", "a.go", true}, {"*.go", "x/a.go", false}, {"**/*.go", "x/y/a.go", true}, {"**/*.go", "a.go", true},
		{"src/**/*.ts", "src/a.ts", true}, {"src/**/*.ts", "src/x/y/a.ts", true}, {"src/**/*.ts", "lib/src/a.ts", false},
		{"**/src/**/*.ts", "lib/src/a.ts", true}, {"cmd/**", "cmd/a/b", true}, {"cmd/**", "cmdx/a", false},
		{"f?.c", "f1.c", true}, {"f?.c", "f/.c", false}, {"Kconfig*", "Kconfig.debug", true}, {"*_test.go", "a_test.go", true},
	}
	for _, c := range cases {
		if got := matchGlob(c.pat, c.name); got != c.want {
			t.Errorf("matchGlob(%q, %q) = %v", c.pat, c.name, got)
		}
	}
}

func checkPaths(t *testing.T, st *Store, repo, commit string, stats *IngestStats, mode string) {
	t.Helper()
	if stats.Mode != mode {
		t.Fatalf("mode = %q, want %q", stats.Mode, mode)
	}
	want, err := lsTree(repo, commit)
	if err != nil {
		t.Fatal(err)
	}
	have, err := readPaths(filepath.Join(st.Dir, "paths", stats.Tree+".paths"))
	if err != nil {
		t.Fatal(err)
	}
	if len(want) != len(have) {
		t.Fatalf("paths: got %d, want %d", len(have), len(want))
	}
	for i := range want {
		if want[i] != have[i] {
			t.Fatalf("path %d: got %+v, want %+v", i, have[i], want[i])
		}
	}
	m, err := st.readManifest(stats.Tree)
	if err != nil {
		t.Fatal(err)
	}
	if wantCommit := run(t, repo, "rev-parse", commit+"^{commit}"); m.Commit != wantCommit {
		t.Fatalf("commit = %s, want %s", m.Commit, wantCommit)
	}
}

func TestDiffPathChanges(t *testing.T) {
	repo := t.TempDir()
	run(t, repo, "init", "-q")
	write(t, repo, map[string]string{"a.b": "dot", "a/b": "nested", "a0": "zero", "rename": "rename content", "exec": "executable", "link": "regular", "gone/deep/file": "delete"})
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "-qm", "base")
	st, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	st.ShardTarget = 1 // each dead blob's shard must be dropped
	base, err := st.Ingest(repo, "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	checkPaths(t, st, repo, "HEAD", base, "ls-tree")
	run(t, repo, "mv", "rename", "renamed")
	if err := os.Chmod(filepath.Join(repo, "exec"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(repo, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("renamed", filepath.Join(repo, "link")); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(repo, "gone")); err != nil {
		t.Fatal(err)
	}
	write(t, repo, map[string]string{"a/c": "added", "a.b": "changed"})
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "-qm", "changes")
	next, err := st.Ingest(repo, "HEAD", []string{base.Tree})
	if err != nil {
		t.Fatal(err)
	}
	checkPaths(t, st, repo, "HEAD", next, "diff")
	if next.NewBlobs != 2 {
		t.Fatalf("new blobs = %d, want 2", next.NewBlobs)
	}
	sn, err := st.Open(next.Tree)
	if err != nil {
		t.Fatal(err)
	}
	for si := range sn.Shards {
		if !slices.ContainsFunc(sn.live[si], func(pi int32) bool { return pi >= 0 }) {
			t.Fatal("fully dead shard retained")
		}
	}
	// A directory replaced by a file, and a file replaced by a directory.
	run(t, repo, "rm", "-qr", "a", "a.b")
	write(t, repo, map[string]string{"a": "file now", "a.b/child": "directory now"})
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "-qm", "type changes")
	last, err := st.Ingest(repo, "HEAD", []string{next.Tree})
	if err != nil {
		t.Fatal(err)
	}
	checkPaths(t, st, repo, "HEAD", last, "diff")
}

func TestIngestFallbackAndReuse(t *testing.T) {
	for _, parentCommit := range []string{"", strings.Repeat("0", 40)} {
		t.Run("parent-"+parentCommit, func(t *testing.T) {
			repo := t.TempDir()
			run(t, repo, "init", "-q")
			write(t, repo, map[string]string{"file": "original"})
			run(t, repo, "add", "-A")
			run(t, repo, "commit", "-qm", "base")
			st, err := openStore(t.TempDir())
			if err != nil {
				t.Fatal(err)
			}
			base, err := st.Ingest(repo, "HEAD", nil)
			if err != nil {
				t.Fatal(err)
			}
			m, err := st.readManifest(base.Tree)
			if err != nil {
				t.Fatal(err)
			}
			m.Commit = parentCommit
			data, err := json.Marshal(m)
			if err != nil {
				t.Fatal(err)
			}
			if err := writeAtomic(filepath.Join(st.Dir, "snaps", base.Tree+".json"), data); err != nil {
				t.Fatal(err)
			}
			write(t, repo, map[string]string{"file": "modified"})
			run(t, repo, "add", "-A")
			run(t, repo, "commit", "-qm", "next")
			next, err := st.Ingest(repo, "HEAD", []string{base.Tree})
			if err != nil {
				t.Fatal(err)
			}
			checkPaths(t, st, repo, "HEAD", next, "ls-tree")
			// Reusing an identical tree still records the newly resolved commit.
			run(t, repo, "commit", "--allow-empty", "-qm", "same tree")
			reused, err := st.Ingest(repo, "HEAD", []string{next.Tree})
			if err != nil {
				t.Fatal(err)
			}
			if !reused.Reused {
				t.Fatal("identical tree not reused")
			}
			checkPaths(t, st, repo, "HEAD", reused, "diff")
		})
	}
}

func TestDiffSubmodules(t *testing.T) {
	repo := t.TempDir()
	run(t, repo, "init", "-q")
	write(t, repo, map[string]string{"file": "blob", "keep": "keep"})
	run(t, repo, "add", "-A")
	run(t, repo, "commit", "-qm", "base")
	commit := run(t, repo, "rev-parse", "HEAD")
	st, err := openStore(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	base, err := st.Ingest(repo, "HEAD", nil)
	if err != nil {
		t.Fatal(err)
	}
	// A blob replaced by a gitlink and a newly added gitlink must both be omitted.
	run(t, repo, "update-index", "--add", "--cacheinfo", "160000,"+commit+",file")
	run(t, repo, "update-index", "--add", "--cacheinfo", "160000,"+commit+",sub")
	run(t, repo, "commit", "-qm", "gitlinks")
	next, err := st.Ingest(repo, "HEAD", []string{base.Tree})
	if err != nil {
		t.Fatal(err)
	}
	checkPaths(t, st, repo, "HEAD", next, "diff")
	if next.NewBlobs != 0 {
		t.Fatalf("indexed gitlinks: %+v", next)
	}
	// A gitlink replaced by a blob is indexed normally.
	id := run(t, repo, "rev-parse", commit+":file")
	run(t, repo, "update-index", "--cacheinfo", "100644,"+id+",file")
	run(t, repo, "commit", "-qm", "blob again")
	last, err := st.Ingest(repo, "HEAD", []string{next.Tree})
	if err != nil {
		t.Fatal(err)
	}
	checkPaths(t, st, repo, "HEAD", last, "diff")
}
