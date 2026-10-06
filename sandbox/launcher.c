// agent-launcher: the image's entrypoint, started as root under the container's init.
//
// It binds one unix socket per sandbox process (root:node 0660, in a root:node 0710
// directory, so only the runtime's uid can connect), then runs
//   - each sandbox process (src/sandbox-server.ts) as its own uid (1001 + index, group
//     sandbox), so none can open another's /proc/<pid>/mem, with its socket as fd 3, no
//     other descriptors, an empty environment, no_new_privs and the seccomp filter below,
//     restarting it when it dies; and
//   - the runtime (argv) as the node uid, with AGENT_SANDBOX_SOCKETS set.
// It forwards termination signals to the runtime and exits with its status.
//
// `agent-launcher probe <pid>` is a test hook: it reports, as JSON, how the calls the
// filter denies fail. tests/image-isolation.ts runs it from inside a sandbox process.
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <sched.h>
#include <seccomp.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/prctl.h>
#include <sys/ptrace.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define RUNTIME_UID 1000
#define SANDBOX_UID 1001
#define SANDBOX_GID 1001
#define SOCKET_DIR "/run/agent-sandbox"
#define NODE "/usr/local/bin/node"
#define SANDBOX_ENTRY "/app/src/sandbox-server.ts"
#define MAX_SANDBOXES 16
#ifndef CLONE_NEWTIME
#define CLONE_NEWTIME 0x00000080
#endif

static void die(const char *what) {
  fprintf(stderr, "agent-launcher: %s: %s\n", what, strerror(errno));
  exit(1);
}

// A denylist, not an allowlist: Node, V8, libuv and glibc use a large syscall set that
// shifts with their versions and the kernel, and a missing entry crashes rare paths
// (worker teardown, OOM). What is denied is what an escaped guest would use to reach
// other processes, the network or kernel attack surface a JavaScript runtime never needs.
static const char *const denied[] = {
  // Other processes' memory, descriptors and credentials.
  "ptrace", "process_vm_readv", "process_vm_writev", "process_madvise", "pidfd_getfd", "kcmp",
  "move_pages", "migrate_pages",
  // Kernel keyrings.
  "add_key", "request_key", "keyctl",
  // Namespaces and mounts (clone's namespace flags are denied below).
  "unshare", "setns", "mount", "umount2", "pivot_root", "chroot", "fsopen", "fsconfig", "fsmount",
  "fspick", "move_mount", "open_tree", "mount_setattr", "open_by_handle_at",
  // Kernel interfaces with a record of exploits; io_uring could also open sockets unfiltered.
  "bpf", "perf_event_open", "userfaultfd", "io_uring_setup", "io_uring_enter", "io_uring_register",
  // Host administration.
  "kexec_load", "kexec_file_load", "reboot", "init_module", "finit_module", "delete_module",
  "swapon", "swapoff", "acct", "quotactl", "syslog", "settimeofday", "clock_settime",
  "clock_adjtime", "adjtimex", "iopl", "ioperm", "vhangup", "lookup_dcookie",
};

static void install_seccomp(void) {
  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
  if (!ctx) die("seccomp_init");
  int rc = seccomp_attr_set(ctx, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_KILL_PROCESS);
  for (size_t i = 0; !rc && i < sizeof denied / sizeof *denied; i++) {
    int nr = seccomp_syscall_resolve_name(denied[i]);
    if (nr == __NR_SCMP_ERROR) { errno = EINVAL; die(denied[i]); }
    // A negative number is a syscall this architecture does not have (iopl on arm64).
    if (nr >= 0) rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), nr, 0);
  }
  // No network: every socket() fails, AF_UNIX included, so the inherited listener is the
  // only way in or out. socketpair stays for Node's child-process pipes.
  if (!rc) rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socket), 0);
  if (!rc) rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(socketpair), 1, SCMP_A0(SCMP_CMP_NE, AF_UNIX));
  static const unsigned long namespaces[] = { CLONE_NEWNS, CLONE_NEWCGROUP, CLONE_NEWUTS, CLONE_NEWIPC,
    CLONE_NEWUSER, CLONE_NEWPID, CLONE_NEWNET, CLONE_NEWTIME };
  for (size_t i = 0; !rc && i < sizeof namespaces / sizeof *namespaces; i++) {
    rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1, SCMP_A0(SCMP_CMP_MASKED_EQ, namespaces[i], namespaces[i]));
  }
  // clone3 takes its flags in memory a filter cannot read; ENOSYS makes glibc fall back to clone.
  if (!rc) rc = seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(clone3), 0);
  if (!rc) rc = seccomp_load(ctx);
  if (rc) { errno = -rc; die("seccomp"); }
  seccomp_release(ctx);
}

static void drop_to(uid_t uid, gid_t gid) {
  if (setgroups(0, NULL) || setgid(gid) || setuid(uid)) die("drop privileges");
  if (setuid(0) == 0) { errno = EPERM; die("privileges were not dropped"); }
}

static int listeners[MAX_SANDBOXES];
static pid_t sandboxes[MAX_SANDBOXES];
static struct timespec restart_at[MAX_SANDBOXES];
static int failures[MAX_SANDBOXES];
static struct timespec started_at[MAX_SANDBOXES];
static sigset_t original_mask;
static char *sandbox_argv[14];

static void listen_on(int index) {
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  snprintf(address.sun_path, sizeof address.sun_path, SOCKET_DIR "/%d.sock", index);
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
  if (fd < 0) die("socket");
  unlink(address.sun_path);
  if (bind(fd, (struct sockaddr *)&address, sizeof address)) die(address.sun_path);
  if (chown(address.sun_path, 0, RUNTIME_UID) || chmod(address.sun_path, 0660)) die(address.sun_path);
  if (listen(fd, 256)) die("listen");
  listeners[index] = fd;
}

static void start_sandbox(int index) {
  pid_t launcher = getpid();
  pid_t pid = fork();
  if (pid < 0) die("fork");
  if (pid == 0) {
    sigprocmask(SIG_SETMASK, &original_mask, NULL);
    // dup2 onto itself would keep close-on-exec, so clear it either way.
    if (dup2(listeners[index], 3) < 0 || fcntl(3, F_SETFD, 0)) die("dup2");
    int null = open("/dev/null", O_RDONLY);
    if (null < 0 || dup2(null, 0) < 0) die("/dev/null");
    if (close_range(4, ~0U, 0)) die("close_range");
    struct rlimit core = { 0, 0 }, processes = { 1024, 1024 };
    if (setrlimit(RLIMIT_CORE, &core) || setrlimit(RLIMIT_NPROC, &processes)) die("setrlimit");
    drop_to(SANDBOX_UID + index, SANDBOX_GID);
    // After the uid change, which would clear it.
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != launcher) die("parent");
    if (chdir("/")) die("chdir");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) die("no_new_privs");
    install_seccomp();
    char *env[] = { "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/nonexistent", "TMPDIR=/nonexistent", NULL };
    execve(NODE, sandbox_argv, env);
    die("execve " NODE);
  }
  sandboxes[index] = pid;
  clock_gettime(CLOCK_MONOTONIC, &started_at[index]);
  fprintf(stderr, "agent-launcher: sandbox %d started (pid %d, uid %d)\n", index, pid, SANDBOX_UID + index);
}

static double seconds_since(const struct timespec *then) {
  struct timespec now;
  clock_gettime(CLOCK_MONOTONIC, &now);
  return (now.tv_sec - then->tv_sec) + (now.tv_nsec - then->tv_nsec) / 1e9;
}

static const char *error_name(int ok) { return ok ? "ok" : strerrorname_np(errno); }

static int probe(pid_t target) {
  // As root, PTRACE_ATTACH would succeed and stop the target.
  if (getuid() < SANDBOX_UID || getuid() >= SANDBOX_UID + MAX_SANDBOXES) { fprintf(stderr, "agent-launcher: probe runs only as a sandbox uid\n"); return 2; }
  char path[64];
  struct iovec local = { path, 1 }, remote = { (void *)path, 1 };
  printf("{\"socket_inet\":\"%s\"", error_name(socket(AF_INET, SOCK_STREAM, 0) >= 0));
  printf(",\"socket_unix\":\"%s\"", error_name(socket(AF_UNIX, SOCK_STREAM, 0) >= 0));
  printf(",\"ptrace_attach\":\"%s\"", error_name(ptrace(PTRACE_ATTACH, target, 0, 0) == 0));
  printf(",\"process_vm_readv\":\"%s\"", error_name(process_vm_readv(target, &local, 1, &remote, 1, 0) >= 0));
  printf(",\"unshare_user\":\"%s\"", error_name(unshare(CLONE_NEWUSER) == 0));
  printf(",\"io_uring_setup\":\"%s\"", error_name(syscall(SYS_io_uring_setup, 1, path) >= 0));
  printf(",\"bpf\":\"%s\"", error_name(syscall(SYS_bpf, 0, NULL, 0) >= 0));
  snprintf(path, sizeof path, "/proc/%d/environ", target);
  printf(",\"environ\":\"%s\"", error_name(open(path, O_RDONLY) >= 0));
  snprintf(path, sizeof path, "/proc/%d/mem", target);
  printf(",\"mem\":\"%s\"}\n", error_name(open(path, O_RDONLY) >= 0));
  return 0;
}

int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "probe")) return probe(atoi(argv[2]));
  if (argc < 2) { fprintf(stderr, "usage: agent-launcher <runtime command...>\n"); return 2; }
  const char *configured = getenv("AGENT_SANDBOX_PROCESSES");
  char *end;
  long count = configured && *configured ? strtol(configured, &end, 10) : 2;
  if (configured && *configured && (*end || count < 0 || count > MAX_SANDBOXES)) {
    fprintf(stderr, "agent-launcher: AGENT_SANDBOX_PROCESSES must be 0..%d\n", MAX_SANDBOXES);
    return 2;
  }
  // Without sandbox processes the runtime runs js_exec itself and says so at startup.
  if (geteuid() != 0 || count == 0) {
    fprintf(stderr, "agent-launcher: %s; no sandbox processes\n", geteuid() != 0 ? "not root" : "AGENT_SANDBOX_PROCESSES=0");
    if (geteuid() == 0) drop_to(RUNTIME_UID, RUNTIME_UID);
    execvp(argv[1], argv + 1);
    die(argv[1]);
  }

  umask(0077);
  if (mkdir(SOCKET_DIR, 0710) && errno != EEXIST) die(SOCKET_DIR);
  if (chown(SOCKET_DIR, 0, RUNTIME_UID) || chmod(SOCKET_DIR, 0710)) die(SOCKET_DIR);
  char sockets[MAX_SANDBOXES * 32] = "";
  for (int i = 0; i < count; i++) {
    listen_on(i);
    snprintf(sockets + strlen(sockets), sizeof sockets - strlen(sockets), "%s" SOCKET_DIR "/%d.sock", i ? "," : "", i);
  }
  if (setenv("AGENT_SANDBOX_SOCKETS", sockets, 1)) die("setenv");
  umask(0022);

  // How many there are and v8-exec's settings are the only settings a sandbox process takes.
  int n = 0;
  static char processes_arg[32];
  sandbox_argv[n++] = "node";
  sandbox_argv[n++] = "--experimental-strip-types";
  sandbox_argv[n++] = "--disable-warning=ExperimentalWarning";
  sandbox_argv[n++] = SANDBOX_ENTRY;
  snprintf(sandbox_argv[n++] = processes_arg, sizeof processes_arg, "--processes=%ld", count);
  // v8-exec's settings (src/v8-exec.ts), checked here, since the sandbox processes get no environment.
  static char prespawn_arg[32], v8_max_arg[32];
  const char *prespawn = getenv("AGENT_V8_PRESPAWN"), *v8_max = getenv("AGENT_V8_MAX"), *jitless = getenv("AGENT_V8_JITLESS");
  if (prespawn && *prespawn && strspn(prespawn, "0123456789") == strlen(prespawn) && strlen(prespawn) < 4) snprintf(sandbox_argv[n++] = prespawn_arg, sizeof prespawn_arg, "--v8-prespawn=%s", prespawn);
  if (v8_max && *v8_max && strspn(v8_max, "0123456789") == strlen(v8_max) && strlen(v8_max) < 6) snprintf(sandbox_argv[n++] = v8_max_arg, sizeof v8_max_arg, "--v8-max=%s", v8_max);
  if (jitless && (!strcmp(jitless, "0") || !strcasecmp(jitless, "false"))) sandbox_argv[n++] = "--v8-jitless=0";
  const char *hooks = getenv("AGENT_SANDBOX_TEST_HOOKS");
  if (hooks && !strcmp(hooks, "1")) {
    sandbox_argv[n++] = "--test-hooks";
    fprintf(stderr, "agent-launcher: AGENT_SANDBOX_TEST_HOOKS=1: sandbox processes serve test probes\n");
  }
  sandbox_argv[n] = NULL;

  sigset_t handled;
  sigemptyset(&handled);
  int forwarded[] = { SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2 };
  for (size_t i = 0; i < sizeof forwarded / sizeof *forwarded; i++) sigaddset(&handled, forwarded[i]);
  sigaddset(&handled, SIGCHLD);
  if (sigprocmask(SIG_BLOCK, &handled, &original_mask)) die("sigprocmask");

  for (int i = 0; i < count; i++) start_sandbox(i);
  pid_t runtime = fork();
  if (runtime < 0) die("fork");
  if (runtime == 0) {
    sigprocmask(SIG_SETMASK, &original_mask, NULL);
    drop_to(RUNTIME_UID, RUNTIME_UID);
    execvp(argv[1], argv + 1);
    die(argv[1]);
  }
  fprintf(stderr, "agent-launcher: runtime started (pid %d, uid %d); %ld sandbox processes (uid %d..%ld, seccomp)\n", runtime, RUNTIME_UID, count, SANDBOX_UID, SANDBOX_UID + count - 1);

  for (;;) {
    // Sleep until a signal, or the next due restart.
    struct timespec wait = { 3600, 0 };
    for (int i = 0; i < count; i++) {
      if (sandboxes[i]) continue;
      double due = -seconds_since(&restart_at[i]);
      if (due <= 0) { start_sandbox(i); continue; }
      if (due < wait.tv_sec + wait.tv_nsec / 1e9) wait = (struct timespec){ (time_t)due, (long)((due - (time_t)due) * 1e9) };
    }
    int signal = sigtimedwait(&handled, NULL, &wait);
    if (signal < 0) continue;
    if (signal != SIGCHLD) { kill(runtime, signal); continue; }
    int status;
    pid_t pid;
    while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
      if (pid == runtime) {
        for (int i = 0; i < count; i++) if (sandboxes[i]) kill(sandboxes[i], SIGKILL);
        return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
      }
      for (int i = 0; i < count; i++) {
        if (sandboxes[i] != pid) continue;
        sandboxes[i] = 0;
        // Back off a process that keeps dying young: 0.25 s doubling to 30 s.
        failures[i] = seconds_since(&started_at[i]) < 10 ? failures[i] + 1 : 0;
        double delay = failures[i] ? 0.25 * (1 << (failures[i] < 8 ? failures[i] - 1 : 7)) : 0;
        if (delay > 30) delay = 30;
        clock_gettime(CLOCK_MONOTONIC, &restart_at[i]);
        restart_at[i].tv_sec += (time_t)delay;
        restart_at[i].tv_nsec += (long)((delay - (time_t)delay) * 1e9);
        if (restart_at[i].tv_nsec >= 1000000000L) { restart_at[i].tv_sec++; restart_at[i].tv_nsec -= 1000000000L; }
        fprintf(stderr, "agent-launcher: sandbox %d (pid %d) %s %d; restarting in %.2fs\n", i, pid,
          WIFEXITED(status) ? "exited with status" : "killed by signal", WIFEXITED(status) ? WEXITSTATUS(status) : WTERMSIG(status), delay);
      }
    }
  }
}
