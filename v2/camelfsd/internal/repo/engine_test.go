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

func TestRepoLifecycleWriteReadLsGrepDiffRestore(t *testing.T) {
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

	// Diff between w1 and w2.
	diffRes, err := eng.Diff(ctx, lin.Lineage, w1.Commit, w2.Commit)
	if err != nil {
		t.Fatalf("Diff: %v", err)
	}
	if len(diffRes.Changes) != 4 { // a.txt deleted, docs/b.txt added, old.txt deleted, src/app.ts modified
		t.Fatalf("expected 4 diff changes, got %+v", diffRes.Changes)
	}
	foundMod := false
	for _, ch := range diffRes.Changes {
		if ch.Path == "src/app.ts" && ch.Kind == "modified" && strings.Contains(ch.Patch, "-export const x = 1;") && strings.Contains(ch.Patch, "+export const x = 2;") {
			foundMod = true
		}
	}
	if !foundMod {
		t.Fatalf("expected unified patch for src/app.ts in %+v", diffRes.Changes)
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

func TestRepoThreeWayMergeForkAndLeaseFencing(t *testing.T) {
	ctx := context.Background()
	eng := newTestRepoEngine(t)

	lin, err := eng.CreateLineage(ctx, repo.CreateLineageRequest{Lineage: "lin_merge_test"})
	if err != nil {
		t.Fatalf("CreateLineage: %v", err)
	}

	// Base commit with multi-line shared file.
	baseWrite, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref: "refs/heads/main",
		Puts: []repo.WritePut{
			{Path: "shared.txt", Content: "line1\nline2\nline3\nline4\nline5\n"},
			{Path: "conflict.txt", Content: "alpha\nbeta\n"},
		},
	})
	if err != nil {
		t.Fatalf("base write: %v", err)
	}

	// Create feature branch at baseWrite.Commit.
	if _, err := eng.SetRef(ctx, lin.Lineage, repo.SetRefRequest{
		Ref:    "refs/heads/feat",
		Commit: baseWrite.Commit,
	}); err != nil {
		t.Fatalf("create branch feat: %v", err)
	}

	// Edit top of shared.txt on main, and bottom of shared.txt + new file on feat (clean 3-way merge!).
	if _, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref: "refs/heads/main",
		Puts: []repo.WritePut{
			{Path: "shared.txt", Content: "LINE_ONE_MAIN\nline2\nline3\nline4\nline5\n"},
			{Path: "main_only.txt", Content: "from main\n"},
		},
	}); err != nil {
		t.Fatalf("write main: %v", err)
	}
	if _, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref: "refs/heads/feat",
		Puts: []repo.WritePut{
			{Path: "shared.txt", Content: "line1\nline2\nline3\nline4\nLINE_FIVE_FEAT\n"},
			{Path: "feat_only.txt", Content: "from feat\n"},
		},
	}); err != nil {
		t.Fatalf("write feat: %v", err)
	}

	// ff-only must fail because main and feat diverged.
	if _, err := eng.Merge(ctx, lin.Lineage, repo.MergeRequest{
		SourceRef: "refs/heads/feat",
		TargetRef: "refs/heads/main",
		Strategy:  "ff-only",
	}); !apperr.IsCode(err, apperr.CodeCASConflict) {
		t.Fatalf("expected cas_conflict for diverged ff-only merge, got %v", err)
	}

	// Three-way merge succeeds cleanly, combining non-overlapping edits in shared.txt!
	mRes, err := eng.Merge(ctx, lin.Lineage, repo.MergeRequest{
		SourceRef: "refs/heads/feat",
		TargetRef: "refs/heads/main",
		Strategy:  "three-way",
		Author:    "workflow",
		Message:   "merge feat",
	})
	if err != nil {
		t.Fatalf("three-way merge: %v", err)
	}
	if len(mRes.Conflicts) != 0 {
		t.Fatalf("expected 0 conflicts, got %v", mRes.Conflicts)
	}
	mergedShared, err := eng.Read(ctx, lin.Lineage, repo.ReadParams{At: "refs/heads/main", Path: "shared.txt"})
	if err != nil {
		t.Fatalf("read merged shared.txt: %v", err)
	}
	wantShared := "LINE_ONE_MAIN\nline2\nline3\nline4\nLINE_FIVE_FEAT\n"
	if *mergedShared.Content != wantShared {
		t.Fatalf("unexpected merged content:\ngot:  %q\nwant: %q", *mergedShared.Content, wantShared)
	}

	// Now create a conflicting edit on conflict-branch and verify 409 conflicts list!
	if _, err := eng.SetRef(ctx, lin.Lineage, repo.SetRefRequest{
		Ref:    "refs/heads/conflict-br",
		Commit: mRes.Commit,
	}); err != nil {
		t.Fatalf("create conflict-br: %v", err)
	}
	if _, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref:  "refs/heads/main",
		Puts: []repo.WritePut{{Path: "conflict.txt", Content: "alpha-main\nbeta\n"}},
	}); err != nil {
		t.Fatalf("edit conflict on main: %v", err)
	}
	if _, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref:  "refs/heads/conflict-br",
		Puts: []repo.WritePut{{Path: "conflict.txt", Content: "alpha-branch\nbeta\n"}},
	}); err != nil {
		t.Fatalf("edit conflict on conflict-br: %v", err)
	}

	_, err = eng.Merge(ctx, lin.Lineage, repo.MergeRequest{
		SourceRef: "refs/heads/conflict-br",
		TargetRef: "refs/heads/main",
		Strategy:  "three-way",
	})
	ae, ok := apperr.As(err)
	if !ok || ae.Status != 409 || len(ae.Conflicts) != 1 || ae.Conflicts[0] != "conflict.txt" {
		t.Fatalf("expected 409 conflict on conflict.txt, got %v", err)
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
