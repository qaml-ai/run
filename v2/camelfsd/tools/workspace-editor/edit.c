/* Each call owns a private block view. Failed transactions discard that view. */
#include <errno.h>
#include <limits.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdio.h>
#include <stdint.h>
#include <endian.h>
#include <ext2fs/ext2fs.h>

static int transfer(int writing, unsigned long long offset, size_t size, void *data)
{
    if (!size) return 0;
    uint64_t le_offset = htole64(offset), le_size = htole64(size);
    if (fputc(writing ? 'W' : 'R', stdout) == EOF ||
        fwrite(&le_offset, 8, 1, stdout) != 1 || fwrite(&le_size, 8, 1, stdout) != 1 ||
        (writing && fwrite(data, 1, size, stdout) != size) || fflush(stdout)) return EIO;
    return !writing && fread(data, 1, size, stdin) != size ? EIO : 0;
}
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

static errcode_t put_file(ext2_filsys fs, char *path, unsigned mode, FILE *input)
{
    ext2_ino_t ino;
    errcode_t err = resolve(fs, path, 1, &ino);
    if (err) return err;

    struct ext2_inode inode;
    err = ext2fs_read_inode(fs, ino, &inode);
    if (err) return err;
    if (!LINUX_S_ISREG(inode.i_mode) || inode.i_links_count != 1) return EINVAL;

    ext2_file_t file;
    err = ext2fs_file_open(fs, ino, EXT2_FILE_WRITE, &file);
    if (err) return err;
    char buf[65536];
    size_t n;
    uint64_t len = 0;
    while ((n = fread(buf, 1, sizeof(buf), input))) {
        unsigned written;
        err = ext2fs_file_write(file, buf, n, &written);
        if (err || written != n) {
            if (!err) err = EIO;
            break;
        }
        len += n;
    }
    if (!err && ferror(input)) err = EIO;
    if (!err) err = ext2fs_file_set_size2(file, len);
    errcode_t closed = ext2fs_file_close(file);
    if (!err) err = closed;
    if (err) return err;

    err = ext2fs_read_inode(fs, ino, &inode);
    if (err) return err;
    inode.i_mode = LINUX_S_IFREG | mode;
    inode.i_mtime = inode.i_ctime = time(NULL);
    return ext2fs_write_inode(fs, ino, &inode);
}

static int nonempty(ext2_ino_t dir, int entry, struct ext2_dir_entry *de, int offset,
                    int blocksize, char *buf, void *state)
{
    (void)dir; (void)offset; (void)blocksize; (void)buf;
    if (entry == DIRENT_DOT_FILE || entry == DIRENT_DOT_DOT_FILE || !de->inode) return 0;
    *(int *)state = 1;
    return DIRENT_ABORT;
}

static errcode_t unlink_entry(ext2_filsys fs, ext2_ino_t parent, const char *name, int directory)
{
    ext2_ino_t ino;
    errcode_t err = ext2fs_lookup(fs, parent, name, strlen(name), NULL, &ino);
    if (err) return err;
    struct ext2_inode inode;
    err = ext2fs_read_inode(fs, ino, &inode);
    if (err) return err;
    if (directory) {
        if (!LINUX_S_ISDIR(inode.i_mode)) return ENOTDIR;
        int has_child = 0;
        err = ext2fs_dir_iterate2(fs, ino, 0, NULL, nonempty, &has_child);
        if (err) return err;
        if (has_child) return ENOTEMPTY;
    } else if (!LINUX_S_ISREG(inode.i_mode) || inode.i_links_count != 1) {
        return EINVAL;
    }

    err = ext2fs_unlink(fs, parent, name, ino, 0);
    if (err) return err;
    err = ext2fs_punch(fs, ino, &inode, NULL, 0, ~(blk64_t)0);
    if (err) return err;
    inode.i_links_count = 0;
    inode.i_dtime = time(NULL);
    err = ext2fs_write_inode(fs, ino, &inode);
    if (err) return err;
    ext2fs_inode_alloc_stats2(fs, ino, -1, directory);
    if (!directory) return 0;

    err = ext2fs_read_inode(fs, parent, &inode);
    if (err) return err;
    if (inode.i_links_count > 1) inode.i_links_count--;
    return ext2fs_write_inode(fs, parent, &inode);
}

static errcode_t remove_path(ext2_filsys fs, char *path)
{
    int prune = 0;
    for (;;) {
        char *slash = strrchr(path, '/');
        const char *name = slash ? slash + 1 : path;
        if (!*name || !strcmp(name, ".") || !strcmp(name, "..")) return EINVAL;
        ext2_ino_t parent = EXT2_ROOT_INO;
        if (slash) {
            *slash = 0;
            char *parts = strdup(path);
            if (!parts) return ENOMEM;
            errcode_t err = resolve(fs, parts, 0, &parent);
            free(parts);
            if (err) return err;
            err = ext2fs_check_directory(fs, parent);
            if (err) return err;
        }
        errcode_t err = unlink_entry(fs, parent, name, prune);
        if (err == ENOTEMPTY && prune) return 0;
        if (err || !slash) return err;
        prune = 1;
    }
}

int main(void)
{
    ext2_filsys fs = NULL;
    FILE *plan = fopen("plan", "rb");
    if (!plan) { perror("open plan"); return 1; }
    char *entry = NULL;
    size_t capacity = 0;
    errcode_t err = ext2fs_open("workspace", EXT2_FLAG_RW | EXT2_FLAG_64BITS, 0, 0, &manager, &fs);
    if (err) goto done;
    if (fs->super->s_state != EXT2_VALID_FS || fs->super->s_last_orphan ||
        ext2fs_has_feature_journal_needs_recovery(fs->super) || ext2fs_has_feature_orphan_present(fs->super)) {
        err = EUCLEAN;
        goto done;
    }
    err = ext2fs_read_bitmaps(fs);
    if (err) goto done;

    ssize_t len;
    for (unsigned i = 0; (len = getdelim(&entry, &capacity, 0, plan)) >= 0; ++i) {
        if (len < 7 || entry[len - 1] != 0 || (entry[0] != 'D' && entry[0] != 'W')) {
            err = EINVAL;
            goto done;
        }
        if (entry[0] == 'D') {
            err = remove_path(fs, entry + 5);
        } else {
            char mode[5];
            memcpy(mode, entry + 1, 4);
            mode[4] = 0;
            char name[24];
            snprintf(name, sizeof(name), "%u", i);
            FILE *data = fopen(name, "rb");
            if (!data) { err = errno; goto done; }
            err = put_file(fs, entry + 5, strtoul(mode, NULL, 8), data);
            fclose(data);
        }
        if (err) goto done;
    }
    err = ferror(plan) ? EIO : ext2fs_flush(fs);
done:
    if (fs) ext2fs_free(fs);
    free(entry);
    fclose(plan);
    if (err) fprintf(stderr, "workspace-editor: ext4 error %ld\n", (long)err);
    return err ? 1 : 0;
}
