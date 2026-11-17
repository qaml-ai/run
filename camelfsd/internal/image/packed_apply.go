package image

import (
	"compress/gzip"
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strconv"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
)

// PackedApply is a benchmark-only prepared stream. Its binding is supplied by
// the fixture that built the artifact from verified canonical objects.
type PackedApply struct {
	Lineage, Commit, Tree, Codec string
	Blob, SHA256, RawSHA256      string
	Size, RawSize, Bytes         int64
	Files                        int
}

type packedApplyCount struct {
	io.Writer
	n int64
}

func (w *packedApplyCount) Write(b []byte) (int, error) {
	n, err := w.Writer.Write(b)
	w.n += int64(n)
	return n, err
}

// PreparePackedApply builds a complete blank-to-tree body using normal verified
// restore reads. The per-VM header remains outside the reusable artifact.
func (m *Manager) PreparePackedApply(ctx context.Context, lineage, commit, tree, codec string) (out PackedApply, err error) {
	if codec != "plain" && codec != "gzip" {
		return out, fmt.Errorf("invalid packed apply codec")
	}
	version, found, err := m.objects(lineage).CommitAncestry(ctx, lineage, commit)
	if err != nil {
		return out, err
	}
	if !found || version.Tree != tree {
		return out, fmt.Errorf("packed apply commit/tree binding failed")
	}
	entries, err := m.entries(ctx, lineage, tree)
	if err != nil {
		return out, err
	}
	ops := make([]wire.Op, 0, len(entries))
	a := applyTrees{ToTree: tree, Files: len(entries)}
	for _, entry := range entries {
		ops = append(ops, wire.Op{Path: entry.Path, Op: "put", Mode: entry.Mode, Size: entry.Size})
		a.Bytes += entry.Size
	}
	f, err := os.CreateTemp(m.Data, "packed-apply-build-")
	if err != nil {
		return out, err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	var dest io.Writer = f
	var compressed *gzip.Writer
	if codec == "gzip" {
		compressed, err = gzip.NewWriterLevel(f, gzip.BestSpeed)
		if err != nil {
			return out, err
		}
		dest = compressed
	}
	rawHash := sha256.New()
	raw := &packedApplyCount{Writer: io.MultiWriter(dest, rawHash)}
	if err := m.sendApplyBody(ctx, raw, lineage, "archive-build", a, entries, ops); err != nil {
		return out, err
	}
	if compressed != nil {
		if err := compressed.Close(); err != nil {
			return out, err
		}
	}
	st, err := f.Stat()
	if err != nil {
		return out, err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return out, err
	}
	git, encodedHash := sha1.New(), sha256.New()
	fmt.Fprintf(git, "blob %d\x00", st.Size())
	if _, err := io.Copy(io.MultiWriter(git, encodedHash), f); err != nil {
		return out, err
	}
	out = PackedApply{Lineage: lineage, Commit: commit, Tree: tree, Codec: codec,
		Blob: fmt.Sprintf("%x", git.Sum(nil)), SHA256: fmt.Sprintf("%x", encodedHash.Sum(nil)),
		RawSHA256: fmt.Sprintf("%x", rawHash.Sum(nil)), Size: st.Size(), RawSize: raw.n,
		Files: len(entries), Bytes: a.Bytes}
	if err := store.PutBlobFile(ctx, store.ForLineage(m.Store, lineage), "o/"+out.Blob, f, out.SHA256); err != nil {
		return PackedApply{}, err
	}
	return out, nil
}

func (m *Manager) validatePackedApply(ctx context.Context, v *Mount) error {
	p := m.PackedApply
	if p == nil || p.Lineage != v.Lineage || p.Commit != v.Parent.Commit || p.Tree != v.Tree || v.BaseTree != "" ||
		!root.Hex(p.Blob, 40) || !root.Hex(p.SHA256, 64) || !root.Hex(p.RawSHA256, 64) ||
		p.Size <= 0 || p.RawSize <= 0 || p.Files < 0 || p.Bytes < 0 || (p.Codec != "plain" && p.Codec != "gzip") {
		return fmt.Errorf("invalid packed apply binding")
	}
	if m.PackedParallel && p.Codec != "plain" {
		return fmt.Errorf("parallel packed apply requires plain codec")
	}
	commit, found, err := m.objects(v.Lineage).CommitAncestry(ctx, v.Lineage, v.Parent.Commit)
	if err != nil {
		return err
	}
	if !found || commit.Tree != p.Tree {
		return fmt.Errorf("packed apply commit does not name tree")
	}
	return nil
}

// Verify both stored bytes and decoded body before sending any artifact bytes.
// The existing guest applies the already verified wire stream.
func (m *Manager) replayPackedApply(ctx context.Context, w io.Writer, lineage, tree string) error {
	p := m.PackedApply
	if p == nil || p.Lineage != lineage || p.Tree != tree {
		return fmt.Errorf("packed apply target changed")
	}
	start := time.Now()
	encoded, err := os.CreateTemp(m.Data, "packed-apply-encoded-")
	if err != nil {
		return err
	}
	defer os.Remove(encoded.Name())
	defer encoded.Close()
	sha, git := sha256.New(), sha1.New()
	fmt.Fprintf(git, "blob %d\x00", p.Size)
	var n int64
	rangeGets := 0
	if m.PackedParallel {
		if p.Codec != "plain" {
			return fmt.Errorf("parallel packed apply requires plain codec")
		}
		const partBytes = store.BundleTargetBytes
		var offsets []string
		for offset := int64(0); offset < p.Size; offset += partBytes {
			offsets = append(offsets, strconv.FormatInt(offset, 10))
		}
		rangeGets = len(offsets)
		err = store.Parallel(ctx, int(applyInflightBytes/partBytes), offsets, func(value string) error {
			offset, _ := strconv.ParseInt(value, 10, 64)
			size := min(int64(partBytes), p.Size-offset)
			data, err := store.ReadObjectRange(ctx, store.ForLineage(m.Store, lineage), "o/"+p.Blob, offset, size, p.Size)
			if err != nil {
				return err
			}
			_, err = encoded.WriteAt(data, offset)
			return err
		})
		if err != nil {
			return err
		}
		if _, err = encoded.Seek(0, io.SeekStart); err != nil {
			return err
		}
		n, err = io.Copy(io.MultiWriter(sha, git), io.LimitReader(encoded, p.Size+1))
	} else {
		source, err := store.OpenReader(ctx, store.ForLineage(m.Store, lineage), "o/"+p.Blob)
		if err != nil {
			return err
		}
		n, err = io.Copy(io.MultiWriter(encoded, sha, git), io.LimitReader(source, p.Size+1))
		closeErr := source.Close()
		if err == nil {
			err = closeErr
		}
	}
	if err != nil {
		return err
	}
	if n != p.Size || fmt.Sprintf("%x", sha.Sum(nil)) != p.SHA256 || fmt.Sprintf("%x", git.Sum(nil)) != p.Blob {
		return fmt.Errorf("packed apply stored digest or size mismatch")
	}
	fetchMs := ms(start)
	if _, err := encoded.Seek(0, io.SeekStart); err != nil {
		return err
	}
	var decoded io.Reader = encoded
	if p.Codec == "gzip" {
		g, err := gzip.NewReader(encoded)
		if err != nil {
			return err
		}
		defer g.Close()
		decoded = g
	}
	body, err := os.CreateTemp(m.Data, "packed-apply-body-")
	if err != nil {
		return err
	}
	defer os.Remove(body.Name())
	defer body.Close()
	rawHash := sha256.New()
	n, err = io.Copy(io.MultiWriter(body, rawHash), io.LimitReader(decoded, p.RawSize+1))
	if err != nil {
		return err
	}
	if n != p.RawSize || fmt.Sprintf("%x", rawHash.Sum(nil)) != p.RawSHA256 {
		return fmt.Errorf("packed apply decoded digest or size mismatch")
	}
	verifyMs := ms(start) - fetchMs
	if _, err := body.Seek(0, io.SeekStart); err != nil {
		return err
	}
	_, err = io.Copy(w, body)
	slog.Info("compute_apply_archive", "codec", p.Codec, "tree", p.Tree, "storedBytes", p.Size, "rawBytes", p.RawSize,
		"parallel", m.PackedParallel, "rangeGets", rangeGets, "fetchMs", fetchMs, "verifyMs", verifyMs, "sendMs", ms(start)-fetchMs-verifyMs, "error", err)
	return err
}
