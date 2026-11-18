package vm

import (
	"bufio"
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
	if _, err := io.ReadFull(bufio.NewReader(rw), hdr[:]); err != nil {
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

func TestFirecrackerBlobSocketFraming(t *testing.T) {
	payload := bytes.Repeat([]byte("lazy-fuse-blob-"), 1024)
	sum := sha256.Sum256(payload)
	hash := hex.EncodeToString(sum[:])

	serverConn, clientConn := net.Pipe()
	defer clientConn.Close()
	go serveBlobConn(serverConn, func(_ context.Context, h string) ([]byte, error) {
		if h == hash {
			return payload, nil
		}
		return nil, os.ErrNotExist
	})

	got, err := fetchFramedBlob(t, clientConn, hash)
	if err != nil {
		t.Fatalf("fetch existing blob: %v", err)
	}
	if !bytes.Equal(got, payload) {
		t.Fatalf("blob payload mismatch (%d bytes vs %d)", len(got), len(payload))
	}

	if _, err := fetchFramedBlob(t, clientConn, "deadbeef"); err == nil {
		t.Fatalf("expected error for missing blob")
	}
}
