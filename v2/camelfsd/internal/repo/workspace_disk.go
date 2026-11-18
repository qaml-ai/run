package repo

import (
	"context"
	"fmt"
	"sort"

	"github.com/qaml-ai/camelrun-next/camelfsd/internal/apperr"
	"github.com/qaml-ai/camelrun-next/camelfsd/internal/workdisk"
)

// UseWorkspaceDisks must be called before the engine starts accepting requests.
func (e *Engine) UseWorkspaceDisks(disks *workdisk.Disks) { e.disks = disks }

// prepareDisk updates a private block view of the parent commit. The ref CAS
// publishes the new file tree and its disk together through the new commit.
func (e *Engine) prepareDisk(ctx context.Context, lineage string, commit CommitObject) (string, error) {
	root := e.disks.Template()
	var before map[string]TreeEntry
	if len(commit.Parents) > 0 {
		parent, err := e.GetCommit(ctx, commit.Parents[0])
		if err != nil {
			return "", err
		}
		if parent.Disk != "" {
			if parent.Tree == commit.Tree {
				return parent.Disk, nil
			}
			root = parent.Disk
			before, err = e.GetTreeMap(ctx, parent.Tree)
			if err != nil {
				return "", err
			}
		}
	}
	after, err := e.GetTreeMap(ctx, commit.Tree)
	if err != nil {
		return "", err
	}
	var deletes, puts []string
	for path := range before {
		if _, exists := after[path]; !exists {
			deletes = append(deletes, path)
		}
	}
	for path, entry := range after {
		old, exists := before[path]
		if !exists || old.Hash != entry.Hash || old.Mode != entry.Mode {
			puts = append(puts, path)
		}
	}
	sort.Strings(deletes)
	sort.Strings(puts)

	edits := make([]workdisk.Edit, 0, len(deletes)+len(puts))
	for _, path := range deletes {
		edits = append(edits, workdisk.Edit{Path: path, Delete: true})
	}
	for _, path := range puts {
		ent := after[path]
		if ent.Type != "file" {
			return "", apperr.InvalidRequest(fmt.Sprintf("unsupported workspace entry %q", path))
		}
		data, err := e.GetBlob(ctx, ent.Hash)
		if err != nil {
			return "", err
		}
		edits = append(edits, workdisk.Edit{Path: path, Mode: ent.Mode, Data: data})
	}
	disk, err := e.disks.Apply(ctx, lineage, root, edits)
	if err != nil {
		return "", apperr.Internal("prepare ext4 workspace", err)
	}
	return disk, nil
}
