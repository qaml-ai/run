package image

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/qaml-ai/run/camelfsd/internal/hostwire"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
)

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
			JobID, Lineage, Root, Tree, Dest, Image, State, DM string
			Fence                                              *refs.Fence
			Parent                                             refs.Value
			Snapshot                                           int
			Promoted, Warm                                     bool
		}
		if err := json.Unmarshal(raw, &state); err != nil {
			return err
		}
		v := Mount{
			Request: Request{JobID: state.JobID, Lineage: state.Lineage, Root: state.Root, Tree: state.Tree, Fence: state.Fence, Session: true},
			Dest:    state.Dest, Image: state.Image, State: state.State, DM: state.DM, Parent: state.Parent,
			Snapshot: state.Snapshot, Promoted: state.Promoted, Warm: state.Warm, mu: new(sync.Mutex),
		}
		if v.JobID != id || v.Dest != filepath.Join(dir, "image.img") || v.Image != v.Dest || v.DM != "" {
			return fmt.Errorf("invalid session mount %s", id)
		}
		r, err := m.mountRoot(context.Background(), v.Lineage, v.Root)
		if err != nil {
			return err
		}
		m.protect(id, r, v.Root)
		files, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, file := range files {
			if strings.HasPrefix(file.Name(), "snap-") && strings.HasSuffix(file.Name(), ".img") {
				number, _ := strconv.Atoi(strings.TrimSuffix(strings.TrimPrefix(file.Name(), "snap-"), ".img"))
				v.Snapshot = max(v.Snapshot, number)
			}
		}
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
	if !v.Session {
		return errors.New("expected a session mount")
	}
	if v.streams != nil {
		v.streams.close()
	}
	v.Vsock = path
	r, err := m.mountRoot(ctx, v.Lineage, v.Root)
	if err != nil {
		return err
	}
	return m.listenStreams(ctx, v, r.Tree, apply, uid)
}

func (m *Manager) SessionCheckpoint(ctx context.Context, id string, q CheckpointRequest, publish func(context.Context, Checkpoint) error) (Checkpoint, error) {
	return m.streamCheckpoint(ctx, id, 0, publish, q)
}

// AdoptCheckpoint installs an already-published checkpoint after an
// interrupted CAS. The snapshot and root were published before the CAS.
func (m *Manager) AdoptCheckpoint(ctx context.Context, id, commit, tree, root string) error {
	v := m.lookup(id)
	if v == nil {
		return os.ErrNotExist
	}
	v.mu.Lock()
	defer v.mu.Unlock()
	r, err := m.mountRoot(ctx, v.Lineage, root)
	if err != nil {
		return err
	}
	m.protect(id, r, root)
	v.Parent.Commit, v.Parent.Tree, v.Parent.Root = commit, tree, root
	v.Tree, v.Root, v.Promoted = tree, root, true
	return m.save(v)
}
