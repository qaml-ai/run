// v8-exec: one js_exec execution in a fresh process, on a bare V8 isolate.
//
// The parent (src/v8-exec.ts) spawns this per execution and speaks length-prefixed JSON frames
// over stdin/stdout, the same messages a QuickJS worker exchanged over its MessagePort:
//   in:  {type:"request", id, method:"execute", params:{code, tools, timeoutMs, maxOutputCharacters, cpuMs}}
//        then {type:"response", id, result|error} for each tool call
//   out: {type:"request", id, method:"tool", params:{name, args}}, {type:"event", event:{type:"output", text}},
//        and one {type:"response", id, result:{output, truncated, returned, cpuMs}} or {..., error}
// There is no Node here: the guest's realm is a bare V8 context holding the ECMAScript built-ins,
// `tools`, `fs`, `console` and `text` (src/sandbox-bootstrap.ts), and nothing else.
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

const BOOTSTRAP: &str = include_str!("bootstrap.js");
const GLUE: &str = include_str!("glue.js");

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

struct Exec {
  remaining: usize,
  events: usize,
  output: Vec<String>,
  truncated: bool,
  returned: Option<serde_json::Value>,
  calls: usize,
  inflight: std::collections::HashSet<u64>,
  /// Tool calls made but not sent yet: they go out only once the guest is left waiting, so a call
  /// its code never awaited (it returned first) never reaches a tool.
  outbox: Vec<String>,
}

thread_local! {
  static EXEC: std::cell::RefCell<Exec> = std::cell::RefCell::new(Exec {
    remaining: 0, events: 0, output: vec![], truncated: false, returned: None, calls: 0, inflight: Default::default(), outbox: vec![],
  });
}

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

/// `send(id, name, json)`: a tool call, checked here as QuickJS's host function did, then sent to the parent.
fn send_cb(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue<v8::Value>) {
  let id = args.get(0).number_value(scope).unwrap_or(0.0) as u64;
  let (name, json) = (args.get(1), args.get(2));
  if !name.is_string() || !json.is_string() { return throw(scope, "Sandbox bridge expects a string", true); }
  let name = name.to_string(scope).unwrap();
  let json = json.to_string(scope).unwrap();
  if name.length() > 80 { return throw(scope, "Sandbox bridge string exceeds size limit", false); }
  let name = name.to_rust_string_lossy(scope);
  // fs.writeFile carries a file's bytes: up to a tool result's size, not a tool call's.
  let limit = if name == "fs.writeFile" { RESULT_BYTES } else { ARGUMENT_BYTES };
  if json.length() > limit as usize { return throw(scope, "Sandbox bridge string exceeds size limit", false); }
  let refused = EXEC.with(|exec| {
    let mut exec = exec.borrow_mut();
    exec.calls += 1;
    if exec.calls > TOOL_CALLS { return Some("Codemode tool call limit exceeded"); }
    if exec.inflight.len() >= CONCURRENT_TOOLS { return Some("Too many concurrent tool calls"); }
    exec.inflight.insert(id);
    None
  });
  if let Some(message) = refused { return throw(scope, message, false); }
  let json = json.to_rust_string_lossy(scope);
  // The guest's JSON goes as it is: the bootstrap made it with the real JSON.stringify, and the parent parses every frame.
  let frame = format!(r#"{{"type":"request","id":"{id}","method":"tool","params":{{"name":{},"args":{json}}}}}"#, serde_json::Value::String(name));
  EXEC.with(|exec| exec.borrow_mut().outbox.push(frame));
}

/// `emit(text, flags)`: output, bounded as QuickJS's host function bounded it. Flags: 1, cut at
/// 128,000 characters; 2, the value code returned; 4, rendered as JSON.
fn emit_cb(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue<v8::Value>) {
  let text = args.get(0);
  if !text.is_string() { return throw(scope, "Sandbox bridge expects a string", true); }
  let text = text.to_string(scope).unwrap();
  if text.length() > EMIT_CHARS as usize { return throw(scope, "Sandbox bridge string exceeds size limit", false); }
  let flags = args.get(1).int32_value(scope).unwrap_or(0);
  let length = text.length();
  let units: Vec<u16> = text.to_rust_string_lossy(scope).encode_utf16().collect();
  let event = EXEC.with(|exec| {
    let mut exec = exec.borrow_mut();
    let take = if exec.events < OUTPUT_EVENTS { exec.remaining.min(units.len()) } else { 0 };
    let part = String::from_utf16_lossy(&units[..take]);
    let cut = length > take || flags & 1 == 1;
    exec.truncated |= cut;
    if flags & 2 != 0 {
      let mut returned = serde_json::json!({ "json": flags & 4 == 4, "truncated": cut });
      if take > 0 { returned["index"] = exec.output.len().into(); }
      exec.returned = Some(returned);
    }
    if take == 0 { return None; }
    exec.events += 1;
    exec.remaining -= take;
    exec.output.push(part.clone());
    Some(part)
  });
  if let Some(text) = event { send_frame(&serde_json::json!({ "type": "event", "event": { "type": "output", "text": text } })); }
}

fn import_cb<'s>(
  scope: &mut v8::PinScope<'s, '_>,
  _options: v8::Local<'s, v8::Data>,
  _resource: v8::Local<'s, v8::Value>,
  _specifier: v8::Local<'s, v8::String>,
  _attributes: v8::Local<'s, v8::FixedArray>,
) -> Option<v8::Local<'s, v8::Promise>> {
  let message = v8::String::new(scope, "Module imports are disabled in codemode").unwrap();
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
// (the guest sees a RangeError, as QuickJS's fixed memory gave it).
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

/// Compile the bootstrap and glue in the current context: `[deliver, install, formatError, finish]`.
fn setup<'s>(scope: &mut v8::PinScope<'s, '_>) -> v8::Local<'s, v8::Array> {
  let send = v8::Function::new(scope, send_cb).unwrap();
  let emit = v8::Function::new(scope, emit_cb).unwrap();
  let bootstrap = run(scope, BOOTSTRAP, "sandbox-bootstrap.js");
  let glue = run(scope, GLUE, "glue.js");
  let glue = v8::Local::<v8::Function>::try_from(glue).unwrap();
  let undefined = v8::undefined(scope).into();
  let helpers = glue.call(scope, undefined, &[send.into(), emit.into(), bootstrap]).expect("glue failed");
  v8::Local::<v8::Array>::try_from(helpers).unwrap()
}

fn run<'s>(scope: &mut v8::PinScope<'s, '_>, source: &str, name: &str) -> v8::Local<'s, v8::Value> {
  let source = v8::String::new(scope, source).unwrap();
  let name = v8::String::new(scope, name).unwrap();
  let origin = v8::ScriptOrigin::new(scope, name.into(), 0, 0, false, 0, None, false, false, false, None);
  v8::Script::compile(scope, source, Some(&origin)).expect("trusted source compiles").run(scope).expect("trusted source runs")
}

const STRIP_PREFIX: &str = "async function __camelTypeStrip__() {\n";
const STRIP_SUFFIX: &str = "\n}";

/// TypeScript to JavaScript, as sucrase did: wrapped so top-level return and await parse, then
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

fn is_word(c: char) -> bool { c.is_ascii_alphanumeric() || c == '_' }

/// `\bword\b` somewhere in `text`.
fn has_word(text: &str, word: &str) -> bool {
  text.match_indices(word).any(|(at, _)| {
    let before = text[..at].chars().next_back().map_or(true, |c| !is_word(c));
    let after = text[at + word.len()..].chars().next().map_or(true, |c| !is_word(c));
    before && after
  })
}

/// shared/code-mode-source.ts's prepareCodeModeUserCode: code without a `return` returns its last expression.
fn prepare(code: &str) -> String {
  if code.trim().is_empty() || has_word(code, "return") { return code.to_string(); }
  let body = code.trim_end();
  let trailing = &code[body.len()..];
  let mut lines: Vec<String> = body.split('\n').map(String::from).collect();
  let Some(index) = lines.iter().rposition(|line| { let t = line.trim(); !t.is_empty() && !t.starts_with("//") }) else { return code.to_string() };
  let last = lines[index].clone();
  let trimmed = last.trim();
  let expression = trimmed.strip_suffix(';').unwrap_or(trimmed).trim();
  const KEYWORDS: [&str; 22] = ["break", "case", "catch", "class", "const", "continue", "debugger", "default", "do", "else", "export", "finally", "for", "function", "if", "import", "let", "return", "switch", "throw", "try", "var"];
  let keyword = KEYWORDS.iter().chain(["while", "with"].iter()).any(|kw| expression.starts_with(kw) && expression[kw.len()..].chars().next().map_or(true, |c| !is_word(c)));
  if expression.is_empty() || expression.ends_with('}') || keyword { return code.to_string(); }
  let indent: String = last.chars().take_while(|c| c.is_whitespace()).collect();
  lines[index] = format!("{indent}return {expression};");
  format!("{}{}", lines.join("\n"), trailing)
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
  // Not dumpable: processes of the same uid (the sandbox process, other executions' v8-exec
  // processes) cannot read this one's memory through /proc/<pid>/mem, whatever Yama's ptrace_scope.
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

  // One thread for V8: no compiler or GC helper threads. (WebAssembly is deleted from the global in glue.js.)
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
  let helpers = setup(scope);
  let (deliver, install, format_error, finish) = (helper(scope, helpers, 0), helper(scope, helpers, 1), helper(scope, helpers, 2), helper(scope, helpers, 3));
  let lockdown = helper(scope, helpers, 4);

  // Ready: everything above can happen before the execution arrives (a pre-spawned process waits here).
  let mut stdin = std::io::stdin().lock();
  let Some(request) = read_frame(&mut stdin) else { return };
  let id = request["id"].as_str().unwrap_or("").to_string();
  let _ = EXECUTION.set(id.clone());
  if request["type"] != "request" || request["method"] != "execute" { answer_and_exit(&id, Err("v8-exec takes one execute request".into())); }
  let params = &request["params"];
  let code = params["code"].as_str().unwrap_or("").to_string();
  let tools = params["tools"].to_string();
  let budget = params["cpuMs"].as_u64().unwrap_or(2_000).clamp(1, 30_000) as usize;
  CPU_MS.store(budget, Ordering::SeqCst);
  EXEC.with(|exec| exec.borrow_mut().remaining = params["maxOutputCharacters"].as_u64().unwrap_or(32_000) as usize);

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

  v8::tc_scope!(let tc, scope);
  let undefined: v8::Local<v8::Value> = v8::undefined(tc).into();
  let tools = v8::String::new(tc, &tools).unwrap();
  install.call(tc, undefined, &[tools.into()]).expect("install");

  // As quickjs-sandbox.ts did: code without a "<" is compiled as it is, and stripped only if that
  // fails; a "<" may be a generic call, which JavaScript reads as comparisons, so it is stripped first.
  let generic = code.contains('<');
  let mut promise = compile(tc, lockdown, &if generic { strip_typescript(&code) } else { code.clone() });
  if promise.is_none() && !generic && !tc.has_terminated() {
    let syntax = tc.exception().and_then(|exception| exception.to_object(tc)).and_then(|error| {
      let key = v8::String::new(tc, "name").unwrap();
      error.get(tc, key.into())
    }).map(|name| name.to_rust_string_lossy(tc) == "SyntaxError").unwrap_or(false);
    if syntax {
      tc.reset();
      promise = compile(tc, lockdown, &strip_typescript(&code));
    }
  }

  let guest_error = |tc: &mut v8::PinnedRef<'_, v8::TryCatch<v8::HandleScope>>, exception: Option<v8::Local<v8::Value>>| -> String {
    if tc.has_terminated() || REASON.load(Ordering::SeqCst) != 0 { return limit_message(); }
    let Some(exception) = exception else { return "Sandbox execution failed (memory or execution limit)".into() };
    tc.reset();
    let undefined = v8::undefined(tc).into();
    match format_error.call(tc, undefined, &[exception]) {
      Some(text) if text.is_string() => text.to_rust_string_lossy(tc).chars().take(2048).collect(),
      _ if tc.has_terminated() || REASON.load(Ordering::SeqCst) != 0 => limit_message(),
      _ => "Sandbox execution failed (memory or execution limit)".into(),
    }
  };

  let Some(promise) = promise else {
    let exception = tc.exception();
    let message = guest_error(tc, exception);
    answer_and_exit(&id, Err(message));
  };
  let Some(result) = finish.call(tc, undefined, &[promise]) else {
    let exception = tc.exception();
    let message = guest_error(tc, exception);
    answer_and_exit(&id, Err(message));
  };
  let result = v8::Local::<v8::Promise>::try_from(result).unwrap();
  tc.perform_microtask_checkpoint();

  loop {
    if tc.has_terminated() || REASON.load(Ordering::SeqCst) != 0 { answer_and_exit(&id, Err(limit_message())); }
    match result.state() {
      v8::PromiseState::Fulfilled => {
        if EXEC.with(|exec| !exec.borrow().inflight.is_empty()) {
          answer_and_exit(&id, Err("Unawaited tool calls: await all tool promises before returning".into()));
        }
        break;
      }
      v8::PromiseState::Rejected => {
        let reason = result.result(tc);
        let message = guest_error(tc, Some(reason));
        answer_and_exit(&id, Err(message));
      }
      v8::PromiseState::Pending => {}
    }
    for frame in EXEC.with(|exec| std::mem::take(&mut exec.borrow_mut().outbox)) {
      let _guard = OUT.lock().unwrap();
      if !DONE.load(Ordering::SeqCst) { write_frame(frame.as_bytes()); }
    }
    // Nothing in flight can settle it: wait for the parent's timeout to end the process.
    let Some(frame) = read_frame(&mut stdin) else { unsafe { libc::_exit(0) } };
    if frame["type"] != "response" { continue; }
    let Some(call) = frame["id"].as_str().and_then(|id| id.parse::<u64>().ok()) else { continue };
    if !EXEC.with(|exec| exec.borrow_mut().inflight.remove(&call)) { continue; }
    let (ok, text) = match frame.get("error") {
      Some(error) => (false, error.as_str().unwrap_or("Tool call failed").chars().take(2048).collect::<String>()),
      None => (true, frame["result"].as_str().map(String::from).unwrap_or_else(|| frame["result"].to_string())),
    };
    let call = v8::Number::new(tc, call as f64);
    let ok = v8::Boolean::new(tc, ok);
    let text = v8::String::new(tc, &text).unwrap();
    deliver.call(tc, undefined, &[call.into(), ok.into(), text.into()]);
    tc.perform_microtask_checkpoint();
  }

  let cpu = (cpu_ms() - started).round() as u64;
  let result = EXEC.with(|exec| {
    let exec = exec.borrow();
    // processCpuMs: the whole process's CPU, V8's startup included (the parent ignores it; benchmarks read it).
    let mut result = serde_json::json!({ "output": exec.output, "truncated": exec.truncated, "cpuMs": cpu, "processCpuMs": (cpu_ms() * 1000.0).round() / 1000.0 });
    if let Some(returned) = &exec.returned { result["returned"] = returned.clone(); }
    result
  });
  answer_and_exit(&id, Ok(result));
}

/// --seccomp-trap: print the number of the call the filter refused ("seccomp: syscall <n>") to stderr, and exit 99.
fn trap_sigsys() {
  #[cfg(target_os = "linux")]
  unsafe {
    extern "C" fn on_sigsys(_signal: libc::c_int, info: *mut libc::siginfo_t, _context: *mut c_void) {
      // siginfo_t's SIGSYS fields: _call_addr at 16, _syscall (an int) at 24, on both 64-bit Linux ABIs.
      let number = unsafe { *(info as *const u8).add(24).cast::<i32>() };
      let text = format!("seccomp: syscall {number}\n");
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

fn compile<'s>(scope: &mut v8::PinScope<'s, '_>, lockdown: v8::Local<'s, v8::Function>, code: &str) -> Option<v8::Local<'s, v8::Value>> {
  let wrapped = format!("(async function() {{ \"use strict\";\n{}\n}})()", prepare(code));
  let source = v8::String::new(scope, &wrapped)?;
  let name = v8::String::new(scope, "codemode.js").unwrap();
  let origin = v8::ScriptOrigin::new(scope, name.into(), 0, 0, false, 0, None, false, false, false, None);
  let script = v8::Script::compile(scope, source, Some(&origin))?;
  // After compiling, just before guest code runs: V8 installs SharedArrayBuffer on a context's first compile.
  let undefined = v8::undefined(scope).into();
  lockdown.call(scope, undefined, &[])?;
  script.run(scope)
}
