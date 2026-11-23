package repo_test

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
	localstore "github.com/qaml-ai/camelrun-next/camelfsd/internal/store/local"
)

func newTestRepoEngine(t *testing.T) *repo.Engine {
	t.Helper()
	st, err := localstore.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open local store: %v", err)
	}
	t.Cleanup(func() { _ = st.Close() })
	return repo.NewEngine(st, time.Now)
}

func TestRepoLifecycleWriteReadLsGrepRestore(t *testing.T) {
	ctx := context.Background()
	eng := newTestRepoEngine(t)

	lin, err := eng.CreateLineage(ctx, repo.CreateLineageRequest{TenantID: "ten_1"})
	if err != nil {
		t.Fatalf("CreateLineage: %v", err)
	}
	if !strings.HasPrefix(lin.Lineage, "lin_") || lin.DefaultRef != "refs/heads/main" {
		t.Fatalf("unexpected lineage: %+v", lin)
	}

	// Idempotent CreateLineage returns same commit.
	linAgain, err := eng.CreateLineage(ctx, repo.CreateLineageRequest{Lineage: lin.Lineage})
	if err != nil {
		t.Fatalf("CreateLineage idempotent: %v", err)
	}
	if linAgain.Commit != lin.Commit {
		t.Fatalf("expected idempotent commit %s, got %s", lin.Commit, linAgain.Commit)
	}

	// Write text + binary files.
	binPayload := []byte{0x00, 0x01, 0x02, 0xff, 0xfe}
	w1, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref:            "refs/heads/main",
		ExpectedCommit: lin.Commit,
		Author:         "agent:agt_1",
		Message:        "seed repo",
		Puts: []repo.WritePut{
			{Path: "index.ts", Content: "console.log('root')\n"},
			{Path: "src/app.ts", Content: "export const x = 1;\nconsole.log(x);\n"},
			{Path: "old.txt", Content: "remove me\n"},
			{Path: "a.txt", Content: "move me\n"},
			{Path: "assets/logo.bin", Base64: base64.StdEncoding.EncodeToString(binPayload)},
		},
	})
	if err != nil {
		t.Fatalf("Write 1: %v", err)
	}
	if len(w1.Changed) != 5 {
		t.Fatalf("expected 5 changed files, got %v", w1.Changed)
	}

	// CAS mismatch must fail with cas_conflict.
	_, err = eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref:            "refs/heads/main",
		ExpectedCommit: lin.Commit, // stale!
		Puts:           []repo.WritePut{{Path: "x.txt", Content: "bad"}},
	})
	if !apperr.IsCode(err, apperr.CodeCASConflict) {
		t.Fatalf("expected cas_conflict, got %v", err)
	}

	// Atomic put + delete + move.
	w2, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref:            "refs/heads/main",
		ExpectedCommit: w1.Commit,
		Author:         "agent:agt_1",
		Message:        "update, delete, move",
		Puts:           []repo.WritePut{{Path: "src/app.ts", Content: "export const x = 2;\nconsole.log(x);\n"}},
		Deletes:        []string{"old.txt"},
		Moves:          []repo.WriteMove{{From: "a.txt", To: "docs/b.txt"}},
	})
	if err != nil {
		t.Fatalf("Write 2: %v", err)
	}
	if w2.Commit == "" || w2.Commit == w1.Commit {
		t.Fatalf("expected new commit from Write 2, got %+v", w2)
	}

	// Read text with offset & limit.
	rText, err := eng.Read(ctx, lin.Lineage, repo.ReadParams{
		At:     "refs/heads/main",
		Path:   "docs/b.txt",
		Offset: 0,
		Limit:  4,
	})
	if err != nil {
		t.Fatalf("Read text: %v", err)
	}
	if rText.Binary || rText.Content == nil || *rText.Content != "move" || rText.Base64 != nil || rText.Size != 8 {
		t.Fatalf("unexpected text read response: %+v", rText)
	}

	// Read binary file.
	rBin, err := eng.Read(ctx, lin.Lineage, repo.ReadParams{
		At:   "refs/heads/main",
		Path: "assets/logo.bin",
	})
	if err != nil {
		t.Fatalf("Read binary: %v", err)
	}
	if !rBin.Binary || rBin.Base64 == nil || rBin.Content != nil {
		t.Fatalf("expected binary read with base64, got %+v", rBin)
	}

	// Non-recursive ls at root synthesizes directories + root files.
	lsRoot, err := eng.ListEntries(ctx, lin.Lineage, repo.ListParams{
		At:        "refs/heads/main",
		Recursive: false,
	})
	if err != nil {
		t.Fatalf("ListEntries root: %v", err)
	}
	if len(lsRoot.Entries) != 4 { // assets, docs, index.ts, src
		t.Fatalf("expected 4 root entries, got %+v", lsRoot.Entries)
	}

	// Recursive ls with **/*.ts glob matches both index.ts and src/app.ts.
	lsGlob, err := eng.ListEntries(ctx, lin.Lineage, repo.ListParams{
		At:        "refs/heads/main",
		Recursive: true,
		Glob:      "**/*.ts",
	})
	if err != nil {
		t.Fatalf("ListEntries glob: %v", err)
	}
	if len(lsGlob.Entries) != 2 || lsGlob.Entries[0].Path != "index.ts" || lsGlob.Entries[1].Path != "src/app.ts" {
		t.Fatalf("unexpected **/*.ts entries: %+v", lsGlob.Entries)
	}

	// Grep with pathPrefix.
	grepRes, err := eng.Grep(ctx, lin.Lineage, repo.GrepRequest{
		At:         "refs/heads/main",
		Pattern:    `console\.log`,
		PathPrefix: "src/",
	})
	if err != nil {
		t.Fatalf("Grep: %v", err)
	}
	if len(grepRes.Matches) != 1 || grepRes.Matches[0].Path != "src/app.ts" || grepRes.Matches[0].Line != 2 || grepRes.Matches[0].Column != 1 {
		t.Fatalf("unexpected grep matches: %+v", grepRes.Matches)
	}

	// History check.
	hist, err := eng.History(ctx, lin.Lineage, "refs/heads/main", 10)
	if err != nil {
		t.Fatalf("History: %v", err)
	}
	if len(hist.Commits) != 3 { // w2, w1, initial
		t.Fatalf("expected 3 commits in history, got %d", len(hist.Commits))
	}

	// Restore back to w1.
	restored, err := eng.Restore(ctx, lin.Lineage, repo.RestoreRequest{
		Ref:          "refs/heads/main",
		TargetCommit: w1.Commit,
		Author:       "agent:agt_1",
		Message:      "rollback to w1",
	})
	if err != nil {
		t.Fatalf("Restore: %v", err)
	}
	if restored.Tree != w1.Tree {
		t.Fatalf("expected restored tree %s, got %s", w1.Tree, restored.Tree)
	}
}

func TestRepoForkAndLeaseFencing(t *testing.T) {
	ctx := context.Background()
	eng := newTestRepoEngine(t)

	lin, err := eng.CreateLineage(ctx, repo.CreateLineageRequest{Lineage: "lin_fork_test"})
	if err != nil {
		t.Fatalf("CreateLineage: %v", err)
	}

	wantShared := "LINE_ONE_MAIN\nline2\n"
	if _, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref:  "refs/heads/main",
		Puts: []repo.WritePut{{Path: "shared.txt", Content: wantShared}},
	}); err != nil {
		t.Fatalf("write main: %v", err)
	}

	// Lease fencing check: acquire lease as agt_owner, verify monotonic epoch and 409 ref_leased for agt_intruder.
	l1, err := eng.LeaseRef(ctx, lin.Lineage, repo.LeaseRequest{
		Ref:    "refs/heads/main",
		Holder: "agt_owner",
		TTLMs:  60_000,
	})
	if err != nil {
		t.Fatalf("LeaseRef 1: %v", err)
	}
	l2, err := eng.LeaseRef(ctx, lin.Lineage, repo.LeaseRequest{
		Ref:    "refs/heads/main",
		Holder: "agt_owner",
		TTLMs:  60_000,
	})
	if err != nil || l2.Epoch <= l1.Epoch {
		t.Fatalf("expected monotonic lease epoch > %d, got %+v (%v)", l1.Epoch, l2, err)
	}
	if _, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref:    "refs/heads/main",
		Holder: "agt_intruder",
		Puts:   []repo.WritePut{{Path: "hack.txt", Content: "nope"}},
	}); !apperr.IsCode(err, apperr.CodeRefLeased) {
		t.Fatalf("expected ref_leased for wrong holder, got %v", err)
	}

	// Fork lineage, then delete source lineage, and verify forked lineage remains completely intact!
	forkRes, err := eng.ForkLineage(ctx, lin.Lineage, "ten_1", repo.ForkRequest{
		TargetLineage: "lin_forked",
		SourceRef:     "refs/heads/main",
	})
	if err != nil {
		t.Fatalf("ForkLineage: %v", err)
	}
	if err := eng.DeleteLineage(ctx, lin.Lineage); err != nil {
		t.Fatalf("DeleteLineage source: %v", err)
	}
	forkRead, err := eng.Read(ctx, forkRes.Lineage, repo.ReadParams{At: "refs/heads/main", Path: "shared.txt"})
	if err != nil || *forkRead.Content != wantShared {
		t.Fatalf("forked lineage must survive source deletion: %+v, err=%v", forkRead, err)
	}
}

func TestCommitLookupRequiresLineageHistory(t *testing.T) {
	ctx := context.Background()
	eng := newTestRepoEngine(t)
	lineage, err := eng.CreateLineage(ctx, repo.CreateLineageRequest{TenantID: "tenant-a"})
	if err != nil {
		t.Fatal(err)
	}
	original, err := eng.Write(ctx, lineage.Lineage, repo.WriteRequest{
		Puts: []repo.WritePut{{Path: "notes.txt", Content: "original"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := eng.Write(ctx, lineage.Lineage, repo.WriteRequest{
		Puts: []repo.WritePut{{Path: "notes.txt", Content: "updated"}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := eng.ResolveCommit(ctx, lineage.Lineage, original.Commit); err != nil {
		t.Fatalf("old commit in lineage history: %v", err)
	}

	other, err := eng.CreateLineage(ctx, repo.CreateLineageRequest{TenantID: "tenant-b"})
	if err != nil {
		t.Fatal(err)
	}
	if _, _, err := eng.ResolveCommit(ctx, other.Lineage, original.Commit); !apperr.IsCode(err, apperr.CodeNotFound) {
		t.Fatalf("expected commit outside lineage history to be absent, got %v", err)
	}
	if _, err := eng.SetRef(ctx, other.Lineage, repo.SetRefRequest{
		Ref: "refs/heads/version", Commit: original.Commit,
	}); !apperr.IsCode(err, apperr.CodeNotFound) {
		t.Fatalf("expected ref targeting a commit outside lineage history to be rejected, got %v", err)
	}
}

func TestApplyWorkspaceDeltaAndLoadCommitTree(t *testing.T) {
	ctx := context.Background()
	st, err := localstore.Open(t.TempDir())
	if err != nil {
		t.Fatalf("open local store: %v", err)
	}
	defer st.Close()

	eng := repo.NewEngine(st, time.Now)
	lin, err := eng.CreateLineage(ctx, repo.CreateLineageRequest{Lineage: "lin_delta", TenantID: "ten_1"})
	if err != nil {
		t.Fatalf("CreateLineage: %v", err)
	}
	w1, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref: "refs/heads/main",
		Puts: []repo.WritePut{
			{Path: "keep.txt", Content: "keep"},
			{Path: "drop.txt", Content: "drop"},
		},
	})
	if err != nil {
		t.Fatalf("Write: %v", err)
	}

	_, entries, err := eng.LoadCommitTree(ctx, w1.Commit)
	if err != nil || len(entries) != 2 {
		t.Fatalf("LoadCommitTree expected 2 entries, got %+v (%v)", entries, err)
	}

	noop, err := eng.ApplyWorkspaceDelta(ctx, lin.Lineage, w1.Commit, "agent:1", "noop", nil, nil)
	if err != nil || noop.Changed || noop.Commit != w1.Commit {
		t.Fatalf("expected noop delta unchanged, got %+v (%v)", noop, err)
	}

	d1, err := eng.ApplyWorkspaceDelta(
		ctx,
		lin.Lineage,
		w1.Commit,
		"agent:1",
		"overlay delta",
		[]repo.MaterializedFile{{Path: "added.sh", Mode: repo.ExecFileMode, Data: []byte("#!/bin/sh\n")}},
		[]string{"drop.txt"},
	)
	if err != nil || !d1.Changed || d1.Commit == w1.Commit {
		t.Fatalf("expected changed delta commit, got %+v (%v)", d1, err)
	}
	if len(d1.FilesChanged) != 2 || d1.FilesChanged[0] != "added.sh" || d1.FilesChanged[1] != "drop.txt" {
		t.Fatalf("expected FilesChanged [added.sh drop.txt], got %+v", d1.FilesChanged)
	}
	_, nextEntries, err := eng.LoadCommitTree(ctx, d1.Commit)
	if err != nil || len(nextEntries) != 2 {
		t.Fatalf("expected 2 entries after delta, got %+v (%v)", nextEntries, err)
	}
	for _, ent := range nextEntries {
		if ent.Path == "drop.txt" {
			t.Fatalf("drop.txt should have been deleted by delta: %+v", nextEntries)
		}
	}
}

func TestRestoreExpectedCommitCAS(t *testing.T) {
	ctx := context.Background()
	eng := newTestRepoEngine(t)

	lin, err := eng.CreateLineage(ctx, repo.CreateLineageRequest{TenantID: "ten_cas"})
	if err != nil {
		t.Fatalf("CreateLineage: %v", err)
	}

	w1, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref:  "refs/heads/main",
		Puts: []repo.WritePut{{Path: "app.txt", Content: "v1\n"}},
	})
	if err != nil {
		t.Fatalf("Write v1: %v", err)
	}

	w2, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref:  "refs/heads/main",
		Puts: []repo.WritePut{{Path: "app.txt", Content: "v2\n"}},
	})
	if err != nil {
		t.Fatalf("Write v2: %v", err)
	}

	// Stale ExpectedCommit must fail with cas_conflict and leave ref untouched.
	_, err = eng.Restore(ctx, lin.Lineage, repo.RestoreRequest{
		Ref:            "refs/heads/main",
		TargetCommit:   w1.Commit,
		ExpectedCommit: w1.Commit,
		Author:         "tenant:ten_cas",
		Message:        "stale restore",
	})
	if !apperr.IsCode(err, apperr.CodeCASConflict) {
		t.Fatalf("expected cas_conflict for stale expectedCommit, got %v", err)
	}

	stillV2, err := eng.Read(ctx, lin.Lineage, repo.ReadParams{At: "refs/heads/main", Path: "app.txt"})
	if err != nil || stillV2.Content == nil || *stillV2.Content != "v2\n" {
		t.Fatalf("expected v2 after failed CAS restore, got %+v (err=%v)", stillV2, err)
	}

	// Matching ExpectedCommit must succeed atomically.
	restored, err := eng.Restore(ctx, lin.Lineage, repo.RestoreRequest{
		Ref:            "refs/heads/main",
		TargetCommit:   w1.Commit,
		ExpectedCommit: w2.Commit,
		Author:         "tenant:ten_cas",
		Message:        "cas restore to v1",
	})
	if err != nil {
		t.Fatalf("Restore with matching expectedCommit: %v", err)
	}
	if restored.Tree != w1.Tree {
		t.Fatalf("expected restored tree %s, got %s", w1.Tree, restored.Tree)
	}

	nowV1, err := eng.Read(ctx, lin.Lineage, repo.ReadParams{At: "refs/heads/main", Path: "app.txt"})
	if err != nil || nowV1.Content == nil || *nowV1.Content != "v1\n" {
		t.Fatalf("expected v1 after matching CAS restore, got %+v (err=%v)", nowV1, err)
	}
}
