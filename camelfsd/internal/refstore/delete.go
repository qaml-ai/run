package refstore

import (
	"context"
	"errors"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"

	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

// Keep the key and leaseEpoch after deleting a ref. An old fence must never
// become valid again when the same name is recreated and acquired.
const removeRef = "REMOVE #version, #tree, #root, #owner, #expiresAt, #holder, #leaseDeadline, #watchers, #createdAt, #createdBy, #updatedAt"

func deleteCheck(r Ref, expect *string, now int64) error {
	if !r.live(now) {
		return failure("no_ref", 404)
	}
	if r.held(now) {
		return failure("held", 409)
	}
	if expect != nil && r.Version != *expect {
		return stale(r, now)
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
	_, err = s.update(ctx, existingRef, lineage, name, "#version = :current AND "+live+" AND "+unheld, removeRef,
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
	if !store.Lineage(lineage) || !ValidOwner(owner) {
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
		_, err := s.update(ctx, existingRef, lineage, r.Name, "#owner = :owner AND #version = :current AND "+live+" AND "+unheld,
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
		_, err := s.update(ctx, existingRef, lineage, r.Name, "attribute_exists(#version) AND "+expired, removeRef,
			attributes{":now": num(now)}, types.ReturnValueNone)
		if ddb.IsConditionFailed(err) {
			err = nil
		}
		return err == nil, err
	})
}

// Held lists all currently held refs, including refs whose own expiry has passed.
func (s *Store) Held(ctx context.Context, lineage string) ([]string, error) {
	now := s.now().UnixMilli()
	var held []string
	err := s.scan(ctx, lineage, "", "", func(r Ref) (bool, error) {
		if r.held(now) {
			held = append(held, r.Name)
		}
		return true, nil
	})
	return held, err
}

// PendingDeletion accepts an undecided deletion, including a legacy clear
// whose refs still need to be stamped and checked for leases.
const PendingDeletion = "(attribute_not_exists(#clearing) OR attribute_type(#clearing, :boolType))"

// StampDeleting holds each ref against ordinary writes. The lineage check
// prevents a delayed sweeper from stamping after rollback or over a newer id.
func (s *Store) StampDeleting(ctx context.Context, lineage, id string) error {
	return s.scanItems(ctx, lineage, "", "", func(item attributes) (bool, error) {
		if item["version"] == nil {
			return true, nil
		}
		name := item["name"].(*types.AttributeValueMemberS).Value
		_, err := s.client.(transactionClient).TransactWriteItems(ctx, &dynamodb.TransactWriteItemsInput{
			TransactItems: []types.TransactWriteItem{
				{ConditionCheck: &types.ConditionCheck{
					TableName: s.guard, Key: attributes{"lineage": str(lineage)},
					ConditionExpression:       aws.String("#deletion = :id AND " + PendingDeletion),
					ExpressionAttributeNames:  map[string]string{"#deletion": "deletion", "#clearing": "clearing"},
					ExpressionAttributeValues: attributes{":id": str(id), ":boolType": str("BOOL")},
				}},
				{Update: &types.Update{
					TableName: s.table, Key: key(lineage, name),
					ConditionExpression:       aws.String("attribute_exists(#version)"),
					UpdateExpression:          aws.String("SET #deleting = :id"),
					ExpressionAttributeNames:  map[string]string{"#version": "version", "#deleting": "deleting"},
					ExpressionAttributeValues: attributes{":id": str(id)},
				}},
			},
		})
		var canceled *types.TransactionCanceledException
		if errors.As(err, &canceled) && len(canceled.CancellationReasons) == 2 &&
			aws.ToString(canceled.CancellationReasons[0].Code) == "None" &&
			aws.ToString(canceled.CancellationReasons[1].Code) == "ConditionalCheckFailed" {
			return true, nil // The ref was removed after the query.
		}
		return err == nil, err
	})
}

func (s *Store) removeStamp(ctx context.Context, lineage, name, id string) error {
	return s.changeStampedRef(ctx, lineage, name, id, "REMOVE #deleting")
}

// UnstampDeleting removes only the stamps belonging to this deletion.
func (s *Store) UnstampDeleting(ctx context.Context, lineage, id string) error {
	return s.scanItems(ctx, lineage, "", "", func(item attributes) (bool, error) {
		if stamp, ok := item["deleting"].(*types.AttributeValueMemberS); !ok || stamp.Value != id {
			return true, nil
		}
		err := s.removeStamp(ctx, lineage, item["name"].(*types.AttributeValueMemberS).Value, id)
		return err == nil, err
	})
}

// ClearDeleting runs after all live refs are stamped and the held check passes.
func (s *Store) ClearDeleting(ctx context.Context, lineage, id string) error {
	return s.scanItems(ctx, lineage, "", "", func(item attributes) (bool, error) {
		if item["version"] == nil {
			return true, nil
		}
		err := s.changeStampedRef(ctx, lineage, item["name"].(*types.AttributeValueMemberS).Value, id, removeRef)
		return err == nil, err
	})
}

func (s *Store) changeStampedRef(ctx context.Context, lineage, name, id, update string) error {
	names := map[string]string{"#deleting": "deleting"}
	for _, alias := range attributeAlias.FindAllString(update, -1) {
		names[alias] = alias[1:]
	}
	_, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: s.table, Key: key(lineage, name),
		ConditionExpression:       aws.String("#deleting = :id"),
		UpdateExpression:          aws.String(update),
		ExpressionAttributeNames:  names,
		ExpressionAttributeValues: attributes{":id": str(id)},
	})
	if ddb.IsConditionFailed(err) {
		return nil
	}
	return err
}
