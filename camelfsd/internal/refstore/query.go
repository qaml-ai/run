package refstore

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/store"
)

func (s *Store) List(ctx context.Context, lineage, prefix, after string, limit int) ([]Ref, string, error) {
	if !store.Lineage(lineage) || (after != "" && !ValidName(after)) || limit <= 0 {
		return nil, "", failure("invalid", 400)
	}
	limit = min(limit, 1000)
	now := s.now().UnixMilli()
	refs := make([]Ref, 0, limit)
	next := ""
	err := s.scan(ctx, lineage, prefix, after, func(r Ref) (bool, error) {
		if !r.live(now) {
			return true, nil
		}
		if len(refs) == limit {
			next = refs[len(refs)-1].Name
			return false, nil
		}
		refs = append(refs, r)
		return true, nil
	})
	if err != nil {
		return nil, "", err
	}
	return refs, next, nil
}

// scan follows DynamoDB pages even when a whole page contains expired refs.
func (s *Store) scan(ctx context.Context, lineage, prefix, after string, visit func(Ref) (bool, error)) error {
	in := &dynamodb.QueryInput{
		TableName: s.table, ConsistentRead: aws.Bool(true), Limit: aws.Int32(1000),
		ExpressionAttributeNames:  map[string]string{"#lineage": "lineage"},
		ExpressionAttributeValues: attributes{":lineage": str(lineage)},
	}
	condition := "#lineage = :lineage"
	if prefix != "" {
		condition += " AND begins_with(#name, :prefix)"
		in.ExpressionAttributeNames["#name"] = "name"
		in.ExpressionAttributeValues[":prefix"] = str(prefix)
	}
	in.KeyConditionExpression = aws.String(condition)
	if after != "" {
		in.ExclusiveStartKey = key(lineage, after)
	}
	for {
		out, err := s.client.Query(ctx, in)
		if err != nil {
			return err
		}
		for _, item := range out.Items {
			r, err := decode(item)
			if err != nil {
				return err
			}
			more, err := visit(r)
			if err != nil || !more {
				return err
			}
		}
		if len(out.LastEvaluatedKey) == 0 {
			return nil
		}
		in.ExclusiveStartKey = out.LastEvaluatedKey
	}
}

func (s *Store) Watch(ctx context.Context, lineage, name, agent string) error {
	return s.watch(ctx, lineage, name, agent, "ADD")
}

func (s *Store) Unwatch(ctx context.Context, lineage, name, agent string) error {
	return s.watch(ctx, lineage, name, agent, "DELETE")
}

func (s *Store) watch(ctx context.Context, lineage, name, agent, action string) error {
	if err := validate(lineage, name); err != nil {
		return err
	}
	if !ValidOwner(agent) {
		return failure("invalid", 400)
	}
	_, err := s.update(ctx, lineage, name, live, action+" #watchers :agents",
		attributes{":now": num(s.now().UnixMilli()), ":agents": &types.AttributeValueMemberSS{Value: []string{agent}}},
		types.ReturnValueNone)
	if ddb.IsConditionFailed(err) {
		return failure("no_ref", 404)
	}
	return err
}
