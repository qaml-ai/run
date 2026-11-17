/* A single trusted fixture edit. The caller owns a private copy-on-write block view. */
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

errcode_t replace_fixture(transfer_fn io, const char *data, unsigned size)
{
    ext2_filsys fs = NULL;
    ext2_file_t file = NULL;
    ext2_ino_t ino;
    struct ext2_inode inode;
    unsigned written = 0;
    transfer = io;
    errcode_t err = ext2fs_open("snapshot", EXT2_FLAG_RW | EXT2_FLAG_64BITS, 0, 0, &manager, &fs);
    if (err) goto done;
    if (fs->super->s_state != EXT2_VALID_FS || fs->super->s_last_orphan ||
        ext2fs_has_feature_journal_needs_recovery(fs->super) || ext2fs_has_feature_orphan_present(fs->super)) {
        err = EUCLEAN;
        goto done;
    }
    err = ext2fs_namei(fs, EXT2_ROOT_INO, EXT2_ROOT_INO, "/src/main.py", &ino);
    if (err) goto done;
    err = ext2fs_read_inode(fs, ino, &inode);
    if (err) goto done;
    if (!LINUX_S_ISREG(inode.i_mode) || inode.i_links_count != 1) { err = EINVAL; goto done; }
    err = ext2fs_read_bitmaps(fs);
    if (err) goto done;
    err = ext2fs_file_open(fs, ino, EXT2_FILE_WRITE, &file);
    if (err) goto done;
    err = ext2fs_file_write(file, data, size, &written);
    if (!err && written != size) err = EIO;
    if (!err) err = ext2fs_file_set_size2(file, size);
    errcode_t closed = ext2fs_file_close(file);
    if (!err) err = closed;
    if (err) goto done;
    err = ext2fs_read_inode(fs, ino, &inode);
    if (err) goto done;
    inode.i_mtime = inode.i_ctime = time(NULL);
    err = ext2fs_write_inode(fs, ino, &inode);
    if (!err) err = ext2fs_flush(fs);
done:
    if (fs) ext2fs_free(fs);
    transfer = NULL;
    return err;
}
