package image

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func TestDecodePrebuiltImageIntegrity(t *testing.T) {
	raw := make([]byte, 256<<10)
	copy(raw[70000:], "verified workspace image")
	input, err := os.CreateTemp(t.TempDir(), "sparse-image")
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	if _, err := input.Write(raw); err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	imageHash := sha256.New()
	z := gzip.NewWriter(&encoded)
	if err := WriteSparseImage(t.Context(), io.MultiWriter(z, imageHash), input, int64(len(raw))); err != nil {
		t.Fatal(err)
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	encodedSum := sha256.Sum256(encoded.Bytes())
	descriptor := store.WorkspaceImage{SHA256: hex.EncodeToString(encodedSum[:]), ImageSHA256: hex.EncodeToString(imageHash.Sum(nil)),
		StoredSize: int64(encoded.Len()), VirtualSize: int64(len(raw))}
	for _, fault := range []string{"", "stored-digest", "image-digest", "short-image", "long-image", "truncated-footer", "checksum", "trailing-bytes", "cancelled"} {
		t.Run(fault, func(t *testing.T) {
			want := descriptor
			body := append([]byte(nil), encoded.Bytes()...)
			ctx := t.Context()
			switch fault {
			case "stored-digest":
				want.SHA256 = strings.Repeat("a", 64)
			case "image-digest":
				want.ImageSHA256 = strings.Repeat("a", 64)
			case "short-image":
				want.VirtualSize--
			case "long-image":
				want.VirtualSize++
			case "truncated-footer":
				body = body[:len(body)-4]
			case "checksum":
				body[len(body)-8] ^= 1
			case "trailing-bytes":
				body = append(body, []byte("unexpected tail")...)
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			if fault == "truncated-footer" || fault == "checksum" || fault == "trailing-bytes" {
				// Even a matching advertised encoded digest must not mask a
				// structurally invalid gzip stream after all sparse records arrived.
				sum := sha256.Sum256(body)
				want.SHA256, want.StoredSize = hex.EncodeToString(sum[:]), int64(len(body))
			}
			path := filepath.Join(t.TempDir(), "image.img")
			err := decodePrebuiltImage(ctx, bytes.NewReader(body), want, path)
			if fault != "" {
				if err == nil {
					t.Fatal("accepted corrupt workspace image")
				}
				if _, err := os.Stat(path); !os.IsNotExist(err) {
					t.Fatalf("failed image was left on disk: %v", err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			got, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(got, raw) {
				t.Fatalf("decoded bytes mismatch: %v", err)
			}
		})
	}
}
