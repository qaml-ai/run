package image

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/unix"
)

func TestSparseImage64GiBRoundTrip(t *testing.T) {
	const virtualSize int64 = 64 << 30
	source := sparseTestFile(t, "source")
	if err := source.Truncate(virtualSize); err != nil {
		t.Fatal(err)
	}
	chunks := []struct {
		offset int64
		data   []byte
	}{
		{4096 + 11, []byte("first sparse extent")},
		{3<<30 + 123, bytes.Repeat([]byte{0x81, 0x20, 0x00, 0xff}, 713)},
		{virtualSize - 8192 + 77, []byte("last sparse extent")},
	}
	for _, chunk := range chunks {
		if _, err := source.WriteAt(chunk.data, chunk.offset); err != nil {
			t.Fatal(err)
		}
	}
	// A filesystem conservatively reporting the entire file as data would turn
	// this regression into a 64 GiB scan. Require real extent discovery first.
	hole, err := unix.Seek(int(source.Fd()), 0, unix.SEEK_HOLE)
	if err != nil || hole != 0 {
		t.Fatalf("sparse filesystem required: initial hole=%d, error=%v", hole, err)
	}
	var encoded bytes.Buffer
	wantHash := sha256.New()
	bounded := &sparseBoundedWriter{Writer: &encoded, remaining: 1 << 20}
	if err := WriteSparseImage(t.Context(), io.MultiWriter(bounded, wantHash), source, virtualSize); err != nil {
		t.Fatal(err)
	}
	if encoded.Len() >= 1<<20 {
		t.Fatalf("sparse encoding unexpectedly large: %d bytes", encoded.Len())
	}
	destination := sparseTestFile(t, "restored")
	gotHash := sha256.New()
	if err := ReadSparseImage(t.Context(), io.TeeReader(bytes.NewReader(encoded.Bytes()), gotHash), destination, virtualSize); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(gotHash.Sum(nil), wantHash.Sum(nil)) {
		t.Fatal("sparse metadata/data digest changed during restore")
	}
	info, err := destination.Stat()
	if err != nil || info.Size() != virtualSize {
		t.Fatalf("restored virtual size: info=%v error=%v", info, err)
	}
	for _, offset := range []int64{0, 4096, 1 << 30, 3 << 30, virtualSize - 8192, virtualSize - 4096} {
		want, got := make([]byte, 4096), make([]byte, 4096)
		if _, err := source.ReadAt(want, offset); err != nil {
			t.Fatal(err)
		}
		if _, err := destination.ReadAt(got, offset); err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, want) {
			t.Fatalf("restored image differs at offset %d", offset)
		}
	}
	var stat unix.Stat_t
	if err := unix.Fstat(int(destination.Fd()), &stat); err != nil || stat.Blocks*512 >= 1<<20 {
		t.Fatalf("restored image is not sparse: blocks=%d error=%v", stat.Blocks, err)
	}
	t.Logf("virtual_bytes=%d encoded_bytes=%d restored_allocated_bytes=%d", virtualSize, encoded.Len(), stat.Blocks*512)
}

func TestSparseImageEmptyRoundTrip(t *testing.T) {
	source := sparseTestFile(t, "empty")
	if err := source.Truncate(64 << 30); err != nil {
		t.Fatal(err)
	}
	var encoded bytes.Buffer
	if err := WriteSparseImage(t.Context(), &encoded, source, 64<<30); err != nil {
		t.Fatal(err)
	}
	if encoded.Len() != 32 {
		t.Fatalf("empty image encoding size=%d, want 32", encoded.Len())
	}
	if err := ReadSparseImage(t.Context(), &encoded, sparseTestFile(t, "empty-restored"), 64<<30); err != nil {
		t.Fatal(err)
	}
}

func TestSparseImageRejectsMalformedStream(t *testing.T) {
	good := sparseTestStream(32, sparseTestRecord{offset: 4, data: []byte("test")})
	badMagic := bytes.Clone(good)
	badMagic[0] ^= 1
	badSize := bytes.Clone(good)
	binary.BigEndian.PutUint64(badSize[8:16], 33)
	badEnd := bytes.Clone(good)
	binary.BigEndian.PutUint64(badEnd[len(badEnd)-16:], 31)
	cases := map[string][]byte{
		"magic":             badMagic,
		"virtual size":      badSize,
		"terminator":        badEnd,
		"header truncated":  good[:15],
		"record truncated":  good[:31],
		"body truncated":    good[:34],
		"missing end":       good[:36],
		"trailing data":     append(bytes.Clone(good), 0),
		"overlap":           sparseTestStream(32, sparseTestRecord{4, []byte("1234")}, sparseTestRecord{7, []byte("x")}),
		"unordered":         sparseTestStream(32, sparseTestRecord{8, []byte("x")}, sparseTestRecord{4, []byte("x")}),
		"past image end":    sparseTestStream(32, sparseTestRecord{31, []byte("xx")}),
		"offset overflow":   sparseTestStream(32, sparseTestRecord{math.MaxUint64, []byte("x")}),
		"zero length early": sparseTestStream(32, sparseTestRecord{4, nil}),
	}
	overflowLength := bytes.Clone(good)
	binary.BigEndian.PutUint64(overflowLength[24:32], math.MaxUint64)
	cases["length overflow"] = overflowLength
	for name, stream := range cases {
		t.Run(name, func(t *testing.T) {
			if err := ReadSparseImage(t.Context(), bytes.NewReader(stream), sparseTestFile(t, "invalid"), 32); err == nil {
				t.Fatal("malformed sparse image accepted")
			}
		})
	}
}

func TestSparseImagePropagatesTailError(t *testing.T) {
	sentinel := errors.New("gzip footer verification failed")
	reader := io.MultiReader(bytes.NewReader(sparseTestStream(32)), sparseErrorReader{sentinel})
	if err := ReadSparseImage(t.Context(), reader, sparseTestFile(t, "invalid-tail"), 32); !errors.Is(err, sentinel) {
		t.Fatalf("tail error=%v, want %v", err, sentinel)
	}
}

func TestSparseImageCancellationAndWriteErrors(t *testing.T) {
	source := sparseTestFile(t, "source")
	if err := source.Truncate(4096); err != nil {
		t.Fatal(err)
	}
	if _, err := source.WriteAt([]byte("allocated"), 0); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	writer := &sparseCancelWriter{cancel: cancel}
	if err := WriteSparseImage(ctx, writer, source, 4096); !errors.Is(err, context.Canceled) {
		t.Fatalf("encoder cancellation error=%v", err)
	}
	if err := WriteSparseImage(t.Context(), sparseShortWriter{}, source, 4096); !errors.Is(err, io.ErrShortWrite) {
		t.Fatalf("encoder short write error=%v", err)
	}
	ctx, cancel = context.WithCancel(t.Context())
	reader := &sparseCancelReader{Reader: bytes.NewReader(sparseTestStream(32)), cancel: cancel}
	if err := ReadSparseImage(ctx, reader, sparseTestFile(t, "cancelled"), 32); !errors.Is(err, context.Canceled) {
		t.Fatalf("decoder cancellation error=%v", err)
	}
	if err := WriteSparseImage(t.Context(), io.Discard, source, 4095); err == nil {
		t.Fatal("encoder accepted a different virtual size")
	}
	dirty := sparseTestFile(t, "dirty")
	if _, err := dirty.WriteAt([]byte("stale bytes"), 0); err != nil {
		t.Fatal(err)
	}
	if err := ReadSparseImage(t.Context(), bytes.NewReader(sparseTestStream(32)), dirty, 32); err == nil {
		t.Fatal("decoder accepted nonempty destination with stale hole bytes")
	}
}

func sparseTestFile(t *testing.T, name string) *os.File {
	t.Helper()
	file, err := os.OpenFile(filepath.Join(t.TempDir(), name), os.O_CREATE|os.O_EXCL|os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { file.Close() })
	return file
}

type sparseTestRecord struct {
	offset uint64
	data   []byte
}

func sparseTestStream(size uint64, records ...sparseTestRecord) []byte {
	var stream bytes.Buffer
	stream.WriteString(sparseImageMagic)
	binary.Write(&stream, binary.BigEndian, size)
	for _, record := range records {
		binary.Write(&stream, binary.BigEndian, record.offset)
		binary.Write(&stream, binary.BigEndian, uint64(len(record.data)))
		stream.Write(record.data)
	}
	binary.Write(&stream, binary.BigEndian, size)
	binary.Write(&stream, binary.BigEndian, uint64(0))
	return stream.Bytes()
}

type sparseErrorReader struct{ err error }

func (r sparseErrorReader) Read([]byte) (int, error) { return 0, r.err }

type sparseCancelWriter struct{ cancel context.CancelFunc }

func (w *sparseCancelWriter) Write(data []byte) (int, error) {
	w.cancel()
	return len(data), nil
}

type sparseShortWriter struct{}

func (sparseShortWriter) Write(data []byte) (int, error) { return len(data) - 1, nil }

type sparseBoundedWriter struct {
	io.Writer
	remaining int
}

func (w *sparseBoundedWriter) Write(data []byte) (int, error) {
	if len(data) > w.remaining {
		return 0, errors.New("sparse test encoding exceeded bound")
	}
	n, err := w.Writer.Write(data)
	w.remaining -= n
	return n, err
}

type sparseCancelReader struct {
	io.Reader
	cancel context.CancelFunc
}

func (r *sparseCancelReader) Read(data []byte) (int, error) {
	n, err := r.Reader.Read(data)
	r.cancel()
	return n, err
}
