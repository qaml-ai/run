package api

import (
	"context"
	"fmt"
	"math"

	"github.com/aws/aws-sdk-go-v2/aws"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb"
	"github.com/aws/aws-sdk-go-v2/service/dynamodb/types"
	"github.com/qaml-ai/run/camelfsd/internal/ddb"
	"github.com/qaml-ai/run/camelfsd/internal/objects"
	"github.com/qaml-ai/run/camelfsd/internal/refstore"
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
	if s.refs == nil || writtenBytes(blob) == 0 {
		return nil
	}
	// Uncommitted uploads count until a mark. Re-referencing an unswept
	// blob adds nothing until the next mark because no object was created.
	return s.refs.AddWritten(ctx, lineage, blob.Size)
}

func writtenBytes(blob objects.Blob) int64 {
	if blob.Existing || blob.Size <= 0 {
		return 0
	}
	return blob.Size
}

func (s *StorageServer) checkQuota(ctx context.Context, lineage string, q *quotaRequest, usage refstore.Usage) (int64, error) {
	if usage.MarkedBytes > math.MaxInt64-usage.WrittenSince {
		return 0, fmt.Errorf("lineage usage overflows int64")
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
