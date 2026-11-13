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
func (m *Manager) objects() *objects.Repository {
	db, ok := m.Refs.(*refs.DB)
	if !ok {
		return nil
	}
	return &objects.Repository{DB: db, Store: m.Store, TempDir: m.Data}
}
func (m *Manager) mountRoot(ctx context.Context, id string) (root.Root, error) {
	if id != "" {
		return m.load(ctx, id)
	}
	return root.Root{V: 1, FSType: "ext4", VirtualSize: m.VirtualSize, Chunks: map[string]string{}}, nil
}
func (m *Manager) baseRoot(ctx context.Context, l, t string) (string, error) {
	repo := m.objects()
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
