package image

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func (m *Manager) fetchPrebuiltImage(ctx context.Context, descriptor store.WorkspaceImage, dir string) (string, error) {
	encoded, err := os.OpenFile(filepath.Join(dir, "download.gz"), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return "", err
	}
	defer encoded.Close()
	const partBytes = store.BundleTargetBytes
	var offsets []string
	for offset := int64(0); offset < descriptor.StoredSize; offset += partBytes {
		offsets = append(offsets, strconv.FormatInt(offset, 10))
	}
	source := store.ForLineage(m.Store, descriptor.Lineage)
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
	storedHash, rawHash := sha256.New(), sha256.New()
	limited := &io.LimitedReader{R: io.TeeReader(input, storedHash), N: descriptor.StoredSize + 1}
	z, err := gzip.NewReader(limited)
	if err != nil {
		return err
	}
	defer z.Close()
	buffer, zero := make([]byte, 64<<10), make([]byte, 64<<10)
	var size int64
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		n, readErr := z.Read(buffer)
		if int64(n) > descriptor.VirtualSize-size {
			return fmt.Errorf("workspace image exceeds declared size")
		}
		if n > 0 {
			rawHash.Write(buffer[:n])
			if !bytes.Equal(buffer[:n], zero[:n]) {
				if _, err := file.WriteAt(buffer[:n], size); err != nil {
					return err
				}
			}
		}
		size += int64(n)
		if readErr == io.EOF {
			break
		}
		if readErr != nil {
			return readErr
		}
	}
	if size != descriptor.VirtualSize || limited.N != 1 || hex.EncodeToString(storedHash.Sum(nil)) != descriptor.SHA256 ||
		hex.EncodeToString(rawHash.Sum(nil)) != descriptor.RawSHA256 {
		return fmt.Errorf("workspace image digest or size mismatch")
	}
	if err := file.Truncate(size); err != nil {
		return err
	}
	if err := file.Sync(); err != nil {
		return err
	}
	return file.Close()
}
