package image

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"github.com/qaml-ai/run/camelfsd/internal/store"
	"os"
	"path/filepath"
)

func blank(c Config) error {
	p := filepath.Join(c.Data, "images", fmt.Sprintf("blank-%d.img", c.VirtualSize))
	if _, e := os.Stat(p); e == nil {
		return nil
	}

	f, e := os.CreateTemp(filepath.Join(c.Data, "images"), "blank-*.tmp")
	if e != nil {
		return e
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	e = f.Truncate(c.VirtualSize)
	f.Close()
	if e != nil {
		return e
	}
	args := []string{"-q", "-F", "-E", "lazy_itable_init=1,lazy_journal_init=1", "-O", "^inline_data"}
	// mke2fs takes journal sizes in MiB, without a suffix. Tiny development
	// images need its automatic smaller journal; production blanks use 128 MiB.
	if c.VirtualSize >= 256<<20 {
		args = append(args, "-J", "size=128")
	}
	args = append(args, tmp)
	if _, e = run(context.Background(), "mkfs.ext4", args...); e != nil {
		return e
	}
	f, e = os.OpenFile(tmp, os.O_RDWR, 0)
	if e != nil {
		return e
	}
	e = f.Sync()
	f.Close()
	if e != nil {
		return e
	}
	e = os.Rename(tmp, p)
	return e
}
func (m *Manager) objects(lineages ...string) *objects.Repository {
	db, ok := m.Refs.(*refs.DB)
	if !ok {
		return nil
	}
	repo := &objects.Repository{DB: db, Store: m.Store, TempDir: m.Data}
	if len(lineages) > 0 {
		return repo.ForLineage(lineages[0])
	}
	return repo
}
func (m *Manager) mountRoot(ctx context.Context, lineage, id string) (root.Root, error) {
	if id != "" {
		return m.load(ctx, lineage, id)
	}
	return root.Root{V: 1, FSType: "ext4", VirtualSize: m.VirtualSize, Chunks: map[string]string{}}, nil
}
func (m *Manager) baseRoot(ctx context.Context, l, t string) (string, error) {
	repo := m.objects(l)
	if repo == nil {
		return "", fmt.Errorf("trees require SQLite")
	}

	for i := 0; i < 64 && t != ""; i++ {
		id, e := m.Refs.TreeRoot(l, t)
		if e == nil {
			return id, nil
		}
		if !errors.Is(e, sql.ErrNoRows) {
			return "", e
		}
		if i == 0 {
			id, e := m.sharedTreeRoot(ctx, l, t)
			if ctx.Err() != nil {
				return "", ctx.Err()
			}
			if e == nil {
				return id, nil
			}
			if !errors.Is(e, os.ErrNotExist) {
				slog.Warn("compute_tree_root_lookup_failed", "lineage", l, "tree", t, "error", e)
			}
		}
		e = repo.DB.DB.QueryRowContext(ctx, "SELECT parent FROM tree_parents WHERE tree=?", t).Scan(&t)
		if errors.Is(e, sql.ErrNoRows) {
			if _, err := repo.Entries(ctx, t); err != nil {
				return "", err
			}
			break
		}
		if e != nil {
			return "", e
		}
	}
	return "", nil
}

func (m *Manager) sharedTreeRoot(ctx context.Context, lineage, tree string) (string, error) {
	b, err := store.ForLineage(m.Store, lineage).Get(ctx, "tr/"+tree)
	if err != nil {
		return "", err
	}
	id := string(b)
	if !root.Hex(id, 64) {
		return "", fmt.Errorf("invalid shared root ID")
	}
	r, err := m.load(ctx, lineage, id)
	if err != nil {
		return "", err
	}
	if r.Tree != tree {
		return "", fmt.Errorf("shared root tree mismatch")
	}
	ok, err := m.objects(lineage).Reachable(ctx, lineage, id, "root")
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fmt.Errorf("shared root is outside lineage")
	}
	return id, m.Refs.RecordTree(lineage, tree, id)
}

func (m *Manager) shareTreeRoot(ctx context.Context, lineage, tree, id string) {
	if err := store.ForLineage(m.Store, lineage).Put(ctx, "tr/"+tree, []byte(id)); err != nil {
		slog.Warn("compute_tree_root_share_failed", "lineage", lineage, "tree", tree, "root", id, "error", err)
	}
}
