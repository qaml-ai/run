// The guest image includes Python 3. JSON arguments are supplied on stdin, separately from this program.
export const vmFilesGuest = String.raw`
import base64
from collections import deque
from contextlib import contextmanager
import fnmatch
import hashlib
import io
import json
import os
import re
import secrets
import stat
import sys

DIR = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW

class Refused(Exception):
    pass

@contextmanager
def directory(path, create=False):
    # Anchor traversal to the mount. A symlink in a parent is never followed.
    fd = os.open('.', DIR)
    try:
        for name in path.split('/') if path else ():
            try:
                child = os.open(name, DIR, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(name, dir_fd=fd)
                except FileExistsError:
                    pass
                child = os.open(name, DIR, dir_fd=fd)
            os.close(fd)
            fd = child
        yield fd
    finally:
        os.close(fd)

def parent(path, create=False):
    folder, _, name = path.rpartition('/')
    return directory(folder, create), name

def info(fd, name):
    s = os.stat(name, dir_fd=fd, follow_symlinks=False)
    if stat.S_ISLNK(s.st_mode):
        return '120000', s.st_size
    if stat.S_ISREG(s.st_mode):
        return ('100755' if s.st_mode & stat.S_IXUSR else '100644'), s.st_size
    return None, s.st_size

@contextmanager
def contents(fd, name):
    mode, _ = info(fd, name)
    if mode == '120000':
        data = os.readlink(os.fsencode(name), dir_fd=fd)
        yield mode, len(data), io.BytesIO(data)
    elif mode:
        f = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(f, 'rb') as data:
            s = os.fstat(f)
            if not stat.S_ISREG(s.st_mode):
                raise Refused('no_file')
            yield ('100755' if s.st_mode & stat.S_IXUSR else '100644'), s.st_size, data
    else:
        raise Refused('no_file')

def checksum(data):
    h = hashlib.sha256()
    for chunk in iter(lambda: data.read(128 * 1024), b''):
        h.update(chunk)
    return h.hexdigest()

def metadata(fd, name):
    try:
        with contents(fd, name) as (mode, size, data):
            return dict(mode=mode, size=size, sha256=checksum(data))
    except FileNotFoundError:
        return None

def path_stat(path):
    folder, name = parent(path)
    try:
        with folder as fd:
            return metadata(fd, name)
    except (FileNotFoundError, NotADirectoryError, Refused):
        return None

def expect(fd, name, token, path):
    if token is None:
        return
    try:
        current = metadata(fd, name)
    except Refused:
        current = {}
    if (current is None and token == 'none') or (current and current['sha256'] == token):
        return
    raise Refused('stale_path', dict(path=path, current=(current or {}).get('sha256')))

def read(a):
    folder, name = parent(a['path'])
    with folder as fd, contents(fd, name) as (_, size, data):
        offset = a.get('offset', 0)
        length = min(a.get('length', size), max(0, size - offset))
        if length > a['maxBytes']:
            raise Refused('too_large')
        sha = checksum(data)
        data.seek(min(offset, size))
        return dict(size=size, sha256=sha, bytes=base64.b64encode(data.read(length)).decode())

def write(a):
    path = a['path']
    try:
        return write_file(a, path)
    except (FileNotFoundError, NotADirectoryError):
        if a.get('expectSha256') not in (None, 'none'):
            raise Refused('stale_path', dict(path=path, current=None))
        raise

def write_file(a, path):
    token = a.get('expectSha256')
    folder, name = parent(path, create=token in (None, 'none'))
    data = base64.b64decode(a['bytes'])
    with folder as fd:
        # The directory descriptor keeps the temporary file and rename in the same directory.
        tmp = '.vmfiles-' + secrets.token_hex(16)
        try:
            mode = a.get('mode')
            if mode is None:
                try:
                    old, _ = info(fd, name)
                except FileNotFoundError:
                    old = None
                mode = '100755' if old == '100755' else '100644'
            if mode == '120000':
                os.symlink(data, tmp, dir_fd=fd)
            else:
                f = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=fd)
                with os.fdopen(f, 'wb') as out:
                    out.write(data)
                    os.fchmod(f, 0o755 if mode == '100755' else 0o644)
                    out.flush()
                    os.fsync(f)
            expect(fd, name, a.get('expectSha256'), path)
            os.replace(tmp, name, src_dir_fd=fd, dst_dir_fd=fd)
            os.fsync(fd)
        finally:
            try:
                os.unlink(tmp, dir_fd=fd)
            except FileNotFoundError:
                pass
    return dict(size=len(data), sha256=hashlib.sha256(data).hexdigest())

def delete(a):
    paths = a['paths']
    tokens = a.get('expectSha256', {})
    # Verify the entire batch before unlinking any path.
    for path in paths:
        old = path_stat(path)
        token = tokens.get(path)
        current = old['sha256'] if old else None
        if token is not None and (None if token == 'none' else token) != current:
            raise Refused('stale_path', dict(path=path, current=current))
        if old is None:
            raise Refused('no_file')
    for path in paths:
        folder, name = parent(path)
        with folder as fd:
            os.unlink(name, dir_fd=fd)
            os.fsync(fd)

def entries(prefix, recursive):
    try:
        with directory(prefix) as fd:
            names = os.listdir(fd)
            for name in names:
                if name == '.git':
                    continue
                path = prefix + '/' + name if prefix else name
                try:
                    mode, size = info(fd, name)
                    if mode:
                        yield dict(path=path, mode=mode, size=size)
                    elif stat.S_ISDIR(os.stat(name, dir_fd=fd, follow_symlinks=False).st_mode):
                        if recursive:
                            yield from entries(path, True)
                        else:
                            yield dict(path=path, mode='040000', size=0)
                except FileNotFoundError:
                    continue
    except (FileNotFoundError, NotADirectoryError):
        return

def ordered(prefix='', recursive=True):
    return sorted(entries(prefix, recursive), key=lambda entry: os.fsencode(entry['path']))

def listing(a):
    after = os.fsencode(a.get('after', ''))
    limit = a['limit']
    page = []
    reply_bytes = 0
    for entry in ordered(a.get('prefix', ''), a['recursive']):
        if os.fsencode(entry['path']) <= after:
            continue
        reply_bytes += len(json.dumps(entry, ensure_ascii=True, separators=(',', ':'))) + 1
        if len(page) == limit or reply_bytes > a['maxOutput'] - 32768:
            return dict(entries=page, next=page[-1]['path'])
        page.append(entry)
    return dict(entries=page)

def matches(path, data, pattern, context):
    if b'\x00' in data.read(8192):
        return
    data.seek(0)
    history = deque(maxlen=context)
    ahead = deque()
    for n, raw in enumerate(data, 1):
        line = raw.removesuffix(b'\n').decode(errors='replace')
        ahead.append((n, line))
        if len(ahead) > context:
            yield from match_line(path, pattern, history, ahead)
    while ahead:
        yield from match_line(path, pattern, history, ahead)

def match_line(path, pattern, history, ahead):
    n, line = ahead.popleft()
    if pattern.search(line):
        match = dict(path=path, line=n, text=line)
        if history:
            match['before'] = list(history)
        if ahead:
            match['after'] = [text for _, text in ahead]
        yield match
    history.append(line)

def grep(a):
    pattern = a['q'] if a.get('regex') else re.escape(a['q'])
    try:
        pattern = re.compile(pattern, re.IGNORECASE if a.get('ignoreCase') else 0)
    except re.error:
        raise Refused('bad_pattern')
    glob = a.get('path')
    limit = a['limit']
    found = []
    reply_bytes = 0
    files = 0
    for entry in ordered():
        path = entry['path']
        if glob and not (glob.endswith('/**') and path.startswith(glob[:-2])):
            parts, pattern_parts = path.split('/'), glob.split('/')
            if len(parts) != len(pattern_parts) or not all(
                fnmatch.fnmatchcase(part, pattern_part) for part, pattern_part in zip(parts, pattern_parts)
            ):
                continue
        folder, name = parent(path)
        try:
            with folder as fd, contents(fd, name) as (_, _, data):
                files += 1
                for match in matches(path, data, pattern, a['context']):
                    if len(found) == limit:
                        return dict(matches=found, files=files, truncated=True)
                    reply_bytes += len(json.dumps(match, ensure_ascii=True, separators=(',', ':'))) + 1
                    if reply_bytes + 128 > a['maxOutput']:
                        raise Refused('too_large')
                    found.append(match)
        except (FileNotFoundError, NotADirectoryError):
            continue
    return dict(matches=found, files=files, truncated=False)

a = json.load(sys.stdin)
try:
    operations = dict(stat=lambda a: {p: path_stat(p) for p in a['paths']},
                      read=read, write=write, delete=delete, list=listing, grep=grep)
    reply = dict(value=operations[a['op']](a))
except Refused as e:
    reply = dict(error=e.args[0], details=e.args[1] if len(e.args) > 1 else None)
except (FileNotFoundError, NotADirectoryError):
    reply = dict(error='no_file')
except IsADirectoryError:
    reply = dict(error='bad_path')
except (ValueError, OverflowError):
    reply = dict(error='bad_input')
print(json.dumps(reply, ensure_ascii=True, separators=(',', ':')))
`;
