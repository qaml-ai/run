package vm_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/repo"
	localstore "github.com/qaml-ai/camelrun-next/camelfsd/internal/store/local"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/vm"
)

func newTestVMStack(t *testing.T, reaperInterval time.Duration) (*repo.Engine, *vm.Manager) {
	t.Helper()
	dir := t.TempDir()
	st, err := localstore.Open(dir)
	if err != nil {
		t.Fatalf("open local store: %v", err)
	}
	drv, err := vm.NewLocalDriver(dir)
	if err != nil {
		t.Fatalf("new local driver: %v", err)
	}
	eng := repo.NewEngine(st, time.Now)
	mgr := vm.NewManager(vm.ManagerConfig{
		Store:          st,
		Repo:           eng,
		Driver:         drv,
		ReaperInterval: reaperInterval,
	})
	t.Cleanup(func() {
		_ = mgr.Close()
		_ = st.Close()
	})
	return eng, mgr
}

func TestVMPersistentShellTimeoutAndIdleReaper(t *testing.T) {
	ctx := context.Background()
	eng, mgr := newTestVMStack(t, 40*time.Millisecond)

	lin, err := eng.CreateLineage(ctx, repo.CreateLineageRequest{Lineage: "lin_vm_unit"})
	if err != nil {
		t.Fatalf("CreateLineage: %v", err)
	}
	if _, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref:  "refs/heads/main",
		Puts: []repo.WritePut{{Path: "seed.txt", Content: "initial seed\n"}},
	}); err != nil {
		t.Fatalf("seed write: %v", err)
	}

	// Boot VM with initial env.
	boot1, err := mgr.BootOrReuse(ctx, vm.BootVMRequest{
		Lineage:      lin.Lineage,
		Ref:          "refs/heads/main",
		Holder:       "agt_1",
		IdleTimeoutS: 30,
		LeaseS:       60,
		Env:          map[string]string{"BOOT_ENV": "present"},
	})
	if err != nil {
		t.Fatalf("BootOrReuse 1: %v", err)
	}
	if boot1.Reused || boot1.State != "running" {
		t.Fatalf("expected fresh running VM, got %+v", boot1)
	}

	// Second BootOrReuse for same holder reuses existing VM; different holder gets 409 ref_leased.
	boot2, err := mgr.BootOrReuse(ctx, vm.BootVMRequest{
		Lineage: lin.Lineage,
		Ref:     "refs/heads/main",
		Holder:  "agt_1",
	})
	if err != nil || !boot2.Reused || boot2.VMID != boot1.VMID {
		t.Fatalf("expected VM reuse, got %+v err=%v", boot2, err)
	}
	if _, err := mgr.BootOrReuse(ctx, vm.BootVMRequest{
		Lineage: lin.Lineage,
		Ref:     "refs/heads/main",
		Holder:  "agt_2",
	}); !apperr.IsCode(err, apperr.CodeRefLeased) {
		t.Fatalf("expected ref_leased for second holder, got %v", err)
	}

	// Exec 1: verify pre-materialized seed.txt, cd into nested dir, export variable, and spawn background job.
	ex1, cached, err := mgr.Exec(ctx, boot1.VMID, vm.ExecRequest{
		ExecID:  "exec_1",
		Command: `cat seed.txt && mkdir -p pkg/core && cd pkg/core && export MY_TOKEN="secret_42" && (sleep 10 >/dev/null 2>&1 &) && echo "ready:$BOOT_ENV"`,
	}, nil, nil)
	if err != nil || cached {
		t.Fatalf("Exec 1 failed: cached=%v err=%v", cached, err)
	}
	if ex1.ExitCode != 0 || ex1.Cwd != "/workspace/pkg/core" || !strings.Contains(ex1.Stdout, "initial seed") || !strings.Contains(ex1.Stdout, "ready:present") {
		t.Fatalf("unexpected Exec 1 result: %+v", ex1)
	}

	// Exec 2: verify persistent cwd AND exported MY_TOKEN across calls + atomic post-exec commit!
	ex2, _, err := mgr.Exec(ctx, boot1.VMID, vm.ExecRequest{
		ExecID:  "exec_2",
		Command: `printf '%s\n' "$MY_TOKEN" > result.txt`,
	}, nil, nil)
	if err != nil {
		t.Fatalf("Exec 2: %v", err)
	}
	if !ex2.Commit.Changed || len(ex2.Commit.FilesChanged) != 1 || ex2.Commit.FilesChanged[0] != "pkg/core/result.txt" {
		t.Fatalf("expected atomic commit of pkg/core/result.txt, got %+v", ex2.Commit)
	}

	// Verify idempotency by execId: re-running exec_2 with a destructive command returns cached receipt without executing!
	ex2Dup, fromCache, err := mgr.Exec(ctx, boot1.VMID, vm.ExecRequest{
		ExecID:  "exec_2",
		Command: `rm -rf * && exit 99`,
	}, nil, nil)
	if err != nil || !fromCache || ex2Dup.Commit.Commit != ex2.Commit.Commit {
		t.Fatalf("expected idempotent cached receipt for exec_2, got fromCache=%v res=%+v err=%v", fromCache, ex2Dup, err)
	}

	// Exec 3: test per-call timeoutS=1 and verify shell recovers while keeping cwd & exported env!
	exTimeout, _, err := mgr.Exec(ctx, boot1.VMID, vm.ExecRequest{
		ExecID:   "exec_timeout",
		Command:  `echo "before-hang" && sleep 10`,
		TimeoutS: 1,
	}, nil, nil)
	if err != nil {
		t.Fatalf("Exec timeout: %v", err)
	}
	if !exTimeout.TimedOut || !strings.Contains(exTimeout.Stdout, "before-hang") {
		t.Fatalf("expected timedOut=true with partial stdout, got %+v", exTimeout)
	}

	exAfterTimeout, _, err := mgr.Exec(ctx, boot1.VMID, vm.ExecRequest{
		ExecID:  "exec_after_timeout",
		Command: `echo "recovered:$MY_TOKEN"`,
	}, nil, nil)
	if err != nil || exAfterTimeout.ExitCode != 0 || exAfterTimeout.Cwd != "/workspace/pkg/core" || !strings.Contains(exAfterTimeout.Stdout, "recovered:secret_42") {
		t.Fatalf("expected shell recovery preserving cwd & env, got %+v err=%v", exAfterTimeout, err)
	}

	// Exec 4 with commit.skip=true leaves dirty file uncommitted until idle reaper stops the VM!
	exSkip, _, err := mgr.Exec(ctx, boot1.VMID, vm.ExecRequest{
		ExecID:  "exec_skip",
		Command: `echo "dirty-on-reap" > dirty.txt`,
		Commit:  &vm.ExecCommitOptions{Skip: true},
	}, nil, nil)
	if err != nil || exSkip.Commit.Changed {
		t.Fatalf("expected commit.skip=true to skip commit, got %+v err=%v", exSkip, err)
	}

	// Lower idleTimeoutS to 1s via BootOrReuse reuse, then wait for background reaper to commit dirty file & stop VM!
	if _, err := mgr.BootOrReuse(ctx, vm.BootVMRequest{
		Lineage:      lin.Lineage,
		Ref:          "refs/heads/main",
		Holder:       "agt_1",
		IdleTimeoutS: 1,
		LeaseS:       60,
	}); err != nil {
		t.Fatalf("update idleTimeoutS: %v", err)
	}

	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		info, err := mgr.Get(ctx, boot1.VMID)
		if err == nil && info.State == "stopped" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	info, err := mgr.Get(ctx, boot1.VMID)
	if err != nil || info.State != "stopped" {
		t.Fatalf("expected idle reaper to stop VM, got %+v err=%v", info, err)
	}

	// Verify reaper committed pkg/core/dirty.txt and released the ref lease so agt_2 can write!
	dirtyRead, err := eng.Read(ctx, lin.Lineage, repo.ReadParams{At: "refs/heads/main", Path: "pkg/core/dirty.txt"})
	if err != nil || strings.TrimSpace(*dirtyRead.Content) != "dirty-on-reap" {
		t.Fatalf("expected reaper to commit dirty file, got %+v err=%v", dirtyRead, err)
	}
	if _, err := eng.Write(ctx, lin.Lineage, repo.WriteRequest{
		Ref:    "refs/heads/main",
		Holder: "agt_2",
		Puts:   []repo.WritePut{{Path: "after_reap.txt", Content: "lease was released!\n"}},
	}); err != nil {
		t.Fatalf("expected ref lease to be released after reap, got %v", err)
	}
}
