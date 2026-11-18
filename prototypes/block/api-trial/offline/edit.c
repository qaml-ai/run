/* Each call owns a private block view. Failed transactions discard that view. */
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <ext2fs/ext2fs.h>

typedef int (*transfer_fn)(int writing, unsigned long long offset, size_t size, void *data);
static _Thread_local transfer_fn transfer;
static struct struct_io_manager manager;

static errcode_t open_channel(const char *name, int flags, io_channel *out)
{
    (void)flags;
    io_channel c = calloc(1, sizeof(*c));
    if (!c) return ENOMEM;
    c->name = strdup(name);
    if (!c->name) { free(c); return ENOMEM; }
    c->manager = &manager;
    c->magic = EXT2_ET_MAGIC_IO_CHANNEL;
    c->refcount = 1;
    c->block_size = 1024;
    *out = c;
    return 0;
}
static errcode_t close_channel(io_channel c)
{
    if (--c->refcount == 0) { free(c->name); free(c); }
    return 0;
}
static errcode_t set_size(io_channel c, int size)
{
    if (size <= 0) return EINVAL;
    c->block_size = size;
    return 0;
}
static errcode_t blocks(io_channel c, unsigned long long b, int n, void *data, int writing)
{
    unsigned size = c->block_size;
    if (b > ULLONG_MAX / size) return EOVERFLOW;
    size_t bytes = n < 0 ? (size_t)-(long long)n : (size_t)n * size;
    return transfer(writing, b * size, bytes, data);
}
static errcode_t read64(io_channel c, unsigned long long b, int n, void *d) { return blocks(c,b,n,d,0); }
static errcode_t write64(io_channel c, unsigned long long b, int n, const void *d) { return blocks(c,b,n,(void *)d,1); }
static errcode_t read32(io_channel c, unsigned long b, int n, void *d) { return read64(c,b,n,d); }
static errcode_t write32(io_channel c, unsigned long b, int n, const void *d) { return write64(c,b,n,d); }
static errcode_t write_bytes(io_channel c, unsigned long off, int size, const void *d)
{
    (void)c;
    return size < 0 ? EINVAL : transfer(1,off,size,(void *)d);
}
/* All channel writes have already entered this request's private view. */
static errcode_t flush(io_channel c) { (void)c; return 0; }
static struct struct_io_manager manager = {
    .magic=EXT2_ET_MAGIC_IO_MANAGER, .name="snapshot", .open=open_channel, .close=close_channel,
    .set_blksize=set_size, .read_blk=read32, .write_blk=write32, .read_blk64=read64,
    .write_blk64=write64, .write_byte=write_bytes, .flush=flush
};

typedef int (*output_fn)(const void *, unsigned);

static errcode_t create_file(ext2_filsys fs, ext2_ino_t parent, const char *name,
                             ext2_ino_t *ino)
{
    struct ext2_inode inode = {0};
    inode.i_mode = LINUX_S_IFREG | 0644;
    inode.i_links_count = 1;
    inode.i_atime = inode.i_ctime = inode.i_mtime = time(NULL);
    errcode_t err = ext2fs_new_inode(fs, parent, inode.i_mode, NULL, ino);
    if (err) return err;
    err = ext2fs_write_new_inode(fs, *ino, &inode);
    if (err) return err;
    ext2fs_inode_alloc_stats2(fs, *ino, 1, 0);
    err = ext2fs_link(fs, parent, name, *ino, EXT2_FT_REG_FILE);
    if (err == EXT2_ET_DIR_NO_SPACE) {
        err = ext2fs_expand_dir(fs, parent);
        if (!err) err = ext2fs_link(fs, parent, name, *ino, EXT2_FT_REG_FILE);
    }
    return err;
}

/* Walk individual directory entries without following symlinks. */
static errcode_t resolve(ext2_filsys fs, char *path, int create, ext2_ino_t *out)
{
    ext2_ino_t parent = EXT2_ROOT_INO;
    while (*path) {
        char *next = strchr(path, '/');
        if (next) *next++ = 0;
        size_t len = strlen(path);
        if (!len || len > EXT2_NAME_LEN || !strcmp(path, ".") || !strcmp(path, "..")) return EINVAL;
        ext2_ino_t ino;
        errcode_t err = ext2fs_lookup(fs, parent, path, len, NULL, &ino);
        if (err == EXT2_ET_FILE_NOT_FOUND && create) {
            if (!next) return create_file(fs, parent, path, out);
            err = ext2fs_mkdir(fs, parent, 0, path);
            if (err == EXT2_ET_DIR_NO_SPACE) {
                err = ext2fs_expand_dir(fs, parent);
                if (!err) err = ext2fs_mkdir(fs, parent, 0, path);
            }
            if (!err) err = ext2fs_lookup(fs, parent, path, len, NULL, &ino);
        }
        if (err == EXT2_ET_FILE_NOT_FOUND) return ENOENT;
        if (err) return err;
        if (!next) { *out = ino; return 0; }
        err = ext2fs_check_directory(fs, ino);
        if (err) return err == EXT2_ET_NO_DIRECTORY ? ENOTDIR : err;
        parent = ino;
        path = next;
    }
    return EINVAL;
}

errcode_t workspace_file(transfer_fn io, const char *path, int writing,
                         const char *data, size_t size, output_fn output)
{
    ext2_filsys fs = NULL;
    ext2_file_t file = NULL;
    ext2_ino_t ino;
    struct ext2_inode inode;
    char *parts = strdup(path);
    if (!parts) return ENOMEM;
    transfer = io;
    errcode_t err = ext2fs_open("workspace", EXT2_FLAG_64BITS | (writing ? EXT2_FLAG_RW : 0),
                                0, 0, &manager, &fs);
    if (err) goto done;
    if (fs->super->s_state != EXT2_VALID_FS || fs->super->s_last_orphan ||
        ext2fs_has_feature_journal_needs_recovery(fs->super) || ext2fs_has_feature_orphan_present(fs->super)) {
        err = EUCLEAN;
        goto done;
    }
    if (writing && (err = ext2fs_read_bitmaps(fs))) goto done;
    err = resolve(fs, parts, writing, &ino);
    if (err) goto done;
    err = ext2fs_read_inode(fs, ino, &inode);
    if (err) goto done;
    if (!LINUX_S_ISREG(inode.i_mode) || (writing && inode.i_links_count != 1)) { err = EINVAL; goto done; }
    err = ext2fs_file_open(fs, ino, writing ? EXT2_FILE_WRITE : 0, &file);
    if (err) goto done;
    if (writing) {
        for (size_t pos = 0; pos < size;) {
            unsigned n = size - pos > 65536 ? 65536 : size - pos;
            unsigned written = 0;
            err = ext2fs_file_write(file, data + pos, n, &written);
            if (err || written != n) { if (!err) err = EIO; break; }
            pos += n;
        }
        if (!err) err = ext2fs_file_set_size2(file, size);
    } else {
        unsigned n;
        char buf[65536];
        do {
            err = ext2fs_file_read(file, buf, sizeof(buf), &n);
            if (!err && n) err = output(buf, n);
        } while (!err && n);
    }
    errcode_t closed = ext2fs_file_close(file);
    if (!err) err = closed;
    if (err || !writing) goto done;
    err = ext2fs_read_inode(fs, ino, &inode);
    if (err) goto done;
    inode.i_mtime = inode.i_ctime = time(NULL);
    err = ext2fs_write_inode(fs, ino, &inode);
    if (!err) err = ext2fs_flush(fs);
done:
    if (fs) ext2fs_free(fs);
    transfer = NULL;
    free(parts);
    return err;
}
