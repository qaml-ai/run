package computehost

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type images struct {
	dir      string
	store    store.Store
	diskMiB  int
	verified atomic.Pointer[map[string]int64]
	mu       sync.Mutex
	inflight map[string]*imageDownload
}

type imageDownload struct {
	done    chan struct{}
	cancel  context.CancelFunc
	waiters int
	err     error
}

func (i *images) scan() {
	verified := make(map[string]int64)
	files, _ := os.ReadDir(i.dir)
	for _, file := range files {
		sha, ok := strings.CutSuffix(file.Name(), ".ext4")
		if !ok || !root.Hex(sha, 64) || !file.Type().IsRegular() {
			continue
		}
		f, err := os.Open(filepath.Join(i.dir, file.Name()))
		if err != nil {
			continue
		}
		info, statErr := f.Stat()
		if statErr == nil && checkHash(f, io.Discard, sha) == nil {
			verified[sha] = info.Size()
		}
		f.Close()
	}
	i.verified.Store(&verified)
}

func (i *images) list() []string {
	list := []string{}
	if verified := i.verified.Load(); verified != nil {
		for sha := range *verified {
			list = append(list, sha)
		}
	}
	sort.Strings(list)
	return list
}

func (i *images) ensure(ctx context.Context, sha string, diskMiB int) (string, error) {
	if !root.Hex(sha, 64) || diskMiB <= 0 || int64(diskMiB) > math.MaxInt64>>20 {
		return "", errors.New("invalid image or disk size")
	}
	path := filepath.Join(i.dir, sha+".ext4")
	for {
		if verified := i.verified.Load(); verified != nil {
			if size, ok := (*verified)[sha]; ok {
				if size > int64(diskMiB)<<20 {
					return "", errors.New("guest image exceeds VM disk")
				}
				return path, nil
			}
		}
		if err := ctx.Err(); err != nil {
			return "", err
		}
		flight, joined := i.join(ctx, sha, path)
		if flight == nil {
			continue
		} // A concurrent download published this SHA.
		select {
		case <-ctx.Done():
			if joined {
				i.leave(flight)
			}
			return "", ctx.Err()
		case <-flight.done:
			if err := ctx.Err(); err != nil {
				return "", err
			}
			if joined && flight.err != nil {
				return "", flight.err
			}
		}
	}
}

func (i *images) join(ctx context.Context, sha, path string) (*imageDownload, bool) {
	i.mu.Lock()
	defer i.mu.Unlock()
	if verified := i.verified.Load(); verified != nil {
		if _, ok := (*verified)[sha]; ok {
			return nil, false
		}
	}
	if flight := i.inflight[sha]; flight != nil {
		// Let a flight with no remaining callers finish cleaning up before retrying.
		if flight.waiters == 0 {
			return flight, false
		}
		flight.waiters++
		return flight, true
	}
	if i.inflight == nil {
		i.inflight = make(map[string]*imageDownload)
	}
	shared, cancel := context.WithCancel(context.WithoutCancel(ctx))
	flight := &imageDownload{done: make(chan struct{}), cancel: cancel, waiters: 1}
	i.inflight[sha] = flight
	go i.fetch(shared, sha, path, flight)
	return flight, true
}

func (i *images) leave(flight *imageDownload) {
	i.mu.Lock()
	defer i.mu.Unlock()
	flight.waiters--
	if flight.waiters == 0 {
		flight.cancel()
	}
}

func (i *images) fetch(ctx context.Context, sha, path string, flight *imageDownload) {
	defer flight.cancel()
	maxBytes := min(int64(i.diskMiB), math.MaxInt64>>20) << 20
	err := i.download(ctx, path, sha, maxBytes)
	var size int64
	if err == nil {
		var info os.FileInfo
		info, err = os.Stat(path)
		if err == nil {
			size = info.Size()
		}
	}
	i.mu.Lock()
	defer i.mu.Unlock()
	if err == nil {
		verified := map[string]int64{}
		if current := i.verified.Load(); current != nil {
			verified = maps.Clone(*current)
		}
		verified[sha] = size
		i.verified.Store(&verified)
	}
	flight.err = err
	delete(i.inflight, sha)
	close(flight.done)
}

func (i *images) download(ctx context.Context, path, sha string, maxBytes int64) error {
	base := "guest/" + sha
	manifest, err := store.OpenReader(ctx, i.store, base+".json")
	if err != nil {
		return err
	}
	var m struct {
		SHA256     string `json:"sha256"`
		ZstdSHA256 string `json:"zstdSha256"`
		Bytes      int64  `json:"bytes"`
		ZstdBytes  int64  `json:"zstdBytes"`
	}
	err = json.NewDecoder(io.LimitReader(manifest, 64<<10)).Decode(&m)
	manifest.Close()
	if err != nil {
		return err
	}
	if m.SHA256 != sha || !root.Hex(m.ZstdSHA256, 64) || m.Bytes <= 0 || m.Bytes > maxBytes || m.ZstdBytes <= 0 || m.ZstdBytes == math.MaxInt64 {
		return errors.New("invalid guest manifest or guest image exceeds VM disk")
	}
	dir, err := os.MkdirTemp(i.dir, ".download-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	compressed, err := os.Create(filepath.Join(dir, "guest.zst"))
	if err != nil {
		return err
	}
	response, err := store.OpenReader(ctx, i.store, base+".ext4.zst")
	if err != nil {
		compressed.Close()
		return err
	}
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(compressed, hash), io.LimitReader(response, m.ZstdBytes+1))
	if err := errors.Join(copyErr, response.Close(), compressed.Close()); err != nil {
		return fmt.Errorf("compressed guest image: %w", err)
	}
	if n != m.ZstdBytes {
		return errors.New("compressed guest image size mismatch")
	}
	if fmt.Sprintf("%x", hash.Sum(nil)) != m.ZstdSHA256 {
		return errors.New("compressed guest image SHA-256 mismatch")
	}

	cmd := exec.CommandContext(ctx, "zstd", "-q", "-d", "-c", "--", compressed.Name())
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	image, err := os.OpenFile(filepath.Join(dir, "guest.ext4"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer image.Close()
	if err := cmd.Start(); err != nil {
		return err
	}
	hash.Reset()
	n, copyErr = io.Copy(io.MultiWriter(hash, image), io.LimitReader(out, m.Bytes+1))
	out.Close()
	if err := errors.Join(copyErr, cmd.Wait()); err != nil {
		return err
	}
	if n != m.Bytes || fmt.Sprintf("%x", hash.Sum(nil)) != sha {
		return errors.New("ext4 guest image hash or size mismatch")
	}
	if err := image.Sync(); err != nil {
		return err
	}
	if err := image.Close(); err != nil {
		return err
	}
	return os.Rename(image.Name(), path)
}

func checkHash(src io.Reader, dst io.Writer, expected string) error {
	hash := sha256.New()
	if _, err := io.Copy(io.MultiWriter(hash, dst), src); err != nil {
		return err
	}
	if fmt.Sprintf("%x", hash.Sum(nil)) != expected {
		return errors.New("SHA-256 mismatch")
	}
	return nil
}
