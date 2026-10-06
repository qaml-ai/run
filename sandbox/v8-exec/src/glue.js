// Trusted: runs once per process, before guest code. It turns the two native
// functions into what the bootstrap expects: `call(name, json)` returning a promise of the result's
// JSON, settled by `deliver` when the host answers; `emit(text, flags)` as it is. Everything here
// belongs to the guest's realm: there is no other realm in this process to reach.
(function (send, emit, bootstrap) {
  "use strict";
  const PromiseCtor = Promise;
  const ErrorCtor = Error;
  const pending = Object.create(null);
  let next = 0;
  const call = (name, json) => new PromiseCtor((resolve, reject) => {
    const id = ++next;
    // Throws (the tool call quota, concurrency, sizes) as a rejection of this call.
    send(id, name, json);
    pending[id] = [resolve, reject];
  });
  const deliver = (id, ok, text) => {
    const entry = pending[id];
    if (!entry) return;
    delete pending[id];
    if (ok) entry[0](text); else entry[1](new ErrorCtor(text));
  };
  const [install, formatError, finish] = bootstrap(call, emit);
  // No shared memory and no WebAssembly: tool orchestration needs neither.
  const lockdown = () => {
    for (const name of ["SharedArrayBuffer", "Atomics", "WebAssembly"]) delete globalThis[name];
  };
  return [deliver, install, formatError, finish, lockdown];
})
