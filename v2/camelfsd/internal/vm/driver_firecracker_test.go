package vm

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"io"
	"net"
	"os"
	"testing"
)

func fetchFramedBlob(t *testing.T, rw io.ReadWriter, hash string) ([]byte, error) {
	t.Helper()
	if _, err := io.WriteString(rw, hash+"\n"); err != nil {
		return nil, err
	}
	var hdr [9]byte
	if _, err := io.ReadFull(rw, hdr[:]); err != nil {
		return nil, err
	}
	n := binary.BigEndian.Uint64(hdr[1:9])
	buf := make([]byte, int(n))
	if n > 0 {
		if _, err := io.ReadFull(rw, buf); err != nil {
			return nil, err
		}
	}
	if hdr[0] != 0 {
		return nil, errors.New(string(buf))
	}
	return buf, nil
}

func TestFirecrackerBlobSocketScopesReadsToWorkspace(t *testing.T) {
	payload := bytes.Repeat([]byte("lazy-fuse-blob-"), 1024)
	sum := sha256.Sum256(payload)
	hash := hex.EncodeToString(sum[:])

	serverConn, clientConn := net.Pipe()
	defer clientConn.Close()
	go serveBlobConn(serverConn, map[string]struct{}{hash: {}}, func(_ context.Context, _ string) ([]byte, error) {
		return payload, nil
	})

	got, err := fetchFramedBlob(t, clientConn, hash)
	if err != nil {
		t.Fatalf("fetch existing blob: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("blob payload mismatch (%d bytes vs %d)", len(got), len(payload))
	}

	other := sha256.Sum256([]byte("another workspace"))
	if _, err := fetchFramedBlob(t, clientConn, hex.EncodeToString(other[:])); err == nil || err.Error() != os.ErrNotExist.Error() {
		t.Fatalf("expected not found for a blob outside the mounted tree, got %v", err)
	}
}
