package compute

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"time"
)

const CheckpointWindow = 5 * time.Minute

var ErrCheckpointInProgress = errors.New("checkpoint in progress")

// BeginCheckpoint claims the VM's checkpoint slot. The owner disambiguates a
// stale request's completion from the request that took over its slot.
func (c *Controller) BeginCheckpoint(ctx context.Context, id string) (string, error) {
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", err
	}
	owner := hex.EncodeToString(nonce[:])
	now := c.now()
	_, err := c.updateVM(ctx, id,
		"#phase = :running AND (attribute_not_exists(#checkpointing) OR #checkpointing.#at < :stale)",
		"SET #checkpointing = :marker",
		attrs{":running": s(string(Running)), ":stale": n(now.Add(-CheckpointWindow).UnixMilli()),
			":marker": m(attrs{"owner": s(owner), "at": n(now.UnixMilli())})})
	if errors.Is(err, ErrCondition) {
		v, err := c.Get(ctx, id)
		if err != nil {
			return "", err
		}
		if v.Phase != Running {
			return "", ErrPhase
		}
		return "", ErrCheckpointInProgress
	}
	return owner, err
}

// FinishCheckpoint records a successful host CAS and releases the slot in one write.
func (c *Controller) FinishCheckpoint(ctx context.Context, id, owner string, saved *Checkpoint) error {
	expr := "REMOVE #checkpointing"
	values := attrs{":owner": s(owner)}
	if saved != nil {
		expr = "SET #lastCheckpoint = :saved " + expr
		values[":saved"] = m(attrs{"version": s(saved.Version), "tree": s(saved.Tree), "at": n(saved.At)})
	}
	_, err := c.updateVM(ctx, id, "#checkpointing.#owner = :owner", expr, values)
	if saved == nil && errors.Is(err, ErrCondition) {
		return nil
	}
	return err
}
