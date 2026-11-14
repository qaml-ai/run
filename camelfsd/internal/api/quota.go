package api

import (
	"context"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
)

type quotaRequest struct {
	LimitBytes *int64
	OtherBytes *int64
}

func (q *quotaRequest) validate() error {
	if q != nil && (q.LimitBytes == nil || q.OtherBytes == nil || *q.LimitBytes < 0 || *q.OtherBytes < 0) {
		return invalid("quota: limitBytes and otherBytes must be nonnegative integers")
	}
	return nil
}

func (s *StorageServer) countUpload(ctx context.Context, lineage string, blob objects.Blob) error {
	if s.refs == nil || blob.Existing || blob.Size == 0 {
		return nil
	}
	// Uncommitted uploads count until a mark. Re-referencing an unswept
	// blob adds nothing until the next mark because no object was created.
	return s.refs.AddWritten(ctx, lineage, blob.Size)
}

func (s *StorageServer) checkQuota(ctx context.Context, lineage string, q *quotaRequest) (int64, error) {
	usage, err := s.refs.ReadUsage(ctx, lineage)
	if err != nil {
		return 0, err
	}
	bytes := usage.MarkedBytes + usage.WrittenSince
	if q == nil {
		return bytes, nil
	}
	limit, other := *q.LimitBytes, *q.OtherBytes
	// Subtract to compare exactly without overflowing the sum or multiplying the limit.
	refused := bytes > limit-other
	threshold := limit - limit/10
	if refused || bytes >= threshold-other {
		if err := s.enqueueMark(ctx, lineage); err != nil {
			return 0, err
		}
	}
	if refused {
		return 0, &storageError{507, "storage_limit", map[string]int64{"limit": limit}}
	}
	return bytes, nil
}

// One pending item per lineage. The GC consumer owns completing the item.
func (s *StorageServer) enqueueMark(ctx context.Context, lineage string) error {
	_, err := s.lineages.client.PutItem(ctx, &dynamodb.PutItemInput{
		TableName: aws.String(s.marksTable),
		Item: map[string]types.AttributeValue{
			"lineage": &types.AttributeValueMemberS{Value: lineage},
		},
		ConditionExpression:      aws.String("attribute_not_exists(#lineage)"),
		ExpressionAttributeNames: map[string]string{"#lineage": "lineage"},
	})
	if ddb.IsConditionFailed(err) {
		return nil
	}
	return err
}
