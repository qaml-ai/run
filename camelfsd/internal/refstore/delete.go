package refstore

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// Keep the key and leaseEpoch after deleting a ref. An old fence must never
// become valid again when the same name is recreated and acquired.
const removeRef = "REMOVE #version, #tree, #root, #owner, #expiresAt, #holder, #leaseDeadline, #watchers, #createdAt, #updatedAt"

func deleteCheck(r Ref, expect *string, now int64) error {
	if !r.live(now) {
		return failure("no_ref", 404)
	}
	if expect != nil && r.Version != *expect {
		return stale(r, now)
	}
	if r.held(now) {
		return failure("held", 409)
	}
	return nil
}

func (s *Store) Delete(ctx context.Context, lineage, name string, expect *string) error {
	if err := validate(lineage, name); err != nil {
		return err
	}
	r, err := s.read(ctx, lineage, name)
	if err != nil {
		return err
	}
	now := s.now().UnixMilli()
	if err := deleteCheck(r, expect, now); err != nil {
		return err
	}
	_, err = s.update(ctx, lineage, name, "#version = :current AND "+live+" AND "+unheld, removeRef,
		attributes{":current": str(r.Version), ":now": num(now)}, types.ReturnValueNone)
	if !ddb.IsConditionFailed(err) {
		return err
	}
	r, err = s.read(ctx, lineage, name)
	if err != nil {
		return err
	}
	now = s.now().UnixMilli()
	if err := deleteCheck(r, expect, now); err != nil {
		return err
	}
	return stale(r, now)
}

func (s *Store) DeleteOwned(ctx context.Context, lineage, owner string) (deleted, held []string, err error) {
	if !store.Lineage(lineage) || !ownerPattern.MatchString(owner) {
		return nil, nil, failure("invalid", 400)
	}
	err = s.scan(ctx, lineage, "", "", func(r Ref) (bool, error) {
		now := s.now().UnixMilli()
		if !r.live(now) || r.Owner == nil || *r.Owner != owner {
			return true, nil
		}
		if r.held(now) {
			held = append(held, r.Name)
			return true, nil
		}
		_, err := s.update(ctx, lineage, r.Name, "#owner = :owner AND #version = :current AND "+live+" AND "+unheld,
			removeRef, attributes{":owner": str(owner), ":current": str(r.Version), ":now": num(now)}, types.ReturnValueNone)
		switch {
		case err == nil:
			deleted = append(deleted, r.Name)
		case ddb.IsConditionFailed(err):
			latest, err := s.read(ctx, lineage, r.Name)
			if err != nil {
				return false, err
			}
			if latest.Owner != nil && *latest.Owner == owner && latest.held(s.now().UnixMilli()) {
				held = append(held, r.Name)
			}
		default:
			return false, err
		}
		return true, nil
	})
	return deleted, held, err
}

func (s *Store) SweepExpired(ctx context.Context, lineage string) error {
	if !store.Lineage(lineage) {
		return failure("invalid", 400)
	}
	return s.scan(ctx, lineage, "", "", func(r Ref) (bool, error) {
		now := s.now().UnixMilli()
		if r.Version == "" || r.live(now) {
			return true, nil
		}
		_, err := s.update(ctx, lineage, r.Name, "attribute_exists(#version) AND "+expired, removeRef,
			attributes{":now": num(now)}, types.ReturnValueNone)
		if ddb.IsConditionFailed(err) {
			err = nil
		}
		return err == nil, err
	})
}
