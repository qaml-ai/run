package image

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sync"

	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
)

const checkpointSnapshot = "checkpoint.img"

func (m *Manager) recoverSessions(entries []fs.DirEntry) error {
	for _, entry := range entries {
		id := entry.Name()
		dir := filepath.Join(m.Data, "mounts", id)
		if !entry.IsDir() || !hostwire.MountID.MatchString(id) {
			return fmt.Errorf("unexpected mount state: %s", id)
		}
		if _, err := os.Stat(filepath.Join(dir, "session")); err != nil {
			return fmt.Errorf("mount %s requires storage host cleanup: %w", id, err)
		}
		if err := os.Remove(filepath.Join(dir, checkpointSnapshot)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		raw, err := os.ReadFile(filepath.Join(dir, "state.json"))
		if errors.Is(err, os.ErrNotExist) {
			// No mount was handed to Firecracker before the state was saved.
			if err := os.RemoveAll(dir); err != nil {
				return err
			}
			continue
		}
		if err != nil {
			return err
		}
		var state struct {
			Mount
			BaseTree *string
		}
		if err := json.Unmarshal(raw, &state); err != nil {
			return err
		}
		if state.BaseTree == nil {
			return fmt.Errorf("legacy mount %s must be drained before upgrading", id)
		}
		v := state.Mount
		v.BaseTree = *state.BaseTree
		if v.JobID != id || v.Dest != filepath.Join(dir, "image.img") || v.Image != v.Dest || !validMountFence(v.Fence) {
			return fmt.Errorf("invalid session mount %s", id)
		}
		v.mu = new(sync.Mutex)
		v.needsBaseline = v.BaseTree != v.Tree
		m.mounts[id] = &v
	}
	return nil
}

// SessionStreams binds the guest's checkpoint socket and, on first boot, its apply socket.
func (m *Manager) SessionStreams(ctx context.Context, id, path string, uid int, apply bool) error {
	v := m.lookup(id)
	if v == nil {
		return os.ErrNotExist
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	if v.streams != nil {
		v.streams.close()
	}
	info, err := os.Stat(v.Dest)
	if err != nil {
		return err
	}
	return m.listenStreams(ctx, v, path, v.BaseTree, info.Size(), apply, uid)
}

// AdoptCheckpoint resumes a checkpoint whose fenced CAS already succeeded.
func (m *Manager) AdoptCheckpoint(id, commit, tree string) error {
	v := m.lookup(id)
	if v == nil {
		return os.ErrNotExist
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	return m.adoptCheckpoint(v, commit, tree)
}

func (m *Manager) adoptCheckpoint(v *Mount, commit, tree string) error {
	v.CachedImage, v.Promoted = "", false
	imageID := checkpointImage(v.Lineage, commit)
	if _, err := os.Stat(m.image(imageID)); err == nil {
		if err := m.Refs.RecordTree(v.Lineage, tree, imageID); err != nil {
			slog.Warn("checkpoint_image_index_failed", "job", v.JobID, "error", err)
		} else {
			v.CachedImage, v.Promoted = imageID, true
		}
	}
	v.Parent.Commit, v.Parent.Tree = commit, tree
	v.Tree, v.BaseTree = tree, tree
	v.needsBaseline = false
	return m.save(v)
}
