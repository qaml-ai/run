package image

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// New runs before mounts are accepted, under the daemon's exclusive host lock.
// Completed images live in workspace-images; these directories are only spools.
func recoverPrebuiltImages(data string) error {
	entries, err := os.ReadDir(data)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), ".prebuilt-") {
			continue
		}
		if err := os.RemoveAll(filepath.Join(data, entry.Name())); err != nil {
			return fmt.Errorf("remove interrupted prebuilt image: %w", err)
		}
	}
	return nil
}
