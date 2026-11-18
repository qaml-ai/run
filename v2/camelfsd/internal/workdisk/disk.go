// Package workdisk stores an ext4 disk as a sparse, immutable map of 256 KiB chunks.
package workdisk

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"sync"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/store"
)

const ChunkSize = 256 << 10

// The local store uses lineage links for collection. A non-user owner pins the
// shared template even after the last fork referencing it has been deleted.
const templateOwner = "/"

type Disks struct {
	objects  store.ObjectStore
	template string
	editor   string
	scratch  string
}

type View struct {
	objects store.ObjectStore
	chunks  []string
	mu      sync.Mutex
	dirty   map[int]struct{}
	overlay *os.File
	scratch string
	// A small read-through cache keeps the metadata blocks used by ext4 hot.
	cache map[int][]byte
}

func New(ctx context.Context, objects store.ObjectStore, templatePath, editor, scratch string) (*Disks, error) {
	f, err := os.Open(templatePath)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 || info.Size()%ChunkSize != 0 {
		return nil, fmt.Errorf("workspace template must be a regular ext4 image in multiples of %d bytes", ChunkSize)
	}
	chunks := make([]string, info.Size()/ChunkSize)
	data := make([]byte, ChunkSize)
	for i := range chunks {
		if _, err := io.ReadFull(f, data); err != nil {
			return nil, err
		}
		if allZero(data) {
			continue
		}
		hash, err := objects.PutObject(ctx, templateOwner, store.KindDiskChunk, data)
		if err != nil {
			return nil, err
		}
		chunks[i] = hash
	}
	d := &Disks{objects: objects, editor: editor, scratch: scratch}
	d.template, err = d.saveMap(ctx, templateOwner, chunks)
	return d, err
}

func (d *Disks) Template() string { return d.template }

func (d *Disks) saveMap(ctx context.Context, lineage string, chunks []string) (string, error) {
	raw, err := json.Marshal(chunks)
	if err != nil {
		return "", err
	}
	return d.objects.PutObject(ctx, lineage, store.KindDiskMap, raw)
}

func (d *Disks) Open(ctx context.Context, root string) (*View, error) {
	if !validHash(root) {
		return nil, fmt.Errorf("invalid workspace disk hash")
	}
	kind, data, err := d.objects.GetObject(ctx, root)
	if err != nil {
		return nil, err
	}
	if kind != store.KindDiskMap || store.HashObject(kind, data) != root {
		return nil, fmt.Errorf("invalid workspace disk object %s", root)
	}
	var chunks []string
	if err = json.Unmarshal(data, &chunks); err != nil || len(chunks) == 0 {
		return nil, fmt.Errorf("invalid workspace disk map %s", root)
	}
	for _, chunk := range chunks {
		if chunk != "" && !validHash(chunk) {
			return nil, fmt.Errorf("invalid chunk in workspace disk %s", root)
		}
	}
	return &View{objects: d.objects, chunks: chunks, dirty: make(map[int]struct{}), cache: make(map[int][]byte), scratch: d.scratch}, nil
}

func validHash(hash string) bool {
	_, err := hex.DecodeString(hash)
	return len(hash) == 64 && err == nil
}

func allZero(data []byte) bool {
	return len(data) == 0 || (data[0] == 0 && bytes.Equal(data[1:], data[:len(data)-1]))
}

func (v *View) Size() int64 { return int64(len(v.chunks)) * ChunkSize }

func (v *View) block(ctx context.Context, i int) ([]byte, error) {
	if _, dirty := v.dirty[i]; dirty {
		data := make([]byte, ChunkSize)
		_, err := v.overlay.ReadAt(data, int64(i)*ChunkSize)
		return data, err
	}
	if data := v.cache[i]; data != nil {
		return data, nil
	}
	if v.chunks[i] == "" {
		return make([]byte, ChunkSize), nil
	}
	kind, data, err := v.objects.GetObject(ctx, v.chunks[i])
	if err != nil {
		return nil, err
	}
	if kind != store.KindDiskChunk || len(data) != ChunkSize || store.HashObject(kind, data) != v.chunks[i] {
		return nil, fmt.Errorf("invalid workspace disk chunk %d", i)
	}
	if len(v.cache) >= 128 {
		clear(v.cache)
	}
	v.cache[i] = data
	return data, nil
}

// Transfer serves both the offline editor and the VM block device.
func (v *View) Transfer(ctx context.Context, write bool, offset int64, data []byte) error {
	if offset < 0 || offset > v.Size() || int64(len(data)) > v.Size()-offset {
		return fmt.Errorf("workspace disk I/O outside device")
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	for len(data) != 0 {
		i, pos := int(offset/ChunkSize), int(offset%ChunkSize)
		n := min(ChunkSize-pos, len(data))
		if !write || n != ChunkSize {
			block, err := v.block(ctx, i)
			if err != nil {
				return err
			}
			if write {
				block = bytes.Clone(block)
				copy(block[pos:], data[:n])
				if err := v.writeBlock(i, block); err != nil {
					return err
				}
			} else {
				copy(data[:n], block[pos:])
			}
		} else if err := v.writeBlock(i, data[:n]); err != nil {
			return err
		}
		data, offset = data[n:], offset+int64(n)
	}
	return nil
}

func (v *View) writeBlock(i int, data []byte) error {
	if v.overlay == nil {
		tmp, err := os.CreateTemp(v.scratch, "ext4-overlay-")
		if err != nil {
			return err
		}
		if err := os.Remove(tmp.Name()); err != nil {
			_ = tmp.Close()
			return err
		}
		v.overlay = tmp
	}
	if _, err := v.overlay.WriteAt(data, int64(i)*ChunkSize); err != nil {
		return err
	}
	v.dirty[i] = struct{}{}
	return nil
}

func (v *View) Close() error {
	if v.overlay != nil {
		return v.overlay.Close()
	}
	return nil
}

func (d *Disks) save(ctx context.Context, lineage string, v *View) (string, error) {
	chunks := append([]string(nil), v.chunks...)
	for i := range v.dirty {
		data, err := v.block(ctx, i)
		if err != nil {
			return "", err
		}
		hash := ""
		if !allZero(data) {
			hash = store.HashObject(store.KindDiskChunk, data)
			if hash != chunks[i] {
				if _, err := d.objects.PutObject(ctx, lineage, store.KindDiskChunk, data); err != nil {
					return "", err
				}
			}
		}
		chunks[i] = hash
	}
	if err := d.objects.LinkObjects(ctx, lineage, chunks); err != nil {
		return "", err
	}
	return d.saveMap(ctx, lineage, chunks)
}

func (d *Disks) Reachable(ctx context.Context, root string) ([]string, error) {
	v, err := d.Open(ctx, root)
	if err != nil {
		return nil, err
	}
	defer v.Close()
	hashes := []string{root}
	for _, hash := range v.chunks {
		if hash != "" {
			hashes = append(hashes, hash)
		}
	}
	return hashes, nil
}
