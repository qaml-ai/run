package refstore

import (
	"context"
	"errors"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
)

type Fence struct {
	Holder string
	Epoch  int64
}

type Move struct {
	Kind, Version, Tree, Root string
	Parents                   []string
	Owner                     *string
	ExpiresAt                 *int64
	Expect                    *string
	ExpectAbsent              bool
	RequireExisting           bool
	// Prepare computes the response after validation but before the conditional write.
	Prepare func(previous Ref) error
	Fence   *Fence
}

type Result struct {
	Version  string
	Previous *string
	Watchers []string
	NoOp     bool
}

var casConflict = errors.New("ref changed during CAS")

func (s *Store) Cas(ctx context.Context, lineage, name string, m Move) (Result, error) {
	if err := validate(lineage, name); err != nil {
		return Result{}, err
	}
	if m.Kind != "commit" && m.Kind != "move" {
		return Result{}, failure("invalid", 400)
	}
	if err := validateTarget(m.Version, m.Tree, m.Root, m.Owner); err != nil {
		return Result{}, err
	}
	for range 2 {
		r, err := s.read(ctx, lineage, name)
		if err != nil {
			return Result{}, err
		}
		result, err := s.cas(ctx, lineage, name, r, m, s.now().UnixMilli())
		if err != casConflict {
			return result, err
		}
	}
	r, err := s.read(ctx, lineage, name)
	if err != nil {
		return Result{}, err
	}
	return Result{}, stale(r, s.now().UnixMilli())
}

func (s *Store) cas(ctx context.Context, lineage, name string, r Ref, m Move, now int64) (Result, error) {
	prev := current(r, now)
	if prev == nil && m.RequireExisting {
		return Result{}, failure("no_ref", 404)
	}
	if (m.Expect != nil && (prev == nil || *prev != *m.Expect)) || (m.ExpectAbsent && prev != nil) {
		return Result{}, stale(r, now)
	}
	isHeld := r.held(now)
	if isHeld {
		if m.Fence == nil || m.Fence.Holder != *r.Holder || m.Fence.Epoch != r.LeaseEpoch {
			return Result{}, failure("fenced", 409)
		}
	} else if m.Fence != nil {
		return Result{}, failure("fenced", 409)
	}
	result := Result{Version: m.Version, Previous: prev}
	if prev != nil && *prev == m.Version {
		if m.Prepare != nil {
			if err := m.Prepare(r); err != nil {
				return Result{}, err
			}
		}
		result.NoOp = true
		result.Watchers = r.Watchers
		return result, nil
	}
	if prev != nil {
		if m.Kind == "commit" {
			if len(m.Parents) < 1 || len(m.Parents) > 2 || m.Parents[0] != *prev {
				return Result{}, &Error{Code: "bad_parent", Status: 409, Details: map[string]any{
					"current": *prev, "parents": append([]string{}, m.Parents...),
				}}
			}
		} else if err := s.fastForward(ctx, lineage, *prev, m.Version); err != nil {
			return Result{}, err
		}
	}
	if m.Prepare != nil {
		if err := m.Prepare(r); err != nil {
			return Result{}, err
		}
	}
	// Recheck deadlines at the write, including after a long ancestry walk.
	now = s.now().UnixMilli()
	update, values := targetUpdate(Target{m.Version, m.Tree, m.Root}, m.Owner, m.ExpiresAt, now, prev == nil)
	condition := absent
	if prev != nil {
		values[":current"] = str(*prev)
		condition = "#version = :current AND "
		if isHeld {
			condition += heldBy
			values[":holder"], values[":epoch"] = str(*r.Holder), num(r.LeaseEpoch)
		} else {
			condition += live + " AND " + unheld
		}
	}
	old, err := s.update(ctx, lineage, name, condition, update, values, types.ReturnValueAllOld)
	if ddb.IsConditionFailed(err) {
		return Result{}, casConflict
	}
	if err != nil {
		return Result{}, err
	}
	if prev != nil {
		result.Watchers = r.Watchers
		if watchers, ok := old.Attributes["watchers"].(*types.AttributeValueMemberSS); ok {
			result.Watchers = watchers.Value
		}
	}
	return result, nil
}

const ancestryLimit = 50_000

func (s *Store) fastForward(ctx context.Context, lineage, current, target string) error {
	if s.commits == nil {
		return failure("invalid", 400)
	}
	details := map[string]any{"current": current}
	queue := []string{target}
	seen := map[string]bool{target: true}
	for i := 0; i < len(queue); i++ {
		if err := ctx.Err(); err != nil {
			return err
		}
		if i == ancestryLimit {
			details["reason"] = "too_deep"
			break
		}
		id := queue[i]
		if id == current {
			return nil
		}
		parents, found, err := s.commits.Parents(ctx, lineage, id)
		if err != nil {
			return err
		}
		if !found {
			if i == 0 {
				return failure("unknown_commit", 400)
			}
			continue
		}
		for _, parent := range parents {
			if !seen[parent] {
				queue = append(queue, parent)
				seen[parent] = true
			}
		}
	}
	return &Error{Code: "not_fast_forward", Status: 409, Details: details}
}
