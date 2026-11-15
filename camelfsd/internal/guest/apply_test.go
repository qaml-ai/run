package guest

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/wire"
)

func sendApplyTestStart(c net.Conn) error {
	if err := wire.Send(c, wire.Header{V: 1, Kind: "apply", JobID: "j", ToTree: strings.Repeat("a", 40)}); err != nil {
		return err
	}
	return wire.Send(c, message{"indexEnd": true, "count": 0})
}

func readApplyTestReply(c net.Conn, want string) error {
	var reply struct {
		Applied bool
		Error   string
	}
	if err := wire.JSON(c, &reply); err != nil {
		return err
	}
	if reply.Applied != (want == "") || !strings.Contains(reply.Error, want) {
		return fmt.Errorf("apply reply %+v, want error %q", reply, want)
	}
	return nil
}

func TestApplyPutBeforeDelete(t *testing.T) {
	g := fixture(t)
	g.syncWorkspace = func(string) error { return nil }
	peer := streamListener(t, g, 5201, func(c net.Conn) error {
		if err := sendApplyTestStart(c); err != nil {
			return err
		}
		if err := wire.Send(c, wire.Op{Op: "put", Path: "file", Mode: "100644", Size: 2}); err != nil {
			return err
		}
		for _, b := range []byte{'a', 'b'} {
			if err := wire.Write(c, []byte{b}); err != nil {
				return err
			}
		}
		if err := wire.Send(c, wire.Op{Op: "del", Path: "file"}); err != nil {
			return err
		}
		if err := wire.Send(c, wire.Op{End: true}); err != nil {
			return err
		}
		return readApplyTestReply(c, "")
	})
	result, err := g.apply(t.Context(), request{JobID: "j", TimeoutMs: 5000})
	if err != nil || result["files"] != 2 {
		t.Fatalf("apply: %v, %v", result, err)
	}
	if err := <-peer; err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(g.repo, "file")); !os.IsNotExist(err) {
		t.Fatalf("delete did not follow put: %v", err)
	}
}

type applyCountingReader struct {
	io.Reader
	bytes atomic.Int64
}

func (r *applyCountingReader) Read(p []byte) (int, error) {
	n, err := r.Reader.Read(p)
	r.bytes.Add(int64(n))
	return n, err
}

func TestApplyQueueByteCap(t *testing.T) {
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	var frame bytes.Buffer
	if err := wire.Write(&frame, make([]byte, wire.DataMax)); err != nil {
		t.Fatal(err)
	}
	const capFrames = applyQueueBytes / wire.DataMax
	const total = capFrames + 4
	frames := make([]io.Reader, total)
	for i := range frames {
		frames[i] = bytes.NewReader(frame.Bytes())
	}
	r := &applyCountingReader{Reader: io.MultiReader(frames...)}
	q := newApplyQueue()
	done := make(chan error, 1)
	go func() {
		defer close(q.items)
		done <- readApplyData(ctx, r, q, total*wire.DataMax)
	}()

	waitForCap := func(readFrames int) {
		t.Helper()
		tick := time.NewTicker(time.Millisecond)
		defer tick.Stop()
		for q.buffered.Load() < applyQueueBytes {
			select {
			case <-ctx.Done():
				t.Fatal("reader never filled the byte budget")
			case <-tick.C:
			}
		}
		// Keep a frame in the writer's hands while the reader is at the cap.
		time.Sleep(10 * time.Millisecond)
		if n := q.buffered.Load(); n != applyQueueBytes {
			t.Fatalf("buffered %d bytes at the cap, want %d", n, applyQueueBytes)
		}
		if n, want := r.bytes.Load(), int64(readFrames*frame.Len()); n != want {
			t.Fatalf("reader consumed %d bytes while writer stalled, want %d", n, want)
		}
	}
	for i := 0; i < total; i++ {
		item, ok, err := q.next(ctx)
		if err != nil || !ok || len(item.data) != wire.DataMax {
			t.Fatalf("frame %d: size %d, available %v, err %v", i, len(item.data), ok, err)
		}
		if i <= total-capFrames {
			waitForCap(capFrames + i)
		}
		q.release(len(item.data))
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
}

func waitForApplyPath(path string) error {
	until := time.Now().Add(time.Second)
	for {
		if _, err := os.Stat(path); err == nil || !os.IsNotExist(err) || time.Now().After(until) {
			return err
		}
		time.Sleep(time.Millisecond)
	}
}

func assertFailedApplyClean(t *testing.T, g *guest) {
	t.Helper()
	if _, err := os.Stat(g.indexPath()); !os.IsNotExist(err) || g.index != nil {
		t.Errorf("failed apply saved an index: %v, %v", g.index, err)
	}
	if err := walkRepo(g.repo, func(_ string, rel string, d os.DirEntry) error {
		if strings.HasPrefix(d.Name(), ".camelfs-tmp-") {
			t.Errorf("failed apply left temp %s", rel)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
}

func TestApplyReaderErrorRemovesPartialPut(t *testing.T) {
	g := fixture(t)
	g.syncWorkspace = func(string) error { t.Error("failed apply reached sync"); return nil }
	const want = "raw frame crosses declared size or exceeds rawMax"
	peer := streamListener(t, g, 5201, func(c net.Conn) error {
		if err := sendApplyTestStart(c); err != nil {
			return err
		}
		if err := wire.Send(c, wire.Op{Op: "put", Path: "file", Mode: "100644", Size: 2}); err != nil {
			return err
		}
		if err := wire.Write(c, []byte("a")); err != nil {
			return err
		}
		// Wait for the writer to create the temp and write the first byte.
		until := time.Now().Add(time.Second)
		for {
			entries, err := os.ReadDir(g.repo)
			if err != nil {
				return err
			}
			if len(entries) == 1 && strings.HasPrefix(entries[0].Name(), ".camelfs-tmp-") {
				info, err := entries[0].Info()
				if err != nil {
					return err
				}
				if info.Size() == 1 {
					break
				}
			}
			if time.Now().After(until) {
				return errors.New("writer never wrote the partial put")
			}
			time.Sleep(time.Millisecond)
		}
		if err := wire.Write(c, []byte("bc")); err != nil {
			return err
		}
		return readApplyTestReply(c, want)
	})
	if _, err := g.apply(t.Context(), request{JobID: "j", TimeoutMs: 5000}); err == nil || err.Error() != want {
		t.Errorf("apply returned %v, want %q", err, want)
	}
	if err := <-peer; err != nil {
		t.Error(err)
	}
	assertFailedApplyClean(t, g)
}

func TestApplyWriterErrorInterruptsHostSend(t *testing.T) {
	g := fixture(t)
	g.syncWorkspace = func(string) error { t.Error("failed apply reached sync"); return nil }
	// A put can write its temp but cannot rename a file over a directory.
	if err := os.Mkdir(filepath.Join(g.repo, "blocked"), 0755); err != nil {
		t.Fatal(err)
	}
	const total = 256 * wire.DataMax
	peer := streamListener(t, g, 5201, func(c net.Conn) error {
		if err := sendApplyTestStart(c); err != nil {
			return err
		}
		if err := wire.Send(c, wire.Op{Op: "put", Path: "blocked", Mode: "100644", Size: 1}); err != nil {
			return err
		}
		if err := wire.Write(c, []byte("a")); err != nil {
			return err
		}
		c.SetDeadline(time.Now().Add(time.Second))
		sent := 0
		err := wire.Send(c, wire.Op{Op: "put", Path: "later", Mode: "100644", Size: total})
		data := make([]byte, wire.DataMax)
		for err == nil && sent < total {
			err = wire.Write(c, data)
			if err == nil {
				sent += len(data)
			}
		}
		var ne net.Error
		if err == nil || errors.As(err, &ne) && ne.Timeout() || sent >= total/2 {
			return fmt.Errorf("host sent %d/%d bytes, send returned %v", sent, total, err)
		}
		return readApplyTestReply(c, "rename")
	})
	if _, err := g.apply(t.Context(), request{JobID: "j", TimeoutMs: 5000}); err == nil || !strings.Contains(err.Error(), "rename") {
		t.Errorf("apply returned %v, want rename failure", err)
	}
	if err := <-peer; err != nil {
		t.Error(err)
	}
	assertFailedApplyClean(t, g)
}
