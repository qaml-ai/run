package computehost

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"golang.org/x/sys/unix"
)

type imageStore struct {
	store.Store
	open func(context.Context, string) (io.ReadCloser, error)
}

func (s imageStore) Open(ctx context.Context, key string) (io.ReadCloser, error) {
	return s.open(ctx, key)
}

func TestImageDownloadsShareOnlyTheSameSHA(t *testing.T) {
	zstd, err := exec.LookPath("zstd")
	if err != nil {
		t.Skip("zstd is required")
	}
	data := []byte("image A")
	cmd := exec.Command(zstd, "-q", "-c")
	cmd.Stdin = bytes.NewReader(data)
	zip, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	sha := fmt.Sprintf("%x", sha256.Sum256(data))
	manifest, err := json.Marshal(map[string]any{
		"sha256": sha, "bytes": len(data), "zstdSha256": fmt.Sprintf("%x", sha256.Sum256(zip)), "zstdBytes": len(zip),
	})
	if err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	var downloads atomic.Int32
	images := &images{dir: t.TempDir(), diskMiB: 1, store: imageStore{open: func(ctx context.Context, key string) (io.ReadCloser, error) {
		if !strings.Contains(key, sha) {
			return nil, os.ErrNotExist
		}
		if strings.HasSuffix(key, ".json") {
			return io.NopCloser(bytes.NewReader(manifest)), nil
		}
		if downloads.Add(1) == 1 {
			close(started)
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-release:
			return io.NopCloser(bytes.NewReader(zip)), nil
		}
	}}}
	cacheData := []byte("cached image B")
	cached := fmt.Sprintf("%x", sha256.Sum256(cacheData))
	if err := os.WriteFile(filepath.Join(images.dir, cached+".ext4"), cacheData, 0600); err != nil {
		t.Fatal(err)
	}
	if err := images.scan(); err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithTimeout(t.Context(), 5*time.Second)
	defer stop()
	first, cancelFirst := context.WithCancel(ctx)
	defer cancelFirst()
	result := make(chan error, 2)
	ensure := func(ctx context.Context) { _, err := images.ensure(ctx, sha, 1); result <- err }
	go ensure(first)
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("download did not start")
	}
	go ensure(ctx)
	for {
		images.mu.Lock()
		var waiters int
		if flight := images.inflight[sha]; flight != nil {
			waiters = flight.waiters
		}
		images.mu.Unlock()
		if waiters == 2 {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("second caller did not join")
		}
		time.Sleep(time.Millisecond)
	}
	if _, err := images.ensure(ctx, cached, 1); err != nil || ctx.Err() != nil {
		t.Fatalf("cached hit blocked: %v", err)
	}
	other := strings.Repeat("c", 64)
	if _, err := images.ensure(ctx, other, 1); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("other miss blocked: %v", err)
	}
	cancelFirst()
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled waiter: %v", err)
	}
	close(release)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	if downloads.Load() != 1 {
		t.Fatalf("downloads=%d", downloads.Load())
	}
}

func TestImageScanClearsCrashLeftovers(t *testing.T) {
	i := images{dir: t.TempDir()}
	content := []byte("verified image")
	valid := fmt.Sprintf("%x.ext4", sha256.Sum256(content))
	corrupt := strings.Repeat("0", 64) + ".ext4"
	temporary := ".tmp-123"
	download := ".download-123"
	if err := os.Mkdir(filepath.Join(i.dir, download), 0700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{valid, corrupt, temporary, filepath.Join(download, "guest.zst"), "blank.img"} {
		if err := os.WriteFile(filepath.Join(i.dir, name), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err := i.scan(); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{corrupt, temporary, download} {
		if _, err := os.Stat(filepath.Join(i.dir, name)); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("%s remains: %v", name, err)
		}
	}
	for _, name := range []string{valid, "blank.img"} {
		if _, err := os.Stat(filepath.Join(i.dir, name)); err != nil {
			t.Error(err)
		}
	}
	if got := i.list(); len(got) != 1 || got[0]+".ext4" != valid {
		t.Errorf("verified images: %v", got)
	}
}

func TestOpenFailsOnImageCacheScanError(t *testing.T) {
	h, err := Open(t.Context(), Config{Data: t.TempDir()})
	if h != nil || !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("Open = %v, %v, want missing images directory error", h, err)
	}
}

func TestRegistrationPrewarmsMissingSparseImage(t *testing.T) {
	zstd, err := exec.LookPath("zstd")
	if err != nil {
		t.Skip("zstd is required")
	}
	data := make([]byte, (4<<20)+19)
	copy(data[64<<10:], "non-zero payload")
	sha := fmt.Sprintf("%x", sha256.Sum256(data))
	cmd := exec.Command(zstd, "-q", "-c")
	cmd.Stdin = bytes.NewReader(data)
	zip, err := cmd.Output()
	if err != nil {
		t.Fatal(err)
	}
	manifest, err := json.Marshal(map[string]any{"sha256": sha, "bytes": len(data),
		"zstdSha256": fmt.Sprintf("%x", sha256.Sum256(zip)), "zstdBytes": len(zip)})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	cache := filepath.Join(dir, "images")
	if err := os.Mkdir(cache, 0700); err != nil {
		t.Fatal(err)
	}
	cachedData := []byte("cached")
	cached := fmt.Sprintf("%x", sha256.Sum256(cachedData))
	if err := os.WriteFile(filepath.Join(cache, cached+".ext4"), cachedData, 0600); err != nil {
		t.Fatal(err)
	}
	ctx, stop := context.WithTimeout(t.Context(), 5*time.Second)
	defer stop()
	started, release := make(chan struct{}), make(chan struct{})
	var downloads, other atomic.Int32
	h, err := Open(ctx, Config{Data: dir, Shape: hostwire.Shape{DiskMiB: 8},
		Post: func(_ context.Context, path string, req, out any) error {
			if path != "/register" || !slices.Equal(req.(hostwire.Register).Images, []string{cached}) {
				t.Errorf("unexpected registration: %s %+v", path, req)
			}
			*out.(*hostwire.Registered) = hostwire.Registered{BootEpoch: 1, Images: []string{cached, sha}}
			return nil
		},
		Images: imageStore{open: func(ctx context.Context, key string) (io.ReadCloser, error) {
			if !strings.HasPrefix(key, "guest/"+sha+".") {
				other.Add(1)
				return nil, os.ErrNotExist
			}
			if strings.HasSuffix(key, ".json") {
				return io.NopCloser(bytes.NewReader(manifest)), nil
			}
			if downloads.Add(1) == 1 {
				close(started)
			}
			select {
			case <-release:
				return io.NopCloser(bytes.NewReader(zip)), nil
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer h.Close()
	if err := h.register(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("registration did not start the download")
	}
	if err := h.register(ctx); err != nil {
		t.Fatal(err)
	}
	result := make(chan error, 1)
	go func() {
		_, err := h.images.ensure(ctx, sha, 8)
		result <- err
	}()
	for {
		h.images.mu.Lock()
		flight := h.images.inflight[sha]
		joined := flight != nil && flight.waiters == 2
		h.images.mu.Unlock()
		if joined {
			break
		}
		if ctx.Err() != nil {
			t.Fatal("boot did not join prewarming")
		}
		time.Sleep(time.Millisecond)
	}
	close(release)
	if err := <-result; err != nil {
		t.Fatal(err)
	}
	h.work.Wait()
	if downloads.Load() != 1 || other.Load() != 0 {
		t.Fatalf("downloads=%d unexpected=%d", downloads.Load(), other.Load())
	}
	path := filepath.Join(cache, sha+".ext4")
	got, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("installed image differs from source, size=%d: %v", len(got), err)
	}
	var st unix.Stat_t
	if err := unix.Stat(path, &st); err != nil {
		t.Fatal(err)
	}
	if st.Size != int64(len(data)) || st.Blocks*512 >= st.Size {
		t.Fatalf("image size=%d, allocated=%d", st.Size, st.Blocks*512)
	}
}
