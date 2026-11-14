package image

import (
	"context"
	"encoding/binary"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/cache"
	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type mountFetchStore struct {
	store.Store
	mu   sync.Mutex
	gets map[string]int
}

func (s *mountFetchStore) Get(ctx context.Context, key string) ([]byte, error) {
	s.mu.Lock()
	s.gets[key]++
	s.mu.Unlock()
	return s.Store.Get(ctx, key)
}

func TestMountPrefetchLocalStore(t *testing.T) {
	for _, tc := range []struct {
		bs            int64
		index, legacy bool
	}{{1024, false, false}, {4096, false, false}, {4096, true, false}, {4096, false, true}} {
		t.Run(fmt.Sprint(tc), func(t *testing.T) {
			bs := tc.bs
			image := make([]byte, 16<<20)
			le := binary.LittleEndian
			sb := image[1024:2048]
			le.PutUint32(sb[4:], uint32(int64(len(image))/bs))
			first := int64(0)
			log := uint32(2)
			if bs == 1024 {
				first = 1
				log = 0
			}
			le.PutUint32(sb[0x14:], uint32(first))
			le.PutUint32(sb[0x18:], log)
			le.PutUint32(sb[0x20:], 32768)
			le.PutUint32(sb[0x28:], 128)
			le.PutUint16(sb[0x38:], 0xef53)
			le.PutUint32(sb[0x4c:], 1)
			le.PutUint16(sb[0x58:], 256)
			le.PutUint32(sb[0x60:], 0x80)
			le.PutUint16(sb[0xfe:], 64)
			le.PutUint32(sb[0x5c:], 4)
			le.PutUint32(sb[0xe0:], 8)
			table, bitmap, inodeBitmap, dir, journal, index := int64(1<<20), int64(2<<20), int64(3<<20), int64(4<<20), int64(5<<20), int64(6<<20)
			gd := image[(first+1)*bs:]
			le.PutUint32(gd, uint32(bitmap/bs))
			le.PutUint32(gd[4:], uint32(inodeBitmap/bs))
			le.PutUint32(gd[8:], uint32(table/bs))
			inode := image[table+256 : table+512]
			extent := func(node []byte, ptr int64) {
				le.PutUint16(node, 0xf30a)
				le.PutUint16(node[2:], 1)
				le.PutUint16(node[4:], 4)
				le.PutUint16(node[16:], 1)
				le.PutUint32(node[20:], uint32(ptr/bs))
			}
			if tc.legacy {
				le.PutUint32(inode[40:], uint32(dir/bs))
			} else {
				le.PutUint32(inode[32:], 0x80000)
				extent(inode[40:], dir)
				if tc.index {
					le.PutUint16(inode[46:], 1)
					le.PutUint32(inode[56:], uint32(index/bs))
					le.PutUint16(inode[60:], 0)
					extent(image[index:index+bs], dir)
				}
			}
			jino := image[table+7*256:]
			le.PutUint32(jino[32:], 0x80000)
			extent(jino[40:], journal)
			for i, off := range []int64{bitmap, inodeBitmap, dir, journal} {
				image[off] = byte(90 + i)
			}
			image[7<<20] = 255 // Unrelated data must not be fetched before returning.
			local := store.Local{Dir: t.TempDir()}
			spy := &mountFetchStore{Store: local, gets: map[string]int{}}
			r := root.Root{V: 1, FSType: "ext4", VirtualSize: int64(len(image)), Chunks: map[string]string{}}
			for off := int64(0); off < int64(len(image)); off += chunk.Size {
				b := image[off : off+chunk.Size]
				nonzero := false
				for _, v := range b {
					if v != 0 {
						nonzero = true
						break
					}
				}
				if !nonzero {
					continue
				}
				h := root.Hash(b)
				r.Chunks[strconv.FormatInt(off, 10)] = h
				if e := local.Put(context.Background(), "lineage/c/"+h, b); e != nil {
					t.Fatal(e)
				}
			}
			m := &Manager{Cache: cache.New(t.TempDir(), spy, 64)}
			defer m.Cache.Close()
			if e := m.prefetchMount(context.Background(), "lineage", r); e != nil {
				t.Fatal(e)
			}
			expected := []int64{0, table, bitmap, inodeBitmap, dir, journal}
			if tc.index {
				expected = append(expected, index)
			}
			if len(spy.gets) != len(expected) {
				t.Fatal("unexpected fetch set", spy.gets)
			}
			for _, off := range expected {
				h := r.Chunks[strconv.FormatInt(off, 10)]
				key := "lineage/c/" + h
				if spy.gets[key] != 1 {
					t.Fatalf("fetch %d: %v", off, spy.gets)
				}
				b := make([]byte, 4096)
				if e := m.Cache.ReadAtLineage("lineage", h, b, 0); e != nil {
					t.Fatal(e)
				}
				if spy.gets[key] != 1 {
					t.Fatal("demand refetched warmed metadata")
				}
			}
		})
	}
}

func TestMountPrefetchRealExt4(t *testing.T) {
	if _, e := exec.LookPath("mkfs.ext4"); e != nil {
		t.Skip(e)
	}
	m, _ := unit3(t)
	p := filepath.Join(m.Data, "mount-metadata.img")
	f, e := os.Create(p)
	if e != nil {
		t.Fatal(e)
	}
	f.Truncate(64 << 20)
	f.Close()
	if out, e := exec.Command("mkfs.ext4", "-q", "-F", p).CombinedOutput(); e != nil {
		t.Fatal(e, string(out))
	}
	imp, e := m.Import(context.Background(), ImportRequest{Lineage: "l", Path: p})
	if e != nil {
		t.Fatal(e)
	}
	r, e := m.load(context.Background(), "l", imp.Root)
	if e != nil {
		t.Fatal(e)
	}
	spy := &mountFetchStore{Store: m.Store, gets: map[string]int{}}
	c := cache.New(t.TempDir(), spy, 64)
	defer c.Close()
	prefetch := &Manager{Cache: c}
	if e = prefetch.prefetchMount(context.Background(), "l", r); e != nil {
		t.Fatal(e)
	}
	if len(spy.gets) < 2 {
		t.Fatal("did not follow real metadata", spy.gets)
	}
	for key, n := range spy.gets {
		if !strings.HasPrefix(key, "l/c/") || n != 1 {
			t.Fatal(key, n)
		}
	}
	t.Logf("real ext4 mount metadata: %d verified chunk fetches", len(spy.gets))
}
