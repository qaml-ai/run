package image

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"path/filepath"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/chunk"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"github.com/qaml-ai/run/camelfsd/internal/wire"
)

const baselineIntent = "baseline.json"

type baselineRecord struct {
	Tree, Root string
}

func (m *Manager) CancelBaseline(id string) {
	if v := m.lookup(id); v != nil && v.baselineCancel != nil {
		v.baselineCancel()
	}
}

func (m *Manager) NeedsBaseline(id string) bool {
	v := m.lookup(id)
	if v == nil {
		return false
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	_, err := m.Refs.TreeRoot(v.Lineage, v.Tree)
	return v.Session && v.streams != nil && errors.Is(err, sql.ErrNoRows)
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
	if !v.needsBaseline || v.streams == nil || v.baselineCtx.Err() != nil {
		return nil, nil
	}
	start := time.Now()
	ctx, cancel := context.WithTimeout(ctx, time.Second)
	defer cancel()
	stop := context.AfterFunc(v.baselineCtx, cancel)
	defer stop()
	armed := make(chan struct{})
	guest := make(chan error, 1)
	go func() {
		<-armed
		guest <- freeze(ctx)
		cancel()
	}()
	c, closeStream, err := v.streams.acceptCheckpoint(ctx, armed)
	var snap string
	if err == nil {
		deadline, _ := ctx.Deadline()
		c.SetDeadline(deadline)
		stop := context.AfterFunc(ctx, func() { c.Close() })
		if err = wire.Send(c, map[string]bool{"ready": true}); err == nil {
			var header wire.Header
			if err = wire.JSON(c, &header); err == nil {
				snap, err = captureBaseline(v, c, header)
			}
		}
		stop()
		closeStream()
	}
	err = errors.Join(err, <-guest)
	freezeMs := ms(start)
	if err != nil {
		if snap != "" {
			os.Remove(snap)
		}
		logBaseline(id, v.Tree, start, freezeMs, Checkpoint{}, err)
		return nil, nil
	}
	base, tree := v.Root, v.Tree
	m.mu.Lock()
	select {
	case <-m.stop:
		m.mu.Unlock()
		os.Remove(snap)
		return nil, nil
	default:
		m.baselineWork.Add(1)
	}
	m.mu.Unlock()
	discard := func() {
		os.Remove(snap)
		m.baselineWork.Done()
	}
	return func() {
		defer discard()
		ctx, cancel := context.WithTimeout(v.baselineCtx, m.ApplyMax)
		defer cancel()
		select {
		case m.baselineSlot <- struct{}{}:
			defer func() { <-m.baselineSlot }()
		case <-ctx.Done():
			logBaseline(id, tree, start, freezeMs, Checkpoint{}, ctx.Err())
			return
		}
		v.mu.Lock()
		defer v.mu.Unlock()
		if v.Tree == tree && v.Root == base {
			m.runBaseline(ctx, v, snap, start, freezeMs)
		}
	}, discard
}

// The guest sends this header only while frozen. Defer fsync until after the
// ack. Publication will sync the promoted image before recording its row.
func captureBaseline(v *Mount, c net.Conn, h wire.Header) (string, error) {
	if h.V != 1 || h.Kind != "baseline" || h.JobID != v.JobID || h.BaseTree != v.Tree {
		return "", errors.New("baseline header mismatch")
	}
	snap := filepath.Join(filepath.Dir(v.Dest), fmt.Sprintf("baseline-%d.img", v.Snapshot))
	v.Snapshot++
	if err := cloneImage(v.Dest, snap, false); err != nil {
		return "", err
	}
	if err := wire.Send(c, map[string]bool{"ack": true}); err != nil {
		os.Remove(snap)
		return "", err
	}
	return snap, nil
}

func (m *Manager) runBaseline(ctx context.Context, v *Mount, snap string, start time.Time, freezeMs float64) {
	var point Checkpoint
	err := m.publishBaseline(ctx, v, snap, &point)
	logBaseline(v.JobID, v.Tree, start, freezeMs, point, err)
}

func logBaseline(id, tree string, start time.Time, freezeMs float64, point Checkpoint, err error) {
	slog.Info("compute_baseline", "vm", id, "tree", tree, "freezeMs", freezeMs, "hashMs", point.HashMs,
		"uploadMs", point.UploadMs, "chunks", point.ChangedChunks, "ms", ms(start), "error", err)
}

func (m *Manager) publishBaseline(ctx context.Context, v *Mount, snap string, point *Checkpoint) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	base, err := m.mountRoot(ctx, v.Lineage, v.Root)
	if err != nil {
		return err
	}
	r, err := m.uploadSnapshot(ctx, v, base, snap, v.Tree, []chunk.Range{{Length: base.VirtualSize}}, point)
	if err != nil {
		return err
	}
	if err := m.objects(v.Lineage).Record(ctx, v.Lineage, point.Root, "root", nil); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}

	// A restart after promotion can finish the local row without trusting
	// the live disk or a snapshot captured before promotion.
	intent := filepath.Join(filepath.Dir(v.Dest), baselineIntent)
	raw, err := json.Marshal(baselineRecord{v.Tree, point.Root})
	if err != nil {
		return err
	}
	if err := store.Atomic(intent, raw); err != nil {
		return err
	}
	m.protect(v.JobID, r, point.Root)
	if err := m.promote(snap, point.Root); err != nil {
		os.Remove(intent)
		return err
	}
	if err := m.Refs.RecordTree(v.Lineage, v.Tree, point.Root); err != nil {
		return err
	}
	v.Root, v.Parent.Root, v.Promoted, v.needsBaseline = point.Root, point.Root, true, false
	err = m.save(v)
	m.shareTreeRoot(ctx, v.Lineage, v.Tree, point.Root)
	return errors.Join(os.Remove(intent), err)
}

func (m *Manager) recoverBaseline(v *Mount, share bool) error {
	dir := filepath.Dir(v.Dest)
	intent := filepath.Join(dir, baselineIntent)
	raw, err := os.ReadFile(intent)
	if err == nil {
		var record baselineRecord
		if err := json.Unmarshal(raw, &record); err != nil {
			return err
		}
		if !root.Hex(record.Root, 64) || !root.Hex(record.Tree, 40) {
			return fmt.Errorf("invalid baseline intent for %s", v.JobID)
		}
		if _, err := os.Stat(m.image(record.Root)); err == nil {
			db := m.objects(v.Lineage).DB.DB
			_, err := db.Exec(`INSERT INTO tree_roots SELECT ?,?,?,? WHERE NOT EXISTS
				(SELECT 1 FROM tree_roots WHERE lineage=? AND tree=? AND root=?)`,
				v.Lineage, record.Tree, record.Root, m.Now().UnixNano(), v.Lineage, record.Tree, record.Root)
			if err != nil {
				return err
			}
			if share {
				ctx, cancel := context.WithTimeout(context.Background(), time.Second)
				m.shareTreeRoot(ctx, v.Lineage, record.Tree, record.Root)
				cancel()
			}
		} else if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := os.Remove(intent); err != nil {
			return err
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	return nil
}
