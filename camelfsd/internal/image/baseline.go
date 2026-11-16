package image

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
)

// SessionBaselineTimeout bounds the boot-path handshake on both sides.
const SessionBaselineTimeout = 500 * time.Millisecond

type baselineSnapshot struct {
	dir  string
	size int64
	tree string
}

func (m *Manager) baselineDir() string { return filepath.Join(m.Data, "workspace-baselines") }

// StopBaselines cancels publication during daemon shutdown.
func (m *Manager) StopBaselines() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.baselineCancel != nil {
		m.baselineCancel()
	}
}

func (m *Manager) reserveBaseline(v *Mount) (*baselineSnapshot, error) {
	info, err := os.Stat(v.Dest)
	if err != nil {
		return nil, err
	}
	size := info.Size()
	m.mu.Lock()
	if err := m.baselineCtx.Err(); err != nil {
		m.mu.Unlock()
		return nil, err
	}
	if size <= 0 || size > m.BaselineDiskMax-m.baselineBytes {
		m.mu.Unlock()
		return nil, fmt.Errorf("baseline disk cap: need %d bytes, limit %d", size, m.BaselineDiskMax)
	}
	m.baselineBytes += size
	m.baselineWork.Add(1)
	m.mu.Unlock()
	snap := &baselineSnapshot{size: size, tree: v.Tree}
	snap.dir, err = os.MkdirTemp(m.baselineDir(), v.JobID+"-")
	if err != nil {
		m.discardBaseline(snap)
		return nil, err
	}
	return snap, nil
}

func (m *Manager) discardBaseline(snap *baselineSnapshot) {
	if snap.dir != "" {
		if err := os.Remove(snap.path()); err != nil && !errors.Is(err, os.ErrNotExist) {
			slog.Error("compute_baseline_cleanup_failed", "path", snap.path(), "error", err)
			m.baselineWork.Done()
			return
		}
		_ = os.Remove(snap.dir)
	}
	m.mu.Lock()
	m.baselineBytes -= snap.size
	m.mu.Unlock()
	m.baselineWork.Done()
}

func (s *baselineSnapshot) path() string { return filepath.Join(s.dir, "image.img") }

func (m *Manager) NeedsBaseline(id string) bool {
	v := m.lookup(id)
	if v == nil {
		return false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	id, err := m.cachedTree(v.Lineage, v.Tree)
	return v.needsBaseline && v.streams != nil && err == nil && id == ""
}

// SessionBaseline captures a snapshot and waits for the guest to thaw. Pass
// the returned function to the background only once the session is started.
func (m *Manager) SessionBaseline(ctx context.Context, id string, freeze func(context.Context) error) (func(), func()) {
	v := m.lookup(id)
	if v == nil {
		return nil, nil
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if !v.needsBaseline || v.streams == nil || v.State == "released" {
		return nil, nil
	}
	start := time.Now()
	snap, err := m.reserveBaseline(v)
	if err != nil {
		logBaseline(id, v.Tree, start, 0, err)
		return nil, nil
	}
	// The guest's syncfs reaches Firecracker, not the host file: its writes sit in this host's page cache, and the
	// reflink below would have to write them back inside the freeze. Flush them first, outside the freeze budget.
	if err = syncImage(v.Dest); err != nil {
		m.discardBaseline(snap)
		logBaseline(id, v.Tree, start, 0, fmt.Errorf("flushing workspace image: %w", err))
		return nil, nil
	}
	start = time.Now()
	ctx, cancel := context.WithTimeout(ctx, SessionBaselineTimeout)
	defer cancel()
	stop := context.AfterFunc(m.baselineCtx, cancel)
	defer stop()
	armed := make(chan struct{})
	guest := make(chan error, 1)
	go func() {
		<-armed
		guest <- freeze(ctx)
		cancel()
	}()
	phase := "connecting to guest"
	c, closeStream, err := v.streams.acceptCheckpoint(ctx, armed)
	if err == nil {
		deadline, _ := ctx.Deadline()
		c.SetDeadline(deadline)
		stop := context.AfterFunc(ctx, func() { c.Close() })
		if err = wire.Send(c, map[string]bool{"ready": true}); err == nil {
			phase = "waiting for workspace freeze"
			var header wire.Header
			if err = wire.JSON(c, &header); err == nil {
				phase = "capturing workspace snapshot"
				err = snap.capture(v, c, header)
				if err == nil {
					phase = "waiting for guest thaw"
				}
			}
		}
		stop()
		closeStream()
	}
	guestErr := <-guest
	var timeout net.Error
	if errors.Is(ctx.Err(), context.DeadlineExceeded) || errors.Is(guestErr, context.DeadlineExceeded) ||
		(errors.As(err, &timeout) && timeout.Timeout()) {
		err = fmt.Errorf("baseline timed out %s: %w", phase, context.DeadlineExceeded)
	} else {
		err = errors.Join(err, guestErr)
	}
	freezeMs := ms(start)
	if err != nil {
		m.discardBaseline(snap)
		logBaseline(id, v.Tree, start, freezeMs, err)
		return nil, nil
	}
	return func() { m.publishCapturedBaseline(v, snap, start, freezeMs) },
		func() { m.discardBaseline(snap) }
}

// The guest sends this header only while frozen. Publication syncs the
// promoted image after the guest is thawed.
func (s *baselineSnapshot) capture(v *Mount, c net.Conn, h wire.Header) error {
	if h.V != 1 || h.Kind != "baseline" || h.JobID != v.JobID || h.BaseTree != v.Tree {
		return errors.New("baseline header mismatch")
	}
	if err := cloneImage(v.Dest, s.path(), false); err != nil {
		return err
	}
	return wire.Send(c, map[string]bool{"ack": true})
}

func (m *Manager) publishCapturedBaseline(v *Mount, snap *baselineSnapshot, start time.Time, freezeMs float64) {
	defer m.discardBaseline(snap)
	ctx := m.baselineCtx
	select {
	case m.baselineSlot <- struct{}{}:
		defer func() { <-m.baselineSlot }()
	case <-ctx.Done():
		logBaseline(v.JobID, snap.tree, start, freezeMs, ctx.Err())
		return
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	err := m.publishBaseline(ctx, v, snap)
	logBaseline(v.JobID, snap.tree, start, freezeMs, err)
}

func logBaseline(id, tree string, start time.Time, freezeMs float64, err error) {
	slog.Info("compute_baseline", "vm", id, "tree", tree, "freezeMs", freezeMs, "ms", ms(start), "error", err)
}

func (m *Manager) publishBaseline(ctx context.Context, v *Mount, snap *baselineSnapshot) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	id, err := m.cachedTree(v.Lineage, snap.tree)
	if err != nil {
		return err
	}
	if id == "" {
		if err := syncImage(snap.path()); err != nil {
			return err
		}
		id = root.Hash([]byte("baseline\x00" + snap.dir))
		m.protect(snap.dir, id)
		defer m.unprotect(snap.dir)
		if err := os.Rename(snap.path(), m.image(id)); err != nil {
			return err
		}
		if err := m.Refs.RecordTree(v.Lineage, snap.tree, id); err != nil {
			return err
		}
	}
	if v.State != "released" && v.Tree == snap.tree && v.needsBaseline {
		v.BaseTree, v.CachedImage, v.Promoted, v.needsBaseline = snap.tree, id, true, false
		return m.save(v)
	}
	return nil
}

// A stopped daemon may leave an unpublished baseline. It is safe to discard
// because a fresh mount can always apply the branch's tree.
func (m *Manager) recoverBaselines() error {
	dir := m.baselineDir()
	if err := os.RemoveAll(dir); err != nil {
		return err
	}
	return os.MkdirAll(dir, 0700)
}

func syncImage(path string) error {
	f, err := os.OpenFile(path, os.O_RDWR, 0)
	if err != nil {
		return err
	}
	err = f.Sync()
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}
