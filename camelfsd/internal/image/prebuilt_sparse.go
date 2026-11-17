package image

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"

	"golang.org/x/sys/unix"
)

const sparseImageMagic = "CFSIMG02"

// WriteSparseImage writes the image's allocated extents. Hashing this complete
// stream binds both the extent map and its bytes; holes require no zero scan.
// The input must be an immutable regular file of exactly virtualSize bytes.
func WriteSparseImage(ctx context.Context, output io.Writer, input *os.File, virtualSize int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	info, err := input.Stat()
	if err != nil {
		return err
	}
	if virtualSize <= 0 || !info.Mode().IsRegular() || info.Size() != virtualSize {
		return fmt.Errorf("invalid sparse workspace image size or type")
	}
	var header [16]byte
	copy(header[:8], sparseImageMagic)
	binary.BigEndian.PutUint64(header[8:], uint64(virtualSize))
	if err := writeSparseBytes(ctx, output, header[:]); err != nil {
		return err
	}
	buffer := make([]byte, 64<<10)
	for cursor := int64(0); cursor < virtualSize; {
		if err := ctx.Err(); err != nil {
			return err
		}
		offset, err := unix.Seek(int(input.Fd()), cursor, unix.SEEK_DATA)
		if errors.Is(err, unix.ENXIO) {
			break
		}
		if err != nil {
			return fmt.Errorf("seek sparse image data: %w", err)
		}
		if offset < cursor || offset >= virtualSize {
			return fmt.Errorf("invalid sparse image data offset")
		}
		end, err := unix.Seek(int(input.Fd()), offset, unix.SEEK_HOLE)
		if err != nil {
			return fmt.Errorf("seek sparse image hole: %w", err)
		}
		if end <= offset || end > virtualSize {
			return fmt.Errorf("invalid sparse image extent")
		}
		binary.BigEndian.PutUint64(header[:8], uint64(offset))
		binary.BigEndian.PutUint64(header[8:], uint64(end-offset))
		if err := writeSparseBytes(ctx, output, header[:]); err != nil {
			return err
		}
		section := io.NewSectionReader(input, offset, end-offset)
		for remaining := end - offset; remaining > 0; {
			if err := ctx.Err(); err != nil {
				return err
			}
			chunk := buffer[:min(int64(len(buffer)), remaining)]
			if _, err := io.ReadFull(section, chunk); err != nil {
				return err
			}
			if err := writeSparseBytes(ctx, output, chunk); err != nil {
				return err
			}
			remaining -= int64(len(chunk))
		}
		cursor = end
	}
	binary.BigEndian.PutUint64(header[:8], uint64(virtualSize))
	binary.BigEndian.PutUint64(header[8:], 0)
	return writeSparseBytes(ctx, output, header[:])
}

// ReadSparseImage restores a strictly ordered extent stream. It consumes EOF
// after the terminator so an enclosing gzip reader verifies its footer too.
// The caller owns synchronization, digest verification and failed-file cleanup.
func ReadSparseImage(ctx context.Context, input io.Reader, output *os.File, virtualSize int64) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if virtualSize <= 0 {
		return fmt.Errorf("invalid sparse workspace image size")
	}
	reader := sparseContextReader{ctx: ctx, Reader: input}
	var header [16]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return err
	}
	if !bytes.Equal(header[:8], []byte(sparseImageMagic)) || binary.BigEndian.Uint64(header[8:]) != uint64(virtualSize) {
		return fmt.Errorf("sparse workspace image header mismatch")
	}
	info, err := output.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != 0 {
		return fmt.Errorf("sparse workspace image destination must be an empty regular file")
	}
	buffer := make([]byte, 64<<10)
	var previousEnd uint64
	for {
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			return err
		}
		offset, length := binary.BigEndian.Uint64(header[:8]), binary.BigEndian.Uint64(header[8:])
		if length == 0 {
			if offset != uint64(virtualSize) {
				return fmt.Errorf("invalid sparse workspace image terminator")
			}
			var tail [1]byte
			if _, err := io.ReadFull(reader, tail[:]); err != io.EOF {
				if err == nil {
					return fmt.Errorf("trailing sparse workspace image data")
				}
				return err
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			return output.Truncate(virtualSize)
		}
		if offset < previousEnd || offset >= uint64(virtualSize) || length > uint64(virtualSize)-offset {
			return fmt.Errorf("invalid or overlapping sparse workspace image extent")
		}
		position := int64(offset)
		for remaining := length; remaining > 0; {
			chunk := buffer[:min(uint64(len(buffer)), remaining)]
			if _, err := io.ReadFull(reader, chunk); err != nil {
				return err
			}
			if err := ctx.Err(); err != nil {
				return err
			}
			n, err := output.WriteAt(chunk, position)
			if err != nil {
				return err
			}
			if n != len(chunk) {
				return io.ErrShortWrite
			}
			position += int64(n)
			remaining -= uint64(n)
		}
		previousEnd = offset + length
	}
}

func writeSparseBytes(ctx context.Context, output io.Writer, data []byte) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	n, err := output.Write(data)
	if err == nil && n != len(data) {
		return io.ErrShortWrite
	}
	return err
}

type sparseContextReader struct {
	ctx context.Context
	io.Reader
}

func (r sparseContextReader) Read(data []byte) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.Reader.Read(data)
}
