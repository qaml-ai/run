// v8-exec: one code mode script in a fresh process, on a bare V8 isolate.
//
// The parent (src/codemode-pi-launcher.ts, through src/v8-exec.ts) spawns this per execution and speaks
// length-prefixed JSON frames over stdin/stdout: pi-start-v1 installs Pi's prelude and reports the fingerprint,
// pi-run-v1 runs the script once the parent accepts it, pi-result-v1 delivers each call's result (pi.rs). There is
// no Node here: the guest's realm is a bare V8 context holding the ECMAScript built-ins and Pi's prelude.
//
// Limits, from the inside out: V8's heap limit (a near-heap-limit callback terminates), a
// counting ArrayBuffer allocator, a watchdog thread that terminates at the CPU budget and exits
// 250 ms later if V8 has not stopped, RLIMIT_CPU/RLIMIT_DATA/RLIMIT_FSIZE/RLIMIT_NPROC as backstops
// the guest cannot lift, a seccomp allowlist installed before guest code (seccomp.rs), and the
// parent's wall-clock timer, which kills the process. ICU data is compiled in, so Intl works.

use std::ffi::c_void;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::Duration;

mod seccomp;
mod pi;


// SANDBOX_LIMITS (src/limits.ts).
const OUTPUT_EVENTS: usize = 1024;
const TOOL_CALLS: usize = 256;
const CONCURRENT_TOOLS: usize = 32;
const ARGUMENT_BYTES: i32 = 128 * 1024;
const RESULT_BYTES: i32 = 1024 * 1024;
const EMIT_CHARS: i32 = 128_000;
const MAX_FRAME_BYTES: usize = 4 * 1024 * 1024;
const CPU_GRACE_MS: u64 = 250;
/// The guest's V8 heap, and the bytes its ArrayBuffers may hold besides.
const HEAP_BYTES: usize = 128 * 1024 * 1024;
const ARRAY_BUFFER_BYTES: usize = 128 * 1024 * 1024;

static OUT: Mutex<()> = Mutex::new(());
static DONE: AtomicBool = AtomicBool::new(false);
/// Why V8 was told to terminate: 1, the CPU budget; 2, the heap limit.
static REASON: AtomicU8 = AtomicU8::new(0);
static CPU_MS: AtomicUsize = AtomicUsize::new(0);
static ARRAY_BUFFERS: AtomicUsize = AtomicUsize::new(0);
/// Set when the allocator refuses a backing store: V8 then collects garbage as a last resort, which
/// calls the near-heap-limit callback, and it should not end the execution for that.
static REFUSED: AtomicBool = AtomicBool::new(false);
/// The execution's request id, once it has arrived: what V8's out-of-memory handler answers.
static EXECUTION: std::sync::OnceLock<String> = std::sync::OnceLock::new();

fn cpu_ms() -> f64 {
  let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 0 };
  unsafe { libc::clock_gettime(libc::CLOCK_PROCESS_CPUTIME_ID, &mut ts) };
  ts.tv_sec as f64 * 1000.0 + ts.tv_nsec as f64 / 1e6
}

fn write_frame(body: &[u8]) {
  let mut out = std::io::stdout().lock();
  let _ = out.write_all(&(body.len() as u32).to_be_bytes());
  let _ = out.write_all(body);
  let _ = out.flush();
}

fn send_frame(value: &serde_json::Value) {
  let _guard = OUT.lock().unwrap();
  if DONE.load(Ordering::SeqCst) { return; }
  write_frame(value.to_string().as_bytes());
}

/// The execution's one answer, then exit: whichever thread gets here first.
fn answer_and_exit(id: &str, outcome: Result<serde_json::Value, String>) -> ! {
  {
    let _guard = OUT.lock().unwrap();
    if !DONE.swap(true, Ordering::SeqCst) {
      let frame = match outcome {
        Ok(result) => serde_json::json!({ "type": "response", "id": id, "result": result }),
        Err(error) => serde_json::json!({ "type": "response", "id": id, "error": error }),
      };
      write_frame(frame.to_string().as_bytes());
    }
  }
  unsafe { libc::_exit(0) }
}

fn read_frame(input: &mut impl Read) -> Option<serde_json::Value> {
  let mut header = [0u8; 4];
  input.read_exact(&mut header).ok()?;
  let length = u32::from_be_bytes(header) as usize;
  if length > MAX_FRAME_BYTES { return None; }
  let mut body = vec![0u8; length];
  input.read_exact(&mut body).ok()?;
  serde_json::from_slice(&body).ok()
}

fn cpu_exceeded(cpu_ms: usize) -> String {
  format!("Codemode CPU limit exceeded: the execution kept its thread busy for over {cpu_ms} ms")
}

fn limit_message() -> String {
  match REASON.load(Ordering::SeqCst) {
    2 => "Codemode memory limit exceeded".to_string(),
    _ => cpu_exceeded(CPU_MS.load(Ordering::SeqCst)),
  }
}

fn throw(scope: &mut v8::PinScope, message: &str, type_error: bool) {
  let message = v8::String::new(scope, message).unwrap();
  let error = if type_error { v8::Exception::type_error(scope, message) } else { v8::Exception::error(scope, message) };
  scope.throw_exception(error);
}

fn import_cb<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  _options: v8::Local<'s, v8::Data>,
  _resource: v8::Local<'s, v8::Value>,
  _specifier: v8::Local<'s, v8::String>,
  _attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
  let message = v8::String::new(scope, "Module imports are disabled in codemode: scripts run plain JavaScript, with tools, console, text and image as globals (no import or require)").unwrap();
  let error = v8::Exception::error(scope, message);
  scope.throw_exception(error);
  None
}

/// V8 out of heap for good (one allocation past what near_heap_limit could make room for, such as a
/// huge array): it would abort the process. Answer as the heap limit does instead, and exit.
unsafe extern "C" fn out_of_memory(_location: *const std::ffi::c_char, _details: &v8::OomDetails) {
  REASON.store(2, Ordering::SeqCst);
  answer_and_exit(EXECUTION.get().map_or("", |id| id.as_str()), Err(limit_message()));
}

unsafe extern "C" fn near_heap_limit(data: *mut c_void, current: usize, _initial: usize) -> usize {
  if REFUSED.swap(false, Ordering::SeqCst) { return current; }
  let handle = &*(data as *const v8::IsolateHandle);
  REASON.store(2, Ordering::SeqCst);
  handle.terminate_execution();
  // Room to unwind to the termination rather than abort.
  current + 64 * 1024 * 1024
}

// ArrayBuffer backing stores live outside the V8 heap: count them, and refuse past the bound
// (the guest sees a RangeError).
unsafe extern "C" fn ab_allocate(_: &AtomicUsize, len: usize) -> *mut c_void {
  if ARRAY_BUFFERS.fetch_add(len, Ordering::SeqCst) + len > ARRAY_BUFFER_BYTES { ARRAY_BUFFERS.fetch_sub(len, Ordering::SeqCst); REFUSED.store(true, Ordering::SeqCst); return std::ptr::null_mut(); }
  let ptr = libc::calloc(len.max(1), 1);
  if ptr.is_null() { ARRAY_BUFFERS.fetch_sub(len, Ordering::SeqCst); }
  ptr
}
unsafe extern "C" fn ab_allocate_uninitialized(_: &AtomicUsize, len: usize) -> *mut c_void {
  if ARRAY_BUFFERS.fetch_add(len, Ordering::SeqCst) + len > ARRAY_BUFFER_BYTES { ARRAY_BUFFERS.fetch_sub(len, Ordering::SeqCst); REFUSED.store(true, Ordering::SeqCst); return std::ptr::null_mut(); }
  let ptr = libc::malloc(len.max(1));
  if ptr.is_null() { ARRAY_BUFFERS.fetch_sub(len, Ordering::SeqCst); }
  ptr
}
unsafe extern "C" fn ab_free(_: &AtomicUsize, data: *mut c_void, len: usize) {
  ARRAY_BUFFERS.fetch_sub(len, Ordering::SeqCst);
  libc::free(data);
}
unsafe extern "C" fn ab_drop(_: *const AtomicUsize) {}
static AB_HANDLE: AtomicUsize = AtomicUsize::new(0);
static AB_VTABLE: v8::RustAllocatorVtable<AtomicUsize> = v8::RustAllocatorVtable {
  allocate: ab_allocate, allocate_uninitialized: ab_allocate_uninitialized, free: ab_free, drop: ab_drop,
};

fn run<'s>(scope: &mut v8::PinScope<'s, '_>, source: &str, name: &str) -> v8::Local<'s, v8::Value> {
  let source = v8::String::new(scope, source).unwrap();
  let name = v8::String::new(scope, name).unwrap();
  let origin = v8::ScriptOrigin::new(scope, name.into(), 0, 0, false, 0, None, false, false, false, None);
  v8::Script::compile(scope, source, Some(&origin)).expect("trusted source compiles").run(scope).expect("trusted source runs")
}

const STRIP_PREFIX: &str = "async function __camelTypeStrip__() {\n";
const STRIP_SUFFIX: &str = "\n}";

/// TypeScript to JavaScript: wrapped so top-level return and await parse, then
/// oxc's TypeScript transform (types removed, enums and parameter properties compiled) and
/// reprinted. Anything it cannot parse is left as it is, for V8 to report.
fn strip_typescript(code: &str) -> String {
  use oxc::{allocator::Allocator, codegen::Codegen, parser::Parser, semantic::SemanticBuilder, span::SourceType, transformer::{TransformOptions, Transformer}};
  if code.trim().is_empty() { return code.to_string(); }
  let wrapped = format!("{STRIP_PREFIX}{code}{STRIP_SUFFIX}");
  let allocator = Allocator::default();
  let parsed = Parser::new(&allocator, &wrapped, SourceType::ts().with_script(true)).parse();
  if parsed.panicked || !parsed.diagnostics.is_empty() { return code.to_string(); }
  let mut program = parsed.program;
  let scoping = SemanticBuilder::new().build(&program).semantic.into_scoping();
  let transformed = Transformer::new(&allocator, std::path::Path::new("codemode.ts"), &TransformOptions::default()).build_with_scoping(scoping, &mut program);
  if !transformed.diagnostics.is_empty() { return code.to_string(); }
  let printed = Codegen::new().build(&program).code;
  // Reprinted: the body is between the wrapper's first "{" and its last "}".
  let trimmed = printed.trim_end();
  match (trimmed.starts_with("async function __camelTypeStrip__()"), trimmed.find('{'), trimmed.ends_with('}')) {
    (true, Some(open), true) => trimmed[open + 1..trimmed.len() - 1].to_string(),
    _ => code.to_string(),
  }
}

fn set_rlimit(resource: libc::c_int, soft: u64, hard: u64) {
  let limit = libc::rlimit { rlim_cur: soft as libc::rlim_t, rlim_max: hard as libc::rlim_t };
  #[allow(clippy::useless_conversion)]
  unsafe { libc::setrlimit(resource as _, &limit) };
}

fn main() {
  let args: Vec<String> = std::env::args().collect();
  let flag = |name: &str| args.iter().position(|arg| arg == name).and_then(|i| args.get(i + 1)).cloned();
  let jitless = args.iter().any(|arg| arg == "--jitless");
  // Not dumpable: no process of the same uid (agent-launcher gives each one its own; without it,
  // the runtime's) can read this one's memory through /proc/<pid>/mem, whatever Yama's ptrace_scope.
  // (Not under --seccomp-debug, so strace can read its calls' arguments.)
  #[cfg(target_os = "linux")]
  if !args.iter().any(|arg| arg == "--seccomp-debug") { unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) }; }
  // No core files, and no files written at all: stdout is a pipe, which RLIMIT_FSIZE leaves alone.
  set_rlimit(libc::RLIMIT_CORE as _, 0, 0);
  set_rlimit(libc::RLIMIT_FSIZE as _, 0, 0);
  // Memory the process may map writable, a backstop behind the heap and ArrayBuffer limits.
  // (RLIMIT_AS cannot do this: V8 reserves ~17 GB of address space up front.)
  if let Some(mb) = flag("--max-data-mb").and_then(|mb| mb.parse::<u64>().ok()) {
    set_rlimit(libc::RLIMIT_DATA as _, mb << 20, mb << 20);
  }

  // One thread for V8: no compiler or GC helper threads. (WebAssembly is deleted from the global in pi-glue.js.)
  // One malloc arena: glibc makes one per thread otherwise, reading /sys (openat) to size them, which
  // the seccomp filter would kill when the watchdog thread first allocates.
  #[cfg(target_os = "linux")]
  unsafe { libc::mallopt(libc::M_ARENA_MAX, 1) };
  v8::V8::set_flags_from_string(&format!("--single-threaded --enable-sharedarraybuffer-per-context{}", if jitless { " --jitless" } else { "" }));
  v8::V8::initialize_platform(v8::new_single_threaded_default_platform(false).make_shared());
  // ICU data compiled in (deno_core_icudata, ICU 78, the version V8 is built with): Intl works, in en-US and UTC.
  v8::icu::set_common_data_78(deno_core_icudata::ICU_DATA).expect("ICU data");
  v8::icu::set_default_locale("en-US");
  let _ = v8::icu::set_default_time_zone("UTC");
  v8::V8::initialize();

  let allocator = unsafe { v8::new_rust_allocator(&AB_HANDLE as *const AtomicUsize, &AB_VTABLE) };
  let params = v8::CreateParams::default().heap_limits(0, HEAP_BYTES).array_buffer_allocator(allocator);
  let isolate = &mut v8::Isolate::new(params);
  isolate.set_microtasks_policy(v8::MicrotasksPolicy::Explicit);
  isolate.set_host_import_module_dynamically_callback(import_cb);
  let handle: &'static v8::IsolateHandle = Box::leak(Box::new(isolate.thread_safe_handle()));
  isolate.add_near_heap_limit_callback(near_heap_limit, handle as *const _ as *mut c_void);
  isolate.set_oom_error_handler(out_of_memory);

  v8::scope!(let scope, isolate);
  let context = v8::Context::new(scope, Default::default());
  let scope = &mut v8::ContextScope::new(scope, context);

  // Ready: everything above can happen before the execution arrives (a pre-spawned process waits here).
  let mut stdin = std::io::stdin().lock();
  let Some(request) = read_frame(&mut stdin) else { return };
  let id = request["id"].as_str().unwrap_or("").to_string();
  let _ = EXECUTION.set(id.clone());
  if request["type"] != "request" || request["method"] != "pi-start-v1" { answer_and_exit(&id, Err("v8-exec takes one pi-start-v1 request".into())); }
  let params = &request["params"];
  let budget = params["cpuMs"].as_u64().unwrap_or(2_000).clamp(1, 30_000) as usize;
  CPU_MS.store(budget, Ordering::SeqCst);

  // The CPU budget: the watchdog terminates V8 at it, and exits if V8 has not stopped 250 ms later;
  // RLIMIT_CPU (whole seconds, past both) kills a process that got around the watchdog.
  let started = cpu_ms();
  let watchdog_id = id.clone();
  // The filter below covers this thread too, so it must be past its own start-up first.
  let (started_tx, started_rx) = std::sync::mpsc::channel::<()>();
  std::thread::spawn(move || loop {
    let _ = started_tx.send(());
    std::thread::sleep(Duration::from_millis(5));
    if DONE.load(Ordering::SeqCst) { return; }
    if cpu_ms() - started < budget as f64 { continue; }
    REASON.store(1, Ordering::SeqCst);
    handle.terminate_execution();
    std::thread::sleep(Duration::from_millis(CPU_GRACE_MS));
    answer_and_exit(&watchdog_id, Err(cpu_exceeded(budget)));
  });
  let seconds = (started as u64 + budget as u64 + CPU_GRACE_MS) / 1000 + 2;
  set_rlimit(libc::RLIMIT_CPU as _, seconds, seconds + 1);
  #[cfg(target_os = "linux")]
  set_rlimit(libc::RLIMIT_NPROC as _, 0, 0);
  // From here on, only the system calls seccomp.rs allows (it fails closed): before any of the
  // guest's code is parsed, TypeScript stripping included.
  if !args.iter().any(|arg| arg == "--no-seccomp") {
    let _ = started_rx.recv();
    let debug = if args.iter().any(|arg| arg == "--seccomp-debug") { seccomp::Debug::Errno }
      else if args.iter().any(|arg| arg == "--seccomp-trap") { trap_sigsys(); seccomp::Debug::Trap } else { seccomp::Debug::Off };
    if let Err(error) = seccomp::install(jitless, debug) { answer_and_exit(&id, Err(format!("v8-exec could not install its seccomp filter: {error}"))); }
  }
  // Test hook (tests/v8-exec.test.ts): a call the filter does not allow, which must kill the process.
  if args.iter().any(|arg| arg == "--test-forbidden-syscall") { unsafe { libc::getuid() }; }
  // And executable memory, which under --jitless must kill it too.
  if args.iter().any(|arg| arg == "--test-exec-memory") { unsafe { libc::mmap(std::ptr::null_mut(), 4096, libc::PROT_READ | libc::PROT_EXEC, libc::MAP_PRIVATE | libc::MAP_ANONYMOUS, -1, 0) }; }

  std::env::set_var("TZ", "UTC");
  pi::execute(scope, &mut stdin, params, jitless, HEAP_BYTES, &args);
}

/// --seccomp-trap: print the number of the call the filter refused ("seccomp: syscall <n>") to stderr, and exit 99.
fn trap_sigsys() {
  #[cfg(target_os = "linux")]
  unsafe {
    extern "C" fn on_sigsys(_signal: libc::c_int, info: *mut libc::siginfo_t, context: *mut c_void) {
      // siginfo_t's SIGSYS fields: _call_addr at 16, _syscall (an int) at 24, on both 64-bit Linux ABIs.
      let number = unsafe { *(info as *const u8).add(24).cast::<i32>() };
      // Its first argument, from the registers the call was made with.
      let context = context as *const libc::ucontext_t;
      #[cfg(target_arch = "x86_64")]
      let first = unsafe { (*context).uc_mcontext.gregs[libc::REG_RDI as usize] as u64 };
      #[cfg(target_arch = "aarch64")]
      let first = unsafe { (*context).uc_mcontext.regs[0] };
      let text = format!("seccomp: syscall {number} (first argument {first:#x})\n");
      unsafe { libc::write(2, text.as_ptr().cast(), text.len()); libc::_exit(99) };
    }
    let mut action: libc::sigaction = std::mem::zeroed();
    action.sa_sigaction = on_sigsys as usize;
    action.sa_flags = libc::SA_SIGINFO;
    libc::sigaction(libc::SIGSYS, &action, std::ptr::null_mut());
  }
}

fn helper<'s>(scope: &mut v8::PinScope<'s, '_>, helpers: v8::Local<'s, v8::Array>, index: u32) -> v8::Local<'s, v8::Function> {
  v8::Local::<v8::Function>::try_from(helpers.get_index(scope, index).unwrap()).unwrap()
}
