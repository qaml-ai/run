// agent-launcher: the image's entrypoint, started as root under the container's init.
//
// It runs the runtime (argv) as the node uid with AGENT_SANDBOX_DIR set, then starts a confined
// process for each connection to one of the unix sockets there:
//   - v8.sock: sandbox/v8-exec, for one js_exec execution (src/v8-exec.ts);
//   - parse.sock: Node on src/parse-job.ts, for one untrusted file (src/inspect.ts).
// The sockets are root:node 0660 in a root:node 0710 directory, so only the runtime's uid connects.
// Each process runs as a uid no other live process has (1001 + slot, group sandbox), so none can
// open another's /proc/<pid>/mem, with the connection as its stdin and stdout, no other
// descriptors, an empty environment, no_new_privs and the seccomp filter below. The runtime closing
// the connection kills the process; when the process ends, how it ended goes to the connection as
// a last frame ({"type":"exit","code":N} or {"type":"exit","signal":"SIGSYS"}) and it is closed.
// It forwards termination signals to the runtime and exits with its status.
//
// `agent-launcher probe <pid>` is a test hook: it reports, as JSON, how the calls the
// filter denies fail. tests/image-isolation.ts runs it from inside a confined process.
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <poll.h>
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
#include <sys/signalfd.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/uio.h>
#include <sys/un.h>
#include <sys/wait.h>
#include <unistd.h>

#define RUNTIME_UID 1000
#define SANDBOX_UID 1001
#define SANDBOX_GID 1001
#define SOCKET_DIR "/run/agent-sandbox"
#define NODE "/usr/local/bin/node"
#define V8_EXEC "/usr/local/bin/v8-exec"
#define PARSE_ENTRY "/app/src/parse-job.ts"
// Confined processes at once; each has its own uid, SANDBOX_UID + its slot.
#define MAX_CHILDREN 512
#ifndef CLONE_NEWTIME
#define CLONE_NEWTIME 0x00000080
#endif

enum kind { V8, PARSE, KINDS };
static const char *const socket_names[KINDS] = { "v8.sock", "parse.sock" };

static void die(const char *what) {
  fprintf(stderr, "agent-launcher: %s: %s\n", what, strerror(errno));
  exit(1);
}

// A denylist, not an allowlist: Node, V8, libuv and glibc use a large syscall set that
// shifts with their versions and the kernel, and a missing entry crashes rare paths
// (worker teardown, OOM). What is denied is what an escaped guest would use to reach
// other processes, the network or kernel attack surface a JavaScript runtime never needs.
// v8-exec adds its own allowlist on top (sandbox/v8-exec/src/seccomp.rs).
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
  // No network: every socket() fails, AF_UNIX included, so the inherited connection is the
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

/** A confined process, by slot: its pid (0 once reaped), its connection (-1 once closed), and whether the runtime hung up. */
static struct { pid_t pid; int conn; int hung_up; } children[MAX_CHILDREN];
static sigset_t original_mask;
static char *argvs[KINDS][8];

static int listen_on(const char *name) {
  struct sockaddr_un address = { .sun_family = AF_UNIX };
  snprintf(address.sun_path, sizeof address.sun_path, SOCKET_DIR "/%s", name);
  int fd = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC | SOCK_NONBLOCK, 0);
  if (fd < 0) die("socket");
  unlink(address.sun_path);
  if (bind(fd, (struct sockaddr *)&address, sizeof address)) die(address.sun_path);
  if (chown(address.sun_path, 0, RUNTIME_UID) || chmod(address.sun_path, 0660)) die(address.sun_path);
  if (listen(fd, 256)) die("listen");
  return fd;
}

/** Start a process of `kind` on `conn` in a free slot, or close `conn` when there is none. */
static void start(enum kind kind, int conn) {
  int slot = 0;
  while (slot < MAX_CHILDREN && (children[slot].pid || children[slot].conn >= 0)) slot++;
  if (slot == MAX_CHILDREN) { fprintf(stderr, "agent-launcher: %d confined processes running; refused one\n", MAX_CHILDREN); close(conn); return; }
  pid_t launcher = getpid();
  pid_t pid = fork();
  if (pid < 0) { fprintf(stderr, "agent-launcher: fork: %s\n", strerror(errno)); close(conn); return; }
  if (pid == 0) {
    sigprocmask(SIG_SETMASK, &original_mask, NULL);
    // dup2 clears close-on-exec on the copies. v8-exec's stderr goes nowhere; Node's to the launcher's.
    if (dup2(conn, 0) < 0 || dup2(conn, 1) < 0) die("dup2");
    if (kind == V8) {
      int null = open("/dev/null", O_WRONLY);
      if (null < 0 || dup2(null, 2) < 0) die("/dev/null");
    }
    if (close_range(3, ~0U, 0)) die("close_range");
    struct rlimit core = { 0, 0 }, processes = { 1024, 1024 };
    if (setrlimit(RLIMIT_CORE, &core) || setrlimit(RLIMIT_NPROC, &processes)) die("setrlimit");
    drop_to(SANDBOX_UID + slot, SANDBOX_GID);
    // After the uid change, which would clear it.
    if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != launcher) die("parent");
    // Anything an earlier process of this uid left behind (a child it forked) goes before this one runs.
    kill(-1, SIGKILL);
    if (chdir("/")) die("chdir");
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) die("no_new_privs");
    install_seccomp();
    char *env[] = { "PATH=/usr/local/bin:/usr/bin:/bin", "HOME=/nonexistent", "TMPDIR=/nonexistent", NULL };
    execve(kind == V8 ? V8_EXEC : NODE, argvs[kind], env);
    die(kind == V8 ? "execve " V8_EXEC : "execve " NODE);
  }
  children[slot].pid = pid;
  children[slot].conn = conn;
  children[slot].hung_up = 0;
}

/** How a process ended, as the last frame on its connection; dropped if the runtime is not reading. */
static void report(int conn, int status) {
  char frame[128];
  const char *name = WIFSIGNALED(status) ? sigabbrev_np(WTERMSIG(status)) : NULL;
  int length = WIFSIGNALED(status) ? (name ? snprintf(frame + 4, sizeof frame - 4, "{\"type\":\"exit\",\"signal\":\"SIG%s\"}", name)
      : snprintf(frame + 4, sizeof frame - 4, "{\"type\":\"exit\",\"signal\":\"%d\"}", WTERMSIG(status)))
    : snprintf(frame + 4, sizeof frame - 4, "{\"type\":\"exit\",\"code\":%d}", WEXITSTATUS(status));
  uint32_t header = htonl((uint32_t)length);
  memcpy(frame, &header, 4);
  (void)!send(conn, frame, 4 + length, MSG_DONTWAIT | MSG_NOSIGNAL);
}

int main(int argc, char **argv) {
  if (argc == 3 && !strcmp(argv[1], "probe")) {
    pid_t target = atoi(argv[2]);
    // As root, PTRACE_ATTACH would succeed and stop the target.
    if (getuid() < SANDBOX_UID || getuid() >= SANDBOX_UID + MAX_CHILDREN) { fprintf(stderr, "agent-launcher: probe runs only as a sandbox uid\n"); return 2; }
    char path[64];
    struct iovec local = { path, 1 }, remote = { (void *)path, 1 };
#define OUTCOME(ok) ((ok) ? "ok" : strerrorname_np(errno))
    printf("{\"socket_inet\":\"%s\"", OUTCOME(socket(AF_INET, SOCK_STREAM, 0) >= 0));
    printf(",\"socket_unix\":\"%s\"", OUTCOME(socket(AF_UNIX, SOCK_STREAM, 0) >= 0));
    printf(",\"ptrace_attach\":\"%s\"", OUTCOME(ptrace(PTRACE_ATTACH, target, 0, 0) == 0));
    printf(",\"process_vm_readv\":\"%s\"", OUTCOME(process_vm_readv(target, &local, 1, &remote, 1, 0) >= 0));
    printf(",\"unshare_user\":\"%s\"", OUTCOME(unshare(CLONE_NEWUSER) == 0));
    printf(",\"io_uring_setup\":\"%s\"", OUTCOME(syscall(SYS_io_uring_setup, 1, path) >= 0));
    printf(",\"bpf\":\"%s\"", OUTCOME(syscall(SYS_bpf, 0, NULL, 0) >= 0));
    snprintf(path, sizeof path, "/proc/%d/environ", target);
    printf(",\"environ\":\"%s\"", OUTCOME(open(path, O_RDONLY) >= 0));
    snprintf(path, sizeof path, "/proc/%d/mem", target);
    printf(",\"mem\":\"%s\"}\n", OUTCOME(open(path, O_RDONLY) >= 0));
    return 0;
  }
  if (argc < 2) { fprintf(stderr, "usage: agent-launcher <runtime command...>\n"); return 2; }
  // Without root there is nothing to confine with: the runtime runs v8-exec and parses files in
  // processes of its own, and says so at startup.
  if (geteuid() != 0) {
    fprintf(stderr, "agent-launcher: not root; no confined processes\n");
    execvp(argv[1], argv + 1);
    die(argv[1]);
  }

  // The settings the confined processes take, fixed here: they get no environment.
  int n = 0;
  argvs[V8][n++] = "v8-exec";
  const char *jitless = getenv("AGENT_V8_JITLESS");
  if (!jitless || (strcmp(jitless, "0") && strcasecmp(jitless, "false"))) argvs[V8][n++] = "--jitless";
  // RLIMIT_DATA, behind its heap (128 MB) and ArrayBuffer (128 MB) limits.
  argvs[V8][n++] = "--max-data-mb";
  argvs[V8][n++] = "512";
  argvs[V8][n] = NULL;
  n = 0;
  argvs[PARSE][n++] = "node";
  argvs[PARSE][n++] = "--experimental-strip-types";
  argvs[PARSE][n++] = "--disable-warning=ExperimentalWarning";
  argvs[PARSE][n++] = PARSE_ENTRY;
  const char *hooks = getenv("AGENT_SANDBOX_TEST_HOOKS");
  if (hooks && !strcmp(hooks, "1")) {
    argvs[PARSE][n++] = "--test-hooks";
    fprintf(stderr, "agent-launcher: AGENT_SANDBOX_TEST_HOOKS=1: parse jobs serve test probes\n");
  }
  argvs[PARSE][n] = NULL;

  umask(0077);
  if (mkdir(SOCKET_DIR, 0710) && errno != EEXIST) die(SOCKET_DIR);
  if (chown(SOCKET_DIR, 0, RUNTIME_UID) || chmod(SOCKET_DIR, 0710)) die(SOCKET_DIR);
  int listeners[KINDS];
  for (int kind = 0; kind < KINDS; kind++) listeners[kind] = listen_on(socket_names[kind]);
  if (setenv("AGENT_SANDBOX_DIR", SOCKET_DIR, 1)) die("setenv");
  umask(0022);
  for (int slot = 0; slot < MAX_CHILDREN; slot++) children[slot].conn = -1;

  sigset_t handled;
  sigemptyset(&handled);
  int forwarded[] = { SIGTERM, SIGINT, SIGHUP, SIGQUIT, SIGUSR1, SIGUSR2 };
  for (size_t i = 0; i < sizeof forwarded / sizeof *forwarded; i++) sigaddset(&handled, forwarded[i]);
  sigaddset(&handled, SIGCHLD);
  if (sigprocmask(SIG_BLOCK, &handled, &original_mask)) die("sigprocmask");
  int signals = signalfd(-1, &handled, SFD_CLOEXEC | SFD_NONBLOCK);
  if (signals < 0) die("signalfd");

  pid_t runtime = fork();
  if (runtime < 0) die("fork");
  if (runtime == 0) {
    sigprocmask(SIG_SETMASK, &original_mask, NULL);
    drop_to(RUNTIME_UID, RUNTIME_UID);
    execvp(argv[1], argv + 1);
    die(argv[1]);
  }
  fprintf(stderr, "agent-launcher: runtime started (pid %d, uid %d); confined processes on demand (uid %d..%d, seccomp)\n",
    runtime, RUNTIME_UID, SANDBOX_UID, SANDBOX_UID + MAX_CHILDREN - 1);

  static struct pollfd fds[1 + KINDS + MAX_CHILDREN];
  static int slots[MAX_CHILDREN];
  for (;;) {
    int count = 0;
    fds[count++] = (struct pollfd){ signals, POLLIN, 0 };
    for (int kind = 0; kind < KINDS; kind++) fds[count++] = (struct pollfd){ listeners[kind], POLLIN, 0 };
    // A connection the runtime closed: only hang-ups are watched, its data is the process's to read.
    int watched = 0;
    for (int slot = 0; slot < MAX_CHILDREN; slot++) {
      if (children[slot].conn < 0 || children[slot].hung_up) continue;
      slots[watched++] = slot;
      fds[count++] = (struct pollfd){ children[slot].conn, POLLRDHUP, 0 };
    }
    if (poll(fds, count, -1) < 0) { if (errno == EINTR) continue; die("poll"); }

    for (int i = 0; i < watched; i++) {
      if (!fds[1 + KINDS + i].revents) continue;
      int slot = slots[i];
      children[slot].hung_up = 1;
      if (children[slot].pid) kill(children[slot].pid, SIGKILL);
    }
    for (int kind = 0; kind < KINDS; kind++) {
      if (!(fds[1 + kind].revents & POLLIN)) continue;
      int conn;
      while ((conn = accept4(listeners[kind], NULL, NULL, SOCK_CLOEXEC)) >= 0) start(kind, conn);
    }
    if (!fds[0].revents) continue;
    struct signalfd_siginfo info;
    while (read(signals, &info, sizeof info) == sizeof info) {
      if (info.ssi_signo != SIGCHLD) { kill(runtime, info.ssi_signo); continue; }
      int status;
      pid_t pid;
      while ((pid = waitpid(-1, &status, WNOHANG)) > 0) {
        if (pid == runtime) {
          for (int slot = 0; slot < MAX_CHILDREN; slot++) if (children[slot].pid) kill(children[slot].pid, SIGKILL);
          return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
        }
        for (int slot = 0; slot < MAX_CHILDREN; slot++) {
          if (children[slot].pid != pid) continue;
          if (!children[slot].hung_up) report(children[slot].conn, status);
          close(children[slot].conn);
          children[slot].pid = 0;
          children[slot].conn = -1;
          break;
        }
      }
    }
  }
}
