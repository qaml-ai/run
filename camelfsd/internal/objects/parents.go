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
	raw, err := r.ForLineage(lineage).Object(ctx, id, "commit")
	if errors.Is(err, os.ErrNotExist) {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}
	headers, _, ok := strings.Cut(string(raw), "\n\n")
	if !ok {
		return nil, false, fmt.Errorf("commit %s has no header terminator", id)
	}
	var parents []string
	for line := range strings.SplitSeq(headers, "\n") {
		if parent, ok := strings.CutPrefix(line, "parent "); ok {
			if !root.Hex(parent, 40) {
				return nil, false, fmt.Errorf("commit %s has an invalid parent", id)
			}
			parents = append(parents, parent)
		}
	}
	return parents, true, nil
}
