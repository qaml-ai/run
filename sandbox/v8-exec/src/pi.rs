// Versioned Pi start protocol.
use super::*;
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashSet};

const GLUE: &str = include_str!("pi-glue.js");

#[derive(Default)]
struct State {
  issued: u64,
  inflight: HashSet<u64>,
  outbox: Vec<Value>,
  output: usize,
  events: usize,
  images: usize,
  image_bytes: usize,
  error: Option<String>,
}

// Output past these is left out, with one note where it stopped, rather than failing the script: its tool calls ran.
// SANDBOX_LIMITS (src/limits.ts) outputImages and outputImageBytes.
const OUTPUT_IMAGES: usize = 16;
const IMAGE_BYTES: usize = 8 * 1024 * 1024;
const TEXT_CUT: &str = "[Output stops here: a script prints at most 1,024 times and 128,000 bytes. Return or write what you need instead.]";
const IMAGE_CUT: &str = "[Images past 16, or past 8 MiB in all, were left out.]";

/// An output item within the limits: the item itself, cut short, or nothing, and the note to add once when output was left out.
fn bounded(state: &mut State, mut frame: Value) -> Vec<Value> {
  let note = |text: &str| json!({ "type": "output", "item": { "type": "text", "text": text } });
  if frame["item"]["type"] == "image" {
    let size = frame["item"]["data"].as_str().map_or(0, str::len);
    if state.images < OUTPUT_IMAGES && state.image_bytes + size <= IMAGE_BYTES {
      state.images += 1;
      state.image_bytes += size;
      return vec![frame];
    }
    let first = state.images <= OUTPUT_IMAGES;
    state.images = OUTPUT_IMAGES + 1;
    return if first { vec![note(IMAGE_CUT)] } else { vec![] };
  }
  if state.events > OUTPUT_EVENTS { return vec![]; }
  let text = frame["item"]["text"].as_str().unwrap_or("").to_string();
  let room = (EMIT_CHARS as usize).saturating_sub(state.output);
  if state.events < OUTPUT_EVENTS && text.len() <= room {
    state.events += 1;
    state.output += text.len();
    return vec![frame];
  }
  let mut end = if state.events < OUTPUT_EVENTS { room.min(text.len()) } else { 0 };
  state.events = OUTPUT_EVENTS + 1;
  while !text.is_char_boundary(end) { end -= 1; }
  if end == 0 { return vec![note(TEXT_CUT)]; }
  frame["item"]["text"] = Value::String(text[..end].to_string());
  vec![frame, note(TEXT_CUT)]
}
thread_local! { static STATE: std::cell::RefCell<State> = Default::default(); }

fn refuse(scope: &mut v8::PinScope, message: &str) {
  STATE.with(|state| state.borrow_mut().error = Some(message.into()));
  throw(scope, message, false);
}

fn send(scope: &mut v8::PinScope, args: v8::FunctionCallbackArguments, _rv: v8::ReturnValue<v8::Value>) {
  let value = args.get(0);
  if !value.is_string() { return refuse(scope, "Pi bridge requires JSON"); }
  let text = value.to_string(scope).unwrap();
  if text.length() > MAX_FRAME_BYTES / 2 { return refuse(scope, "Pi bridge frame exceeds limit"); }
  let text = text.to_rust_string_lossy(scope);
  if text.len() > MAX_FRAME_BYTES { return refuse(scope, "Pi bridge frame exceeds limit"); }
  let Ok(mut frame) = serde_json::from_str::<Value>(&text) else { return refuse(scope, "Invalid Pi bridge JSON") };
  let error = STATE.with(|state| {
    let mut state = state.borrow_mut();
    let kind = frame["type"].as_str().map(str::to_owned);
    let error = match kind.as_deref() {
      Some("call") => {
        let id = frame["id"].as_u64().unwrap_or(0);
        if id != state.issued + 1 || id > TOOL_CALLS as u64 { Some("Pi tool call limit or invalid call id") }
        else if state.inflight.len() >= CONCURRENT_TOOLS { Some("Too many concurrent tool calls") }
        else if frame["args"].as_str().map_or(0, str::len) > ARGUMENT_BYTES as usize { Some("Pi call arguments exceed limit") }
        else { state.issued = id; state.inflight.insert(id); None }
      }
      Some("output") => {
        let kept = bounded(&mut *state, std::mem::take(&mut frame));
        state.outbox.extend(kept);
        return None;
      }
      Some("done") => None,
      _ => Some("Invalid Pi bridge message"),
    };
    if let Some(error) = error { state.error = Some(error.into()); }
    else { state.outbox.push(frame); }
    error
  });
  if let Some(error) = error { throw(scope, error, false); }
}

fn crash(message: &str) -> ! {
  send_frame(&json!({ "type": "crash", "message": message }));
  unsafe { libc::_exit(0) }
}

// Source and dependency hashes also cover compiler/TS transform changes. This is an identity,
// not a signature: changing any input deliberately refuses old replay fingerprints.
fn hash(text: &str) -> String {
  let value = text.bytes().fold(0xcbf29ce484222325u64, |hash, byte| (hash ^ byte as u64).wrapping_mul(0x100000001b3));
  format!("{value:016x}")
}

pub(super) fn execute(scope: &mut v8::PinScope, stdin: &mut impl Read, data: &Value, jitless: bool, heap: usize, args: &[String]) -> ! {
  if !data["code"].as_str().is_some_and(|code| code.len() <= 256 * 1024)
    || !data["tools"].is_array() || !data["globals"].is_array() || !data["store"].is_object()
    || data.get("deterministic").is_some_and(|clock| !clock["startedAt"].as_f64().is_some_and(|n| n.is_finite() && n >= 0.0)
      || !clock["seed"].as_u64().is_some_and(|n| n <= u32::MAX as u64)) {
    crash("Malformed Pi start data");
  }
  let Some(prelude) = data["prelude"].as_str() else { crash("Missing Pi prelude"); };
  // The trusted launcher hashes the exact prelude it sends, once at module load.
  let Some(prelude_sha256) = data["preludeSha256"].as_str() else { crash("Missing Pi prelude SHA-256"); };
  let fingerprint = format!(
    "v8-exec {} v8 {} protocol pi-start-v1 arch {} os {} jitless {} heap {} arraybuffer {} cpu {} wall {} calls {} concurrent {} args {} result {} output {} events {} frame {} icu 78 prelude-sha256 {} glue {} build {} flags {}",
    env!("CARGO_PKG_VERSION"), v8::V8::get_version(), std::env::consts::ARCH, std::env::consts::OS, jitless,
    heap, ARRAY_BUFFER_BYTES, CPU_MS.load(Ordering::SeqCst), data["wallMs"], TOOL_CALLS, CONCURRENT_TOOLS, ARGUMENT_BYTES, RESULT_BYTES,
    EMIT_CHARS, OUTPUT_EVENTS, MAX_FRAME_BYTES, prelude_sha256, hash(GLUE),
    hash(&format!("{}{}{}{}", include_str!("main.rs"), include_str!("pi.rs"), include_str!("../Cargo.lock"), include_str!("seccomp.rs"))),
    args.iter().skip(1).cloned().collect::<Vec<_>>().join(" "),
  );
  // The host must accept the fingerprint before even compiling user code.
  send_frame(&json!({ "type": "started", "fingerprint": fingerprint }));
  let Some(ack) = read_frame(stdin) else { unsafe { libc::_exit(0) } };
  if ack != json!({ "type": "request", "id": "pi", "method": "pi-run-v1" }) { crash("Expected pi-run-v1 acknowledgement"); }

  v8::tc_scope!(let tc, scope);
  let undefined = v8::undefined(tc).into();
  let bootstrap = run(tc, prelude, "codemode-prelude.js");
  let glue = run(tc, GLUE, "pi-glue.js");
  let glue = v8::Local::<v8::Function>::try_from(glue).unwrap();
  let send = v8::Function::new(tc, send).unwrap();
  let data_json = v8::String::new(tc, &data.to_string()).unwrap();
  let Some(api) = glue.call(tc, undefined, &[send.into(), bootstrap, data_json.into()]) else {
    let message = tc.exception().map(|error| error.to_rust_string_lossy(tc)).unwrap_or_default();
    crash(&format!("Pi bootstrap failed: {message}"));
  };
  let api = v8::Local::<v8::Array>::try_from(api).unwrap();
  let settle = helper(tc, api, 0);
  let execute = helper(tc, api, 1);
  let stalled = helper(tc, api, 2);
  let lockdown = helper(tc, api, 3);
  let code = strip_typescript(data["code"].as_str().unwrap_or(""));
  // As Pi's vm.js: an async function body on the prefix's line.
  // The script in a block of its own, inside the function: it may declare `tools` or `console` itself, as it could in
  // js_exec, where they were globals (a parameter's name, declared again in the function's own body, is a SyntaxError).
  let source = v8::String::new(tc, &format!("(async (tools, console) => {{ {{{code}\n}} }})")).unwrap();
  let name = v8::String::new(tc, "codemode.js").unwrap();
  let origin = v8::ScriptOrigin::new(tc, name.into(), 0, 0, false, 0, None, false, false, false, None);
  let function = v8::Script::compile(tc, source, Some(&origin)).and_then(|script| script.run(tc));
  let Some(function) = function else {
    if tc.has_terminated() { crash(&limit_message()); }
    let mut message = tc.exception().map(|error| error.to_rust_string_lossy(tc)).unwrap_or_else(|| "Script compilation failed".into());
    // A static import, as code written for Node or for js_exec's fs: say what there is instead.
    if message.contains("import statement") {
      message.push_str(". codemode runs plain JavaScript with no modules: files are the agent's file tools, called as await tools.read({ path }) and await tools.write({ path, content })");
    }
    send_frame(&json!({ "type": "done", "ok": false, "error": json!({ "name": "SyntaxError", "message": message }).to_string(), "during": { "seq": 0, "issued": 0 } }));
    unsafe { libc::_exit(0) }
  };
  lockdown.call(tc, undefined, &[]);
  let started = cpu_ms();
  execute.call(tc, undefined, &[function]);
  let mut seq = 0u64;
  let mut early = BTreeMap::<u64, Value>::new();
  let mut received = HashSet::new();
  loop {
    tc.perform_microtask_checkpoint();
    if tc.has_terminated() || REASON.load(Ordering::SeqCst) != 0 { crash(&limit_message()); }
    if tc.has_caught() { crash("Pi bridge execution failed"); }
    stalled.call(tc, undefined, &[]);
    if let Some(error) = STATE.with(|state| state.borrow().error.clone()) { crash(&error); }
    let outbox = STATE.with(|state| std::mem::take(&mut state.borrow_mut().outbox));
    let mut done = false;
    for mut message in outbox {
      // The CPU the script used, for the runtime's metrics (the launcher takes it off before Pi sees the frame).
      if message["type"] == "done" { done = true; message["cpuMs"] = ((cpu_ms() - started).round() as u64).into(); }
      send_frame(&message);
    }
    if done { unsafe { libc::_exit(0) } }
    send_frame(&json!({ "type": "idle", "seq": seq, "issued": STATE.with(|state| state.borrow().issued) }));
    let next = loop {
      if let Some(next) = early.remove(&(seq + 1)) { break next; }
      let Some(envelope) = read_frame(stdin) else { crash("Invalid or truncated Pi result frame"); };
      if envelope["type"] != "request" || envelope["method"] != "pi-result-v1" { crash("Expected pi-result-v1"); }
      let frame = envelope["params"].clone();
      let number = frame["seq"].as_u64().unwrap_or(0);
      let id = frame["id"].as_u64().unwrap_or(0);
      let valid = frame["type"] == "result" && number > seq && number <= TOOL_CALLS as u64 && !early.contains_key(&number)
        && frame["ok"].is_boolean() && frame["now"].as_f64().is_some_and(f64::is_finite)
        && STATE.with(|state| state.borrow().inflight.contains(&id)) && received.insert(id)
        && frame.get("payload").map_or(true, |v| v.as_str().is_some_and(|s| s.len() <= RESULT_BYTES as usize))
        && frame.get("properties").map_or(true, |v| v.as_str().is_some_and(|s| s.len() <= RESULT_BYTES as usize && serde_json::from_str::<Value>(s).is_ok_and(|p| p.is_object())));
      if !valid { crash("Malformed or duplicate Pi result"); }
      if frame["ok"] == true && frame.get("payload").is_some_and(|v| serde_json::from_str::<Value>(v.as_str().unwrap()).is_err()) { crash("Invalid Pi result JSON"); }
      early.insert(number, frame);
    };
    seq += 1;
    STATE.with(|state| { state.borrow_mut().inflight.remove(&next["id"].as_u64().unwrap()); });
    let json = v8::String::new(tc, &next.to_string()).unwrap();
    settle.call(tc, undefined, &[json.into()]);
  }
}
