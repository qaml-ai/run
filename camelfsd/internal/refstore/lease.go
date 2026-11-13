package refstore

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
)

type Lease struct {
	Epoch, Deadline int64
}

func validateTTL(ttlMs int64) error {
	if ttlMs < 1000 || ttlMs > 600000 {
		return failure("bad_ttl", 400)
	}
	return nil
}

func (s *Store) Acquire(ctx context.Context, lineage, name, holder string, ttlMs int64) (Lease, error) {
	if err := validate(lineage, name); err != nil {
		return Lease{}, err
	}
	if err := validateTTL(ttlMs); err != nil {
		return Lease{}, err
	}
	if holder == "" {
		return Lease{}, failure("invalid", 400)
	}
	for {
		r, err := s.read(ctx, lineage, name)
		if err != nil {
			return Lease{}, err
		}
		now := s.now().UnixMilli()
		if !r.live(now) {
			return Lease{}, failure("no_ref", 404)
		}
		lease := Lease{Epoch: r.LeaseEpoch, Deadline: now + ttlMs}
		values := attributes{":current": str(r.Version), ":now": num(now), ":holder": str(holder), ":deadline": num(lease.Deadline), ":epoch": num(r.LeaseEpoch)}
		condition := "#version = :current AND "
		update := "SET #leaseDeadline = :deadline"
		if r.held(now) {
			if *r.Holder != holder {
				return Lease{}, failure("held", 409)
			}
			condition += heldBy
		} else {
			condition += live + " AND " + unheld + " AND #leaseEpoch = :epoch"
			lease.Epoch++
			values[":next"] = num(lease.Epoch)
			update += ", #holder = :holder, #leaseEpoch = :next"
		}
		_, err = s.update(ctx, lineage, name, condition, update, values, types.ReturnValueNone)
		if !ddb.IsConditionFailed(err) {
			return lease, err
		}
		if err := ctx.Err(); err != nil {
			return Lease{}, err
		}
	}
}

func (s *Store) Renew(ctx context.Context, lineage, name string, fence Fence, ttlMs int64) (Lease, error) {
	if err := validateTTL(ttlMs); err != nil {
		return Lease{}, err
	}
	now := s.now().UnixMilli()
	lease := Lease{Epoch: fence.Epoch, Deadline: now + ttlMs}
	err := s.fencedUpdate(ctx, lineage, name, fence, now, "SET #leaseDeadline = :deadline", attributes{":deadline": num(lease.Deadline)})
	return lease, err
}

func (s *Store) Release(ctx context.Context, lineage, name string, fence Fence) error {
	return s.fencedUpdate(ctx, lineage, name, fence, s.now().UnixMilli(), "REMOVE #holder, #leaseDeadline", attributes{})
}

func (s *Store) fencedUpdate(ctx context.Context, lineage, name string, fence Fence, now int64, update string, values attributes) error {
	if err := validate(lineage, name); err != nil {
		return err
	}
	values[":holder"], values[":epoch"], values[":now"] = str(fence.Holder), num(fence.Epoch), num(now)
	_, err := s.update(ctx, lineage, name, heldBy, update, values, types.ReturnValueNone)
	if ddb.IsConditionFailed(err) {
		return failure("fenced", 409)
	}
	return err
}
