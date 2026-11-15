package guest

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/wire"
	"golang.org/x/sys/unix"
)

// Bound buffered file data to 64 MiB plus at most one frame (wire.DataMax),
// about 3% of a 2 GiB guest. The item channel also bounds queued metadata.
const applyQueueBytes = 64 << 20

type applyItem struct {
	op   operation
	mode os.FileMode
	data []byte
}

type applyQueue struct {
	items    chan applyItem
	buffered atomic.Int64
	released chan struct{}
}

func newApplyQueue() *applyQueue {
	return &applyQueue{items: make(chan applyItem, 128), released: make(chan struct{}, 1)}
}

func (q *applyQueue) send(ctx context.Context, item applyItem) error {
	select {
	case q.items <- item:
		return nil
	case <-ctx.Done():
		return context.Cause(ctx)
	}
}

func (q *applyQueue) next(ctx context.Context) (applyItem, bool, error) {
	select {
	case item, ok := <-q.items:
		// A ready item and a canceled context can both win the select.
		return item, ok, context.Cause(ctx)
	case <-ctx.Done():
		return applyItem{}, false, context.Cause(ctx)
	}
}

func (q *applyQueue) release(n int) {
	q.buffered.Add(-int64(n))
	select {
	case q.released <- struct{}{}:
	default:
	}
}

func (g *guest) applyStream(parent context.Context, c transport, replay bool) (int, error) {
	ctx, cancel := context.WithCancelCause(parent)
	defer cancel(nil)
	q := newApplyQueue()
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		defer close(q.items)
		if err := readApply(ctx, c, q); err != nil {
			cancel(err)
		}
	}()
	files, err := g.writeApply(ctx, q, replay)
	if err != nil {
		cancel(err)
		// Interrupt a blocked frame read without affecting the nack's write side.
		_ = c.SetReadDeadline(time.Now())
	}
	<-readerDone
	return files, err
}

func readApply(ctx context.Context, r io.Reader, q *applyQueue) error {
	for {
		if err := context.Cause(ctx); err != nil {
			return err
		}
		var op operation
		if err := applyJSON(r, &op); err != nil {
			return err
		}
		if op.End {
			if op.Error != "" {
				return errors.New(op.Error)
			}
			return nil
		}
		if err := checkPath(op.Path); err != nil {
			return err
		}
		var mode os.FileMode
		switch op.Op {
		case "put", "mode":
			var err error
			mode, err = modeBits(op.Mode)
			if err != nil {
				return err
			}
			if op.Mode == "120000" {
				if op.Op == "put" {
					return errors.New("mode 120000 is invalid with put")
				}
				return errors.New("mode cannot change a symlink")
			}
			if op.Op == "put" && !validSize(op.Size) {
				return errors.New("invalid size")
			}
		case "link":
			if op.Target == nil || len(*op.Target) > 4096 || strings.ContainsRune(*op.Target, 0) {
				return errors.New("invalid link target")
			}
		case "del":
		default:
			return errors.New("unknown apply op")
		}
		if err := q.send(ctx, applyItem{op: op, mode: mode}); err != nil {
			return err
		}
		if op.Op == "put" {
			if err := readApplyData(ctx, r, q, *op.Size); err != nil {
				return err
			}
		}
	}
}

func readApplyData(ctx context.Context, r io.Reader, q *applyQueue, left int64) error {
	for left > 0 {
		// Leave space for a whole frame before reading. FrameMax allows a
		// malformed oversized frame to be read and rejected as before.
		for q.buffered.Load()+wire.DataMax > applyQueueBytes {
			select {
			case <-q.released:
			case <-ctx.Done():
				return context.Cause(ctx)
			}
		}
		if err := context.Cause(ctx); err != nil {
			return err
		}
		b, err := wire.Read(r, wire.FrameMax)
		if err != nil {
			if errors.Is(err, wire.ErrEmptyFrame) {
				return errors.New("raw frame crosses declared size or exceeds rawMax")
			}
			return readError(err, "unexpected EOF in apply stream")
		}
		if len(b) > wire.DataMax || int64(len(b)) > left {
			return errors.New("raw frame crosses declared size or exceeds rawMax")
		}
		q.buffered.Add(int64(len(b)))
		if err := q.send(ctx, applyItem{data: b}); err != nil {
			return err
		}
		left -= int64(len(b))
	}
	return nil
}

func (g *guest) writeApply(ctx context.Context, q *applyQueue, replay bool) (int, error) {
	files := 0
	for {
		item, ok, err := q.next(ctx)
		if err != nil || !ok {
			return files, err
		}
		if err := g.applyOp(ctx, q, item, replay); err != nil {
			return files, err
		}
		files++
	}
}

func (g *guest) applyOp(ctx context.Context, q *applyQueue, item applyItem, replay bool) error {
	op := item.op
	if op.Op == "del" {
		return g.applyDel(op.Path, replay)
	}
	// Filesystem path checks run in stream order, after earlier changes.
	path, err := g.target(op.Path)
	if err != nil {
		return err
	}
	switch op.Op {
	case "put":
		return applyPut(ctx, q, path, item.mode, *op.Size)
	case "link":
		if err := unix.Unlink(path); err != nil && err != unix.ENOENT {
			return err
		}
		return os.Symlink(*op.Target, path)
	case "mode":
		st, err := os.Lstat(path)
		if err != nil {
			return err
		}
		if st.Mode()&os.ModeSymlink != 0 {
			return errors.New("mode cannot change a symlink")
		}
		return os.Chmod(path, item.mode)
	default:
		return errors.New("unknown apply op")
	}
}

func applyPut(ctx context.Context, q *applyQueue, path string, mode os.FileMode, size int64) error {
	f, err := os.CreateTemp(filepath.Dir(path), ".camelfs-tmp-")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	defer f.Close()
	for left := size; left > 0; {
		item, ok, err := q.next(ctx)
		if err != nil {
			return err
		}
		if !ok {
			return errors.New("unexpected EOF in apply stream")
		}
		if _, err = f.Write(item.data); err != nil {
			return err
		}
		q.release(len(item.data))
		left -= int64(len(item.data))
	}
	if err := context.Cause(ctx); err != nil {
		return err
	}
	// Apply syncs the workspace before saving the index and exposing it as durable.
	if err = f.Close(); err != nil {
		return err
	}
	if err = context.Cause(ctx); err != nil {
		return err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return err
	}
	return os.Chmod(path, mode)
}
