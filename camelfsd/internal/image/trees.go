package image

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"github.com/qaml-ai/run/camelfsd/internal/apierr"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
	"os"
	"path/filepath"
	"time"
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

var ErrHeld = errors.New("held")

type ForkRequest struct {
	Lineage  string `json:"lineage"`
	FromRef  string `json:"fromRef"`
	FromTree string `json:"fromTree"`
	Name     string `json:"name"`
	Owner    string `json:"owner"`
}

func (m *Manager) Fork(ctx context.Context, q ForkRequest) (map[string]string, error) {
	if q.Lineage == "" || q.Name == "" || (q.FromRef == "") == (q.FromTree == "") {
		return nil, apierr.Invalid("invalid fork")
	}
	db, ok := m.Refs.(*refs.DB)
	if !ok {
		return nil, fmt.Errorf("fork requires SQLite")
	}
	tx, e := db.DB.BeginTx(ctx, nil)
	if e != nil {
		return nil, e
	}
	defer tx.Rollback()
	var tree, rt, commit string
	if q.FromRef != "" {
		var holder sql.NullString
		var deadline int64
		e = tx.QueryRowContext(ctx, `SELECT tree,root,"commit",holder,lease_deadline FROM refs WHERE lineage=? AND name=?`, q.Lineage, q.FromRef).Scan(&tree, &rt, &commit, &holder, &deadline)
		if e != nil {
			return nil, e
		}
		if holder.String != "" && deadline > db.Now().UnixMilli() {
			return nil, ErrHeld
		}
	} else {
		tree = q.FromTree
		var exists int
		if e := tx.QueryRowContext(ctx, "SELECT 1 FROM objects WHERE id=? AND kind='tree'", tree).Scan(&exists); e != nil {
			return nil, e
		}
		if !root.Hex(tree, 40) {
			return nil, apierr.Invalid("invalid tree")
		}
		e = tx.QueryRowContext(ctx, "SELECT root FROM tree_roots WHERE lineage=? AND tree=? ORDER BY created_at DESC LIMIT 1", q.Lineage, tree).Scan(&rt)
		if e != nil && !errors.Is(e, sql.ErrNoRows) {
			return nil, e
		}
	}
	_, e = tx.ExecContext(ctx, `INSERT INTO refs(lineage,name,tree,root,"commit",owner,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)`, q.Lineage, q.Name, tree, rt, commit, q.Owner, time.Now().UnixMilli(), time.Now().UnixMilli())
	if e != nil {
		return nil, e
	}
	e = tx.Commit()
	return map[string]string{"ref": q.Name, "tree": tree, "root": rt}, e
}
