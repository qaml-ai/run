// The allowlist v8-exec puts itself under once V8 is set up and the execution has arrived, just
// before any of the guest's code is parsed or run. It is on top of agent-launcher's denylist (which
// the process inherits) and applies to every thread (TSYNC). Anything not listed kills the process.
//
// What is left is what running JavaScript needs: memory (mmap/munmap/mprotect/madvise/mremap/brk),
// the two pipes (read/write), time (clock_gettime, the watchdog's sleep), futexes, signal masks,
// and exiting. No socket, no fork or clone, no exec, no ioctl; openat and prctl fail. Under --jitless, no
// executable memory either: mmap and mprotect with PROT_EXEC kill the process.
//
// Syscall numbers come from the libc crate for the target, so x86_64's and aarch64's tables both
// hold; the filter checks the architecture first (and so rejects x86_64's x32 and i386 ABIs).
// aarch64 has no legacy calls (open, stat, poll...): only the *at and p* forms, listed for both.

#[cfg(target_os = "linux")]
#[allow(non_snake_case)]
pub fn install(jitless: bool, debug: Debug) -> Result<(), String> {
  use libc::*;
  #[cfg(target_arch = "x86_64")]
  const ARCH: u32 = 0xC000_003E; // AUDIT_ARCH_X86_64
  #[cfg(target_arch = "aarch64")]
  const ARCH: u32 = 0xC000_00B7; // AUDIT_ARCH_AARCH64
  const RET_ALLOW: u32 = 0x7fff_0000;
  // scripts/v8-syscalls.ts: under --seccomp-debug a call outside the list fails with ENOSYS instead, so strace
  // shows it; under --seccomp-trap it raises SIGSYS, whose handler (main.rs) prints its number and exits.
  let RET_KILL_PROCESS: u32 = match debug { Debug::Off => 0x8000_0000, Debug::Errno => 0x0005_0000 | ENOSYS as u32, Debug::Trap => 0x0003_0000 };
  const LD_W_ABS: u16 = 0x20; // BPF_LD | BPF_W | BPF_ABS
  const JEQ_K: u16 = 0x15; // BPF_JMP | BPF_JEQ | BPF_K
  const JSET_K: u16 = 0x45; // BPF_JMP | BPF_JSET | BPF_K
  const RET_K: u16 = 0x06; // BPF_RET | BPF_K
  const NR: u32 = 0;
  const ARCH_OFFSET: u32 = 4;
  const ARG2_LOW: u32 = 16 + 2 * 8; // seccomp_data.args[2], low word (little-endian on both)

  let allowed: &[c_long] = &[
    SYS_read, SYS_write, SYS_writev, SYS_close,
    SYS_mmap, SYS_munmap, SYS_mprotect, SYS_madvise, SYS_mremap, SYS_brk,
    SYS_futex, SYS_sched_yield, SYS_sched_getaffinity,
    SYS_clock_gettime, SYS_clock_nanosleep, SYS_nanosleep, SYS_gettimeofday,
    SYS_rt_sigprocmask, SYS_rt_sigreturn, SYS_rt_sigaction, SYS_sigaltstack, SYS_restart_syscall,
    SYS_getpid, SYS_gettid, SYS_getrandom,
    SYS_exit, SYS_exit_group,
  ];
  let mut program: Vec<sock_filter> = Vec::new();
  let mut push = |code: u16, jt: u8, jf: u8, k: u32| program.push(sock_filter { code, jt, jf, k });
  push(LD_W_ABS, 0, 0, ARCH_OFFSET);
  push(JEQ_K, 1, 0, ARCH);
  push(RET_K, 0, 0, RET_KILL_PROCESS);
  push(LD_W_ABS, 0, 0, NR);
  if jitless {
    // mmap/mprotect: allowed unless asking for PROT_EXEC.
    for nr in [SYS_mmap, SYS_mprotect] {
      push(JEQ_K, 0, 4, nr as u32);
      push(LD_W_ABS, 0, 0, ARG2_LOW);
      push(JSET_K, 1, 0, PROT_EXEC as u32);
      push(RET_K, 0, 0, RET_ALLOW);
      push(RET_K, 0, 0, RET_KILL_PROCESS);
    }
  }
  for &nr in allowed {
    push(JEQ_K, 0, 1, nr as u32);
    push(RET_K, 0, 0, RET_ALLOW);
  }
  // tgkill to this process only: abort() (a V8 CHECK failing, a Rust panic) raises SIGABRT with it, and
  // should end the process as an abort, not as a seccomp kill. (x86_64 glibc's abort uses tgkill; V8's
  // own crashes trap without a call.)
  push(JEQ_K, 0, 3, SYS_tgkill as u32);
  push(LD_W_ABS, 0, 0, 16); // seccomp_data.args[0], low word: the thread group
  push(JEQ_K, 0, 1, unsafe { getpid() } as u32);
  push(RET_K, 0, 0, RET_ALLOW);
  push(LD_W_ABS, 0, 0, NR);
  // prctl fails with EINVAL rather than killing: on x86_64, V8 names the anonymous memory it maps as its
  // heap grows (PR_SET_VMA, seen at the CPU limit and in long regular expressions) and does without the
  // names. Failing every option keeps the rest of prctl (dumpable, no_new_privs, ...) out of reach.
  push(JEQ_K, 0, 1, SYS_prctl as u32);
  push(RET_K, 0, 0, 0x0005_0000 | EINVAL as u32); // SECCOMP_RET_ERRNO
  // openat fails with EACCES rather than killing: V8 and glibc open a few files of their own as they
  // run (/proc/self/maps for the main thread's stack bounds, /sys/devices/system/cpu/online and
  // /proc/stat to count CPUs, as the heap grows) and get on without them. Nothing is opened.
  push(JEQ_K, 0, 1, SYS_openat as u32);
  push(RET_K, 0, 0, 0x0005_0000 | EACCES as u32); // SECCOMP_RET_ERRNO
  push(RET_K, 0, 0, RET_KILL_PROCESS);

  let fprog = sock_fprog { len: program.len() as u16, filter: program.as_mut_ptr() };
  unsafe {
    if prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 { return Err(format!("no_new_privs: {}", std::io::Error::last_os_error())); }
    // SECCOMP_SET_MODE_FILTER (1), SECCOMP_FILTER_FLAG_TSYNC (1): the watchdog thread too.
    let rc = syscall(SYS_seccomp, 1 as c_ulong, 1 as c_ulong, &fprog as *const sock_fprog);
    if rc != 0 { return Err(format!("seccomp: {} ({rc})", std::io::Error::last_os_error())); }
  }
  Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn install(_jitless: bool, _debug: Debug) -> Result<(), String> { Ok(()) }

/// How a call outside the list ends: killing the process, or for tracing it, failing with ENOSYS or trapping.
#[derive(Clone, Copy, PartialEq)]
pub enum Debug { Off, Errno, Trap }
