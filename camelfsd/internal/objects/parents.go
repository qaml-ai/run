package objects

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/qaml-ai/run/camelfsd/internal/root"
)

// Parents reads the Git commit in lineage, even when its parents are stored
// elsewhere. Each parent is resolved independently by the caller.
func (r *Repository) Parents(ctx context.Context, lineage, id string) ([]string, bool, error) {
	commit, found, err := r.CommitAncestry(ctx, lineage, id)
	return commit.Parents, found, err
}

type CommitAncestry struct {
	Tree    string
	Parents []string
}

// CommitAncestry reads the verified commit's tree and ordered parents.
func (r *Repository) CommitAncestry(ctx context.Context, lineage, id string) (CommitAncestry, bool, error) {
	raw, err := r.ForLineage(lineage).Object(ctx, id, "commit")
	if errors.Is(err, os.ErrNotExist) {
		return CommitAncestry{}, false, nil
	}
	if err != nil {
		return CommitAncestry{}, false, err
	}
	headers, _, ok := strings.Cut(string(raw), "\n\n")
	if !ok {
		return CommitAncestry{}, false, fmt.Errorf("commit %s has no header terminator", id)
	}
	var commit CommitAncestry
	for line := range strings.SplitSeq(headers, "\n") {
		if tree, ok := strings.CutPrefix(line, "tree "); ok {
			if commit.Tree != "" || !root.Hex(tree, 40) {
				return CommitAncestry{}, false, fmt.Errorf("commit %s has an invalid tree", id)
			}
			commit.Tree = tree
		}
		if parent, ok := strings.CutPrefix(line, "parent "); ok {
			if !root.Hex(parent, 40) {
				return CommitAncestry{}, false, fmt.Errorf("commit %s has an invalid parent", id)
			}
			commit.Parents = append(commit.Parents, parent)
		}
	}
	if commit.Tree == "" {
		return CommitAncestry{}, false, fmt.Errorf("commit %s has no tree", id)
	}
	return commit, true, nil
}
