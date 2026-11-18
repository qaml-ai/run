import ctypes as ct
import errno
import os
from pathlib import Path

import device

HERE = Path(__file__).resolve().parent
Transfer = ct.CFUNCTYPE(ct.c_int, ct.c_int, ct.c_ulonglong, ct.c_size_t, ct.c_void_p)


Output = ct.CFUNCTYPE(ct.c_int, ct.c_void_p, ct.c_uint)


def workspace_file(h, path, data=None, output=None):
    if not path or any(part in ("", ".", "..") for part in path.split("/")) or "\0" in path:
        raise ValueError("expected a workspace-relative path")
    lib = ct.CDLL(str(HERE / "edit.so"))
    lib.workspace_file.argtypes = [Transfer, ct.c_char_p, ct.c_int, ct.c_char_p, ct.c_size_t, Output]
    lib.workspace_file.restype = ct.c_long
    errors = []

    @Transfer
    def transfer(write, offset, size, pointer):
        try:
            if offset + size > device.get_size(h):
                raise ValueError("invalid ext4 IO range")
            if write:
                device.pwrite(h, ct.string_at(pointer, size), offset, 0)
            else:
                buf = bytearray(size)
                device.pread(h, buf, offset, 0)
                ct.memmove(pointer, bytes(buf), size)
            return 0
        except Exception as error:  # noqa: BLE001 - exceptions cannot cross a ctypes callback.
            errors.append(error)
            return errno.EIO

    @Output
    def emit(ptr, size):
        try:
            output.write(ct.string_at(ptr, size))
            return 0
        except Exception as error:
            errors.append(error)
            return errno.EIO

    status = lib.workspace_file(transfer, os.fsencode(path), data is not None, data,
                                len(data) if data is not None else 0, emit)
    if errors:
        raise errors[0]
    if status in (errno.ENOENT, errno.EINVAL, errno.ENOTDIR):
        raise OSError(status, os.strerror(status), path)
    if status:
        raise OSError(f"ext4 editor rejected image or operation ({status})")


