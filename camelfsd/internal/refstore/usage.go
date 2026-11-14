package refstore

import (
	"context"
	"fmt"
	"math"
	"strconv"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
)

type Usage struct {
	MarkedBytes, WrittenSince int64
	MarkedAt                  *int64
}

const activeLineage = "attribute_exists(#lineage) AND attribute_not_exists(#deletion) AND attribute_not_exists(#deletedAt)"

func (s *Store) ReadUsage(ctx context.Context, lineage string) (Usage, error) {
	out, err := s.client.GetItem(ctx, &dynamodb.GetItemInput{
		TableName: s.guard, Key: attributes{"lineage": str(lineage)}, ConsistentRead: aws.Bool(true),
	})
	if err != nil {
		return Usage{}, err
	}
	if out.Item["lineage"] == nil || out.Item["deletedAt"] != nil || out.Item["deletion"] != nil {
		return Usage{}, failure("lineage_blocked", 409)
	}
	var usage Usage
	for field, target := range map[string]*int64{"markedBytes": &usage.MarkedBytes, "writtenSince": &usage.WrittenSince, "markedAt": new(int64)} {
		if out.Item[field] == nil {
			continue
		}
		value, ok := out.Item[field].(*types.AttributeValueMemberN)
		if !ok {
			return Usage{}, fmt.Errorf("invalid usage field %s", field)
		}
		n, err := strconv.ParseInt(value.Value, 10, 64)
		if err != nil || n < 0 {
			return Usage{}, fmt.Errorf("invalid usage field %s", field)
		}
		*target = n
		if field == "markedAt" {
			usage.MarkedAt = target
		}
	}
	if usage.MarkedBytes > math.MaxInt64-usage.WrittenSince {
		return Usage{}, fmt.Errorf("lineage usage overflows int64")
	}
	return usage, nil
}

func (s *Store) AddWritten(ctx context.Context, lineage string, bytes int64) error {
	if bytes < 0 {
		return failure("invalid", 400)
	}
	// ADD is not idempotent. An ambiguous response must not replay the addition.

	_, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: s.guard, Key: attributes{"lineage": str(lineage)},
		ConditionExpression:       aws.String(activeLineage),
		UpdateExpression:          aws.String("ADD #writtenSince :n"),
		ExpressionAttributeNames:  map[string]string{"#lineage": "lineage", "#deletion": "deletion", "#deletedAt": "deletedAt", "#writtenSince": "writtenSince"},
		ExpressionAttributeValues: attributes{":n": num(bytes)},
	}, func(o *dynamodb.Options) { o.Retryer = aws.NopRetryer{} })
	if ddb.IsConditionFailed(err) {
		return failure("lineage_blocked", 409)
	}
	return err
}

// ApplyMark subtracts only the snapshot, retaining additions since the scan began.
func (s *Store) ApplyMark(ctx context.Context, lineage string, markedBytes, snapshotWrittenSince int64, prevMarkedAt *int64) error {
	now := s.now().UnixMilli()
	if markedBytes < 0 || snapshotWrittenSince < 0 || (prevMarkedAt != nil && *prevMarkedAt == math.MaxInt64) {
		return failure("invalid", 400)
	}
	condition := activeLineage + " AND attribute_not_exists(#markedAt)"
	values := attributes{":m": num(markedBytes), ":s": num(snapshotWrittenSince), ":zero": num(0)}
	if prevMarkedAt != nil {
		condition = activeLineage + " AND #markedAt = :prev"
		values[":prev"] = num(*prevMarkedAt)
		now = max(now, *prevMarkedAt+1)
	}
	values[":now"] = num(now)
	if snapshotWrittenSince > 0 {
		condition += " AND #writtenSince >= :s"
	}
	_, err := s.client.UpdateItem(ctx, &dynamodb.UpdateItemInput{
		TableName: s.guard, Key: attributes{"lineage": str(lineage)},
		ConditionExpression:       aws.String(condition),
		UpdateExpression:          aws.String("SET #markedBytes = :m, #markedAt = :now, #writtenSince = if_not_exists(#writtenSince, :zero) - :s"),
		ExpressionAttributeValues: values,
		ExpressionAttributeNames:  map[string]string{"#lineage": "lineage", "#deletion": "deletion", "#deletedAt": "deletedAt", "#markedBytes": "markedBytes", "#markedAt": "markedAt", "#writtenSince": "writtenSince"},
	})
	return err
}
