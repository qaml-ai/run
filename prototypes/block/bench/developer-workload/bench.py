"""Run in a private mount and network namespace on a scratch NVMe filesystem."""

import hashlib
import json
import os
import pwd
import shutil
import subprocess as sp
import sys
import time
from pathlib import Path

clock = time.monotonic


def run_trial(work, base, mode, user):
    image = work / "disk.img"
    origin, mount = work / "ext4", work / "fuse"
    origin.mkdir()
    mount.mkdir()
    with image.open("wb") as f:
        f.truncate(4 * 1024**3)
    sp.run(
        [
            "mkfs.ext4",
            "-q",
            "-F",
            "-E",
            "lazy_itable_init=0,lazy_journal_init=0",
            image,
        ],
        check=True,
    )
    sp.run(["mount", "-o", "loop,noatime", image, origin], check=True)
    daemon = None
    result = {}
    binds = []
    try:
        shutil.copytree(base / "npm-source", origin / "repo")
        sp.run(
            ["chown", "-R", f"{user.pw_uid}:{user.pw_gid}", origin / "repo"], check=True
        )
        cwd = origin / "repo"
        if mode != "ext4":
            log = (work / "fuse.log").open("wb")
            daemon = sp.Popen(
                [
                    base / "fuse-loop",
                    "-allow-other",
                    "-passthrough="
                    + str(mode in {"passthrough", "local-build-dirs"}).lower(),
                    origin,
                    mount,
                ],
                stdout=log,
                stderr=log,
            )
            deadline = clock() + 10
            while not os.path.ismount(mount):
                if daemon.poll() is not None or clock() > deadline:
                    raise RuntimeError("FUSE failed to mount")
                time.sleep(0.005)
            cwd = mount / "repo"
            if mode == "local-build-dirs":
                for name in ("node_modules", "dist"):
                    direct = origin / "repo" / name
                    direct.mkdir()
                    os.chown(direct, user.pw_uid, user.pw_gid)
                    target = cwd / name
                    sp.run(["mount", "--bind", direct, target], check=True)
                    binds.append(target)
        env = {
            "HOME": user.pw_dir,
            "PATH": "/usr/local/bin:/usr/bin:/bin",
            "ONNXRUNTIME_NODE_INSTALL_CUDA": "skip",
        }

        def workload(key, args):
            t = clock()
            with (work / (key + ".log")).open("wb") as out:
                sp.run(
                    [
                        "setpriv",
                        "--reuid",
                        str(user.pw_uid),
                        "--regid",
                        str(user.pw_gid),
                        "--clear-groups",
                        "--no-new-privs",
                        *args,
                    ],
                    cwd=cwd,
                    env=env,
                    stdout=out,
                    stderr=sp.STDOUT,
                    check=True,
                )
            result[key] = clock() - t

        workload(
            "install_s",
            [
                "npm",
                "ci",
                "--offline",
                "--no-audit",
                "--no-fund",
                "--cache",
                base / "npm-cache",
            ],
        )
        # Sync the backing filesystem consistently across all modes.
        t = clock()
        sp.run(["sync", "-f", origin], check=True)
        result["install_local_sync_s"] = clock() - t
        workload("compile_s", ["node_modules/.bin/tsc", "-p", "bench.json"])
        t = clock()
        sp.run(["sync", "-f", origin], check=True)
        result["compile_local_sync_s"] = clock() - t
        dist = origin / "repo/dist"
        sha = hashlib.sha256()
        files = sorted(p for p in dist.rglob("*") if p.is_file())
        if not files:
            raise RuntimeError("compiler emitted no files")
        for p in files:
            sha.update(str(p.relative_to(dist)).encode() + b"\0")
            sha.update(hashlib.sha256(p.read_bytes()).digest())
        result.update(emitted=len(files), output_digest=sha.hexdigest(), mode=mode)
        return result
    finally:
        for target in reversed(binds):
            sp.run(["umount", target], check=True)
        if os.path.ismount(mount):
            sp.run(["umount", mount], check=True)
        if daemon:
            try:
                daemon.wait(5)
            except sp.TimeoutExpired:
                daemon.terminate()
                daemon.wait(5)
            log.close()
        sp.run(["umount", origin], check=True)
        image.unlink()


def main(base, compare_local_dirs):
    out = base / (
        "developer-local-dirs" if compare_local_dirs else "developer-workload"
    )
    out.mkdir()
    user = pwd.getpwnam("ubuntu")
    modes = (
        ["ext4", "local-build-dirs"]
        if compare_local_dirs
        else ["ext4", "fuse", "passthrough"]
    )
    rows = []
    for rep in range(3):
        offset = rep % len(modes)
        for mode in modes[offset:] + modes[:offset]:
            work = out / f"{rep}-{mode}"
            work.mkdir()
            row = run_trial(work, base, mode, user)
            row["repetition"] = rep
            rows.append(row)
            assert len({r["output_digest"] for r in rows}) == 1
            (out / "results.json").write_text(json.dumps(rows, indent=2) + "\n")
            print(
                mode,
                rep,
                round(row["install_s"], 2),
                round(row["compile_s"], 2),
                flush=True,
            )


if __name__ == "__main__":
    if sys.argv[2:] not in ([], ["--compare-local-dirs"]):
        raise SystemExit("expected scratch directory and optional --compare-local-dirs")
    main(Path(sys.argv[1]).resolve(), bool(sys.argv[2:]))
