package computehost

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type images struct {
	dir      string
	store    store.Store
	mu       sync.Mutex
	fetch    sync.Mutex
	verified map[string]bool
}

func (i *images) scan() {
	i.verified = make(map[string]bool)
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
		i.verified[sha] = checkHash(f, io.Discard, sha) == nil
		f.Close()
	}
}

func (i *images) list() []string {
	i.mu.Lock()
	defer i.mu.Unlock()
	list := []string{}
	for sha, ok := range i.verified {
		if ok {
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
	i.fetch.Lock()
	defer i.fetch.Unlock()
	i.mu.Lock()
	cached := i.verified[sha]
	i.mu.Unlock()
	path := filepath.Join(i.dir, sha+".ext4")
	if cached {
		st, err := os.Stat(path)
		if err != nil {
			return "", err
		}
		if st.Size() > int64(diskMiB)<<20 {
			return "", errors.New("guest image exceeds VM disk")
		}
		return path, nil
	}
	if err := i.download(ctx, path, sha, int64(diskMiB)<<20); err != nil {
		return "", err
	}
	i.mu.Lock()
	i.verified[sha] = true
	i.mu.Unlock()
	return path, nil
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
	}
	err = json.NewDecoder(io.LimitReader(manifest, 64<<10)).Decode(&m)
	manifest.Close()
	if err != nil {
		return err
	}
	if m.SHA256 != sha || !root.Hex(m.ZstdSHA256, 64) || m.Bytes <= 0 || m.Bytes > maxBytes {
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
	// zstd never expands incompressible input by more than a few bytes per block; bound the
	// download by the image size so a bad object cannot fill the cache disk.
	verify := checkHash(io.LimitReader(response, m.Bytes+m.Bytes/64+1<<20), compressed, m.ZstdSHA256)
	response.Close()
	if err := errors.Join(verify, compressed.Close()); err != nil {
		return fmt.Errorf("compressed guest image: %w", err)
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
	hash := sha256.New()
	n, copyErr := io.Copy(io.MultiWriter(hash, image), io.LimitReader(out, m.Bytes+1))
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
