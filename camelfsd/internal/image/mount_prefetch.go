package image

import (
	"context"
	"encoding/binary"
	"fmt"
	"strconv"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// An advisory ext4 metadata walk, never a filesystem mount. See the kernel's
// filesystems/ext4/{super,group_descr,ifork}.html for on-disk field offsets.
// Unknown layouts simply keep lazy reads. Store failures remain mount errors.
func (m *Manager) prefetchMount(ctx context.Context, lineage string, r root.Root) error {
	const maxMetadata = 64 << 20
	read := func(off, n int64) ([]byte, error) {
		if off < 0 || n < 0 || off > r.VirtualSize || n > r.VirtualSize-off || n > maxMetadata {
			return nil, fmt.Errorf("ext4 metadata outside image")
		}
		b := make([]byte, n)
		for pos := int64(0); pos < n; {
			at := off + pos
			base := at / root.ChunkSize * root.ChunkSize
			count := min(n-pos, root.ChunkSize-(at-base))
			if h := r.Chunks[strconv.FormatInt(base, 10)]; h != "" {
				_, e := m.Cache.EnsureLineage(ctx, lineage, h)
				if e != nil {
					return nil, e
				}
				// ReadAtLineage uses the verified, open-file cache on subsequent access.
				if e = m.Cache.ReadAtLineage(lineage, h, b[pos:pos+count], at-base); e != nil {
					return nil, e
				}
			}
			pos += count
		}
		return b, nil
	}
	if r.VirtualSize < 2048 {
		return nil
	}
	b, e := read(0, min(root.ChunkSize, r.VirtualSize))
	if e != nil {
		return e
	}
	sb := b[1024:2048]
	le := binary.LittleEndian
	if le.Uint16(sb[0x38:]) != 0xef53 {
		return nil
	}
	log := le.Uint32(sb[0x18:])
	if log > 6 {
		return nil
	}
	bs := int64(1024) << log
	incompat := le.Uint32(sb[0x60:])
	if incompat&0x10 != 0 {
		return nil
	} // meta_bg has distributed descriptors.
	blocks := uint64(le.Uint32(sb[4:]))
	desc := int64(32)
	if incompat&0x80 != 0 {
		blocks |= uint64(le.Uint32(sb[0x150:])) << 32
		desc = int64(le.Uint16(sb[0xfe:]))
	}
	first := int64(le.Uint32(sb[0x14:]))
	perGroup := int64(le.Uint32(sb[0x20:]))
	inodes := int64(le.Uint32(sb[0x28:]))
	inodeSize := int64(128)
	if le.Uint32(sb[0x4c:]) != 0 {
		inodeSize = int64(le.Uint16(sb[0x58:]))
	}
	if blocks == 0 || blocks > uint64(r.VirtualSize/bs) || first < 0 || uint64(first) >= blocks || perGroup == 0 || inodes < 2 || desc < 32 || desc > bs || inodeSize < 128 || inodeSize > bs || inodes > maxMetadata/inodeSize {
		return nil
	}
	groups := (int64(blocks) - first + perGroup - 1) / perGroup
	if groups > maxMetadata/desc {
		return nil
	}
	gdt := (first + 1) * bs
	if gdt > r.VirtualSize-desc {
		return nil
	}
	gd, e := read(gdt, desc)
	if e != nil {
		return e
	}
	block := func(lo, hi int) int64 {
		v := uint64(le.Uint32(gd[lo:]))
		if incompat&0x80 != 0 && desc >= 64 {
			v |= uint64(le.Uint32(gd[hi:])) << 32
		}
		if v >= blocks {
			return -1
		}
		return int64(v) * bs
	}
	table, bitmap, inodeBitmap := block(8, 0x28), block(0, 0x20), block(4, 0x24)
	if table < 0 || bitmap < 0 || inodeBitmap < 0 || table > r.VirtualSize-inodes*inodeSize || gdt > r.VirtualSize-groups*desc {
		return nil
	}
	hashes := map[string]bool{}
	add := func(off, n int64) {
		for base := off / root.ChunkSize * root.ChunkSize; base < off+n; base += root.ChunkSize {
			if h := r.Chunks[strconv.FormatInt(base, 10)]; h != "" {
				hashes[h] = true
			}
		}
	}
	add(gdt, groups*desc)
	add(bitmap, bs)
	add(inodeBitmap, bs)
	add(table, inodes*inodeSize)
	keys := make([]string, 0, len(hashes))
	for h := range hashes {
		keys = append(keys, h)
	}
	if e = store.Parallel(ctx, 64, keys, func(h string) error { _, e := m.Cache.EnsureLineage(ctx, lineage, h); return e }); e != nil {
		return e
	}
	// Follow logical block zero, including extent-index nodes of larger dirs.
	firstBlock := func(inode []byte) (int64, error) {
		node := inode[40:100]
		if le.Uint32(inode[32:])&0x10000000 != 0 {
			return -1, nil
		} // inline_data
		if le.Uint32(inode[32:])&0x80000 == 0 {
			ptr := uint64(le.Uint32(node))
			if ptr == 0 || ptr >= blocks {
				return -1, nil
			}
			return int64(ptr) * bs, nil
		}
		expectedDepth := -1
		for level := 0; level <= 5; level++ {
			if le.Uint16(node) != 0xf30a {
				return -1, nil
			}
			count, depth := int(le.Uint16(node[2:])), int(le.Uint16(node[6:]))
			if count == 0 || count > (len(node)-12)/12 || depth > 5 || (expectedDepth >= 0 && depth != expectedDepth) {
				return -1, nil
			}
			ex := node[12:24]
			if le.Uint32(ex) != 0 {
				return -1, nil
			}
			var ptr uint64
			if depth == 0 {
				length := le.Uint16(ex[4:])
				if length == 0 || length > 32768 {
					return -1, nil
				}
				ptr = uint64(le.Uint32(ex[8:])) | uint64(le.Uint16(ex[6:]))<<32
			} else {
				ptr = uint64(le.Uint32(ex[4:])) | uint64(le.Uint16(ex[8:]))<<32
			}
			if ptr == 0 || ptr >= blocks {
				return -1, nil
			}
			if depth == 0 {
				return int64(ptr) * bs, nil
			}
			node, e = read(int64(ptr)*bs, bs)
			if e != nil {
				return -1, e
			}
			expectedDepth = depth - 1
		}
		return -1, nil
	}
	// The journal superblock is also read during a normal ext4 mount.
	inodeNumbers := []int64{2}
	if le.Uint32(sb[0x5c:])&4 != 0 && le.Uint32(sb[0xe0:]) == 8 && inodes >= 8 {
		inodeNumbers = append(inodeNumbers, 8)
	}
	var offsets []string
	for _, ino := range inodeNumbers {
		inode, e := read(table+(ino-1)*inodeSize, inodeSize)
		if e != nil {
			return e
		}
		off, e := firstBlock(inode)
		if e != nil {
			return e
		}
		if off >= 0 {
			offsets = append(offsets, strconv.FormatInt(off, 10))
		}
	}
	return store.Parallel(ctx, 64, offsets, func(key string) error { off, _ := strconv.ParseInt(key, 10, 64); _, e := read(off, bs); return e })
}
