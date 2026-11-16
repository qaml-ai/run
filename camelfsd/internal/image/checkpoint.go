package image

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"time"

	"github.com/qaml-ai/run/camelfsd/internal/root"
)

type Checkpoint struct {
	Timings       map[string]float64 `json:"timings"`
	FilesChanged  int                `json:"filesChanged"`
	BytesReceived int64              `json:"bytesReceived"`
	WalkMs        float64            `json:"walkMs"`
	StreamMs      float64            `json:"streamMs"`
	FreezeMs      float64            `json:"freezeMs"`
	CommitMs      float64            `json:"-"`
	PublishMs     float64            `json:"publishMs"`
	Commit        string             `json:"commit"`
	Tree          string             `json:"tree"`
	ImageMs       float64            `json:"imageMs"`
	WallMs        float64            `json:"wallMs"`
	CheckpointMs  float64            `json:"checkpointMs"`
}

// Checkpoint image IDs can be recovered from the existing durable checkpoint intent.
func checkpointImage(lineage, commit string) string {
	return root.Hash([]byte("checkpoint\x00" + lineage + "\x00" + commit))
}

func (m *Manager) publishCheckpoint(ctx context.Context, v *Mount, tree, snapshot string, q CheckpointRequest, publish func(context.Context, Checkpoint) error) (out Checkpoint, err error) {
	start := time.Now()
	out.Tree = tree
	out.Commit, err = m.writeCommit(ctx, v, tree, q)
	if err != nil {
		return out, err
	}
	out.CommitMs = ms(start)
	imageStart := time.Now()
	imageID := checkpointImage(v.Lineage, out.Commit)
	if snapshot != "" {
		m.protect(v.JobID, imageID)
		defer m.unprotect(v.JobID)
		if err := os.Link(snapshot, m.image(imageID)); err != nil && !errors.Is(err, os.ErrExist) {
			slog.Warn("checkpoint_image_cache_failed", "job", v.JobID, "error", err)
		}
	}
	out.ImageMs = ms(imageStart)
	if err = ctx.Err(); err != nil {
		return out, err
	}
	if err = publish(ctx, out); err != nil {
		return out, err
	}
	return out, m.adoptCheckpoint(v, out.Commit, tree)
}

func (v Checkpoint) timingFields() map[string]float64 {
	return map[string]float64{"walkMs": v.WalkMs, "streamMs": v.StreamMs, "freezeMs": v.FreezeMs, "imageMs": v.ImageMs, "wallMs": v.WallMs, "publishMs": v.PublishMs}
}
