package image

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refs"
	"github.com/qaml-ai/run/camelfsd/internal/root"
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

// cachedAncestor follows tree hints left by this host's checkpoints.
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

// A bounded first-parent walk covers short bursts of API writes without
// walking a repository's history during boot.
const cachedCommitHops = 4

func (m *Manager) cachedCommitAncestor(ctx context.Context, lineage, tree, version string) (string, string, error) {
	repo := m.objects(lineage)
	var hasImages bool
	err := repo.DB.DB.QueryRowContext(ctx, "SELECT EXISTS (SELECT 1 FROM tree_roots WHERE lineage=?)", lineage).Scan(&hasImages)
	if err != nil || !hasImages {
		return "", "", err
	}
	for hop := 0; hop <= cachedCommitHops; hop++ {
		commit, found, err := repo.CommitAncestry(ctx, lineage, version)
		if err != nil {
			return "", "", err
		}
		// A fork can preserve parent IDs outside the destination lineage.
		if !found {
			if hop == 0 {
				return "", "", fmt.Errorf("boot commit %s is missing", version)
			}
			break
		}
		if hop == 0 && commit.Tree != tree {
			return "", "", fmt.Errorf("boot commit %s does not name tree %s", version, tree)
		}
		if commit.Tree != tree {
			id, err := m.cachedTree(lineage, commit.Tree)
			if err != nil || id != "" {
				return commit.Tree, id, err
			}
			tree = commit.Tree
		}
		if len(commit.Parents) == 0 {
			break
		}
		version = commit.Parents[0]
	}
	return "", "", nil
}

// A newly tracked path can collide with image-only files and directories.
// The guest also removes temporary files before apply and omits that
// namespace when checkpointing.
func (m *Manager) canReuseCommitImage(ctx context.Context, lineage, base, target string) (bool, error) {
	old, err := m.entries(ctx, lineage, base)
	if err != nil {
		return false, err
	}
	const tempPrefix = ".camelfs-tmp-"
	for _, entry := range old {
		if strings.HasPrefix(entry.Path, tempPrefix) || strings.Contains(entry.Path, "/"+tempPrefix) {
			return false, nil
		}
	}
	next, err := m.entries(ctx, lineage, target)
	if err != nil {
		return false, err
	}
	i := 0
	for _, entry := range next {
		for i < len(old) && old[i].Path < entry.Path {
			i++
		}
		if i == len(old) || old[i].Path != entry.Path {
			return false, nil
		}
	}
	return true, nil
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
