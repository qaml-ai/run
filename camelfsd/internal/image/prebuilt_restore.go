package image

import (
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"math"
	"os"
	"path/filepath"
	"strconv"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func (m *Manager) fetchPrebuiltImage(ctx context.Context, descriptor store.WorkspaceImage, dir string) (string, error) {
	source := store.ForLineage(m.Store, descriptor.Lineage)
	info, err := source.Head(ctx, descriptor.Blob)
	if err != nil {
		return "", err
	}
	if descriptor.StoredSize <= 0 || info.Size != descriptor.StoredSize {
		return "", fmt.Errorf("workspace image stored size mismatch")
	}
	// Decoding reserves one extra byte to verify EOF. That bound must fit in
	// int64 before allocating ranges or reading any payload bytes.
	if descriptor.StoredSize == math.MaxInt64 {
		return "", fmt.Errorf("workspace image stored size overflows EOF bound")
	}
	encoded, err := os.OpenFile(filepath.Join(dir, "download.gz"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return "", err
	}
	defer encoded.Close()
	const partBytes = store.BundleTargetBytes
	var offsets []string
	for offset := int64(0); offset < descriptor.StoredSize; {
		offsets = append(offsets, strconv.FormatInt(offset, 10))
		offset += min(int64(partBytes), descriptor.StoredSize-offset)
	}
	err = store.Parallel(ctx, int(applyInflightBytes/partBytes), offsets, func(value string) error {
		offset, _ := strconv.ParseInt(value, 10, 64)
		size := min(int64(partBytes), descriptor.StoredSize-offset)
		data, err := store.ReadObjectRange(ctx, source, descriptor.Blob, offset, size, descriptor.StoredSize)
		if err != nil {
			return err
		}
		_, err = encoded.WriteAt(data, offset)
		return err
	})
	if err != nil {
		return "", err
	}
	if _, err := encoded.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	path := filepath.Join(dir, "restored.ext4")
	if err := decodePrebuiltImage(ctx, encoded, descriptor, path); err != nil {
		return "", err
	}
	return path, nil
}

// Verify both representations before the image can enter the local cache.
func decodePrebuiltImage(ctx context.Context, input io.Reader, descriptor store.WorkspaceImage, path string) (err error) {
	if descriptor.StoredSize <= 0 || descriptor.StoredSize == math.MaxInt64 {
		return fmt.Errorf("workspace image stored size overflows EOF bound")
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return err
	}
	defer func() {
		file.Close()
		if err != nil {
			os.Remove(path)
		}
	}()
	storedHash, imageHash := sha256.New(), sha256.New()
	limited := &io.LimitedReader{R: io.TeeReader(input, storedHash), N: descriptor.StoredSize + 1}
	z, err := gzip.NewReader(limited)
	if err != nil {
		return err
	}
	defer z.Close()
	if err := ReadSparseImage(ctx, io.TeeReader(z, imageHash), file, descriptor.VirtualSize); err != nil {
		return err
	}
	if limited.N != 1 || hex.EncodeToString(storedHash.Sum(nil)) != descriptor.SHA256 ||
		hex.EncodeToString(imageHash.Sum(nil)) != descriptor.ImageSHA256 {
		return fmt.Errorf("workspace image digest or size mismatch")
	}
	if err := file.Sync(); err != nil {
		return err
	}
	return file.Close()
}
