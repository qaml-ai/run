# Run with gdb -q -batch -nx -c CORE -x segv-triage.py NODE.
import os
import re
import sys

import gdb


def has_startup_frame(frame):
    inferior = gdb.selected_inferior()
    sp = int(frame.read_register("sp"))
    for offset in range(0, 1024 * 8, 8):
        try:
            word = inferior.read_memory(sp + offset, 8)
        except gdb.MemoryError:
            break
        address = int.from_bytes(word, sys.byteorder)
        if address < 4096:
            continue
        symbol = gdb.execute(f"info symbol {address:#x}", to_string=True)
        if "Isolate::Init" in symbol or "Heap::SetUp" in symbol:
            return True
    return False


def corrupt_return(frame):
    # A return to a non-canonical address (overwritten stack, e.g. text over a return address) faults at the ret.
    # Node's SIGSEGV handler re-raises it while the signal is blocked, so si_code reads SI_TKILL from the process
    # itself: the code says nothing; the instruction and the return address do.
    pc = int(frame.read_register("pc"))
    if gdb.selected_inferior().read_memory(pc, 1).tobytes() != b"\xc3":
        return False
    sp = int(frame.read_register("sp"))
    target = int.from_bytes(gdb.selected_inferior().read_memory(sp, 8), sys.byteorder)
    return not (target < (1 << 47) or target >= ((1 << 64) - (1 << 47)))


core = frame0 = "?"
si_code = si_pid = core_pid = 0
startup = False
classification = "unknown"
try:
    files = gdb.execute("info files", to_string=True)
    path = re.search(r"^Local core dump file:\s*\n\s*`(.+?)',", files, re.MULTILINE)
    if path:
        core = os.path.basename(path[1])
        name = re.fullmatch(r"core\..+\.([0-9]+)\.[0-9]+", core)
        if name:
            core_pid = int(name[1])
    frame = gdb.selected_frame()
    frame0 = frame.name() or "?"
    siginfo = gdb.parse_and_eval("$_siginfo")
    si_code = int(siginfo["si_code"])
    si_pid = int(siginfo["_sifields"]["_kill"]["si_pid"])
    # A signal the process sent itself from code (raise, kill, pthread_kill, tgkill, abort) stops in that call.
    reraised = any(name in frame0 for name in ("raise", "kill", "abort"))
    startup = has_startup_frame(frame)
    if corrupt_return(frame):
        classification = "stack-corrupt"
    elif si_code > 0 or reraised:
        classification = "fault"
except Exception:
    pass

print(
    f"SEGV_TRIAGE {core} class={classification} si_code={si_code} si_pid={si_pid} "
    f"core_pid={core_pid} frame0={' '.join(frame0.split())} startup={'yes' if startup else 'no'}"
)
