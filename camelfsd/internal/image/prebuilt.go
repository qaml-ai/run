package image

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// preparePrebuiltImage leaves the immutable image pinned until Mount finishes
// cloning it. Only an absent descriptor starts a producer.
func (m *Manager) preparePrebuiltImage(ctx context.Context, q Request) (id string, err error) {
	start := time.Now()
	mode := "lookup"
	var buildMS, publishMS, transferMS float64
	defer func() {
		slog.Info("compute_prebuilt_image", "vm", q.JobID, "lineage", q.Lineage, "tree", q.Tree,
			"mode", mode, "image", id, "buildMs", buildMS, "publishMs", publishMS,
			"transferMs", transferMS, "ms", ms(start), "error", err)
	}()
	descriptor, found, err := store.GetWorkspaceImage(ctx, m.Store, q.Lineage, q.Tree, m.VirtualSize)
	if err != nil {
		return "", fmt.Errorf("lookup prebuilt workspace: %w", err)
	}
	dir, err := os.MkdirTemp(m.Data, ".prebuilt-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(dir)
	var imagePath string
	if !found {
		mode = "build"
		buildStart := time.Now()
		built, err := m.buildPrebuiltImage(ctx, q, dir)
		if err != nil {
			return "", fmt.Errorf("build prebuilt workspace: %w", err)
		}
		buildMS = ms(buildStart)
		file, err := os.Open(built.compressed)
		if err != nil {
			return "", err
		}
		publishStart := time.Now()
		descriptor, err = store.PublishWorkspaceImage(ctx, m.Store, built.descriptor, file)
		closeErr := file.Close()
		if err != nil {
			return "", fmt.Errorf("publish prebuilt workspace: %w", err)
		}
		if closeErr != nil {
			return "", closeErr
		}
		publishMS = ms(publishStart)
		if descriptor == built.descriptor {
			imagePath = built.image
		}
	} else {
		mode = "remote"
	}
	// Concurrent producers may publish different ext4 UUIDs for the same tree.
	// If another producer won, verify and use the advertised artifact.
	if imagePath == "" {
		transferStart := time.Now()
		imagePath, err = m.fetchPrebuiltImage(ctx, descriptor, dir)
		if err != nil {
			return "", fmt.Errorf("restore prebuilt workspace: %w", err)
		}
		transferMS = ms(transferStart)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	id = descriptor.ImageSHA256
	m.protect(q.JobID, id)
	if err := syncImage(imagePath); err != nil {
		return "", err
	}
	if err := os.Rename(imagePath, m.image(id)); err != nil {
		return "", err
	}
	if err := store.SyncDir(filepath.Dir(m.image(id))); err != nil {
		return "", err
	}
	if err := m.Refs.RecordTree(q.Lineage, q.Tree, id); err != nil {
		return "", err
	}
	return id, nil
}
