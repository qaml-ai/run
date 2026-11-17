package image

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

type prebuiltBuild struct {
	descriptor        store.WorkspaceImage
	image, compressed string
}

type prebuiltReader struct {
	ctx context.Context
	io.Reader
}

func (r prebuiltReader) Read(p []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(p)
}

// Build from canonical files, never from a guest disk with image-only state.
func (m *Manager) buildPrebuiltImage(ctx context.Context, q Request, dir string) (out prebuiltBuild, err error) {
	entries, err := m.entries(ctx, q.Lineage, q.Tree)
	if err != nil {
		return out, err
	}
	stage := filepath.Join(dir, "files")
	if err := os.Mkdir(stage, 0755); err != nil {
		return out, err
	}
	ids := make([]string, 0, len(entries))
	var logicalBytes int64
	for _, entry := range entries {
		if entry.Size < 0 || entry.Size > m.VirtualSize-logicalBytes || entry.Mode == "120000" && entry.Size > 4096 {
			return out, fmt.Errorf("workspace image content exceeds disk or symlink size")
		}
		logicalBytes += entry.Size
		if err := objects.Path(entry.Path); err != nil {
			return out, err
		}
		if err := os.MkdirAll(filepath.Dir(filepath.Join(stage, entry.Path)), 0755); err != nil {
			return out, err
		}
		if entry.Size <= store.BundleMaxBlob {
			ids = append(ids, entry.SHA1)
		}
	}
	source := store.ForLineage(m.Store, q.Lineage)
	locations, err := store.LocateBundlesForRestore(ctx, source, ids)
	if err != nil {
		return out, err
	}
	groups := make(map[string][]objects.Entry)
	var loose []string
	looseEntries := make(map[string]objects.Entry)
	for _, entry := range entries {
		if ref, ok := locations[entry.SHA1]; ok {
			if ref.Size != entry.Size || !store.ValidateBundleRef(ref) {
				return out, fmt.Errorf("invalid workspace image locator")
			}
			if group := groups[ref.Key]; len(group) > 0 && locations[group[0].SHA1].PackSize != ref.PackSize {
				return out, fmt.Errorf("inconsistent workspace image pack size")
			}
			groups[ref.Key] = append(groups[ref.Key], entry)
		} else {
			loose = append(loose, entry.Path)
			looseEntries[entry.Path] = entry
		}
	}
	for key, group := range groups {
		if err := ctx.Err(); err != nil {
			return out, err
		}
		pack, err := store.ReadBundle(ctx, source, key, locations[group[0].SHA1].PackSize)
		if err != nil {
			return out, err
		}
		for _, entry := range group {
			ref := locations[entry.SHA1]
			if err := materializePrebuiltBlob(ctx, stage, entry, bytes.NewReader(pack[ref.Offset:ref.Offset+ref.Size])); err != nil {
				return out, err
			}
		}
	}
	if err := store.Parallel(ctx, 32, loose, func(path string) error {
		entry := looseEntries[path]
		r, err := store.OpenLooseBlob(ctx, source, entry.SHA1)
		if err != nil {
			return err
		}
		err = materializePrebuiltBlob(ctx, stage, entry, r)
		closeErr := r.Close()
		if err != nil {
			return err
		}
		return closeErr
	}); err != nil {
		return out, err
	}
	out.image = filepath.Join(dir, "workspace.ext4")
	file, err := os.OpenFile(out.image, os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		return out, err
	}
	err = file.Truncate(m.VirtualSize)
	closeErr := file.Close()
	if err != nil || closeErr != nil {
		return out, fmt.Errorf("create workspace image: %v %v", err, closeErr)
	}
	args := []string{"-q", "-F", "-E", "lazy_itable_init=1,lazy_journal_init=1", "-O", "^inline_data"}
	if m.VirtualSize >= 256<<20 {
		args = append(args, "-J", "size=128")
	}
	args = append(args, "-d", stage, out.image)
	if _, err := run(ctx, "mkfs.ext4", args...); err != nil {
		return out, err
	}
	out.compressed = filepath.Join(dir, "workspace.ext4.gz")
	artifact, err := os.OpenFile(out.compressed, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return out, err
	}
	defer artifact.Close()
	storedHash, imageHash := sha256.New(), sha256.New()
	z, err := gzip.NewWriterLevel(io.MultiWriter(artifact, storedHash), gzip.BestSpeed)
	if err != nil {
		return out, err
	}
	input, err := os.Open(out.image)
	if err != nil {
		return out, err
	}
	encodeErr := WriteSparseImage(ctx, io.MultiWriter(z, imageHash), input, m.VirtualSize)
	inputErr, gzipErr := input.Close(), z.Close()
	if encodeErr != nil || inputErr != nil || gzipErr != nil {
		return out, fmt.Errorf("compress sparse workspace image: encode=%v close=%v gzip=%v", encodeErr, inputErr, gzipErr)
	}
	if err := artifact.Sync(); err != nil {
		return out, err
	}
	info, err := artifact.Stat()
	if err != nil {
		return out, err
	}
	out.descriptor = store.WorkspaceImage{Format: store.WorkspaceImageFormat, Lineage: q.Lineage, Tree: q.Tree,
		VirtualSize: m.VirtualSize, StoredSize: info.Size(), SHA256: hex.EncodeToString(storedHash.Sum(nil)),
		ImageSHA256: hex.EncodeToString(imageHash.Sum(nil))}
	out.descriptor.Blob = "w/" + out.descriptor.SHA256
	return out, artifact.Close()
}

func materializePrebuiltBlob(ctx context.Context, stage string, entry objects.Entry, input io.Reader) error {
	if entry.Size < 0 {
		return fmt.Errorf("invalid workspace image blob length")
	}
	path := filepath.Join(stage, entry.Path)
	file, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	hash := sha1.New()
	fmt.Fprintf(hash, "blob %d\x00", entry.Size)
	body := prebuiltReader{ctx, input}
	n, readErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(body, entry.Size))
	var extra [1]byte
	_, eof := io.ReadFull(body, extra[:])
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || n != entry.Size || eof != io.EOF || hex.EncodeToString(hash.Sum(nil)) != entry.SHA1 {
		return fmt.Errorf("workspace image blob mismatch: %s (read=%v close=%v tail=%v)", entry.Path, readErr, closeErr, eof)
	}
	switch entry.Mode {
	case "100644":
		return os.Chmod(path, 0644)
	case "100755":
		return os.Chmod(path, 0755)
	case "120000":
		raw, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.Remove(path); err != nil {
			return err
		}
		return os.Symlink(string(raw), path)
	default:
		return fmt.Errorf("unsupported workspace image mode %s", entry.Mode)
	}
}
