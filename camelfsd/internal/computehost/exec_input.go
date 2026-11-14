package computehost

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"log/slog"
	"os"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func stageExecInput(ctx context.Context, objects store.Store, dir, lineage string, blob hostwire.ExecBlob) (out *os.File, err error) {
	if !blob.Valid() {
		return nil, invalidRequest
	}
	src, err := store.OpenReader(ctx, store.ForLineage(objects, lineage), "o/"+blob.Blob)
	if err != nil {
		return nil, err
	}
	defer src.Close()

	f, err := os.CreateTemp(dir, "exec-stdin-")
	if err != nil {
		return nil, err
	}
	// The descriptor owns the staging file, including across cancellation.
	defer func() {
		if err != nil {
			f.Close()
		}
	}()
	if err := os.Remove(f.Name()); err != nil {
		return nil, err
	}

	hash := sha256.New()
	n, err := io.Copy(io.MultiWriter(f, hash), io.LimitReader(src, *blob.Size+1))
	if err != nil {
		return nil, err
	}
	if n != *blob.Size || hex.EncodeToString(hash.Sum(nil)) != blob.SHA256 {
		return nil, &httpError{502, "blob_mismatch"}
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	return f, nil
}

func (h *Host) execInput(ctx context.Context, s *session, blob hostwire.ExecBlob) (string, func(), error) {
	h.mu.Lock()
	spec := s.row.Spec
	h.mu.Unlock()
	start := time.Now()
	f, err := stageExecInput(ctx, h.Mounts.Store, h.Mounts.Data, spec.Lineage, blob)
	// One line per staged stdin blob: the store fetch to the host temp file, hash-verified. Ids and sizes only.
	var size int64
	if blob.Size != nil {
		size = *blob.Size
	}
	slog.Info("compute_exec_input", "vm", spec.ID, "blob", blob.Blob, "bytes", size, "ms", ms(time.Since(start)), "error", err)
	if err != nil {
		return "", nil, err
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		f.Close()
		return "", nil, err
	}
	token := hex.EncodeToString(nonce[:])
	release, err := h.Mounts.OfferExecInput(spec.ID, token, f)
	if err != nil {
		f.Close()
		return "", nil, err
	}
	return token, func() {
		release()
		f.Close()
	}, nil
}
