package image

import (
	"context"
	"database/sql"
	"errors"
	"fmt"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"os"
	"path/filepath"
)

func imageDir(data string) string { return filepath.Join(data, "workspace-images") }

func blankImage(data string, size int64) string {
	return filepath.Join(imageDir(data), fmt.Sprintf("blank-%d.img", size))
}

func blank(c Config) error {
	p := blankImage(c.Data, c.VirtualSize)
	if _, e := os.Stat(p); e == nil {
		return nil
	}

	f, e := os.CreateTemp(imageDir(c.Data), "blank-*.tmp")
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

// cachedAncestor finds a compatible image on this host. An evicted image
// and a ref written on a different host both fall back to the Git tree.
func (m *Manager) cachedAncestor(ctx context.Context, lineage, tree string) (string, string, error) {
	repo := m.objects(lineage)
	if repo == nil {
		return "", "", fmt.Errorf("trees require SQLite")
	}
	for range 64 {
		if tree == "" {
			break
		}
		id, err := m.cachedTree(lineage, tree)
		if err != nil || id != "" {
			return tree, id, err
		}
		err = repo.DB.DB.QueryRowContext(ctx, "SELECT parent FROM tree_parents WHERE tree=?", tree).Scan(&tree)
		if errors.Is(err, sql.ErrNoRows) {
			break
		}
		if err != nil {
			return "", "", err
		}
	}
	return "", "", nil
}

func (m *Manager) cachedTree(lineage, tree string) (string, error) {
	id, err := m.Refs.TreeRoot(lineage, tree)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if root.Hex(id, 64) {
		if st, err := os.Stat(m.image(id)); err == nil && st.Size() == m.VirtualSize {
			return id, nil
		}
	}
	return "", nil
}
